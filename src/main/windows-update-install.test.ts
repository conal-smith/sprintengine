import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  ELECTRON_BUILDER_NS_UUID,
  ELEVATION_DECLINED_EXIT_CODE,
  NSIS_APP_GUID,
  canWriteDirectory,
  elevatedLaunchOutcome,
  elevatedLaunchScript,
  encodePowerShellCommand,
  installDirFromExecPath,
  isValidNsisInstallDir,
  nsisCommandLineTail,
  nsisUpdateArgs,
  parseRegQueryValue,
  powerShellArgs,
  resolveWindowsInstallTarget,
  sameWindowsPath,
  windowHandleToDecimal,
} from './windows-update-install'
import { windowsPowerShellPath } from './command-on-path'
import { powerShellSingleQuoted } from '../shared/powershell-quote'

// The three installations an update has to find, as the running app sees them.
const PER_USER_DEFAULT = 'C:\\Users\\dev\\AppData\\Local\\Programs\\sprintengine-studio'
// The assisted installer of 0.4.0 to 0.6.0 named its per-user default folder
// after the product, with a space in it.
const PER_USER_ASSISTED_DEFAULT = 'C:\\Users\\dev\\AppData\\Local\\Programs\\SprintEngine Studio'
const CUSTOM_FOLDER = 'D:\\Tools\\SprintEngine Studio'
const PROGRAM_FILES = 'C:\\Program Files\\SprintEngine Studio'
const EXE = 'SprintEngine Studio.exe'

/**
 * UUID v5 (RFC 4122 §4.3), the way electron-builder derives an app's registry
 * id: SHA-1 over the namespace's 16 bytes then the name, version and variant
 * bits set on the first 16 bytes of the digest.
 */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(ns).update(name).digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * multiUser.nsh `GetDParameter`, ported: the installer takes everything after
 * the first `/D=` (or `/d=`) on its command line (StdUtils.GetAllParameters,
 * which leaves out the program's own path) as the installation folder.
 */
function nsisGetDParameter(commandLineTail: string): string {
  const at = commandLineTail.search(/\/[Dd]=/)
  return at < 0 ? '' : commandLineTail.slice(at + 3)
}

/** How Node (libuv `quote_cmd_arg`) writes an argument into a Windows command line by default. */
function nodeDefaultQuote(arg: string): string {
  return /[ \t"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

test('the registry id is electron-builder’s UUID v5 of the app id', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { build: { appId: string } }
  assert.equal(NSIS_APP_GUID, uuidV5(pkg.build.appId, ELECTRON_BUILDER_NS_UUID))
})

test('the installation folder is the folder of the running executable', () => {
  assert.equal(installDirFromExecPath(`${PER_USER_DEFAULT}\\${EXE}`), PER_USER_DEFAULT)
  assert.equal(installDirFromExecPath(`${CUSTOM_FOLDER}\\${EXE}`), CUSTOM_FOLDER)
  assert.equal(installDirFromExecPath(`${PROGRAM_FILES}\\${EXE}`), PROGRAM_FILES)
  // A drive root keeps its separator: `C:` alone means the drive's current folder.
  assert.equal(installDirFromExecPath(`E:\\${EXE}`), 'E:\\')
})

test('Windows paths compare without case or a trailing separator', () => {
  assert.equal(sameWindowsPath(PROGRAM_FILES, 'c:\\program files\\sprintengine studio\\'), true)
  assert.equal(sameWindowsPath(PROGRAM_FILES, 'C:/Program Files/SprintEngine Studio'), true)
  assert.equal(sameWindowsPath(PROGRAM_FILES, `${PROGRAM_FILES} (x86)`), false)
})

async function targetFor(options: { installDir: string; hklm: string | null; writable: boolean }) {
  return resolveWindowsInstallTarget({
    execPath: `${options.installDir}\\${EXE}`,
    readMachineInstallLocation: async () => options.hklm,
    canWrite: async () => options.writable,
  })
}

test('a per-user default installation updates in place without an administrator', async () => {
  assert.deepEqual(await targetFor({ installDir: PER_USER_DEFAULT, hklm: null, writable: true }), {
    installDir: PER_USER_DEFAULT,
    perMachine: false,
    writable: true,
    requiresAdmin: false,
  })
  // The assisted installer's per-user default, with its space.
  assert.equal(
    (await targetFor({ installDir: PER_USER_ASSISTED_DEFAULT, hklm: null, writable: true })).requiresAdmin,
    false,
  )
  // An all-users installation elsewhere on the machine is not this one.
  const beside = await targetFor({ installDir: PER_USER_DEFAULT, hklm: PROGRAM_FILES, writable: true })
  assert.equal(beside.perMachine, false)
  assert.equal(beside.requiresAdmin, false)
})

test('a per-user installation in a folder of the person’s choosing updates in place', async () => {
  assert.deepEqual(await targetFor({ installDir: CUSTOM_FOLDER, hklm: null, writable: true }), {
    installDir: CUSTOM_FOLDER,
    perMachine: false,
    writable: true,
    requiresAdmin: false,
  })
})

test('an all-users installation needs an administrator, wherever it is', async () => {
  // Program Files, as HKLM records it (any case, trailing separator or not).
  assert.deepEqual(
    await targetFor({ installDir: PROGRAM_FILES, hklm: 'c:\\program files\\sprintengine studio\\', writable: false }),
    { installDir: PROGRAM_FILES, perMachine: true, writable: false, requiresAdmin: true },
  )
  // A custom all-users folder the user can write: its registry entry and its
  // shortcuts are still machine-wide.
  const custom = await targetFor({ installDir: CUSTOM_FOLDER, hklm: CUSTOM_FOLDER, writable: true })
  assert.equal(custom.perMachine, true)
  assert.equal(custom.requiresAdmin, true)
  // A folder the user cannot write, whatever the registry says.
  const locked = await targetFor({ installDir: CUSTOM_FOLDER, hklm: null, writable: false })
  assert.equal(locked.perMachine, false)
  assert.equal(locked.requiresAdmin, true)
})

test('a registry or permission probe that fails reads as nothing, never as a crash', async () => {
  const target = await resolveWindowsInstallTarget({
    execPath: `${PROGRAM_FILES}\\${EXE}`,
    readMachineInstallLocation: async () => {
      throw new Error('reg.exe missing')
    },
    canWrite: async () => {
      throw new Error('EPERM')
    },
  })
  assert.deepEqual(target, { installDir: PROGRAM_FILES, perMachine: false, writable: false, requiresAdmin: true })
})

test('the installer arguments end in an unquoted /D=, whatever the folder', () => {
  for (const dir of [PER_USER_DEFAULT, PER_USER_ASSISTED_DEFAULT, CUSTOM_FOLDER, PROGRAM_FILES]) {
    const args = nsisUpdateArgs({ installDir: dir, silent: false, forceRun: true, waitForPid: 4242 })
    assert.deepEqual(args, ['--updated', '--force-run', '--wait-for-pid=4242', `/D=${dir}`])
    const tail = nsisCommandLineTail(args)
    assert.ok(tail.endsWith(`/D=${dir}`), 'last')
    assert.equal(tail.includes('"'), false, 'no quotes anywhere')
    // What the installer reads back is the folder, exactly.
    assert.equal(nsisGetDParameter(tail), dir)
  }
})

test('Node’s default quoting would hand the installer a folder ending in a quote', () => {
  // Why the installer is spawned with verbatim arguments rather than through
  // electron-updater's `installDirectory`: Node quotes an argument with a
  // space, and NSIS takes everything after /D= to the end of the line.
  const args = nsisUpdateArgs({ installDir: PROGRAM_FILES, silent: true, forceRun: true })
  const quoted = args.map(nodeDefaultQuote).join(' ')
  assert.equal(nsisGetDParameter(quoted), `${PROGRAM_FILES}"`)
  assert.notEqual(nsisGetDParameter(quoted), PROGRAM_FILES)
})

test('silent, force-run and the pid are each optional, and in the NSIS order', () => {
  assert.deepEqual(nsisUpdateArgs({ installDir: PROGRAM_FILES, silent: true, forceRun: false }), [
    '--updated',
    '/S',
    `/D=${PROGRAM_FILES}`,
  ])
  assert.deepEqual(
    nsisUpdateArgs({ installDir: `${PROGRAM_FILES}\\`, silent: false, forceRun: false, waitForPid: 0 }),
    ['--updated', `/D=${PROGRAM_FILES}`],
  )
})

test('a folder NSIS could not take as /D= is refused before anything starts', () => {
  for (const dir of ['relative\\folder', 'C:\\Program Files\\Say "hi"', 'C:\\bad\nline', '']) {
    assert.equal(isValidNsisInstallDir(dir), false, JSON.stringify(dir))
    assert.throws(() => nsisUpdateArgs({ installDir: dir, silent: false, forceRun: true }))
  }
  assert.equal(isValidNsisInstallDir(PROGRAM_FILES), true)
  assert.equal(isValidNsisInstallDir('\\\\build-box\\apps\\SprintEngine Studio'), true)
})

test('reg query output yields the InstallLocation value', () => {
  const stdout = [
    '',
    `HKEY_LOCAL_MACHINE\\SOFTWARE\\${NSIS_APP_GUID}`,
    `    InstallLocation    REG_SZ    ${PROGRAM_FILES}`,
    '',
  ].join('\r\n')
  assert.equal(parseRegQueryValue(stdout, 'InstallLocation'), PROGRAM_FILES)
  assert.equal(parseRegQueryValue(stdout, 'KeepShortcuts'), null)
  assert.equal(parseRegQueryValue('', 'InstallLocation'), null)
  assert.equal(parseRegQueryValue('    InstallLocation    REG_SZ    ', 'InstallLocation'), null)
})

test('the elevation script starts the installer through runas, owned by the app window', () => {
  const installerPath = "C:\\Users\\dev\\AppData\\Local\\sprintengine-studio-updater\\pending\\O'Neil Setup.exe"
  const args = nsisUpdateArgs({ installDir: PROGRAM_FILES, silent: false, forceRun: true, waitForPid: 77 })
  const script = elevatedLaunchScript({ installerPath, args, parentWindowHandle: '132456' })
  assert.match(
    script,
    /\$psi\.FileName = 'C:\\Users\\dev\\AppData\\Local\\sprintengine-studio-updater\\pending\\O''Neil Setup\.exe'/,
  )
  assert.ok(script.includes(`$psi.Arguments = '--updated --force-run --wait-for-pid=77 /D=${PROGRAM_FILES}'`))
  assert.ok(script.includes("$psi.Verb = 'runas'"))
  assert.ok(script.includes('$psi.UseShellExecute = $true'))
  assert.ok(script.includes('$psi.ErrorDialogParentHandle = [IntPtr]::new([Int64]132456)'))
  assert.ok(script.includes(`exit ${ELEVATION_DECLINED_EXIT_CODE}`))
  // A handle that is not a plain integer is never pasted into the script.
  assert.ok(elevatedLaunchScript({ installerPath, args, parentWindowHandle: '1; rm -rf' }).includes('[Int64]0)'))
})

test('the script travels as -EncodedCommand, so nothing in it needs quoting', () => {
  const script = "Write-Output 'Program Files'"
  const encoded = encodePowerShellCommand(script)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
  const argv = powerShellArgs(script)
  assert.deepEqual(argv.slice(0, -1), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
  ])
  assert.equal(argv.at(-1), encoded)
  assert.equal(powerShellSingleQuoted("it's"), "'it''s'")
  assert.equal(
    windowsPowerShellPath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
})

test('the elevation answer maps to started, declined, or failed with a reason', () => {
  assert.deepEqual(elevatedLaunchOutcome(0), { outcome: 'started' })
  assert.deepEqual(elevatedLaunchOutcome(ELEVATION_DECLINED_EXIT_CODE), { outcome: 'declined' })
  const failed = elevatedLaunchOutcome(1, 'The file is not a valid application.')
  assert.equal(failed.outcome, 'failed')
  assert.match((failed as { message: string }).message, /not a valid application/)
  assert.match((elevatedLaunchOutcome(null) as { message: string }).message, /exit code none/)
})

test('a window handle reads as the decimal integer PowerShell takes', () => {
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(0x2a0f38n)
  assert.equal(windowHandleToDecimal(handle), String(0x2a0f38))
  const short = Buffer.alloc(4)
  short.writeUInt32LE(1234)
  assert.equal(windowHandleToDecimal(short), '1234')
  assert.equal(windowHandleToDecimal(null), null)
  assert.equal(windowHandleToDecimal(Buffer.alloc(0)), null)
})

test('the write probe answers for a folder and leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'update-write-probe-'))
  try {
    assert.equal(await canWriteDirectory(dir), true)
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(await canWriteDirectory(join(dir, 'missing')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an update puts back a missing Start Menu shortcut, with only what the stock installer defines', () => {
  const nsh = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
  const start = nsh.indexOf('!macro customInstall')
  assert.ok(start > 0, 'the installer defines customInstall')
  const body = nsh
    .slice(start, nsh.indexOf('!macroend', start))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';'))
  const guard = body.indexOf('${IfNot} ${FileExists} "$newStartMenuLink"')
  assert.ok(guard > 0, 'a link that is there is left as it is')
  assert.equal(body[guard - 1], '!ifndef DO_NOT_CREATE_START_MENU_SHORTCUT', 'and none is made for a build without one')
  const made = body.slice(guard)
  assert.ok(made.includes('CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"'))
  assert.ok(made.includes('WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"'))
  // makensis runs with -WX, so a name the templates stopped defining fails the
  // Windows build; this says which one without one.
  const templates = join(process.cwd(), 'node_modules', 'app-builder-lib', 'templates', 'nsis')
  const installer = readFileSync(join(templates, 'installer.nsi'), 'utf8')
  assert.match(installer, /^Var newStartMenuLink$/mu)
  assert.match(installer, /^\s*Var appExe$/mu)
  const stockShortcuts = readFileSync(join(templates, 'include', 'installer.nsh'), 'utf8')
  assert.match(stockShortcuts, /^!macro createMenuDirectory$/mu)
  assert.match(stockShortcuts, /WinShell::SetLnkAUMI "\$newStartMenuLink" "\$\{APP_ID\}"/u)
})
