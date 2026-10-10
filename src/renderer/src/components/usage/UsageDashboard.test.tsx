// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { UsageReport, UsageReportRequest, UsageReportResult } from '../../../../shared/usage-report'
import UsageDashboard from './UsageDashboard'

// The dashboard as a person opens it: one request for the range on show,
// the total and each agent's share of it, and every model in the breakdown,
// a model nothing prices saying so rather than $0.

const requests: UsageReportRequest[] = []
let answer: UsageReportResult
let root: Root | null = null
let host: HTMLElement | null = null

const now = Date.now()
const tokens = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0 })

const REPORT: UsageReport = {
  from: now - 30 * 86_400_000,
  to: now,
  scannedAt: now,
  pricing: { source: 'live', fetchedAt: now },
  totals: {
    tokens: tokens(1_000, 2_000, 1_000_000),
    costUsd: 1234.5,
    cacheSavingsUsd: 99,
    sessions: 12,
    requests: 40,
    unpricedTokens: 500,
  },
  agents: [
    { id: 'claude-code', sessions: 10, tokens: tokens(900, 1_900, 1_000_000), costUsd: 1200, unpricedTokens: 0 },
    { id: 'opencode', sessions: 2, tokens: tokens(100, 100), costUsd: 34.5, unpricedTokens: 500 },
  ],
  models: [
    {
      agent: 'claude-code',
      model: 'claude-opus-5-5',
      tokens: tokens(900, 1_900, 1_000_000),
      costUsd: 1200,
      requests: 30,
    },
    { agent: 'opencode', model: 'mimo-free', tokens: tokens(100, 100), costUsd: null, requests: 10 },
  ],
  points: [{ hour: Math.floor(now / 3_600_000) * 3_600_000, agent: 'claude-code', tokens: 1_002_800, costUsd: 1200 }],
  sources: [{ id: 'claude-code', found: 10, error: null }],
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  requests.length = 0
  answer = { ok: true, report: REPORT }
  ;(window as unknown as { api: unknown }).api = {
    usageReport: async (request: UsageReportRequest) => {
      requests.push(request)
      return answer
    },
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(<UsageDashboard />))
  return host
}

test('opens on the last 30 days of cost: the total, each agent, and every model', async () => {
  const view = await mount()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.to - requests[0]!.from).toBeGreaterThan(29 * 86_400_000)
  const text = view.textContent ?? ''
  expect(text).toContain('$1,234.50')
  expect(text).toContain('12 sessions')
  expect(text).toContain('API estimate')
  const agents = [...view.querySelectorAll('ul[aria-label="By agent"] > li')].map((item) => item.textContent ?? '')
  expect(agents[0]).toContain('Claude Code')
  expect(agents[0]).toContain('$1,200.00')
  expect(agents[1]).toContain('OpenCode')
  const rows = [...view.querySelectorAll('table[aria-label="Usage by model"] tbody tr')].map((row) => row.textContent)
  expect(rows[0]).toContain('claude-opus-5-5')
  expect(rows[1]).toContain('mimo-free')
  expect(rows[1]).toContain('Unpriced')
  expect(text).toContain('Cache savings')
  expect(text).toContain('$99.00')
})

test('a failed read says so and offers to try again', async () => {
  answer = { ok: false, message: 'could not read the logs' }
  const view = await mount()
  expect(view.textContent).toContain('Usage could not be read')
  const retry = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  await act(async () => retry.click())
  expect(requests.at(-1)?.refresh).toBe(true)
})
