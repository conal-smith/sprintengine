import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'

import type { ConversationEvent, ConversationSessionFrame } from '../../shared/conversation-runtime'
import type { TailnetScope } from '../../shared/tailnet'
import type { MeshConversationFrame, MeshConversationKey } from '../../shared/tailnet-mesh'
import { ConversationRuntime } from '../conversation-runtime'
import type { ConversationProviderAdapter } from '../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationGatewayHost } from './tailnet/tailnet-conversation-host'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet/tailnet-mesh-service'
import { createTailnetMeshStore } from './tailnet/tailnet-mesh-store'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { createRemoteConversations } from './tailnet/tailnet-remote-conversations'
import {
  createRemoteConversationCache,
  type RemoteConversationCache,
} from './tailnet/tailnet-remote-conversation-cache'
import type { RemoteJsonSocket, RemoteJsonSocketHandlers } from './tailnet/tailnet-remote-client'
import { pairingUrl } from './tailnet/tailnet-service'
import { createScheduledMessages } from '../scheduled-messages/scheduled-messages'
import { studioHeldMessages, studioScheduledSends } from '../../server/core/studio-scheduled-messages'
import {
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_UPLOAD_PATH,
} from './tailnet/tailnet-routes'
import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'

// Another Studio desktop following this machine's conversations over the
// tailnet. Both halves are real: the gateway, its conversation socket, the
// session API and a conversation runtime on one side; the mesh service's
// conversation client, its kept copy on disk, and the real outbound socket on
// the other, over loopback TCP.

/** A provider whose turn streams whatever the test pushes, so a link can drop mid-reply. */
function pushProvider() {
  let push: (text: string | null) => void = () => undefined
  let started: () => void = () => undefined
  let turnStarted = new Promise<void>((resolve) => (started = resolve))
  let running = false
  const switched: string[] = []
  // A CLI chat provider takes a new model mid-conversation; mid-turn it says
  // the reply finishes on the model it started with, as the real ones do.
  const base = createMockConversationProvider({ liveModelSwitch: true })
  const adapter: ConversationProviderAdapter = {
    ...base,
    listModels: () => ['mock-model', 'mock-large'],
    setPermissionPreset: async () => ({ ok: true }),
    setModel: async (input) => {
      switched.push(input.nextModelId)
      return running ? { ok: true, notice: MID_TURN_NOTICE } : { ok: true }
    },
    sendTurn: (input) =>
      (async function* () {
        const queue: Array<string | null> = []
        let wake: (() => void) | null = null
        push = (text) => {
          queue.push(text)
          wake?.()
        }
        const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
          id: '',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: 1,
          type,
          payload,
        })
        running = true
        yield event('turn_started', { turnId: input.turnId })
        started()
        for (;;) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
          wake = null
          const text = queue.shift()!
          if (text === null) break
          yield event('content_delta', { turnId: input.turnId, text })
        }
        running = false
        yield event('turn_completed', { turnId: input.turnId })
      })(),
  }
  return {
    adapter,
    switched,
    turnStarted: () => turnStarted,
    nextTurn: () => (turnStarted = new Promise<void>((resolve) => (started = resolve))),
    push: (text: string | null) => push(text),
  }
}

const MID_TURN_NOTICE = 'The new model starts with your next message.'

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate(), what)
}

type Harness = {
  /** The far end's clock, which its scheduled messages keep time by. */
  hostNow(): number
  runtime: ConversationRuntime
  provider: ReturnType<typeof pushProvider>
  devices: TailnetDeviceStore
  localDir: string
  sessionId: string
  /** What the session API handed the gateway for each subscribe: the cursor asked with, and the frames produced. */
  joins: Array<{ afterSeq?: number; generation?: string; frames: ConversationSessionFrame[] }>
  mesh: TailnetMeshService
  newMesh(): TailnetMeshService
  pair(scopes: TailnetScope[]): Promise<string>
  stopServer(): Promise<void>
  restartServer(): Promise<void>
  close(): Promise<void>
}

const workspaceId = 'workspace'
const agentId = 'agent'

/**
 * The far end's gateway tools, for a test that starts a chat there: built once
 * the runtime and the workspace folder exist.
 */
type HarnessTools = (runtime: ConversationRuntime, workspaceRoot: string) => McpToolRegistration[]

async function startHarness(options: { holdQueued?: boolean; tools?: HarnessTools } = {}): Promise<Harness> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'remote-conversation-host-'))
  const remoteDir = mkdtempSync(join(tmpdir(), 'remote-conversation-devices-'))
  const localDir = mkdtempSync(join(tmpdir(), 'remote-conversation-local-'))
  const provider = pushProvider()
  const runtime = new ConversationRuntime({ adapters: [provider.adapter], getProviderById: () => undefined })
  // The far end's scheduled messages, where a queued send is held: the real
  // ones, kept in memory, following this runtime's chats and sending through
  // the host as a scheduled message does. Their clock runs past the start's
  // grace once started, so a held message is not kept waiting for it.
  let skew = 0
  let body: string | null = null
  const scheduled = options.holdQueued
    ? createScheduledMessages({
        storage: {
          read: async () => body,
          write: async (next) => {
            body = next
          },
        },
        listSessions: () => {
          const listed = runtime.listSessions()
          return listed.ok ? listed.sessions : []
        },
        onConversationEvent: (listener) => runtime.onEvent(listener),
        chatExists: (chat) => chat.workspaceId === workspaceId && chat.agentId === agentId,
        send: async (chat, text, commandId) => {
          const key = real.resolveKey(chat.workspaceId, chat.agentId)
          if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
          return real.command(key, 'studio-scheduled-message', commandId, { kind: 'send', message: text })
        },
        now: () => Date.now() + skew,
      })
    : null
  const real = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
    () => 'bypass',
    () => null,
    // The chat's CLI catalog, as the host's own picker would list it.
    async (providerId) =>
      providerId === provider.adapter.id
        ? {
            cli: 'mock-cli',
            cliLabel: 'Mock CLI',
            options: [
              { id: 'mock-model', label: 'Mock' },
              { id: 'mock-large', label: 'Mock Large' },
            ],
          }
        : null,
    undefined,
    scheduled
      ? { heldMessages: studioHeldMessages(() => scheduled), scheduledSends: studioScheduledSends(() => scheduled) }
      : {},
  )
  if (scheduled) {
    await scheduled.start()
    skew = 60_000
  }
  const joins: Harness['joins'] = []
  const conversations: ConversationGatewayHost = {
    ...real,
    subscribe(key, cursor, listener) {
      const join = {
        afterSeq: cursor.afterSeq,
        generation: cursor.generation,
        frames: [] as ConversationSessionFrame[],
      }
      joins.push(join)
      return real.subscribe(key, cursor, (frame) => {
        join.frames.push(frame)
        listener(frame)
      })
    },
  }
  const tools = options.tools?.(runtime, workspaceRoot) ?? []
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => remoteDir })
  const build = (port: number): TailnetGatewayServer =>
    createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => tools,
      isMutation: () => false,
      devices,
      conversations,
      peers: createTailnetPeerResolver({ runWhois: async () => null }),
    })
  let server = build(0)
  await server.start()
  const port = server.address()!.port
  // One keychain across launches, so a restarted client opens the pairing the
  // first one sealed.
  const keychain = createSecretCipherStandIn()
  const newMesh = () =>
    createTailnetMeshService({
      resolveUserDataDir: () => localDir,
      createStore: (options) => createTailnetMeshStore({ ...options, cipher: keychain }),
      resolveDeviceName: () => 'dev-macbook-air',
      resolvePeerName: async () => null,
      conversations: { retry: { baseMs: 20, maxMs: 200 }, saveDelayMs: 5, requestTimeoutMs: 5_000 },
    })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.adapter.id,
    modelId: provider.adapter.listModels()[0],
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const harness: Harness = {
    hostNow: () => Date.now() + skew,
    runtime,
    provider,
    devices,
    localDir,
    sessionId: started.session.sessionId,
    joins,
    mesh: newMesh(),
    newMesh,
    async pair(scopes) {
      const offer = devices.offerPairing({ scopes })
      const result = await harness.mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
      assert.ok(result.ok, result.ok ? '' : result.message)
      return result.connection.id
    },
    stopServer: () => server.stop(),
    async restartServer() {
      server = build(port)
      await server.start()
    },
    async close() {
      harness.mesh.shutdown()
      await scheduled?.dispose()
      await server.stop().catch(() => undefined)
      await runtime.shutdown()
      for (const dir of [workspaceRoot, remoteDir, localDir]) rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}

/** Everything one window was handed for a followed conversation. */
function follower(mesh: TailnetMeshService, key: MeshConversationKey, followId = 'pane-1') {
  const frames: MeshConversationFrame[] = []
  const following = mesh.followConversation({ followId, key, turnLimit: 10, emit: (frame) => frames.push(frame) })
  const of = <T extends MeshConversationFrame['type']>(type: T) =>
    frames.filter((frame): frame is Extract<MeshConversationFrame, { type: T }> => frame.type === type)
  return {
    frames,
    following,
    of,
    text: () =>
      of('event')
        .flatMap((frame) => (frame.event.type === 'content_delta' ? [String(frame.event.payload?.text)] : []))
        .join(''),
    seqs: () => of('event').map((frame) => frame.event.seq!),
    live: () => frames.some((frame) => frame.type === 'link' && frame.state === 'live'),
    link: () => of('link').at(-1),
  }
}

test('a paired desktop lists, follows and drives a conversation, and a dropped link resumes without a reset', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.access, 'operate')
    assert.deepEqual(
      listed.conversations.map((entry) => [entry.workspaceId, entry.agentId, entry.sessionId, entry.permissionPreset]),
      [[workspaceId, agentId, h.sessionId, 'bypass']],
      'the list carries the preset in force, across the wire',
    )

    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    assert.deepEqual(await pane.following, { ok: true })
    await waitFor(pane.live, 'the follow synchronizes and goes live')
    assert.equal(pane.of('snapshot').length, 1, 'a first follow is hydrated by one snapshot')

    // A send from this desktop starts a turn over there, on a chat in Bypass.
    // It is answered when the turn ends, as a send on the desktop itself is.
    const sent = h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    for (let index = 0; index < 5; index++) h.provider.push(`before-${index} `)
    await waitFor(() => pane.text().endsWith('before-4 '), 'live deltas reach the follower')
    const lastBefore = Math.max(...pane.seqs())

    // The link drops mid-reply; more of the reply lands and reaches nobody.
    const joinsBefore = h.joins.length
    await h.stopServer()
    await waitFor(() => pane.link()?.state !== 'live', 'the follower notices the drop')
    for (let index = 0; index < 5; index++) h.provider.push(`missed-${index} `)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await h.restartServer()
    await waitFor(() => h.joins.length > joinsBefore && pane.link()?.state === 'live', 'the follower reconnects')
    for (let index = 0; index < 3; index++) h.provider.push(`after-${index} `)
    h.provider.push(null)
    await waitFor(
      () => pane.of('event').some((frame) => frame.event.type === 'turn_completed'),
      'the rest of the turn arrives',
    )
    assert.deepEqual(await sent, { ok: true }, 'a send in flight across the drop is settled once, by its receipt')

    const rejoin = h.joins.at(-1)!
    assert.equal(rejoin.afterSeq !== undefined && rejoin.afterSeq >= lastBefore, true, 'the reconnect names its cursor')
    assert.ok(rejoin.generation, 'with the generation it was read from')
    assert.equal(
      rejoin.frames.some((frame) => frame.type === 'snapshot'),
      false,
      'a cursor the far end can vouch for gets no snapshot',
    )
    assert.equal(pane.of('snapshot').length, 1, 'the window was never reset')
    const seqs = pane.seqs()
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'in order',
    )
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicates')
    const expected = ['before', 'missed', 'after']
      .flatMap((phase) => Array.from({ length: phase === 'after' ? 3 : 5 }, (_, index) => `${phase}-${index} `))
      .join('')
    assert.equal(pane.text(), expected, 'every delta exactly once, across the drop')

    // And this desktop can switch the chat over there to No flag, and back.
    for (const preset of ['none', 'bypass'] as const) {
      assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'setPermissionPreset', preset } }), {
        ok: true,
      })
      const relisted = await h.mesh.listConversations(connectionId)
      assert.ok(relisted.ok)
      assert.equal(relisted.conversations[0]?.permissionPreset, preset)
    }
  } finally {
    await h.close()
  }
})

test("a paired desktop switches a chat's model within its CLI, and the host's session and list follow", async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.modelSwitch, true, 'the host advertises model switching')
    assert.deepEqual(
      listed.conversations[0]?.models,
      {
        cli: 'mock-cli',
        cliLabel: 'Mock CLI',
        liveModelSwitch: true,
        options: [
          { id: 'mock-model', label: 'Mock' },
          { id: 'mock-large', label: 'Mock Large' },
        ],
      },
      'the list carries the catalog across the wire',
    )
    assert.equal(listed.conversations[0]?.modelId, 'mock-model')

    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')

    // Between turns the switch simply applies.
    assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'setModel', modelId: 'mock-large' } }), {
      ok: true,
    })
    assert.deepEqual(h.provider.switched, ['mock-large'])
    const hostSession = h.runtime.listSessions({ workspaceId, agentId })
    assert.ok(hostSession.ok)
    assert.equal(hostSession.sessions[0]?.modelId, 'mock-large', "the host's session is on the new model")
    const relisted = await h.mesh.listConversations(connectionId)
    assert.ok(relisted.ok)
    assert.equal(relisted.conversations[0]?.modelId, 'mock-large', 'and the list names it')
    await waitFor(
      () => pane.of('event').some((frame) => frame.event.type === 'session_updated'),
      "the follower sees the host's own record of the switch",
    )

    // Mid-turn, the answer says the switch applies from the next turn.
    const sent = h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'setModel', modelId: 'default' } }), {
      ok: true,
      notice: MID_TURN_NOTICE,
    })
    h.provider.push(null)
    assert.deepEqual(await sent, { ok: true })

    // A model the CLI does not offer is refused by the host with its own code.
    const refused = await h.mesh.conversationCommand({ key, command: { kind: 'setModel', modelId: 'gpt-large' } })
    assert.equal(!refused.ok && refused.code, 'unsupported_model')
    assert.deepEqual(h.provider.switched, ['mock-large', 'default'])
  } finally {
    await h.close()
  }
})

test('a paired desktop attaches images to a message: each goes up the upload route and the send names them', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    assert.deepEqual(await pane.following, { ok: true })
    await waitFor(pane.live, 'the follow goes live')
    const turns = vi.spyOn(h.runtime, 'sendTurn')

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6])
    const sent = h.mesh.conversationSend({
      key,
      message: 'look at these',
      attachments: [
        { id: 'a-1', mediaType: 'image/png', dataBase64: png.toString('base64'), name: 'screen.png', byteLength: 11 },
        // Pasted from the clipboard, so it has no name of its own.
        { id: 'a-2', mediaType: 'image/jpeg', dataBase64: jpeg.toString('base64'), byteLength: 7 },
      ],
    })
    await h.provider.turnStarted()
    h.provider.push(null)
    assert.deepEqual(await sent, { ok: true })
    const turn = turns.mock.calls.at(-1)![0]
    assert.equal(turn.message, 'look at these', 'the words arrive as they were written, with no paths in them')
    assert.deepEqual(
      turn.attachments?.map((attachment) => [
        attachment.mediaType,
        attachment.name,
        Buffer.from(attachment.dataBase64, 'base64').equals(attachment.mediaType === 'image/png' ? png : jpeg),
      ]),
      [
        ['image/png', 'screen.png', true],
        ['image/jpeg', 'image-2.jpg', true],
      ],
      'the chat over there is handed the same bytes, in order, under a name each',
    )

    // A message without images is the send it always was.
    h.provider.nextTurn()
    const plain = h.mesh.conversationSend({ key, message: 'and this', attachments: [] })
    await h.provider.turnStarted()
    h.provider.push(null)
    assert.deepEqual(await plain, { ok: true })
    assert.equal(turns.mock.calls.at(-1)![0].attachments?.length ?? 0, 0)

    // What the local boundary refuses is refused here, before anything goes up.
    const turnsBefore = turns.mock.calls.length
    const tooMany = await h.mesh.conversationSend({
      key,
      message: 'many',
      attachments: Array.from({ length: 17 }, (_, index) => ({
        id: `m-${index}`,
        mediaType: 'image/png',
        dataBase64: png.toString('base64'),
        byteLength: png.length,
      })),
    })
    assert.equal(tooMany.ok, false)
    assert.equal(tooMany.ok ? '' : tooMany.code, 'invalid_arguments')
    const notAnImage = await h.mesh.conversationSend({
      key,
      message: 'a document',
      attachments: [{ id: 'p-1', mediaType: 'application/pdf', dataBase64: png.toString('base64'), byteLength: 11 }],
    })
    assert.equal(notAnImage.ok ? '' : notAnImage.code, 'invalid_arguments')

    // A chat the machine does not list as taking images is told so in words.
    const elsewhere = await h.mesh.conversationSend({
      key: { ...key, agentId: 'not-listed' },
      message: 'look',
      attachments: [{ id: 'e-1', mediaType: 'image/png', dataBase64: png.toString('base64'), byteLength: 11 }],
    })
    assert.equal(elsewhere.ok ? '' : elsewhere.code, 'images_unsupported')
    assert.equal(turns.mock.calls.length, turnsBefore, 'no refused message started a turn')
  } finally {
    await h.close()
  }
})

test('a machine whose handshake leaves uploads out is not sent an image, and says so in words', async () => {
  let uploads = 0
  let toolCalls = 0
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'],
    transportVersion: 2,
    capabilities: ['events', 'conversations'],
  }
  const peer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    request.resume()
    if (path === TAILNET_UPLOAD_PATH) uploads++
    if (path === TAILNET_MCP_PATH) toolCalls++
    const known = path === TAILNET_PAIR_PATH || path === TAILNET_IDENTITY_PATH
    response.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(path === TAILNET_PAIR_PATH ? { ...device, deviceToken: 'device-token' } : device))
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const dir = mkdtempSync(join(tmpdir(), 'remote-conversation-older-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  try {
    const port = (peer.address() as { port: number }).port
    const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
    assert.ok(paired.ok, paired.ok ? '' : paired.message)
    await mesh.checkReachability(paired.connection.id)
    const answer = await mesh.conversationSend({
      key: { connectionId: paired.connection.id, workspaceId, agentId },
      message: 'look',
      attachments: [{ id: 'a-1', mediaType: 'image/png', dataBase64: 'iVBORw==', byteLength: 4 }],
    })
    assert.equal(answer.ok ? '' : answer.code, 'images_unsupported')
    assert.match(answer.ok ? '' : answer.message, /Update Studio there/)
    assert.equal(uploads, 0)

    // A New chat with images is refused the same way, before a chat is made
    // over there that would be left empty.
    const created = await mesh.createConversation({
      connectionId: paired.connection.id,
      workspaceId,
      prompt: 'look',
      attachments: [{ id: 'a-1', mediaType: 'image/png', dataBase64: 'iVBORw==', byteLength: 4 }],
    })
    assert.equal(created.ok ? '' : created.code, 'images_unsupported')
    assert.match(created.ok ? '' : created.message, /Update Studio there/)
    assert.equal(toolCalls, 0, 'no chat was asked for')
    assert.equal(uploads, 0)
  } finally {
    mesh.shutdown()
    await new Promise<void>((resolve) => peer.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The far end's `conversation.create` and `conversation.settle`, as a test
 * double: a create starts a session for `newAgentId` in the harness workspace
 * (or, for `ghostAgentId`, answers with a chat that has none), and both
 * record what they were asked.
 */
function chatTools(record: { creates: Array<Record<string, unknown>>; settles: Array<Record<string, unknown>> }) {
  return ((runtime, workspaceRoot) => [
    {
      name: 'conversation.create',
      description: 'Start a chat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      handler: async (args) => {
        record.creates.push(args)
        const agent = args.cli === 'ghost' ? ghostAgentId : newAgentId
        let sessionId = 'none'
        if (agent === newAgentId) {
          const started = await runtime.startSession({
            workspaceRoot,
            workspaceId,
            agentId: agent,
            providerId: 'mock-provider',
            modelId: 'mock-model',
            permissionPreset: 'bypass',
          })
          if (!started.ok) return toolError('conversation_start_failed', started.message)
          sessionId = started.session.sessionId
        }
        return toolSuccess({
          conversation: {
            workspaceId,
            agentId: agent,
            name: 'Chat 2',
            providerId: 'mock',
            modelId: 'mock-model',
            sessionId,
          },
        })
      },
    },
    {
      name: 'conversation.settle',
      description: 'Settle a chat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      handler: async (args) => {
        record.settles.push(args)
        return toolSuccess({ workspaceId: args.workspaceId, settledAt: 1 })
      },
    },
  ]) satisfies HarnessTools
}

const newAgentId = 'agent-new'
const ghostAgentId = 'agent-ghost'

test('a New chat on a paired desktop takes its images with its first message, as one here does', async () => {
  const record = { creates: [] as Array<Record<string, unknown>>, settles: [] as Array<Record<string, unknown>> }
  const h = await startHarness({ tools: chatTools(record) })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const turns = vi.spyOn(h.runtime, 'sendTurn')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9])
    const created = h.mesh.createConversation({
      connectionId,
      workspaceId,
      cli: 'mock-cli',
      prompt: 'what is in this screenshot',
      permissionPreset: 'bypass',
      attachments: [
        { id: 'a-1', mediaType: 'image/png', dataBase64: png.toString('base64'), name: 'shot.png', byteLength: 11 },
      ],
    })
    await h.provider.turnStarted()
    const answer = await created
    assert.ok(answer.ok, answer.ok ? '' : answer.message)
    assert.equal(answer.agentId, newAgentId, 'the chat over there is the one opened here')
    assert.equal(record.creates.length, 1)
    assert.equal(record.creates[0]?.prompt, undefined, 'the chat is made without its words, which follow its images')
    const turn = turns.mock.calls.at(-1)![0]
    assert.notEqual(turn.sessionId, h.sessionId, 'the turn is the new chat’s, not the one already there')
    assert.equal(turn.message, 'what is in this screenshot', 'the words arrive as written, with no path in them')
    assert.deepEqual(
      turn.attachments?.map((attachment) => [
        attachment.mediaType,
        attachment.name,
        Buffer.from(attachment.dataBase64, 'base64').equals(png),
      ]),
      [['image/png', 'shot.png', true]],
      'the chat over there is handed the same bytes as its first message',
    )
    assert.equal(record.settles.length, 0, 'a chat that took its message is left alone')
    h.provider.push(null)
  } finally {
    await h.close()
  }
})

test('a New chat whose images cannot go is refused, and the empty chat over there is put to rest', async () => {
  const record = { creates: [] as Array<Record<string, unknown>>, settles: [] as Array<Record<string, unknown>> }
  const h = await startHarness({ tools: chatTools(record) })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const turns = vi.spyOn(h.runtime, 'sendTurn')
    // A chat over there with no live session to keep an upload for: it reads
    // as a chat that takes no images, as one whose CLI reads none does.
    const answer = await h.mesh.createConversation({
      connectionId,
      workspaceId,
      cli: 'ghost',
      prompt: 'look',
      attachments: [{ id: 'a-1', mediaType: 'image/png', dataBase64: 'iVBORw==', byteLength: 4 }],
    })
    assert.equal(answer.ok ? '' : answer.code, 'images_unsupported')
    assert.match(answer.ok ? '' : answer.message, /first message did not go: .*does not take images/u)
    await waitFor(() => record.settles.length === 1, 'the empty chat is settled')
    assert.equal(record.settles[0]?.workspaceId, workspaceId)
    assert.equal(turns.mock.calls.length, 0, 'nothing was sent in place of the images')

    // Bad images are refused before anything is made.
    const before = record.creates.length
    const invalid = await h.mesh.createConversation({
      connectionId,
      workspaceId,
      prompt: 'a document',
      attachments: [{ id: 'p-1', mediaType: 'application/pdf', dataBase64: 'iVBORw==', byteLength: 4 }],
    })
    assert.equal(invalid.ok ? '' : invalid.code, 'invalid_arguments')
    assert.equal(record.creates.length, before, 'no chat was asked for')

    // Without images, a New chat is asked for with its words, as it always was.
    const plain = await h.mesh.createConversation({ connectionId, workspaceId, cli: 'ghost', prompt: 'hello' })
    assert.ok(plain.ok, plain.ok ? '' : plain.message)
    assert.equal(record.creates.at(-1)?.prompt, 'hello')
  } finally {
    await h.close()
  }
})

test('a restarted client shows its kept copy at once and resumes from its cursor; a new generation resets it', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const key = { connectionId, workspaceId, agentId }
    const first = follower(h.mesh, key)
    await waitFor(first.live, 'first follow goes live')
    const sent = h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'one' } })
    await h.provider.turnStarted()
    h.provider.push('kept ')
    h.provider.push(null)
    assert.deepEqual(await sent, { ok: true })
    await waitFor(() => first.of('event').some((frame) => frame.event.type === 'turn_completed'), 'first turn lands')
    const heldThrough = Math.max(...first.seqs())
    h.mesh.shutdown()

    // Offline: another turn happens over there.
    h.provider.nextTurn()
    const sending = h.runtime.sendTurn({ sessionId: h.sessionId, message: 'two' })
    await h.provider.turnStarted()
    h.provider.push('missed ')
    h.provider.push(null)
    await sending

    // A fresh process: nothing in memory, the copy on disk.
    h.mesh = h.newMesh()
    const joinsBefore = h.joins.length
    const second = follower(h.mesh, key, 'pane-2')
    await second.following
    const cached = second.of('snapshot')[0]
    assert.ok(cached, 'the kept copy is handed over at once')
    assert.equal(cached.reset, undefined)
    assert.ok(
      cached.page.events.some((event) => event.type === 'content_delta' && event.payload?.text === 'kept '),
      'with what was followed before the restart',
    )
    await waitFor(second.live, 'the restarted client resumes')
    await waitFor(() => second.text().includes('missed '), 'the missed turn arrives')
    const rejoin = h.joins.slice(joinsBefore).at(-1)!
    assert.ok(rejoin.afterSeq !== undefined && rejoin.afterSeq >= heldThrough, 'resumed from the persisted cursor')
    assert.equal(
      rejoin.frames.some((frame) => frame.type === 'snapshot'),
      false,
      'incrementally, with no snapshot',
    )
    assert.equal(second.of('snapshot').length, 1, 'only the kept copy hydrated the window')
    assert.ok(
      second.seqs().every((seq) => seq > heldThrough),
      'nothing already held arrives twice',
    )
    h.mesh.shutdown()

    // The copy now names a log generation the far end no longer has.
    const directory = join(h.localDir, 'tailnet-remote-conversations')
    const [file] = readdirSync(directory)
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Record<string, unknown>
    writeFileSync(join(directory, file), JSON.stringify({ ...record, generation: 'a-recreated-log' }))
    h.mesh = h.newMesh()
    const third = follower(h.mesh, key, 'pane-3')
    await waitFor(() => third.of('snapshot').some((frame) => frame.reset === true), 'another generation resets')
    const reset = third.of('snapshot').find((frame) => frame.reset === true)!
    assert.ok(reset.generation && reset.generation !== 'a-recreated-log', 'the reset names the live generation')
    assert.ok(
      reset.page.events.some((event) => event.payload?.text === 'missed '),
      'and replaces the copy',
    )
    await waitFor(third.live, 'and goes live after the reset')
  } finally {
    await h.close()
  }
})

test('a grant narrowed to read refuses commands; one without read ends the follow for good', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const deviceId = h.devices.listDevices()[0].id
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'follow goes live')
    assert.equal(pane.link()?.access, 'operate')

    h.devices.updateDeviceScopes(deviceId, ['conversation:read'])
    const refused = await h.mesh.conversationCommand({ key, command: { kind: 'interrupt' } })
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.code, 'conversation_operate_required')
    assert.equal(pane.link()?.access, 'read', 'the window learns it is read-only')
    // Known to be read-only now: refused here, without a round trip.
    const again = await h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'hi' } })
    assert.equal(!again.ok && again.code, 'conversation_operate_required')

    // A permanent rule is refused before it leaves this machine.
    const always = await h.mesh.conversationCommand({
      key,
      command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
    })
    assert.equal(!always.ok && always.code, 'unsafe_remote_decision')

    const joins = h.joins.length
    h.devices.updateDeviceScopes(deviceId, ['workspace:read'])
    await waitFor(() => pane.link()?.state === 'closed', 'losing read closes the follow')
    assert.equal(pane.link()?.code, 'conversation_scope_required')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(h.joins.length, joins, 'and it does not dial again')

    const listed = await h.mesh.listConversations(connectionId)
    assert.equal(!listed.ok && listed.code, 'conversation_scope_required')
  } finally {
    await h.close()
  }
})

test('a revoked pairing ends the follow and is recorded as unauthorized', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read'])
    const pane = follower(h.mesh, { connectionId, workspaceId, agentId })
    await waitFor(pane.live, 'follow goes live')
    assert.equal(pane.link()?.access, 'read')
    h.devices.revokeDevice(h.devices.listDevices()[0].id)
    await waitFor(() => pane.link()?.state === 'closed', 'revocation closes the follow')
    assert.equal(pane.link()?.code, 'revoked')
    const reach = h.mesh.getLiveState().reachability.find((entry) => entry.connectionId === connectionId)
    assert.equal(reach?.unauthorized, true)
  } finally {
    await h.close()
  }
})

test('a resync close waits the delay the far end advised before dialling again', async () => {
  // On the fake clock: the assertions are about the advised 400 ms, and on a
  // busy machine a real 250 ms sleep can overrun it and see a dial that was due.
  vi.useFakeTimers()
  try {
    const dials: number[] = []
    const handlers: RemoteJsonSocketHandlers[] = []
    const cache: RemoteConversationCache = {
      load: async () => null,
      save: async () => undefined,
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    }
    const client = createRemoteConversations({
      cache,
      retry: { baseMs: 5, maxMs: 10 },
      resolveConnection: () => ({
        id: 'c',
        machineName: 'mac-mini',
        endpoint: { host: 'mac-mini.tail1234.ts.net', port: 1 },
        token: 't',
        scopes: ['conversation:read'],
      }),
      openSocket: async (input) => {
        dials.push(Date.now())
        handlers.push(input.handlers)
        return { ok: true, value: { send: () => undefined, close: () => undefined, isOpen: () => true } }
      },
    })
    const frames: MeshConversationFrame[] = []
    await client.follow({
      followId: 'pane',
      key: { connectionId: 'c', workspaceId, agentId },
      emit: (frame) => frames.push(frame),
    })
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(dials.length, 1, 'first dial')
    handlers[0].onFrame({ type: 'error', code: 'resync_required', message: 'behind', retryAfterMs: 400 })
    handlers[0].onClosed({ code: 4409, reason: 'resync_required;retryAfterMs=400' })
    await vi.advanceTimersByTimeAsync(250)
    assert.equal(dials.length, 1, 'no dial before the advised delay, whatever the backoff says')
    client.onWake()
    await vi.advanceTimersByTimeAsync(50)
    assert.equal(dials.length, 1, 'a wake does not cut an advised delay short')
    await vi.advanceTimersByTimeAsync(100)
    assert.equal(dials.length, 2, 'dials again once the delay has passed')
    assert.ok(dials[1] - dials[0] >= 400, `waited ${dials[1] - dials[0]} ms`)
    client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a frame of a known type in the wrong shape ends the follow instead of being skipped', async () => {
  const handlers: RemoteJsonSocketHandlers[] = []
  const client = createRemoteConversations({
    cache: {
      load: async () => null,
      save: async () => undefined,
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    },
    resolveConnection: () => ({
      id: 'c',
      machineName: 'build-box',
      endpoint: { host: 'build-box.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read'],
    }),
    openSocket: async (input) => {
      handlers.push(input.handlers)
      return { ok: true, value: { send: () => undefined, close: () => undefined, isOpen: () => true } }
    },
  })
  const frames: MeshConversationFrame[] = []
  await client.follow({ followId: 'p', key: { connectionId: 'c', workspaceId, agentId }, emit: (f) => frames.push(f) })
  await waitFor(() => handlers.length === 1, 'dialled')
  // A newer desktop's frame type is ignored.
  handlers[0].onFrame({ type: 'presence', who: 'someone' })
  const before = frames.at(-1)
  assert.equal(before?.type === 'link' && before.state, 'connecting')
  handlers[0].onFrame({ type: 'event', event: { id: 'e', seq: 'twelve' } })
  const last = frames.at(-1)
  assert.equal(last?.type === 'link' && last.state, 'closed')
  assert.equal(last?.type === 'link' && last.code, 'protocol')
  client.shutdown()
})

test('a snapshot sent in parts and chunks is applied once whole, and a busy command is retried under its own id', async () => {
  const handlers: RemoteJsonSocketHandlers[] = []
  const sent: Array<Record<string, unknown>> = []
  const client = createRemoteConversations({
    cache: {
      load: async () => null,
      save: async () => undefined,
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    },
    retry: { baseMs: 5, maxMs: 10 },
    resolveConnection: () => ({
      id: 'c',
      machineName: 'mac-mini',
      endpoint: { host: 'mac-mini.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read', 'conversation:operate'],
    }),
    openSocket: async (input) => {
      handlers.push(input.handlers)
      return { ok: true, value: { send: (frame) => sent.push(frame), close: () => undefined, isOpen: () => true } }
    },
  })
  const frames: MeshConversationFrame[] = []
  const key = { connectionId: 'c', workspaceId, agentId }
  await client.follow({ followId: 'p', key, emit: (f) => frames.push(f) })
  await waitFor(() => handlers.length === 1, 'dialled')
  const event = (seq: number, text: string) => ({
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId,
    agentId,
    providerId: 'p',
    modelId: 'm',
    type: 'content_delta',
    createdAt: 1,
    payload: { text, turnId: 't' },
  })
  const part = (index: number, events: unknown[]) => ({
    type: 'snapshot',
    page: { events, hasMore: false, beforeCursor: null },
    generation: 'g1',
    part: { index, total: 2 },
  })
  handlers[0].onFrame(part(0, [event(1, 'a'), event(2, 'b')]))
  assert.equal(frames.filter((frame) => frame.type === 'snapshot').length, 0, 'nothing is applied from half a snapshot')
  // The second part is larger than one frame, so it arrives as chunks.
  const json = JSON.stringify(part(1, [event(5, 'c')]))
  const pieces = [json.slice(0, 40), json.slice(40, 90), json.slice(90)]
  pieces.forEach((piece, index) =>
    handlers[0].onFrame({ type: 'chunk', frameId: 'f1', index, total: pieces.length, json: piece }),
  )
  const snapshots = frames.filter((frame) => frame.type === 'snapshot')
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0].type === 'snapshot' && snapshots[0].page.events.map((entry) => entry.seq), [1, 2, 5])
  // A fence for another conversation — the tail of a replay the host was
  // switching away from — is never taken as this one's cursor.
  handlers[0].onFrame({ type: 'synchronized', seq: 99, generation: 'gx', key: { workspaceId, agentId: 'other' } })
  assert.equal(frames.filter((frame) => frame.type === 'synchronized').length, 0)
  handlers[0].onFrame({ type: 'synchronized', seq: 5, generation: 'g1', key: { workspaceId, agentId } })
  assert.equal(frames.filter((frame) => frame.type === 'synchronized').length, 1)
  // Sequence 6 and 7 never arrive on their own: 8 is a merged run. A gap is
  // normal and never a reason to resubscribe.
  handlers[0].onFrame({ type: 'event', event: event(8, 'd') })
  assert.equal(sent.filter((frame) => frame.type === 'subscribe').length, 1)
  assert.equal(frames.at(-1)?.type, 'event')

  const result = client.command(key, { kind: 'interrupt' })
  await waitFor(() => sent.some((frame) => frame.type === 'command'), 'the command is sent')
  const first = sent.find((frame) => frame.type === 'command')!
  handlers[0].onFrame({ type: 'commandResult', commandId: first.commandId, ok: false, code: 'busy', retryAfterMs: 20 })
  await waitFor(() => sent.filter((frame) => frame.type === 'command').length === 2, 'retried after the delay')
  const second = sent.filter((frame) => frame.type === 'command')[1]
  assert.equal(second.commandId, first.commandId, 'under the same command id')
  handlers[0].onFrame({ type: 'commandResult', commandId: first.commandId, ok: true })
  assert.deepEqual(await result, { ok: true })

  // A read the far end refuses as too large is answered, and the follow stays up.
  const detail = client.toolDetail(key, 'tool-1')
  await waitFor(() => sent.some((frame) => frame.type === 'getToolDetail'), 'the read is sent')
  const read = sent.find((frame) => frame.type === 'getToolDetail')!
  handlers[0].onFrame({ type: 'result', requestId: read.requestId, ok: false, code: 'too_large', message: 'Too big.' })
  assert.deepEqual(await detail, { ok: false, code: 'unavailable', message: 'Too big.' })
  client.shutdown()
})

test('a kept copy read back while its write is in flight is the copy that write leaves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-conversation-cache-'))
  try {
    const cache = createRemoteConversationCache({ resolveUserDataDir: () => dir })
    const cacheKey = { connectionId: 'c', workspaceId, agentId }
    const page = (text: string) => ({
      events: [
        {
          id: 'e1',
          seq: 7,
          sessionId: 's',
          workspaceId,
          agentId,
          providerId: 'p',
          modelId: 'm',
          type: 'content_delta' as const,
          createdAt: 1,
          payload: { text },
        },
      ],
      hasMore: false,
      beforeCursor: null,
    })
    await cache.save(cacheKey, { generation: 'g', lastSeq: 7, page: page('old') })
    void cache.save(cacheKey, { generation: 'g', lastSeq: 9, page: page('new') })
    const loaded = await cache.load(cacheKey)
    assert.equal(loaded?.lastSeq, 9)
    assert.equal(loaded?.page.events[0].payload?.text, 'new')
    // A copy for another conversation is never read as this one's.
    assert.equal(await cache.load({ ...cacheKey, agentId: 'other' }), null)
    await cache.forgetConnection('c')
    assert.equal(await cache.load(cacheKey), null, 'forgetting the machine deletes what was kept of it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A follow client whose sockets and kept copy the test drives, on fake timers. */
function drivenClient(
  overrides: { isOnBattery?: () => boolean; dial?: 'ok' | 'fail'; capabilities?: string[] | null } = {},
) {
  const handlers: RemoteJsonSocketHandlers[] = []
  const sockets: Array<{ socket: RemoteJsonSocket; closed: boolean }> = []
  // Every frame this client sent, on any socket.
  const sent: Array<Record<string, unknown>> = []
  const saves: Array<{ lastSeq: number | null; events: number }> = []
  const away: string[] = []
  let dial = overrides.dial ?? 'ok'
  let release: (() => void) | null = null
  let hold = false
  const client = createRemoteConversations({
    cache: {
      load: async () => null,
      save: async (_key, record) => {
        saves.push({ lastSeq: record.lastSeq, events: record.page.events.length })
      },
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    },
    retry: { baseMs: 500, maxMs: 15_000 },
    ...(overrides.isOnBattery ? { isOnBattery: overrides.isOnBattery } : {}),
    ...(overrides.capabilities !== undefined ? { capabilitiesOf: () => overrides.capabilities } : {}),
    onAway: (connectionId) => away.push(connectionId),
    resolveConnection: () => ({
      id: 'c',
      machineName: 'mac-mini',
      endpoint: { host: 'mac-mini.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read', 'conversation:operate'],
    }),
    openSocket: async (input) => {
      handlers.push(input.handlers)
      if (hold) await new Promise<void>((resolve) => (release = resolve))
      if (dial === 'fail') return { ok: false, code: 'unreachable', message: 'mac-mini did not answer.' }
      const entry = { closed: false, socket: null as unknown as RemoteJsonSocket }
      entry.socket = {
        send: (frame) => {
          sent.push(frame)
        },
        close: () => {
          entry.closed = true
        },
        isOpen: () => !entry.closed,
      }
      sockets.push(entry)
      return { ok: true, value: entry.socket }
    },
  })
  const frames: MeshConversationFrame[] = []
  const key = { connectionId: 'c', workspaceId, agentId }
  const event = (seq: number, type: string, payload: Record<string, unknown> = { text: 'x', turnId: 't' }) => ({
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId,
    agentId,
    providerId: 'p',
    modelId: 'm',
    type,
    createdAt: 1,
    payload,
  })
  return {
    client,
    handlers,
    sockets,
    sent,
    saves,
    away,
    frames,
    key,
    event,
    setDial: (next: 'ok' | 'fail') => (dial = next),
    holdDials: (next: boolean) => (hold = next),
    releaseDial: () => release?.(),
    follow: (followId = 'p') => client.follow({ followId, key, emit: (frame) => frames.push(frame) }),
    link: () => frames.filter((frame) => frame.type === 'link').at(-1),
    fence: (seq: number) =>
      handlers.at(-1)!.onFrame({ type: 'synchronized', seq, generation: 'g1', key: { workspaceId, agentId } }),
  }
}

test('a streaming reply is kept on a slow beat, and at once where a turn ends', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient()
    await d.follow()
    await vi.advanceTimersByTimeAsync(0)
    d.fence(1)
    assert.equal(d.saves.length, 1, 'the fence is kept at once')
    // A reply streaming for two seconds, four deltas a second.
    for (let seq = 2; seq < 10; seq++) {
      d.handlers[0].onFrame({ type: 'event', event: d.event(seq, 'content_delta') })
      await vi.advanceTimersByTimeAsync(250)
    }
    assert.equal(d.saves.length, 1, 'no write per delta')
    await vi.advanceTimersByTimeAsync(8_000)
    assert.equal(d.saves.length, 2, 'one write on the slow beat')
    assert.equal(d.saves.at(-1)?.lastSeq, 9)
    d.handlers[0].onFrame({ type: 'event', event: d.event(10, 'content_delta') })
    d.handlers[0].onFrame({ type: 'event', event: d.event(11, 'turn_completed', { turnId: 't' }) })
    assert.equal(d.saves.length, 3, 'the end of the turn is kept at once')
    assert.equal(d.saves.at(-1)?.lastSeq, 11)
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(d.saves.length, 3, 'nothing left to write')
    // A reconnect that finds nothing new rewrites nothing.
    d.handlers[0].onClosed({ code: null, reason: 'dropped' })
    await vi.advanceTimersByTimeAsync(1_000)
    d.fence(11)
    assert.equal(d.saves.length, 3, 'an unchanged fence is not a write')
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('on battery the slow beat stretches', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient({ isOnBattery: () => true })
    await d.follow()
    await vi.advanceTimersByTimeAsync(0)
    d.fence(1)
    d.handlers[0].onFrame({ type: 'event', event: d.event(2, 'content_delta') })
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(d.saves.length, 1)
    await vi.advanceTimersByTimeAsync(2_000)
    assert.equal(d.saves.length, 2)
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a follow on a machine that stops answering parks until it is resumed or the machine wakes', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient({ dial: 'fail' })
    await d.follow()
    await vi.advanceTimersByTimeAsync(10_000)
    const dials = d.handlers.length
    assert.equal(dials, 4, 'the first dial and a few quick retries')
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'offline')
    assert.deepEqual(d.away, ['c'], 'the owner is told once')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    assert.equal(d.handlers.length, dials, 'a parked follow does not dial on a timer')
    assert.equal(d.client.parkedOn('c'), true)

    d.client.resume('c')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 1, 'resume dials once')
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'offline', 'and parks again on a failure')
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(d.handlers.length, dials + 1)
    await d.follow('another-window')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 2, 'another window opening it dials once')

    d.setDial('ok')
    d.client.onWake()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 3, 'a wake dials a parked follow')
    d.fence(1)
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'live')
    assert.equal(d.client.parkedOn('c'), false)
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a follow woken, resumed and joined while its dial is out opens one socket', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient({ dial: 'fail' })
    await d.follow()
    await vi.advanceTimersByTimeAsync(10_000)
    assert.equal(d.client.parkedOn('c'), true)
    const dials = d.handlers.length
    d.setDial('ok')
    d.holdDials(true)
    d.client.resume('c')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 1, 'the dial is out')
    // Everything else that would dial lands while it is out.
    d.client.onWake()
    d.client.resume('c')
    await d.follow('p2')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 1, 'none of it dials a second time')
    d.releaseDial()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.sockets.length, 1, 'one socket, none orphaned')
    d.fence(1)
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'live')
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a message queued while the turn runs over there is held there, and goes when the turn ends with this desktop gone', async () => {
  const h = await startHarness({ holdQueued: true })
  const asked: string[] = []
  const stopListening = h.runtime.onEvent((event) => {
    if (event.type === 'user_message' && event.workspaceId === workspaceId && event.agentId === agentId)
      asked.push(String(event.payload?.text ?? ''))
  })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.queuedSends, true, 'the machine says it holds queued messages')
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')
    await waitFor(() => pane.of('queued').length > 0, 'told what the machine holds, nothing yet')
    assert.deepEqual(pane.of('queued').at(-1)?.messages, [])

    void h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    // A held message is its words alone: one with pictures is refused here.
    const withPicture = await h.mesh.conversationSend({
      key,
      message: 'Look at this.',
      queue: true,
      attachments: [{ id: 'a', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'a.png', byteLength: 8 }],
    })
    assert.equal(withPicture.ok, false)
    assert.equal(!withPicture.ok && withPicture.code, 'invalid_arguments')
    // Queued mid-turn, as the window sends it: answered as soon as it is held,
    // long before the turn ends.
    const queued = await h.mesh.conversationSend({ key, message: 'And then the docs.', queue: true })
    assert.deepEqual(queued, { ok: true })
    await waitFor(() => pane.of('queued').at(-1)?.messages.length === 1, 'the window sees what is held there')
    assert.equal(pane.of('queued').at(-1)?.messages[0]?.text, 'And then the docs.')

    // The laptop closes: nothing on this side is left to send it.
    h.mesh.shutdown()
    h.provider.nextTurn()
    h.provider.push(null)
    await h.provider.turnStarted()
    assert.deepEqual(asked, ['stream', 'And then the docs.'], 'the machine sent it into the chat once the turn ended')
    h.provider.push(null)
  } finally {
    stopListening()
    await h.close()
  }
})

test('a held message is taken back from here, and every window is told it is gone', async () => {
  const h = await startHarness({ holdQueued: true })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')
    void h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    await h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'Maybe this.', queue: true } })
    await waitFor(() => pane.of('queued').at(-1)?.messages.length === 1, 'held')
    // A second window opened now is told at once, without asking the machine again.
    const second = follower(h.mesh, key, 'pane-2')
    await second.following
    assert.equal(second.of('queued').at(-1)?.messages[0]?.text, 'Maybe this.')
    const queuedId = pane.of('queued').at(-1)!.messages[0]!.id
    assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'cancelQueued', queuedId } }), {
      ok: true,
    })
    await waitFor(() => pane.of('queued').at(-1)?.messages.length === 0, 'taken back')
    await waitFor(() => second.of('queued').at(-1)?.messages.length === 0, 'both windows are told')
    const again = await h.mesh.conversationCommand({ key, command: { kind: 'cancelQueued', queuedId } })
    assert.equal(again.ok, false, 'a message no longer held cannot be taken back twice')
    h.provider.push(null)
  } finally {
    await h.close()
  }
})

test('a message scheduled from here is kept there, and goes at its time with this desktop gone', async () => {
  const h = await startHarness({ holdQueued: true })
  const asked: string[] = []
  const stopListening = h.runtime.onEvent((event) => {
    if (event.type === 'user_message' && event.workspaceId === workspaceId && event.agentId === agentId)
      asked.push(String(event.payload?.text ?? ''))
  })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.scheduledSends, true, 'the machine says it keeps scheduled messages')
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')
    await waitFor(() => pane.of('scheduled').length > 0, 'told what the machine keeps, nothing yet')
    assert.deepEqual(pane.of('scheduled').at(-1)?.messages, [])

    const sendAt = h.hostNow() + 400
    const kept = await h.mesh.conversationCommand({
      key,
      command: { kind: 'scheduleSend', message: 'Start the migration.', sendAt },
    })
    assert.deepEqual(kept, { ok: true })
    await waitFor(() => pane.of('scheduled').at(-1)?.messages.length === 1, 'the window sees what is kept there')
    const [message] = pane.of('scheduled').at(-1)!.messages
    assert.equal(message?.text, 'Start the migration.')
    assert.equal(message?.sendAt, sendAt)
    // A second window opened now is told at once, without asking the machine again.
    const second = follower(h.mesh, key, 'pane-2')
    await second.following
    assert.equal(second.of('scheduled').at(-1)?.messages[0]?.text, 'Start the migration.')

    // The laptop closes: the machine sends it at its time all the same.
    h.mesh.shutdown()
    await h.provider.turnStarted()
    assert.deepEqual(asked, ['Start the migration.'], 'sent into the chat over there, once')
    h.provider.push(null)
  } finally {
    stopListening()
    await h.close()
  }
})

test("a message scheduled there is sent now or deleted from here, and a repeat is refused in the machine's words", async () => {
  const h = await startHarness({ holdQueued: true })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    assert.ok((await h.mesh.listConversations(connectionId)).ok)
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')
    const later = h.hostNow() + 60 * 60_000
    for (const message of ['Tomorrow, the docs.', 'Tomorrow, the tests.'])
      assert.deepEqual(
        await h.mesh.conversationCommand({ key, command: { kind: 'scheduleSend', message, sendAt: later } }),
        { ok: true },
      )
    await waitFor(() => pane.of('scheduled').at(-1)?.messages.length === 2, 'both kept')
    const [docs, tests] = pane.of('scheduled').at(-1)!.messages
    assert.deepEqual(
      await h.mesh.conversationCommand({ key, command: { kind: 'cancelScheduled', scheduledId: docs!.id } }),
      { ok: true },
    )
    await waitFor(() => pane.of('scheduled').at(-1)?.messages.length === 1, 'deleted')
    const again = await h.mesh.conversationCommand({ key, command: { kind: 'cancelScheduled', scheduledId: docs!.id } })
    assert.equal(again.ok, false)
    assert.match(!again.ok ? again.message : '', /no longer scheduled/)

    assert.deepEqual(
      await h.mesh.conversationCommand({ key, command: { kind: 'sendScheduledNow', scheduledId: tests!.id } }),
      { ok: true },
    )
    await h.provider.turnStarted()
    await waitFor(() => pane.of('scheduled').at(-1)?.messages[0]?.sending === true, 'on its way, and said so')
    h.provider.push(null)
    await waitFor(() => pane.of('scheduled').at(-1)?.messages.length === 0, 'it went')
  } finally {
    await h.close()
  }
})

test('a machine that keeps no scheduled messages refuses one in words', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    assert.ok((await h.mesh.listConversations(connectionId)).ok)
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')
    // This host keeps none (no `scheduledSends`): its refusal is in words too.
    const refused = await h.mesh.conversationCommand({
      key,
      command: { kind: 'scheduleSend', message: 'Later.', sendAt: h.hostNow() + 60_000 },
    })
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.message : '', /schedule/)
  } finally {
    await h.close()
  }
})

test('the held messages are asked for after each fence, and never of a machine that said it holds none', async () => {
  vi.useFakeTimers()
  try {
    const watches = (sent: Array<Record<string, unknown>>) => sent.filter((frame) => frame.type === 'watchQueued')
    // Not said yet: asked anyway, and an older machine answers under the id.
    const unknown = drivenClient({ capabilities: null })
    await unknown.follow()
    await vi.advanceTimersByTimeAsync(0)
    unknown.fence(1)
    assert.equal(watches(unknown.sent).length, 1)
    unknown.fence(2)
    assert.equal(watches(unknown.sent).length, 2, 'each fence begins the watch afresh')
    unknown.handlers.at(-1)!.onFrame({
      type: 'queued',
      key: { workspaceId, agentId },
      messages: [{ id: 'sm-1', text: 'Held.', createdAt: 1 }],
    })
    assert.deepEqual(unknown.frames.at(-1), {
      type: 'queued',
      messages: [{ id: 'sm-1', text: 'Held.', createdAt: 1 }],
    })
    // Another conversation's list is not this one's.
    unknown.handlers.at(-1)!.onFrame({ type: 'queued', key: { workspaceId, agentId: 'other' }, messages: [] })
    assert.equal(unknown.frames.filter((frame) => frame.type === 'queued').length, 1)
    unknown.client.shutdown()

    const without = drivenClient({ capabilities: ['conversations', 'conversation-models'] })
    await without.follow()
    await vi.advanceTimersByTimeAsync(0)
    without.fence(1)
    assert.equal(watches(without.sent).length, 0)
    without.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a message steered from here into a turn its chat cannot take is held there, and goes when the turn ends', async () => {
  const h = await startHarness({ holdQueued: true })
  const asked: string[] = []
  const stopListening = h.runtime.onEvent((event) => {
    if (event.type === 'user_message' && event.workspaceId === workspaceId && event.agentId === agentId)
      asked.push(String(event.payload?.text ?? ''))
  })
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.steerSends, true, 'the machine says it takes a steer')
    assert.equal(listed.conversations[0]?.capabilities?.steer, false, 'and that this chat’s provider cannot')
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')

    void h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    assert.equal(
      (await h.mesh.conversationSend({ key, message: 'Both.', steer: true, queue: true })).ok,
      false,
      'steered or queued, not both',
    )
    // Answered at once, with the machine's word that it waits for the turn.
    const steered = await h.mesh.conversationSend({ key, message: 'Keep it to one file.', steer: true })
    assert.equal(steered.ok, true, steered.ok ? '' : steered.message)
    assert.match((steered.ok && steered.notice) || '', /queued and goes when this turn ends/)
    await waitFor(() => pane.of('queued').at(-1)?.messages.length === 1, 'the window sees what is held there')

    h.provider.nextTurn()
    h.provider.push(null)
    await h.provider.turnStarted()
    assert.deepEqual(asked, ['stream', 'Keep it to one file.'], 'sent once the turn ended, never lost')
    h.provider.push(null)
  } finally {
    stopListening()
    await h.close()
  }
})
