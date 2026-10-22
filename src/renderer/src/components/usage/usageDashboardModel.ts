import {
  usageTokenTotal,
  type UsageAgentId,
  type UsageReport,
  type UsageReportMachine,
  type UsageReportTokens,
} from '../../../../shared/usage-report'

// The usage dashboard's arithmetic, apart from its drawing so it can be tested
// as plain functions: the window a range covers, the periods the chart and the
// day table are cut into (this machine's local hours or days), the series per
// agent, a readable axis, the curve through the points, and what each
// machine's row says about where its figures came from.

export type UsageView = 'cost' | 'tokens' | 'limits'
export type UsageRange = '24h' | '7d' | '30d' | '90d'
export type UsageMetric = 'cost' | 'tokens'

export const USAGE_RANGES: ReadonlyArray<{ value: UsageRange; label: string }> = [
  { value: '24h', label: 'Past 24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

const HOUR_MS = 3_600_000

export type UsageWindow = {
  from: number
  to: number
  /** `hour` for the past day, `day` (local calendar days) for the rest. */
  unit: 'hour' | 'day'
  /** Each period's start, oldest first; the last runs to `to`. */
  periods: number[]
}

/**
 * The window a range covers, ending now. The past 24 hours are the 24 whole
 * hours up to and including this one. A range of days is that many local
 * calendar days, today included, so "7 days" on a Tuesday starts the Wednesday
 * before at midnight; days are stepped by the calendar, not by 24 hours, so a
 * daylight-saving change gives a 23- or 25-hour day rather than a skewed one.
 */
export function usageWindow(range: UsageRange, now: number): UsageWindow {
  if (range === '24h') {
    const current = Math.floor(now / HOUR_MS) * HOUR_MS
    const periods = Array.from({ length: 24 }, (_, index) => current - (23 - index) * HOUR_MS)
    return { from: periods[0]!, to: now, unit: 'hour', periods }
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const periods: number[] = []
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(today)
    day.setDate(today.getDate() - back)
    periods.push(day.getTime())
  }
  return { from: periods[0]!, to: now, unit: 'day', periods }
}

/** The period an instant falls in, or -1 before the first. */
export function periodIndex(periods: readonly number[], at: number): number {
  let low = 0
  let high = periods.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (periods[middle]! <= at) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

export type UsageSeries = {
  agent: UsageAgentId
  /** One value per period. */
  values: number[]
  total: number
}

/** Each agent's cost or tokens per period, in the report's agent order. */
export function usageSeries(report: UsageReport, window: UsageWindow, metric: UsageMetric): UsageSeries[] {
  const byAgent = new Map<UsageAgentId, number[]>()
  for (const agent of report.agents) byAgent.set(agent.id, new Array<number>(window.periods.length).fill(0))
  for (const point of report.points) {
    const index = periodIndex(window.periods, point.hour)
    if (index < 0) continue
    let values = byAgent.get(point.agent)
    if (!values) {
      values = new Array<number>(window.periods.length).fill(0)
      byAgent.set(point.agent, values)
    }
    values[index]! += metric === 'cost' ? point.costUsd : point.tokens
  }
  return [...byAgent].map(([agent, values]) => ({ agent, values, total: values.reduce((sum, v) => sum + v, 0) }))
}

export type UsagePeriodRow = {
  start: number
  costUsd: number
  tokens: number
  byAgent: Array<{ agent: UsageAgentId; costUsd: number; tokens: number }>
}

/** The day (or hour) table: each period with usage, newest first. */
export function usagePeriodRows(report: UsageReport, window: UsageWindow): UsagePeriodRow[] {
  const rows = window.periods.map<UsagePeriodRow>((start) => ({ start, costUsd: 0, tokens: 0, byAgent: [] }))
  for (const point of report.points) {
    const row = rows[periodIndex(window.periods, point.hour)]
    if (!row) continue
    row.costUsd += point.costUsd
    row.tokens += point.tokens
    const agent = row.byAgent.find((entry) => entry.agent === point.agent)
    if (agent) {
      agent.costUsd += point.costUsd
      agent.tokens += point.tokens
    } else row.byAgent.push({ agent: point.agent, costUsd: point.costUsd, tokens: point.tokens })
  }
  return rows.filter((row) => row.tokens > 0 || row.costUsd > 0).reverse()
}

/**
 * An axis that reads: a top at or above `max`, cut into `ticks` equal steps
 * of a round number (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten)
 * chosen to waste as little of the plot as it can. A zero max still gets an
 * axis.
 */
export function niceScale(max: number, ticks = 2): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 1 / ticks }
  const raw = max / ticks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step =
    [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ??
    10 * magnitude
  return { top: step * ticks, step }
}

/**
 * A smooth path through the points that never overshoots them (monotone
 * cubic, Fritsch–Carlson): a spike stays a spike and a zero stays on the
 * baseline, where a plain spline would dip below it or invent a peak.
 */
export function monotonePath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return `M${points[0]![0]},${points[0]![1]}`
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1]![0] - points[i]![0])
    slope.push(dx[i] === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / dx[i]!)
  }
  const tangent: number[] = [slope[0]!]
  for (let i = 1; i < n - 1; i += 1) {
    tangent.push(slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2)
  }
  tangent.push(slope[n - 2]!)
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i]! / slope[i]!
    const b = tangent[i + 1]! / slope[i]!
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      tangent[i] = t * a * slope[i]!
      tangent[i + 1] = t * b * slope[i]!
    }
  }
  const round = (value: number): string => String(Math.round(value * 100) / 100)
  let d = `M${round(points[0]![0])},${round(points[0]![1])}`
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i]!
    const [x1, y1] = points[i + 1]!
    const third = dx[i]! / 3
    d += `C${round(x0 + third)},${round(y0 + tangent[i]! * third)} ${round(x1 - third)},${round(y1 - tangent[i + 1]! * third)} ${round(x1)},${round(y1)}`
  }
  return d
}

/** The figure a total leads with on each view. */
export function usageHeadline(report: UsageReport, metric: UsageMetric): number {
  return metric === 'cost' ? report.totals.costUsd : usageTokenTotal(report.totals.tokens)
}

/** Every token, by kind, for the totals row. */
export function usageTotalsRow(tokens: UsageReportTokens): Array<{ label: string; value: number }> {
  return [
    { label: 'Processed tokens', value: usageTokenTotal(tokens) },
    { label: 'Cached input', value: tokens.cacheRead },
    { label: 'Uncached input', value: tokens.input },
    { label: 'Cache writes', value: tokens.cacheWrite },
    { label: 'Output', value: tokens.output },
  ]
}

export type UsageMachineLine = {
  text: string
  /** `muted` for a machine counted as it should be, `warn` for one counted from an old answer or not at all. */
  tone: 'muted' | 'warn'
  /** Still being asked, or still reading its logs. */
  pending: boolean
}

/**
 * The line under a machine's name in the breakdown: where its figures came
 * from, and why a machine is not counted. `asking` is the dashboard asking
 * the paired machines now; `formatAt` names a time.
 */
export function usageMachineLine(
  machine: UsageReportMachine,
  asking: boolean,
  formatAt: (at: number) => string,
): UsageMachineLine {
  const from = (at: number | null): string => (at === null ? '' : `, figures from ${formatAt(at)}`)
  switch (machine.status) {
    case 'local':
      return { text: 'This machine', tone: 'muted', pending: false }
    case 'ok':
      if (machine.scanning) return { text: 'Reading its logs…', tone: 'muted', pending: true }
      return {
        text: machine.scannedAt === null ? 'Up to date' : `Logs read ${formatAt(machine.scannedAt)}`,
        tone: 'muted',
        pending: false,
      }
    case 'cached':
      if (asking)
        return {
          text: machine.fetchedAt === null ? 'Asking…' : `Asking… (figures from ${formatAt(machine.fetchedAt)})`,
          tone: 'muted',
          pending: true,
        }
      return { text: `Offline${from(machine.fetchedAt)}`, tone: 'warn', pending: false }
    case 'offline':
      if (asking) return { text: 'Asking…', tone: 'muted', pending: true }
      return { text: 'Offline, never counted here yet', tone: 'warn', pending: false }
    case 'unsupported':
      return { text: `Update Studio on ${machine.label} to include its usage`, tone: 'warn', pending: false }
    case 'unauthorized':
      return { text: 'This pairing may not read its usage', tone: 'warn', pending: false }
    case 'error':
      return { text: 'Its usage could not be read', tone: 'warn', pending: false }
  }
}

/** Whether the report counts what other machines spent, so the dashboard shows its machines. */
export function usageHasPeers(report: UsageReport): boolean {
  return report.machines.some((machine) => machine.status !== 'local')
}
