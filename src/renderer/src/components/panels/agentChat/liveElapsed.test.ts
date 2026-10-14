import { expect, test, vi } from 'vitest'
import { formatClockTime, formatElapsedMs, formatMessageTime } from './liveElapsed'

// Local-time instants, so the calendar arithmetic is what the reader sees.
const at = (year: number, month: number, day: number, hour = 14, minute = 5) =>
  new Date(year, month - 1, day, hour, minute).getTime()
const now = at(2026, 9, 27, 9, 30)

test('a time from today is the clock alone', () => {
  expect(formatMessageTime(at(2026, 9, 27, 0, 10), now)).toBe(formatClockTime(at(2026, 9, 27, 0, 10)))
  expect(formatMessageTime(now, now)).toBe(formatClockTime(now))
})

test('yesterday is named, even when it was less than a day ago', () => {
  const lateLastNight = at(2026, 9, 26, 23, 50)
  expect(formatMessageTime(lateLastNight, now)).toBe(`Yesterday ${formatClockTime(lateLastNight)}`)
})

test('within the week the weekday stands in for the date', () => {
  const tuesday = at(2026, 9, 22)
  const weekday = new Date(tuesday).toLocaleDateString([], { weekday: 'short' })
  expect(formatMessageTime(tuesday, now)).toBe(`${weekday} ${formatClockTime(tuesday)}`)
})

test('a week or more back reads as a date, with the year once it is not this one', () => {
  const lastWeek = at(2026, 9, 20)
  const thisYear = formatMessageTime(lastWeek, now)
  expect(thisYear).toBe(
    `${new Date(lastWeek).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${formatClockTime(lastWeek)}`,
  )
  expect(thisYear).not.toContain('2026')
  expect(formatMessageTime(at(2025, 12, 30), now)).toContain('2025')
})

test('a time ahead of now is not called yesterday or a weekday', () => {
  const tomorrow = at(2026, 9, 28)
  expect(formatMessageTime(tomorrow, now)).toBe(
    `${new Date(tomorrow).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${formatClockTime(tomorrow)}`,
  )
})

// Every live counter rides one shared 1 s clock instead of an interval each,
// and a counter in a mounted-but-hidden workspace layer skips its writes.
test('live counters share one clock and hold their text in a hidden layer', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  class InViewObserver {
    constructor(private readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true }])
    }
    unobserve() {}
    disconnect() {}
  }
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IntersectionObserver: InViewObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { LiveElapsed } = await import('./liveElapsed')
    const start = Date.now()
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement('p', { id: 'shown' }, createElement(LiveElapsed, { startedAt: start })),
          createElement(
            'div',
            { 'data-layer-state': 'warm' },
            createElement('p', { id: 'warm' }, createElement(LiveElapsed, { startedAt: start })),
          ),
          createElement('p', null, createElement(LiveElapsed, { startedAt: start - 5000 })),
        ),
      ),
    )
    expect(vi.getTimerCount(), 'three counters, one clock').toBe(1)
    await act(async () => void vi.advanceTimersByTime(3000))
    const text = (id: string) => dom.window.document.getElementById(id)!.textContent
    expect(text('shown')).toBe('3s')
    expect(text('warm'), 'nobody can see a warm layer, so its counter is not written').toBe('0s')
    await act(async () => root.unmount())
    expect(vi.getTimerCount(), 'the clock stops with its last counter').toBe(0)
  } finally {
    vi.useRealTimers()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a long run is counted in hours, not hundreds of minutes', () => {
  expect(formatElapsedMs(59_000)).toBe('59s')
  expect(formatElapsedMs(3_599_000)).toBe('59m 59s')
  expect(formatElapsedMs(3_600_000)).toBe('1h 0m 0s')
  expect(formatElapsedMs(25_190_000)).toBe('6h 59m 50s')
})
