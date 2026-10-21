import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// A chat whose first message leaves a background agent running in its Claude
// Code child, then changes a setting on the next one. The agent lives in the
// child, so a setting that replaced the child would end it.

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Look into the flaky test with a background agent',
}

type Options = {
  // How the child answers a live effort change: takes it, refuses it, or has
  // no such request (a Claude Code older than it).
  effort?: 'applies' | 'refuses' | 'absent'
  // How the child answers a live permission-mode change: refuses-once turns
  // the first request down and takes the rest.
  modes?: 'applies' | 'refuses' | 'refuses-once'
}

function harness(options: Options = {}) {
  const spawned: Array<Record<string, unknown>> = []
  const effortCalls: unknown[] = []
  const modeCalls: string[] = []
  const sent: string[] = []
  let finishAgent = (): void => undefined
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    spawned.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    const push = (...messages: Record<string, unknown>[]) => {
      pending.push(...messages)
      wake?.()
    }
    let first = true
    void (async () => {
      for await (const message of params.prompt) {
        const content = (message.message as { content?: unknown })?.content
        sent.push(typeof content === 'string' ? content : JSON.stringify(content))
        if (first && spawned.length === 1) {
          first = false
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
              is_backgrounded: true,
              description: 'Find the flaky test',
            },
          )
        }
        push({ type: 'result', subtype: 'success', is_error: false, result: 'On it.', session_id: 'sess_1' })
      }
    })()
    finishAgent = () =>
      push({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        status: 'completed',
      })
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => undefined,
      setPermissionMode: async (mode: string) => {
        modeCalls.push(mode)
        if (options.modes === 'refuses' || (options.modes === 'refuses-once' && modeCalls.length === 1))
          throw new Error('Unsupported control request')
      },
      stopTask: async () => undefined,
      ...(options.effort === 'absent'
        ? {}
        : {
            applyFlagSettings: async (settings: Record<string, unknown>) => {
              effortCalls.push(settings.effortLevel)
              if (options.effort === 'refuses') throw new Error('Unsupported control request')
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
  const run = async (input: Partial<MockAdapterTurnInput>): Promise<ConversationEvent[]> => {
    const events: ConversationEvent[] = []
    for await (const event of (await adapter.sendTurn({ ...TURN, ...input })) as AsyncIterable<ConversationEvent>)
      events.push(event)
    return events
  }
  const stoppedAgents = (events: ConversationEvent[]) =>
    events.filter((event) => event.type === 'subagent_status' && event.payload?.status === 'stopped')
  const notices = (events: ConversationEvent[]) =>
    events
      .filter((event) => event.type === 'session_updated' && typeof event.payload?.notice === 'string')
      .map((event) => event.payload!.notice as string)
  return {
    adapter,
    spawned,
    effortCalls,
    modeCalls,
    sent,
    run,
    stoppedAgents,
    notices,
    finishAgent: () => finishAgent(),
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('a new effort goes to the running child, and the background agent goes on', async () => {
  const chat = harness({ effort: 'applies' })
  await chat.adapter.startSession(TURN)
  await chat.run({})
  const second = await chat.run({ turnId: 'turn_2', reasoningEffort: 'high' })
  expect(chat.effortCalls).toEqual(['high'])
  expect(chat.spawned).toHaveLength(1)
  expect(chat.stoppedAgents(second)).toEqual([])
  expect(chat.notices(second)).toEqual([])
  // Applied, it is not asked again.
  await chat.run({ turnId: 'turn_3', reasoningEffort: 'high' })
  expect(chat.effortCalls).toEqual(['high'])
  await chat.adapter.disposeAll()
})

test('an effort the child will not take waits for the background agent, said once, then respawns it', async () => {
  const chat = harness({ effort: 'refuses' })
  await chat.adapter.startSession(TURN)
  await chat.run({})
  const second = await chat.run({ turnId: 'turn_2', reasoningEffort: 'high' })
  expect(chat.spawned).toHaveLength(1)
  expect(chat.stoppedAgents(second)).toEqual([])
  expect(chat.notices(second)).toEqual([
    'The new effort will apply to your messages once the background work in this chat finishes.',
  ])

  chat.finishAgent()
  await settle()
  const third = await chat.run({ turnId: 'turn_3', reasoningEffort: 'high' })
  expect(chat.spawned).toHaveLength(2)
  expect(chat.spawned[1]?.effort).toBe('high')
  expect(chat.notices(third)).toEqual([])
  await chat.adapter.disposeAll()
})

test('a Claude Code with no live effort change still respawns at once when nothing runs in the background', async () => {
  const chat = harness({ effort: 'absent' })
  await chat.adapter.startSession(TURN)
  await chat.run({})
  chat.finishAgent()
  await settle()
  await chat.run({ turnId: 'turn_2', reasoningEffort: 'low' })
  expect(chat.spawned).toHaveLength(2)
  expect(chat.spawned[1]?.effort).toBe('low')
  await chat.adapter.disposeAll()
})

test('back to default from plan waits for the background agent when the child cannot switch live', async () => {
  // Under `none` default mode is the CLI's own, which no live request names.
  const chat = harness()
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'none' })
  await chat.run({ mode: 'plan' })
  const second = await chat.run({ turnId: 'turn_2', mode: 'default' })
  expect(chat.spawned).toHaveLength(1)
  expect(chat.stoppedAgents(second)).toEqual([])
  expect(chat.notices(second)).toEqual([
    'Default mode will apply to your messages once the background work in this chat finishes.',
  ])
  await chat.adapter.disposeAll()
})

test('a preset changed while an agent works moves the child live on the next message instead of replacing it', async () => {
  const chat = harness({ modes: 'refuses-once' })
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'auto' })
  await chat.run({})
  // The switch the preset change asks for is refused, so the child runs on a
  // mode nobody vouches for until the next message.
  await chat.adapter.setPermissionPreset({ ...TURN, permissionPreset: 'manual' })
  const second = await chat.run({ turnId: 'turn_2' })
  expect(chat.modeCalls).toEqual(['default', 'default'])
  expect(chat.spawned).toHaveLength(1)
  expect(chat.stoppedAgents(second)).toEqual([])
  await chat.adapter.disposeAll()
})

test('a preset the busy child will not take still replaces it: permissions come before the agent', async () => {
  const chat = harness({ modes: 'refuses' })
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'auto' })
  await chat.run({})
  await chat.adapter.setPermissionPreset({ ...TURN, permissionPreset: 'manual' })
  const second = await chat.run({ turnId: 'turn_2' })
  expect(chat.spawned).toHaveLength(2)
  expect(chat.spawned[1]?.permissionMode).toBe('default')
  expect(chat.stoppedAgents(second)).toHaveLength(1)
  await chat.adapter.disposeAll()
})

test('skills attached while an agent works wait for it, and the message does not name them yet', async () => {
  const chat = harness()
  await chat.adapter.startSession(TURN)
  await chat.run({})
  const second = await chat.run({ turnId: 'turn_2', skills: ['release-notes'], message: 'Write the notes' })
  expect(chat.spawned).toHaveLength(1)
  expect(chat.stoppedAgents(second)).toEqual([])
  expect(chat.notices(second)).toEqual([
    'The attached skills will apply to your messages once the background work in this chat finishes.',
  ])
  expect(chat.sent.at(-1)).not.toContain('Use the attached skills')
  await chat.adapter.disposeAll()
})
