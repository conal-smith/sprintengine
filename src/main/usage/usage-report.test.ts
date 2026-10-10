import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { UsageRow } from '../../shared/modules/activity-service'
import { createPricing } from './usage-pricing'
import { buildUsageReport } from './usage-report'

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-08T09:00:00.000Z')

const row = (partial: Partial<UsageRow> & Pick<UsageRow, 'tokens'>): UsageRow => ({
  day: String(T0),
  providerId: 'claude-agent',
  model: 'm-priced',
  sessionId: 's1',
  requests: 1,
  reportedCostUsd: null,
  ...partial,
})

const pricing = createPricing(new Map([['m-priced', { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 }]]), {
  source: 'live',
  fetchedAt: 5,
})

test('rows are priced by model, a reported cost is kept, and an unknown model is unpriced', () => {
  const report = buildUsageReport({
    from: T0,
    to: T0 + 24 * HOUR,
    scannedAt: 9,
    sources: [{ id: 'claude-code', found: 2, error: null }],
    pricing,
    rows: [
      row({ tokens: { input: 2, output: 1, cacheRead: 10, cacheWrite: 4 } }),
      row({ sessionId: 's2', day: String(T0 + HOUR), tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      // OpenCode priced this turn itself.
      row({
        providerId: 'opencode-agent',
        model: 'free-model',
        sessionId: 'o1',
        reportedCostUsd: 0.5,
        tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      row({
        providerId: 'codex-agent',
        model: 'gpt-mystery',
        sessionId: 'c1',
        tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
      }),
    ],
  })

  // 2*1 + 1*10 + 10*0.1 + 4*1.25 = 18, plus 1 for the second row.
  const claude = report.agents.find((agent) => agent.id === 'claude-code')!
  assert.equal(claude.costUsd, 19)
  assert.equal(claude.sessions, 2)
  assert.equal(report.agents.find((agent) => agent.id === 'opencode')!.costUsd, 0.5)
  const codex = report.agents.find((agent) => agent.id === 'codex')!
  assert.equal(codex.costUsd, 0)
  assert.equal(codex.unpricedTokens, 10)

  assert.equal(report.totals.costUsd, 19.5)
  assert.equal(report.totals.sessions, 4)
  assert.equal(report.totals.unpricedTokens, 10)
  // Ten cache reads at 0.1 instead of 1.
  assert.ok(Math.abs(report.totals.cacheSavingsUsd - 9) < 1e-9)
  assert.deepEqual(report.totals.tokens, { input: 110, output: 4, cacheRead: 10, cacheWrite: 4 })

  assert.equal(report.models.find((model) => model.model === 'gpt-mystery')!.costUsd, null)
  assert.equal(report.models[0]!.model, 'm-priced', 'the costliest model first')
  assert.deepEqual(report.pricing, { source: 'live', fetchedAt: 5 })

  const claudePoints = report.points.filter((point) => point.agent === 'claude-code')
  assert.deepEqual(
    claudePoints.map((point) => [point.hour, point.costUsd, point.tokens]),
    [
      [T0, 18, 17],
      [T0 + HOUR, 1, 1],
    ],
  )
})
