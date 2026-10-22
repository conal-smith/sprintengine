import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// Claude Code's own settings can turn bypass off
// (`permissions.disableBypassPermissionsMode: "disable"`). A child asked for
// bypass then starts in a mode that asks, names it in its init, and sends its
// asks to canUseTool: they have to reach the person, not be answered as
// bypass would have.

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Tidy the parser',
}

type CanUseTool = (name: string, input: Record<string, unknown>, options: object) => Promise<{ behavior: string }>

function harness(initMode: string) {
  const decisions: string[] = []
  let spawned = 0
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    spawned += 1
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    const emit = (...messages: Record<string, unknown>[]) => {
      pending.push(...messages)
      wake?.()
    }
    const canUseTool = params.options.canUseTool as CanUseTool
    void (async () => {
      for await (const _message of params.prompt) {
        emit({ type: 'system', subtype: 'init', session_id: 'sess_1', permissionMode: initMode })
        // The CLI asks once the chat has read its init.
        setTimeout(() => {
          void canUseTool('Bash', { command: 'rm -rf build' }, {}).then((decision) => {
            decisions.push(decision.behavior)
            emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess_1' })
          })
        }, 5)
      }
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
    const turnInput = { ...TURN, ...input }
    for await (const event of (await adapter.sendTurn(turnInput)) as AsyncIterable<ConversationEvent>) {
      events.push(event)
      if (event.type === 'approval_requested')
        void adapter.resolveApproval({ ...turnInput, requestId: String(event.payload?.requestId), approved: false })
    }
    return events
  }
  return { adapter, decisions, run, spawned: () => spawned }
}

const approvals = (events: ConversationEvent[]) => events.filter((event) => event.type === 'approval_requested')
const notes = (events: ConversationEvent[]) =>
  events.filter((event) => event.type === 'command_output' && event.payload?.adapterNote === true)

test('a bypass the CLI refused at spawn sends its asks to the person, marked as needing an answer', async () => {
  const chat = harness('default')
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'bypass' })
  const events = await chat.run({})
  const asked = approvals(events)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.payload?.mustAsk).toBe(true)
  expect(chat.decisions).toEqual(['deny'])
  await chat.adapter.disposeAll()
})

test('a bypass the CLI refused is said once, and the child is kept for the next message', async () => {
  const chat = harness('default')
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'bypass' })
  const first = await chat.run({})
  expect(notes(first).map((event) => event.payload?.output)).toEqual([
    'Claude Code’s settings turn off bypass permissions here, so actions will ask for approval.',
  ])
  const second = await chat.run({ turnId: 'turn_2', requestId: 'approval_2' })
  expect(notes(second)).toEqual([])
  expect(approvals(second)[0]?.payload?.mustAsk).toBe(true)
  expect(chat.spawned()).toBe(1)
  await chat.adapter.disposeAll()
})

test('a bypass the CLI took still answers its asks without a card', async () => {
  const chat = harness('bypassPermissions')
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'bypass' })
  const events = await chat.run({})
  expect(approvals(events)).toEqual([])
  expect(notes(events)).toEqual([])
  expect(chat.decisions).toEqual(['allow'])
  await chat.adapter.disposeAll()
})
