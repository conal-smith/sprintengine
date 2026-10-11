/**
 * The pull-request watch: a backoff-scheduled re-probe of things whose state
 * changes on GitHub, outside the app, long after the local work finished.
 *
 * Built for a pull request's merge state self-healing with no window
 * open) and generalised over `{ key, isWatchable, probe }`, so the conversation
 * pull request record (`src/server/pull-requests/pull-request-record.ts`, epic `pull-request-marks`
 * decision 9) rides this schedule rather than a second one with the same
 * comments.
 *
 * WHAT A KEY IS is the consumer's business — a pull request URL, for the one
 * consumer there is today. The poller only ever asks two things about one — "is
 * this still worth probing" and "probe it" — and both are the consumer's to
 * answer.
 *
 * THE SCHEDULE. 1 → 2 min, then HOLDING at 2 until the key stops being
 * watchable, at which point its timer is torn down for good. It used to climb
 * to 32 min, and a pull request merged an hour after it was opened stayed green
 * in the sidebar for up to half an hour (owner, 2026-10-02: "I should be able
 * to scan my thread and see exactly what is outstanding"). Two minutes keeps a
 * merge visible within a glance's worth of time for a handful of `gh` calls; a
 * merged or closed one is never probed again. It
 * deliberately does not halt at the cap: a headless owner has no "the user came
 * back" trigger to re-arm it, and a watch that goes silent an hour in does not
 * self-heal at all. When nothing is watchable the poller holds zero timers —
 * the no-steady-state-polling rule is about the app at rest, not about a pull
 * request that is genuinely still open.
 *
 * NOBODY LOOKING. Two minutes is for a person scanning the sidebar. While no
 * app window has focus nobody is, and a probe per open pull request every
 * couple of minutes is a `gh` process each, on battery, for nothing: the
 * delay stretches to {@link PR_WATCH_UNFOCUSED_MS}. A window coming back to
 * the front probes each watched key once, shortly (spread over
 * {@link PR_WATCH_FOCUS_SPREAD_MS}), and the two-minute schedule resumes. A
 * headless owner, which no window ever focuses, still self-heals, on the
 * longer delay. A key its consumer says keeps its pace (`keepsPace`) does not
 * stretch: an agent waiting to be woken about its pull request is looking
 * whether a person is or not.
 *
 * JITTER. Arming a whole scan's worth of keys in one pass would fire their
 * probes in lockstep — a burst of `gh` subprocesses on one tick. Each delay is
 * spread by ±{@link PR_WATCH_JITTER_RATIO}.
 *
 * COALESCING. `noteChanged` is fired by change funnels that run several times a
 * minute; the answer to "is this watchable" changes about once per key. At most
 * one re-evaluation per key per {@link PR_WATCH_CHANGE_COALESCE_MS}, with a
 * single trailing one for notifications that arrived inside the window. Well
 * under the base delay, so a newly-opened pull request still arms long before
 * its first probe would fire.
 */
import { backoffDelayMs, type ExponentialBackoffOptions } from '../../shared/exponentialBackoff'

/**
 * 1 → 2 min, then every 2 min. No `stopAtMax`: see the header for why a
 * headless owner keeps probing where a renderer supervisor halted.
 */
export const PR_WATCH_BACKOFF: ExponentialBackoffOptions = {
  baseMs: 60_000,
  factor: 2,
  maxMs: 2 * 60_000,
}

/** The delay between probes while no app window has focus; see the header. */
export const PR_WATCH_UNFOCUSED_MS = 10 * 60_000

/** A window coming back to the front probes each watched key within this, spread so they do not fire together. */
export const PR_WATCH_FOCUS_SPREAD_MS = 10_000

/** Each delay is multiplied by 1 ± this, so simultaneously-armed keys desynchronize. */
export const PR_WATCH_JITTER_RATIO = 0.2

/** At most one re-evaluation per key per this window; see the header. */
export const PR_WATCH_CHANGE_COALESCE_MS = 30_000

/**
 * How stale a thing may be and still be picked up by a consumer's startup scan
 * — and, for a consumer whose keys accumulate for the life of the process, how
 * old one may be and still be worth a timer at all (30 days).
 *
 * It lives here because the conversation pull request record bounds itself by
 * it, so a laptop that has seen a thousand pull requests does not hold a
 * thousand timers for ones nobody will merge.
 */
export const PR_WATCH_BOOT_SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type WatchPollerTimers = {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Whether an app window has focus, and word when that changes (power-activity.ts). */
export type WatchPollerFocus = {
  isFocused(): boolean
  onFocusChange(listener: (focused: boolean) => void): () => void
}

export type PullRequestWatchPollerDeps = {
  /**
   * Whether this key is still worth probing. Re-read after every probe — it is
   * what tears the last timer down. May throw: an unreadable key is not a key
   * to probe (Fallback Discipline — no guessing that a pull request is open on
   * evidence we could not read).
   */
  isWatchable(key: string): boolean | Promise<boolean>
  /** One probe. Failures are swallowed: a transient `gh` error just retries on the next step. */
  probe(key: string): Promise<unknown>
  /** Whether this key holds the base schedule with no window focused. Absent, none does. */
  keepsPace?(key: string): boolean
  backoff?: ExponentialBackoffOptions
  jitterRatio?: number
  changeCoalesceMs?: number
  timers?: WatchPollerTimers
  /** Absent, the poller reads as always looked at, and keeps the two-minute schedule. */
  focus?: WatchPollerFocus
  unfocusedDelayMs?: number
  now?(): number
  /** Injected so jitter is deterministic under test. */
  random?(): number
}

export type PullRequestWatchPoller = {
  /**
   * Open for business. Until it is called `noteChanged` is inert, so a consumer
   * that arms from a startup scan cannot be raced by a change notification that
   * arrives while it is still scanning.
   */
  begin(): void
  /** Put this key under watch now (no probe until the first delay elapses). */
  arm(key: string): void
  /** Stop watching this key and drop its timer. */
  disarm(key: string): void
  /**
   * Something about this key changed: re-read its watchability and arm or
   * disarm accordingly, coalesced. Deliberately does NOT restart an
   * already-armed key's schedule — our own probe usually causes the change, so
   * re-arming on it would loop a watched key at the base delay for ever.
   */
  noteChanged(key: string): void
  /** Keys holding a live timer. Introspection for diagnostics and tests. */
  watchedKeys(): string[]
  dispose(): void
}

type PollEntry = { attempt: number; handle: unknown | null }

export function createPullRequestWatchPoller(deps: PullRequestWatchPollerDeps): PullRequestWatchPoller {
  const backoff = deps.backoff ?? PR_WATCH_BACKOFF
  const jitterRatio = deps.jitterRatio ?? PR_WATCH_JITTER_RATIO
  const coalesceMs = deps.changeCoalesceMs ?? PR_WATCH_CHANGE_COALESCE_MS
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const timers = deps.timers ?? {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const unfocusedDelayMs = deps.unfocusedDelayMs ?? PR_WATCH_UNFOCUSED_MS
  const focused = (): boolean => deps.focus?.isFocused() ?? true

  const entries = new Map<string, PollEntry>()
  // Serializes the async re-evaluations of one key, so a burst of change
  // notifications cannot interleave an arm with a disarm for the same key.
  const evaluations = new Map<string, Promise<void>>()
  // Change-notification coalescing per key: when it last read, and the trailing
  // timer holding a notification that arrived inside the window.
  const lastEvaluatedAt = new Map<string, number>()
  const trailingEvaluations = new Map<string, unknown>()
  let started = false
  let disposed = false

  function jittered(delayMs: number): number {
    if (jitterRatio <= 0) return delayMs
    // random() ∈ [0,1) → a factor in [1 - ratio, 1 + ratio).
    return Math.max(0, Math.round(delayMs * (1 + (random() * 2 - 1) * jitterRatio)))
  }

  function schedule(key: string, soon?: number): void {
    const entry = entries.get(key)
    if (!entry || disposed) return
    const stepped = backoffDelayMs(entry.attempt, backoff)
    // A non-stopping schedule never exhausts; a caller that configured one that
    // does gets halt-and-stay-silent behaviour instead of a crash.
    if (stepped === null) {
      entry.handle = null
      return
    }
    const paced = focused() || deps.keepsPace?.(key) === true
    const delay = soon ?? jittered(paced ? stepped : Math.max(stepped, unfocusedDelayMs))
    entry.handle = timers.setTimeout(() => {
      const armed = entries.get(key)
      if (!armed || armed !== entry || disposed) return
      armed.handle = null
      void probeThenReschedule(key, armed)
    }, delay)
  }

  // A window back at the front: each key waiting out the long, unfocused
  // delay is probed once, shortly, and the short schedule resumes after it.
  // A key whose probe is in flight reschedules itself when it lands.
  const stopFollowingFocus = deps.focus?.onFocusChange((nowFocused) => {
    if (!nowFocused || disposed) return
    for (const [key, entry] of entries) {
      if (entry.handle === null) continue
      timers.clearTimeout(entry.handle)
      schedule(key, Math.round(random() * PR_WATCH_FOCUS_SPREAD_MS))
    }
  })

  async function probeThenReschedule(key: string, armed: PollEntry): Promise<void> {
    try {
      await deps.probe(key)
    } catch {
      // Best-effort: a transient gh/git failure just retries on the next step.
      // A key whose pull request is genuinely gone stops via the re-read below.
    }
    if (disposed) return
    // Disarm/re-arm during the in-flight probe wins.
    if (entries.get(key) !== armed) return
    armed.attempt += 1
    // The probe just refreshed this key's state: re-read it rather than keep
    // probing something that has now merged. This is what tears the last timer
    // down and returns the poller to holding none.
    const watchable = await isWatchable(key)
    if (disposed || entries.get(key) !== armed) return
    if (!watchable) {
      entries.delete(key)
      return
    }
    schedule(key)
  }

  async function isWatchable(key: string): Promise<boolean> {
    try {
      return await deps.isWatchable(key)
    } catch {
      return false
    }
  }

  function arm(key: string): void {
    if (entries.has(key) || disposed) return
    const entry: PollEntry = { attempt: 0, handle: null }
    entries.set(key, entry)
    schedule(key)
  }

  function disarm(key: string): void {
    const entry = entries.get(key)
    if (!entry) return
    if (entry.handle !== null) timers.clearTimeout(entry.handle)
    entries.delete(key)
  }

  // One notification, coalesced: read now if this key has not been read inside
  // the window, otherwise arm a single trailing read for when the window closes.
  function evaluateCoalesced(key: string): void {
    if (trailingEvaluations.has(key)) return
    const sinceLast = now() - (lastEvaluatedAt.get(key) ?? -Infinity)
    if (sinceLast >= coalesceMs) {
      evaluate(key)
      return
    }
    trailingEvaluations.set(
      key,
      timers.setTimeout(() => {
        trailingEvaluations.delete(key)
        if (disposed || !started) return
        evaluate(key)
      }, coalesceMs - sinceLast),
    )
  }

  // One key, re-read and reconciled against its timer. Queued per key so
  // overlapping notifications resolve in order.
  function evaluate(key: string): void {
    lastEvaluatedAt.set(key, now())
    const previous = evaluations.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (disposed || !started) return
        // An already-armed key keeps its schedule: see `noteChanged`.
        if (entries.has(key)) {
          if (!(await isWatchable(key))) disarm(key)
          return
        }
        if (await isWatchable(key)) arm(key)
      })
    evaluations.set(key, next)
    void next.finally(() => {
      if (evaluations.get(key) === next) evaluations.delete(key)
    })
  }

  return {
    begin() {
      if (!disposed) started = true
    },
    arm(key) {
      arm(key)
    },
    disarm(key) {
      disarm(key)
    },
    noteChanged(key) {
      if (!started || disposed) return
      evaluateCoalesced(key)
    },
    watchedKeys() {
      return [...entries.keys()]
    },
    dispose() {
      disposed = true
      stopFollowingFocus?.()
      for (const key of [...entries.keys()]) disarm(key)
      for (const handle of trailingEvaluations.values()) timers.clearTimeout(handle)
      trailingEvaluations.clear()
      lastEvaluatedAt.clear()
      evaluations.clear()
    },
  }
}
