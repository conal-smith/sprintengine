import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { createControlRpc } from '../bootstrap/control-rpc'
import { createMessageHub, type ServerControlChannel } from '../bootstrap/control-channel'
import type { ServerBootstrapEnvelope } from '../bootstrap/envelope'
import { serveOnChannel } from '../bootstrap/serve'
import { applyGatewayLaunchTokenChange, resolveGatewayLaunchToken } from '../core/gateway-launch-tokens'
import type { TunnelPort } from '../ipc/ipc-tunnel'
import { resetStudioPlatform } from '../platform/platform'
import { serveShellBridge } from '../shell-bridge/serve-shell-bridge'
import type { ShellBridge } from '../shell-bridge/shell-bridge'
import { startDesktopServer } from './desktop-server'
import { SERVER_EVENTS, SERVER_METHODS, SHELL_METHODS, type ServerMirrorState } from './server-methods'

// The desktop's server out of process, composed for real over a temp data
// directory and driven the way the shell drives it: an envelope on the control
// channel, the shell bridge served back, a window's port carrying tunnelled
// IPC, the mirror the shell reads, and a drain at the end. No Electron: the
// carrier is a fake parent port, and the shell is this test.

const ROOT = join(__dirname, '..', '..', '..')
let scratch = ''
let previousHome: string | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'se-desktop-server-'))
  previousHome = process.env.HOME
  // Module discovery and the launcher pointer are read from the home folder.
  process.env.HOME = join(scratch, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  resetStudioPlatform()
  rmSync(scratch, { recursive: true, force: true })
})

const keychainSeal = (plain: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(plain, 'utf8').reverse()])

function shellBridge(): ShellBridge & { notices: unknown[] } {
  const notices: unknown[] = []
  return {
    notices,
    cipher: {
      available: async () => true,
      seal: async (plain) => new Uint8Array(keychainSeal(Buffer.from(plain).toString('utf8'))),
      open: async (sealed) => new Uint8Array(Buffer.from(Buffer.from(sealed).subarray(3)).reverse()),
    },
    terminals: {
      launchAgent: async () => ({ ok: false, code: 'shell_unavailable', message: 'No terminals in this test.' }),
    },
    reveal: { tab: async () => false },
    notify: (notice) => notices.push(notice),
    analytics: () => undefined,
    integrationsReady: async () => undefined,
    images: { downscale: async (bytes, mediaType) => ({ bytes, mediaType }) },
  }
}

/** The window's end of a port pair the test holds; the server holds the other. */
function windowPort() {
  const server = { message: [] as Array<(event: { data: unknown }) => void>, close: [] as Array<() => void> }
  const received: Array<Record<string, any>> = []
  const port: TunnelPort = {
    postMessage: (message) => received.push(structuredClone(message) as Record<string, any>),
    on: (event: 'message' | 'close', listener: any) => {
      server[event].push(listener)
      return port
    },
    start: () => undefined,
    close: () => undefined,
  }
  let nextId = 1
  return {
    port,
    received,
    async invoke(channel: string, ...args: unknown[]): Promise<Record<string, any>> {
      const id = nextId++
      for (const listener of server.message) listener({ data: { t: 'ipc.invoke', id, channel, args } })
      for (let tries = 0; tries < 2_000; tries++) {
        const found = received.find((frame) => frame.t === 'ipc.result' && frame.id === id)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`no answer on ${channel}`)
    },
  }
}

test('the desktop server composes, serves a window over the tunnel and the shell over the control channel, and drains', async () => {
  const dataDir = join(scratch, 'profile')
  const hub = createMessageHub()
  const fromServer: Array<Record<string, any>> = []
  const shellRpc = createControlRpc((frame) => setImmediate(() => hub.dispatch(frame, [])))
  const channel: ServerControlChannel = {
    carriesPorts: true,
    send(frame) {
      const recorded = frame as Record<string, any>
      fromServer.push(recorded)
      setImmediate(() => shellRpc.receive(recorded))
    },
    onMessage: (listener) => hub.add(listener),
    onClose: () => () => undefined,
  }
  const bridge = shellBridge()
  serveShellBridge(shellRpc, bridge)
  shellRpc.handle(SHELL_METHODS.marketplaceRead, () => ({ ok: true, entries: [] }))
  shellRpc.handle(SHELL_METHODS.thirdPartyModules, () => ({ modules: [], rejected: [] }))
  // A terminal agent the shell launched before this server started holds this token.
  const terminalAgent = { workspaceId: 'acme', agentId: 'agent-1' }
  const tokenDigest = createHash('sha256').update('terminal-agent-token').digest('hex')
  shellRpc.handle(SHELL_METHODS.liveLaunchTokens, () => [{ digest: tokenDigest, identity: terminalAgent }])
  const mirrored: string[] = []
  shellRpc.on(SERVER_EVENTS.mirrorLaunchSettings, () => mirrored.push('launch-settings'))

  const exit = serveOnChannel(channel, {
    starters: { 'desktop-local': startDesktopServer },
    unwrapEnvelope: true,
    buildStamp: null,
    log: () => undefined,
  })
  const envelope: ServerBootstrapEnvelope = {
    v: 1,
    role: 'desktop-local',
    dataDir,
    logsDir: join(dataDir, 'logs'),
    runDir: join(dataDir, 'run'),
    tempDir: tmpdir(),
    paths: { resourcesDir: null, appPath: ROOT, isPackaged: false, appExecPath: process.execPath },
    app: { version: '0.0.0-test', buildStamp: '', channel: 'nightly' },
    owner: {},
    listeners: { gateway: true, tailnet: 'from-settings' },
    secrets: { kind: 'shell', available: true },
    flags: {},
  }
  hub.dispatch({ t: 'envelope', envelope }, [])
  const ready = await waitFor(() => fromServer.find((frame) => frame.t === 'ready' || frame.t === 'fatal'))
  assert.equal(ready.t, 'ready', JSON.stringify(ready))
  assert.equal(typeof ready.gateway.socketPath, 'string')
  // Its bridge is proven the moment the socket is back, before any push after ready.
  assert.deepEqual(resolveGatewayLaunchToken('terminal-agent-token'), terminalAgent)
  applyGatewayLaunchTokenChange({ digest: tokenDigest, identity: null })
  // Desktop role: the lock names the desktop, so the app's own server is never refused by its parent.
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'run', 'studio.lock'), 'utf8')).role, 'desktop')

  // A window attaches; its tunnelled calls reach the server's domains.
  const window = windowPort()
  hub.dispatch(
    { t: 'attach-client', clientId: 'window-1-1', windowId: 'primary', kind: 'desktop-window', workspaceWindow: true },
    [window.port],
  )
  const settings = await window.invoke('launch-settings:get')
  assert.equal(settings.ok, true, JSON.stringify(settings))
  const snapshot = await window.invoke('workspace-sync:get-snapshot')
  assert.ok(Array.isArray(snapshot.value.state.workspaces))
  const scheduled = await window.invoke('scheduled-agents:list')
  assert.equal(scheduled.ok, true, JSON.stringify(scheduled))
  const update = await window.invoke('launch-settings:update', { lastSelectedCli: 'codex' })
  assert.equal(update.value.ok, true)
  // The update is pushed to the window and mirrored to the shell.
  await waitFor(() =>
    window.received.find((frame) => frame.t === 'ipc.push' && frame.channel === 'launch-settings:changed'),
  )
  await waitFor(() => mirrored.length > 0 || undefined)

  // A Claude terminal's status line, read in the shell, reaches the usage
  // limits the server's windows draw.
  shellRpc.emit(SERVER_EVENTS.usageStatusLine, {
    rateLimits: { five_hour: { usedPercentage: 37, resetsAt: Date.now() + 3_600_000 } },
    at: Date.now(),
  })
  let claudeLimits: { windows: Array<{ id: string; usedPercent: number }> } | undefined
  for (let tries = 0; tries < 200 && !claudeLimits; tries++) {
    const answer = await window.invoke('usage-limits:get')
    claudeLimits = answer.value?.snapshots?.find((snapshot: { provider: string }) => snapshot.provider === 'claude')
    if (!claudeLimits) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(claudeLimits?.windows.find((entry) => entry.id === 'five_hour')?.usedPercent, 37)

  // The shell's mirror reads from the server.
  const mirror = await shellRpc.call<ServerMirrorState>(SERVER_METHODS.mirrorSnapshot)
  assert.equal(mirror.launchSettings.settings.lastSelectedCli, 'codex')
  assert.ok(Array.isArray(mirror.state.workspaces))

  // A GitHub token is sealed by the shell's keychain, byte for byte.
  await shellRpc.call(SERVER_METHODS.githubToken, { op: 'write', token: 'ghp_example' })
  assert.deepEqual(readFileSync(join(dataDir, 'github-token.bin')), keychainSeal('ghp_example'))
  assert.equal(await shellRpc.call(SERVER_METHODS.githubToken, { op: 'resolve' }), 'ghp_example')

  const info = await shellRpc.call<{ cipher: string; pid: number }>(SERVER_METHODS.info)
  assert.equal(info.pid, process.pid)
  assert.match(info.cipher, /desktop keychain/)

  // What a quit would stop: no chat has a turn running here.
  assert.equal(await shellRpc.call(SERVER_METHODS.conversationsWorking), 0)

  // The drain runs every leg and lets the directory go.
  hub.dispatch({ t: 'shutdown', drain: true, budgetMs: 8_000 }, [])
  assert.equal(await exit, 0)
  const legs = fromServer.filter((frame) => frame.t === 'shutdown-progress').map((frame) => frame.leg)
  assert.deepEqual(legs.slice(0, 2), ['modules (begin)', 'local app socket'])
  assert.equal(legs.at(-1), 'data directory')
  assert.ok(legs.indexOf('chat transcripts') < legs.indexOf('data directory'))
  assert.equal(
    fromServer.filter((frame) => frame.t === 'shutdown-progress').every((frame) => !frame.failed),
    true,
    JSON.stringify(fromServer.filter((frame) => frame.t === 'shutdown-progress')),
  )
})

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let tries = 0; tries < 3_000; tries++) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition not met')
}
