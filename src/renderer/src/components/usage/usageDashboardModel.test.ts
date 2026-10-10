import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { UsageReport } from '../../../../shared/usage-report'
import { monotonePath, niceScale, periodIndex, usagePeriodRows, usageSeries, usageWindow } from './usageDashboardModel'

const HOUR = 3_600_000

test('the past 24h is the 24 whole hours up to this one', () => {
  const now = Date.parse('2026-10-10T15:42:00Z')
  const window = usageWindow('24h', now)
  assert.equal(window.unit, 'hour')
  assert.equal(window.periods.length, 24)
  assert.equal(window.periods.at(-1), Date.parse('2026-10-10T15:00:00Z'))
  assert.equal(window.from, Date.parse('2026-10-09T16:00:00Z'))
  assert.equal(window.to, now)
})

test('a range of days is that many local calendar days, today included, each starting at midnight', () => {
  const now = new Date(2026, 9, 10, 15, 42).getTime()
  const window = usageWindow('7d', now)
  assert.equal(window.unit, 'day')
  assert.equal(window.periods.length, 7)
  assert.equal(window.from, new Date(2026, 9, 4).getTime())
  for (const start of window.periods) {
    const date = new Date(start)
    assert.equal(date.getHours() + date.getMinutes(), 0)
  }
  assert.equal(usageWindow('90d', now).periods.length, 90)
})

test('periodIndex finds the period an instant falls in', () => {
  const periods = [0, 10, 20]
  assert.equal(periodIndex(periods, -1), -1)
  assert.equal(periodIndex(periods, 0), 0)
  assert.equal(periodIndex(periods, 19), 1)
  assert.equal(periodIndex(periods, 500), 2)
})

const report = (points: UsageReport['points']): UsageReport => ({
  from: 0,
  to: 0,
  scannedAt: null,
  pricing: { source: 'bundled', fetchedAt: null },
  totals: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    cacheSavingsUsd: 0,
    sessions: 0,
    requests: 0,
    unpricedTokens: 0,
  },
  agents: [
    {
      id: 'claude-code',
      sessions: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      unpricedTokens: 0,
    },
  ],
  models: [],
  points,
  sources: [],
})

test('hourly points fold into the periods they fall in, per agent', () => {
  const window = { from: 0, to: 3 * HOUR, unit: 'hour' as const, periods: [0, HOUR, 2 * HOUR] }
  const data = report([
    { hour: 0, agent: 'claude-code', tokens: 10, costUsd: 1 },
    { hour: 2 * HOUR, agent: 'claude-code', tokens: 5, costUsd: 2 },
    { hour: 2 * HOUR, agent: 'codex', tokens: 7, costUsd: 0.5 },
  ])
  const cost = usageSeries(data, window, 'cost')
  assert.deepEqual(
    cost.map((entry) => [entry.agent, entry.values, entry.total]),
    [
      ['claude-code', [1, 0, 2], 3],
      ['codex', [0, 0, 0.5], 0.5],
    ],
  )
  assert.deepEqual(usageSeries(data, window, 'tokens')[0]!.values, [10, 0, 5])
  const rows = usagePeriodRows(data, window)
  assert.deepEqual(
    rows.map((row) => [row.start, row.costUsd, row.tokens, row.byAgent.length]),
    [
      [2 * HOUR, 2.5, 12, 2],
      [0, 1, 10, 1],
    ],
    'newest first, empty periods left out',
  )
})

test('niceScale tops the axis at a round number at or above the max', () => {
  assert.deepEqual(niceScale(912, 2), { top: 1000, step: 500 })
  assert.deepEqual(niceScale(1100, 2), { top: 1200, step: 600 })
  assert.deepEqual(niceScale(2.9e9, 3), { top: 3e9, step: 1e9 })
  assert.deepEqual(niceScale(0, 2), { top: 1, step: 0.5 })
  assert.ok(niceScale(0.03, 2).top >= 0.03)
})

test('the curve passes through every point and never dips below a zero baseline', () => {
  const points: Array<[number, number]> = [
    [0, 100],
    [10, 100],
    [20, 0],
    [30, 100],
    [40, 100],
  ]
  const d = monotonePath(points)
  assert.ok(d.startsWith('M0,100'))
  for (const [x, y] of points.slice(1)) assert.ok(d.includes(` ${x},${y}`), `passes through ${x},${y}`)
  // Every control point stays within the y range of the points (y=0 top … 100 baseline).
  const numbers = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const ys = numbers.filter((_, index) => index % 2 === 1)
  assert.ok(Math.max(...ys) <= 100 && Math.min(...ys) >= 0)
  assert.equal(monotonePath([]), '')
  assert.equal(monotonePath([[5, 5]]), 'M5,5')
})
