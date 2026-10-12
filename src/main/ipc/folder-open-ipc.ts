import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix as posixPath, win32 as windowsPath } from 'node:path'
import type { IpcMain } from 'electron'
import {
  FOLDER_OPEN_TARGET_IDS,
  isFolderOpenTargetId,
  type FolderOpenRequest,
  type FolderOpenResult,
  type FolderOpenTargetAvailability,
  type FolderOpenTargetId,
} from '../../shared/folder-open-targets'
import { errorMessage } from '../../shared/errors'

/**
 * How a target is launched. `reveal` is the OS file manager and goes through
 * the existing show-item-in-folder path; `command` is an argv spawn — the
 * editor's own CLI, or `open -a <bundle>` on macOS when only the app is
 * installed. The folder path is always appended as the final argv element, so
 * no path text is ever interpreted as a flag or shell syntax.
 */
export type FolderOpenLauncher =
  | { kind: 'reveal' }
  | {
      kind: 'command'
      command: string
      args: string[]
      /** Run by `cmd.exe` (a Windows `.cmd`/`.bat` shim), which reads the folder path as command text. */
      viaCommandProcessor?: true
    }

// What `cmd.exe` acts on in an argument however it is quoted: the command
// separators and redirections, the escape, and variable expansion. A folder
// path holding one, handed to a shim through the command processor, would be
// run as commands (`C:\R&D\app` runs `D\app`), so such a path is refused
// rather than escaped: which of these survive Node's quoting and the shim's own
// `%*` re-expansion depends on both, and a wrong guess runs the rest.
const COMMAND_PROCESSOR_METACHARACTERS = /[&|<>^%!"]/u

/** Whether `folderPath` can be handed to `launcher` without being read as commands. */
export function launcherTakesPath(launcher: FolderOpenLauncher, folderPath: string): boolean {
  return !(
    launcher.kind === 'command' &&
    launcher.viaCommandProcessor &&
    COMMAND_PROCESSOR_METACHARACTERS.test(folderPath)
  )
}

export type LauncherProbe = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(candidatePath: string): boolean
  /**
   * macOS only: where an application with one of these bundle identifiers is
   * installed, wherever that is. The directory scan above it only knows the
   * conventional folders; an app dragged onto another volume (`/Volumes/work/
   * IntelliJ IDEA.app`) is still an installed app, and Launch Services knows
   * about it even when we do not. Absent in a probe that has no such lookup.
   */
  locateAppByBundleId?(bundleIds: readonly string[]): string | null
}

type LaunchOutcome = { ok: true } | { ok: false; message: string }

export type FolderOpenIpcDependencies = {
  showItemInFolder(targetPath: string): Promise<void>
  resolveLauncher(target: FolderOpenTargetId): FolderOpenLauncher | null | Promise<FolderOpenLauncher | null>
  runLauncher(command: string, args: string[]): Promise<LaunchOutcome>
  /** Rejects when the folder cannot be reached; same rule show-item-in-folder applies. */
  assertPathReachable(targetPath: string): Promise<void>
}

// The bundle names cover every spelling the vendors ship: the Community
// editions install as "IntelliJ IDEA CE.app" / "PyCharm CE.app", and JetBrains
// Toolbox writes "IntelliJ IDEA Ultimate.app". The bundle ids are what Launch
// Services indexes the same app under whatever it was renamed to on disk; an
// editor whose id we cannot vouch for lists none and is found by name alone. The
// CLI names are the shims each editor installs (or JetBrains Toolbox writes to
// its scripts folder, `wellKnownCliDirs`). `cliArgs` go before the folder for a
// shim that needs a subcommand to open the editor rather than its other tool.
const EDITOR_LAUNCHERS: Record<
  Exclude<FolderOpenTargetId, 'finder'>,
  { cliNames: string[]; cliArgs?: string[]; macAppNames: string[]; macBundleIds: string[] }
> = {
  vscode: {
    cliNames: ['code'],
    macAppNames: ['Visual Studio Code.app'],
    macBundleIds: ['com.microsoft.VSCode'],
  },
  'vscode-insiders': {
    cliNames: ['code-insiders'],
    macAppNames: ['Visual Studio Code - Insiders.app'],
    macBundleIds: ['com.microsoft.VSCodeInsiders'],
  },
  vscodium: {
    cliNames: ['codium'],
    macAppNames: ['VSCodium.app'],
    macBundleIds: ['com.vscodium'],
  },
  cursor: {
    cliNames: ['cursor'],
    macAppNames: ['Cursor.app'],
    macBundleIds: ['com.todesktop.230313mzl4w4u92'],
  },
  windsurf: {
    cliNames: ['windsurf'],
    macAppNames: ['Windsurf.app'],
    macBundleIds: ['com.exafunction.windsurf'],
  },
  zed: {
    cliNames: ['zed'],
    macAppNames: ['Zed.app', 'Zed Preview.app'],
    macBundleIds: ['dev.zed.Zed', 'dev.zed.Zed-Preview'],
  },
  trae: {
    cliNames: ['trae'],
    macAppNames: ['Trae.app'],
    macBundleIds: [],
  },
  // Kiro's `kiro` command fronts more than the editor, so the editor is asked
  // for by name.
  kiro: {
    cliNames: ['kiro'],
    cliArgs: ['ide'],
    macAppNames: ['Kiro.app'],
    macBundleIds: [],
  },
  // The IDE, not its siblings: `agy` is the separate command-line agent, and
  // "Antigravity.app" is the hub that launches agents, so neither one means
  // the editor is installed.
  antigravity: {
    cliNames: ['antigravity-ide', 'agy-ide'],
    macAppNames: ['Antigravity IDE.app'],
    macBundleIds: [],
  },
  sublime: {
    cliNames: ['subl'],
    macAppNames: ['Sublime Text.app'],
    macBundleIds: ['com.sublimetext.4', 'com.sublimetext.3'],
  },
  intellij: {
    cliNames: ['idea'],
    macAppNames: [
      'IntelliJ IDEA.app',
      'IntelliJ IDEA Ultimate.app',
      'IntelliJ IDEA CE.app',
      'IntelliJ IDEA Community Edition.app',
    ],
    macBundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
  },
  webstorm: {
    cliNames: ['webstorm'],
    macAppNames: ['WebStorm.app'],
    macBundleIds: ['com.jetbrains.WebStorm'],
  },
  pycharm: {
    cliNames: ['pycharm'],
    macAppNames: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Professional Edition.app', 'PyCharm Community Edition.app'],
    macBundleIds: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'],
  },
  goland: {
    cliNames: ['goland'],
    macAppNames: ['GoLand.app'],
    macBundleIds: ['com.jetbrains.goland'],
  },
  clion: {
    cliNames: ['clion'],
    macAppNames: ['CLion.app'],
    macBundleIds: ['com.jetbrains.CLion'],
  },
  phpstorm: {
    cliNames: ['phpstorm'],
    macAppNames: ['PhpStorm.app'],
    macBundleIds: ['com.jetbrains.PhpStorm'],
  },
  rider: {
    cliNames: ['rider'],
    macAppNames: ['Rider.app', 'JetBrains Rider.app'],
    macBundleIds: ['com.jetbrains.rider'],
  },
  rubymine: {
    cliNames: ['rubymine'],
    macAppNames: ['RubyMine.app'],
    macBundleIds: ['com.jetbrains.rubymine'],
  },
  rustrover: {
    cliNames: ['rustrover'],
    macAppNames: ['RustRover.app'],
    macBundleIds: ['com.jetbrains.rustrover'],
  },
  datagrip: {
    cliNames: ['datagrip'],
    macAppNames: ['DataGrip.app'],
    macBundleIds: ['com.jetbrains.datagrip'],
  },
}

const TARGET_NAMES: Record<FolderOpenTargetId, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  vscodium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  trae: 'Trae',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  zed: 'Zed',
  sublime: 'Sublime Text',
  intellij: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  pycharm: 'PyCharm',
  goland: 'GoLand',
  clion: 'CLion',
  phpstorm: 'PhpStorm',
  rider: 'Rider',
  rubymine: 'RubyMine',
  rustrover: 'RustRover',
  datagrip: 'DataGrip',
  finder: 'the file manager',
}

// A launcher that has not exited by this point started the editor: the editor
// CLIs and `open` all return immediately, so a still-running child means the
// binary resolved and is doing its work. Only an exit failure or a spawn error
// is reported as a failed launch.
const LAUNCH_SETTLE_MS = 5_000

/**
 * The editor probe, as a plain call. Shared by the `fs:folder-open-targets`
 * handler and the boot-discovery pass so both answer "which editors are
 * installed" the same way. It walks PATH and the application folders with
 * `existsSync`, and only for an editor none of that finds does it ask
 * Spotlight once (cached, see `locateAppByBundleIdHere`).
 */
export async function listFolderOpenTargetAvailability(
  resolveLauncher: FolderOpenIpcDependencies['resolveLauncher'],
): Promise<FolderOpenTargetAvailability[]> {
  return Promise.all(
    FOLDER_OPEN_TARGET_IDS.map(async (id) => ({ id, available: (await resolveLauncher(id)) !== null })),
  )
}

/**
 * `resolveFolderOpenLauncher` against the real machine. The folder walk is
 * synchronous and cheap; Spotlight is not, so it is asked first, without
 * blocking, and its answer handed to the same resolver. The boot-discovery pass
 * runs this right after the main window is created, and a `mdfind` run
 * synchronously there held the main thread for tens of milliseconds (up to its
 * two-second timeout on a slow index) while the window's document was waiting
 * on that thread to commit.
 */
export async function resolveFolderOpenLauncherHere(target: FolderOpenTargetId): Promise<FolderOpenLauncher | null> {
  const probe: LauncherProbe = { platform: process.platform, env: process.env, exists: existsSync }
  const found = resolveFolderOpenLauncher(target, probe)
  if (found || target === 'finder' || probe.platform !== 'darwin') return found
  const located = await locateAppByBundleIdHere(EDITOR_LAUNCHERS[target].macBundleIds)
  return resolveFolderOpenLauncher(target, { ...probe, locateAppByBundleId: () => located })
}

// Spotlight answers are remembered for a minute. The probe runs at boot, again
// for every workspace bar that mounts, and once more at launch time; `mdfind`
// takes tens of milliseconds, and the answer does not change between one
// workspace switch and the next. A minute is short enough that an editor
// installed while the app is open shows up on the next probe.
//
// One query asks after every editor at once, with each hit's bundle id beside
// its path, and each editor's answer is read out of it: the boot probe misses
// most editors on most machines, and one `mdfind` per missing editor was eight
// processes where one does. The entry is the pending answer, so the boot pass
// and the first workspace bar, which ask in the same moment, share it.
const SPOTLIGHT_CACHE_MS = 60_000
const ALL_EDITOR_BUNDLE_IDS = Object.values(EDITOR_LAUNCHERS).flatMap((spec) => spec.macBundleIds)
let spotlightCache: { at: number; bundles: Promise<ReadonlyMap<string, string[]>> } | null = null

/**
 * Spotlight's `-attr kMDItemCFBundleIdentifier` listing, as bundle id → the
 * paths installed under it. A line it cannot read is skipped.
 */
export function parseSpotlightBundles(stdout: string): Map<string, string[]> {
  const bundles = new Map<string, string[]>()
  for (const line of stdout.split('\n')) {
    const match = /^(.+?\.app)\s+kMDItemCFBundleIdentifier = "?([^"\s]+)"?\s*$/u.exec(line.trim())
    if (!match) continue
    const [, path, id] = match
    bundles.set(id!, [...(bundles.get(id!) ?? []), path!])
  }
  return bundles
}

function spotlightBundlesHere(): Promise<ReadonlyMap<string, string[]>> {
  if (spotlightCache && Date.now() - spotlightCache.at < SPOTLIGHT_CACHE_MS) return spotlightCache.bundles
  const query = ALL_EDITOR_BUNDLE_IDS.map((id) => `kMDItemCFBundleIdentifier == "${id}"`).join(' || ')
  const bundles = new Promise<ReadonlyMap<string, string[]>>((resolve) => {
    execFile(
      '/usr/bin/mdfind',
      ['-attr', 'kMDItemCFBundleIdentifier', query],
      { encoding: 'utf8', timeout: 2_000 },
      (error, stdout) => resolve(error ? new Map() : parseSpotlightBundles(stdout)),
    )
  })
  spotlightCache = { at: Date.now(), bundles }
  return bundles
}

/**
 * Ask Spotlight where an app with one of these bundle ids lives. The directory
 * scan finds the conventional installs; this finds the rest — an app kept on a
 * second volume, or a bundle renamed on disk. `mdfind` is the same index Launch
 * Services opens apps through, so a hit here is an app `open -a` can start.
 *
 * Conventional folders win when Spotlight lists several copies (an install and
 * a stray download), and anything in the Trash or a Time Machine backup is not
 * an install at all. Any failure — Spotlight off, the volume unindexed, a slow
 * index — is "not found", never an error: the menu simply omits the editor.
 */
async function locateAppByBundleIdHere(bundleIds: readonly string[]): Promise<string | null> {
  if (process.platform !== 'darwin' || bundleIds.length === 0) return null
  const bundles = await spotlightBundlesHere()
  return pickInstalledBundle(
    bundleIds.flatMap((id) => bundles.get(id) ?? []),
    process.env.HOME ?? '',
  )
}

/** The bundle to launch out of Spotlight's list, or null when none is an install. */
export function pickInstalledBundle(candidates: readonly string[], home: string): string | null {
  const bundles = candidates
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.app'))
    .filter((line) => !line.includes('/.Trash/') && !line.includes('Backups.backupdb'))
  if (bundles.length === 0) return null
  const rank = (bundle: string): number => {
    if (bundle.startsWith('/Applications/')) return 0
    if (home && bundle.startsWith(posixPath.join(home, 'Applications') + '/')) return 1
    return 2
  }
  return [...bundles].sort((a, b) => rank(a) - rank(b))[0] ?? null
}

export function registerFolderOpenIpc(ipcMain: IpcMain, deps: FolderOpenIpcDependencies): void {
  ipcMain.handle('fs:folder-open-targets', async (): Promise<FolderOpenTargetAvailability[]> => {
    return listFolderOpenTargetAvailability(deps.resolveLauncher)
  })

  ipcMain.handle('fs:open-folder-in-target', async (_, request: FolderOpenRequest): Promise<FolderOpenResult> => {
    const target = request?.target
    if (!isFolderOpenTargetId(target)) {
      return { ok: false, target: null, reason: 'unknown_target', message: `Unknown open target: ${String(target)}.` }
    }

    const folderPath = typeof request?.path === 'string' ? request.path : ''
    if (!folderPath.trim()) {
      return { ok: false, target, reason: 'path_unavailable', message: 'No folder was given to open.' }
    }
    try {
      await deps.assertPathReachable(folderPath)
    } catch (error) {
      return { ok: false, target, reason: 'path_unavailable', message: errorMessage(error) }
    }

    // Resolved again at launch time rather than trusted from the probe: an
    // editor can be uninstalled between the menu opening and the click.
    const launcher = await deps.resolveLauncher(target)
    if (!launcher) {
      return { ok: false, target, reason: 'target_unavailable', message: `${TARGET_NAMES[target]} is not installed.` }
    }

    if (launcher.kind === 'reveal') {
      try {
        await deps.showItemInFolder(folderPath)
        return { ok: true, target }
      } catch (error) {
        return { ok: false, target, reason: 'launch_failed', message: errorMessage(error) }
      }
    }

    if (!launcherTakesPath(launcher, folderPath)) {
      return {
        ok: false,
        target,
        reason: 'launch_failed',
        message: `${TARGET_NAMES[target]} is opened through its command-line shim here, which cannot be given a folder path containing & | < > ^ % ! or ". Open the folder from ${TARGET_NAMES[target]} instead.`,
      }
    }

    // A spawn that cannot even start (a rejected launcher call) is still a
    // launch failure the caller must see, not a rejected invoke it has to catch.
    let outcome: LaunchOutcome
    try {
      outcome = await deps.runLauncher(launcher.command, [...launcher.args, folderPath])
    } catch (error) {
      return { ok: false, target, reason: 'launch_failed', message: errorMessage(error) }
    }
    if (!outcome.ok) {
      return { ok: false, target, reason: 'launch_failed', message: outcome.message }
    }
    return { ok: true, target }
  })
}

export function createFolderOpenIpcDependencies(
  showItemInFolder: (targetPath: string) => Promise<void>,
): FolderOpenIpcDependencies {
  return {
    showItemInFolder,
    resolveLauncher: resolveFolderOpenLauncherHere,
    runLauncher: (command, args) => runLauncher(command, args, LAUNCH_SETTLE_MS),
    assertPathReachable: (targetPath) => access(targetPath),
  }
}

/**
 * The single source of truth for both channels: availability is "this returns a
 * launcher", so the menu can never offer an editor the open action would fail
 * to start. The file manager always resolves.
 */
export function resolveFolderOpenLauncher(target: FolderOpenTargetId, probe: LauncherProbe): FolderOpenLauncher | null {
  if (target === 'finder') return { kind: 'reveal' }

  const spec = EDITOR_LAUNCHERS[target]
  for (const cliName of spec.cliNames) {
    const resolved = findOnPath(cliName, probe)
    if (resolved) return commandLauncher(resolved, spec.cliArgs ?? [], probe)
  }

  const appBundle = findMacApp(spec.macAppNames, probe)
  if (appBundle) return { kind: 'command', command: '/usr/bin/open', args: ['-a', appBundle] }

  // Nowhere we know to look: ask Launch Services where the app actually is.
  if (probe.platform === 'darwin' && probe.locateAppByBundleId) {
    const located = probe.locateAppByBundleId(spec.macBundleIds)
    if (located) return { kind: 'command', command: '/usr/bin/open', args: ['-a', located] }
  }

  return null
}

/**
 * Directories the editor CLIs live in when they are installed but not on PATH:
 * JetBrains Toolbox writes its `idea` shim to a scripts folder it asks the user
 * to add to PATH (and most never do), and the vscode target's Windows installer
 * offers PATH as an unticked box. A GUI app's PATH is the login shell's, which
 * is what makes these worth knowing by name.
 */
function wellKnownCliDirs(probe: LauncherProbe): string[] {
  const { platform, env } = probe
  if (platform === 'darwin') {
    const home = env.HOME ?? ''
    return home ? [posixPath.join(home, 'Library/Application Support/JetBrains/Toolbox/scripts')] : []
  }
  if (platform === 'win32') {
    const dirs: string[] = []
    const local = env.LOCALAPPDATA
    if (local) {
      dirs.push(windowsPath.join(local, 'JetBrains', 'Toolbox', 'scripts'))
      dirs.push(windowsPath.join(local, 'Programs', 'Microsoft VS Code', 'bin'))
    }
    const programFiles = env.ProgramFiles
    if (programFiles) dirs.push(windowsPath.join(programFiles, 'Microsoft VS Code', 'bin'))
    return dirs
  }
  const home = env.HOME ?? ''
  return home ? [posixPath.join(home, '.local/share/JetBrains/Toolbox/scripts')] : []
}

function findOnPath(name: string, probe: LauncherProbe): string | null {
  const isWindows = probe.platform === 'win32'
  const pathValue = probe.env.PATH ?? probe.env.Path ?? ''
  const candidateNames = isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
  const joinPath = isWindows ? windowsPath.join : posixPath.join
  // PATH first, so a shim the person put there deliberately wins over a default
  // install location; the well-known directories are the fallback.
  const dirs = [...pathValue.split(isWindows ? ';' : ':'), ...wellKnownCliDirs(probe)]
  for (const dir of dirs) {
    if (!dir) continue
    for (const candidateName of candidateNames) {
      const candidate = joinPath(dir, candidateName)
      if (probe.exists(candidate)) return candidate
    }
  }
  return null
}

function findMacApp(appNames: string[], probe: LauncherProbe): string | null {
  if (probe.platform !== 'darwin') return null
  const home = probe.env.HOME ?? ''
  // JetBrains Toolbox keeps its installs in a folder of their own under the
  // user's Applications, so that folder is one of the places an IDE lives.
  const searchDirs = home
    ? ['/Applications', posixPath.join(home, 'Applications'), posixPath.join(home, 'Applications/JetBrains Toolbox')]
    : ['/Applications']
  for (const dir of searchDirs) {
    for (const appName of appNames) {
      const candidate = posixPath.join(dir, appName)
      if (probe.exists(candidate)) return candidate
    }
  }
  return null
}

// Windows ships the editor CLIs as `.cmd`/`.bat` shims, which cannot be spawned
// directly; the command processor runs them, with the path still a separate
// argv element rather than concatenated shell text.
function commandLauncher(command: string, args: string[], probe: LauncherProbe): FolderOpenLauncher {
  if (probe.platform !== 'win32' || command.toLowerCase().endsWith('.exe')) {
    return { kind: 'command', command, args }
  }
  return {
    kind: 'command',
    command: probe.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
    viaCommandProcessor: true,
  }
}

function runLauncher(command: string, args: string[], settleMs: number): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let settleTimer: NodeJS.Timeout | undefined
    const settle = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(settleTimer)
      resolve(outcome)
    }

    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch (error) {
      settle({ ok: false, message: errorMessage(error) })
      return
    }
    settleTimer = setTimeout(() => settle({ ok: true }), settleMs)
    child.on('error', (error) => settle({ ok: false, message: errorMessage(error) }))
    child.on('close', (code) => {
      settle(code === 0 ? { ok: true } : { ok: false, message: `${command} exited with code ${String(code)}.` })
    })
    child.unref()
  })
}
