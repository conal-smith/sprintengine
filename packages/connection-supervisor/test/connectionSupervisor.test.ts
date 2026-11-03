import { expect, test } from 'vitest'
import {
  ConnectionSupervisor,
  ConnectTimeoutError,
  connectionRetryDelayMs,
  type ConnectionAttempt,
  type ConnectionFailureVerdict,
  type ConnectionPhase,
  type ConnectionSupervisorOptions,
  type SupervisorClock,
} from '../src/connectionSupervisor.js'

// Every case runs on a fake clock: time moves only when a test says so, and a
// timer fires only when the clock passes it. `sleep` moves the clock without
// running anything, as a computer whose lid is closed does, and the timers
// that came due fire late, on the first advance after it.

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: SupervisorClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const handle = ++id
      timers.set(handle, { at: now + ms, run })
      return handle
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
  }
  return {
    clock,
    now: () => now,
    timers: () => timers.size,
    async advance(ms = 0): Promise<void> {
      const end = now + ms
      await flush()
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        now = Math.max(now, next[1].at)
        next[1].run()
        await flush()
      }
      now = end
      await flush()
    },
    sleep(ms: number): void {
      now += ms
    },
  }
}

type Conn = { id: number; alive: boolean }

type Pending = {
  attempt: ConnectionAttempt<Conn, string>
  resolve(connection?: Conn): Conn
  reject(error: unknown): void
}

function harness(overrides: Partial<ConnectionSupervisorOptions<Conn, string>> = {}) {
  const time = fakeClock()
  const attempts: Pending[] = []
  const closed: Array<{ id: number; reason: string }> = []
  const phases: ConnectionPhase[] = []
  let ids = 0
  const supervisor = new ConnectionSupervisor<Conn, string>({
    connect: (attempt) =>
      new Promise<Conn>((resolve, reject) => {
        attempts.push({
          attempt,
          resolve: (connection = { id: ++ids, alive: true }) => {
            resolve(connection)
            return connection
          },
          reject,
        })
      }),
    close: (connection, reason) => {
      connection.alive = false
      closed.push({ id: connection.id, reason })
    },
    ping: async (connection) => {
      if (!connection.alive) await new Promise(() => undefined)
    },
    clock: time.clock,
    random: () => 1,
    ...overrides,
  })
  supervisor.subscribe((state) => {
    if (phases.at(-1) !== state.phase) phases.push(state.phase)
  })
  const last = (): Pending => attempts.at(-1)!
  /** The latest attempt fails, and the supervisor has heard. */
  const fail = async (error: unknown = new Error('refused')): Promise<void> => {
    last().reject(error)
    await time.advance()
  }
  /** Wait out the backoff, up to the attempt it starts. */
  const untilRetry = (): Promise<void> => time.advance(supervisor.state().retryAt! - time.now())
  return { supervisor, time, attempts, closed, phases, last, fail, untilRetry }
}

test('the retry delay doubles from its base to its cap, jittered over the upper half', () => {
  const policy = { baseMs: 1_000, maxMs: 30_000, jitter: 0.5 }
  expect(connectionRetryDelayMs(1, policy, () => 0)).toBe(500)
  expect(connectionRetryDelayMs(1, policy, () => 1)).toBe(1_000)
  expect(connectionRetryDelayMs(4, policy, () => 0)).toBe(4_000)
  expect(connectionRetryDelayMs(4, policy, () => 1)).toBe(8_000)
  expect(connectionRetryDelayMs(60, policy, () => 1)).toBe(30_000)
  expect(connectionRetryDelayMs(10_000, policy, () => 0.5)).toBe(22_500)
  // No jitter is the plain ladder.
  expect(connectionRetryDelayMs(3, { baseMs: 50, maxMs: 200, jitter: 0 }, () => 0.3)).toBe(200)
})

test('start connects, and next() hands over the live connection', async () => {
  const { supervisor, last, phases } = harness()
  expect(supervisor.state().phase).toBe('idle')
  await expect(supervisor.next()).rejects.toThrow(/Not connected/u)
  supervisor.start('first')
  expect(supervisor.state().phase).toBe('connecting')
  expect(last().attempt).toMatchObject({ number: 1, hint: 'first', reconnecting: false })
  const joined = supervisor.next()
  const connection = last().resolve()
  await expect(joined).resolves.toBe(connection)
  await expect(supervisor.next()).resolves.toBe(connection)
  expect(supervisor.current()).toBe(connection)
  expect(supervisor.state()).toMatchObject({ phase: 'up', generation: 1, failures: 0, lastError: null })
  expect(phases).toEqual(['connecting', 'up'])
  // Starting what is already running changes nothing.
  supervisor.start()
  expect(supervisor.state().phase).toBe('up')
})

test('a lost connection backs off and reconnects, and the attempt knows it is a reconnect', async () => {
  const { supervisor, time, attempts, last } = harness({ backoff: { baseMs: 1_000, maxMs: 30_000 } })
  supervisor.start()
  last().resolve()
  await time.advance()
  last().attempt.lost(new Error('socket closed'))
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', failures: 1, reconnecting: true, retryAt: 1_000 })
  expect((supervisor.state().lastError as Error).message).toBe('socket closed')
  expect(supervisor.current()).toBeNull()
  await time.advance(999)
  expect(attempts).toHaveLength(1)
  await time.advance(1)
  expect(attempts).toHaveLength(2)
  expect(last().attempt).toMatchObject({ number: 2, reconnecting: true, hint: undefined })
  last().reject(new Error('refused'))
  await time.advance()
  // Doubling: the second failure in a row waits up to two seconds.
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', failures: 2, retryAt: time.now() + 2_000 })
  await time.advance(2_000)
  last().resolve()
  await time.advance()
  expect(supervisor.state()).toMatchObject({ phase: 'up', generation: 2, reconnecting: false })
})

test('failures reset only after the connection stays up long enough', async () => {
  const { supervisor, time, last } = harness({ backoff: { baseMs: 1_000, maxMs: 60_000 }, stableAfterMs: 30_000 })
  supervisor.start()
  last().reject(new Error('refused'))
  await time.advance(1_000)
  last().reject(new Error('refused'))
  await time.advance(2_000)
  expect(supervisor.state().failures).toBe(2)
  // Up briefly, then gone: a flapping server keeps backing off.
  last().resolve()
  await time.advance(5_000)
  last().attempt.lost(new Error('dropped'))
  expect(supervisor.state()).toMatchObject({ failures: 3, retryAt: time.now() + 4_000 })
  await time.advance(4_000)
  // Up for the whole stable window: the ladder starts again.
  last().resolve()
  await time.advance(30_000)
  expect(supervisor.state().failures).toBe(0)
  last().attempt.lost(new Error('dropped'))
  expect(supervisor.state()).toMatchObject({ failures: 1, retryAt: time.now() + 1_000 })
})

test('the delay is capped and never stops: there is no permanent give-up', async () => {
  const { supervisor, time, attempts, last } = harness({ backoff: { baseMs: 1_000, maxMs: 300_000 } })
  supervisor.start()
  for (let i = 0; i < 40; i++) {
    last().reject(new Error('refused'))
    await time.advance()
    expect(supervisor.state().phase).toBe('backoff')
    await time.advance(supervisor.state().retryAt! - time.now())
  }
  expect(attempts).toHaveLength(41)
  expect(supervisor.state().phase).toBe('connecting')
  last().reject(new Error('refused'))
  await time.advance()
  expect(supervisor.state().retryAt! - time.now()).toBe(300_000)
})

test('time asleep is not time spent trying', async () => {
  const { supervisor, time, last } = harness({ backoff: { baseMs: 1_000, maxMs: 30_000 }, connectTimeoutMs: 15_000 })
  supervisor.start()
  last().resolve()
  await time.advance()
  last().attempt.lost(new Error('dropped'))
  // A wait counts once it has been waited, not when it is set.
  expect(supervisor.state().retryingForMs).toBe(0)
  // The lid closes for three hours; the timer fires late, after it opens.
  time.sleep(3 * 60 * 60_000)
  await time.advance()
  expect(supervisor.state()).toMatchObject({ phase: 'connecting', retryingForMs: 1_000 })
  await time.advance(200)
  last().reject(new Error('no network yet'))
  await time.advance()
  // The wait as scheduled and the attempt's own 200 ms count, and nothing else.
  expect(supervisor.state().retryingForMs).toBe(1_000 + 200)
  // A wake starts the count over.
  supervisor.wake()
  expect(supervisor.state()).toMatchObject({ phase: 'connecting', retryingForMs: 0, failures: 0 })
})

test('an attempt the computer slept through counts only its time awake after the wake', async () => {
  const { supervisor, time, fail } = harness({ connectTimeoutMs: null, backoff: { baseMs: 1_000, maxMs: 30_000 } })
  supervisor.start()
  await fail()
  await time.advance(1_000)
  time.sleep(10 * 60_000)
  supervisor.wake()
  await time.advance(300)
  await fail()
  // 300 ms of trying since the wake.
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', failures: 1, retryingForMs: 300 })
})

test('an attempt that takes too long fails, and the connection it brings later is closed', async () => {
  const { supervisor, time, closed, last, attempts } = harness({ connectTimeoutMs: 15_000 })
  supervisor.start()
  const late = last()
  await time.advance(14_999)
  expect(supervisor.state().phase).toBe('connecting')
  await time.advance(1)
  expect(supervisor.state().phase).toBe('backoff')
  expect(supervisor.state().lastError).toBeInstanceOf(ConnectTimeoutError)
  expect(late.attempt.current()).toBe(false)
  const connection = late.resolve()
  await time.advance()
  expect(closed).toEqual([{ id: connection.id, reason: expect.stringMatching(/no longer wanted/u) }])
  expect(supervisor.current()).toBeNull()
  // A timed-out attempt's loss report is not news either.
  late.attempt.lost(new Error('late close'))
  expect(supervisor.state().phase).toBe('backoff')
  await time.advance(supervisor.state().retryAt! - time.now())
  expect(attempts).toHaveLength(2)
})

test('a loss reported before the attempt settled waits for how it settles', async () => {
  const { supervisor, time, last, attempts } = harness({ stableAfterMs: 0 })
  supervisor.start()
  // Handed over and dropped in the same breath: up, then lost, and nobody
  // waiting is handed the connection that is already gone.
  const joined = supervisor.next()
  last().attempt.lost(new Error('dropped at once'))
  expect(supervisor.state().phase).toBe('connecting')
  last().resolve()
  await expect(joined).rejects.toThrow(/dropped at once/u)
  await time.advance()
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', generation: 1, failures: 1, reconnecting: true })
  expect(supervisor.current()).toBeNull()
  // Closed during the handshake, and the attempt then fails: a failed attempt.
  await time.advance(supervisor.state().retryAt! - time.now())
  expect(attempts).toHaveLength(2)
  const waiting = supervisor.next()
  last().attempt.lost(new Error('closed during the handshake'))
  last().reject(new Error('handshake failed'))
  await expect(waiting).rejects.toThrow(/handshake failed/u)
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', generation: 1, failures: 2 })
})

test('a transport may say it is up from the event itself, and a loss in the same tick is a loss of it', async () => {
  const { supervisor, time, closed, last } = harness({ stableAfterMs: 0 })
  supervisor.start()
  const connection: Conn = { id: 99, alive: true }
  last().attempt.connected(connection)
  expect(supervisor.state()).toMatchObject({ phase: 'up', generation: 1 })
  last().attempt.lost(Object.assign(new Error('resync'), { retryAfterMs: 5_000 }))
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', failures: 1, reconnecting: true })
  // The promise resolving to it afterwards changes nothing, and closes nothing.
  last().resolve(connection)
  await time.advance()
  expect(closed).toEqual([])
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', generation: 1 })
})

test('a wake keeps a connection that answers its ping', async () => {
  const { supervisor, time, closed, attempts, last } = harness({ pingTimeoutMs: 10_000 })
  supervisor.start()
  const connection = last().resolve()
  await time.advance()
  supervisor.wake()
  await time.advance(10_000)
  expect(closed).toEqual([])
  expect(attempts).toHaveLength(1)
  expect(supervisor.current()).toBe(connection)
  expect(supervisor.state().phase).toBe('up')
})

test('a wake replaces a connection that does not answer, at once and without a backoff', async () => {
  const { supervisor, time, closed, attempts, last } = harness({ pingTimeoutMs: 10_000 })
  supervisor.start()
  const connection = last().resolve()
  await time.advance()
  // The socket died while the computer slept, and nothing said so.
  connection.alive = false
  supervisor.wake()
  supervisor.wake()
  await time.advance(9_999)
  expect(attempts).toHaveLength(1)
  await time.advance(1)
  expect(closed).toEqual([{ id: connection.id, reason: expect.stringMatching(/stopped answering/u) }])
  expect(attempts).toHaveLength(2)
  expect(supervisor.state()).toMatchObject({ phase: 'connecting', failures: 0, reconnecting: true })
  // The transport's own close report for the replaced connection changes nothing.
  attempts[0]!.attempt.lost(new Error('closed'))
  expect(supervisor.state().phase).toBe('connecting')
})

test('without a ping, a wake trusts an open connection', async () => {
  const { supervisor, time, closed, attempts, last } = harness({ ping: undefined })
  supervisor.start()
  last().resolve()
  await time.advance()
  supervisor.wake()
  await time.advance(60_000)
  expect(closed).toEqual([])
  expect(attempts).toHaveLength(1)
})

test('a wake retries a backoff now, and leaves an attempt in flight alone', async () => {
  const { supervisor, time, attempts, fail, untilRetry } = harness({ backoff: { baseMs: 1_000, maxMs: 300_000 } })
  supervisor.start()
  for (let i = 0; i < 8; i++) {
    await fail()
    await untilRetry()
  }
  await fail()
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', failures: 9 })
  supervisor.wake()
  expect(attempts).toHaveLength(10)
  expect(supervisor.state()).toMatchObject({ phase: 'connecting', failures: 0, retryAt: null })
  supervisor.wake()
  expect(attempts).toHaveLength(10)
  // Its failure starts from the bottom of the ladder.
  await fail()
  expect(supervisor.state()).toMatchObject({ failures: 1, retryAt: time.now() + 1_000 })
})

test('a credential refused waits for the person, not for a wake', async () => {
  const signIn = new Error('Permission denied (publickey)')
  const { supervisor, time, attempts, last } = harness({
    classify: (error): ConnectionFailureVerdict =>
      error === signIn ? { kind: 'needs-sign-in' } : { kind: 'transient' },
  })
  supervisor.start()
  last().resolve()
  await time.advance()
  last().attempt.lost(new Error('dropped'))
  await time.advance(supervisor.state().retryAt! - time.now())
  last().reject(signIn)
  await time.advance()
  expect(supervisor.state()).toMatchObject({ phase: 'needs-sign-in', reconnecting: false, lastError: signIn })
  expect(time.timers()).toBe(0)
  supervisor.wake()
  supervisor.wake({ replace: true })
  await time.advance(600_000)
  expect(attempts).toHaveLength(2)
  await expect(supervisor.next()).rejects.toBe(signIn)
  supervisor.retryNow('person')
  expect(attempts).toHaveLength(3)
  expect(last().attempt).toMatchObject({ hint: 'person', reconnecting: false })
})

test('what retrying cannot fix ends at failed, and the classifier is told what kind of attempt it was', async () => {
  const seen: Array<{ established: boolean; reconnecting: boolean }> = []
  const { supervisor, time, attempts, last } = harness({
    classify: (error, context): ConnectionFailureVerdict => {
      seen.push(context)
      return (error as Error).message === 'unsupported' ? { kind: 'fatal' } : { kind: 'transient' }
    },
  })
  supervisor.start()
  last().resolve()
  await time.advance()
  last().attempt.lost(new Error('dropped'))
  await time.advance(supervisor.state().retryAt! - time.now())
  last().reject(new Error('unsupported'))
  await time.advance()
  expect(seen).toEqual([
    { established: true, reconnecting: true },
    { established: false, reconnecting: true },
  ])
  expect(supervisor.state()).toMatchObject({ phase: 'failed', reconnecting: false })
  supervisor.wake()
  await time.advance(600_000)
  expect(attempts).toHaveLength(2)
  supervisor.retryNow()
  expect(supervisor.state().phase).toBe('connecting')
})

test('a delay the far end asked for is honoured, and a wake does not cut it short', async () => {
  const { supervisor, time, attempts, last } = harness({
    classify: (error): ConnectionFailureVerdict => ({
      kind: 'transient',
      retryAfterMs: (error as { retryAfterMs?: number }).retryAfterMs,
    }),
  })
  supervisor.start()
  last().resolve()
  await time.advance()
  last().attempt.lost(Object.assign(new Error('resync'), { retryAfterMs: 5_000 }))
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', heldByPeer: true, retryAt: 5_000 })
  supervisor.wake()
  await time.advance(4_999)
  expect(attempts).toHaveLength(1)
  await time.advance(1)
  expect(attempts).toHaveLength(2)
  // The person's own retry goes at once, held or not.
  last().reject(Object.assign(new Error('busy'), { retryAfterMs: 60_000 }))
  await time.advance()
  supervisor.retryNow()
  expect(attempts).toHaveLength(3)
})

test('a wake cuts a backoff down to the delay the far end asked for, never below it', async () => {
  const { supervisor, time, attempts, fail, untilRetry } = harness({
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    classify: (error): ConnectionFailureVerdict => ({
      kind: 'transient',
      retryAfterMs: (error as { retryAfterMs?: number }).retryAfterMs,
    }),
  })
  supervisor.start()
  for (let i = 0; i < 3; i++) {
    await fail()
    await untilRetry()
  }
  // Four failures in a row: the backoff's own wait is eight seconds, and the
  // far end asked for three.
  await fail(Object.assign(new Error('busy'), { retryAfterMs: 3_000 }))
  const failedAt = time.now()
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', heldByPeer: true, retryAt: failedAt + 8_000 })
  await time.advance(1_000)
  // The app comes to the front: not at once, and not after eight seconds.
  supervisor.wake()
  expect(attempts).toHaveLength(4)
  expect(supervisor.state()).toMatchObject({ phase: 'backoff', heldByPeer: true, retryAt: failedAt + 3_000 })
  await time.advance(1_999)
  expect(attempts).toHaveLength(4)
  await time.advance(1)
  expect(attempts).toHaveLength(5)
  // Past the far end's delay, a wake goes at once.
  await fail(Object.assign(new Error('busy'), { retryAfterMs: 100 }))
  await time.advance(100)
  supervisor.wake()
  expect(attempts).toHaveLength(6)
})

test('after enough failures in a row it waits for a wake instead of a timer', async () => {
  const { supervisor, time, attempts, fail, untilRetry } = harness({
    parkAfterFailures: 3,
    backoff: { baseMs: 500, maxMs: 60_000 },
  })
  supervisor.start()
  await fail(new Error('away'))
  await untilRetry()
  await fail(new Error('away'))
  await untilRetry()
  await fail(new Error('away'))
  expect(supervisor.state()).toMatchObject({ phase: 'waiting-for-wake', failures: 3 })
  expect(time.timers()).toBe(0)
  await expect(supervisor.next()).rejects.toThrow(/away/u)
  await time.advance(3_600_000)
  expect(attempts).toHaveLength(3)
  supervisor.wake()
  expect(attempts).toHaveLength(4)
  expect(supervisor.state()).toMatchObject({ phase: 'connecting', failures: 0 })
})

test('a connection that opens and drops is not an absence: it backs off but never parks', async () => {
  const { supervisor, time, attempts, last, untilRetry } = harness({ parkAfterFailures: 3, stableAfterMs: 30_000 })
  supervisor.start()
  for (let i = 0; i < 6; i++) {
    last().resolve()
    await time.advance()
    last().attempt.lost(new Error('dropped'))
    expect(supervisor.state().phase).toBe('backoff')
    await untilRetry()
  }
  expect(attempts).toHaveLength(7)
  expect(supervisor.state().failures).toBe(6)
})

test('an attempt hears that it was given up on, to stop its own work, and only then', async () => {
  const { supervisor, time, last } = harness({ connectTimeoutMs: 15_000 })
  const heard: string[] = []
  supervisor.start()
  last().attempt.onAbandoned((reason) => heard.push(`timed out: ${reason}`))
  await time.advance(15_000)
  expect(heard).toEqual([expect.stringMatching(/^timed out: The connection did not open/u)])
  // Asked after the fact, it hears at once.
  last().attempt.onAbandoned(() => heard.push('late listener'))
  expect(heard).toHaveLength(2)
  await time.advance(supervisor.state().retryAt! - time.now())
  last().attempt.onAbandoned(() => heard.push('replaced'))
  supervisor.retryNow()
  expect(heard.at(-1)).toBe('replaced')
  last().attempt.onAbandoned(() => heard.push('stopped'))
  supervisor.stop('Quit.')
  expect(heard.at(-1)).toBe('stopped')
  // One that connects, or fails by itself, hears nothing.
  supervisor.start()
  last().attempt.onAbandoned(() => heard.push('never'))
  last().resolve()
  await time.advance()
  supervisor.start()
  expect(heard).not.toContain('never')
})

test('a listener that calls back into the supervisor never runs inside a transition', async () => {
  const { supervisor, time, attempts, last } = harness()
  const second: string[] = []
  let stopped = false
  supervisor.subscribe((state) => {
    if (state.phase === 'connecting' && !stopped) {
      stopped = true
      supervisor.stop('Not now.')
    }
  })
  supervisor.subscribe((state) => second.push(state.phase))
  const abandoned: string[] = []
  supervisor.start()
  last().attempt.onAbandoned((reason) => abandoned.push(reason))
  // The attempt was made and then let go, whole: one attempt, one stop, and
  // the second listener never hears a 'connecting' that was already over.
  expect(attempts).toHaveLength(1)
  expect(abandoned).toEqual(['Not now.'])
  expect(supervisor.state().phase).toBe('stopped')
  expect(second.at(-1)).toBe('stopped')
  expect(second).not.toContain('connecting')
  last().resolve()
  await time.advance()
  expect(supervisor.state().phase).toBe('stopped')
})

test('a wake pings the connection that is up now, not one an earlier wake pinged', async () => {
  const pinged: number[] = []
  const { supervisor, time, closed, last } = harness({
    pingTimeoutMs: 10_000,
    ping: async (connection) => {
      pinged.push(connection.id)
      if (connection.id === 1) await new Promise(() => undefined)
    },
  })
  supervisor.start()
  last().resolve()
  await time.advance()
  supervisor.wake()
  // The person retries before that ping is answered; a new connection comes up.
  supervisor.retryNow()
  last().resolve()
  await time.advance()
  supervisor.wake()
  await time.advance(10_000)
  expect(pinged).toEqual([1, 2])
  expect(closed.map((entry) => entry.id)).toEqual([1])
  expect(supervisor.current()?.id).toBe(2)
})

test('a replacing wake redials at once, whatever the connection is doing', async () => {
  const { supervisor, time, closed, attempts, last } = harness()
  supervisor.start()
  const connection = last().resolve()
  await time.advance()
  supervisor.wake({ replace: true })
  expect(closed).toEqual([{ id: connection.id, reason: expect.any(String) }])
  expect(attempts).toHaveLength(2)
  // In flight: that attempt is dropped for a new one, and what it brings is closed.
  const abandoned = last()
  supervisor.wake({ replace: true })
  expect(attempts).toHaveLength(3)
  expect(abandoned.attempt.current()).toBe(false)
  abandoned.resolve()
  await time.advance()
  expect(closed).toHaveLength(2)
  last().resolve()
  await time.advance()
  expect(supervisor.state()).toMatchObject({ phase: 'up', generation: 2 })
})

test('next() joins the attempt after a backoff, and hears how it ends', async () => {
  const { supervisor, time, last } = harness()
  supervisor.start()
  last().reject(new Error('refused'))
  await time.advance()
  const first = supervisor.next()
  const second = supervisor.next()
  await time.advance(supervisor.state().retryAt! - time.now())
  last().reject(new Error('refused again'))
  await expect(first).rejects.toThrow(/refused again/u)
  await expect(second).rejects.toThrow(/refused again/u)
  const third = supervisor.next()
  await time.advance(supervisor.state().retryAt! - time.now())
  const connection = last().resolve()
  await expect(third).resolves.toBe(connection)
})

test('stop closes the connection, ends every wait, and ignores what arrives after', async () => {
  const { supervisor, time, closed, attempts, last } = harness()
  supervisor.start()
  const connection = last().resolve()
  await time.advance()
  supervisor.stop('Disconnected.')
  expect(closed).toEqual([{ id: connection.id, reason: 'Disconnected.' }])
  expect(supervisor.state()).toMatchObject({ phase: 'stopped', reconnecting: false })
  last().attempt.lost(new Error('closed'))
  supervisor.wake()
  await time.advance(600_000)
  expect(attempts).toHaveLength(1)
  expect(supervisor.state().phase).toBe('stopped')
  // Stopped mid-attempt: its waiters are told, and its connection is closed when it comes.
  supervisor.start()
  const waiting = supervisor.next()
  const pending = last()
  supervisor.stop('Quit.')
  await expect(waiting).rejects.toThrow(/Quit/u)
  pending.resolve()
  await time.advance()
  expect(closed).toHaveLength(2)
  expect(supervisor.current()).toBeNull()
})

test('retryNow replaces a live connection or an attempt in flight, and from a backoff goes at once', async () => {
  const { supervisor, time, closed, attempts, last } = harness()
  supervisor.start()
  const first = last()
  supervisor.retryNow('sooner')
  expect(first.attempt.current()).toBe(false)
  expect(attempts).toHaveLength(2)
  expect(last().attempt.hint).toBe('sooner')
  first.resolve()
  await time.advance()
  expect(closed).toHaveLength(1)
  last().resolve()
  await time.advance()
  supervisor.retryNow('again')
  expect(closed).toHaveLength(2)
  expect(attempts).toHaveLength(3)
  expect(last().attempt.hint).toBe('again')
  last().reject(new Error('refused'))
  await time.advance()
  supervisor.retryNow()
  expect(attempts).toHaveLength(4)
})

test('a connect that throws at once is a failed attempt, and a listener that throws is its own problem', async () => {
  const time = fakeClock()
  const supervisor = new ConnectionSupervisor<Conn>({
    connect: () => {
      throw new Error('no socket API here')
    },
    close: () => undefined,
    clock: time.clock,
    random: () => 1,
  })
  supervisor.subscribe(() => {
    throw new Error('listener bug')
  })
  const seen: ConnectionPhase[] = []
  const unsubscribe = supervisor.subscribe((state) => seen.push(state.phase))
  supervisor.start()
  await time.advance()
  expect(supervisor.state().phase).toBe('backoff')
  expect(seen).toEqual(['connecting', 'backoff'])
  unsubscribe()
  supervisor.stop('done')
  expect(seen).toEqual(['connecting', 'backoff'])
})

test('the cap may follow the state, so a long outage can be retried more slowly', async () => {
  const { supervisor, time, last } = harness({
    backoff: { baseMs: 1_000, maxMs: (state) => (state.retryingForMs >= 10_000 ? 300_000 : 2_000) },
  })
  supervisor.start()
  const delays: number[] = []
  for (let i = 0; i < 8; i++) {
    last().reject(new Error('refused'))
    await time.advance()
    delays.push(supervisor.state().retryAt! - time.now())
    await time.advance(delays.at(-1)!)
  }
  expect(delays).toEqual([1_000, 2_000, 2_000, 2_000, 2_000, 2_000, 64_000, 128_000])
})
