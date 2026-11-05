import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { AgentState } from '../shared/agent-state'
import type { ConversationEvent, ConversationSessionSummary } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import { createSubagentLifecycle, SUBAGENT_RESULT_MAX_CHARS, type SubagentLifecycleDeps } from './subagent-lifecycle'

const WORKSPACE = 'ws-1'
const parent = { workspaceId: WORKSPACE, agentId: 'agent-parent' }
const child = { workspaceId: WORKSPACE, agentId: 'agent-child' }

function chat(overrides: Partial<AgentState> = {}): AgentState {
  return { runtimeKind: 'conversation', ...overrides } as AgentState
}

function event(type: ConversationEvent['type'], who: typeof child, payload: unknown = {}, createdAt = 100) {
  return { type, payload, createdAt, sessionId: `conv-${who.agentId}`, ...who } as ConversationEvent
}

function harness(
  agents: Record<string, AgentState> = {
    [parent.agentId]: chat(),
    [child.agentId]: chat({ subagentOf: { agentId: parent.agentId, startedAt: 1 } }),
  },
  overrides: Partial<SubagentLifecycleDeps> = {},
) {
  const calls: string[] = []
  const lifecycle = createSubagentLifecycle({
    agentsOf: (workspaceId) => (workspaceId === WORKSPACE ? agents : null),
    workspaceIds: () => [WORKSPACE],
    writeEnd: ({ agentId }, end) => {
      agents[agentId] = { ...agents[agentId]!, subagentEnd: end }
    },
    removeAgent: ({ agentId }) => {
      calls.push(`remove ${agentId}`)
      delete agents[agentId]
    },
    session: ({ agentId }) =>
      ({ sessionId: `conv-${agentId}`, status: 'active', turnStartedAt: 1 }) as ConversationSessionSummary,
    interrupt: async (sessionId) => calls.push(`interrupt ${sessionId}`),
    rest: async (sessionId) => calls.push(`rest ${sessionId}`),
    readEvents: async () => [],
    deleteTranscript: async ({ agentId }) => calls.push(`delete ${agentId}`),
    now: () => 500,
    ...overrides,
  })
  return { agents, calls, lifecycle }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('a sub-agent ends with its first turn, and rests once the turn has let go', () => {
  const h = harness()
  h.lifecycle.onConversationEvent(event('turn_completed', child))
  assert.deepEqual(h.agents[child.agentId]?.subagentEnd, { at: 100, status: 'completed' })
  assert.deepEqual(h.calls, [])
  h.lifecycle.onSessionIdle({ sessionId: 'conv-agent-child', ...child })
  assert.deepEqual(h.calls, ['rest conv-agent-child'])
})

test("a failed turn keeps the provider's words, and an interrupted one reads as stopped", () => {
  const failed = harness()
  failed.lifecycle.onConversationEvent(event('turn_failed', child, { message: 'Usage limit reached.' }))
  assert.deepEqual(failed.agents[child.agentId]?.subagentEnd, {
    at: 100,
    status: 'failed',
    error: 'Usage limit reached.',
  })
  const stopped = harness()
  stopped.lifecycle.onConversationEvent(event('turn_failed', child, { reason: 'interrupted' }))
  assert.equal(stopped.agents[child.agentId]?.subagentEnd?.status, 'stopped')
  const codex = harness()
  codex.lifecycle.onConversationEvent(event('turn_completed', child, { interrupted: true }))
  assert.equal(codex.agents[child.agentId]?.subagentEnd?.status, 'stopped')
})

test('a steered turn is not the end, and a later turn does not change the first end', () => {
  const h = harness()
  h.lifecycle.onConversationEvent(event('turn_completed', child, { steered: true }))
  assert.equal(h.agents[child.agentId]?.subagentEnd, undefined)
  h.lifecycle.onConversationEvent(event('turn_completed', child))
  h.lifecycle.onConversationEvent(event('turn_failed', child, { message: 'Later.' }, 900))
  assert.deepEqual(h.agents[child.agentId]?.subagentEnd, { at: 100, status: 'completed' })
})

test('an ordinary chat is none of this', () => {
  const h = harness({ [parent.agentId]: chat() })
  h.lifecycle.onConversationEvent(event('turn_completed', parent))
  h.lifecycle.onSessionIdle({ sessionId: 'conv-agent-parent', ...parent })
  assert.equal(h.agents[parent.agentId]?.subagentEnd, undefined)
  assert.deepEqual(h.calls, [])
})

test('interrupting the parent stops its running sub-agents, and leaves finished ones alone', async () => {
  const h = harness({
    [parent.agentId]: chat(),
    [child.agentId]: chat({ subagentOf: { agentId: parent.agentId, startedAt: 1 } }),
    'agent-done': chat({
      subagentOf: { agentId: parent.agentId, startedAt: 1 },
      subagentEnd: { at: 50, status: 'completed' },
    }),
    'agent-other': chat({ subagentOf: { agentId: 'agent-someone-else', startedAt: 1 } }),
  })
  h.lifecycle.onConversationEvent(event('turn_failed', parent, { reason: 'interrupted' }))
  await tick()
  assert.equal(h.agents[child.agentId]?.subagentEnd?.status, 'stopped')
  assert.equal(h.agents['agent-done']?.subagentEnd?.status, 'completed')
  assert.equal(h.agents['agent-other']?.subagentEnd, undefined)
  assert.deepEqual(h.calls, ['interrupt conv-agent-child', 'rest conv-agent-child'])
})

test('stopping a sub-agent says so before the interrupt, and an ended one says nothing', async () => {
  const h = harness()
  const stopped: string[] = []
  h.lifecycle.onStopped(({ agentId }) => {
    stopped.push(agentId)
    h.calls.push('heard')
  })
  await h.lifecycle.stop(child)
  await h.lifecycle.stop(child)
  assert.deepEqual(stopped, [child.agentId])
  assert.deepEqual(h.calls, ['heard', 'interrupt conv-agent-child', 'rest conv-agent-child'])
})

test('a parent that merely finished its turn leaves its sub-agents working', async () => {
  const h = harness()
  h.lifecycle.onConversationEvent(event('turn_completed', parent))
  h.lifecycle.onConversationEvent(event('turn_failed', parent, { message: 'Overloaded.' }))
  await tick()
  assert.equal(h.agents[child.agentId]?.subagentEnd, undefined)
})

test('a parent removed from its workspace takes its sub-agents and their transcripts', async () => {
  const h = harness()
  delete h.agents[parent.agentId]
  h.lifecycle.onAgentsChanged(WORKSPACE)
  await tick()
  await tick()
  assert.deepEqual(h.calls, [
    'interrupt conv-agent-child',
    'rest conv-agent-child',
    'delete agent-child',
    'remove agent-child',
  ])
})

test('after a restart a sub-agent that was working reads stopped, and one that ended stays as it was', () => {
  const h = harness(
    {
      [parent.agentId]: chat(),
      [child.agentId]: chat({ subagentOf: { agentId: parent.agentId, startedAt: 1 } }),
      'agent-done': chat({
        subagentOf: { agentId: parent.agentId, startedAt: 1 },
        subagentEnd: { at: 50, status: 'completed' },
      }),
    },
    { session: () => undefined },
  )
  h.lifecycle.reconcile()
  assert.deepEqual(h.agents[child.agentId]?.subagentEnd, { at: 500, status: 'stopped' })
  assert.equal(h.agents['agent-done']?.subagentEnd?.status, 'completed')
})

test('a stop on one that ended, or that is already at rest, interrupts nothing', async () => {
  const ended = harness({
    [child.agentId]: chat({
      subagentOf: { agentId: parent.agentId, startedAt: 1 },
      subagentEnd: { at: 50, status: 'completed' },
    }),
  })
  await ended.lifecycle.stop(child)
  assert.deepEqual(ended.calls, [])
  assert.equal(ended.agents[child.agentId]?.subagentEnd?.status, 'completed')

  const resting = harness(undefined, {
    session: () => ({ sessionId: 'conv-agent-child', status: 'ready' }) as ConversationSessionSummary,
  })
  await resting.lifecycle.stop(child)
  assert.deepEqual(resting.calls, ['rest conv-agent-child'])
})

test('a first message that never went fails the sub-agent, in its own words', () => {
  const h = harness()
  h.lifecycle.fail(child, 'The first message was refused.')
  assert.deepEqual(h.agents[child.agentId]?.subagentEnd, {
    at: 500,
    status: 'failed',
    error: 'The first message was refused.',
  })
})

// As a sub-agent's transcript holds a turn: the task is Studio's message.
function textTurn(turnId: string, text: string, at: number): ConversationEvent[] {
  const entry = (type: ConversationEvent['type'], seq: number, payload: Record<string, unknown>) =>
    ({
      id: `${turnId}-${seq}`,
      seq: at + seq,
      createdAt: at + seq,
      sessionId: 'conv',
      ...child,
      type,
      payload,
    }) as ConversationEvent
  return [
    entry('user_message', 0, { turnId, text: 'Go', origin: { kind: 'studio', reason: 'subagent-task' } }),
    entry('turn_started', 1, { turnId }),
    entry('content_delta', 2, { turnId, text }),
    entry('turn_completed', 3, { turnId }),
  ]
}

test('the result is the last thing the agent said in its task, whatever came after', async () => {
  const agents = {
    [child.agentId]: chat({
      subagentOf: { agentId: parent.agentId, startedAt: 1 },
      subagentEnd: { at: 20, status: 'completed' },
    }),
  }
  const h = harness(agents, {
    readEvents: async () => [...textTurn('t1', 'Verdict: ship it.', 10), ...textTurn('t2', 'A later answer.', 30)],
  })
  assert.deepEqual(await h.lifecycle.result(child), { text: 'Verdict: ship it.', truncated: false })
})

test('a long result is cut from its start, so the verdict survives', async () => {
  const verdict = 'Verdict: ship it.'
  const long = `${'word '.repeat(6_000)}\n\n${verdict}`
  const h = harness(undefined, { readEvents: async () => textTurn('t1', long, 10) })
  const result = await h.lifecycle.result(child)
  assert.equal(result?.truncated, true)
  assert.ok(result!.text.endsWith(verdict))
  assert.ok(result!.text.length <= SUBAGENT_RESULT_MAX_CHARS)
})

test("with the runtime: a mock sub-agent's turn ends it, leaves it at rest, and its reply is the result", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'subagent-lifecycle-'))
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const agents: Record<string, AgentState> = {
    [parent.agentId]: chat(),
    [child.agentId]: chat({ subagentOf: { agentId: parent.agentId, startedAt: 1 } }),
  }
  const lifecycle = createSubagentLifecycle({
    agentsOf: () => agents,
    workspaceIds: () => [WORKSPACE],
    writeEnd: ({ agentId }, end) => {
      agents[agentId] = { ...agents[agentId]!, subagentEnd: end }
    },
    removeAgent: () => undefined,
    session: (key) => {
      const listed = runtime.listSessions(key)
      return listed.ok ? listed.sessions[0] : undefined
    },
    interrupt: (sessionId) => runtime.interrupt({ sessionId }),
    rest: (sessionId) => runtime.suspendSession({ sessionId }),
    readEvents: async (key, turns) => {
      const read = await runtime.readConversationSync({ ...key, workspaceRoot }, { turnLimit: turns })
      if (!read.ok) return []
      return read.kind === 'snapshot' ? read.page.events : read.events
    },
    deleteTranscript: async () => undefined,
  })
  runtime.onEvent((conversationEvent) => lifecycle.onConversationEvent(conversationEvent))
  let idle = false
  runtime.onSessionIdle((summary) => {
    lifecycle.onSessionIdle(summary)
    idle = true
  })
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      ...child,
      providerId: adapter.id,
      modelId: adapter.listModels()[0]!,
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'Say something' })
    for (let wait = 0; wait < 1_000 && !idle; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await tick()
    assert.equal(agents[child.agentId]?.subagentEnd?.status, 'completed')
    const result = await lifecycle.result(child)
    assert.ok(result?.text.trim(), 'the reply is read back from the transcript')
    const listed = runtime.listSessions(child)
    assert.equal(listed.ok && listed.sessions[0]?.resting, true)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
