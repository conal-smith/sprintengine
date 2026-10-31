// The pull-request watch's clock: two minutes while a window is in front, far
// less often while none is, and one prompt probe when a window comes back.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import {
  createPullRequestWatchPoller,
  PR_WATCH_FOCUS_FRESH_MS,
  PR_WATCH_FOCUS_SETTLE_MS,
  PR_WATCH_FOCUS_SPREAD_MS,
  PR_WATCH_SWEEP_GATHER_MS,
  PR_WATCH_UNFOCUSED_MS,
  type WatchPollerFocus,
} from './pull-request-watch-poller'

const MINUTE = 60_000
const URL = 'https://github.com/acme/app/pull/12'

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 8, 9, 0) })
})
afterEach(() => {
  vi.useRealTimers()
})

function focus(initial: boolean): WatchPollerFocus & { set(next: boolean): void } {
  let focused = initial
  const listeners = new Set<(focused: boolean) => void>()
  return {
    isFocused: () => focused,
    onFocusChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      focused = next
      for (const listener of listeners) listener(next)
    },
  }
}

function poller(window: ReturnType<typeof focus>) {
  const probes: number[] = []
  const watch = createPullRequestWatchPoller({
    isWatchable: () => true,
    probe: async () => {
      probes.push(Date.now())
    },
    focus: window,
    jitterRatio: 0,
    random: () => 0.5,
  })
  watch.begin()
  return { watch, probes }
}

test('with a window in front, an open pull request is probed at one, then every two minutes', async () => {
  const { watch, probes } = poller(focus(true))
  const start = Date.now()
  watch.arm(URL)
  await vi.advanceTimersByTimeAsync(5 * MINUTE)
  assert.deepEqual(
    probes.map((at) => at - start),
    [MINUTE, 3 * MINUTE, 5 * MINUTE],
  )
  watch.dispose()
})

test('with no window in front, the probes stretch to the unfocused delay', async () => {
  const { watch, probes } = poller(focus(false))
  const start = Date.now()
  watch.arm(URL)
  await vi.advanceTimersByTimeAsync(30 * MINUTE)
  assert.deepEqual(
    probes.map((at) => at - start),
    [PR_WATCH_UNFOCUSED_MS, 2 * PR_WATCH_UNFOCUSED_MS, 3 * PR_WATCH_UNFOCUSED_MS],
  )
  watch.dispose()
})

test('a window coming back probes once, shortly, and the two-minute schedule resumes', async () => {
  const window = focus(false)
  const { watch, probes } = poller(window)
  watch.arm(URL)
  await vi.advanceTimersByTimeAsync(3 * MINUTE)
  assert.equal(probes.length, 0, 'nobody looking: still waiting out the long delay')

  const back = Date.now()
  window.set(true)
  await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_SPREAD_MS)
  assert.equal(probes.length, 1)
  assert.ok(probes[0]! - back <= PR_WATCH_FOCUS_SPREAD_MS)
  await vi.advanceTimersByTimeAsync(2 * MINUTE)
  assert.equal(probes.length, 2, 'then every couple of minutes again')

  // Gone to the background again: the next wait is the long one.
  window.set(false)
  await vi.advanceTimersByTimeAsync(2 * MINUTE)
  const count = probes.length
  await vi.advanceTimersByTimeAsync(5 * MINUTE)
  assert.equal(probes.length, count)
  await vi.advanceTimersByTimeAsync(PR_WATCH_UNFOCUSED_MS)
  assert.equal(probes.length, count + 1)
  watch.dispose()
})

test('a disposed poller stops hearing focus', async () => {
  const window = focus(false)
  const { watch, probes } = poller(window)
  watch.arm(URL)
  watch.dispose()
  window.set(true)
  await vi.advanceTimersByTimeAsync(PR_WATCH_UNFOCUSED_MS * 2)
  assert.deepEqual(probes, [])
})

test('a key that keeps its pace is probed every two minutes with no window in front', async () => {
  const probes: string[] = []
  const watch = createPullRequestWatchPoller({
    isWatchable: () => true,
    probe: async (key) => {
      probes.push(key)
    },
    keepsPace: (key) => key === URL,
    focus: focus(false),
    jitterRatio: 0,
    random: () => 0.5,
  })
  watch.begin()
  const other = 'https://github.com/acme/app/pull/13'
  watch.arm(URL)
  watch.arm(other)
  await vi.advanceTimersByTimeAsync(5 * MINUTE)
  assert.deepEqual(probes, [URL, URL, URL], 'an agent waiting on it is looking; nobody is looking at the other')
  watch.dispose()
})

test('a window that comes back for a moment and goes again probes nothing', async () => {
  const window = focus(false)
  const { watch, probes } = poller(window)
  watch.arm(URL)
  await vi.advanceTimersByTimeAsync(3 * MINUTE)
  // An editor and back, ten times over: blur and focus a moment apart.
  for (let flap = 0; flap < 10; flap += 1) {
    window.set(true)
    await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_SETTLE_MS / 2)
    window.set(false)
    await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_SETTLE_MS)
  }
  await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_SPREAD_MS)
  assert.deepEqual(probes, [], 'no return settled, so nothing is probed early')
  watch.dispose()
})

test('a window coming back does not probe a key read inside the fresh window', async () => {
  const window = focus(true)
  const { watch, probes } = poller(window)
  watch.arm(URL)
  await vi.advanceTimersByTimeAsync(MINUTE)
  assert.equal(probes.length, 1, 'the first probe, at one minute')

  // Away and back, well inside a minute of that probe, and staying in front.
  window.set(false)
  await vi.advanceTimersByTimeAsync(5_000)
  window.set(true)
  await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_SETTLE_MS + PR_WATCH_FOCUS_SPREAD_MS)
  assert.equal(probes.length, 1, 'just read: its state is as fresh as a prompt probe would make it')
  watch.dispose()
})

test('a window coming back after the fresh window probes the key once, shortly', async () => {
  const window = focus(true)
  const { watch, probes } = poller(window)
  watch.arm(URL)
  await vi.advanceTimersByTimeAsync(MINUTE)
  window.set(false)
  await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_FRESH_MS)
  const back = Date.now()
  window.set(true)
  await vi.advanceTimersByTimeAsync(PR_WATCH_FOCUS_SETTLE_MS + PR_WATCH_FOCUS_SPREAD_MS)
  assert.equal(probes.length, 2)
  assert.ok(probes[1]! - back <= PR_WATCH_FOCUS_SETTLE_MS + PR_WATCH_FOCUS_SPREAD_MS)
  watch.dispose()
})

test('keys due close together are probed as one sweep, and fall into step', async () => {
  const sweeps: Array<{ at: number; keys: string[] }> = []
  const single: string[] = []
  const watch = createPullRequestWatchPoller({
    isWatchable: () => true,
    probe: async (key) => void single.push(key),
    probeMany: async (keys) => void sweeps.push({ at: Date.now(), keys: [...keys].sort() }),
    focus: focus(true),
    jitterRatio: 0,
    random: () => 0.5,
  })
  watch.begin()
  const start = Date.now()
  watch.arm('a')
  await vi.advanceTimersByTimeAsync(20_000)
  watch.arm('b')
  await vi.advanceTimersByTimeAsync(PR_WATCH_SWEEP_GATHER_MS)
  watch.arm('far')
  // 'a' is due at one minute; 'b' (at 1:20) is inside the gather window, so it
  // is taken along; 'far' was armed too late to be.
  await vi.advanceTimersByTimeAsync(5 * MINUTE)
  assert.deepEqual(single, [], 'a sweep-capable consumer is never probed key by key')
  assert.deepEqual(sweeps[0], { at: start + MINUTE, keys: ['a', 'b'] })
  // From then on every key is in the same sweep, on the two-minute pace.
  const later = sweeps.filter((sweep) => sweep.keys.length === 3)
  assert.ok(later.length >= 1, JSON.stringify(sweeps))
  const firstFull = sweeps.indexOf(later[0]!)
  for (const sweep of sweeps.slice(firstFull)) assert.deepEqual(sweep.keys, ['a', 'b', 'far'])
  watch.dispose()
})
