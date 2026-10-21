import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type {
  ConversationProviderAdapter,
  ConversationProviderCursor,
  MockAdapterSessionInput,
} from './providers/conversation-provider-adapter'
import type { ConversationCapabilities, ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

// Handoff (ConversationRuntime.handoffConversation): the chat's messages go to
// a file first, then the provider session goes, and a `context_handed_off`
// records the file as the resume cursor of a session that does not exist yet.
// The next message that is not a command carries the pointer; a rewind across
// the handoff goes back to the session that was there.

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

async function setup(script: { turn?: TurnScript; hold?: Promise<void> } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-handoff-'))
  roots.add(workspaceRoot)
  const record: Calls = { starts: [], handoffs: [], rewinds: [], sent: [], sessions: 0 }
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const open = async () => {
    const runtime = new ConversationRuntime({
      adapters: [handingProvider(record, script)],
      getProviderById: () => undefined,
      secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    })
    runtimes.add(runtime)
    const started = await runtime.startSession({ ...key, providerId: 'handing', modelId: 'model' })
    assert.ok(started.ok)
    return { runtime, sessionId: started.session.sessionId }
  }
  let current = await open()
  const chat = {
    key,
    record,
    get runtime() {
      return current.runtime
    },
    send: async (message: string) =>
      assert.ok((await current.runtime.sendTurn({ sessionId: current.sessionId, message })).ok),
    sendLater: (message: string) => current.runtime.sendTurn({ sessionId: current.sessionId, message }),
    restart: async () => {
      await current.runtime.shutdown()
      current = await open()
    },
    events: async () => {
      const transcript = await current.runtime.readTranscript(key)
      assert.ok(transcript.ok)
      return transcript.events
    },
    seqOf: async (text: string) =>
      (await chat.events()).filter((entry) => entry.type === 'user_message' && entry.payload?.text === text).at(-1)
        ?.seq ?? 0,
  }
  return chat
}

test('a handoff writes the messages to a file before the session goes, and the next message carries the pointer', async () => {
  const chat = await setup()
  await chat.send('make the release script check the tag')
  await chat.send('ship it')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.ok(handed.ok, 'handed off')
  // Beside the transcript, in the project's store, named by chat and minute.
  assert.match(handed.path, /[\\/]conversations[\\/]workspace[\\/]handoffs[\\/]agent-\d{8}-\d{4}\.md$/u)
  // The file was on disk when the provider was told to let its session go.
  assert.deepEqual(chat.record.handoffs, [{ path: handed.path, fileOnDisk: true }])
  const file = await readFile(handed.path, 'utf8')
  assert.match(file, /make the release script check the tag/u)
  assert.match(file, /reply to ship it/u)
  assert.match(file, /the messages only, without the tool calls/u)

  const mark = (await chat.events()).at(-1)
  assert.equal(mark?.type, 'context_handed_off')
  assert.deepEqual(mark?.payload, { path: handed.path, seedOwed: true, providerSessionId: null })

  // The next message starts a fresh session and points it at the file, once.
  await chat.send('where were we?')
  await chat.send('and after that?')
  assert.deepEqual(chat.record.sent.slice(-2), [
    { message: 'where were we?', pointer: handed.path },
    { message: 'and after that?' },
  ])
  // The history above the divider is still there, and the pointer is not a message.
  const texts = (await chat.events()).filter((entry) => entry.type === 'user_message').map((entry) => entry.payload?.text)
  assert.deepEqual(texts, ['make the release script check the tag', 'ship it', 'where were we?', 'and after that?'])
})

test('after a restart the handed-off chat starts afresh owing the pointer, and resumes the new session once it is carried', async () => {
  const chat = await setup()
  await chat.send('one')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.ok(handed.ok)
  await chat.restart()
  assert.deepEqual(chat.record.starts.at(-1), {
    resumeSessionId: undefined,
    resumeSessionAt: undefined,
    handoffPath: handed.path,
  })
  await chat.send('two')
  assert.deepEqual(chat.record.sent.at(-1), { message: 'two', pointer: handed.path })
  await chat.restart()
  assert.deepEqual(chat.record.starts.at(-1), {
    resumeSessionId: 'provider-2',
    resumeSessionAt: undefined,
    handoffPath: undefined,
  })
})

test('a command after a handoff carries no pointer, and the pointer is still owed after a restart', async () => {
  const chat = await setup()
  await chat.send('one')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.ok(handed.ok)
  await chat.send('/context')
  assert.deepEqual(chat.record.sent.at(-1), { message: '/context' })
  await chat.restart()
  // The command's turn opened the new session; the pointer waits for prose.
  assert.deepEqual(chat.record.starts.at(-1), {
    resumeSessionId: 'provider-2',
    resumeSessionAt: undefined,
    handoffPath: handed.path,
  })
  await chat.send('now the real question')
  assert.deepEqual(chat.record.sent.at(-1), { message: 'now the real question', pointer: handed.path })
})

test('a handoff no message has carried yet is not handed off again', async () => {
  const chat = await setup()
  await chat.send('one')
  assert.ok((await chat.runtime.handoffConversation({ key: chat.key })).ok)
  const again = await chat.runtime.handoffConversation({ key: chat.key })
  assert.equal(again.ok, false)
  assert.equal(chat.record.handoffs.length, 1)
})

test('a chat with nothing said yet has nothing to hand off', async () => {
  const chat = await setup()
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.deepEqual(handed, { ok: false, message: 'This chat has no messages to hand off yet.' })
  assert.equal(chat.record.handoffs.length, 0)
})

test('Edit from here before the handoff resumes the old session at that point and owes no pointer', async () => {
  const chat = await setup()
  await chat.send('one')
  await chat.send('two')
  assert.ok((await chat.runtime.handoffConversation({ key: chat.key })).ok)
  await chat.send('three')
  const two = await chat.seqOf('two')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: two }), { ok: true })
  assert.deepEqual(chat.record.rewinds.at(-1), { cursor: { sessionId: 'provider-1', at: 'entry-1' } })
  const marker = (await chat.events()).at(-1)
  assert.deepEqual(marker?.payload, { rewoundFromSeq: two, providerSessionId: 'provider-1', providerResumeAt: 'entry-1' })
  await chat.restart()
  assert.deepEqual(chat.record.starts.at(-1), {
    resumeSessionId: 'provider-1',
    resumeSessionAt: 'entry-1',
    handoffPath: undefined,
  })
})

test('Edit from here on the first message after the handoff goes back to the start of the new session, owing the pointer again', async () => {
  const chat = await setup()
  await chat.send('one')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.ok(handed.ok)
  await chat.send('two')
  const two = await chat.seqOf('two')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: two }), { ok: true })
  assert.deepEqual(chat.record.rewinds.at(-1), { cursor: null, handoffPath: handed.path })
  const marker = (await chat.events()).at(-1)
  assert.deepEqual(marker?.payload, { rewoundFromSeq: two, providerSessionId: null, handoffSeedOwed: handed.path })
  await chat.restart()
  assert.deepEqual(chat.record.starts.at(-1), {
    resumeSessionId: undefined,
    resumeSessionAt: undefined,
    handoffPath: handed.path,
  })
})

test('Edit from here after the pointer was carried stays in the new session', async () => {
  const chat = await setup()
  await chat.send('one')
  assert.ok((await chat.runtime.handoffConversation({ key: chat.key })).ok)
  await chat.send('two')
  await chat.send('three')
  const three = await chat.seqOf('three')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: three }), { ok: true })
  assert.deepEqual(chat.record.rewinds.at(-1), { cursor: { sessionId: 'provider-2', at: 'entry-1' } })
})

test('deleting the chat deletes its handoff files', async () => {
  const chat = await setup()
  await chat.send('one')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.ok(handed.ok)
  assert.ok((await chat.runtime.deleteTranscript(chat.key)).ok)
  await assert.rejects(access(handed.path))
})

test('a handoff is refused while a turn runs', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => (release = resolve))
  const chat = await setup({ hold })
  const turn = chat.sendLater('a long one')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.deepEqual(handed, { ok: false, message: 'Stop the running turn before handing the chat off.' })
  release()
  assert.ok((await turn).ok)
  assert.equal(chat.record.handoffs.length, 0)
})

test('a handoff is refused while the agent waits on an answer', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => (release = resolve))
  const chat = await setup({
    hold,
    turn: (input) => [
      event(input, 'approval_requested', { turnId: input.turnId, requestId: 'ask-1', kind: 'tool', summary: 'Run npm test' }),
    ],
  })
  const turn = chat.sendLater('test it')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.deepEqual(handed, { ok: false, message: 'Answer what the agent is waiting on before handing the chat off.' })
  release()
  await turn
  assert.equal(chat.record.handoffs.length, 0)
})

test('a handoff is refused while an agent the chat started is still working', async () => {
  const chat = await setup({
    turn: (input) => [
      event(input, 'subagent_status', { toolUseId: 'agent-1', status: 'running', background: true }),
    ],
  })
  await chat.send('look into it in the background')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.equal(handed.ok, false)
  assert.match(handed.ok ? '' : handed.message, /An agent this chat started is still working/u)
  assert.equal(chat.record.handoffs.length, 0)
  assert.notEqual((await chat.events()).at(-1)?.type, 'context_handed_off')
})

test('a handoff is refused while a shell or monitor the chat started is still running', async () => {
  const chat = await setup({
    turn: (input) => [
      event(input, 'session_updated', { backgroundTasks: [{ taskId: 'dev-server', kind: 'command' }] }),
    ],
  })
  await chat.send('start the dev server')
  const handed = await chat.runtime.handoffConversation({ key: chat.key })
  assert.equal(handed.ok, false)
  assert.match(handed.ok ? '' : handed.message, /A shell or monitor this chat started is still running/u)
  assert.equal(chat.record.handoffs.length, 0)
})

test('a provider that cannot hand off is refused', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-handoff-'))
  roots.add(workspaceRoot)
  const record: Calls = { starts: [], handoffs: [], rewinds: [], sent: [], sessions: 0 }
  const adapter = handingProvider(record)
  delete adapter.handoff
  const runtime = new ConversationRuntime({
    adapters: [{ ...adapter, capabilities: { ...CAPABILITIES, handoff: false } }],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.add(runtime)
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'handing', modelId: 'model' })
  assert.ok(started.ok)
  assert.ok((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'one' })).ok)
  assert.deepEqual(await runtime.handoffConversation({ key }), {
    ok: false,
    message: 'This agent cannot hand a chat off to a new session.',
  })
})
