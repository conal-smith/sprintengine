import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { UsageLimitHit } from '../../shared/usage-limits'
import { useClaudeUsageLimitPrefixes } from '../usage-limits/sources'
import { onUsageLimitHit, usageLimitsStore, usageRateLimit } from '../usage-limits/store'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider, mapSdkMessage } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// The subscription's limits as a Claude chat reports them: the SDK's
// `rate_limit_event`s carry the windows, the init's key source and the
// session's account say whether there is a subscription at all, and a turn
// whose result says it ended on a limit is a limit hit. The store is the app's
// one; each test starts from a clean provider by billing it to an API key,
// which forgets its windows.

// The fallback for a CLI that sends no terminal reason reads the SDK's list,
// which a chat takes when it loads the SDK.
useClaudeUsageLimitPrefixes(USAGE_LIMIT_ERROR_PREFIXES)

// Epoch seconds, as the SDK sends them.
const RESET_S = Math.floor(Date.now() / 1000) + 3 * 60 * 60

function mapperState() {
  return {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: 'native' as string | null,
    turn: { turnId: 'turn_1' } as { turnId: string } | null,
    queryCostUsd: 0,
  }
}

const init = (apiKeySource: string) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'native',
  apiKeySource,
  model: 'claude-sonnet-5',
  cwd: '/Users/dev/app',
  tools: [],
  mcp_servers: [],
  claude_code_version: '2.1.291',
})

// Shaped like the SDK's SDKRateLimitEvent.
const rateLimitEvent = (info: Record<string, unknown>) => ({
  type: 'rate_limit_event',
  rate_limit_info: info,
  uuid: '7c1e4b5a-2f0d-4c8e-9a61-1d2b3c4d5e6f',
  session_id: 'native',
})

const failedResult = (result: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result,
  duration_ms: 900,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  session_id: 'native',
})

// A session whose init named no key, and whose account (`reportAccount`)
// said it is signed in to a plan.
function subscribed(state: ReturnType<typeof mapperState> & { usageBilling?: 'subscription' | 'api' | null }) {
  mapSdkMessage(state, init('none'))
  state.usageBilling = 'subscription'
  usageLimitsStore().noteBilling('claude', 'subscription', 'max')
  return state
}

const claudeSnapshot = () =>
  usageLimitsStore()
    .state()
    .snapshots.find((snapshot) => snapshot.provider === 'claude')

let stopHits: (() => void) | null = null
afterEach(() => {
  stopHits?.()
  stopHits = null
  usageLimitsStore().noteBilling('claude', 'api')
})

function collectHits(): UsageLimitHit[] {
  const hits: UsageLimitHit[] = []
  stopHits = onUsageLimitHit((hit) => hits.push(hit))
  return hits
}

test('a subscription session reads its windows off rate_limit_events, and none of them reach the transcript', () => {
  const state = mapperState()
  mapSdkMessage(state, init('none'))
  const events = mapSdkMessage(
    state,
    rateLimitEvent({ status: 'allowed', resetsAt: RESET_S, rateLimitType: 'five_hour', utilization: 0.42 }),
  )
  expect(events).toEqual([])
  mapSdkMessage(
    state,
    rateLimitEvent({
      status: 'allowed_warning',
      resetsAt: RESET_S + 86_400,
      rateLimitType: 'seven_day',
      utilization: 0.91,
    }),
  )
  expect(claudeSnapshot()?.windows.map((window) => [window.id, window.usedPercent, window.status])).toEqual([
    ['five_hour', 42, 'allowed'],
    ['seven_day', 91, 'warning'],
  ])
  expect(claudeSnapshot()?.windows[0].resetsAt).toBe(RESET_S * 1000)
})

test('an API-key session shows no limits, whatever events it sees', () => {
  const state = mapperState()
  mapSdkMessage(state, init('ANTHROPIC_API_KEY'))
  mapSdkMessage(
    state,
    rateLimitEvent({ status: 'allowed', resetsAt: RESET_S, rateLimitType: 'five_hour', utilization: 0.42 }),
  )
  expect(claudeSnapshot()).toBeUndefined()
  // Nor is a failed turn on it a plan's limit.
  const hits = collectHits()
  mapSdkMessage(state, failedResult("You've hit your limit · resets 3pm"))
  expect(hits).toEqual([])
})

test('a turn that ends after a rejected event is a limit hit, with the window and when it resets', () => {
  const hits = collectHits()
  const state = mapperState()
  subscribed(state)
  mapSdkMessage(
    state,
    rateLimitEvent({
      status: 'rejected',
      resetsAt: RESET_S,
      rateLimitType: 'five_hour',
      utilization: 1,
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
    }),
  )
  const events = mapSdkMessage(state, failedResult("You've hit your limit · resets 3pm"))
  expect(events.at(-1)?.type).toBe('turn_failed')
  expect(hits).toEqual([
    {
      provider: 'claude',
      sessionId: 'conv_1',
      resetsAt: RESET_S * 1000,
      windowId: 'five_hour',
      at: expect.any(Number),
    },
  ])
  expect(usageRateLimit('claude')).toEqual({ limited: true, resetsAt: RESET_S * 1000, windowId: 'five_hour' })
  // The refusal belonged to that turn; the next failure is judged on its own.
  mapSdkMessage(state, failedResult('API Error: 500'))
  expect(hits).toHaveLength(1)
})

test('a turn the CLI ends with its usage-limit message or its rate_limit error is a hit without a window', () => {
  const hits = collectHits()
  const state = mapperState()
  subscribed(state)
  mapSdkMessage(state, failedResult("You've reached your weekly limit"))
  mapSdkMessage(state, {
    type: 'assistant',
    error: 'rate_limit',
    parent_tool_use_id: null,
    uuid: '0b7d2f1e-5a4c-4d3b-8e2f-6a7b8c9d0e1f',
    session_id: 'native',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }], stop_reason: null },
  })
  mapSdkMessage(state, failedResult('Request failed'))
  expect(hits.map((hit) => [hit.provider, hit.windowId, hit.resetsAt])).toEqual([
    ['claude', null, null],
    ['claude', null, null],
  ])
})

test('an event that lets a kind of limit through again clears that kind’s refusal and no other', () => {
  const hits = collectHits()
  const state = mapperState()
  subscribed(state)
  mapSdkMessage(state, rateLimitEvent({ status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour' }))
  mapSdkMessage(state, rateLimitEvent({ status: 'allowed', resetsAt: RESET_S + 18_000, rateLimitType: 'five_hour' }))
  mapSdkMessage(state, failedResult('API Error: 500'))
  expect(hits).toEqual([])

  // The weekly going through says nothing about the session window that refused.
  mapSdkMessage(state, rateLimitEvent({ status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour' }))
  mapSdkMessage(
    state,
    rateLimitEvent({ status: 'allowed_warning', resetsAt: RESET_S + 86_400, rateLimitType: 'seven_day' }),
  )
  mapSdkMessage(state, failedResult('Request failed'))
  expect(hits.map((hit) => [hit.windowId, hit.resetsAt])).toEqual([['five_hour', RESET_S * 1000]])
})

test('a result that says it ended on a limit is a hit with no event before it; a failed sign-in never is', () => {
  const hits = collectHits()
  const state = mapperState()
  subscribed(state)
  mapSdkMessage(state, { ...failedResult("You've hit your limit · resets 3pm"), terminal_reason: 'blocking_limit' })
  mapSdkMessage(state, { ...failedResult('Rate limited'), terminal_reason: 'api_error', api_error_status: 429 })
  expect(hits.map((hit) => [hit.windowId, hit.resetsAt])).toEqual([
    [null, null],
    [null, null],
  ])
  mapSdkMessage(state, { ...failedResult('Overloaded'), terminal_reason: 'api_error', api_error_status: 529 })
  expect(hits).toHaveLength(2)

  // An exchange whose sign-in failed, even with a rate_limit error beside it.
  mapSdkMessage(state, {
    type: 'assistant',
    error: 'authentication_failed',
    parent_tool_use_id: null,
    uuid: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    session_id: 'native',
    message: { id: 'msg_2', role: 'assistant', content: [], stop_reason: null },
  })
  mapSdkMessage(state, { ...failedResult('Not logged in'), terminal_reason: 'blocking_limit' })
  expect(hits).toHaveLength(2)
})

test('a chat whose context window filled is not a usage limit, and its provider is not limited', () => {
  const hits = collectHits()
  const state = mapperState()
  subscribed(state)
  mapSdkMessage(state, rateLimitEvent({ status: 'allowed', resetsAt: RESET_S, rateLimitType: 'five_hour' }))
  mapSdkMessage(state, { ...failedResult('Prompt is too long'), terminal_reason: 'blocking_limit' })
  expect(hits).toHaveLength(0)
})

// The session's account, as its initialize answers it, decides whether there
// is a plan: a cloud provider's session forgets what a subscription reported.
function accountHarness(account: Record<string, unknown>) {
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
      initializationResult: async () => ({ commands: [], agents: [], models: [], account }),
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
  })
  const turn: MockAdapterTurnInput = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'hello',
  }
  return {
    adapter,
    async firstTurn() {
      await adapter.startSession(turn)
      for await (const _event of (await adapter.sendTurn(turn)) as AsyncIterable<ConversationEvent>) {
        // drained
      }
      // The account is read beside the turn, not ahead of it.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

test('a session on a cloud provider bills no plan, and the subscription reading is forgotten', async () => {
  usageLimitsStore().noteWindows('claude', [{ id: 'five_hour', usedPercent: 40, status: 'allowed' }])
  expect(claudeSnapshot()).toBeDefined()
  const bedrock = accountHarness({ apiProvider: 'bedrock' })
  await bedrock.firstTurn()
  expect(claudeSnapshot()).toBeUndefined()
  expect(usageRateLimit('claude').limited).toBe(false)
  await bedrock.adapter.disposeAll()

  const max = accountHarness({ apiProvider: 'firstParty', subscriptionType: 'max' })
  await max.firstTurn()
  usageLimitsStore().noteWindows('claude', [{ id: 'five_hour', usedPercent: 40, status: 'allowed' }])
  expect(claudeSnapshot()).toMatchObject({ billing: 'subscription', plan: 'max' })
  await max.adapter.disposeAll()
})
