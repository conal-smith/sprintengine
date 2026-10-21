import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider, mapSdkMessage } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// Claude can enter plan mode on its own (its EnterPlanMode tool), and says so
// in the `permissionMode` of its status messages. A chat that never chose plan
// mode must not stay in it.

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
type Script = (turn: number, emit: (...messages: Record<string, unknown>[]) => void, canUseTool: CanUseTool) => void

function harness(script: Script) {
  const log: string[] = []
  let spawned = 0
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    spawned += 1
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    const emit = (...messages: Record<string, unknown>[]) => {
      pending.push(...messages)
      wake?.()
    }
    let turn = 0
    void (async () => {
      for await (const _message of params.prompt) {
        turn += 1
        log.push(`message ${turn}`)
        script(turn, emit, params.options.canUseTool as CanUseTool)
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
      setPermissionMode: async (mode: string) => {
        log.push(`mode ${mode}`)
      },
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 20,
  })
  const run = async (input: Partial<MockAdapterTurnInput>, approve?: boolean): Promise<ConversationEvent[]> => {
    const events: ConversationEvent[] = []
    const turnInput = { ...TURN, ...input }
    for await (const event of (await adapter.sendTurn(turnInput)) as AsyncIterable<ConversationEvent>) {
      events.push(event)
      if (event.type === 'approval_requested' && approve !== undefined)
        void adapter.resolveApproval({
          ...turnInput,
          requestId: String(event.payload?.requestId),
          approved: approve,
        })
    }
    return events
  }
  return { adapter, log, run, spawned: () => spawned }
}

const init = (permissionMode: string) => ({ type: 'system', subtype: 'init', session_id: 'sess_1', permissionMode })
const status = (permissionMode: string) => ({ type: 'system', subtype: 'status', status: null, permissionMode })
const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess_1' }

test('the mode a child reports in its init and its status messages is kept', () => {
  const state = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: null as string | null,
    turn: { turnId: 'turn_1' },
    cliMode: null as string | null | undefined,
    cliSpawnMode: null as string | null | undefined,
  }
  mapSdkMessage(state, init('auto'), { saveToolImages: false })
  expect([state.cliMode, state.cliSpawnMode]).toEqual(['auto', 'auto'])
  mapSdkMessage(state, status('plan'), { saveToolImages: false })
  expect([state.cliMode, state.cliSpawnMode]).toEqual(['plan', 'auto'])
  // A status without a mode (a compaction's) leaves it as it was.
  mapSdkMessage(state, { type: 'system', subtype: 'status', status: 'compacting' }, { saveToolImages: false })
  expect(state.cliMode).toBe('plan')
  mapSdkMessage(state, init('plan'), { saveToolImages: false })
  expect(state.cliSpawnMode).toBe('auto')
})

test('a plan mode Claude entered on its own is left before the next message reaches the child', async () => {
  const chat = harness((turn, emit) => {
    if (turn === 1) emit(init('auto'), status('plan'), result)
    else emit(init('auto'), result)
  })
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'auto' })
  await chat.run({})
  await chat.run({ turnId: 'turn_2' })
  expect(chat.log).toEqual(['message 1', 'mode auto', 'message 2'])
  expect(chat.spawned()).toBe(1)
  await chat.adapter.disposeAll()
})

test('approving a plan Claude entered on its own leaves plan mode', async () => {
  const decisions: string[] = []
  const chat = harness((turn, emit, canUseTool) => {
    if (turn > 1) return emit(init('default'), result)
    emit(init('default'), status('plan'))
    // The CLI asks once the chat has read where it stands.
    setTimeout(() => {
      void canUseTool('ExitPlanMode', { plan: '## Plan\n1. Tidy it' }, {}).then((decision) => {
        decisions.push(decision.behavior)
        emit(result)
      })
    }, 5)
  })
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'manual' })
  const events = await chat.run({}, true)
  expect(events.some((event) => event.type === 'approval_resolved' && event.payload?.approved === true)).toBe(true)
  expect(decisions).toEqual(['allow'])
  expect(chat.log).toEqual(['message 1', 'mode default'])
  // Left already: the next message goes straight in.
  await chat.run({ turnId: 'turn_2', requestId: 'approval_2' })
  expect(chat.log).toEqual(['message 1', 'mode default', 'message 2'])
  await chat.adapter.disposeAll()
})

test('a chat whose own default is plan mode is left in it', async () => {
  // Under "Your rules" the child starts in the person's configured mode.
  const chat = harness((_turn, emit) => emit(init('plan'), result))
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'none' })
  await chat.run({})
  await chat.run({ turnId: 'turn_2' })
  expect(chat.log).toEqual(['message 1', 'message 2'])
  await chat.adapter.disposeAll()
})

test('a chat in plan mode by choice is not taken out of it', async () => {
  const chat = harness((_turn, emit) => emit(init('plan'), result))
  await chat.adapter.startSession({ ...TURN, permissionPreset: 'auto' })
  await chat.run({ mode: 'plan' })
  await chat.run({ turnId: 'turn_2', mode: 'plan' })
  expect(chat.log).toEqual(['message 1', 'message 2'])
  await chat.adapter.disposeAll()
})
