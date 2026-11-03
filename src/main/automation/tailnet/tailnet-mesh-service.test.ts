import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { MeshConnection, MeshEvent } from '../../../shared/tailnet-mesh'
import { createPowerActivity, type PowerActivity } from '../../power-activity'
import type { RemoteEventsSocket, RemoteJsonSocketHandlers } from './tailnet-remote-client'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet-mesh-service'
import type { StoredMeshConnection, TailnetMeshStore } from './tailnet-mesh-store'

// The mesh's own clocks, with the wire stood in for: how often a machine that
// stopped answering is dialled, when it is asked again, what a wake does to a
// watch that looks open, and how many reads a burst of windows costs. The
// loopback suites next door cover the wire itself.

const wire = vi.hoisted(() => ({
  readRemoteIdentity: vi.fn(),
  openRemoteEventsSocket: vi.fn(),
  openRemoteConversationSocket: vi.fn(),
}))

vi.mock('./tailnet-remote-client', async (original) => ({
  ...(await original<typeof import('./tailnet-remote-client')>()),
  readRemoteIdentity: wire.readRemoteIdentity,
  openRemoteEventsSocket: wire.openRemoteEventsSocket,
  openRemoteConversationSocket: wire.openRemoteConversationSocket,
}))

const connection: StoredMeshConnection = {
  id: 'tnc_mini',
  machineName: 'mac-mini',
  endpoint: 'mac-mini.tail1234.ts.net:8443',
  deviceId: 'dev_air',
  deviceName: 'dev-macbook-air',
  deviceToken: 'token',
  scopes: ['conversation:read'],
  pairedAt: '2026-09-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

function memoryStore(initial: StoredMeshConnection[]): TailnetMeshStore {
  let connections = [...initial]
  const publicView = ({ deviceToken: _token, ...rest }: StoredMeshConnection): MeshConnection => rest
  return {
    list: () => connections.map(publicView),
    find: (id) => connections.find((entry) => entry.id === id) ?? null,
    add: () => {
      throw new Error('not used here')
    },
    updateScopes: () => undefined,
    markConnected: () => undefined,
    forget(id) {
      const before = connections.length
      connections = connections.filter((entry) => entry.id !== id)
      return connections.length < before
    },
  }
}

const unreachable = { ok: false, code: 'unreachable', message: 'mac-mini did not answer.' }
const identity = {
  ok: true,
  value: {
    deviceId: 'dev_air',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read'],
    transportVersion: 2,
    capabilities: ['events', 'conversations'],
  },
}

/**
 * A watch socket the test drives: frames in through the handlers, whether this
 * end closed it, and whether it answers a ping (a socket that died asleep does not).
 */
function watchSocket(handlers: RemoteJsonSocketHandlers) {
  let open = true
  const state = { answers: true, pings: 0 }
  const socket: RemoteEventsSocket = {
    send: () => undefined,
    close: () => {
      open = false
    },
    isOpen: () => open,
    ping: () => {
      state.pings += 1
      return state.answers ? Promise.resolve() : new Promise<void>(() => undefined)
    },
  }
  return { socket, handlers, isOpen: () => open, state }
}

type Harness = {
  mesh: TailnetMeshService
  activity: PowerActivity
  events: MeshEvent[]
  looking: { value: boolean }
  store: TailnetMeshStore
}

let dir = ''
let harness: Harness | null = null

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'mesh-service-'))
  wire.readRemoteIdentity.mockReset()
  wire.openRemoteEventsSocket.mockReset()
  wire.openRemoteConversationSocket.mockReset()
})

afterEach(() => {
  harness?.mesh.shutdown()
  harness = null
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function startMesh(connections: StoredMeshConnection[] = [connection]): Harness {
  const activity = createPowerActivity({ focused: false })
  const events: MeshEvent[] = []
  const looking = { value: true }
  const store = memoryStore(connections)
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
    createStore: () => store,
    hasWindow: () => looking.value,
    activity,
    onEvent: (event) => events.push(event),
  })
  harness = { mesh, activity, events, looking, store }
  return harness
}

test('a watch on a machine that stopped answering parks, and is asked for again only while someone can look', async () => {
  wire.readRemoteIdentity.mockResolvedValue(unreachable)
  wire.openRemoteEventsSocket.mockResolvedValue(unreachable)
  const h = startMesh()
  h.looking.value = false
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(10_000)
  // The first dial and a few quick retries, then nothing of its own.
  const dials = wire.openRemoteEventsSocket.mock.calls.length
  assert.equal(dials, 5, 'a few quick dials before the watch parks')
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  assert.equal(wire.openRemoteEventsSocket.mock.calls.length, dials, 'a parked watch does not dial on a timer')
  assert.equal(wire.readRemoteIdentity.mock.calls.length, 1, 'with no window in sight, only the start check ran')

  // Someone comes back to the app: the machine is asked once, at once.
  h.looking.value = true
  h.activity.noteFocus(true)
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, 2, 'focus asks the absent machine')
  // Then on a slow beat while a window is in sight.
  await vi.advanceTimersByTimeAsync(15_000)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, 3, 'the re-check after the first wait')

  // The machine answers: the watch dials again at once.
  wire.readRemoteIdentity.mockResolvedValue(identity)
  let handlers: RemoteJsonSocketHandlers | null = null
  wire.openRemoteEventsSocket.mockImplementation(async (input: { handlers: RemoteJsonSocketHandlers }) => {
    handlers = input.handlers
    return { ok: true, value: watchSocket(input.handlers).socket }
  })
  await vi.advanceTimersByTimeAsync(30_000)
  assert.equal(wire.openRemoteEventsSocket.mock.calls.length, dials + 1, 'an answer brings the watch back')
  assert.ok(handlers, 'and it is open')
  const checks = wire.readRemoteIdentity.mock.calls.length
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, checks, 'a machine that answered is not re-checked')
})

test('a parked watch dials again when a followed conversation reaches its machine', async () => {
  // The record already says the machine answers (its identity read did), so
  // only the follow's own dial shows the watch it is worth trying again.
  wire.readRemoteIdentity.mockResolvedValue(identity)
  wire.openRemoteEventsSocket.mockResolvedValue(unreachable)
  wire.openRemoteConversationSocket.mockResolvedValue({
    ok: true,
    value: { send: () => undefined, close: () => undefined, isOpen: () => true },
  })
  const h = startMesh()
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(10_000)
  const dials = wire.openRemoteEventsSocket.mock.calls.length
  assert.equal(dials, 5, 'the watch parked')
  await h.mesh.followConversation({
    followId: 'pane',
    key: { connectionId: connection.id, workspaceId: 'w', agentId: 'a' },
    emit: () => undefined,
  })
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(wire.openRemoteConversationSocket.mock.calls.length, 1, 'the follow dialled')
  assert.equal(wire.openRemoteEventsSocket.mock.calls.length, dials + 1, 'and the watch dials with it')
})

test('on battery the re-checks of an absent machine stretch', async () => {
  wire.readRemoteIdentity.mockResolvedValue(unreachable)
  wire.openRemoteEventsSocket.mockResolvedValue(unreachable)
  const h = startMesh()
  h.activity.noteBattery(true)
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(10_000)
  const checks = wire.readRemoteIdentity.mock.calls.length
  // On mains the first re-check comes at 15 s; on battery at a minute.
  await vi.advanceTimersByTimeAsync(50_000)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, checks, 'no re-check inside the stretched wait')
  await vi.advanceTimersByTimeAsync(15_000)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, checks + 1)
})

test('a wake keeps a watch that answers its ping, and recycles one that does not, whose hello reports what changed', async () => {
  wire.readRemoteIdentity.mockResolvedValue(identity)
  const sockets: Array<ReturnType<typeof watchSocket>> = []
  wire.openRemoteEventsSocket.mockImplementation(async (input: { handlers: RemoteJsonSocketHandlers }) => {
    const socket = watchSocket(input.handlers)
    sockets.push(socket)
    return { ok: true, value: socket.socket }
  })
  const h = startMesh()
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(sockets.length, 1)
  sockets[0].handlers.onFrame({ type: 'hello', revisions: { terminals: 3, workspaces: 1, conversations: 7 } })
  const changes = () => h.events.filter((event) => event.kind === 'remote-changed')
  assert.equal(changes().length, 0, 'the first hello is where things stand, not a change')

  // A screen unlocked with the socket still there: it answers, and is kept.
  h.mesh.onWake()
  await vi.advanceTimersByTimeAsync(10_000)
  assert.equal(sockets[0].state.pings, 1, 'the wake asks the socket')
  assert.equal(sockets[0].isOpen(), true, 'a socket that answers is kept')
  assert.equal(sockets.length, 1, 'and nothing is dialled')

  // A sleep that a middlebox dropped the socket during: no answer, so it is recycled.
  sockets[0].state.answers = false
  h.mesh.onWake()
  await vi.advanceTimersByTimeAsync(4_999)
  assert.equal(sockets.length, 1, 'the ping gets its time')
  await vi.advanceTimersByTimeAsync(1)
  assert.equal(sockets[0].isOpen(), false, 'the old socket is closed from this end')
  assert.equal(sockets.length, 2, 'and a new one dialled')
  // The recycled socket's close arrives late; it is not a drop of the new one.
  sockets[0].handlers.onClosed({ code: null, reason: 'closed' })
  await vi.advanceTimersByTimeAsync(5_000)
  assert.equal(sockets.length, 2, 'a late close of the recycled socket dials nothing')
  sockets[1].handlers.onFrame({ type: 'hello', revisions: { terminals: 3, workspaces: 1, conversations: 9 } })
  assert.deepEqual(
    changes().map((event) => event.kind === 'remote-changed' && event.what),
    ['conversations'],
    'only the kind that moved while away',
  )
})

test('windows re-reading one machine share one browse, and a change push drops the shared answer', async () => {
  wire.readRemoteIdentity.mockResolvedValue(identity)
  let handlers: RemoteJsonSocketHandlers | null = null
  wire.openRemoteEventsSocket.mockImplementation(async (input: { handlers: RemoteJsonSocketHandlers }) => {
    handlers = input.handlers
    return { ok: true, value: watchSocket(input.handlers).socket }
  })
  const h = startMesh()
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(0)
  const before = wire.readRemoteIdentity.mock.calls.length
  const [a, b] = await Promise.all([h.mesh.browse(connection.id), h.mesh.browse(connection.id)])
  assert.equal(a.reachable && b.reachable, true)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, before + 1, 'two windows, one read')
  await h.mesh.browse(connection.id)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, before + 1, 'a read just after shares the answer')

  // A conversation push leaves the browse shared; a workspace push does not.
  handlers!.onFrame({ type: 'changed', what: 'conversations', revision: 1 })
  await h.mesh.browse(connection.id)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, before + 1)
  handlers!.onFrame({ type: 'changed', what: 'workspaces', revision: 1 })
  await h.mesh.browse(connection.id)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, before + 2, 'a change push is read from the machine')

  // And the share lapses on its own.
  await vi.advanceTimersByTimeAsync(2_000)
  await h.mesh.browse(connection.id)
  assert.equal(wire.readRemoteIdentity.mock.calls.length, before + 3)
})

test('the reachability timer runs only while a machine is paired', async () => {
  wire.readRemoteIdentity.mockResolvedValue(identity)
  wire.openRemoteEventsSocket.mockResolvedValue(unreachable)
  const empty = startMesh([])
  empty.mesh.start()
  assert.equal(vi.getTimerCount(), 0, 'nothing paired, nothing armed')
  empty.mesh.shutdown()

  const h = startMesh()
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(0)
  assert.ok(vi.getTimerCount() > 0)
  h.mesh.forget(connection.id)
  assert.equal(vi.getTimerCount(), 0, 'forgetting the last machine stops the timer and the watch')
})
