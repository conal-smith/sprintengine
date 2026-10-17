import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  createFolderOpenIpcDependencies,
  launcherTakesPath,
  pickInstalledBundle,
  registerFolderOpenIpc,
  resolveFolderOpenLauncher,
  type FolderOpenIpcDependencies,
  type FolderOpenLauncher,
  type LauncherProbe,
} from './folder-open-ipc'
import {
  FOLDER_OPEN_TARGET_IDS,
  type FolderOpenResult,
  type FolderOpenTargetAvailability,
} from '../../shared/folder-open-targets'
import { test } from 'vitest'

test('folder-open-ipc', async () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

  function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>()
    return {
      handlers,
      handle(channel, handler): void {
        handlers.set(channel, handler)
      },
    }
  }

  function probe(options: {
    platform: NodeJS.Platform
    installed: string[]
    env?: NodeJS.ProcessEnv
    /** Spotlight's answer per bundle-id list, keyed by the ids joined with `|`. */
    spotlight?: Record<string, string | null>
    /** Every bundle-id list Spotlight was asked about, in order. */
    spotlightAsked?: string[][]
  }): LauncherProbe {
    const installed = new Set(options.installed)
    return {
      platform: options.platform,
      env: options.env ?? { PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/dev' },
      exists: (candidate) => installed.has(candidate),
      ...(options.spotlight
        ? {
            locateAppByBundleId: (ids: readonly string[]) => {
              options.spotlightAsked?.push([...ids])
              return options.spotlight?.[ids.join('|')] ?? null
            },
          }
        : {}),
    }
  }

  const suiteRun = main()

  async function main(): Promise<void> {
    assertProbeResolvesEachTarget()
    assertProbeFindsEditorsOutsideTheConventionalFolders()
    assertSpotlightPickPrefersAnInstall()
    await assertProbeChannelReportsEveryTarget()
    await assertOpenSucceeds()
    await assertOpenFails()
    await assertRealDependenciesAreWired()
  }

  // Availability is "the launcher resolves": the CLI on PATH, else the macOS app
  // bundle. Each editor is checked present and absent; the file manager always
  // resolves.
  function assertProbeResolvesEachTarget(): void {
    const noEditors = probe({ platform: 'darwin', installed: [] })
    assert.deepEqual(resolveFolderOpenLauncher('finder', noEditors), { kind: 'reveal' })
    assert.equal(resolveFolderOpenLauncher('vscode', noEditors), null)
    assert.equal(resolveFolderOpenLauncher('intellij', noEditors), null)

    const cliInstalled = probe({ platform: 'darwin', installed: ['/usr/local/bin/code', '/usr/local/bin/idea'] })
    assert.deepEqual(resolveFolderOpenLauncher('vscode', cliInstalled), {
      kind: 'command',
      command: '/usr/local/bin/code',
      args: [],
    })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', cliInstalled), {
      kind: 'command',
      command: '/usr/local/bin/idea',
      args: [],
    })

    // No CLI, but the app bundle is installed: launch through `open -a`.
    const bundleOnly = probe({
      platform: 'darwin',
      installed: ['/Applications/Visual Studio Code.app', '/Users/dev/Applications/IntelliJ IDEA.app'],
    })
    assert.deepEqual(resolveFolderOpenLauncher('vscode', bundleOnly), {
      kind: 'command',
      command: '/usr/bin/open',
      args: ['-a', '/Applications/Visual Studio Code.app'],
    })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', bundleOnly), {
      kind: 'command',
      command: '/usr/bin/open',
      args: ['-a', '/Users/dev/Applications/IntelliJ IDEA.app'],
    })

    // A macOS bundle is not a launcher on other platforms.
    const linuxBundlePaths = probe({
      platform: 'linux',
      installed: ['/Applications/Visual Studio Code.app'],
      env: { PATH: '/usr/bin', HOME: '/home/dev' },
    })
    assert.equal(resolveFolderOpenLauncher('vscode', linuxBundlePaths), null)

    // Windows ships `code.cmd`, which the command processor has to run.
    const windows = probe({
      platform: 'win32',
      installed: ['C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'],
      env: { Path: 'C:\\Program Files\\Microsoft VS Code\\bin', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    })
    assert.deepEqual(resolveFolderOpenLauncher('vscode', windows), {
      kind: 'command',
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'],
      viaCommandProcessor: true,
    })
    assert.equal(resolveFolderOpenLauncher('intellij', windows), null)
  }

  // The conventional folders are where the scan looks first, not the only place
  // an editor can be: JetBrains Toolbox has folders of its own, the vendors ship
  // several bundle names, and an app on another volume is still an installed app
  // — Spotlight knows it by bundle id. (The case that prompted this lived at
  // `/Volumes/Extra/IntelliJ IDEA.app` with no `idea` shim on PATH, and the
  // menu said it was not installed.)
  function assertProbeFindsEditorsOutsideTheConventionalFolders(): void {
    // The Toolbox `idea` shim, which Toolbox writes but rarely gets onto PATH.
    const toolboxShim = probe({
      platform: 'darwin',
      installed: ['/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/idea'],
    })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', toolboxShim), {
      kind: 'command',
      command: '/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/idea',
      args: [],
    })

    // The Community edition's real bundle name, and Toolbox's own install folder.
    const communityEdition = probe({ platform: 'darwin', installed: ['/Applications/IntelliJ IDEA CE.app'] })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', communityEdition), {
      kind: 'command',
      command: '/usr/bin/open',
      args: ['-a', '/Applications/IntelliJ IDEA CE.app'],
    })
    const toolboxInstall = probe({
      platform: 'darwin',
      installed: ['/Users/dev/Applications/JetBrains Toolbox/IntelliJ IDEA Ultimate.app'],
    })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', toolboxInstall), {
      kind: 'command',
      command: '/usr/bin/open',
      args: ['-a', '/Users/dev/Applications/JetBrains Toolbox/IntelliJ IDEA Ultimate.app'],
    })

    // Nowhere the scan knows: Spotlight is asked by bundle id, and its answer is
    // what `open -a` starts.
    const asked: string[][] = []
    const onAnotherVolume = probe({
      platform: 'darwin',
      installed: [],
      spotlight: { 'com.jetbrains.intellij|com.jetbrains.intellij.ce': '/Volumes/Extra/IntelliJ IDEA.app' },
      spotlightAsked: asked,
    })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', onAnotherVolume), {
      kind: 'command',
      command: '/usr/bin/open',
      args: ['-a', '/Volumes/Extra/IntelliJ IDEA.app'],
    })
    assert.equal(
      resolveFolderOpenLauncher('vscode', onAnotherVolume),
      null,
      'Spotlight knowing nothing is "not installed"',
    )
    assert.deepEqual(asked, [['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'], ['com.microsoft.VSCode']])

    // Spotlight is the LAST resort: an install the scan finds never spawns it.
    const askedWhenScanHits: string[][] = []
    const scanHits = probe({
      platform: 'darwin',
      installed: ['/Applications/IntelliJ IDEA.app'],
      spotlight: {},
      spotlightAsked: askedWhenScanHits,
    })
    resolveFolderOpenLauncher('intellij', scanHits)
    assert.deepEqual(askedWhenScanHits, [], 'the directory scan answering means Spotlight is never asked')

    // A probe with no Spotlight lookup (other platforms, tests) simply stops at
    // the scan — the optional hook is optional.
    assert.equal(resolveFolderOpenLauncher('intellij', probe({ platform: 'darwin', installed: [] })), null)

    // Windows: the Toolbox scripts folder and the vscode target's default install folder
    // are searched after PATH, so an unticked "add to PATH" box is not "absent".
    const windowsDefaults = probe({
      platform: 'win32',
      installed: [
        'C:\\Users\\dev\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd',
        'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      ],
      env: {
        Path: 'C:\\Windows\\system32',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      },
    })
    assert.deepEqual(resolveFolderOpenLauncher('intellij', windowsDefaults), {
      kind: 'command',
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\Users\\dev\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd'],
      viaCommandProcessor: true,
    })
    assert.deepEqual(resolveFolderOpenLauncher('vscode', windowsDefaults), {
      kind: 'command',
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'],
      viaCommandProcessor: true,
    })
  }

  // Spotlight lists every copy it has indexed. The one to launch is an install:
  // the conventional folders first, and never the Trash or a backup.
  function assertSpotlightPickPrefersAnInstall(): void {
    assert.equal(pickInstalledBundle([], '/Users/dev'), null)
    assert.equal(pickInstalledBundle(['', '   '], '/Users/dev'), null)
    assert.equal(
      pickInstalledBundle(
        ['/Users/dev/.Trash/IntelliJ IDEA.app', '/Volumes/Backup/Backups.backupdb/mac/IntelliJ IDEA.app'],
        '/Users/dev',
      ),
      null,
      'a trashed or backed-up bundle is not an install',
    )
    assert.equal(
      pickInstalledBundle(
        [
          '/Volumes/Extra/IntelliJ IDEA.app',
          '/Users/dev/Applications/IntelliJ IDEA.app',
          '/Applications/IntelliJ IDEA.app',
        ],
        '/Users/dev',
      ),
      '/Applications/IntelliJ IDEA.app',
    )
    assert.equal(
      pickInstalledBundle(
        ['/Volumes/Extra/IntelliJ IDEA.app', '/Users/dev/Applications/IntelliJ IDEA.app'],
        '/Users/dev',
      ),
      '/Users/dev/Applications/IntelliJ IDEA.app',
    )
    assert.equal(
      pickInstalledBundle(['/Volumes/Extra/IntelliJ IDEA.app\n'], '/Users/dev'),
      '/Volumes/Extra/IntelliJ IDEA.app',
    )
  }

  async function assertProbeChannelReportsEveryTarget(): Promise<void> {
    const { probeTargets } = mountHandlers({
      resolveLauncher: (target) => (target === 'vscode' ? null : { kind: 'reveal' }),
    })

    const targets = (await probeTargets(null)) as FolderOpenTargetAvailability[]
    assert.deepEqual(
      targets,
      FOLDER_OPEN_TARGET_IDS.map((id) => ({ id, available: id !== 'vscode' })),
    )
  }

  async function assertOpenSucceeds(): Promise<void> {
    const revealed: string[] = []
    const launched: Array<{ command: string; args: string[] }> = []
    const { openFolder } = mountHandlers({
      showItemInFolder: async (targetPath) => {
        revealed.push(targetPath)
      },
      resolveLauncher: (target) =>
        target === 'finder' ? { kind: 'reveal' } : { kind: 'command', command: '/usr/local/bin/code', args: [] },
      runLauncher: async (command, args) => {
        launched.push({ command, args })
        return { ok: true }
      },
    })

    assert.deepEqual(await openFolder(null, { target: 'finder', path: '/repo' }), { ok: true, target: 'finder' })
    assert.deepEqual(revealed, ['/repo'])

    assert.deepEqual(await openFolder(null, { target: 'vscode', path: '/repo' }), { ok: true, target: 'vscode' })
    assert.deepEqual(launched, [{ command: '/usr/local/bin/code', args: ['/repo'] }])
  }

  // Every failure is a typed result the caller can surface, and a failed launch
  // never quietly falls through to another target.
  async function assertOpenFails(): Promise<void> {
    const attempted: string[] = []
    const { openFolder } = mountHandlers({
      showItemInFolder: async () => {
        throw new Error('reveal refused')
      },
      resolveLauncher: (target) =>
        target === 'intellij'
          ? null
          : target === 'finder'
            ? { kind: 'reveal' }
            : { kind: 'command', command: 'code', args: [] },
      runLauncher: async (command) => {
        attempted.push(command)
        return { ok: false, message: 'code exited with code 1.' }
      },
      assertPathReachable: async (targetPath) => {
        if (targetPath !== '/repo') throw new Error(`ENOENT: no such file or directory, access '${targetPath}'`)
      },
    })

    assert.deepEqual(await openFolder(null, { target: 'atom', path: '/repo' }), {
      ok: false,
      target: null,
      reason: 'unknown_target',
      message: 'Unknown open target: atom.',
    })

    assert.deepEqual(await openFolder(null, { target: 'vscode', path: '   ' }), {
      ok: false,
      target: 'vscode',
      reason: 'path_unavailable',
      message: 'No folder was given to open.',
    })

    const missingPath = (await openFolder(null, { target: 'vscode', path: '/gone' })) as FolderOpenResult
    assert.equal(missingPath.ok, false)
    assert.equal(missingPath.ok === false && missingPath.reason, 'path_unavailable')

    assert.deepEqual(await openFolder(null, { target: 'intellij', path: '/repo' }), {
      ok: false,
      target: 'intellij',
      reason: 'target_unavailable',
      message: 'IntelliJ IDEA is not installed.',
    })

    assert.deepEqual(await openFolder(null, { target: 'vscode', path: '/repo' }), {
      ok: false,
      target: 'vscode',
      reason: 'launch_failed',
      message: 'code exited with code 1.',
    })

    const revealFailure = (await openFolder(null, { target: 'finder', path: '/repo' })) as FolderOpenResult
    assert.deepEqual(revealFailure, {
      ok: false,
      target: 'finder',
      reason: 'launch_failed',
      message: 'reveal refused',
    })

    // Only the requested target was ever launched.
    assert.deepEqual(attempted, ['code'])

    // A launcher that cannot start at all is still a typed result, not a rejected
    // invoke the caller has to catch.
    const { openFolder: openWithBrokenSpawn } = mountHandlers({
      resolveLauncher: () => ({ kind: 'command', command: 'code', args: [] }),
      runLauncher: async () => {
        throw new Error('spawn code ENOENT')
      },
    })
    assert.deepEqual(await openWithBrokenSpawn(null, { target: 'vscode', path: '/repo' }), {
      ok: false,
      target: 'vscode',
      reason: 'launch_failed',
      message: 'spawn code ENOENT',
    })
  }

  // The real dependency set must reach the same reveal handler the rest of the
  // app uses, and reject an unreachable path before anything is spawned.
  async function assertRealDependenciesAreWired(): Promise<void> {
    const revealed: string[] = []
    const deps = createFolderOpenIpcDependencies(async (targetPath) => {
      revealed.push(targetPath)
    })

    await deps.showItemInFolder('/repo')
    assert.deepEqual(revealed, ['/repo'])
    assert.deepEqual(await deps.resolveLauncher('finder'), { kind: 'reveal' })
    await assert.rejects(deps.assertPathReachable(join(__dirname, 'definitely-missing-folder')))
  }

  function mountHandlers(overrides: Partial<FolderOpenIpcDependencies>): {
    probeTargets: Handler
    openFolder: (event: unknown, request: { target: string; path: string }) => Promise<unknown>
  } {
    const ipcMain = createIpcMain()
    registerFolderOpenIpc(ipcMain as unknown as Parameters<typeof registerFolderOpenIpc>[0], {
      showItemInFolder: async () => {},
      resolveLauncher: (): FolderOpenLauncher | null => null,
      runLauncher: async () => ({ ok: true }),
      assertPathReachable: async () => {},
      ...overrides,
    })

    const probeTargets = ipcMain.handlers.get('fs:folder-open-targets')
    const openFolder = ipcMain.handlers.get('fs:open-folder-in-target')
    assert.ok(probeTargets, 'probe channel should be registered')
    assert.ok(openFolder, 'open channel should be registered')
    return { probeTargets, openFolder }
  }

  await suiteRun
})

function editorProbe(platform: NodeJS.Platform, installed: string[]): LauncherProbe {
  const present = new Set(installed)
  return {
    platform,
    env: { PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/dev' },
    exists: (candidate) => present.has(candidate),
  }
}

test('each editor is offered only when its CLI or its app is installed', () => {
  const nothing = editorProbe('darwin', [])
  for (const target of FOLDER_OPEN_TARGET_IDS) {
    if (target === 'finder') continue
    assert.equal(resolveFolderOpenLauncher(target, nothing), null, `${target} is absent when nothing is installed`)
  }
})

test('the newer editors resolve through the CLI shim each one installs', () => {
  const shims = {
    windsurf: 'windsurf',
    zed: 'zed',
    sublime: 'subl',
    webstorm: 'webstorm',
    pycharm: 'pycharm',
    goland: 'goland',
    'vscode-insiders': 'code-insiders',
    vscodium: 'codium',
    trae: 'trae',
    antigravity: 'antigravity-ide',
    clion: 'clion',
    phpstorm: 'phpstorm',
    rider: 'rider',
    rubymine: 'rubymine',
    rustrover: 'rustrover',
    datagrip: 'datagrip',
  } as const
  for (const [target, cli] of Object.entries(shims) as [keyof typeof shims, string][]) {
    const onPath = editorProbe('linux', [`/usr/local/bin/${cli}`])
    assert.deepEqual(resolveFolderOpenLauncher(target, onPath), {
      kind: 'command',
      command: `/usr/local/bin/${cli}`,
      args: [],
    })
  }
})

// OpenZFS's event daemon is also called `zed`, and run with a folder it starts
// the daemon. It is never taken for the editor, and on macOS Zed.app decides.
test('Open in Zed starts Zed, never the ZFS event daemon of the same name', () => {
  const zfsOnMac: LauncherProbe = {
    platform: 'darwin',
    env: { PATH: '/usr/local/zfs/bin:/usr/local/bin:/usr/bin', HOME: '/Users/dev' },
    exists: (candidate) => ['/usr/local/zfs/bin/zed', '/Applications/Zed.app'].includes(candidate),
  }
  assert.deepEqual(resolveFolderOpenLauncher('zed', zfsOnMac), {
    kind: 'command',
    command: '/usr/bin/open',
    args: ['-a', '/Applications/Zed.app'],
  })
  assert.equal(
    resolveFolderOpenLauncher('zed', { ...zfsOnMac, exists: (candidate) => candidate === '/usr/local/zfs/bin/zed' }),
    null,
    'the daemon alone is not Zed',
  )

  // On macOS the app wins over a CLI too, Spotlight included; the CLI is the
  // fallback for a machine with no Zed.app at all.
  const shimAndElsewhereApp: LauncherProbe = {
    ...editorProbe('darwin', ['/usr/local/bin/zed']),
    locateAppByBundleId: () => '/Volumes/Extra/Zed.app',
  }
  assert.deepEqual(resolveFolderOpenLauncher('zed', shimAndElsewhereApp), {
    kind: 'command',
    command: '/usr/bin/open',
    args: ['-a', '/Volumes/Extra/Zed.app'],
  })
  assert.deepEqual(resolveFolderOpenLauncher('zed', editorProbe('darwin', ['/usr/local/bin/zed'])), {
    kind: 'command',
    command: '/usr/local/bin/zed',
    args: [],
  })

  const linux = (installed: string[]): LauncherProbe => ({
    platform: 'linux',
    env: { PATH: '/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin', HOME: '/home/dev' },
    exists: (candidate) => installed.includes(candidate),
  })
  assert.equal(resolveFolderOpenLauncher('zed', linux(['/usr/sbin/zed', '/usr/sbin/zpool'])), null)
  assert.equal(resolveFolderOpenLauncher('zed', linux(['/usr/sbin/zed'])), null)
  assert.deepEqual(resolveFolderOpenLauncher('zed', linux(['/usr/sbin/zed', '/home/dev/.local/bin/zed'])), {
    kind: 'command',
    command: '/home/dev/.local/bin/zed',
    args: [],
  })
  // A distribution with /usr/sbin merged into /usr/bin puts the daemon beside
  // `zpool` there, and packages the editor as `zeditor`.
  assert.equal(resolveFolderOpenLauncher('zed', linux(['/usr/bin/zed', '/usr/bin/zpool'])), null)
  assert.deepEqual(resolveFolderOpenLauncher('zed', linux(['/usr/bin/zed', '/usr/bin/zpool', '/usr/bin/zeditor'])), {
    kind: 'command',
    command: '/usr/bin/zeditor',
    args: [],
  })
})

test('without a CLI, the newer editors open through their macOS app bundle', () => {
  const bundles = {
    cursor: '/Applications/Cursor.app',
    windsurf: '/Applications/Windsurf.app',
    zed: '/Applications/Zed Preview.app',
    sublime: '/Applications/Sublime Text.app',
    webstorm: '/Users/dev/Applications/JetBrains Toolbox/WebStorm.app',
    pycharm: '/Applications/PyCharm CE.app',
    goland: '/Users/dev/Applications/GoLand.app',
    'vscode-insiders': '/Applications/Visual Studio Code - Insiders.app',
    vscodium: '/Applications/VSCodium.app',
    trae: '/Applications/Trae.app',
    kiro: '/Applications/Kiro.app',
    antigravity: '/Applications/Antigravity IDE.app',
    clion: '/Applications/CLion.app',
    phpstorm: '/Users/dev/Applications/JetBrains Toolbox/PhpStorm.app',
    rider: '/Applications/Rider.app',
    rubymine: '/Applications/RubyMine.app',
    rustrover: '/Applications/RustRover.app',
    datagrip: '/Applications/DataGrip.app',
  } as const
  for (const [target, bundle] of Object.entries(bundles) as [keyof typeof bundles, string][]) {
    assert.deepEqual(resolveFolderOpenLauncher(target, editorProbe('darwin', [bundle])), {
      kind: 'command',
      command: '/usr/bin/open',
      args: ['-a', bundle],
    })
  }
})

test('Kiro is asked for its editor by name, ahead of the folder', () => {
  assert.deepEqual(resolveFolderOpenLauncher('kiro', editorProbe('linux', ['/usr/local/bin/kiro'])), {
    kind: 'command',
    command: '/usr/local/bin/kiro',
    args: ['ide'],
  })
})

test('Cursor is asked for its editor window, not its Agents window', () => {
  assert.deepEqual(resolveFolderOpenLauncher('cursor', editorProbe('linux', ['/usr/local/bin/cursor'])), {
    kind: 'command',
    command: '/usr/local/bin/cursor',
    args: ['--classic'],
  })
})

test('a Windows Kiro shim keeps its subcommand ahead of the folder through cmd.exe', () => {
  const windows: LauncherProbe = {
    platform: 'win32',
    env: { Path: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kiro\\bin', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    exists: (candidate) => candidate === 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kiro\\bin\\kiro.cmd',
  }
  assert.deepEqual(resolveFolderOpenLauncher('kiro', windows), {
    kind: 'command',
    command: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kiro\\bin\\kiro.cmd', 'ide'],
    viaCommandProcessor: true,
  })
})

test('the Antigravity agent and its hub do not make the Antigravity IDE look installed', () => {
  const agentAndHub = editorProbe('darwin', ['/usr/local/bin/agy', '/Applications/Antigravity.app'])
  assert.equal(resolveFolderOpenLauncher('antigravity', agentAndHub), null)
  assert.deepEqual(resolveFolderOpenLauncher('antigravity', editorProbe('linux', ['/usr/local/bin/agy-ide'])), {
    kind: 'command',
    command: '/usr/local/bin/agy-ide',
    args: [],
  })
})

test('VS Code and its Insiders build are separate targets', () => {
  const insidersOnly = editorProbe('darwin', ['/Applications/Visual Studio Code - Insiders.app'])
  assert.equal(resolveFolderOpenLauncher('vscode', insidersOnly), null)
  assert.notEqual(resolveFolderOpenLauncher('vscode-insiders', insidersOnly), null)
})

test('a JetBrains IDE installed by Toolbox is found by its scripts-folder shim', () => {
  const shim = '/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/webstorm'
  assert.deepEqual(resolveFolderOpenLauncher('webstorm', editorProbe('darwin', [shim])), {
    kind: 'command',
    command: shim,
    args: [],
  })
})

test('a Windows shim run through cmd.exe is never handed a folder path cmd would read as commands', async () => {
  const windows: LauncherProbe = {
    platform: 'win32',
    env: { Path: 'C:\\Program Files\\Microsoft VS Code\\bin', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    exists: (candidate) => candidate === 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
  }
  const viaCmd = resolveFolderOpenLauncher('vscode', windows)!
  for (const path of ['C:\\R&D\\app', 'C:\\a|b', 'C:\\50%off', 'C:\\wow!', 'C:\\x^y', 'C:\\a<b', 'C:\\a>b']) {
    assert.equal(launcherTakesPath(viaCmd, path), false, path)
  }
  assert.equal(launcherTakesPath(viaCmd, 'C:\\Users\\dev\\My Project (2)'), true)
  const exe = resolveFolderOpenLauncher('vscode', {
    ...windows,
    exists: (candidate) => candidate === 'C:\\Program Files\\Microsoft VS Code\\bin\\code.exe',
  })!
  assert.equal(launcherTakesPath(exe, 'C:\\R&D\\app'), true, 'an .exe is spawned directly, with no command processor')

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const launched: string[][] = []
  registerFolderOpenIpc({ handle: (channel: string, handler: never) => handlers.set(channel, handler) } as never, {
    showItemInFolder: async () => {},
    resolveLauncher: () => viaCmd,
    runLauncher: async (_command, args) => {
      launched.push(args)
      return { ok: true }
    },
    assertPathReachable: async () => {},
  })
  const result = (await handlers.get('fs:open-folder-in-target')!(null, {
    target: 'vscode',
    path: 'C:\\R&D\\app',
  })) as FolderOpenResult
  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.reason, 'launch_failed')
  assert.deepEqual(launched, [], 'nothing was run')
})
