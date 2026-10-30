// Discover's own model: the input discipline the search budget forces, and the
// small facts a result row is allowed to state.
//
// GitHub's code search allows ten requests a minute, so a keystroke cannot be a
// request. `createSkillSearchScheduler` is that rule as one testable object:
// nothing is sent below the minimum length, and a burst of keystrokes collapses
// into one request after the quiet window. Its timers are injected, so the
// coalescing is proven against a fake clock rather than a sleeping test.
//
// Nothing here derives a skill count, a ranking, or a dedupe. Those are the
// scan's to answer, and Discover's whole rule is that a hit is a candidate.

import {
  MIN_SKILL_SEARCH_QUERY_LENGTH,
  type SkillDiscoveryCondition,
  type SkillRateLimit,
} from '../../../../../../../shared/skills'

/** Quiet window before a typed query is sent. Ten searches a minute is the budget. */
export const SKILL_SEARCH_DEBOUNCE_MS = 700

/**
 * What the surface should show for the input as it stands. `pending` means a
 * request is armed and will fire after the quiet window — never that one is in
 * flight, which only the caller's own request state knows.
 */
export type SkillSearchIntent = { kind: 'empty' } | { kind: 'too_short'; minLength: number } | { kind: 'pending' }

export type SkillSearchScheduler = {
  /** Feed the current input; returns what the surface should show right now. */
  type: (query: string) => SkillSearchIntent
  /** Drop an armed request — leaving the tab, or unmounting. */
  cancel: () => void
}

export type SkillSearchSchedulerOptions = {
  /** Runs with the trimmed query once the input has been quiet. */
  onSearch: (query: string) => void
  delayMs?: number
  minLength?: number
  /** Injected by tests so a fake clock can cross the window. */
  schedule?: (run: () => void, delayMs: number) => number
  cancelScheduled?: (handle: number) => void
}

export function createSkillSearchScheduler(options: SkillSearchSchedulerOptions): SkillSearchScheduler {
  const delayMs = options.delayMs ?? SKILL_SEARCH_DEBOUNCE_MS
  const minLength = options.minLength ?? MIN_SKILL_SEARCH_QUERY_LENGTH
  const schedule = options.schedule ?? ((run, ms) => window.setTimeout(run, ms))
  const cancelScheduled = options.cancelScheduled ?? ((handle) => window.clearTimeout(handle))
  let armed: number | null = null

  function cancel(): void {
    if (armed === null) return
    cancelScheduled(armed)
    armed = null
  }

  return {
    cancel,
    type(query) {
      // Every keystroke disarms the previous one first: that, and only that, is
      // what turns a burst of them into a single request.
      cancel()
      const terms = query.trim().replace(/\s+/g, ' ')
      if (terms.length === 0) return { kind: 'empty' }
      if (terms.length < minLength) return { kind: 'too_short', minLength }
      armed = schedule(() => {
        armed = null
        options.onSearch(terms)
      }, delayMs)
      return { kind: 'pending' }
    },
  }
}

/**
 * The remaining budget, spoken only when it is about to bite. Code search
 * allows ten a minute, so a line reading "8 left" on every result is noise,
 * while one that appears at 2 is a warning the next keystroke can act on.
 */
export function describeSearchBudget(rateLimit: SkillRateLimit | null): string | null {
  if (!rateLimit || rateLimit.remaining > 2) return null
  if (rateLimit.remaining <= 0) return 'No searches left in this minute.'
  return `${rateLimit.remaining} search${rateLimit.remaining === 1 ? '' : 'es'} left this minute.`
}

/**
 * A missing token is a failure of the tab — it cannot search at all, and the
 * notice carries the way to fix it. Everything else still works or reopens on
 * its own, which is the degraded tone, not the failed one.
 */
export function discoverNoticeTone(condition: SkillDiscoveryCondition): 'error' | 'warn' {
  return condition.reason === 'needs_token' ? 'error' : 'warn'
}

/**
 * What an empty result list says. An empty list with nothing said is the one
 * outcome this surface must never render: "GitHub has no match" is a fact, and
 * a rate limit, a missing token, or an abandoned search must never borrow it.
 */
export function skillSearchEmptyLine(query: string): string {
  return `No SKILL.md on GitHub matches “${query.trim()}”.`
}

export const POPULAR_REPOS_EMPTY_LINE = 'GitHub returned no repositories tagged as skill collections.'

/**
 * Star counts sit in a dense row, so the long ones fold: 52,341 → 52k. Never a
 * trailing ".0" (1,000 → 1k, 9,960 → 10k), and a count that would round to
 * 1000k reads as 1M.
 */
export function formatStars(stars: number): string {
  if (!Number.isFinite(stars) || stars < 0) return ''
  const count = Math.round(stars)
  if (count < 1000) return String(count)
  const [scaled, unit] = count < 999_500 ? [count / 1000, 'k'] : [count / 1_000_000, 'M']
  return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${unit}`
}

/** Repositories already in the source list, matched the way GitHub matches them. */
export function isRepoAdded(addedRepos: ReadonlySet<string>, repo: string): boolean {
  return addedRepos.has(repo.trim().toLowerCase())
}

/** The set `isRepoAdded` reads, from whatever the source list holds. */
export function addedRepoKeys(repos: readonly string[]): Set<string> {
  return new Set(repos.filter((repo) => repo.trim().length > 0).map((repo) => repo.trim().toLowerCase()))
}
