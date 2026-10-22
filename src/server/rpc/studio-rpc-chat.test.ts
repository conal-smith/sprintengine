import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import {
  STUDIO_CHAT_CAPABILITIES,
  createStudioChunkAssembler,
  parseStudioServerFrame,
  type StudioParsedServerFrame,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type { ConversationSendTurnInput } from '../../shared/conversation-runtime'
import {
  createTicketAuthenticator,
  framePortStream,
  mintStudioTicket,
  studioWindowGrant,
  type StudioFramePort,
} from './studio-frame-port'
import { createStudioRpcRouter } from './studio-rpc-router'
import { createStudioUploads } from './studio-uploads'
import {
  OWNER_TOKEN,
  connectLineClient,
  createFakeBackend,
  hello,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'
import type { StudioChatBackend } from './studio-rpc-types'

// The chat surface and the window's way in: what Studio's own chat view asks
// of the RPC beside the conversation lane, held to owners, answered as its IPC
// answers it, and reached over a port with a one-time ticket.

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

type ChatCalls = {
  sends: ConversationSendTurnInput[]
  reverts: number
  searchSlots: number[]
  released: number[]
  commandListeners: Set<(catalog: ConversationCommandCatalog) => void>
}

function fakeChat(): StudioChatBackend & { calls: ChatCalls } {
  const calls: ChatCalls = { sends: [], reverts: 0, searchSlots: [], released: [], commandListeners: new Set() }
  const session = {
    sessionId: 's1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'mock',
    modelId: 'mock',
    status: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    calls,
    startSession: async () => ({ ok: true, session }),
    sendTurn: async (input) => {
      calls.sends.push(input)
      return { ok: true, session }
    },
    // A send the runtime has carried out holds a receipt under its id.
    hasReceipt: async ({ commandId }) => calls.sends.some((send) => send.commandId === commandId),
    interrupt: async () => ({ ok: true, session }),
    respond: async () => ({ ok: true, session }),
    setPermission: async () => ({ ok: true, session }),
    setModel: async () => ({ ok: true, session }),
    revert: async () => {
      calls.reverts++
      return { ok: true, files: [], reverted: true }
    },
    rewind: async () => ({ ok: true }),
    handoff: async () => ({ ok: true, path: '/Users/dev/handoff.md' }),
    fork: async () => ({ ok: true }),
    attachment: async () => ({ ok: false, message: 'No such picture.' }),
    planDocument: async () => ({ ok: true, path: '/Users/dev/plan.md' }),
    commands: async (input) => ({ cli: input.cli, cwd: input.cwd, commands: [], fetchedAt: 1 }),
    onCommandsChanged: (listener) => {
      calls.commandListeners.add(listener)
      return () => calls.commandListeners.delete(listener)
    },
    providers: async () => ({ ok: true, providers: [] }),
    providerModels: async () => ({ ok: false, message: 'No catalog.' }),
    secretStatus: async () => ({ ok: false, message: 'No secret.' }),
    searchFiles: async (slot) => {
      calls.searchSlots.push(slot)
      return { ok: true, results: [], truncated: false, engine: 'walker', elapsedMs: 0, resultCount: 0 }
    },
    cancelFileSearch: () => undefined,
    releaseFileSearches: (slot) => void calls.released.push(slot),
    stat: async () => ({ isFile: true, isDirectory: false, sizeBytes: 1, modifiedAt: '', modifiedAtMs: 1 }),
    readImage: async () => 'data:image/png;base64,AAAA',
    repoRoot: async () => '/Users/dev/app',
    workspaces: () => [{ id: 'ws-1', name: 'App', folderPath: '/Users/dev/app' }],
  }
}

/** A window's end of a port, reading frames as a client does. */
type PortClient = {
  send(frame: unknown): void
  next(match?: (frame: StudioParsedServerFrame) => boolean): Promise<StudioParsedServerFrame>
  close(): void
  closed: Promise<void>
}

function portPair(): { server: StudioFramePort; client: PortClient } {
  const toClient: Array<(frame: string) => void> = []
  const toServer: Array<(frame: string) => void> = []
  const closeListeners: Array<() => void> = []
  let isClosed = false
  let closedResolve!: () => void
  const closed = new Promise<void>((resolve) => (closedResolve = resolve))
  const end = () => {
    if (isClosed) return
    isClosed = true
    closedResolve()
    for (const listener of closeListeners.splice(0)) queueMicrotask(listener)
  }
  const frames: StudioParsedServerFrame[] = []
  const waiters: Array<() => void> = []
  const assembler = createStudioChunkAssembler()
  const accept = (json: string) => {
    const frame = parseStudioServerFrame(JSON.parse(json))
    if (!frame) throw new Error(`Unreadable frame: ${json.slice(0, 200)}`)
    if (frame.t === 'chunk') {
      const step = assembler.push(frame)
      if (step.kind === 'frame') accept(step.json)
      return
    }
    frames.push(frame)
    for (const wake of waiters.splice(0)) wake()
  }
  toClient.push(accept)
  return {
    server: {
      post: (frame) => {
        if (!isClosed) queueMicrotask(() => toClient.forEach((listener) => listener(frame)))
      },
      onFrame: (listener) => void toServer.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
      close: end,
    },
    client: {
      send: (frame) => {
        if (!isClosed) queueMicrotask(() => toServer.forEach((listener) => listener(JSON.stringify(frame))))
      },
      async next(match = () => true) {
        const deadline = Date.now() + 5_000
        for (;;) {
          const index = frames.findIndex(match)
          if (index !== -1) return frames.splice(index, 1)[0]
          if (Date.now() > deadline) throw new Error(`No matching frame; saw ${JSON.stringify(frames).slice(0, 400)}`)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20)
            waiters.push(() => {
              clearTimeout(timer)
              resolve()
            })
          })
        }
      },
      close: end,
      closed,
    },
  }
}

const isT =
  <T extends StudioParsedServerFrame['t']>(t: T) =>
  (frame: StudioParsedServerFrame) =>
    frame.t === t
const isRes = (id: string) => (frame: StudioParsedServerFrame) => frame.t === 'res' && frame.id === id

async function served(input: { chat?: ReturnType<typeof fakeChat> | null } = {}) {
  const chat = input.chat === undefined ? fakeChat() : input.chat
  const started = await startTestServer(chat ? { chat } : {})
  disposers.push(started.dispose)
  return { ...started, chat }
}

async function windowClient(server: Awaited<ReturnType<typeof served>>['server']): Promise<PortClient> {
  const { server: serverEnd, client } = portPair()
  const ticket = mintStudioTicket()
  server.attach(framePortStream(serverEnd), { authenticator: createTicketAuthenticator(ticket), ownWindow: true })
  client.send(hello({ token: ticket }, { client: { name: 'Studio window' } }))
  const welcome = await client.next(isT('welcome'))
  assert.equal(welcome.t === 'welcome' && welcome.grant.owner, true)
  return client
}

async function socketClient(path: string, token: string): Promise<LineClient> {
  const client = await connectLineClient(path)
  client.send(hello({ token }))
  await client.next(isT('welcome'))
  return client
}

async function ask(client: PortClient | LineClient, id: string, method: string, params: unknown = {}) {
  client.send({ t: 'req', id, method, params })
  const answer = await client.next(isRes(id))
  if (answer.t !== 'res') throw new Error('not a response')
  return answer
}

test('a window says hello once with the ticket main minted for it, and no other credential opens its port', async () => {
  const now = { at: 0 }
  const ticket = mintStudioTicket()
  const auth = createTicketAuthenticator(ticket, { now: () => now.at })
  assert.match(ticket, /^[\x21-\x7e]{16,256}$/)
  assert.equal(auth.authenticate({ token: 'seport_wrongwrongwrongwrong' }, { name: 'w' }).ok, false)
  assert.equal(auth.authenticate({ pairingCode: ticket }, { name: 'w' }).ok, false)
  assert.equal(auth.grantFor('owner'), null)
  const first = auth.authenticate({ token: ticket }, { name: 'w' })
  assert.equal(first.ok && first.grant.owner, true)
  assert.equal(auth.grantFor('owner')?.owner, true)
  assert.equal(auth.authenticate({ token: ticket }, { name: 'w' }).ok, false, 'a ticket is good once')
  const late = createTicketAuthenticator(ticket, { now: () => now.at })
  now.at = 30_001
  assert.equal(late.authenticate({ token: ticket }, { name: 'w' }).ok, false, 'and for thirty seconds')

  const { server } = await served()
  const { server: serverEnd, client } = portPair()
  server.attach(framePortStream(serverEnd), {
    authenticator: createTicketAuthenticator(mintStudioTicket()),
    ownWindow: true,
  })
  client.send(hello({ token: OWNER_TOKEN }))
  const bye = await client.next(isT('bye'))
  assert.equal(bye.t === 'bye' && bye.code, 'unauthorized')
  await client.closed
})

test('the welcome names the chat capabilities only where there is a chat surface', async () => {
  const withChat = await served()
  const owner = await connectLineClient(withChat.path)
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next(isT('welcome'))
  for (const capability of STUDIO_CHAT_CAPABILITIES)
    assert.ok(welcome.t === 'welcome' && welcome.capabilities.includes(capability), capability)
  owner.close()
  const without = await served({ chat: null })
  const other = await connectLineClient(without.path)
  other.send(hello({ token: OWNER_TOKEN }))
  const bare = await other.next(isT('welcome'))
  for (const capability of STUDIO_CHAT_CAPABILITIES)
    assert.ok(bare.t === 'welcome' && !bare.capabilities.includes(capability), capability)
  const refused = await ask(other, 'r1', 'workspaces.list')
  assert.equal(!refused.ok && refused.error.code, 'unavailable')
  other.close()
})

test('the chat surface and a conversation’s folder are an owner’s; a paired app is refused them whatever it holds', async () => {
  const { path, auth, backend } = await served()
  const token = pairFakeClient(auth, 'app', ['conversation:read', 'conversation:operate', 'conversation:create'])
  const app = await socketClient(path, token)
  const send = await ask(app, 's1', 'session.send', { commandId: 'c1', sessionId: 's1', message: 'hi' })
  assert.equal(!send.ok && send.error.code, 'owner_required')
  const folder = { workspaceId: 'ws-1', agentId: 'agent-1', workspaceRoot: '/Users/dev/elsewhere' }
  const earlier = await ask(app, 'e1', 'conversation.loadEarlier', { key: folder, beforeCursor: 3 })
  assert.equal(!earlier.ok && earlier.error.code, 'owner_required')
  app.send({ t: 'sub', id: 'sub-1', topic: 'conversation.session', params: { key: folder } })
  const failed = await app.next(isT('subFailed'))
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
  app.send({ t: 'sub', id: 'sub-2', topic: 'conversation.commands', params: {} })
  const commands = await app.next(isT('subFailed'))
  assert.equal(commands.t === 'subFailed' && commands.code, 'owner_required')
  // An owner's folder is followed as named, not resolved by its workspace.
  const owner = await socketClient(path, OWNER_TOKEN)
  backend.emit('agent-1', 'user_message', { text: 'hello' })
  owner.send({ t: 'sub', id: 'sub-3', topic: 'conversation.session', params: { key: { ...folder } } })
  const snapshot = await owner.next((frame) => frame.t === 'frame' && frame.frame.type === 'snapshot')
  assert.equal(snapshot.t === 'frame' && snapshot.sub, 'sub-3')
  app.close()
  owner.close()
})

test('a window is shown events as its IPC shows them; a client is shown them redacted', async () => {
  const { server, path, backend } = await served()
  const window = await windowClient(server)
  const owner = await socketClient(path, OWNER_TOKEN)
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  for (const [client, id] of [
    [window, 'w'],
    [owner, 'o'],
  ] as const) {
    client.send({ t: 'sub', id, topic: 'conversation.session', params: { key } })
    await client.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  }
  backend.emit('agent-1', 'usage_updated', { inputTokens: 3, cacheReadInputTokens: 5, apiKey: 'sk-live' })
  const shown = async (client: PortClient | LineClient) => {
    const frame = await client.next((candidate) => candidate.t === 'frame' && candidate.frame.type === 'event')
    return frame.t === 'frame' && frame.frame.type === 'event' ? frame.frame.event.payload : null
  }
  assert.deepEqual(await shown(window), { inputTokens: 3, cacheReadInputTokens: 5, apiKey: 'sk-live' })
  const redacted = await shown(owner)
  assert.notEqual(redacted?.apiKey, 'sk-live')
  window.close()
  owner.close()
})

test('a picture arrives in pieces and reaches the runtime whole, spent by the one send that carries it', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  const bytes = Buffer.from(Array.from({ length: 700_000 }, (_, index) => index % 251))
  const begun = await ask(window, 'b1', 'uploads.begin', { mediaType: 'image/png', byteLength: bytes.length })
  assert.ok(begun.ok)
  const { uploadId, chunkBytes } = begun.result as { uploadId: string; chunkBytes: number }
  const first = bytes.subarray(0, chunkBytes).toString('base64')
  assert.equal((await ask(window, 'a1', 'uploads.append', { uploadId, offset: 0, dataBase64: first })).ok, true)
  // The same piece again (a request resent after a dropped connection) is answered, not added twice.
  const again = await ask(window, 'a2', 'uploads.append', { uploadId, offset: 0, dataBase64: first })
  assert.deepEqual(again.ok && again.result, { received: chunkBytes })
  const skipped = await ask(window, 'a3', 'uploads.append', { uploadId, offset: chunkBytes + 1, dataBase64: 'AAAA' })
  assert.equal(!skipped.ok && skipped.error.code, 'invalid_params')
  const early = await ask(window, 's0', 'session.send', {
    commandId: 'c0',
    sessionId: 's1',
    message: 'too soon',
    attachments: [{ id: 'img', uploadId }],
  })
  assert.equal(!early.ok && early.error.code, 'invalid_params', 'an unfinished picture is not sent')
  const rest = bytes.subarray(chunkBytes).toString('base64')
  assert.equal((await ask(window, 'a4', 'uploads.append', { uploadId, offset: chunkBytes, dataBase64: rest })).ok, true)
  const sent = await ask(window, 's1', 'session.send', {
    commandId: 'c1',
    sessionId: 's1',
    message: 'look',
    attachments: [{ id: 'img', uploadId, name: 'shot.png' }],
  })
  assert.ok(sent.ok)
  const carried = chat!.calls.sends[0]
  assert.equal(carried.commandId, 'owner:c1', 'a session command reaches the runtime under its namespaced id')
  assert.deepEqual(
    carried.attachments?.map(({ id, mediaType, name, byteLength }) => ({ id, mediaType, name, byteLength })),
    [{ id: 'img', mediaType: 'image/png', name: 'shot.png', byteLength: bytes.length }],
  )
  assert.equal(carried.attachments?.[0].dataBase64, bytes.toString('base64'))
  // The same send again finds its picture; another send may not take it.
  assert.ok(
    (
      await ask(window, 's2', 'session.send', {
        commandId: 'c1',
        sessionId: 's1',
        message: 'look',
        attachments: [{ id: 'img', uploadId, name: 'shot.png' }],
      })
    ).ok,
  )
  const stolen = await ask(window, 's3', 'session.send', {
    commandId: 'c2',
    sessionId: 's1',
    message: 'mine',
    attachments: [{ id: 'img', uploadId }],
  })
  assert.equal(!stolen.ok && stolen.error.code, 'invalid_params')
  window.close()
})

test('a send resent long after its pictures went is answered from its receipt, never refused for them', async () => {
  let clock = 1_000_000
  const chat = fakeChat()
  const uploads = createStudioUploads({ now: () => clock })
  disposers.push(async () => uploads.close())
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    uploads,
    now: () => clock,
  })
  const grant = studioWindowGrant()
  const context = { connectionId: 'w1', slot: 1, ownWindow: true }
  const call = (method: string, params: unknown) => router.handle(grant, method as never, params, context)
  const begun = await call('uploads.begin', { mediaType: 'image/png', byteLength: 3 })
  assert.ok(begun.ok)
  const { uploadId } = begun.result as { uploadId: string }
  assert.ok((await call('uploads.append', { uploadId, offset: 0, dataBase64: 'AAAA' })).ok)
  const send = { commandId: 'c1', sessionId: 's1', message: 'look', attachments: [{ id: 'img', uploadId }] }
  assert.ok((await call('session.send', send)).ok)
  assert.equal(chat.calls.sends[0].attachments?.length, 1)
  // Its receipt answers for it now, so the bytes are let go of at once.
  assert.equal(uploads.spend(grant.clientId, [uploadId], 'owner:c1').ok, false)
  // An hour later, after a long sleep, the window resends what it never heard answered.
  clock += 60 * 60_000
  const late = await call('session.send', send)
  assert.ok(late.ok, 'answered, not "That upload is not here"')
  assert.equal(chat.calls.sends.length, 2)
  assert.equal(chat.calls.sends[1].commandId, 'owner:c1', 'the runtime answers it from the same receipt')
  assert.equal(chat.calls.sends[1].attachments, undefined)
  router.close()
})

test('a revert, rewind or fork is carried out once per command id, and its answer given to every retry', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  const key = { workspaceId: 'ws-1', agentId: 'agent-1', workspaceRoot: '/Users/dev/app' }
  const params = { commandId: 'rev-1', key, turnSeq: 2, confirmed: true, files: ['a.ts'] }
  const [one, two] = await Promise.all([
    ask(window, 'r1', 'conversation.revert', params),
    ask(window, 'r2', 'conversation.revert', params),
  ])
  assert.deepEqual(one.ok && one.result, two.ok && two.result)
  assert.equal(chat!.calls.reverts, 1)
  await ask(window, 'r3', 'conversation.revert', { ...params, commandId: 'rev-2' })
  assert.equal(chat!.calls.reverts, 2)
  window.close()
})

test('the command list is pushed to an owner as each is reported, and its stream ends with the connection', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  window.send({ t: 'sub', id: 'cmds', topic: 'conversation.commands' })
  for (let tries = 0; chat!.calls.commandListeners.size === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(chat!.calls.commandListeners.size, 1)
  const catalog = {
    cli: 'codex',
    cwd: '/Users/dev/app',
    commands: [{ name: 'review', source: 'cli' as const }],
    fetchedAt: 2,
  }
  for (const listener of chat!.calls.commandListeners) listener(catalog)
  const push = await window.next(isT('push'))
  assert.deepEqual(push.t === 'push' && push.payload, catalog)
  const searched = await ask(window, 'f1', 'files.search', { rootPath: '/Users/dev/app', query: 'a' })
  assert.ok(searched.ok)
  window.close()
  await window.closed
  for (let tries = 0; chat!.calls.released.length === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(chat!.calls.commandListeners.size, 0)
  assert.deepEqual(chat!.calls.released, chat!.calls.searchSlots, 'a closed connection’s searches are ended')
  assert.ok(chat!.calls.searchSlots[0] >= 1_000_000_000, 'its slot is clear of any window’s webContents id')
})

test('a window is answered as its IPC was, never busy: a transcript checks every link it shows at once', async () => {
  const { server } = await served()
  const window = await windowClient(server)
  const answers = await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      ask(window, `stat-${index}`, 'files.stat', { path: `/Users/dev/app/${index}.ts` }),
    ),
  )
  assert.deepEqual(
    answers.filter((answer) => !answer.ok).map((answer) => !answer.ok && answer.error.code),
    [],
  )
  window.close()
})

test('a stream Studio cannot read is told to a client in stable words with an id, and to a window as its IPC says it', async () => {
  const { server, path, backend, logs } = await served()
  backend.follow = (_key, _cursor, listener) => {
    queueMicrotask(() =>
      listener({ type: 'error', message: 'EACCES: /Users/dev/app/.sprintengine/conversations/a.jsonl' }),
    )
    return { dispose: () => undefined, ready: Promise.resolve() }
  }
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const owner = await socketClient(path, OWNER_TOKEN)
  owner.send({ t: 'sub', id: 'o', topic: 'conversation.session', params: { key } })
  const told = await owner.next(isT('subFailed'))
  assert.ok(told.t === 'subFailed')
  assert.equal(told.message, 'Studio could not read this conversation just now.')
  assert.equal(told.retryable, true)
  assert.ok(logs.some((line) => line.includes(`[${told.errorId}]`) && line.includes('EACCES')))
  const window = await windowClient(server)
  window.send({ t: 'sub', id: 'w', topic: 'conversation.session', params: { key } })
  const shown = await window.next(isT('subFailed'))
  assert.equal(shown.t === 'subFailed' && shown.message, 'EACCES: /Users/dev/app/.sprintengine/conversations/a.jsonl')
  owner.close()
  window.close()
})

test('an owner’s web tab is Studio’s own view, and its mutations are audited all the same', async () => {
  const chat = fakeChat()
  const audited: string[] = []
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    audit: (entry) => void audited.push(entry.tool),
  })
  const grant = studioWindowGrant()
  const send = { commandId: 'c1', sessionId: 's1', message: 'hello' }
  await router.handle(grant, 'session.send', send, { connectionId: 'w1', slot: 1, ownWindow: true })
  assert.deepEqual(audited, [], 'a desktop window is the app, and is not audited')
  await router.handle(
    grant,
    'session.send',
    { ...send, commandId: 'c2' },
    {
      connectionId: 'w2',
      slot: 2,
      ownWindow: true,
      audited: true,
    },
  )
  assert.deepEqual(audited, ['session.send'])
  router.close()
})

test('a connection held to known folders searches and asks only about the folders Studio knows', async () => {
  const chat: StudioChatBackend = {
    ...fakeChat(),
    isKnownFolder: async (path) => path === '/Users/dev/app' || path.startsWith('/Users/dev/app/'),
  }
  const uploads = createStudioUploads()
  disposers.push(async () => uploads.close())
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    uploads,
  })
  const grant = studioWindowGrant()
  const tailnet = { connectionId: 'w1', slot: 1, ownWindow: false, knownFoldersOnly: true }
  const loopback = { connectionId: 'w2', slot: 2, ownWindow: false }
  const search = (rootPath: string, context: typeof loopback) =>
    router.handle(grant, 'files.search', { rootPath, query: 'a' }, context)
  const repoRoot = (folderPath: string, context: typeof loopback) =>
    router.handle(grant, 'files.repoRoot', { folderPath }, context)

  assert.ok((await search('/Users/dev/app', tailnet)).ok)
  const elsewhere = await search('/Users/dev', tailnet)
  assert.equal(!elsewhere.ok && elsewhere.error.code, 'not_found')
  assert.ok((await repoRoot('/Users/dev/app/src', tailnet)).ok)
  const other = await repoRoot('/etc', tailnet)
  assert.equal(!other.ok && other.error.code, 'not_found')
  // A browser on this machine names any folder, as before.
  assert.ok((await search('/Users/dev', loopback)).ok)
  assert.ok((await repoRoot('/etc', loopback)).ok)
})
