import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { StudioParsedServerFrame } from '../../../packages/studio-protocol/src/public'
import {
  OWNER_TOKEN,
  connectLineClient,
  hello,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function serve(input: Parameters<typeof startTestServer>[0] = {}) {
  const started = await startTestServer(input)
  cleanups.push(() => started.dispose())
  return started
}
async function client(path: string): Promise<LineClient> {
  const opened = await connectLineClient(path)
  cleanups.push(() => opened.close())
  return opened
}
const isT =
  <T extends StudioParsedServerFrame['t']>(t: T) =>
  (frame: StudioParsedServerFrame): frame is Extract<StudioParsedServerFrame, { t: T }> =>
    frame.t === t
const response = (id: string) => (frame: StudioParsedServerFrame) => frame.t === 'res' && frame.id === id
async function request(c: LineClient, id: string, method: string, params?: unknown) {
  c.send({ t: 'req', id, method, ...(params === undefined ? {} : { params }) })
  return (await c.next(response(id))) as Extract<StudioParsedServerFrame, { t: 'res' }>
}
async function open(path: string, token: string): Promise<LineClient> {
  const c = await client(path)
  c.send(hello({ token }))
  await c.next(isT('welcome'))
  return c
}

test('a hello is welcomed with the grant, the Studio capabilities and the conversation hello answer', async () => {
  const { path, auth } = await serve()
  const token = pairFakeClient(auth, 'reader', ['conversation:read'])
  const c = await client(path)
  c.send(hello({ token }, { protocolVersion: 2, minProtocolVersion: 1 }))
  const welcome = await c.next(isT('welcome'))
  assert.equal(welcome.t === 'welcome' && welcome.protocolVersion, 1)
  assert.deepEqual(welcome.t === 'welcome' && welcome.grant, {
    clientId: 'reader',
    name: 'reader',
    owner: false,
    scopes: ['conversation:read'],
    ceiling: 'auto',
  })
  assert.ok(welcome.t === 'welcome' && welcome.capabilities.includes('conversation-create'))
  // The conversation lane's own answer, without the capabilities that
  // describe the tailnet's transport.
  assert.ok(welcome.t === 'welcome' && welcome.conversation.capabilities.includes('conversation-plans'))
  assert.ok(welcome.t === 'welcome' && !welcome.conversation.capabilities.includes('conversation-images'))
  assert.ok(welcome.t === 'welcome' && !welcome.conversation.capabilities.includes('conversation-message-images'))
  assert.ok(welcome.t === 'welcome' && !welcome.conversation.capabilities.includes('conversation-message-files'))
  assert.ok(welcome.t === 'welcome' && !welcome.conversation.capabilities.includes('conversation-image-downscale'))
  const info = await request(c, 'i1', 'server.info')
  assert.equal(info.ok && (info.result as { grant: { clientId: string } }).grant.clientId, 'reader')
})

test('the welcome says where this Studio runs: local unless its server was started in WSL or over SSH', async () => {
  for (const hostKind of [undefined, 'wsl', 'ssh'] as const) {
    const { path } = await serve(hostKind ? { hostKind } : {})
    const c = await client(path)
    c.send(hello({ token: OWNER_TOKEN }))
    const welcome = await c.next(isT('welcome'))
    assert.equal(welcome.t === 'welcome' && welcome.environment.hostKind, hostKind ?? 'local')
  }
})

test('a client outside the version window is refused with both numbers named', async () => {
  const { path, auth } = await serve()
  const token = pairFakeClient(auth, 'future', ['conversation:read'])
  const c = await client(path)
  c.send(hello({ token }, { protocolVersion: 5, minProtocolVersion: 4 }))
  const bye = await c.next(isT('bye'))
  assert.equal(bye.t === 'bye' && bye.code, 'unsupported_protocol_version')
  assert.match(bye.t === 'bye' ? bye.message : '', /4 or newer.*speaks 1/)
  await c.closed
})

test('no credential, a wrong one, or a late or missing hello never reaches a request', async () => {
  const { path, audit, backend } = await serve({ helloTimeoutMs: 150 })
  // Every attempt carries mutations, sent at once behind its hello (or with
  // none), so a request that slipped through would show in the backend.
  const mutations = [
    { t: 'req', id: 'm1', method: 'conversation.send', params: { key, commandId: 'c1', message: 'hi' } },
    { t: 'req', id: 'm2', method: 'conversation.create', params: { workspaceId: 'ws-1', commandId: 'c2' } },
    { t: 'req', id: 'm3', method: 'conversation.stop', params: { key, commandId: 'c3' } },
  ]
  const wrong = await client(path)
  wrong.send(hello({ token: 'sest_not_a_real_token_000' }))
  for (const frame of mutations) wrong.send(frame)
  const refused = await wrong.next(isT('bye'))
  assert.equal(refused.t === 'bye' && refused.code, 'unauthorized')
  await wrong.closed
  assert.deepEqual(
    audit.map((entry) => [entry.tool, entry.ok, entry.clientName]),
    [['studio.auth_refused', false, 'test-app']],
  )

  const skipped = await client(path)
  for (const frame of mutations) skipped.send(frame)
  const notHello = (await skipped.next(isT('bye'))) as { code: string; retryAfterMs?: number }
  assert.equal(notHello.code, 'hello_required')
  assert.equal(notHello.retryAfterMs, undefined, 'a client that says something else is not asked back')
  await skipped.closed

  const silent = await client(path)
  const late = (await silent.next(isT('bye'))) as { code: string; retryAfterMs?: number }
  assert.equal(late.code, 'hello_required')
  assert.ok((late.retryAfterMs ?? 0) > 0, 'a hello that is only late may be tried again')
  await silent.closed
  // A hello after the deadline, with mutations behind it, reaches nothing either.
  for (const frame of [hello({ token: OWNER_TOKEN }), ...mutations]) silent.send(frame)

  assert.equal(
    wrong.frames.some((frame) => frame.t === 'res'),
    false,
  )
  assert.equal(
    skipped.frames.some((frame) => frame.t === 'res'),
    false,
  )
  assert.deepEqual(backend.commands, [])
  assert.deepEqual(backend.creates, [])
  assert.deepEqual(backend.stops, [])
})

test('a pairing code is exchanged once for a token, and the token is what works afterwards', async () => {
  const { path, auth, audit } = await serve()
  auth.pairingCodes.set('sepair_0123456789abcdef', {
    clientId: 'bot',
    name: 'release-bot',
    owner: false,
    scopes: ['conversation:read'],
    ceiling: 'manual',
  })
  const first = await client(path)
  first.send(hello({ pairingCode: 'sepair_0123456789abcdef' }))
  const welcome = await first.next(isT('welcome'))
  const token = welcome.t === 'welcome' ? welcome.pairing?.token : undefined
  assert.ok(token)
  assert.equal(audit.at(-1)?.tool, 'studio.paired')
  const again = await client(path)
  again.send(hello({ pairingCode: 'sepair_0123456789abcdef' }))
  assert.equal(((await again.next(isT('bye'))) as { code: string }).code, 'unauthorized')
  const later = await client(path)
  later.send(hello({ token: token! }))
  const welcomed = await later.next(isT('welcome'))
  assert.equal(welcomed.t === 'welcome' && welcomed.pairing, undefined)
})

test('each method and stream is held to its scope, and a refused mutation is audited', async () => {
  const { path, auth, backend, audit } = await serve()
  const reader = await open(path, pairFakeClient(auth, 'reader', ['conversation:read']))
  const sent = await request(reader, 's1', 'conversation.send', { key, commandId: 'c1', message: 'hi' })
  assert.equal(!sent.ok && sent.error.code, 'scope_required')
  const created = await request(reader, 'c1', 'conversation.create', { workspaceId: 'ws-1', commandId: 'c1' })
  assert.equal(!created.ok && created.error.code, 'scope_required')
  assert.equal((await request(reader, 'l1', 'conversation.list')).ok, true)
  assert.equal(backend.commands.length + backend.creates.length, 0)
  assert.deepEqual(
    audit.map((entry) => [entry.tool, entry.ok, entry.code, entry.commandId]),
    [
      ['conversation.send', false, 'scope_required', 'c1'],
      ['conversation.create', false, 'scope_required', 'c1'],
    ],
  )

  const creator = await open(path, pairFakeClient(auth, 'creator', ['conversation:create']))
  creator.send({ t: 'sub', id: 'sub-1', topic: 'conversation.session', params: { key } })
  const failed = await creator.next(isT('subFailed'))
  assert.deepEqual(failed.t === 'subFailed' && [failed.code, failed.retryable], ['scope_required', false])
  const unknown = await request(creator, 'u1', 'conversation.compact', { key })
  assert.equal(!unknown.ok && unknown.error.code, 'unknown_method')
  // The chat surface is Studio's own, whatever a pairing holds.
  const owned = await request(creator, 'o1', 'conversation.revert', { key, commandId: 'r1', turnSeq: 1 })
  assert.equal(!owned.ok && owned.error.code, 'owner_required')
})

test('the ceiling lowers presets, pins a missing one, guards allowed tools and looser chats', async () => {
  const { path, auth, backend } = await serve()
  const app = await open(path, pairFakeClient(auth, 'app', ['conversation:operate', 'conversation:create'], 'auto'))
  const loose = await request(app, 'c1', 'conversation.create', {
    workspaceId: 'ws-1',
    commandId: 'create-1',
    permissionPreset: 'bypass',
    permissionMode: 'bypassPermissions',
  })
  assert.equal(
    loose.ok && (loose.result as { conversation: { permissionPreset: string } }).conversation.permissionPreset,
    'auto',
  )
  // The mode belonged to the preset asked for, and goes with it.
  assert.deepEqual(backend.creates[0].request, { workspaceId: 'ws-1', permissionPreset: 'auto' })
  await request(app, 'c2', 'conversation.create', { workspaceId: 'ws-1', commandId: 'create-2' })
  assert.equal(backend.creates[1].request.permissionPreset, 'auto')
  const tools = await request(app, 'c3', 'conversation.create', {
    workspaceId: 'ws-1',
    commandId: 'create-3',
    allowedTools: ['Bash'],
  })
  assert.equal(!tools.ok && tools.error.code, 'ceiling_exceeded')

  const switched = await request(app, 'p1', 'conversation.setPermissionPreset', {
    key,
    commandId: 'preset-1',
    preset: 'bypass',
  })
  assert.deepEqual(switched.ok && switched.result, { permissionPreset: 'auto' })
  assert.deepEqual(backend.commands.at(-1)?.command, { kind: 'setPermissionPreset', preset: 'auto' })

  // The person put the chat on bypass themselves: the app may hold it back,
  // never drive it.
  backend.presets.set('agent-1', 'bypass')
  const send = await request(app, 's1', 'conversation.send', { key, commandId: 'send-1', message: 'go' })
  assert.equal(!send.ok && send.error.code, 'ceiling_exceeded')
  const approve = await request(app, 'a1', 'conversation.resolveApproval', {
    key,
    commandId: 'approve-1',
    requestId: 'req-1',
    decision: 'once',
  })
  assert.equal(!approve.ok && approve.error.code, 'ceiling_exceeded')
  for (const [id, method, params] of [
    ['i1', 'conversation.interrupt', {}],
    ['d1', 'conversation.resolveApproval', { requestId: 'req-1', decision: 'deny' }],
    ['r1', 'conversation.resolvePlan', { requestId: 'plan-1', decision: 'reject' }],
    ['x1', 'conversation.stop', {}],
  ] as const) {
    const held = await request(app, id, method, { key, commandId: `cmd-${id}`, ...params })
    assert.equal(held.ok, true, method)
  }

  // Allowing a kind of request for the rest of a chat is an allow rule: an app
  // below `auto` answers once at a time.
  backend.presets.set('agent-1', 'manual')
  const strict = await open(path, pairFakeClient(auth, 'strict', ['conversation:operate'], 'manual'))
  const rule = await request(strict, 'c1', 'conversation.resolveApproval', {
    key,
    commandId: 'rule-1',
    requestId: 'req-2',
    decision: 'conversation',
  })
  assert.equal(!rule.ok && rule.error.code, 'ceiling_exceeded')
  const once = await request(strict, 'c2', 'conversation.resolveApproval', {
    key,
    commandId: 'once-1',
    requestId: 'req-2',
    decision: 'once',
  })
  assert.equal(once.ok, true)

  // The owner has no ceiling.
  const owner = await open(path, OWNER_TOKEN)
  const ownerSend = await request(owner, 's2', 'conversation.send', { key, commandId: 'send-1', message: 'go' })
  assert.equal(ownerSend.ok, true)
})

test('command ids are namespaced per client, and a retried id is carried out once', async () => {
  const { path, auth, backend } = await serve()
  const one = await open(path, pairFakeClient(auth, 'one', ['conversation:operate']))
  const two = await open(path, pairFakeClient(auth, 'two', ['conversation:operate']))
  await request(one, 'a', 'conversation.interrupt', { key, commandId: 'same' })
  await request(one, 'b', 'conversation.interrupt', { key, commandId: 'same' })
  await request(two, 'c', 'conversation.interrupt', { key, commandId: 'same' })
  const owner = await open(path, OWNER_TOKEN)
  await request(owner, 'd', 'conversation.interrupt', { key, commandId: 'same' })
  assert.deepEqual(
    backend.commands.map((entry) => entry.commandId),
    ['client:one:same', 'client:two:same', 'owner:same'],
  )
  // A stop is a command like the rest: carried out once under its id.
  await request(one, 'e', 'conversation.stop', { key, commandId: 'halt' })
  await request(one, 'f', 'conversation.stop', { key, commandId: 'halt' })
  assert.deepEqual(backend.stops, ['client:one:halt'])
})

test('a create retried while the first is starting, and after, makes one chat', async () => {
  const { path, auth, backend } = await serve()
  const app = await open(path, pairFakeClient(auth, 'app', ['conversation:create']))
  app.send({ t: 'req', id: 'r1', method: 'conversation.create', params: { workspaceId: 'ws-1', commandId: 'make' } })
  app.send({ t: 'req', id: 'r2', method: 'conversation.create', params: { workspaceId: 'ws-1', commandId: 'make' } })
  const [first, second] = [await app.next(response('r1')), await app.next(response('r2'))]
  const agentOf = (frame: StudioParsedServerFrame) =>
    frame.t === 'res' && frame.ok ? (frame.result as { conversation: { agentId: string } }).conversation.agentId : null
  assert.equal(agentOf(first), 'created-1')
  assert.equal(agentOf(second), 'created-1')
  const third = await request(app, 'r3', 'conversation.create', { workspaceId: 'ws-1', commandId: 'make' })
  assert.equal(agentOf(third), 'created-1')
  assert.equal(backend.creates.length, 1)
  assert.equal(backend.creates[0].launchCommandId, 'client:app:make')
  const failed = await request(app, 'r4', 'conversation.create', { workspaceId: 'ws-9', commandId: 'nowhere' })
  assert.equal(!failed.ok && failed.error.code, 'unknown_workspace')
})

test('a stream resumes from its cursor with no gap and no repeat, across a reconnect', async () => {
  const { path, auth, backend } = await serve()
  const token = pairFakeClient(auth, 'follower', ['conversation:read'])
  for (const text of ['a', 'b']) backend.emit('agent-1', 'content_delta', { text })
  const first = await open(path, token)
  first.send({ t: 'sub', id: 'chat', topic: 'conversation.session', params: { key } })
  const snapshot = await first.next((frame) => frame.t === 'frame' && frame.frame.type === 'snapshot')
  assert.equal(snapshot.t === 'frame' && snapshot.frame.type === 'snapshot' && snapshot.frame.page.events.length, 2)
  const fence = await first.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  const cursor = fence.t === 'frame' && fence.frame.type === 'synchronized' ? fence.frame : null
  assert.deepEqual(cursor && [cursor.seq, cursor.generation, cursor.key], [2, 'log-1', key])
  backend.emit('agent-1', 'turn_started', { apiKey: 'sk-secret' })
  const live = await first.next((frame) => frame.t === 'frame' && frame.frame.type === 'event')
  assert.equal(live.t === 'frame' && live.frame.type === 'event' && live.frame.event.seq, 3)
  // Redacted the way a chat view is shown it.
  assert.equal(live.t === 'frame' && live.frame.type === 'event' && live.frame.event.payload?.apiKey, '[redacted]')
  first.close()
  await first.closed

  // Missed while away.
  backend.emit('agent-1', 'content_delta', { text: 'c' })
  backend.emit('agent-1', 'turn_completed')
  const second = await open(path, token)
  second.send({
    t: 'sub',
    id: 'chat',
    topic: 'conversation.session',
    params: { key },
    cursor: { afterSeq: 3, generation: 'log-1' },
  })
  // Everything after the cursor arrives exactly once and in order: 4 and 5
  // before the fence, with no snapshot, then 6 live.
  const received: Array<number | 'fence'> = []
  while (received.at(-1) !== 6) {
    const frame = await second.next((candidate) => candidate.t === 'frame' && candidate.sub === 'chat')
    if (frame.t !== 'frame') continue
    if (frame.frame.type === 'snapshot') assert.fail('a cursor the log vouches for gets no snapshot')
    if (frame.frame.type === 'event') received.push(frame.frame.event.seq!)
    if (frame.frame.type === 'synchronized') {
      received.push('fence')
      backend.emit('agent-1', 'turn_started')
    }
  }
  assert.deepEqual(received, [4, 5, 'fence', 6])

  // A cursor from another generation is answered with a reset snapshot.
  second.send({
    t: 'sub',
    id: 'stale',
    topic: 'conversation.session',
    params: { key },
    cursor: { afterSeq: 3, generation: 'log-0' },
  })
  const reset = await second.next(
    (frame) => frame.t === 'frame' && frame.sub === 'stale' && frame.frame.type === 'snapshot',
  )
  assert.equal(reset.t === 'frame' && reset.frame.type === 'snapshot' && reset.frame.reset, true)
})

test('revoking a client mid-stream closes it at once, and its token stops working', async () => {
  const { path, auth, backend } = await serve()
  const token = pairFakeClient(auth, 'doomed', ['conversation:read'])
  const c = await open(path, token)
  c.send({ t: 'sub', id: 'chat', topic: 'conversation.session', params: { key } })
  await c.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  assert.equal(backend.followers('agent-1'), 1)
  auth.revoke('doomed')
  const bye = await c.next(isT('bye'))
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  await c.closed
  assert.equal(backend.followers('agent-1'), 0)
  const again = await client(path)
  again.send(hello({ token }))
  assert.equal(((await again.next(isT('bye'))) as { code: string }).code, 'unauthorized')
})

test('a client that only listens is held to a revoke by its next outbound frame', async () => {
  const { path, auth, backend } = await serve()
  const c = await open(path, pairFakeClient(auth, 'listener', ['conversation:read']))
  c.send({ t: 'sub', id: 'chat', topic: 'conversation.session', params: { key } })
  await c.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  // Revoked without the revoke listener reaching this connection.
  auth.grants.delete('listener')
  backend.emit('agent-1', 'turn_started')
  const bye = await c.next(isT('bye'))
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  assert.equal(
    c.frames.some((frame) => frame.t === 'frame' && frame.frame.type === 'event'),
    false,
  )
  await c.closed
})

test('a grant that loses read ends its streams but keeps the connection', async () => {
  const { path, auth } = await serve()
  const c = await open(path, pairFakeClient(auth, 'narrowed', ['conversation:read', 'conversation:create']))
  c.send({ t: 'sub', id: 'chat', topic: 'conversation.session', params: { key } })
  await c.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  auth.change('narrowed', { scopes: ['conversation:create'] })
  const ended = await c.next(isT('subFailed'))
  assert.deepEqual(ended.t === 'subFailed' && [ended.sub, ended.code, ended.retryable], [
    'chat',
    'scope_required',
    false,
  ])
  const info = await request(c, 'i1', 'server.info')
  assert.equal(info.ok, true)
})

test('a reader that stops reading is told to resync with a delay, then closed', async () => {
  const { path, auth, backend } = await serve()
  const c = await open(path, pairFakeClient(auth, 'slow', ['conversation:read']))
  c.send({ t: 'sub', id: 'chat', topic: 'conversation.session', params: { key } })
  await c.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  c.socket.pause()
  // Distinct tool outputs do not merge, so the backlog grows past the bound.
  for (let index = 0; index < 64; index++)
    backend.emit('agent-1', 'tool_output', { toolUseId: `t${index}`, output: 'x'.repeat(200_000), isError: false })
  c.socket.resume()
  const bye = await c.next(isT('bye'), 10_000)
  assert.deepEqual(bye.t === 'bye' && [bye.code, bye.retryAfterMs], ['resync_required', 1_500])
  await c.closed
})

test('consecutive deltas behind a slow reader arrive merged, under the last sequence', async () => {
  const { path, auth, backend } = await serve()
  const c = await open(path, pairFakeClient(auth, 'merging', ['conversation:read']))
  c.send({ t: 'sub', id: 'chat', topic: 'conversation.session', params: { key } })
  await c.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  // A first frame large enough to hold the writer while the deltas queue.
  backend.emit('agent-1', 'tool_output', { toolUseId: 'big', output: 'y'.repeat(2_000_000), isError: false })
  for (const text of ['one ', 'two ', 'three']) backend.emit('agent-1', 'content_delta', { text, turnId: 't1' })
  const deltas: Array<{ seq: number; text: string }> = []
  while (deltas.map((delta) => delta.text).join('') !== 'one two three') {
    const frame = await c.next((candidate) => candidate.t === 'frame' && candidate.frame.type === 'event')
    if (frame.t === 'frame' && frame.frame.type === 'event' && frame.frame.event.type === 'content_delta')
      deltas.push({ seq: frame.frame.event.seq!, text: String(frame.frame.event.payload?.text) })
  }
  assert.equal(deltas.at(-1)?.seq, 4)
  assert.ok(deltas.length < 3, `merged into fewer frames, got ${deltas.length}`)
})

test('an answer over the frame cap arrives chunked and whole', async () => {
  const { path, auth } = await serve()
  const c = await open(path, pairFakeClient(auth, 'reader', ['conversation:read']))
  const detail = await request(c, 'd1', 'conversation.toolDetail', { key, toolUseId: 'big' })
  assert.equal(detail.ok && (detail.result as { detail: { output: string } }).detail.output.length, 300_000)
  // Redacted as the tailnet lane redacts it.
  assert.deepEqual(detail.ok && (detail.result as { detail: { input: unknown } }).detail.input, {
    authorization: '[redacted]',
  })
  const missing = await request(c, 'd2', 'conversation.toolDetail', { key, toolUseId: 'nope' })
  assert.equal(!missing.ok && missing.error.code, 'not_found')
  const elsewhere = await request(c, 'd3', 'conversation.loadEarlier', {
    key: { workspaceId: 'ws-9', agentId: 'agent-1' },
    beforeCursor: 3,
  })
  assert.equal(!elsewhere.ok && elsewhere.error.code, 'not_found')
})

test('a refusal from below is answered in stable words, never the runtime’s own, with an id the log keeps them under', async () => {
  const { path, auth, logs } = await serve()
  const c = await open(path, pairFakeClient(auth, 'app', ['conversation:operate', 'conversation:create']))
  const sent = await request(c, 's1', 'conversation.send', { key, commandId: 'boom', message: 'explode' })
  const { errorId, ...said } = (!sent.ok && sent.error) || { errorId: undefined }
  assert.deepEqual(said, { code: 'unavailable', message: 'Studio could not carry that out.' })
  assert.match(errorId ?? '', /^[0-9a-f]{12}$/)
  // The log has the real cause, under the id the client was given.
  assert.ok(logs.some((line) => line.includes(`[${errorId}]`) && line.includes('ENOENT')))
  const created = await request(c, 'c1', 'conversation.create', { workspaceId: 'ws-9', commandId: 'nowhere' })
  assert.equal(!created.ok && created.error.code, 'unknown_workspace')
  assert.equal(!created.ok && created.error.message, 'There is no workspace with that id here.')
  const otherId = !created.ok && created.error.errorId
  assert.ok(otherId && otherId !== errorId, 'each refusal has an id of its own')
})

test('a send turned away behind another is answered busy with its delay, so the client retries it', async () => {
  const { path, auth } = await serve()
  const c = await open(path, pairFakeClient(auth, 'app', ['conversation:operate']))
  const sent = await request(c, 's1', 'conversation.send', { key, commandId: 'later', message: 'behind another' })
  assert.equal(!sent.ok && sent.error.code, 'busy')
  assert.equal(!sent.ok && sent.error.retryAfterMs, 400)
})

test('a command id reused for a different command is refused; the same command again is answered from its receipt', async () => {
  const { path, auth, backend } = await serve()
  const c = await open(path, pairFakeClient(auth, 'app', ['conversation:operate']))
  const first = await request(c, 'a', 'conversation.send', { key, commandId: 'same', message: 'hello' })
  assert.equal(first.ok, true)
  const again = await request(c, 'b', 'conversation.send', { key, commandId: 'same', message: 'hello' })
  assert.equal(again.ok, true)
  const other = await request(c, 'c', 'conversation.send', { key, commandId: 'same', message: 'something else' })
  assert.equal(!other.ok && other.error.code, 'command_id_conflict')
  const method = await request(c, 'd', 'conversation.interrupt', { key, commandId: 'same' })
  assert.equal(!method.ok && method.error.code, 'command_id_conflict', 'another method under the id is another command')
  assert.equal(backend.commands.length, 1)
  // A fingerprint rides with the command to the runtime's receipts.
  assert.match(backend.fingerprints[0] ?? '', /^[A-Za-z0-9_-]{32}$/)
})

test('a line over the client cap is refused under its id, and the connection stays open', async () => {
  const { path, auth } = await serve()
  const c = await open(path, pairFakeClient(auth, 'big-sender', ['conversation:operate']))
  c.send(`{"t":"req","id":"huge","method":"conversation.send","params":{"message":"${'z'.repeat(1_400_000)}"}}`)
  const refused = await c.next(response('huge'))
  assert.equal(refused.t === 'res' && !refused.ok && refused.error.code, 'too_large')
  assert.equal((await request(c, 'after', 'server.info')).ok, true)
})
