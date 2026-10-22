/**
 * Where a Windows update installs, and how the installer is started.
 *
 * Owner ruling 2026-09-24: "the app knows where it is installed, so just update
 * the current installation." The running app's folder is the folder of
 * `process.execPath`, whatever kind of installation it is: the per-user
 * default under %LOCALAPPDATA%\Programs, a folder the person chose, or an
 * all-users installation under Program Files that the assisted installer of
 * 0.4.0 to 0.6.0 recorded in HKLM. The installer is told that folder with
 * `/D=`, and build/installer.nsh installs there in the matching per-user or
 * all-users mode.
 *
 * Two NSIS rules shape the argument list (NSIS manual, 3.2 "Installer Usage"):
 * `/D=` must be the LAST argument, and it must not be quoted even when the path
 * has spaces. electron-builder's templates read it back the same way
 * (multiUser.nsh `GetDParameter` takes everything after `/D=` on the command
 * line). Node quotes any argument with a space in it on Windows, so the
 * installer is spawned with `windowsVerbatimArguments` and a command line built
 * here, and not through electron-updater's `installDirectory`, whose `/D=` Node
 * would wrap in quotes.
 *
 * An installation that needs an administrator is updated by starting the
 * installer elevated FROM THE APP, before it shuts anything down: a declined
 * prompt then leaves the app running on its current version, which a prompt
 * raised by the installer after the app had quit could not.
 */
import { execFile, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { open, unlink } from 'fs/promises'
import path from 'path'
import { windowsPowerShellPath } from './command-on-path'
import { powerShellSingleQuoted } from '../shared/powershell-quote'

/**
 * electron-builder's registry id for this app: the installer writes
 * `Software\<id>` (InstallLocation, KeepShortcuts) under HKCU or HKLM. It is
 * UUID v5 of `build.appId` in electron-builder's namespace
 * (`ELECTRON_BUILDER_NS_UUID`, app-builder-lib NsisTarget), and the test pins it
 * to package.json's appId.
 */
export const NSIS_APP_GUID = '811b2173-7620-5d95-bc40-528684ed1d2d'

/** electron-builder's namespace for the id above (app-builder-lib NsisTarget). */
export const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3'

export type WindowsInstallTarget = {
  /** The folder the running app lives in; the update replaces the files here. */
  installDir: string
  /** HKLM records this folder: an all-users installation. */
  perMachine: boolean
  /** The signed-in user can write to the folder. */
  writable: boolean
  /** Starting the installer needs an administrator. */
  requiresAdmin: boolean
}

const win32 = path.win32

/** The installation folder of an app whose executable is `execPath`. */
export function installDirFromExecPath(execPath: string): string {
  return trimTrailingSeparators(win32.dirname(win32.normalize(execPath)))
}

function trimTrailingSeparators(dir: string): string {
  // `C:\` keeps its separator: without it the path means "the current folder of drive C".
  return /^[A-Za-z]:\\$/.test(dir) ? dir : dir.replace(/[\\/]+$/, '')
}

/** Windows paths compare without regard to case or a trailing separator. */
export function sameWindowsPath(a: string, b: string): boolean {
  const norm = (value: string) => trimTrailingSeparators(win32.normalize(value.trim())).toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Whether a folder can be the value of `/D=`. NSIS takes everything after the
 * `=` to the end of the command line, so the path must be absolute, contain no
 * double quote (it would end up in $INSTDIR), and no line break.
 */
export function isValidNsisInstallDir(dir: string): boolean {
  return win32.isAbsolute(dir) && /^[A-Za-z]:\\|^\\\\/.test(dir) && !/["\r\n\0]/.test(dir)
}

/**
 * The value `reg query <key> /v InstallLocation` prints, or null. The output is
 * a header line with the key, then `    InstallLocation    REG_SZ    <value>`.
 */
export function parseRegQueryValue(stdout: string, valueName: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (match && match[1]?.toLowerCase() === valueName.toLowerCase()) {
      const value = match[3]?.trim() ?? ''
      return value === '' ? null : value
    }
  }
  return null
}

export type ResolveInstallTargetDeps = {
  execPath: string
  /** HKLM `Software\<id>` InstallLocation, or null when there is none. */
  readMachineInstallLocation: () => Promise<string | null>
  /** Whether the signed-in user can create a file in the folder. */
  canWrite: (dir: string) => Promise<boolean>
}

export async function resolveWindowsInstallTarget(deps: ResolveInstallTargetDeps): Promise<WindowsInstallTarget> {
  const installDir = installDirFromExecPath(deps.execPath)
  const [machineLocation, writable] = await Promise.all([
    deps.readMachineInstallLocation().catch(() => null),
    deps.canWrite(installDir).catch(() => false),
  ])
  const perMachine = machineLocation !== null && sameWindowsPath(machineLocation, installDir)
  // An all-users installation needs an administrator even in a folder the user
  // can write (a custom folder outside Program Files): its registry entry and
  // its shortcuts are machine-wide.
  return { installDir, perMachine, writable, requiresAdmin: perMachine || !writable }
}

/**
 * The installer's arguments for an update, in the order NSIS needs.
 *
 * - `--updated` marks it an update: electron-builder's templates keep the
 *   person's shortcuts and data, and build/installer.nsh looks for the
 *   installation to update.
 * - `/S` only when silent. "Restart to update" runs the one-click installer
 *   non-silently, which shows its progress banner and no wizard (oneClick.nsh
 *   has only MUI_PAGE_INSTFILES; installSection.nsh shows SpiderBanner unless
 *   silent), so the person can see the update happening.
 * - `--force-run` restarts the app when the installer finishes
 *   (installSection.nsh `doStartApp`, which runs it as the signed-in user even
 *   from an elevated installer, via StdUtils.ExecShellAsUser).
 * - `--wait-for-pid` makes the installer wait for this process to exit before
 *   it checks for a running app, instead of force-closing it.
 * - `/D=` last and unquoted.
 */
export function nsisUpdateArgs(options: {
  installDir: string
  silent: boolean
  forceRun: boolean
  waitForPid?: number | null
}): string[] {
  if (!isValidNsisInstallDir(options.installDir)) {
    throw new Error(`Cannot pass "${options.installDir}" to the installer as its folder.`)
  }
  const args = ['--updated']
  if (options.silent) args.push('/S')
  if (options.forceRun) args.push('--force-run')
  if (options.waitForPid && Number.isInteger(options.waitForPid) && options.waitForPid > 0) {
    args.push(`--wait-for-pid=${options.waitForPid}`)
  }
  args.push(`/D=${trimTrailingSeparators(options.installDir)}`)
  return args
}

/**
 * The command line tail the installer is given. Nothing here needs quoting:
 * the flags have no spaces, and `/D=` must not be quoted. It is passed to
 * CreateProcess verbatim.
 */
export function nsisCommandLineTail(args: readonly string[]): string {
  return args.join(' ')
}

/**
 * Spawn the installer as the signed-in user, with the command line exactly as
 * built. `argv0` is the quoted installer path: with verbatim arguments Node
 * does not quote it, and NSIS skips its own path by looking for the closing
 * quote (or, unquoted, the first space).
 */
export function spawnInstallerVerbatim(installerPath: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(installerPath, [nsisCommandLineTail(args)], {
        argv0: `"${installerPath}"`,
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve(child.pid ?? 0)
      })
    } catch (error) {
      reject(error)
    }
  })
}

/** ERROR_CANCELLED: the person chose No on the UAC prompt. */
export const ELEVATION_DECLINED_EXIT_CODE = 1223

/**
 * A PowerShell script that starts the installer elevated and says whether it
 * did: exit 0 once the installer is running, 1223 when the UAC prompt was
 * declined, 1 for anything else.
 *
 * It goes through ShellExecuteEx with the "runas" verb, as the documented way
 * to ask for elevation. `ErrorDialogParentHandle` becomes SHELLEXECUTEINFO's
 * hwnd (.NET Framework Process.StartWithShellExecuteEx sets `hwnd` from it
 * when `ErrorDialog` is on), so the prompt belongs to the app's window and
 * comes up in front of it, rather than as a flashing taskbar button behind a
 * window-less PowerShell.
 */
export function elevatedLaunchScript(options: {
  installerPath: string
  args: readonly string[]
  parentWindowHandle?: string | null
}): string {
  const handle =
    options.parentWindowHandle && /^\d+$/.test(options.parentWindowHandle) ? options.parentWindowHandle : '0'
  return [
    "$ErrorActionPreference = 'Stop'",
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${powerShellSingleQuoted(options.installerPath)}`,
    `$psi.Arguments = ${powerShellSingleQuoted(nsisCommandLineTail(options.args))}`,
    "$psi.Verb = 'runas'",
    '$psi.UseShellExecute = $true',
    '$psi.ErrorDialog = $true',
    `$psi.ErrorDialogParentHandle = [IntPtr]::new([Int64]${handle})`,
    'try {',
    '  [void][System.Diagnostics.Process]::Start($psi)',
    '  exit 0',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e -ne $null -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    `  if ($e -ne $null -and $e.NativeErrorCode -eq ${ELEVATION_DECLINED_EXIT_CODE}) { exit ${ELEVATION_DECLINED_EXIT_CODE} }`,
    '  exit 1',
    '}',
  ].join('\n')
}

/** `-EncodedCommand` takes base64 of the script's UTF-16LE bytes, so nothing in it needs quoting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function powerShellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodePowerShellCommand(script),
  ]
}

export type ElevatedLaunchResult =
  { outcome: 'started' } | { outcome: 'declined' } | { outcome: 'failed'; message: string }

/** Map the elevation script's exit code to what happened. */
export function elevatedLaunchOutcome(exitCode: number | null, stderr = ''): ElevatedLaunchResult {
  if (exitCode === 0) return { outcome: 'started' }
  if (exitCode === ELEVATION_DECLINED_EXIT_CODE) return { outcome: 'declined' }
  const detail = stderr.trim()
  return {
    outcome: 'failed',
    message: detail
      ? `Windows could not start the installer as an administrator: ${detail}`
      : `Windows could not start the installer as an administrator (exit code ${exitCode ?? 'none'}).`,
  }
}

/**
 * Ask Windows to start the installer elevated, and wait for the answer. No
 * timeout: the UAC prompt waits for the person, and so does this.
 */
export function launchInstallerElevated(options: {
  installerPath: string
  args: readonly string[]
  parentWindowHandle?: string | null
}): Promise<ElevatedLaunchResult> {
  const script = elevatedLaunchScript(options)
  return new Promise((resolve) => {
    execFile(
      windowsPowerShellPath(),
      powerShellArgs(script),
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ outcome: 'started' })
          return
        }
        // A non-zero exit puts the exit code in `code`; a PowerShell that could
        // not be started at all puts an errno string there instead.
        const code: unknown = (error as { code?: unknown }).code
        if (typeof code !== 'number') {
          resolve({ outcome: 'failed', message: error.message })
          return
        }
        resolve(elevatedLaunchOutcome(code, String(stderr ?? '')))
      },
    )
  })
}

/** HKLM `Software\<id>` InstallLocation in the 64-bit view, which is where the installer wrote it. */
export function readMachineInstallLocation(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', `HKLM\\SOFTWARE\\${NSIS_APP_GUID}`, '/v', 'InstallLocation', '/reg:64'],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(parseRegQueryValue(String(stdout), 'InstallLocation'))
      },
    )
  })
}

/**
 * Whether the signed-in user can create a file in `dir`: the one test that
 * answers for Program Files, a custom folder with its own ACL, and a read-only
 * volume alike.
 */
export async function canWriteDirectory(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.update-write-probe-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    const handle = await open(probe, 'wx')
    await handle.close()
    await unlink(probe).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/**
 * The native handle of a window as the decimal integer PowerShell reads.
 * `getNativeWindowHandle()` is the HWND's bytes, little-endian.
 */
export function windowHandleToDecimal(handle: Buffer | null | undefined): string | null {
  if (!handle || handle.length === 0) return null
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  if (handle.length >= 4) return String(handle.readUInt32LE(0))
  return null
}
