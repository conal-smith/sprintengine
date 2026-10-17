import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationServerFrame } from '../../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { ConversationThread as IndexedThread } from '../../../shared/conversation-index'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import {
  createConversationGatewayHost,
  type ConversationListWorkspace,
  type ConversationRegistryLink,
} from './tailnet-conversation-host'

// The list a paired phone or desktop reads, as the desktop that owns each
// chat's rest and read state answers it (`conversation-lifecycle`).

function indexed(agentId: string, fields: Partial<IndexedThread> = {}): IndexedThread {
  return {
    agentId,
    title: `First message of ${agentId}`,
    titleSource: 'first-message',
    createdAt: 1,
    updatedAt: 1,
    turnCount: 1,
    model: 'default',
    providerId: 'mock',
    lastSeq: 4,
    firstUserText: 'hello',
    ...fields,
  }
}

function session(workspaceId: string, agentId: string, fields: Partial<ConversationSessionSummary> = {}) {
  return {
    sessionId: `conv-${workspaceId}-${agentId}`,
    workspaceId,
    agentId,
    providerId: 'mock',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  } as ConversationSessionSummary
}

function hostFor(input: {
  threads: Record<string, IndexedThread[]>
  sessions?: ConversationSessionSummary[]
  records: Record<string, ConversationListWorkspace>
  registry?: ConversationRegistryLink
}) {
  const runtime = {
    listSessions: () => ({ ok: true, sessions: input.sessions ?? [] }),
    listThreads: async (key: { workspaceId: string }) => ({ ok: true, threads: input.threads[key.workspaceId] ?? [] }),
    getProviderCapabilities: () => undefined,
  } as unknown as ConversationBackend
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => Object.keys(input.threads).map((workspaceId) => ({ workspaceId, workspaceRoot: '/Users/dev/app' })),
    () => 'bypass',
    // The agent record's name, which old clients keep reading as `title`.
    (key) => `Agent of ${key.workspaceId}`,
    async () => null,
    {},
    input.registry ?? { workspaceOf: (workspaceId) => input.records[workspaceId] ?? null, lifecycleList: true },
  )
}

test('a settled chat is not listed, whether its history or a live session would name it', async () => {
  const host = hostFor({
    threads: { open: [indexed('agent-1')], resting: [indexed('agent-1')] },
    sessions: [session('resting', 'agent-2')],
    records: {
      open: { name: 'Open chat', createdAt: 1 },
      resting: { name: 'Resting chat', createdAt: 1, settledAt: 50 },
    },
  })
  const listed = await host.list()
  assert.deepEqual(
    listed.map((thread) => thread.workspaceId),
    ['open'],
  )
})

test('each chat names its sidebar title and its clocks, and keeps the agent name as `title`', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1', { lastTurnEndedAt: 300 })] },
    records: {
      chat: { name: ' Fix the login ', createdAt: 1, lastUserMessageAt: 200, lastVisitedAt: 250 },
    },
  })
  const [thread] = await host.list()
  assert.equal(thread?.title, 'Agent of chat')
  assert.equal(thread?.chatTitle, 'Fix the login')
  assert.equal(thread?.lastUserMessageAt, 200)
  assert.equal(thread?.lastTurnEndedAt, 300)
  assert.equal(thread?.lastVisitedAt, 250)
})

test('a chat marked unread says when, so a client closed at the time can tell its visit clock went back', async () => {
  const host = hostFor({
    threads: { marked: [indexed('agent-1', { lastTurnEndedAt: 300 })], plain: [indexed('agent-1')] },
    records: {
      marked: { name: 'Marked', createdAt: 1, lastVisitedAt: 299, visitRewoundAt: 5_000 },
      plain: { name: 'Plain', createdAt: 1, lastVisitedAt: 250, visitRewoundAt: null },
    },
  })
  const byWorkspace = new Map((await host.list()).map((thread) => [thread.workspaceId, thread]))
  assert.equal(byWorkspace.get('marked')?.lastVisitedAt, 299)
  assert.equal(byWorkspace.get('marked')?.visitRewoundAt, 5_000)
  assert.equal('visitRewoundAt' in byWorkspace.get('plain')!, false, 'a chat never marked unread says nothing')

  // The client validator keeps a readable one and drops the rest, never the row.
  const listed = JSON.parse(JSON.stringify([byWorkspace.get('marked')])) as Array<Record<string, unknown>>
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [...listed, { ...listed[0], agentId: 'agent-2', visitRewoundAt: 'yesterday' }],
  })
  assert.ok(parsed?.type === 'sessions')
  assert.equal(parsed.sessions[0]?.visitRewoundAt, 5_000)
  assert.equal(parsed.sessions.length, 2)
  assert.equal('visitRewoundAt' in parsed.sessions[1]!, false)
})

test('the turn end is the later of the transcript’s and a session’s, never `updatedAt`', async () => {
  const host = hostFor({
    threads: { a: [indexed('agent-1', { lastTurnEndedAt: 300, updatedAt: 9_000 })], b: [indexed('agent-1')] },
    sessions: [session('a', 'agent-1', { lastTurnEndedAt: 400, status: 'stopped', updatedAt: 9_500 })],
    records: { a: { name: 'A', createdAt: 1 }, b: { name: 'B', createdAt: 1 } },
  })
  const byWorkspace = new Map((await host.list()).map((thread) => [thread.workspaceId, thread]))
  assert.equal(byWorkspace.get('a')?.lastTurnEndedAt, 400)
  // A chat whose agent never finished a turn says nothing about one.
  assert.equal('lastTurnEndedAt' in byWorkspace.get('b')!, false)
})

test('a chat previews its last reply: the newest session’s reading, else the transcript’s', async () => {
  const host = hostFor({
    threads: {
      held: [indexed('agent-1', { lastAssistantText: 'From the transcript' })],
      cold: [indexed('agent-1', { lastAssistantText: 'Done — the tests pass.' })],
      asked: [indexed('agent-1', { lastAssistantText: 'An earlier answer' })],
    },
    sessions: [
      session('held', 'agent-1', { lastAssistantText: 'Older', updatedAt: 5 }),
      session('held', 'agent-1', { sessionId: 'conv-held-2', lastAssistantText: 'Fresh reply', updatedAt: 9 }),
      // The person has written since that reply: nothing to preview until the agent answers.
      session('asked', 'agent-1', { lastAssistantText: '', updatedAt: 9 }),
    ],
    records: {
      held: { name: 'Held', createdAt: 1 },
      cold: { name: 'Cold', createdAt: 1 },
      asked: { name: 'Asked', createdAt: 1 },
    },
  })
  const listed = await host.list()
  const byWorkspace = new Map(listed.map((thread) => [thread.workspaceId, thread]))
  assert.equal(byWorkspace.get('held')?.lastAssistantText, 'Fresh reply')
  assert.equal(byWorkspace.get('cold')?.lastAssistantText, 'Done — the tests pass.')
  assert.equal('lastAssistantText' in byWorkspace.get('asked')!, false)

  // The client keeps a readable preview, cuts a long one, and drops the rest.
  const wire = JSON.parse(JSON.stringify(listed)) as Array<Record<string, unknown>>
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      { ...wire[0], agentId: 'long', lastAssistantText: 'y'.repeat(500) },
      { ...wire[0], agentId: 'blank', lastAssistantText: '   ' },
      { ...wire[0], agentId: 'number', lastAssistantText: 7 },
    ],
  })
  assert.ok(parsed?.type === 'sessions')
  const [long, blank, number] = parsed.sessions
  assert.equal(long?.lastAssistantText?.length, 240)
  assert.equal('lastAssistantText' in blank!, false)
  assert.equal('lastAssistantText' in number!, false)
})

test('a chat with nothing true to say leaves the members out rather than sending empties', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1')], unknown: [indexed('agent-1')] },
    records: { chat: { name: '   ', createdAt: 1 } },
  })
  for (const thread of await host.list()) {
    for (const member of ['chatTitle', 'lastUserMessageAt', 'lastTurnEndedAt', 'lastVisitedAt'])
      assert.equal(member in thread, false, `${thread.workspaceId}.${member}`)
  }
})

test('the list arrives in the sidebar’s order: last message first, the work clock for a chat with none', async () => {
  const host = hostFor({
    threads: {
      // Busiest by `updatedAt`, but last written to longest ago.
      busy: [indexed('agent-1', { updatedAt: 99_000 })],
      recent: [indexed('agent-1', { updatedAt: 10 })],
      // Never written to: ordered by when it was made, or last typed into.
      fresh: [indexed('agent-1', { updatedAt: 5 })],
      older: [indexed('agent-1', { updatedAt: 6 })],
    },
    records: {
      busy: { name: 'Busy', createdAt: 1, lastUserMessageAt: 100 },
      recent: { name: 'Recent', createdAt: 1, lastUserMessageAt: 5_000 },
      fresh: { name: 'Fresh', createdAt: 3_000 },
      older: { name: 'Older', createdAt: 50, lastTerminalActivityAt: 70 },
    },
  })
  assert.deepEqual(
    (await host.list()).map((thread) => thread.workspaceId),
    ['recent', 'fresh', 'busy', 'older'],
  )
})

test('each chat carries the key the sidebar orders it by, and a running turn when it began', async () => {
  const host = hostFor({
    threads: {
      written: [indexed('agent-1', { updatedAt: 99_000 })],
      fresh: [indexed('agent-1', { updatedAt: 5 })],
      typed: [indexed('agent-1', { updatedAt: 6 })],
    },
    sessions: [session('written', 'agent-1', { phase: 'running', turnStartedAt: 7_000, updatedAt: 9_000 })],
    records: {
      written: { name: 'Written', createdAt: 1, lastUserMessageAt: 5_000 },
      fresh: { name: 'Fresh', createdAt: 3_000 },
      typed: { name: 'Typed', createdAt: 50, lastTerminalActivityAt: 70 },
    },
  })
  const listed = JSON.parse(JSON.stringify(await host.list())) as Array<Record<string, unknown>>
  assert.deepEqual(
    listed.map((thread) => [thread.workspaceId, thread.recencyAt]),
    [
      ['written', 5_000],
      ['fresh', 3_000],
      ['typed', 70],
    ],
    'the chat never written to says when it was made, or last typed into, not when it last moved',
  )
  assert.equal(listed[0]?.turnStartedAt, 7_000)
  assert.equal('turnStartedAt' in listed[1]!, false, 'nothing running, no start')
  const parsed = parseConversationServerFrame({ type: 'sessions', requestId: 'list', sessions: listed })
  assert.ok(parsed?.type === 'sessions')
  assert.equal(parsed.sessions[0]?.recencyAt, 5_000, 'the client validator keeps it')
  assert.equal(parsed.sessions[0]?.turnStartedAt, 7_000)
})

test('a failed record read lists the chats as an older desktop would, with nothing left out', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1')] },
    records: {},
    registry: {
      lifecycleList: true,
      workspaceOf: () => {
        throw new Error('registry unavailable')
      },
    },
  })
  const listed = await host.list()
  assert.equal(listed.length, 1)
  assert.equal('chatTitle' in listed[0]!, false)
})

test('the client validator keeps every lifecycle member that is readable and drops the rest, never the row', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1', { lastTurnEndedAt: 300 })] },
    records: { chat: { name: 'Fix the login', createdAt: 1, lastUserMessageAt: 200, lastVisitedAt: 250 } },
  })
  const listed = JSON.parse(JSON.stringify(await host.list())) as Array<Record<string, unknown>>
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      ...listed,
      { ...listed[0], agentId: 'agent-2', chatTitle: '', lastUserMessageAt: 'soon', lastVisitedAt: -1 },
    ],
  })
  assert.ok(parsed?.type === 'sessions')
  assert.equal(parsed.sessions.length, 2)
  const [whole, broken] = parsed.sessions
  assert.equal(whole?.chatTitle, 'Fix the login')
  assert.equal(whole?.lastUserMessageAt, 200)
  assert.equal(whole?.lastTurnEndedAt, 300)
  assert.equal(whole?.lastVisitedAt, 250)
  assert.equal('chatTitle' in broken!, false)
  assert.equal('lastUserMessageAt' in broken!, false)
  assert.equal('lastVisitedAt' in broken!, false)
  assert.equal(broken?.lastTurnEndedAt, 300)
})

/** A runtime that takes a send as the real one does: its `user_message` first, or a busy refusal and nothing. */
function sendingRuntime(answer: 'accept' | 'busy') {
  const sent: unknown[] = []
  const listeners = new Set<(event: ConversationEvent) => void>()
  const runtime = {
    listSessions: () => ({ ok: true, sessions: [session('chat', 'agent-1')] }),
    listThreads: async () => ({ ok: true, threads: [] }),
    getProviderCapabilities: () => undefined,
    onEvent: (listener: (event: ConversationEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendTurn: async (input: { sessionId: string; commandId?: string }) => {
      sent.push(input)
      if (answer === 'busy') return { ok: false, code: 'busy', retryAfterMs: 1_000, message: 'Busy.' }
      const event = (commandId: string | undefined, createdAt: number) =>
        ({
          id: 'e',
          sessionId: input.sessionId,
          workspaceId: 'chat',
          agentId: 'agent-1',
          providerId: 'mock',
          modelId: 'default',
          type: 'user_message',
          createdAt,
          payload: { text: 'carry on', commandId },
        }) as ConversationEvent
      // Another device's message in another chat is not this send's.
      for (const listener of [...listeners]) listener({ ...event('someone-else', 4_000), sessionId: 'other' })
      for (const listener of [...listeners]) listener(event(input.commandId, 5_000))
      return { ok: true }
    },
  } as unknown as ConversationBackend
  return { runtime, sent, listeners }
}

function noteHost(runtime: ConversationBackend, notes: Array<[string, number]>) {
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => [],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { noteUserMessage: (workspaceId, at) => notes.push([workspaceId, at]) },
  )
}

const chatKey = { workspaceRoot: '/Users/dev/app', workspaceId: 'chat', agentId: 'agent-1' }

test('a send from a paired device stamps the desktop’s message clock when the chat takes it', async () => {
  const notes: Array<[string, number]> = []
  const { runtime, sent, listeners } = sendingRuntime('accept')
  const result = await noteHost(runtime, notes).command(chatKey, 'device-1', 'command-1', {
    kind: 'send',
    message: 'carry on',
  })
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.deepEqual(notes, [['chat', 5_000]], 'at the message’s own time, once')
  assert.equal(listeners.size, 0, 'nothing is left listening')
})

test('a send turned away busy stamps nothing, so a phone’s retries neither write nor wake the chat', async () => {
  const notes: Array<[string, number]> = []
  const { runtime, listeners } = sendingRuntime('busy')
  const host = noteHost(runtime, notes)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await host.command(chatKey, 'device-1', 'command-1', { kind: 'send', message: 'carry on' })
    assert.equal(result.code, 'busy')
  }
  assert.deepEqual(notes, [])
  assert.equal(listeners.size, 0)
})

test('a send through a host for Studio’s own messages is recorded as Studio’s and stamps no clock', async () => {
  const sent: Array<{ origin?: unknown }> = []
  const runtime = {
    listSessions: () => ({ ok: true, sessions: [session('chat', 'agent-1')] }),
    listThreads: async () => ({ ok: true, threads: [] }),
    getProviderCapabilities: () => undefined,
    sendTurn: async (input: { origin?: unknown }) => {
      sent.push(input)
      return { ok: true }
    },
  } as unknown as ConversationBackend
  const host = createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => [],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { sendOrigin: { kind: 'studio', reason: 'usage-resume' } },
  )
  const result = await host.command(
    { workspaceRoot: '/Users/dev/app', workspaceId: 'chat', agentId: 'agent-1' },
    'studio-usage-limit-resume',
    'usage-limit-resume:1',
    { kind: 'send', message: 'carry on' },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(sent[0]?.origin, { kind: 'studio', reason: 'usage-resume' })
})
