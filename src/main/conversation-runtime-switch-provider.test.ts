import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type {
  ConversationMessage,
  ConversationProviderAdapter,
  ConversationProviderCursor,
  MockAdapterSessionInput,
} from './providers/conversation-provider-adapter'
import type { ConversationCapabilities, ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

// Moving a chat to another agent (ConversationRuntime.switchConversationProvider):
// the chat's words go to a file inside a budget, its session ends, and a mark
// under the new provider is the cursor that provider's next session starts
// from. An agent that takes a handoff file is pointed at it; any other is
// handed the file's words as the history its first message carries.

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
  approvals: true,
  questions: false,
  planMode: false,
  images: false,
  skills: 'none',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: true,
  cost: false,
  contextMeter: false,
  liveModelSwitch: false,
  rewind: true,
  handoff: true,
}

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

type Calls = {
  starts: Array<{ resumeSessionId?: string; resumeSessionAt?: string; handoffPath?: string }>
  handoffs: Array<{ path: string; fileOnDisk: boolean }>
  rewinds: Array<{ cursor: ConversationProviderCursor | null; handoffPath?: string }>
  // What the provider was sent, with the pointer when it carried one.
  sent: Array<{ message: string; pointer?: string }>
  // Provider sessions opened, across restarts.
  sessions: number
}

type TurnScript = (input: MockAdapterSessionInput & { turnId: string }) => ConversationEvent[]

// A stateful provider that numbers its sessions the way Claude Code's do: one
// per fresh start, each turn ending at the next entry of the session it is in.
function handingProvider(record: Calls, script: { turn?: TurnScript; hold?: Promise<void> } = {}) {
  type State = { session: string | null; entries: number; owed?: string }
  const states = new Map<string, State>()
  const adapter: ConversationProviderAdapter = {
    id: 'handing',
    sessions: 'stateful',
    capabilities: CAPABILITIES,
    listModels: () => ['model'],
    startSession: (input) => {
      record.starts.push({
        resumeSessionId: input.resumeSessionId,
        resumeSessionAt: input.resumeSessionAt,
        handoffPath: input.handoffPath,
      })
      states.set(input.sessionId, {
        session: input.resumeSessionId ?? null,
        entries: 0,
        ...(input.handoffPath ? { owed: input.handoffPath } : {}),
      })
      return [event(input, 'session_started', { providerSessionId: input.resumeSessionId ?? null })]
    },
    async *sendTurn(input) {
      const state = states.get(input.sessionId)!
      yield event(input, 'turn_started', { turnId: input.turnId })
      const command = input.message.startsWith('/')
      const pointer = state.owed && !command ? state.owed : undefined
      record.sent.push({ message: input.message, ...(pointer ? { pointer } : {}) })
      if (pointer) {
        state.owed = undefined
        yield event(input, 'session_updated', { historySeeded: true })
      }
      if (!state.session) {
        state.session = `provider-${++record.sessions}`
        yield event(input, 'session_updated', { providerSessionId: state.session })
      }
      for (const extra of script.turn?.(input) ?? []) yield extra
      if (script.hold) await script.hold
      yield event(input, 'content_delta', { turnId: input.turnId, text: `reply to ${input.message}` })
      yield event(input, 'turn_completed', {
        turnId: input.turnId,
        providerCursor: { sessionId: state.session, at: `entry-${++state.entries}` },
      })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
    rewind: async (input) => {
      record.rewinds.push({ cursor: input.cursor, ...(input.handoffPath ? { handoffPath: input.handoffPath } : {}) })
      const state = states.get(input.sessionId)
      if (state) {
        state.session = input.cursor?.sessionId ?? null
        state.owed = input.handoffPath
      }
      return { ok: true }
    },
    handoff: async (input) => {
      const fileOnDisk = await access(input.handoffPath).then(
        () => true,
        () => false,
      )
      record.handoffs.push({ path: input.handoffPath, fileOnDisk })
      const state = states.get(input.sessionId)
      if (state) {
        state.session = null
        state.entries = 0
        state.owed = input.handoffPath
      }
      return { ok: true }
    },
  }
  return adapter
}

type SeedCalls = {
  starts: Array<{ resumeSessionId?: string; seedFromHistory?: boolean; fallbackHistory?: ConversationMessage[] }>
  sent: Array<{ message: string; seeded: boolean }>
  sessions: number
}

// A stateful provider that takes no handoff file: a fresh session is seeded
// with history as text, as a fork that could not branch is.
function seedingProvider(record: SeedCalls) {
  type State = { session: string | null; seed: boolean; entries: number }
  const states = new Map<string, State>()
  const adapter: ConversationProviderAdapter = {
    id: 'seeding',
    displayName: 'Seeding CLI',
    sessions: 'stateful',
    capabilities: { ...CAPABILITIES, handoff: false },
    listModels: () => ['fast', 'slow'],
    startSession: (input) => {
      record.starts.push({
        resumeSessionId: input.resumeSessionId,
        seedFromHistory: input.seedFromHistory,
        fallbackHistory: input.fallbackHistory,
      })
      states.set(input.sessionId, {
        session: input.resumeSessionId ?? null,
        seed: input.seedFromHistory === true,
        entries: 0,
      })
      return [event(input, 'session_started', { providerSessionId: input.resumeSessionId ?? null })]
    },
    async *sendTurn(input) {
      const state = states.get(input.sessionId)!
      yield event(input, 'turn_started', { turnId: input.turnId })
      record.sent.push({ message: input.message, seeded: state.seed })
      if (state.seed) {
        state.seed = false
        yield event(input, 'session_updated', { historySeeded: true })
      }
      if (!state.session) {
        state.session = `seed-${++record.sessions}`
        yield event(input, 'session_updated', { providerSessionId: state.session })
      }
      yield event(input, 'content_delta', { turnId: input.turnId, text: `seeded reply to ${input.message}` })
      yield event(input, 'turn_completed', {
        turnId: input.turnId,
        providerCursor: { sessionId: state.session, at: `entry-${++state.entries}` },
      })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
  }
  return adapter
}

async function setup(script: { hold?: Promise<void> } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-switch-'))
  roots.add(workspaceRoot)
  const record: Calls = { starts: [], handoffs: [], rewinds: [], sent: [], sessions: 0 }
  const seeds: SeedCalls = { starts: [], sent: [], sessions: 0 }
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({
    adapters: [handingProvider(record, script), seedingProvider(seeds)],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.add(runtime)
  let sessionId = ''
  const start = async (providerId: string, modelId: string) => {
    const started = await runtime.startSession({ ...key, providerId, modelId })
    assert.ok(started.ok, started.ok ? '' : started.message)
    sessionId = started.session.sessionId
  }
  await start('handing', 'model')
  return {
    key,
    record,
    seeds,
    runtime,
    start,
    send: async (message: string) => {
      const sent = await runtime.sendTurn({ sessionId, message })
      assert.ok(sent.ok, sent.ok ? '' : sent.message)
    },
    sendLater: (message: string) => runtime.sendTurn({ sessionId, message }),
    stop: async () => void (await runtime.stopSession({ sessionId })),
    events: async () => {
      const transcript = await runtime.readTranscript(key)
      assert.ok(transcript.ok)
      return transcript.events
    },
  }
}

test('moving a chat to an agent that takes no handoff file seeds its first message with the chat so far', async () => {
  const chat = await setup()
  await chat.send('make the release script check the tag')
  await chat.send('ship it')
  const moved = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'fast' })
  assert.ok(moved.ok, moved.ok ? '' : moved.message)
  assert.equal(moved.providerId, 'seeding')
  assert.equal(moved.modelId, 'fast')
  assert.ok(moved.path)
  const file = await readFile(moved.path, 'utf8')
  assert.match(file, /make the release script check the tag/u)
  assert.match(file, /reply to ship it/u)
  assert.match(file, /The chat has moved to you/u)
  assert.deepEqual(chat.record.handoffs, [], 'the old agent was not asked to hand off: its session was ended')
  const listed = chat.runtime.listSessions()
  assert.ok(listed.ok)
  assert.equal(
    listed.sessions.some((session) => session.status !== 'stopped'),
    false,
    'the old session ended',
  )

  const mark = (await chat.events()).at(-1)
  assert.equal(mark?.type, 'context_handed_off')
  assert.equal(mark?.providerId, 'seeding', "the mark is the new provider's cursor")
  assert.deepEqual(mark?.payload?.switchedFrom, { providerId: 'handing', modelId: 'model' })

  await chat.start('seeding', 'fast')
  assert.equal(chat.seeds.starts.length, 1)
  const [first] = chat.seeds.starts
  assert.equal(first?.resumeSessionId, undefined, 'a fresh session')
  assert.equal(first?.seedFromHistory, true)
  assert.equal(first?.fallbackHistory?.length, 1)
  assert.equal(first?.fallbackHistory?.[0]?.role, 'user')
  assert.equal(first?.fallbackHistory?.[0]?.content, file.trim(), 'seeded with the file, not the whole transcript')

  await chat.send('where were we?')
  await chat.send('and then?')
  assert.deepEqual(chat.seeds.sent, [
    { message: 'where were we?', seeded: true },
    { message: 'and then?', seeded: false },
  ])
  const texts = (await chat.events())
    .filter((entry) => entry.type === 'user_message')
    .map((entry) => entry.payload?.text)
  assert.deepEqual(texts, ['make the release script check the tag', 'ship it', 'where were we?', 'and then?'])

  // Once seeded, the new agent's own session is the chat's: a new start resumes it.
  await chat.stop()
  await chat.start('seeding', 'fast')
  assert.equal(chat.seeds.starts.at(-1)?.resumeSessionId, 'seed-1')
  assert.equal(chat.seeds.starts.at(-1)?.seedFromHistory, undefined)
})

test('moving a chat to an agent that takes a handoff file points it at the file', async () => {
  const chat = await setup()
  await chat.send('one')
  const there = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'fast' })
  assert.ok(there.ok)
  await chat.start('seeding', 'fast')
  await chat.send('two')
  const back = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'handing', modelId: 'model' })
  assert.ok(back.ok && back.path)
  assert.match(await readFile(back.path, 'utf8'), /seeded reply to two/u)
  await chat.start('handing', 'model')
  assert.deepEqual(chat.record.starts.at(-1), {
    resumeSessionId: undefined,
    resumeSessionAt: undefined,
    handoffPath: back.path,
  })
  await chat.send('three')
  assert.deepEqual(chat.record.sent.at(-1), { message: 'three', pointer: back.path })
})

test('a model the session cannot take live is a move on the same agent', async () => {
  const chat = await setup()
  await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'fast' })
  await chat.start('seeding', 'fast')
  await chat.send('hello')
  const moved = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'slow' })
  assert.ok(moved.ok)
  await chat.start('seeding', 'slow')
  assert.equal(chat.seeds.starts.at(-1)?.resumeSessionId, undefined)
  assert.equal(chat.seeds.starts.at(-1)?.seedFromHistory, true)
})

test('it is refused while the chat works, for an agent not here, and for where the chat already is', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => (release = resolve))
  const chat = await setup({ hold })
  const running = chat.sendLater('long job')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const busy = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'fast' })
  assert.equal(busy.ok, false)
  assert.match(busy.ok ? '' : busy.message, /Stop the running turn before switching the agent/u)
  release()
  await running
  const unknown = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'nope', modelId: 'x' })
  assert.equal(unknown.ok, false)
  const same = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'handing', modelId: 'model' })
  assert.equal(same.ok, false)
})

test('a long chat is cut to the budget, newest messages kept, and says so', async () => {
  const chat = await setup()
  const filler = 'x'.repeat(4_000)
  for (let index = 0; index < 30; index += 1) await chat.send(`message ${index} ${filler}`)
  const moved = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'fast' })
  assert.ok(moved.ok && moved.path)
  const file = await readFile(moved.path, 'utf8')
  assert.ok(Buffer.byteLength(file) <= 64 * 1024, `${Buffer.byteLength(file)} bytes`)
  assert.match(file, /message 29 /u, 'the newest message is kept')
  assert.doesNotMatch(file, /message 0 /u, 'the oldest is left out')
  assert.match(file, /most recent part/u)
  await access(moved.path)
})

test('a chat with nothing said yet moves without a file', async () => {
  const chat = await setup()
  const moved = await chat.runtime.switchConversationProvider({ key: chat.key, providerId: 'seeding', modelId: 'fast' })
  assert.ok(moved.ok)
  assert.equal(moved.path, null)
  await chat.start('seeding', 'fast')
  assert.equal(chat.seeds.starts.at(-1)?.seedFromHistory, undefined)
})
