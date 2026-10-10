import type { UsageRow, UsageSource } from '../../shared/modules/activity-service'
import {
  usageAgentOf,
  usageTokenTotal,
  type UsageAgentId,
  type UsageReport,
  type UsageReportAgent,
  type UsageReportModel,
  type UsageReportPoint,
  type UsageReportTokens,
} from '../../shared/usage-report'
import type { UsagePricing } from './usage-pricing'

// The dashboard's answer, built from the usage service's rows grouped by
// hour, provider, model and session. Each row is priced once:
//
// - a cost the agent reported for the turns it priced itself (OpenCode, Grok,
//   a Studio chat whose CLI log is not on this machine) is kept as it is;
// - every other row is priced from its model's list price;
// - a row neither covers is unpriced: its tokens count, its cost does not.
//
// Cache savings are what the cache reads would have cost at full input price,
// less what they cost as reads, for the rows a list price covers.

const zeroTokens = (): UsageReportTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function addTokens(into: UsageReportTokens, from: UsageReportTokens): void {
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
}

export function buildUsageReport(input: {
  /** Rows grouped by `day` (an hour's start, as a string), `provider`, `model` and `session`. */
  rows: readonly UsageRow[]
  from: number
  to: number
  scannedAt: number | null
  sources: readonly UsageSource[]
  pricing: UsagePricing
}): UsageReport {
  const { pricing } = input
  const agents = new Map<UsageAgentId, UsageReportAgent & { sessionIds: Set<string> }>()
  const models = new Map<string, UsageReportModel>()
  const points = new Map<string, UsageReportPoint>()
  const totals: UsageReport['totals'] = {
    tokens: zeroTokens(),
    costUsd: 0,
    cacheSavingsUsd: 0,
    sessions: 0,
    requests: 0,
    unpricedTokens: 0,
  }

  for (const row of input.rows) {
    const agent = usageAgentOf(row.providerId ?? '')
    const model = row.model ?? 'unknown'
    const hour = Number(row.day)
    const tokens = row.tokens
    const total = usageTokenTotal(tokens)
    const rates = pricing.ratesFor(model)
    let cost: number | null = null
    if (row.reportedCostUsd !== null && row.reportedCostUsd > 0) cost = row.reportedCostUsd
    else if (rates) {
      cost =
        tokens.input * rates.input +
        tokens.output * rates.output +
        tokens.cacheRead * rates.cacheRead +
        tokens.cacheWrite * rates.cacheWrite
    }
    if (rates) totals.cacheSavingsUsd += tokens.cacheRead * Math.max(0, rates.input - rates.cacheRead)

    let agentRow = agents.get(agent)
    if (!agentRow) {
      agentRow = { id: agent, sessions: 0, tokens: zeroTokens(), costUsd: 0, unpricedTokens: 0, sessionIds: new Set() }
      agents.set(agent, agentRow)
    }
    addTokens(agentRow.tokens, tokens)
    agentRow.costUsd += cost ?? 0
    if (cost === null) agentRow.unpricedTokens += total
    if (row.sessionId) agentRow.sessionIds.add(row.sessionId)

    const modelKey = `${agent}\u0000${model}`
    let modelRow = models.get(modelKey)
    if (!modelRow) {
      modelRow = { agent, model, tokens: zeroTokens(), costUsd: null, requests: 0 }
      models.set(modelKey, modelRow)
    }
    addTokens(modelRow.tokens, tokens)
    modelRow.requests += row.requests
    if (cost !== null) modelRow.costUsd = (modelRow.costUsd ?? 0) + cost

    if (Number.isFinite(hour)) {
      const pointKey = `${hour}\u0000${agent}`
      const point = points.get(pointKey) ?? { hour, agent, tokens: 0, costUsd: 0 }
      point.tokens += total
      point.costUsd += cost ?? 0
      points.set(pointKey, point)
    }

    addTokens(totals.tokens, tokens)
    totals.costUsd += cost ?? 0
    totals.requests += row.requests
    if (cost === null) totals.unpricedTokens += total
  }

  const agentRows = [...agents.values()].map(({ sessionIds, ...agent }) => ({ ...agent, sessions: sessionIds.size }))
  totals.sessions = agentRows.reduce((sum, agent) => sum + agent.sessions, 0)
  return {
    from: input.from,
    to: input.to,
    scannedAt: input.scannedAt,
    pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt },
    totals,
    agents: agentRows.sort((a, b) => b.costUsd - a.costUsd || usageTokenTotal(b.tokens) - usageTokenTotal(a.tokens)),
    models: [...models.values()].sort(
      (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || usageTokenTotal(b.tokens) - usageTokenTotal(a.tokens),
    ),
    points: [...points.values()].sort((a, b) => a.hour - b.hour),
    sources: input.sources.map((source) => ({ ...source })),
  }
}
