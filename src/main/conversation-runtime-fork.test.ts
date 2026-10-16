import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import { workspaceStorePath } from './workspace-store'
import type {
  ConversationMessage,
  ConversationProviderAdapter,
  ConversationProviderForkResult,
  MockAdapterForkInput,
  MockAdapterSessionInput,
} from './providers/conversation-provider-adapter'
import type { ConversationCapabilities, ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CAPABILITIES: ConversationCapabilities = {
  tools: false,
  approvals: false,
  questions: false,
  planMode: false,
  images: false,
  skills: 'none',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: false,
  cost: false,
  contextMeter: false,
  liveModelSwitch: false,
  rewind: true,
  fork: true,
}

type Start = {
  resumeSessionId?: string
  resumeSessionAt?: string
  seedFromHistory?: boolean
  fallbackHistory?: ConversationMessage[]
}
type Calls = {
  starts: Start[]
  forks: Array<Pick<MockAdapterForkInput, 'cursor' | 'exact' | 'latest' | 'resumeSessionId'>>
  messages: ConversationMessage[][]
}
// How the provider answers a fork: branch the parent's session at the point
// it recorded (refusing where it has none), or start the fork afresh.
type ForkMode = 'branch' | 'seed'

function event(input: MockAdapterSessionInput, type: ConversationEventType, payload?: object): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload: payload as ConversationEvent['payload'],
  }
}

function forkingProvider(
  record: Calls,
  options: { fork?: ForkMode; stateless?: boolean; capable?: boolean; gate?: Promise<void>; providerId?: string } = {},
) {
  let entries = 0
  const adapter: ConversationProviderAdapter = {
    id: options.providerId ?? 'forking',
    ...(options.stateless ? {} : { sessions: 'stateful' as const }),
    capabilities: { ...CAPABILITIES, fork: options.capable !== false },
    listModels: () => ['model'],
    startSession: (input) => {
      record.starts.push({
        resumeSessionId: input.resumeSessionId,
        resumeSessionAt: input.resumeSessionAt,
        seedFromHistory: input.seedFromHistory,
        fallbackHistory: input.fallbackHistory,
      })
      return [event(input, 'session_started')]
    },
    async *sendTurn(input) {
      record.messages.push(input.messages ?? [])
      yield event(input, 'turn_started', { turnId: input.turnId })
      // A send that never reaches the provider, as a signed-out CLI's.
      if (input.message === 'unreached') {
        yield event(input, 'turn_failed', { turnId: input.turnId, reason: 'provider', message: 'Not signed in.' })
        return
      }
      if (input.seedFromHistory) yield event(input, 'session_updated', { historySeeded: true })
      await options.gate
      yield event(input, 'content_delta', { turnId: input.turnId, text: `reply to ${input.message}` })
      yield event(input, 'turn_completed', {
        turnId: input.turnId,
        providerCursor: { sessionId: 'provider-1', at: `entry-${++entries}` },
        checkpointTurnSeq: 1,
        checkpointAvailable: true,
        costUsd: 0.5,
      })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
    rewind: async () => ({ ok: true }),
  }
  if (!options.stateless)
    adapter.fork = async (input): Promise<ConversationProviderForkResult> => {
      record.forks.push({
        cursor: input.cursor,
        exact: input.exact,
        latest: input.latest,
        resumeSessionId: input.resumeSessionId,
      })
      if (options.fork === 'seed') return { ok: true, cursor: null }
      if (input.exact && (input.cursor?.at || !input.cursor)) return { ok: true, cursor: input.cursor }
      return { ok: false, message: 'No record of where the provider stood there.' }
    }
  return adapter
}

async function setup(options: Parameters<typeof forkingProvider>[1] & { transcript?: object[] } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-fork-'))
  roots.add(workspaceRoot)
  const record: Calls = { starts: [], forks: [], messages: [] }
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const forkKey = { ...key, agentId: 'fork' }
  if (options.transcript) {
    const path = workspaceStorePath(workspaceRoot, 'conversations', 'workspace', 'agent.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, options.transcript.map((line) => `${JSON.stringify(line)}\n`).join(''))
  }
  const open = () => {
    const runtime = new ConversationRuntime({
      adapters: [forkingProvider(record, options)],
      getProviderById: () => undefined,
      secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    })
    runtimes.add(runtime)
    return runtime
  }
  const chat = { runtime: open(), sessionId: '' }
  const start = async (target = key) => {
    const started = await chat.runtime.startSession({ ...target, providerId: 'forking', modelId: 'model' })
    assert.ok(started.ok, started.ok ? '' : started.message)
    return started.session.sessionId
  }
  const send = async (message: string, sessionId = chat.sessionId) => {
    const sent = await chat.runtime.sendTurn({ sessionId, message })
    assert.ok(sent.ok, sent.ok ? '' : sent.message)
  }
  const events = async (target = key) => {
    const transcript = await chat.runtime.readTranscript(target)
    assert.ok(transcript.ok)
    return transcript.events
  }
  const userMessage = async (text: string) => {
    const found = (await events()).findLast((entry) => entry.type === 'user_message' && entry.payload?.text === text)
    assert.ok(found, `no message "${text}"`)
    return { seq: found.seq!, turnId: String(found.payload?.turnId) }
  }
  const texts = async (target = forkKey) =>
    (await events(target)).filter((entry) => entry.type === 'user_message').map((entry) => entry.payload?.text)
  const restart = async () => {
    await chat.runtime.shutdown()
    chat.runtime = open()
  }
  return { chat, key, forkKey, record, start, send, events, userMessage, texts, restart }
}

test('a fork at a reply holds that turn and its first start branches the session at the turn’s end', async () => {
  const t = await setup()
  t.chat.sessionId = await t.start()
  await t.send('one')
  await t.send('two')
  await t.send('three')
  const two = await t.userMessage('two')
  const forked = await t.chat.runtime.forkAtTurn({
    key: t.key,
    newAgentId: 'fork',
    side: 'assistant',
    turnId: two.turnId,
    title: 'Atlas (fork)',
  })
  assert.deepEqual(forked, { ok: true })
  assert.deepEqual(t.record.forks, [
    { cursor: { sessionId: 'provider-1', at: 'entry-2' }, exact: true, latest: false, resumeSessionId: undefined },
  ])

  const copied = await t.events(t.forkKey)
  assert.deepEqual(await t.texts(), ['one', 'two'])
  assert.ok(
    copied.every((entry) => entry.agentId === 'fork'),
    'every event the fork holds is its own',
  )
  assert.deepEqual(
    copied.map((entry) => entry.seq),
    copied.map((_, index) => index + 1),
    'numbered from its own start',
  )
  assert.ok(
    copied.every((entry) => entry.payload?.checkpointTurnSeq === undefined),
    'the parent’s checkpoints stay with the parent',
  )
  assert.deepEqual(copied.at(-1)?.payload, {
    forkedFrom: { agentId: 'agent', turnSeq: two.seq },
    providerSessionId: 'provider-1',
    providerResumeAt: 'entry-2',
    conversationTitle: 'Atlas (fork)',
    titleSource: 'user',
  })
  assert.deepEqual(await t.texts(t.key), ['one', 'two', 'three'], 'the chat forked from is left as it was')

  await t.start(t.forkKey)
  assert.deepEqual(t.record.starts.at(-1)?.resumeSessionId, 'provider-1')
  assert.deepEqual(t.record.starts.at(-1)?.resumeSessionAt, 'entry-2')
  // The fork's transcript is its cursor: a restart before its first message
  // branches at the same point.
  await t.restart()
  await t.start(t.forkKey)
  assert.deepEqual(t.record.starts.at(-1)?.resumeSessionAt, 'entry-2')
})

test('a fork at a user message holds what came before it', async () => {
  const t = await setup()
  t.chat.sessionId = await t.start()
  await t.send('one')
  await t.send('two')
  const two = await t.userMessage('two')
  assert.deepEqual(
    await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'user', turnSeq: two.seq }),
    { ok: true },
  )
  assert.deepEqual(await t.texts(), ['one'])
  assert.deepEqual(t.record.forks.at(-1)?.cursor, { sessionId: 'provider-1', at: 'entry-1' })
  assert.equal(t.record.forks.at(-1)?.latest, false, 'the provider has seen the message forked before')
})

test('a fork before the first message holds nothing and starts afresh', async () => {
  const t = await setup()
  t.chat.sessionId = await t.start()
  await t.send('one')
  const one = await t.userMessage('one')
  assert.ok((await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'user', turnSeq: one.seq })).ok)
  assert.deepEqual(t.record.forks.at(-1), { cursor: null, exact: true, latest: false, resumeSessionId: undefined })
  assert.deepEqual(await t.texts(), [])
  await t.start(t.forkKey)
  assert.equal(t.record.starts.at(-1)?.resumeSessionId, undefined)
  assert.equal(t.record.starts.at(-1)?.seedFromHistory, undefined, 'there is nothing to hand over')
})

test('the latest reply is forked as the newest point the provider has', async () => {
  const t = await setup()
  t.chat.sessionId = await t.start()
  await t.send('one')
  const one = await t.userMessage('one')
  assert.ok(
    (await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: one.turnId })).ok,
  )
  assert.equal(t.record.forks.at(-1)?.latest, true)
})

test('turns a rewind hid stay out of the fork', async () => {
  const t = await setup()
  t.chat.sessionId = await t.start()
  await t.send('one')
  await t.send('two')
  await t.send('three')
  assert.ok((await t.chat.runtime.rewindToTurn({ key: t.key, turnSeq: (await t.userMessage('two')).seq })).ok)
  await t.send('two again')
  const again = await t.userMessage('two again')
  assert.ok(
    (await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: again.turnId })).ok,
  )
  assert.deepEqual(await t.texts(), ['one', 'two again'])
  assert.ok(
    (await t.events(t.forkKey)).every((entry) => entry.payload?.rewoundFromSeq === undefined),
    'the rewind’s mark names the parent’s numbering, so it stays behind too',
  )
  const hidden = await t.chat.runtime.forkAtTurn({
    key: t.key,
    newAgentId: 'other',
    side: 'user',
    turnSeq: (await t.userMessage('three')).seq,
  })
  assert.deepEqual(hidden, { ok: false, message: 'That message is no longer in this conversation.' })
})

test('a fork is refused while the chat is working, without the capability, or into a chat that has one', async () => {
  let open = () => {}
  const gate = new Promise<void>((resolve) => (open = resolve))
  const busy = await setup({ gate })
  busy.chat.sessionId = await busy.start()
  const running = busy.chat.runtime.sendTurn({ sessionId: busy.chat.sessionId, message: 'one' })
  for (let i = 0; i < 50 && !(await busy.events()).some((entry) => entry.type === 'turn_started'); i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const one = await busy.userMessage('one')
  assert.deepEqual(
    await busy.chat.runtime.forkAtTurn({ key: busy.key, newAgentId: 'fork', side: 'user', turnSeq: one.seq }),
    { ok: false, message: 'Stop the running turn before forking from an earlier message.' },
  )
  open()
  assert.ok((await running).ok)
  assert.deepEqual(busy.record.forks, [])

  const incapable = await setup({ capable: false })
  incapable.chat.sessionId = await incapable.start()
  await incapable.send('one')
  const first = await incapable.userMessage('one')
  assert.deepEqual(
    await incapable.chat.runtime.forkAtTurn({
      key: incapable.key,
      newAgentId: 'fork',
      side: 'assistant',
      turnId: first.turnId,
    }),
    { ok: false, message: 'This agent cannot be forked.' },
  )
  assert.deepEqual(await incapable.texts(), [], 'a refused fork writes nothing')

  const taken = await setup()
  taken.chat.sessionId = await taken.start()
  await taken.send('one')
  const reply = await taken.userMessage('one')
  const fork = { key: taken.key, newAgentId: 'fork', side: 'assistant' as const, turnId: reply.turnId }
  assert.ok((await taken.chat.runtime.forkAtTurn(fork)).ok)
  assert.deepEqual(await taken.chat.runtime.forkAtTurn(fork), {
    ok: false,
    message: 'The chat to fork into already has a conversation.',
  })
})

test('a provider that cannot branch its session seeds the fork with the conversation until it is sent a message', async () => {
  const t = await setup({ fork: 'seed' })
  t.chat.sessionId = await t.start()
  await t.send('one')
  await t.send('two')
  const one = await t.userMessage('one')
  assert.ok(
    (await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: one.turnId })).ok,
  )
  const mark = (await t.events(t.forkKey)).at(-1)
  assert.equal(mark?.payload?.seedFromHistory, true)
  assert.equal(mark?.payload?.providerSessionId, null)

  await t.start(t.forkKey)
  assert.equal(t.record.starts.at(-1)?.seedFromHistory, true)
  assert.equal(t.record.starts.at(-1)?.resumeSessionId, undefined)
  assert.deepEqual(t.record.starts.at(-1)?.fallbackHistory, [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'reply to one' },
  ])
  // Still owed after a restart, as long as nothing was sent.
  await t.restart()
  const resumed = await t.start(t.forkKey)
  assert.equal(t.record.starts.at(-1)?.seedFromHistory, true)
  await t.send('next', resumed)
  await t.restart()
  await t.start(t.forkKey)
  assert.equal(t.record.starts.at(-1)?.seedFromHistory, undefined, 'the first message carried it')
})

test('a stateless chat’s fork replays the conversation it holds', async () => {
  const t = await setup({ stateless: true })
  t.chat.sessionId = await t.start()
  await t.send('one')
  await t.send('two')
  const one = await t.userMessage('one')
  assert.ok(
    (await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: one.turnId })).ok,
  )
  assert.deepEqual(t.record.forks, [], 'a stateless provider has no session to branch')
  const forkSession = await t.start(t.forkKey)
  await t.send('next', forkSession)
  assert.deepEqual(t.record.messages.at(-1), [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'reply to one' },
    { role: 'user', content: 'next' },
  ])
})

// A chat a steer joined: "one" was running when "steer" went in, and the
// provider had no point between them to record.
function steeredTranscript() {
  const base = { workspaceId: 'workspace', agentId: 'agent', sessionId: 'old', providerId: 'forking', modelId: 'model' }
  const lines: Array<{ type: ConversationEventType; payload: object }> = [
    { type: 'session_started', payload: {} },
    { type: 'user_message', payload: { turnId: 'z', text: 'zero' } },
    { type: 'turn_started', payload: { turnId: 'z' } },
    { type: 'tool_started', payload: { turnId: 'z', toolUseId: 'tool-1', name: 'Read', kind: 'file_read', input: {} } },
    { type: 'content_delta', payload: { turnId: 'z', text: 'zero done' } },
    {
      type: 'turn_completed',
      payload: { turnId: 'z', providerCursor: { sessionId: 'provider-1', at: 'entry-1' }, checkpointTurnSeq: 2 },
    },
    { type: 'user_message', payload: { turnId: 'a', text: 'one' } },
    { type: 'turn_started', payload: { turnId: 'a' } },
    { type: 'content_delta', payload: { turnId: 'a', text: 'working on one' } },
    { type: 'turn_completed', payload: { turnId: 'a', steered: true } },
    { type: 'user_message', payload: { turnId: 'b', text: 'steer' } },
    { type: 'turn_started', payload: { turnId: 'b' } },
    { type: 'content_delta', payload: { turnId: 'b', text: 'both done' } },
    { type: 'turn_completed', payload: { turnId: 'b', providerCursor: { sessionId: 'provider-1', at: 'entry-2' } } },
  ]
  return lines.map((line, index) => ({ ...base, id: `e${index + 1}`, seq: index + 1, createdAt: index, ...line }))
}

test('a steered turn: the message that joined it forks before both, its own reply cannot be forked', async () => {
  const t = await setup({ transcript: steeredTranscript() })
  const steer = await t.userMessage('steer')
  assert.ok((await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'user', turnSeq: steer.seq })).ok)
  assert.deepEqual(await t.texts(), ['zero'], 'what stays is what the provider had before the joined turn')
  assert.deepEqual(t.record.forks.at(-1)?.cursor, { sessionId: 'provider-1', at: 'entry-1' })

  assert.deepEqual(
    await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'other', side: 'assistant', turnId: 'a' }),
    { ok: false, message: 'No record of where the provider stood there.' },
  )
  assert.equal(t.record.forks.at(-1)?.exact, false)

  assert.ok((await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'third', side: 'assistant', turnId: 'b' })).ok)
  assert.deepEqual(await t.texts({ ...t.key, agentId: 'third' }), ['zero', 'one', 'steer'])
  assert.deepEqual(t.record.forks.at(-1)?.cursor, { sessionId: 'provider-1', at: 'entry-2' })
})

test('a fork’s steps open their details as the parent’s do', async () => {
  const t = await setup({ transcript: steeredTranscript() })
  const detail = workspaceStorePath(t.key.workspaceRoot, 'conversations', 'workspace', 'agent.tools', 'tool-1.json')
  await mkdir(dirname(detail), { recursive: true })
  await writeFile(detail, JSON.stringify({ input: {}, output: 'file text', status: 'ok', clipped: false }))
  assert.ok((await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: 'z' })).ok)
  const copied = await t.chat.runtime.getToolDetail({ ...t.forkKey, toolUseId: 'tool-1' })
  assert.ok(copied.ok)
  assert.equal(copied.detail.output, 'file text')
})

test('a seeded fork whose first message never reached the provider still owes the conversation', async () => {
  const t = await setup({ fork: 'seed' })
  t.chat.sessionId = await t.start()
  await t.send('one')
  const one = await t.userMessage('one')
  assert.ok(
    (await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: one.turnId })).ok,
  )
  await t.chat.runtime.sendTurn({ sessionId: await t.start(t.forkKey), message: 'unreached' })
  assert.ok((await t.events(t.forkKey)).some((entry) => entry.type === 'turn_failed'))
  await t.restart()
  const again = await t.start(t.forkKey)
  assert.equal(t.record.starts.at(-1)?.seedFromHistory, true, 'nothing carried it yet')
  await t.send('carried', again)
  await t.restart()
  await t.start(t.forkKey)
  assert.equal(t.record.starts.at(-1)?.seedFromHistory, undefined)
})

test('a fork reads only cursors its own provider wrote', async () => {
  const base = { workspaceId: 'workspace', agentId: 'agent', sessionId: 'old', modelId: 'model' }
  const lines = [
    { providerId: 'other', type: 'user_message', payload: { turnId: 'x', text: 'elsewhere' } },
    {
      providerId: 'other',
      type: 'turn_completed',
      payload: { turnId: 'x', providerCursor: { sessionId: 'other-session', at: 'other-entry' } },
    },
    { providerId: 'forking', type: 'user_message', payload: { turnId: 'y', text: 'here' } },
    { providerId: 'forking', type: 'turn_completed', payload: { turnId: 'y' } },
  ].map((line, index) => ({ ...base, ...line, id: `e${index + 1}`, seq: index + 1, createdAt: index }))
  const t = await setup({ fork: 'seed', transcript: lines })
  assert.ok((await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: 'y' })).ok)
  assert.equal(t.record.forks.at(-1)?.cursor, null, 'the other runtime’s session is not this one’s')
  assert.equal(t.record.forks.at(-1)?.exact, false)
})

test('a fork’s thread totals only what it spent itself', async () => {
  const t = await setup()
  t.chat.sessionId = await t.start()
  const base = { workspaceRoot: t.key.workspaceRoot, workspaceId: 'workspace' }
  await t.send('one')
  const one = await t.userMessage('one')
  assert.ok(
    (await t.chat.runtime.forkAtTurn({ key: t.key, newAgentId: 'fork', side: 'assistant', turnId: one.turnId })).ok,
  )
  const listed = await t.chat.runtime.listThreads(base)
  assert.ok(listed.ok)
  const fork = listed.threads.find((thread) => thread.agentId === 'fork')
  assert.equal(listed.threads.find((thread) => thread.agentId === 'agent')?.totalCostUsd, 0.5)
  assert.equal(fork?.totalCostUsd, undefined, 'the copied turn was paid for by the chat it came from')
})
