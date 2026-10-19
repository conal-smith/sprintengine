import { expect, test } from 'vitest'

import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'

import {
  claudeBillingOf,
  claudeBillingOfAccount,
  claudeStatusLineUpdates,
  codexBillingOf,
  codexRateLimitUpdates,
  isClaudeUsageLimitMessage,
  isClaudeUsageLimitResult,
  isCodexUsageLimitError,
  readClaudeRateLimitInfo,
  useClaudeUsageLimitPrefixes,
} from './sources'

const HOUR = 60 * 60 * 1000
// Epoch seconds, as the CLIs send them.
const RESET_S = 1_791_370_800

test("a Claude rate_limit_event's info becomes its window: a fraction to a percent, seconds to ms", () => {
  // Shaped like the SDK's SDKRateLimitInfo on a subscription nearing its weekly cap.
  expect(
    readClaudeRateLimitInfo({
      status: 'allowed_warning',
      resetsAt: RESET_S,
      rateLimitType: 'seven_day',
      utilization: 0.82,
      surpassedThreshold: 0.75,
      isUsingOverage: false,
    }),
  ).toEqual({
    updates: [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 82,
        resetsAt: RESET_S * 1000,
        durationMs: 7 * 24 * HOUR,
        status: 'warning',
      },
    ],
    type: 'seven_day',
    rejected: null,
  })
  // A model's own weekly is a row of its own, scoped to that model.
  expect(
    readClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.1 })?.updates[0],
  ).toMatchObject({ id: 'seven_day_opus', label: 'Weekly · Opus', usedPercent: 10, status: 'allowed', scope: 'model' })
})

test('the weekly of the model extra usage covers is a model row, named by the session’s model', () => {
  const info = { status: 'allowed_warning', rateLimitType: 'seven_day_overage_included', utilization: 0.9 }
  expect(readClaudeRateLimitInfo(info, 'claude-fable-5')?.updates[0]).toMatchObject({
    id: 'seven_day_overage_included',
    label: 'Weekly · Fable',
    usedPercent: 90,
    durationMs: 7 * 24 * HOUR,
    scope: 'model',
    status: 'warning',
  })
  expect(readClaudeRateLimitInfo(info, 'default')?.updates[0]?.label).toBe('Weekly · Model')
  expect(readClaudeRateLimitInfo(info)?.updates[0]?.label).toBe('Weekly · Model')
})

test('a rejected Claude event is a refusal with its window and reset, unless extra usage carries the turn', () => {
  const refused = readClaudeRateLimitInfo({
    status: 'rejected',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    utilization: 1,
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
  })
  expect(refused?.rejected).toEqual({ windowId: 'five_hour', resetsAt: RESET_S * 1000 })
  expect(refused?.updates[0]).toMatchObject({ id: 'five_hour', usedPercent: 100, status: 'rejected' })
  const carried = readClaudeRateLimitInfo({
    status: 'rejected',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    utilization: 1,
    overageStatus: 'allowed',
    isUsingOverage: true,
  })
  expect(carried?.rejected).toBe(null)
  expect(carried?.updates[0]?.status).toBe('warning')
  // `overageInUse` says the same as `isUsingOverage`.
  const inUse = readClaudeRateLimitInfo({
    status: 'rejected',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    utilization: 1,
    overageInUse: true,
  })
  expect(inUse?.rejected).toBe(null)
  expect(inUse?.updates[0]?.status).toBe('warning')
})

test('every window an event carries is read, not only the one that limits now', () => {
  // A Max plan whose weekly is the fuller: the event is about the weekly, and
  // the session (5h) window's share rides only in `unifiedWindows`. It used
  // to be read as a reset with no share, "Within the limit" over an empty bar.
  const reading = readClaudeRateLimitInfo({
    status: 'allowed',
    resetsAt: RESET_S,
    rateLimitType: 'seven_day',
    utilization: 0.3,
    unifiedWindows: {
      five_hour: { utilization: 0.25, resetsAt: RESET_S - 3600 },
      seven_day: { utilization: 0.31, resetsAt: RESET_S },
      seven_day_overage_included: { utilization: 0.12, resetsAt: RESET_S },
    },
  })
  expect(reading?.updates).toEqual([
    {
      id: 'seven_day',
      label: 'Weekly',
      // The event's own fields stand for the window it is about.
      usedPercent: 30,
      resetsAt: RESET_S * 1000,
      durationMs: 7 * 24 * HOUR,
      status: 'allowed',
    },
    {
      id: 'five_hour',
      label: 'Session (5h)',
      usedPercent: 25,
      resetsAt: (RESET_S - 3600) * 1000,
      durationMs: 5 * HOUR,
      status: 'allowed',
    },
    {
      id: 'seven_day_overage_included',
      label: 'Weekly · Model',
      usedPercent: 12,
      resetsAt: RESET_S * 1000,
      durationMs: 7 * 24 * HOUR,
      scope: 'model',
      status: 'allowed',
    },
  ])
})

test('a window from `unifiedWindows` past its cap is carried while the event lets requests through', () => {
  const allowed = readClaudeRateLimitInfo({
    status: 'allowed_warning',
    rateLimitType: 'seven_day',
    utilization: 0.9,
    unifiedWindows: { five_hour: { utilization: 1.2, resetsAt: RESET_S } },
  })
  expect(allowed?.updates[1]).toMatchObject({ id: 'five_hour', usedPercent: 100, status: 'warning' })
  // Refused, the refusal is the event's window's; another window's share says
  // nothing either way, and the store reads it.
  const refused = readClaudeRateLimitInfo({
    status: 'rejected',
    rateLimitType: 'seven_day',
    utilization: 1,
    unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: RESET_S } },
  })
  expect(refused?.updates[1]).toMatchObject({ id: 'five_hour', usedPercent: 40 })
  expect(refused?.updates[1] && 'status' in refused.updates[1]).toBe(false)
  // An event whose own fields carry no share takes it from its window there.
  const bare = readClaudeRateLimitInfo({
    status: 'allowed',
    rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: RESET_S } },
  })
  expect(bare?.updates).toEqual([
    expect.objectContaining({ id: 'five_hour', usedPercent: 25, resetsAt: RESET_S * 1000 }),
  ])
  // A window it does not know, or a share that is not a number, is left out.
  const odd = readClaudeRateLimitInfo({
    status: 'allowed',
    unifiedWindows: { monthly: { utilization: 0.5, resetsAt: RESET_S }, five_hour: { utilization: 'half' } },
  })
  expect(odd?.updates).toEqual([])
})

test('a Claude event about a kind that is not a plan window moves no window, and junk is nothing', () => {
  expect(readClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'overage', utilization: 0.4 })).toEqual({
    updates: [],
    type: 'overage',
    rejected: null,
  })
  expect(readClaudeRateLimitInfo({ status: 'rejected' })?.rejected).toEqual({ windowId: null, resetsAt: null })
  expect(readClaudeRateLimitInfo({ status: 'maybe' })).toBe(null)
  expect(readClaudeRateLimitInfo(null)).toBe(null)
})

test("the status line's windows become updates that say how full, never whether refused", () => {
  expect(
    claudeStatusLineUpdates({
      five_hour: { usedPercentage: 23.5, resetsAt: RESET_S * 1000 },
      seven_day: { usedPercentage: 41 },
      spend_limit: { usedPercentage: 12 },
    }),
  ).toEqual([
    { id: 'five_hour', label: 'Session (5h)', usedPercent: 23.5, resetsAt: RESET_S * 1000, durationMs: 5 * HOUR },
    { id: 'seven_day', label: 'Weekly', usedPercent: 41, durationMs: 7 * 24 * HOUR },
  ])
  // Read as another process received it: anything that is not a reading is dropped.
  expect(claudeStatusLineUpdates({ five_hour: null, seven_day: 7 })).toEqual([])
  expect(claudeStatusLineUpdates('five_hour')).toEqual([])
})

test("Claude's init names an API key; `none` is not taken for a plan, since a cloud provider says it too", () => {
  expect(claudeBillingOf('none')).toBe(null)
  expect(claudeBillingOf('ANTHROPIC_API_KEY')).toBe('api')
  expect(claudeBillingOf('apiKeyHelper')).toBe('api')
  expect(claudeBillingOf('/login managed key')).toBe('api')
  expect(claudeBillingOf('oauth')).toBe(null)
  expect(claudeBillingOf(null)).toBe(null)
})

test("Claude's plan is the account's: Anthropic's own API signed in to a plan, never a cloud or a gateway", () => {
  // The SDK's AccountInfo, from the session's initialize.
  expect(
    claudeBillingOfAccount({ apiProvider: 'firstParty', subscriptionType: 'Max', email: 'dev@example.com' }),
  ).toEqual({ billing: 'subscription', plan: 'max' })
  for (const apiProvider of ['bedrock', 'vertex', 'foundry', 'gateway', 'anthropicAws'])
    expect(claudeBillingOfAccount({ apiProvider }, 'none')).toEqual({ billing: 'api' })
  // First-party on a key, or with no plan named: a key bills the API; nothing else says.
  expect(claudeBillingOfAccount({ apiProvider: 'firstParty' }, 'ANTHROPIC_API_KEY')).toEqual({ billing: 'api' })
  expect(claudeBillingOfAccount({ apiProvider: 'firstParty' }, 'none')).toBe(null)
  // An older CLI's account names no provider.
  expect(claudeBillingOfAccount({ subscriptionType: 'max' })).toBe(null)
  expect(claudeBillingOfAccount(null)).toBe(null)
})

test('the message a Claude turn ends with on a usage limit is read with the SDK’s own list of them', () => {
  useClaudeUsageLimitPrefixes(USAGE_LIMIT_ERROR_PREFIXES)
  expect(isClaudeUsageLimitMessage("You've hit your limit · resets 3pm (Europe/London)")).toBe(true)
  expect(isClaudeUsageLimitMessage("You've reached your weekly limit")).toBe(true)
  expect(isClaudeUsageLimitMessage('API Error: 529 overloaded')).toBe(false)
  // Something that is not the SDK's list leaves the one taken.
  useClaudeUsageLimitPrefixes([42])
  expect(isClaudeUsageLimitMessage("You've hit your limit")).toBe(true)
})

test('a Claude result is a usage limit by what the CLI says: its terminal reason and its status first', () => {
  useClaudeUsageLimitPrefixes(USAGE_LIMIT_ERROR_PREFIXES)
  const heard = { refused: false, authFailed: false, reported: 'Request failed' }
  const failed = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: true, ...extra })
  // A full context window ends on `blocking_limit` too: a limit only with a refusal or the limit's wording.
  expect(isClaudeUsageLimitResult(failed({ terminal_reason: 'blocking_limit' }), heard)).toBe(false)
  expect(
    isClaudeUsageLimitResult(failed({ terminal_reason: 'blocking_limit' }), {
      ...heard,
      reported: 'Prompt is too long',
    }),
  ).toBe(false)
  expect(isClaudeUsageLimitResult(failed({ terminal_reason: 'blocking_limit' }), { ...heard, refused: true })).toBe(
    true,
  )
  expect(
    isClaudeUsageLimitResult(failed({ terminal_reason: 'blocking_limit' }), {
      ...heard,
      reported: "You've hit your limit · resets 3pm",
    }),
  ).toBe(true)
  expect(isClaudeUsageLimitResult(failed({ api_error_status: 429, terminal_reason: 'api_error' }), heard)).toBe(true)
  expect(isClaudeUsageLimitResult(failed({ api_error_status: 500, terminal_reason: 'api_error' }), heard)).toBe(false)
  // A refusal the exchange heard counts unless the result names another cause.
  const refused = { ...heard, refused: true }
  expect(isClaudeUsageLimitResult(failed({ terminal_reason: 'api_error' }), refused)).toBe(true)
  expect(isClaudeUsageLimitResult(failed({ api_error_status: 500 }), refused)).toBe(false)
  expect(isClaudeUsageLimitResult(failed({ terminal_reason: 'prompt_too_long' }), refused)).toBe(false)
  // A sign-in that failed is never a usage limit.
  expect(
    isClaudeUsageLimitResult(failed({ terminal_reason: 'blocking_limit' }), { ...refused, authFailed: true }),
  ).toBe(false)
  // The message only for a CLI that sends no terminal reason.
  const worded = { ...heard, reported: "You've hit your limit · resets 3pm" }
  expect(isClaudeUsageLimitResult(failed({}), worded)).toBe(true)
  expect(isClaudeUsageLimitResult(failed({ terminal_reason: 'model_error' }), worded)).toBe(false)
})

test("Codex's account/rateLimits/read answer becomes one window per bucket and slot", () => {
  // Shaped like GetAccountRateLimitsResponse for a ChatGPT Plus sign-in.
  const response = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_S },
      secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: RESET_S + 86_400 },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: null,
        normalModelSlug: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_S },
        secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: RESET_S + 86_400 },
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: null,
      },
      codex_mini: {
        limitId: 'codex_mini',
        limitName: 'Mini',
        normalModelSlug: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_S },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: 'rate_limit_reached',
      },
    },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  }
  expect(codexRateLimitUpdates(response)).toEqual([
    {
      id: 'codex:primary',
      label: 'Session (5h)',
      usedPercent: 12,
      resetsAt: RESET_S * 1000,
      durationMs: 5 * HOUR,
      status: 'allowed',
    },
    {
      id: 'codex:secondary',
      label: 'Weekly',
      usedPercent: 37,
      resetsAt: (RESET_S + 86_400) * 1000,
      durationMs: 7 * 24 * HOUR,
      status: 'allowed',
    },
    {
      // A bucket of its own meters its model: a row of its own, scoped to it.
      id: 'codex_mini:primary',
      label: 'Mini · Session (5h)',
      usedPercent: 100,
      resetsAt: RESET_S * 1000,
      durationMs: 5 * HOUR,
      scope: 'model',
      status: 'rejected',
    },
  ])
})

test('a sparse account/rateLimits/updated snapshot updates the windows it carries and no others', () => {
  // AccountRateLimitsUpdatedNotification.rateLimits: the weekly window left null.
  expect(
    codexRateLimitUpdates({
      limitId: null,
      limitName: null,
      primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: RESET_S },
      secondary: null,
      planType: null,
      rateLimitReachedType: null,
    }),
  ).toEqual([
    {
      id: 'codex:primary',
      label: 'Session (5h)',
      usedPercent: 15,
      resetsAt: RESET_S * 1000,
      durationMs: 5 * HOUR,
      status: 'allowed',
    },
  ])
  expect(codexRateLimitUpdates(null)).toEqual([])
})

test("Codex's billing comes from account/read: ChatGPT is a plan, an API key or Bedrock is not", () => {
  expect(
    codexBillingOf({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    }),
  ).toEqual({ billing: 'subscription', plan: 'pro' })
  expect(codexBillingOf({ account: { type: 'chatgpt', email: null, planType: 'unknown' } })).toEqual({
    billing: 'subscription',
  })
  expect(codexBillingOf({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toEqual({ billing: 'api' })
  expect(codexBillingOf({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: false } })).toEqual({
    billing: 'api',
  })
  expect(codexBillingOf({ account: null, requiresOpenaiAuth: false })).toBe(null)
})

test('a Codex turn error is a usage limit only when Codex says usageLimitExceeded', () => {
  expect(
    isCodexUsageLimitError({
      message: "You've hit your usage limit.",
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: null,
      misalignment: null,
    }),
  ).toBe(true)
  expect(isCodexUsageLimitError({ message: 'Slow down', codexErrorInfo: 'rateLimitExceeded' })).toBe(false)
  expect(isCodexUsageLimitError(null)).toBe(false)
})
