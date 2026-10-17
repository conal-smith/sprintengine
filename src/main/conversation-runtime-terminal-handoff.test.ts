import assert from 'node:assert/strict'
import { workspaceStorePath } from './workspace-store'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { AgentLaunchRequest } from '../shared/agent-launch'
import { ConversationRuntime } from './conversation-runtime'
import { createConversationTerminalHandoff } from './conversation-terminal-handoff'
import type {
  ConversationProviderAdapter,
  ConversationProviderCursor,
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
}

type Calls = {
  starts: Array<{ resumeSessionId?: string; resumeSessionAt?: string }>
  rewinds: Array<ConversationProviderCursor | null>
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

// A stateful provider whose every turn ends where a real one would say its
// session stood: the next entry of one provider session.
function rewindingProvider(record: Calls, options: { rewind?: boolean; cursors?: boolean } = {}) {
  let entries = 0
  const adapter: ConversationProviderAdapter = {
    id: 'rewinding',
    sessions: 'stateful',
    capabilities: { ...CAPABILITIES, rewind: options.rewind !== false },
    listModels: () => ['model'],
    startSession: (input) => {
      record.starts.push({ resumeSessionId: input.resumeSessionId, resumeSessionAt: input.resumeSessionAt })
      return [event(input, 'session_started', { providerSessionId: input.resumeSessionId ?? null })]
    },
    async *sendTurn(input) {
      yield event(input, 'turn_started', { turnId: input.turnId })
      // As Claude's and Codex's do: the provider says which session it is.
      yield event(input, 'session_updated', { providerSessionId: 'provider-1' })
      yield event(input, 'content_delta', { turnId: input.turnId, text: `reply to ${input.message}` })
      yield event(input, 'turn_completed', {
        turnId: input.turnId,
        ...(options.cursors === false ? {} : { providerCursor: { sessionId: 'provider-1', at: `entry-${++entries}` } }),
      })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
  }
  if (options.rewind !== false)
    adapter.rewind = async (input) => {
      record.rewinds.push(input.cursor)
      return { ok: true }
    }
  return adapter
}

async function setup(options: { rewind?: boolean; cursors?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-handoff-'))
  roots.add(workspaceRoot)
  const record: Calls = { starts: [], rewinds: [] }
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const open = async () => {
    const runtime = new ConversationRuntime({
      adapters: [rewindingProvider(record, options)],
      getProviderById: () => undefined,
      secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    })
    runtimes.add(runtime)
    const started = await runtime.startSession({ ...key, providerId: 'rewinding', modelId: 'model' })
    assert.ok(started.ok)
    return { runtime, sessionId: started.session.sessionId }
  }
  const { runtime, sessionId } = await open()
  const send = async (message: string) => assert.ok((await runtime.sendTurn({ sessionId, message })).ok)
  const events = async () => {
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    return transcript.events
  }
  const seqOf = async (text: string) =>
    (await events()).filter((entry) => entry.type === 'user_message' && entry.payload?.text === text).at(-1)?.seq ?? 0
  return { runtime, key, record, send, events, seqOf, open }
}

function sessionOf(runtime: ConversationRuntime): string {
  const listed = runtime.listSessions()
  assert.ok(listed.ok)
  return listed.sessions[0]!.sessionId
}

test('a chat with no turn yet has no CLI session for a terminal to resume', async () => {
  const chat = await setup()
  const listed = chat.runtime.listSessions()
  const sessionId = listed.ok ? listed.sessions[0]!.sessionId : ''
  assert.deepEqual(await chat.runtime.terminalHandoffTarget({ sessionId }), {
    ok: false,
    message: 'This chat has no CLI session yet. Send it a message first.',
  })
})

test('a chat hands a terminal its CLI session, its folder and its mode', async () => {
  const chat = await setup()
  await chat.send('one')
  const sessionId = sessionOf(chat.runtime)
  const found = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.deepEqual(found, {
    ok: true,
    target: {
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'rewinding',
      modelId: 'model',
      workspaceRoot: chat.key.workspaceRoot,
      providerSessionId: 'provider-1',
    },
  })
})

test('a terminal is never handed a CLI session another provider wrote', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-handoff-'))
  roots.add(workspaceRoot)
  // The chat ran on another provider before this one: its thread id is the
  // newest cursor in the transcript, and means nothing to this provider's CLI.
  const dir = workspaceStorePath(workspaceRoot, 'conversations', 'workspace')
  await mkdir(dir, { recursive: true })
  const other = {
    id: 'old_1',
    sessionId: 'conv_other',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'other-provider',
    modelId: 'model',
    type: 'session_updated',
    createdAt: 1,
    payload: { providerSessionId: 'other-provider-thread' },
  }
  await writeFile(join(dir, 'agent.jsonl'), JSON.stringify(other) + '\n', 'utf-8')
  const runtime = new ConversationRuntime({
    adapters: [rewindingProvider({ starts: [], rewinds: [] })],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.add(runtime)
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'rewinding',
    modelId: 'model',
  })
  assert.ok(started.ok)
  assert.deepEqual(await runtime.terminalHandoffTarget({ sessionId: started.session.sessionId }), {
    ok: false,
    message: 'This chat has no CLI session yet. Send it a message first.',
  })
})

test('after Edit from here a terminal waits for the chat to take a turn from where it now stands', async () => {
  const chat = await setup()
  await chat.send('one')
  await chat.send('two')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: await chat.seqOf('two') }), { ok: true })
  const sessionId = sessionOf(chat.runtime)
  const refused = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.message : '', /taken back to an earlier message/)

  await chat.send('two again')
  assert.equal((await chat.runtime.terminalHandoffTarget({ sessionId })).ok, true)
})

test('the handoff notice lands in the chat without moving its resume point', async () => {
  const chat = await setup()
  await chat.send('one')
  const sessionId = sessionOf(chat.runtime)
  await chat.runtime.noteTerminalHandoff({ sessionId, notice: 'Continues in a terminal.' })
  const last = (await chat.events()).at(-1)
  assert.equal(last?.type, 'session_updated')
  assert.deepEqual(last?.payload, { notice: 'Continues in a terminal.' })
  const found = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.equal(found.ok && found.target.providerSessionId, 'provider-1')
})

// A stateful provider whose turns keep working until they are stopped, as a
// long turn does: `ask` waits on a permission card, `spawn` leaves a background
// agent running after its turn, anything else runs on. Interrupting answers the
// card no, as the CLI's own Stop does.
function workingProvider(record: { interrupts: number; denied: string[]; disposed: number }) {
  let pending: { requestId?: string; release: () => void } | null = null
  const adapter: ConversationProviderAdapter = {
    id: 'codex-agent',
    sessions: 'stateful',
    capabilities: { ...CAPABILITIES, approvals: true, subagents: true },
    listModels: () => ['model'],
    startSession: (input) => [event(input, 'session_started', {})],
    async *sendTurn(input) {
      yield event(input, 'turn_started', { turnId: input.turnId })
      yield event(input, 'session_updated', { providerSessionId: 'thread-1' })
      if (input.message === 'spawn') {
        yield event(input, 'subagent_status', { toolUseId: 'task-1', status: 'running', background: true })
        yield event(input, 'turn_completed', { turnId: input.turnId })
        return
      }
      if (input.message === 'ask')
        yield event(input, 'approval_requested', {
          turnId: input.turnId,
          requestId: input.requestId,
          action: 'Bash',
          summary: 'Bash: npm test',
        })
      await new Promise<void>((release) => {
        pending = { ...(input.message === 'ask' ? { requestId: input.requestId } : {}), release }
      })
    },
    resolveApproval: () => [],
    interrupt: (input) => {
      record.interrupts++
      if (pending?.requestId) record.denied.push(pending.requestId)
      pending?.release()
      pending = null
      return [event(input, 'turn_failed', { reason: 'interrupted' })]
    },
    stopSession: () => [],
    disposeChildProcess: () => {
      record.disposed++
      return true
    },
  }
  return adapter
}

async function workingChat() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-handoff-'))
  roots.add(workspaceRoot)
  const record = { interrupts: 0, denied: [] as string[], disposed: 0 }
  const runtime = new ConversationRuntime({
    adapters: [workingProvider(record)],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.add(runtime)
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'codex-agent', modelId: 'model' })
  assert.ok(started.ok)
  const sessionId = started.session.sessionId
  const seen: ConversationEventType[] = []
  runtime.onEvent((entry) => seen.push(entry.type))
  const waitFor = async (type: ConversationEventType) => {
    for (let tries = 0; tries < 200 && !seen.includes(type); tries++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(seen.includes(type), `no ${type} event`)
  }
  const summary = () => {
    const listed = runtime.listSessions()
    assert.ok(listed.ok)
    return listed.sessions[0]!
  }
  const events = async () => {
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    return transcript.events
  }
  // The handoff as main wires it, with a launch that records what the chat
  // looked like the moment the terminal was opened.
  const launches: Array<{ request: AgentLaunchRequest; status: string; interrupts: number; sendWhileOpening: string }> =
    []
  const handoff = (options: { cliResumesSessions?: boolean } = {}) =>
    createConversationTerminalHandoff({
      runtime,
      cliResumesSessions: () => options.cliResumesSessions !== false,
      launch: async (request) => {
        const send = await runtime.sendTurn({ sessionId, message: 'queued behind the stopped turn' })
        launches.push({
          request,
          status: summary().status,
          interrupts: record.interrupts,
          sendWhileOpening: send.ok ? 'sent' : send.message,
        })
        return {
          ok: true,
          workspaceId: request.workspaceId,
          agentId: 'terminal-agent',
          sessionId: 't',
          cli: 'codex',
          executionId: 't',
        }
      },
    }).handoff({ sessionId })
  return { runtime, sessionId, record, waitFor, summary, events, launches, handoff }
}

test('a handoff asked for mid-turn stops the turn first, then opens the terminal on its session', async () => {
  const chat = await workingChat()
  void chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'refactor the parser' })
  await chat.waitFor('session_updated')
  assert.equal(chat.summary().status, 'active')

  assert.deepEqual(await chat.handoff(), { ok: true, workspaceId: 'workspace', agentId: 'terminal-agent' })
  // Stopped and settled before the terminal opened, and the child gone with it.
  assert.equal(chat.launches.length, 1)
  assert.equal(chat.launches[0]!.interrupts, 1)
  assert.equal(chat.launches[0]!.status, 'ready')
  assert.equal(chat.launches[0]!.request.resumeCliSessionId, 'thread-1')
  assert.ok(chat.record.disposed > 0)
  // A message queued behind the stopped turn waits for the person rather than
  // respawning the chat beside the terminal.
  assert.match(chat.launches[0]!.sendWhileOpening, /moving to a terminal/)

  const events = await chat.events()
  const failed = events.filter((entry) => entry.type === 'turn_failed')
  assert.equal(failed.at(-1)?.payload?.reason, 'interrupted')
  assert.match(String(events.at(-1)?.payload?.notice), /^The agent was stopped, so this conversation could continue/)
  // Once it has moved, the chat takes a message again.
  void chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'one more thing' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(chat.summary().status, 'active')
})

test('a handoff asked for while a card waits answers it no, then hands over', async () => {
  const chat = await workingChat()
  void chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'ask' })
  await chat.waitFor('approval_requested')
  assert.equal(chat.summary().status, 'awaiting_approval')

  assert.equal((await chat.handoff()).ok, true)
  assert.equal(chat.record.denied.length, 1)
  assert.equal(chat.launches[0]!.interrupts, 1)
  assert.equal(chat.launches[0]!.status, 'ready')
  const events = await chat.events()
  const asked = events.findIndex((entry) => entry.type === 'approval_requested')
  const ended = events.findIndex((entry) => entry.type === 'turn_failed')
  // The turn ends after the card, which is what closes the card in the chat.
  assert.ok(asked >= 0 && ended > asked)
  assert.match(String(events.at(-1)?.payload?.notice), /^The agent was stopped/)
})

test('an agent the chat started is stopped with the handoff, and its card says so', async () => {
  const chat = await workingChat()
  assert.ok((await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'spawn' })).ok)
  assert.equal(chat.summary().backgroundAgents, 1)

  assert.equal((await chat.handoff()).ok, true)
  assert.equal(chat.record.interrupts, 0, 'no turn was running to interrupt')
  assert.equal(chat.summary().backgroundAgents, undefined)
  const events = await chat.events()
  const agent = events.filter((entry) => entry.type === 'subagent_status').at(-1)
  assert.equal(agent?.payload?.status, 'stopped')
  assert.match(String(events.at(-1)?.payload?.notice), /^The agent this chat started was stopped/)
})

test('a handoff refused for any other reason leaves a working chat running', async () => {
  const chat = await workingChat()
  void chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'refactor the parser' })
  await chat.waitFor('session_updated')
  assert.deepEqual(await chat.handoff({ cliResumesSessions: false }), {
    ok: false,
    message: 'A terminal cannot resume this kind of chat yet.',
  })
  assert.equal(chat.record.interrupts, 0)
  assert.equal(chat.summary().status, 'active')
})

test('while a handoff is under way, a second one is refused before it stops anything', async () => {
  const chat = await setup()
  await chat.send('one')
  const sessionId = sessionOf(chat.runtime)
  assert.equal((await chat.runtime.stopForTerminalHandoff({ sessionId })).ok, true)
  const second = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.equal(second.ok, false)
  assert.match(!second.ok ? second.message : '', /already moving to a terminal/u)
  chat.runtime.endTerminalHandoff({ sessionId })
  assert.equal((await chat.runtime.terminalHandoffTarget({ sessionId })).ok, true)
})

test('once a terminal has the session, Studio’s own sends are refused until the person writes again', async () => {
  const chat = await setup()
  await chat.send('one')
  const sessionId = sessionOf(chat.runtime)
  await chat.runtime.noteTerminalHandoff({ sessionId, notice: 'Continues in a terminal.' })

  // A launched agent's notice, a resume after a usage limit: neither respawns the chat beside the terminal.
  for (const origin of [
    { kind: 'studio', reason: 'agent-notice' },
    { kind: 'studio', reason: 'usage-resume' },
  ] as const) {
    const refused = await chat.runtime.sendTurn({ sessionId, message: '[SprintEngine Studio] news', origin })
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.message : '', /continues in a terminal/u)
  }

  // The person writing to the chat takes it back, and Studio may send again.
  await chat.send('back here')
  const after = await chat.runtime.sendTurn({
    sessionId,
    message: '[SprintEngine Studio] news',
    origin: { kind: 'studio', reason: 'agent-notice' },
  })
  assert.equal(after.ok, true)
})
