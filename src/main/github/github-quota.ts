// How much of the GitHub API quota is left, per host, and whether the
// background reads should wait for it to come back.
//
// The quota is the signed-in account's, shared with everything else that
// account does: the agents' own `gh` calls, a person's terminal, CI tooling.
// The pull request watch is the one caller here that runs on its own, so it is
// the one that stops early. Every answer that says how much is left feeds in
// (a REST response's `x-ratelimit-*` headers, the GraphQL `rateLimit` field
// the batched fingerprint asks for), and once a quota is down to its reserve
// ({@link GITHUB_QUOTA_RESERVE_RATIO} of its limit) the watch pauses on that
// host until the quota resets. The reserve is what the agents keep.
//
// A call GitHub refused outright (the quota spent, or a secondary limit) is a
// hold too, set by the caller with the reset it could learn
// (`pull-request-record.ts`). Both are the same answer to "may I ask now",
// so they live together.

/** The share of a quota left alone for everything but the watch. */
export const GITHUB_QUOTA_RESERVE_RATIO = 0.1

/** One quota as an answer reported it. `resource` is GitHub's name for it: `core`, `graphql`, … */
export type GitHubQuotaReading = {
  resource: string
  limit: number
  remaining: number
  /** When it resets, ms epoch. */
  resetAt: number
}

export type GitHubQuota = {
  /** What an answer said about one quota on this host. The latest reading of a resource replaces the one before. */
  note(host: string, reading: GitHubQuotaReading): void
  /** Hold every read on this host until then: GitHub refused one. Replaces the hold before, which may have been a guess. */
  hold(host: string, until: number): void
  /** Until when reads on this host wait, ms epoch, or null when they may ask now. */
  pausedUntil(host: string): number | null
}

export function createGitHubQuota(
  options: { now?: () => number; reserveRatio?: number; maxPauseMs?: number } = {},
): GitHubQuota {
  const now = options.now ?? (() => Date.now())
  const reserveRatio = options.reserveRatio ?? GITHUB_QUOTA_RESERVE_RATIO
  // A reset reported far in the future is a clock or a parse gone wrong; the
  // pause never outlasts the longest window GitHub has (an hour), with margin.
  const maxPauseMs = options.maxPauseMs ?? 65 * 60_000
  const readings = new Map<string, Map<string, GitHubQuotaReading>>()
  const holds = new Map<string, number>()

  return {
    note(host, reading) {
      if (!validReading(reading)) return
      let byResource = readings.get(host)
      if (!byResource) readings.set(host, (byResource = new Map()))
      byResource.set(reading.resource, reading)
    },
    hold(host, until) {
      holds.set(host, until)
    },
    pausedUntil(host) {
      const at = now()
      let until = holds.get(host) ?? 0
      for (const reading of readings.get(host)?.values() ?? []) {
        if (reading.resetAt <= at) continue
        if (reading.remaining > Math.floor(reading.limit * reserveRatio)) continue
        until = Math.max(until, Math.min(reading.resetAt, at + maxPauseMs))
      }
      return until > at ? until : null
    },
  }
}

function validReading(reading: GitHubQuotaReading): boolean {
  return (
    reading.resource.length > 0 &&
    Number.isFinite(reading.limit) &&
    reading.limit > 0 &&
    Number.isFinite(reading.remaining) &&
    reading.remaining >= 0 &&
    Number.isFinite(reading.resetAt) &&
    reading.resetAt > 0
  )
}

/**
 * A REST response's quota, from its `x-ratelimit-*` headers (header names
 * lower-cased). Null when they are not all there: GitHub Enterprise Server
 * with rate limiting off sends none.
 */
export function quotaFromHeaders(headers: ReadonlyMap<string, string>): GitHubQuotaReading | null {
  const limit = Number(headers.get('x-ratelimit-limit'))
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (!headers.has('x-ratelimit-limit') || !headers.has('x-ratelimit-remaining') || !headers.has('x-ratelimit-reset'))
    return null
  const reading = { resource: headers.get('x-ratelimit-resource') || 'core', limit, remaining, resetAt: reset * 1000 }
  return validReading(reading) ? reading : null
}

/** A GraphQL answer's `rateLimit { limit remaining resetAt }`, or null when it has none. */
export function quotaFromGraphQl(rateLimit: unknown): GitHubQuotaReading | null {
  if (typeof rateLimit !== 'object' || rateLimit === null) return null
  const { limit, remaining, resetAt } = rateLimit as Record<string, unknown>
  if (typeof limit !== 'number' || typeof remaining !== 'number' || typeof resetAt !== 'string') return null
  const reading = { resource: 'graphql', limit, remaining, resetAt: Date.parse(resetAt) }
  return validReading(reading) ? reading : null
}
