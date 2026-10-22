import { isRecord } from '../../shared/records'
import {
  claudeUsageWindowDurationMs,
  claudeUsageWindowLabel,
  claudeUsageWindowScope,
  isClaudeUsageWindowId,
  usageEpochMs,
  usagePercent,
  usageWindowLabelForMinutes,
  type UsageLimitStatus,
} from '../../shared/usage-limits'
import type { UsageWindowUpdate } from './store'

// What each agent reports about its usage limits, read into window updates.
// Structural on purpose, like the adapters these are called from: the SDK's
// and the app-server's shapes move between releases, and an unknown shape is
// dropped rather than guessed at.

// --- Claude ------------------------------------------------------------------

/**
 * Billing from the credential source a Claude Code session's init names
 * (normalized by `normalizeApiKeySource`): the three key sources bill the API.
 * `none` says only that no key was used — a claude.ai login, but just as well
 * a bearer token or a cloud provider's credentials (Bedrock, Vertex, Foundry),
 * which the person's environment or settings can select — so it says nothing
 * here: the session's account answers (`claudeBillingOfAccount`). The legacy
 * members say nothing either way.
 */
export function claudeBillingOf(apiKeySource: string | null): 'subscription' | 'api' | null {
  if (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper' || apiKeySource === '/login managed key')
    return 'api'
  return null
}

/**
 * Billing from the account a Claude Code session's initialize answers with
 * (`query.initializationResult()`'s `account`, the SDK's `AccountInfo`), which
 * the session already holds: no request of its own. Only Anthropic's own API
 * (`apiProvider: 'firstParty'`) signed in to a plan (`subscriptionType`) has
 * plan limits. Any other provider — a cloud's, or a gateway's — meters by use
 * and has none, and a first-party session on a key bills the API. An account
 * that names no provider (an older CLI) says nothing.
 */
export function claudeBillingOfAccount(
  account: unknown,
  apiKeySource: string | null = null,
): { billing: 'subscription' | 'api'; plan?: string } | null {
  if (!isRecord(account) || typeof account.apiProvider !== 'string') return null
  if (account.apiProvider !== 'firstParty') return { billing: 'api' }
  const plan = typeof account.subscriptionType === 'string' ? account.subscriptionType.trim() : ''
  if (plan) return { billing: 'subscription', plan: plan.toLowerCase() }
  return claudeBillingOf(apiKeySource) === 'api' ? { billing: 'api' } : null
}

export type ClaudeRateLimitReading = {
  /**
   * Every window the event reads: the one it is about first, when it names
   * one, then each other window in its `unifiedWindows`. Empty for a bare
   * status that names none.
   */
  updates: UsageWindowUpdate[]
  /**
   * The kind of limit the event is about (`five_hour`, `seven_day`…, or
   * `unknown` when it named none). A refusal is kept per kind: one window
   * going through again says nothing about another that refused.
   */
  type: string
  /** Set when the event says requests of this kind are being refused now. */
  rejected: { windowId: string | null; resetsAt: number | null } | null
}

/**
 * One `rate_limit_event`'s `rate_limit_info` (the SDK's `SDKRateLimitInfo`).
 * Its `utilization` is a fraction of the window, 0..1, as the CLI's own
 * display multiplies it; `resetsAt` is epoch seconds. A window that is full
 * while the person's extra usage carries them is a warning, not a refusal:
 * their turns still run. `model` is the session's, which names the window of
 * the model the plan's extra usage covers.
 *
 * The top-level status and utilization are the window that limits now, and
 * only that one: on a plan whose weekly is the fuller, every event was about
 * the weekly, and the session (5h) window was read with a reset and never a
 * share, so it said "Within the limit" over an empty bar. A newer CLI carries
 * every window's share on each event (`unifiedWindows`: the session's, the
 * weekly and the overage-included weekly, each a fraction and a reset in
 * epoch seconds), and each is read from there. One that runs past its cap
 * while the event lets requests through is carried, which the CLI says
 * happens (lower-priority work past the session's limit): a warning, never a
 * refusal it did not make.
 */
export function readClaudeRateLimitInfo(raw: unknown, model?: string | null): ClaudeRateLimitReading | null {
  if (!isRecord(raw)) return null
  const status = raw.status
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return null
  const resetsAt = usageEpochMs(raw.resetsAt)
  const type = typeof raw.rateLimitType === 'string' ? raw.rateLimitType : null
  const windowId = type && isClaudeUsageWindowId(type) ? type : null
  const carriedByOverage =
    status === 'rejected' &&
    (raw.isUsingOverage === true ||
      raw.overageInUse === true ||
      raw.overageStatus === 'allowed' ||
      raw.overageStatus === 'allowed_warning')
  const refused = status === 'rejected' && !carriedByOverage
  const windowStatus: UsageLimitStatus = refused ? 'rejected' : status === 'allowed' ? 'allowed' : 'warning'
  const fraction = typeof raw.utilization === 'number' ? usagePercent(raw.utilization * 100) : null
  const scope = windowId ? claudeUsageWindowScope(windowId) : undefined
  const limiting: UsageWindowUpdate | null = windowId
    ? {
        id: windowId,
        label: claudeUsageWindowLabel(windowId, model),
        ...(fraction !== null ? { usedPercent: fraction } : {}),
        ...(resetsAt !== null ? { resetsAt } : {}),
        ...(claudeUsageWindowDurationMs(windowId) ? { durationMs: claudeUsageWindowDurationMs(windowId) } : {}),
        ...(scope ? { scope } : {}),
        status: windowStatus,
      }
    : null
  const updates: UsageWindowUpdate[] = limiting ? [limiting] : []
  const unified = isRecord(raw.unifiedWindows) ? raw.unifiedWindows : null
  for (const [id, reading] of Object.entries(unified ?? {})) {
    if (!isClaudeUsageWindowId(id) || !isRecord(reading) || typeof reading.utilization !== 'number') continue
    const usedPercent = usagePercent(reading.utilization * 100)
    if (usedPercent === null) continue
    const windowResetsAt = usageEpochMs(reading.resetsAt)
    // The window the event is about keeps its own status; its share is
    // taken from here only when the event's own fields left it out.
    if (limiting && id === limiting.id) {
      if (limiting.usedPercent === undefined) limiting.usedPercent = usedPercent
      if (limiting.resetsAt === undefined && windowResetsAt !== null) limiting.resetsAt = windowResetsAt
      continue
    }
    const windowScope = claudeUsageWindowScope(id)
    updates.push({
      id,
      label: claudeUsageWindowLabel(id, model),
      usedPercent,
      ...(windowResetsAt !== null ? { resetsAt: windowResetsAt } : {}),
      ...(claudeUsageWindowDurationMs(id) ? { durationMs: claudeUsageWindowDurationMs(id) } : {}),
      ...(windowScope ? { scope: windowScope } : {}),
      // Refused, the event says which window refuses, and it is not this one;
      // the store's own reading of a share decides. Let through, a window
      // past its cap is being carried.
      ...(refused ? {} : { status: usedPercent >= 100 ? ('warning' as const) : ('allowed' as const) }),
    })
  }
  return {
    updates,
    type: type ?? 'unknown',
    rejected: refused ? { windowId, resetsAt } : null,
  }
}

/** One window from a Claude Code status line, as the forwarder carries it: 0..100, reset in epoch ms. */
export type StatusLineRateLimit = { usedPercentage: number; resetsAt?: number }

/** The status line's `rate_limits`, as window updates. It says how full, never whether refused. */
export function claudeStatusLineUpdates(
  rateLimits: Readonly<Record<string, StatusLineRateLimit>> | unknown,
): UsageWindowUpdate[] {
  const updates: UsageWindowUpdate[] = []
  // Read as the forwarder's record, whichever process it reached: a value
  // that is not one is dropped, not guessed at.
  if (!isRecord(rateLimits)) return updates
  for (const [id, reading] of Object.entries(rateLimits)) {
    if (!isClaudeUsageWindowId(id) || !isRecord(reading)) continue
    const usedPercent = usagePercent(reading.usedPercentage)
    if (usedPercent === null) continue
    const resetsAt = usageEpochMs(reading.resetsAt)
    const scope = claudeUsageWindowScope(id)
    updates.push({
      id,
      label: claudeUsageWindowLabel(id),
      usedPercent,
      ...(resetsAt !== null ? { resetsAt } : {}),
      ...(claudeUsageWindowDurationMs(id) ? { durationMs: claudeUsageWindowDurationMs(id) } : {}),
      ...(scope ? { scope } : {}),
    })
  }
  return updates
}

// The opening words of the message a Claude turn ends with when a usage limit
// refused it ("You've hit your limit · resets 3pm"), as the SDK lists them
// (`USAGE_LIMIT_ERROR_PREFIXES`). Read off the SDK when a chat loads it, never
// copied: the CLI's wording moves between releases, and the list moves with
// it. Until it is loaded no message is read as one, which loses nothing: the
// fallback is only for a CLI too old to say `terminal_reason`.
let claudeUsageLimitPrefixes: readonly string[] = []

/** Take the SDK's list of usage-limit message prefixes; anything that is not a list of strings is ignored. */
export function useClaudeUsageLimitPrefixes(prefixes: unknown): void {
  if (Array.isArray(prefixes) && prefixes.every((prefix) => typeof prefix === 'string' && prefix))
    claudeUsageLimitPrefixes = [...prefixes]
}

export function isClaudeUsageLimitMessage(text: string): boolean {
  const trimmed = text.trimStart()
  return claudeUsageLimitPrefixes.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * Whether a failed Claude `result` (the SDK's `SDKResultMessage`) ended on a
 * usage limit. The CLI says so itself with an exchange whose API call came
 * back 429. Next, a refusal the exchange already heard (a rejected
 * `rate_limit_event`, an assistant message with the `rate_limit` error)
 * counts when the result does not name another cause: no other HTTP status,
 * no terminal reason but an API error or the limit itself. A sign-in that
 * failed is never a usage limit, whatever came with it. Last, for a CLI too
 * old to send `terminal_reason`, its message.
 *
 * `terminal_reason: 'blocking_limit'` is not a usage limit on its own. The
 * CLI ends there when the conversation no longer fits the context window (a
 * prompt too long even after compacting), and read as one, a full chat got
 * the usage-limit notice with no reset time, its provider counted as limited,
 * and a wait that could never clear it. It counts only beside a refusal the
 * exchange heard, or in the usage-limit wording.
 */
export function isClaudeUsageLimitResult(
  result: Record<string, unknown>,
  heard: { refused: boolean; authFailed: boolean; reported: string },
): boolean {
  if (heard.authFailed) return false
  const reason = result.terminal_reason
  const status = result.api_error_status
  if (reason === 'blocking_limit') return heard.refused || isClaudeUsageLimitMessage(heard.reported)
  if (result.subtype === 'success' && status === 429) return true
  if (
    heard.refused &&
    (result.subtype !== 'success' || status === null || status === undefined || status === 429) &&
    (reason === null || reason === undefined || reason === 'api_error')
  )
    return true
  return (reason === null || reason === undefined) && isClaudeUsageLimitMessage(heard.reported)
}

// --- Codex -------------------------------------------------------------------

/**
 * Billing from `account/read` (the app-server's `GetAccountResponse`): a
 * ChatGPT sign-in has plan limits, an API key and a cloud provider's
 * credentials do not. No account says nothing.
 */
export function codexBillingOf(result: unknown): { billing: 'subscription' | 'api'; plan?: string } | null {
  const account = isRecord(result) && isRecord(result.account) ? result.account : null
  if (!account) return null
  if (account.type === 'chatgpt') {
    const plan = typeof account.planType === 'string' && account.planType !== 'unknown' ? account.planType : undefined
    return { billing: 'subscription', ...(plan ? { plan } : {}) }
  }
  if (account.type === 'apiKey' || account.type === 'amazonBedrock') return { billing: 'api' }
  return null
}

// The bucket every Codex account meters by default; any other is named.
const CODEX_DEFAULT_LIMIT_ID = 'codex'

/**
 * Windows from an `account/rateLimits/read` answer (`GetAccountRateLimitsResponse`)
 * or the `rateLimits` of an `account/rateLimits/updated` push (a sparse
 * `RateLimitSnapshot`). Each bucket has a primary (the short window) and a
 * secondary (the weekly one), or for an Enterprise usage-based plan an
 * `individualLimit` instead; `usedPercent` is 0..100 and `resetsAt` epoch
 * seconds. A window the push leaves null is left as it was.
 */
export function codexRateLimitUpdates(raw: unknown): UsageWindowUpdate[] {
  if (!isRecord(raw)) return []
  const buckets: Record<string, unknown>[] = []
  if (isRecord(raw.rateLimitsByLimitId)) {
    for (const bucket of Object.values(raw.rateLimitsByLimitId)) if (isRecord(bucket)) buckets.push(bucket)
  }
  // The single-bucket view mirrors one of the buckets above; read it only
  // when there are none, or it would be counted twice.
  if (buckets.length === 0) {
    if (isRecord(raw.rateLimits)) buckets.push(raw.rateLimits)
    else if ('primary' in raw || 'secondary' in raw) buckets.push(raw)
  }
  return buckets.flatMap(codexBucketUpdates)
}

function codexBucketUpdates(bucket: Record<string, unknown>): UsageWindowUpdate[] {
  const limitId = typeof bucket.limitId === 'string' && bucket.limitId ? bucket.limitId : CODEX_DEFAULT_LIMIT_ID
  const name =
    limitId === CODEX_DEFAULT_LIMIT_ID ? null : typeof bucket.limitName === 'string' ? bucket.limitName : limitId
  const updates: UsageWindowUpdate[] = []
  for (const slot of ['primary', 'secondary'] as const) {
    const window = bucket[slot]
    if (!isRecord(window)) continue
    const usedPercent = usagePercent(window.usedPercent)
    if (usedPercent === null) continue
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null
    const resetsAt = usageEpochMs(window.resetsAt)
    const label = usageWindowLabelForMinutes(minutes)
    updates.push({
      id: `${limitId}:${slot}`,
      label: name ? `${name} · ${label}` : label,
      usedPercent,
      ...(resetsAt !== null ? { resetsAt } : {}),
      ...(minutes && minutes > 0 ? { durationMs: minutes * 60_000 } : {}),
      // A bucket under its own limit id meters one model (Spark); only the
      // default bucket holds back every turn.
      ...(name ? { scope: 'model' as const } : {}),
      // Codex says which bucket refused, not which window: the full one did.
      status: usedPercent >= 100 ? 'rejected' : 'allowed',
    })
  }
  // An Enterprise usage-based plan has neither window: its allowance is a
  // monthly credit limit, sent as what is left of it. Read only for the
  // default bucket and only when it has no window of its own, so a plan that
  // meters by session and week is shown and held back exactly as before.
  const individual = bucket.individualLimit
  if (limitId === CODEX_DEFAULT_LIMIT_ID && updates.length === 0 && isRecord(individual)) {
    const remaining = usagePercent(individual.remainingPercent)
    if (remaining !== null) {
      const usedPercent = 100 - remaining
      const resetsAt = usageEpochMs(individual.resetsAt)
      updates.push({
        id: `${limitId}:individual`,
        label: 'Monthly credit limit',
        usedPercent,
        ...(resetsAt !== null ? { resetsAt } : {}),
        // As the windows above: spent, it is what refuses every turn until
        // it resets, and a reading with some left again lifts that.
        status: usedPercent >= 100 ? 'rejected' : 'allowed',
      })
    }
  }
  return updates
}

/** A Codex turn error (`TurnError`) that is a plan's usage limit, not a transient rate limit. */
export function isCodexUsageLimitError(error: unknown): boolean {
  return isRecord(error) && error.codexErrorInfo === 'usageLimitExceeded'
}
