import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALLOWED_PERMISSIONS,
  TAB_MOVE_GRACE_MS,
  createAgentTabAssignments,
  createBrowserManager,
  type BrowserManagerDeps,
  cropRect,
  descendantPids,
  fileStamp,
  parseListeningSockets,
  stripUserAgent,
  writeCaptureFile,
} from './browser-manager'
import { applyGuestWebPreferences } from './guest-policy'
import { BROWSER_PARTITION } from '../../shared/browser'
import { parsePsTree } from '../terminal-subtree-probe'
import { test } from 'vitest'

test('browser-manager', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  // `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output for a vite server, a Next server
  // bound to a LAN address, and a database that is not a web server.
  const LSOF = [
    'p4242',
    'cnode',
    'n*:5173',
    'n[::1]:5173',
    'p4300',
    'cnext-server',
    'n192.168.1.20:3000',
    'p900',
    'cpostgres',
    'n127.0.0.1:5432',
    '',
  ].join('\n')

  run('listening sockets: loopback and wildcard binds, one row per socket, LAN binds skipped', () => {
    assert.deepEqual(parseListeningSockets(LSOF), [
      { pid: 4242, command: 'node', port: 5173 },
      { pid: 4242, command: 'node', port: 5173 },
      { pid: 900, command: 'postgres', port: 5432 },
    ])
    assert.deepEqual(parseListeningSockets(''), [])
  })

  // ps -axo pid=,ppid=,pcpu=,args=
  const PS = [
    '  100     1  0.0 /bin/zsh -l',
    '  200   100  0.0 npm run dev',
    '  4242  200 12.0 node vite',
    '  4300     1  0.0 node next',
    '  900     1  0.0 postgres',
  ].join('\n')

  run('descendant pids walk the pty shell subtree only', () => {
    const procs = parsePsTree(PS)
    assert.deepEqual(
      [...descendantPids(100, procs)].sort((a, b) => a - b),
      [200, 4242],
    )
    assert.deepEqual([...descendantPids(4300, procs)], [])
    assert.deepEqual([...descendantPids(999, procs)], [])
  })

  console.log('browser-manager tests passed')

  // The will-attach-webview policy: the epic's one security boundary.
  const PICKER = '/app/out/preload/browser-guest.js'

  run('guest policy: a foreign partition or a non-http src is refused outright', () => {
    assert.equal(
      applyGuestWebPreferences({}, { partition: 'persist:other', src: 'http://localhost:5173/' }, PICKER),
      false,
    )
    assert.equal(
      applyGuestWebPreferences({}, { partition: BROWSER_PARTITION, src: 'file:///etc/passwd' }, PICKER),
      false,
    )
    assert.equal(
      applyGuestWebPreferences({}, { partition: BROWSER_PARTITION, src: 'javascript:alert(1)' }, PICKER),
      false,
    )
    assert.equal(applyGuestWebPreferences({}, { partition: BROWSER_PARTITION, src: 'about:blank' }, PICKER), true)
    assert.equal(applyGuestWebPreferences({}, { partition: BROWSER_PARTITION }, PICKER), true)
  })

  run('guest policy: only the shipped picker preload survives, and context isolation stays on with it', () => {
    const withPicker: Record<string, unknown> = {
      preload: '/app/out/preload/../preload/browser-guest.js',
      contextIsolation: false,
    }
    assert.equal(
      applyGuestWebPreferences(withPicker, { partition: BROWSER_PARTITION, src: 'http://localhost:5173/' }, PICKER),
      true,
    )
    assert.equal(withPicker.preload, PICKER)
    assert.equal(withPicker.contextIsolation, true)

    const foreign: Record<string, unknown> = { preload: '/tmp/evil.js', contextIsolation: false }
    assert.equal(
      applyGuestWebPreferences(foreign, { partition: BROWSER_PARTITION, src: 'http://localhost:5173/' }, PICKER),
      true,
    )
    assert.equal('preload' in foreign, false)
    assert.equal(foreign.contextIsolation, true)

    // No picker built: even the right path is dropped.
    const unbuilt: Record<string, unknown> = { preload: PICKER }
    applyGuestWebPreferences(unbuilt, { partition: BROWSER_PARTITION }, null)
    assert.equal('preload' in unbuilt, false)
    assert.equal(unbuilt.contextIsolation, true)
  })

  run('guest policy: sandbox on, Node off everywhere, web security on — whatever the tag asked for', () => {
    const prefs: Record<string, unknown> = {
      sandbox: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    }
    applyGuestWebPreferences(prefs, { partition: BROWSER_PARTITION, src: 'https://example.com/' }, PICKER)
    assert.deepEqual(prefs, {
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableHtmlFullscreenWindowResize: true,
      contextIsolation: true,
    })
  })

  run('cropRect: pads, scales CSS px by the zoom factor, clamps to the capture, and refuses nonsense', () => {
    // 150% zoom: a 100×50 element at (200,100) CSS px is at (300,150) in DIP.
    assert.deepEqual(cropRect({ x: 200, y: 100, width: 100, height: 50 }, 1.5, { width: 1200, height: 800 }), {
      x: 270,
      y: 120,
      width: 210,
      height: 135,
    })
    // Clamped at the origin and the far edge.
    assert.deepEqual(cropRect({ x: 5, y: 5, width: 1000, height: 1000 }, 1, { width: 400, height: 300 }), {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    // Fully off-screen, absurd, or negative sizes: nothing to crop.
    assert.equal(cropRect({ x: 5000, y: 5000, width: 10, height: 10 }, 1, { width: 400, height: 300 }), null)
    assert.equal(cropRect({ x: 1e300, y: 0, width: 10, height: 10 }, 1, { width: 400, height: 300 }), null)
    assert.equal(cropRect({ x: 0, y: 0, width: -10, height: 10 }, 1, { width: 400, height: 300 }), null)
    assert.equal(cropRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, 1, { width: 400, height: 300 }), null)
  })

  run('fileStamp is the local clock, not UTC', () => {
    assert.equal(fileStamp(new Date(2026, 8, 4, 8, 18, 2)), '2026-09-04_08-18-02')
  })

  // A browser tab popped out of its pane, or docked back, unregisters from the
  // window it left and registers under the same id in the other. The agents
  // driving it keep driving it; a tab that is really gone lets them go.
  run('agent assignments: a tab that moves windows keeps its agents, one that closes does not', () => {
    let clock = 1_000
    const assignments = createAgentTabAssignments(() => clock)
    assignments.set('ws-1', 'agent-a', 'tab-1')
    assignments.set('ws-1', 'agent-b', 'tab-1')
    assignments.set('ws-1', 'agent-c', 'tab-2')

    assignments.release('tab-1', 'ws-1')
    assert.equal(assignments.get('ws-1', 'agent-a'), undefined, 'gone, the tab is held by nobody')
    // While it was away, one agent took another tab: that one is not undone.
    assignments.set('ws-1', 'agent-b', 'tab-2')
    clock += 2_000
    assignments.restore('tab-1', 'ws-1')
    assert.equal(assignments.get('ws-1', 'agent-a'), 'tab-1', 'registered again, it is held again')
    assert.equal(assignments.get('ws-1', 'agent-b'), 'tab-2')
    assert.deepEqual(
      assignments.holding('ws-1').sort((x, y) => x.agentId.localeCompare(y.agentId)),
      [
        { agentId: 'agent-a', tabId: 'tab-1' },
        { agentId: 'agent-b', tabId: 'tab-2' },
        { agentId: 'agent-c', tabId: 'tab-2' },
      ],
    )

    // Closed for real: a tab with that id much later is a new tab.
    assignments.release('tab-1', 'ws-1')
    clock += TAB_MOVE_GRACE_MS + 1
    assignments.restore('tab-1', 'ws-1')
    assert.equal(assignments.get('ws-1', 'agent-a'), undefined)

    // Nor does a tab of the same id in another workspace inherit them.
    assignments.release('tab-2', 'ws-1')
    assignments.restore('tab-2', 'ws-2')
    assert.equal(assignments.get('ws-1', 'agent-c'), undefined)
  })
})

// Chrome's own user agent, with the two tokens Electron adds: the app name with
// its spaces removed, then `Electron/<version>`.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
function electronUserAgent(appToken: string): string {
  return CHROME_UA.replace('Chrome/140.0.0.0', `${appToken} Chrome/140.0.0.0 Electron/38.0.0`)
}

test("a page cannot post system notifications under the app's name", () => {
  assert.equal(ALLOWED_PERMISSIONS.has('notifications'), false)
})

test("a page may go fullscreen, and the guest's fullscreen never resizes the app window", () => {
  assert.equal(ALLOWED_PERMISSIONS.has('fullscreen'), true)
  const prefs: Record<string, unknown> = { disableHtmlFullscreenWindowResize: false }
  applyGuestWebPreferences(prefs, { partition: BROWSER_PARTITION, src: 'https://example.com/' }, null)
  assert.equal(prefs.disableHtmlFullscreenWindowResize, true, 'whatever the tag asked for')
})

test('two captures within the same second are both kept, the second numbered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-capture-'))
  try {
    const second = new Date(2026, 8, 4, 8, 18, 2)
    const first = await writeCaptureFile(directory, 'page-localhost', Buffer.from('one'), second)
    const next = await writeCaptureFile(directory, 'page-localhost', Buffer.from('two'), second)
    assert.equal(first, join(directory, 'page-localhost-2026-09-04_08-18-02.png'))
    assert.equal(next, join(directory, 'page-localhost-2026-09-04_08-18-02-2.png'))
    assert.equal(await readFile(first, 'utf8'), 'one', 'the first capture is not overwritten')
    assert.equal(await readFile(next, 'utf8'), 'two')
    assert.equal((await readdir(directory)).length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('user agent: a packaged build loses its space-less productName token', () => {
  assert.equal(stripUserAgent(electronUserAgent('SprintEngineStudio/0.4.0')), CHROME_UA)
})

test('user agent: a dev build loses its package-name token', () => {
  assert.equal(stripUserAgent(electronUserAgent('sprintengine-studio/0.4.0')), CHROME_UA)
  assert.equal(stripUserAgent(electronUserAgent('sprintengine/0.4.0')), CHROME_UA)
})

test('user agent: what is left is single-spaced, with no space at either end', () => {
  const stripped = stripUserAgent(`Electron/38.0.0  ${electronUserAgent('SprintEngineStudio/0.4.0')}  `)
  assert.equal(stripped, CHROME_UA)
  assert.doesNotMatch(stripped, /\s{2}|^\s|\s$/)
})

test('user agent: a token that only contains the name is left alone', () => {
  const ua = `${CHROME_UA} NotSprintEngineStudio/1.0`
  assert.equal(stripUserAgent(ua), ua)
})

// Linux without `lsof`: the listeners come from `/proc` instead. A workspace
// terminal (pid 10) runs a shell whose child (20) serves on 5173; another
// workspace's terminal (50) has a child (60) on 8080.
function linuxManager(listProcListeners: NonNullable<BrowserManagerDeps['listProcListeners']>) {
  const asked: number[][] = []
  const manager = createBrowserManager({
    listTerminalRoots: () => [
      { rootPid: 10, workspaceId: 'ws-a', sessionId: 's-a', terminalId: 't-a' },
      { rootPid: 50, workspaceId: 'ws-b', sessionId: 's-b', terminalId: 't-b' },
    ],
    isHostWindow: () => false,
    broadcast: () => {},
    resolveWorkspaceRoot: () => null,
    platform: 'linux',
    runPs: async () =>
      [
        '   10     1  0.0 -zsh',
        '   20    10  1.0 /usr/bin/node /Users/dev/app/node_modules/.bin/vite',
        '   50     1  0.0 -bash',
        '   60    50  0.0 python3 -m http.server 8080',
      ].join('\n'),
    runLsofListening: async () => null,
    listProcListeners: async (pids) => {
      asked.push([...pids])
      return listProcListeners(pids)
    },
    probeServer: async () => true,
  })
  return { manager, asked }
}

test('local servers: on Linux without lsof, a terminal’s dev server is found from /proc', async () => {
  const { manager, asked } = linuxManager(async () => [{ pid: 20, port: 5173 }])
  const servers = await manager.listLocalServers('ws-a')
  assert.deepEqual(asked, [[20]], 'only the workspace’s own processes are read')
  assert.deepEqual(servers, [
    {
      url: 'http://localhost:5173/',
      port: 5173,
      pid: 20,
      command: 'node',
      sessionId: 's-a',
      terminalId: 't-a',
    },
  ])
})

test('local servers: a /proc listener held by a process outside the workspace is not listed', async () => {
  const { manager } = linuxManager(async () => [{ pid: 60, port: 8080 }])
  assert.deepEqual(await manager.listLocalServers('ws-a'), [])
})

test('local servers: on macOS a missing lsof still lists nothing, with no /proc to read', async () => {
  let readProc = false
  const manager = createBrowserManager({
    listTerminalRoots: () => [{ rootPid: 10, workspaceId: 'ws-a', sessionId: 's-a', terminalId: 't-a' }],
    isHostWindow: () => false,
    broadcast: () => {},
    resolveWorkspaceRoot: () => null,
    platform: 'darwin',
    runPs: async () => ['   10     1  0.0 -zsh', '   20    10  1.0 node vite'].join('\n'),
    runLsofListening: async () => null,
    listProcListeners: async () => {
      readProc = true
      return [{ pid: 20, port: 5173 }]
    },
    probeServer: async () => true,
  })
  assert.deepEqual(await manager.listLocalServers('ws-a'), [])
  assert.equal(readProc, false)
})
