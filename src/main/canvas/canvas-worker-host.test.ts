/**
 * The canvas worker host: correlation, deadlines, the one restart, the idle
 * stop, and the single-file queue.
 *
 * Every one of those is a rule about what happens when the worker misbehaves,
 * so the transport here is a stub that misbehaves on demand and the clock is a
 * list of callbacks — a test that had to wait out a twenty-second deadline
 * would never be run.
 */
import assert from 'node:assert/strict'

import { createCanvasWorkerHost, type CanvasWorkerTransport } from './canvas-worker-host'
import type { CanvasWorkerRequest, CanvasWorkerResponse } from '../../shared/canvas/worker-protocol'
import { test } from 'vitest'

test('canvas-worker-host', async () => {
  type FakeClock = {
    setTimer: (fn: () => void, ms: number) => { cancel(): void }
    advance: (ms: number) => void
  }

  function createClock(): FakeClock {
    let now = 0
    let nextId = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    return {
      setTimer(fn, ms) {
        const id = nextId++
        timers.set(id, { at: now + ms, fn })
        return { cancel: () => timers.delete(id) }
      },
      advance(ms) {
        now += ms
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(id)
          timer.fn()
        }
      },
    }
  }

  type FakeTransport = {
    transport: CanvasWorkerTransport
    posted: CanvasWorkerRequest[]
    counts: { starts: number; stops: number }
    failNextStart: () => void
    respond: (response: CanvasWorkerResponse) => void
    crash: () => void
  }

  function createTransport(): FakeTransport {
    const posted: CanvasWorkerRequest[] = []
    const counts = { starts: 0, stops: 0 }
    let onResponse: ((response: CanvasWorkerResponse) => void) | null = null
    let onCrashed: ((reason: string) => void) | null = null
    let startFails = false
    return {
      posted,
      counts,
      failNextStart: () => {
        startFails = true
      },
      respond: (response) => onResponse?.(response),
      crash: () => onCrashed?.('gone'),
      transport: {
        ensureStarted: async () => {
          counts.starts += 1
          if (startFails) {
            startFails = false
            throw new Error('the worker never reported ready')
          }
        },
        post: (request) => posted.push(request),
        report: () => null,
        onResponse: (cb) => {
          onResponse = cb
          return () => {
            onResponse = null
          }
        },
        onCrashed: (cb) => {
          onCrashed = cb
          return () => {
            onCrashed = null
          }
        },
        stop: () => {
          counts.stops += 1
        },
      },
    }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await new Promise((settle) => setImmediate(settle))
  }

  const layoutRequest = { kind: 'layout' as const, elements: [], request: { op: 'align' as const, elementIds: [] } }

  async function assertCorrelation(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })

    const call = host.call(layoutRequest)
    await flush()
    assert.equal(fake.posted.length, 1, 'the request reaches the worker')
    const requestId = fake.posted[0].requestId
    assert.ok(requestId.length > 0, 'the host mints a request id')

    // Somebody else's answer, and a late one of our own shape: neither is ours.
    fake.respond({
      kind: 'layout',
      requestId: 'another-request',
      ok: true,
      elements: [{ id: 'wrong', type: 'rectangle', version: 1, versionNonce: 1 }],
      changed: [],
    })
    fake.respond({
      kind: 'layout',
      requestId,
      ok: true,
      elements: [{ id: 'right', type: 'rectangle', version: 1, versionNonce: 1 }],
      changed: [],
    })

    const answer = await call
    assert.ok(answer.ok, 'the matching answer settles the call')
    assert.equal(answer.value.elements[0].id, 'right', 'the answer is the one whose id matched')
    console.log('ok - a worker answer is correlated by request id and nothing else')
  }

  async function assertTimeout(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })

    const call = host.call(layoutRequest)
    await flush()
    // 20 s, plus the cold-start grace the first call after a start is given.
    clock.advance(20_000 + 15_000 + 1)
    const answer = await call
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.error.code, 'timeout')
    assert.equal(fake.posted.length, 1, 'a timeout is not retried')
    assert.equal(fake.counts.stops, 1, 'the worker that did not answer is stopped')

    // It serves one request at a time, so the one it never finished would hold
    // this one too: the next call goes to a fresh worker instead.
    const next = host.call(layoutRequest)
    await flush()
    assert.equal(fake.counts.starts, 2, 'the next call starts a new worker')
    assert.equal(fake.posted.length, 2)
    fake.respond({ kind: 'layout', requestId: fake.posted[1].requestId, ok: true, elements: [], changed: [] })
    assert.ok((await next).ok, 'and the new worker answers it')
    console.log('ok - a worker that does not answer in time fails the call as a timeout, and is replaced')
  }

  async function assertCrashRestartsOnce(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })

    const call = host.call(layoutRequest)
    await flush()
    assert.equal(fake.counts.starts, 1)
    fake.crash()
    await flush()
    assert.equal(fake.counts.starts, 2, 'the worker is started again for the retry')
    assert.equal(fake.posted.length, 2, 'and the request is posted again')
    assert.notEqual(fake.posted[1].requestId, fake.posted[0].requestId, 'the retry carries a new id')

    fake.respond({ kind: 'layout', requestId: fake.posted[1].requestId, ok: true, elements: [], changed: [] })
    const answer = await call
    assert.ok(answer.ok, 'the retry is the answer')

    // A second crash inside one call is not retried again.
    const second = host.call(layoutRequest)
    await flush()
    fake.crash()
    await flush()
    fake.crash()
    await flush()
    const failure = await second
    assert.equal(failure.ok, false)
    assert.equal(failure.ok === false && failure.error.code, 'worker_unavailable')
    console.log('ok - a crashed worker is restarted for one retry, and no more than one')
  }

  async function assertStartFailure(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })
    fake.failNextStart()

    const call = host.call(layoutRequest)
    await flush()
    // The retry's start succeeds, so the call is still live and waiting.
    assert.equal(fake.counts.starts, 2)
    assert.equal(fake.posted.length, 1, 'only the retry got as far as posting')
    fake.respond({ kind: 'layout', requestId: fake.posted[0].requestId, ok: true, elements: [], changed: [] })
    const answer = await call
    assert.ok(answer.ok, 'a worker that failed to start once still answers on the retry')
    console.log('ok - a worker that never signals ready is restarted the same way a crash is')
  }

  async function assertSerial(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })

    const first = host.call(layoutRequest)
    const second = host.call(layoutRequest)
    await flush()
    assert.equal(fake.posted.length, 1, 'the second request waits its turn')

    fake.respond({ kind: 'layout', requestId: fake.posted[0].requestId, ok: true, elements: [], changed: [] })
    await first
    await flush()
    assert.equal(fake.posted.length, 2, 'and is posted once the first is answered')
    fake.respond({ kind: 'layout', requestId: fake.posted[1].requestId, ok: true, elements: [], changed: [] })
    assert.ok((await second).ok)
    console.log('ok - the worker holds one request at a time and queues the rest')
  }

  async function assertIdleStop(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })

    const call = host.call(layoutRequest)
    await flush()
    fake.respond({ kind: 'layout', requestId: fake.posted[0].requestId, ok: true, elements: [], changed: [] })
    await call
    await flush()

    assert.equal(fake.counts.stops, 0, 'a worker that just answered is kept')
    clock.advance(5 * 60 * 1000 + 1)
    assert.equal(fake.counts.stops, 1, 'and is stopped once nobody has needed it for five minutes')

    const next = host.call(layoutRequest)
    await flush()
    assert.equal(fake.counts.starts, 2, 'the next call brings it back')
    fake.respond({ kind: 'layout', requestId: fake.posted[1].requestId, ok: true, elements: [], changed: [] })
    assert.ok((await next).ok)
    console.log('ok - an idle worker is disposed and the next call starts a new one')
  }

  async function assertDisposeAnswersQueuedCalls(): Promise<void> {
    const clock = createClock()
    const fake = createTransport()
    const host = createCanvasWorkerHost({ transport: fake.transport, setTimer: clock.setTimer })

    const first = host.call(layoutRequest)
    const queued = host.call(layoutRequest)
    await flush()
    await host.dispose()

    const answer = await queued
    assert.equal(answer.ok, false)
    assert.equal(answer.ok === false && answer.error.code, 'worker_unavailable')
    assert.equal(fake.counts.stops, 1, 'dispose stops the transport')

    // The in-flight one is left to its own deadline rather than being lost.
    clock.advance(20_000 + 15_000 + 1)
    assert.equal((await first).ok, false)

    const after = await host.call(layoutRequest)
    assert.equal(after.ok === false && after.error.code, 'worker_unavailable', 'a disposed host takes no new work')
    console.log('ok - disposing the host answers every call it was holding')
  }

  async function main(): Promise<void> {
    await assertCorrelation()
    await assertTimeout()
    await assertCrashRestartsOnce()
    await assertStartFailure()
    await assertSerial()
    await assertIdleStop()
    await assertDisposeAnswersQueuedCalls()
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
