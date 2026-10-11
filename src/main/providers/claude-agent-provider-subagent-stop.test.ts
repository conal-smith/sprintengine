import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// One agent stopped on its own, as Claude Code 2.1.294 does it: `stopTask`
// on the agent's task, a `task_notification` saying it stopped, the agent's
// call answered as interrupted, and the turn that spawned it carrying on.

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Look into the flaky test with an agent',
}

function harness(answer: 'stops' | 'never' = 'stops') {
  const stopped: string[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    const push = (...messages: Record<string, unknown>[]) => {
      pending.push(...messages)
      wake?.()
    }
    void (async () => {
      for await (const _message of params.prompt)
        push(
          {
            type: 'assistant',
            parent_tool_use_id: null,
            message: {
              content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'Explore' } }],
            },
          },
          {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task_1',
            tool_use_id: 'toolu_agent',
            task_type: 'local_agent',
            subagent_type: 'Explore',
            description: 'Find the flaky test',
          },
        )
    })()
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      stopTask: (taskId: string) => {
        stopped.push(taskId)
        if (answer === 'never') return new Promise<void>(() => undefined)
        push(
          {
            type: 'system',
            subtype: 'task_notification',
            task_id: taskId,
            tool_use_id: 'toolu_agent',
            status: 'stopped',
          },
          {
            type: 'user',
            parent_tool_use_id: null,
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_agent',
                  content: '[Request interrupted by user for tool use]',
                  is_error: true,
                },
              ],
            },
          },
          { type: 'result', subtype: 'success', is_error: false, result: 'The agent was stopped.', session_id: 'n' },
        )
        return Promise.resolve()
      },
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 20,
  })
  return { adapter, stopped }
}

test('a running Claude agent is stopped by its task, and the turn that spawned it carries on to its end', async () => {
  const { adapter, stopped } = harness()
  expect(adapter.capabilities?.stopSubagent).toBe(true)
  await adapter.startSession(TURN)
  const events: ConversationEvent[] = []
  const answers: boolean[] = []
  for await (const event of (await adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>) {
    events.push(event)
    if (event.type === 'subagent_status' && event.payload?.status === 'running')
      answers.push(await adapter.stopSubagent('conv_1', 'toolu_agent'))
  }
  expect(answers).toEqual([true])
  expect(stopped).toEqual(['task_1'])
  const lane = events.filter((event) => event.type === 'subagent_status').map((event) => event.payload?.status)
  expect(lane).toEqual(['running', 'stopped'])
  expect(events.at(-1)?.type).toBe('turn_completed')
  // Ended, the agent is not stopped twice.
  expect(await adapter.stopSubagent('conv_1', 'toolu_agent')).toBe(false)
  await adapter.disposeAll()
})

test('only an agent the chat has running is stopped', async () => {
  const { adapter, stopped } = harness()
  expect(await adapter.stopSubagent('conv_1', 'toolu_agent')).toBe(false)
  await adapter.startSession(TURN)
  // No child yet, so no agent either.
  expect(await adapter.stopSubagent('conv_1', 'toolu_agent')).toBe(false)
  for await (const event of (await adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>) {
    if (event.type !== 'subagent_status') continue
    expect(await adapter.stopSubagent('conv_1', 'toolu_other')).toBe(false)
    break
  }
  expect(stopped).toEqual([])
  await adapter.disposeAll()
})

test('a child that never answers the stop is not taken to have stopped the agent', async () => {
  const { adapter, stopped } = harness('never')
  await adapter.startSession(TURN)
  for await (const event of (await adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>) {
    if (event.type !== 'subagent_status') continue
    expect(await adapter.stopSubagent('conv_1', 'toolu_agent')).toBe(false)
    break
  }
  expect(stopped).toEqual(['task_1'])
  await adapter.disposeAll()
})
