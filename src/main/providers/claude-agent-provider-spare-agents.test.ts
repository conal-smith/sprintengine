import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// An agent is stopped by its own Stop and by nothing else. The turn's Stop and
// a steer each move the agents the turn is waiting on to the background
// first (`backgroundTasks`, by the call that spawned each), and the session
// declares `perTaskStopAffordance`, so the child's interrupt spares the
// background agents and aborts the turn alone.

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Restyle the design system with an agent',
}

type BackgroundAnswer = 'moves' | 'declines' | 'refuses' | 'never' | 'absent'

function harness(options: { agent?: 'foreground' | 'background'; background?: BackgroundAnswer } = {}) {
  const calls: string[] = []
  const prompts: string[] = []
  const queryOptions: Record<string, unknown>[] = []
  const answer = options.background ?? 'moves'
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    queryOptions.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    const push = (...messages: Record<string, unknown>[]) => {
      pending.push(...messages)
      wake?.()
    }
    void (async () => {
      for await (const message of params.prompt) {
        const content = (message.message as { content: unknown }).content
        prompts.push(typeof content === 'string' ? content : JSON.stringify(content))
        if (prompts.length > 1) continue
        push(
          {
            type: 'assistant',
            parent_tool_use_id: null,
            uuid: 'a-1',
            message: {
              content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'general' } }],
            },
          },
          {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task_1',
            tool_use_id: 'toolu_agent',
            task_type: 'local_agent',
            subagent_type: 'general',
            description: 'Restyle the boxes',
            ...(options.agent === 'background' ? { is_backgrounded: true } : {}),
          },
        )
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async (input?: { cancelQueued?: boolean }) => {
        calls.push(`interrupt${input?.cancelQueued ? ':cancelQueued' : ''}`)
      },
      setPermissionMode: async () => undefined,
      stopTask: async (taskId: string) => {
        calls.push(`stopTask:${taskId}`)
      },
      ...(answer === 'absent'
        ? {}
        : {
            backgroundTasks: (toolUseId?: string) => {
              calls.push(`background:${toolUseId}`)
              if (answer === 'never') return new Promise<boolean>(() => undefined)
              if (answer === 'refuses') return Promise.reject(new Error('Background tasks are disabled'))
              if (answer === 'declines') return Promise.resolve(false)
              // The child's own word that it moved, which arrives after its answer.
              setTimeout(
                () =>
                  push({
                    type: 'system',
                    subtype: 'task_updated',
                    task_id: 'task_1',
                    patch: { is_backgrounded: true },
                  }),
                5,
              )
              return Promise.resolve(true)
            },
          }),
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 20,
  })
  return { adapter, calls, prompts, queryOptions }
}

/** Starts the turn and reads it until the agent is running; the rest of its stream is returned. */
async function runningAgent(h: ReturnType<typeof harness>) {
  const sessionEvents: ConversationEvent[] = []
  await h.adapter.startSession({ ...TURN, onSessionEvent: (event) => sessionEvents.push(event) })
  const stream = (await h.adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>
  const iterator = stream[Symbol.asyncIterator]()
  const turnEvents: ConversationEvent[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    turnEvents.push(next.value)
    if (next.value.type === 'subagent_status' && next.value.payload?.status === 'running') break
  }
  const rest = (async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      turnEvents.push(next.value)
    }
  })()
  return { sessionEvents, turnEvents, rest }
}

const laneUpdates = (events: ConversationEvent[]) =>
  events
    .filter((event) => event.type === 'subagent_status')
    .map((event) => `${event.payload?.status}${event.payload?.background ? ':background' : ''}`)

test('every Claude Code child is told each agent has a Stop of its own, so an interrupt spares them', async () => {
  const h = harness()
  await runningAgent(h)
  expect(h.queryOptions[0]?.perTaskStopAffordance).toBe(true)
  await h.adapter.disposeAll()
})

test('Stop moves the agent the turn waits on to the background before the interrupt, and the turn ends after it', async () => {
  const h = harness()
  const { sessionEvents, rest } = await runningAgent(h)
  const ended = (await h.adapter.interrupt(TURN)) as ConversationEvent[]
  expect(h.calls).toEqual(['background:toolu_agent', 'interrupt:cancelQueued'])
  // The lane hears the agent went to the background before the turn's end
  // is returned, so the end finds it running and leaves its row open.
  expect(laneUpdates(sessionEvents)).toEqual(['running:background'])
  expect(ended.map((event) => event.type)).toEqual(['turn_failed'])
  expect(ended[0]?.payload?.reason).toBe('interrupted')
  await rest
  // The child's own word that it moved says nothing new.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(laneUpdates(sessionEvents)).toEqual(['running:background'])
  // Nothing stopped the agent.
  expect(h.calls.filter((call) => call.startsWith('stopTask'))).toEqual([])
  // Its own Stop still reaches it, between turns.
  expect(await h.adapter.stopSubagent('conv_1', 'toolu_agent')).toBe(true)
  expect(h.calls.at(-1)).toBe('stopTask:task_1')
  await h.adapter.disposeAll()
})

test('an agent already in the background is not moved again; Stop only interrupts', async () => {
  const h = harness({ agent: 'background' })
  const { rest } = await runningAgent(h)
  await h.adapter.interrupt(TURN)
  expect(h.calls).toEqual(['interrupt:cancelQueued'])
  await rest
  await h.adapter.disposeAll()
})

for (const background of ['declines', 'refuses', 'never', 'absent'] as const) {
  test(`a child that ${background === 'absent' ? 'cannot move agents' : `${background} the move`} is still stopped, and the agent is left where it was`, async () => {
    const h = harness({ background })
    const { sessionEvents, rest } = await runningAgent(h)
    const ended = (await h.adapter.interrupt(TURN)) as ConversationEvent[]
    expect(h.calls.at(-1)).toBe('interrupt:cancelQueued')
    expect(ended.map((event) => event.type)).toEqual(['turn_failed'])
    expect(laneUpdates(sessionEvents)).toEqual([])
    await rest
    await h.adapter.disposeAll()
  })
}

test('a steer moves the agent the turn waits on to the background before the child is handed the message', async () => {
  const h = harness()
  const { turnEvents, rest } = await runningAgent(h)
  const steered = await h.adapter.steer({ ...TURN, message: 'Keep the print styles square' })
  expect(steered.ok).toBe(true)
  expect(h.calls).toEqual(['background:toolu_agent'])
  expect(h.prompts.at(-1)).toContain('Keep the print styles square')
  expect(laneUpdates(turnEvents)).toEqual(['running', 'running:background'])
  // Twice in a row, the agent is moved once.
  expect((await h.adapter.steer({ ...TURN, message: 'And the dock' })).ok).toBe(true)
  expect(h.calls).toEqual(['background:toolu_agent'])
  await h.adapter.interrupt(TURN)
  await rest
  await h.adapter.disposeAll()
})

test('a steer whose turn ends while the agents move is refused rather than starting a turn of its own', async () => {
  const h = harness({ background: 'never' })
  const { rest } = await runningAgent(h)
  const steering = h.adapter.steer({ ...TURN, message: 'Keep the print styles square' })
  void h.adapter.interrupt(TURN)
  const steered = await steering
  expect(steered.ok).toBe(false)
  expect(h.prompts).toHaveLength(1)
  await rest
  await h.adapter.disposeAll()
})
