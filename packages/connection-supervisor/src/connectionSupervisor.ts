// One owner for a connection that has to stay up: an SSH machine's session, a
// paired machine's change feed, a web tab's socket, a phone's conversation
// stream. Each of those used to carry its own retry loop, and two shipped bugs
// came out of the differences between them: a wake that closed a working
// connection unasked, and a reconnect that gave up for good after ten minutes
// of wall-clock time, sleep included. The rules live here once instead.
//
//   idle ─start─► connecting ─► up ─lost─► backoff ─timer─► connecting
//                    │                       │ offline, or parked after N failures
//                    │                       └► waiting-for-wake ─wake/online─► connecting
//                    ├─ a credential refused ─► needs-sign-in   (retryNow)
//                    └─ retrying cannot help ─► failed          (retryNow)
//   any ─stop─► stopped (start)
//
// - Each attempt is one call of `connect`; the transport reports a loss through
//   the attempt's `lost`. An attempt the supervisor has moved on from (timed
//   out, replaced, stopped) is ignored, and a connection it brings late is
//   closed, so a slow dial can never resurrect a session nobody wants.
// - Retries back off exponentially with jitter, up to a cap, and never stop:
//   a machine that is away for a day is tried again at the cap all day. The
//   jitter keeps every client of a restarted server from knocking at once.
// - Failures in a row reset only once a connection has stayed up for a while,
//   so a server that accepts and drops at once still backs off.
// - `retryingForMs` is time spent trying: each attempt's own duration and each
//   wait as scheduled. A timer that fires hours late because the computer slept
//   adds what it was scheduled for, not the hours.
// - A wake (resume, unlock, foreground, the network back) pings a live
//   connection and keeps it when it answers: closing it unasked costs a full
//   handshake, which a background reconnect may not be able to make. One that
//   does not answer is replaced at once. A wait in a backoff is cut short; an
//   attempt in flight is left to finish.
// - A refused credential or a failure retrying cannot fix waits for the person
//   (`retryNow`), not for a wake: asking again with what was refused only
//   repeats the refusal.
// - A delay the far end asked for is a floor that a wake does not cut short.
//
// Pure TypeScript with no imports: the clock, timers and randomness are
// injected, and nothing here needs Node, a DOM or React, so the desktop's main
// process, a web tab and the phone app all run this same file. The phone app
// carries a byte-for-byte copy (it cannot import this package), pinned by a
// digest on both sides.
//
// The connect seam is one attempt at one address. Several routes to one
// machine would be a `connect` that tries them in its own order; the supervisor
// needs no change for that.

export type ConnectionPhase =
  'idle' | 'connecting' | 'up' | 'backoff' | 'waiting-for-wake' | 'needs-sign-in' | 'failed' | 'stopped'

export type ConnectionState = {
  readonly phase: ConnectionPhase
  /** Failed attempts in a row, since a connection last stayed up, a wake, or a retry. */
  readonly failures: number
  /** When the backoff's attempt is due, on the supervisor's clock; null outside a backoff. */
  readonly retryAt: number | null
  /** The backoff waits out a delay the far end asked for, which a wake does not cut short. */
  readonly heldByPeer: boolean
  /** In `waiting-for-wake`: the network to come back, or any wake after parking. */
  readonly waitingFor: 'network' | 'wake' | null
  /** A connection was lost and has not come back: a retry is a reconnect, not a first connect. */
  readonly reconnecting: boolean
  /** Time spent trying since the last connection, wake or retry: attempts plus scheduled waits, never sleep. */
  readonly retryingForMs: number
  /** What the last failure threw or reported; null once a connection is up. */
  readonly lastError: unknown
  /** How many connections have come up. */
  readonly generation: number
  /** What `setOnline` last said. */
  readonly online: boolean
}

export type ConnectionFailureVerdict =
  /** Worth another try, no sooner than `retryAfterMs` if the far end asked for one. */
  | { readonly kind: 'transient'; readonly retryAfterMs?: number }
  /** A credential was refused: wait for the person. */
  | { readonly kind: 'needs-sign-in' }
  /** Retrying cannot help (an unsupported server, a changed host key): wait for the person. */
  | { readonly kind: 'fatal' }

export type ConnectionAttempt<Hint> = {
  /** 1 for the first attempt after a success, a wake or a retry; counts up through a backoff. */
  readonly number: number
  /** What `start` or `retryNow` was given; undefined for the supervisor's own retries. */
  readonly hint: Hint | undefined
  /** A connection was lost before this attempt: it is a reconnect. */
  readonly reconnecting: boolean
  /** The connection this attempt made, or is making, ended. Ignored once the supervisor moved on. */
  lost(error?: unknown): void
  /** Whether the supervisor still wants what this attempt brings. */
  current(): boolean
}

export type SupervisorClock = {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type ConnectionBackoff = {
  /** The first retry's ceiling. Default one second. */
  baseMs?: number
  /** The longest wait, or how long it may be now (a battery, an outage gone on for a while). Default five minutes. */
  maxMs?: number | ((state: ConnectionState) => number)
  /** How much of each wait is random, from its top down: 0.5 waits between half the ceiling and all of it. */
  jitter?: number
}

export type ConnectionSupervisorOptions<C, Hint = undefined> = {
  connect(attempt: ConnectionAttempt<Hint>): Promise<C>
  /** End a connection the supervisor no longer wants: replaced, stopped, or brought by an attempt it gave up on. */
  close(connection: C, reason: string): void
  /** Resolves while the connection still answers. Without one, a wake trusts an open connection. */
  ping?(connection: C): Promise<unknown>
  /** What a failure means. Default: worth another try. */
  classify?(error: unknown, context: { established: boolean; reconnecting: boolean }): ConnectionFailureVerdict
  backoff?: ConnectionBackoff
  /** Up this long, the failures in a row are forgotten. Default 30 s. */
  stableAfterMs?: number
  /** An attempt not done by then has failed. Default 15 s; null for one whose steps carry their own deadlines. */
  connectTimeoutMs?: number | null
  /** How long a wake's ping may take. Default 10 s. */
  pingTimeoutMs?: number
  /** After this many failures in a row, wait for a wake instead of a timer. Default never. */
  parkAfterFailures?: number
  clock?: SupervisorClock
  random?: () => number
}

/** An attempt that did not finish within `connectTimeoutMs`. */
export class ConnectTimeoutError extends Error {
  constructor(ms: number) {
    super(`The connection did not open within ${Math.round(ms / 1000)} s.`)
    this.name = 'ConnectTimeoutError'
  }
}

/** The supervisor was stopped, or never started, while something waited for a connection. */
export class ConnectionStoppedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ConnectionStoppedError'
  }
}

const DEFAULT_BASE_MS = 1_000
const DEFAULT_MAX_MS = 5 * 60_000
const DEFAULT_JITTER = 0.5
const DEFAULT_STABLE_AFTER_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_PING_TIMEOUT_MS = 10_000

/**
 * The wait before the retry after `failures` failures in a row (1 or more):
 * the ceiling doubles from `baseMs` up to `maxMs`, and the wait is drawn from
 * its top `jitter` share.
 */
export function connectionRetryDelayMs(
  failures: number,
  policy: { baseMs: number; maxMs: number; jitter: number },
  random: () => number,
): number {
  const exponent = Math.max(0, Math.floor(failures) - 1)
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent)
  const jitter = Math.min(1, Math.max(0, policy.jitter))
  return Math.round(ceiling * (1 - jitter + jitter * random()))
}

/** Timers that never hold a process open by themselves, where the host has that notion. */
const SYSTEM_CLOCK: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms) as unknown as { unref?: () => void }
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}

type Attempt<C> = {
  /** When the attempt's time started counting: its start, or the last wake during it. */
  startedAt: number
  /** Settled: connected, failed, or given up on. */
  done: boolean
  connection: C | null
  timeout: unknown
}

type Waiter<C> = { resolve(connection: C): void; reject(error: unknown): void }

export class ConnectionSupervisor<C, Hint = undefined> {
  private snapshot: ConnectionState = {
    phase: 'idle',
    failures: 0,
    retryAt: null,
    heldByPeer: false,
    waitingFor: null,
    reconnecting: false,
    retryingForMs: 0,
    lastError: null,
    generation: 0,
    online: true,
  }
  private readonly options: ConnectionSupervisorOptions<C, Hint>
  private readonly clock: SupervisorClock
  private readonly random: () => number
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  /** The attempt in flight, or the one whose connection is up. */
  private attempt: Attempt<C> | null = null
  private connection: C | null = null
  private retryTimer: unknown = null
  private stableTimer: unknown = null
  private liveness: Promise<void> | null = null
  private waiters: Array<Waiter<C>> = []

  constructor(options: ConnectionSupervisorOptions<C, Hint>) {
    this.options = options
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.random = options.random ?? Math.random
  }

  state(): ConnectionState {
    return this.snapshot
  }

  current(): C | null {
    return this.connection
  }

  /** Hear every change of state. The returned function stops it. */
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Connect, from idle or stopped. Anything else is already under way, or waits for `retryNow`. */
  start(hint?: Hint): void {
    if (this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'stopped') return
    this.begin(hint, { failures: 0, retryingForMs: 0, reconnecting: false, lastError: null })
  }

  /**
   * Try now: the person asked. Cuts a backoff short, held by the far end or not,
   * ends a wait for a wake or for the person, and replaces a live connection.
   * An attempt already in flight is the one asked for.
   */
  retryNow(hint?: Hint): void {
    switch (this.snapshot.phase) {
      case 'idle':
      case 'stopped':
        this.start(hint)
        return
      case 'connecting':
        return
      case 'up':
        this.replace('Reconnecting.', hint)
        return
      default:
        this.begin(hint, { failures: 0, retryingForMs: 0 })
    }
  }

  /**
   * The computer woke, the screen was unlocked, the app came to the front, or
   * the network came back. `replace` redials whatever the connection is doing
   * (an absence long enough that what it holds is stale).
   */
  wake(options: { replace?: boolean } = {}): void {
    switch (this.snapshot.phase) {
      case 'up':
        if (options.replace) this.replace('Reconnecting after a wake.')
        else void this.checkLiveness()
        return
      case 'connecting':
        if (options.replace) {
          this.replace('Reconnecting after a wake.')
          return
        }
        // Whatever the attempt spent before the wake may have been asleep.
        if (this.attempt) this.attempt.startedAt = this.clock.now()
        this.update({ failures: 0, retryingForMs: 0 })
        return
      case 'backoff':
        if (this.snapshot.heldByPeer) return
        this.begin(undefined, { failures: 0, retryingForMs: 0 })
        return
      case 'waiting-for-wake':
        this.begin(undefined, { failures: 0, retryingForMs: 0 })
        return
      default:
        return
    }
  }

  /**
   * Whether the device has a network. Offline, a backoff stops spending attempts
   * and waits; a live connection is checked rather than dropped, since an
   * offline report can be wrong (a server on loopback). Back online is a wake.
   */
  setOnline(online: boolean): void {
    if (online === this.snapshot.online) return
    this.update({ online })
    if (online) {
      this.wake()
      return
    }
    if (this.snapshot.phase === 'backoff' && !this.snapshot.heldByPeer) {
      this.clearRetry()
      this.update({ phase: 'waiting-for-wake', waitingFor: 'network', retryAt: null })
    } else if (this.snapshot.phase === 'up') void this.checkLiveness()
  }

  /** Let the connection go and stop trying, until `start`. */
  stop(reason: string): void {
    this.clearRetry()
    this.clearStable()
    this.abandonAttempt()
    const connection = this.connection
    this.connection = null
    this.update({
      phase: 'stopped',
      retryAt: null,
      heldByPeer: false,
      waitingFor: null,
      reconnecting: false,
    })
    if (connection !== null) this.closeQuietly(connection, reason)
    this.rejectWaiters(new ConnectionStoppedError(reason))
  }

  /**
   * The live connection, or the outcome of the attempt under way or due after
   * the backoff. Refused at once where nothing is due: idle, stopped, waiting
   * for a wake, or for the person (with the failure that put it there).
   */
  next(): Promise<C> {
    switch (this.snapshot.phase) {
      case 'up':
        return Promise.resolve(this.connection as C)
      case 'connecting':
      case 'backoff':
        return new Promise<C>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      case 'idle':
      case 'stopped':
        return Promise.reject(new ConnectionStoppedError('Not connected.'))
      default:
        return Promise.reject(this.snapshot.lastError ?? new ConnectionStoppedError('Not connected.'))
    }
  }

  // ── Attempts ──────────────────────────────────────────────────────────────

  private begin(hint: Hint | undefined, reset: Partial<ConnectionState> = {}): void {
    this.clearRetry()
    this.abandonAttempt()
    const attempt: Attempt<C> = { startedAt: this.clock.now(), done: false, connection: null, timeout: null }
    this.attempt = attempt
    this.update({ ...reset, phase: 'connecting', retryAt: null, heldByPeer: false, waitingFor: null })
    const timeoutMs = this.connectTimeoutMs()
    if (timeoutMs !== null)
      attempt.timeout = this.clock.setTimeout(() => {
        attempt.timeout = null
        this.attemptFailed(attempt, new ConnectTimeoutError(timeoutMs))
      }, timeoutMs)
    const handle: ConnectionAttempt<Hint> = {
      number: this.snapshot.failures + 1,
      hint,
      reconnecting: this.snapshot.reconnecting,
      lost: (error) => this.lost(attempt, error),
      current: () => this.attempt === attempt,
    }
    let connecting: Promise<C>
    try {
      connecting = Promise.resolve(this.options.connect(handle))
    } catch (error) {
      connecting = Promise.reject(error)
    }
    connecting.then(
      (connection) => this.connected(attempt, connection),
      (error: unknown) => this.attemptFailed(attempt, error),
    )
  }

  private connected(attempt: Attempt<C>, connection: C): void {
    if (this.attempt !== attempt || attempt.done) {
      this.closeQuietly(connection, 'This connection is no longer wanted.')
      return
    }
    this.settle(attempt)
    attempt.connection = connection
    this.connection = connection
    this.update({
      phase: 'up',
      reconnecting: false,
      retryingForMs: 0,
      lastError: null,
      generation: this.snapshot.generation + 1,
    })
    const stableAfterMs = this.options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS
    if (stableAfterMs <= 0) this.update({ failures: 0 })
    else
      this.stableTimer = this.clock.setTimeout(() => {
        this.stableTimer = null
        if (this.connection === connection) this.update({ failures: 0 })
      }, stableAfterMs)
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.resolve(connection)
  }

  private attemptFailed(attempt: Attempt<C>, error: unknown): void {
    if (this.attempt !== attempt || attempt.done) return
    this.settle(attempt)
    this.attempt = null
    this.failed(error, false, this.creditFor(attempt))
  }

  private lost(attempt: Attempt<C>, error: unknown): void {
    if (this.attempt !== attempt) return
    if (!attempt.done) {
      // Ended before the attempt finished: a failed attempt, whatever it brings later.
      this.settle(attempt)
      this.attempt = null
      this.failed(error, false, this.creditFor(attempt))
      return
    }
    this.attempt = null
    this.connection = null
    this.clearStable()
    this.failed(error, true, 0)
  }

  private failed(error: unknown, established: boolean, creditMs: number): void {
    const reconnecting = established || this.snapshot.reconnecting
    const verdict = this.options.classify?.(error, { established, reconnecting }) ?? { kind: 'transient' }
    this.rejectWaiters(error)
    if (verdict.kind === 'needs-sign-in' || verdict.kind === 'fatal') {
      this.update({
        phase: verdict.kind === 'needs-sign-in' ? 'needs-sign-in' : 'failed',
        lastError: error,
        reconnecting: false,
        retryAt: null,
        heldByPeer: false,
        waitingFor: null,
      })
      return
    }
    const failures = this.snapshot.failures + 1
    const retryingForMs = this.snapshot.retryingForMs + creditMs
    const common = { failures, lastError: error, reconnecting, retryingForMs }
    if (!this.snapshot.online) {
      this.update({ ...common, phase: 'waiting-for-wake', waitingFor: 'network', retryAt: null, heldByPeer: false })
      return
    }
    if (failures >= (this.options.parkAfterFailures ?? Number.POSITIVE_INFINITY)) {
      this.update({ ...common, phase: 'waiting-for-wake', waitingFor: 'wake', retryAt: null, heldByPeer: false })
      return
    }
    const backoffMs = this.backoffMs(failures, { ...this.snapshot, ...common })
    const advisedMs = verdict.retryAfterMs ?? 0
    const delayMs = Math.max(advisedMs, backoffMs)
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      this.begin(undefined)
    }, delayMs)
    this.update({
      ...common,
      // The wait is counted as scheduled, so a timer that fires late after a sleep adds nothing.
      retryingForMs: retryingForMs + delayMs,
      phase: 'backoff',
      retryAt: this.clock.now() + delayMs,
      heldByPeer: advisedMs > backoffMs,
      waitingFor: null,
    })
  }

  /** Close what is up, or drop what is in flight, and dial again at once. */
  private replace(reason: string, hint?: Hint): void {
    const connection = this.connection
    this.connection = null
    this.clearStable()
    this.abandonAttempt()
    if (connection !== null) this.closeQuietly(connection, reason)
    this.begin(hint, { failures: 0, retryingForMs: 0, reconnecting: this.snapshot.reconnecting || connection !== null })
  }

  /** Ping the live connection; one that does not answer in time is replaced. Concurrent calls share one ping. */
  private checkLiveness(): Promise<void> {
    const ping = this.options.ping
    const connection = this.connection
    if (!ping || connection === null) return Promise.resolve()
    if (this.liveness) return this.liveness
    const timeoutMs = this.options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
    const check = new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(false), timeoutMs)
      let pinging: Promise<unknown>
      try {
        pinging = Promise.resolve(ping(connection))
      } catch (error) {
        pinging = Promise.reject(error)
      }
      pinging.then(
        () => {
          this.clock.clearTimeout(timer)
          resolve(true)
        },
        () => {
          this.clock.clearTimeout(timer)
          resolve(false)
        },
      )
    }).then((answered) => {
      this.liveness = null
      if (answered || this.connection !== connection) return
      this.replace('The connection stopped answering after a wake or a network change.')
    })
    this.liveness = check
    return check
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────

  private connectTimeoutMs(): number | null {
    const configured = this.options.connectTimeoutMs
    return configured === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : configured
  }

  /** An attempt's own time, counted toward `retryingForMs`: never more than its deadline. */
  private creditFor(attempt: Attempt<C>): number {
    const elapsed = Math.max(0, this.clock.now() - attempt.startedAt)
    const timeoutMs = this.connectTimeoutMs()
    return timeoutMs === null ? elapsed : Math.min(elapsed, timeoutMs)
  }

  private backoffMs(failures: number, state: ConnectionState): number {
    const backoff = this.options.backoff ?? {}
    const maxMs = typeof backoff.maxMs === 'function' ? backoff.maxMs(state) : (backoff.maxMs ?? DEFAULT_MAX_MS)
    return connectionRetryDelayMs(
      failures,
      { baseMs: backoff.baseMs ?? DEFAULT_BASE_MS, maxMs, jitter: backoff.jitter ?? DEFAULT_JITTER },
      this.random,
    )
  }

  private settle(attempt: Attempt<C>): void {
    attempt.done = true
    if (attempt.timeout !== null) this.clock.clearTimeout(attempt.timeout)
    attempt.timeout = null
  }

  /** Forget the attempt in flight: what it brings later is closed, and what it reports is ignored. */
  private abandonAttempt(): void {
    const attempt = this.attempt
    this.attempt = null
    if (attempt && !attempt.done) this.settle(attempt)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private clearStable(): void {
    if (this.stableTimer !== null) this.clock.clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private closeQuietly(connection: C, reason: string): void {
    try {
      this.options.close(connection, reason)
    } catch {
      // Closing is best effort: the connection is no longer this supervisor's.
    }
  }

  private rejectWaiters(error: unknown): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  private update(change: Partial<ConnectionState>): void {
    this.snapshot = { ...this.snapshot, ...change }
    const state = this.snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}
