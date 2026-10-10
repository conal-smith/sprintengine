import { cliForConversationProvider } from './conversation-harness'

// The usage dashboard's contract: what a window asks main for (`usage:report`)
// and the answer, already priced. Main reads every agent's session logs on
// this machine (src/main/usage) and folds them; the window draws, and buckets
// the hourly series into its own local days, so a day is the reader's day.

/** Where the prices came from: the live list fetched today, an older copy of it, or the bundled table alone. */
export type UsagePricingSource = 'live' | 'cached' | 'bundled'

export type UsageReportRequest = {
  /** Epoch ms, inclusive. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  /** Scan the logs now and fetch the price list again, rather than answer from the last scan. */
  refresh?: boolean
}

export type UsageReportTokens = {
  /** Fresh input: not read from or written to the prompt cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The agent a session ran: an agent CLI's id (`claude-code`, `codex`, `opencode`…), or the provider's id for one that is not a CLI. */
export type UsageAgentId = string

export type UsageReportAgent = {
  id: UsageAgentId
  sessions: number
  tokens: UsageReportTokens
  /** Priced cost, plus what the agent reported for turns it priced itself. */
  costUsd: number
  /** Tokens no price was found for; they are in `tokens`, not in `costUsd`. */
  unpricedTokens: number
}

export type UsageReportModel = {
  agent: UsageAgentId
  model: string
  tokens: UsageReportTokens
  /** Null when nothing priced this model's tokens. */
  costUsd: number | null
  requests: number
}

/** One agent's usage in one hour. */
export type UsageReportPoint = {
  hour: number
  agent: UsageAgentId
  tokens: number
  costUsd: number
}

export type UsageReportSource = {
  id: string
  /** Session logs found. */
  found: number
  error: string | null
}

export type UsageReport = {
  from: number
  to: number
  /** When the logs were last read (epoch ms), or null before the first scan finished. */
  scannedAt: number | null
  pricing: { source: UsagePricingSource; fetchedAt: number | null }
  totals: {
    tokens: UsageReportTokens
    costUsd: number
    /** What the cache reads saved over paying full input price for the same tokens. */
    cacheSavingsUsd: number
    sessions: number
    requests: number
    unpricedTokens: number
  }
  agents: UsageReportAgent[]
  models: UsageReportModel[]
  points: UsageReportPoint[]
  sources: UsageReportSource[]
}

export type UsageReportResult = { ok: true; report: UsageReport } | { ok: false; message: string }

/** Every token the window processed: fresh input, cache reads and writes, and output. */
export function usageTokenTotal(tokens: UsageReportTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

/**
 * The agent a usage row's provider id stands for. A chat's provider
 * (`claude-agent`) and the CLI's own logs read as the same agent, so a
 * person's Claude Code is one line whether it ran in a chat or a terminal.
 */
export function usageAgentOf(providerId: string): UsageAgentId {
  return cliForConversationProvider(providerId) ?? (providerId || 'other')
}

const AGENT_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok',
  gemini: 'Gemini',
  other: 'Other',
}

export function usageAgentLabel(agent: UsageAgentId): string {
  return AGENT_LABELS[agent] ?? agent
}

/**
 * The chart slot an agent's series takes (1..8), fixed by agent so a filter
 * never repaints the others; an agent past the table folds into the neutral
 * "other" colour. Claude Code takes the rust slot and OpenCode the teal, the
 * nearest the palette has to their own marks.
 */
const AGENT_CHART_SLOTS: Readonly<Record<string, number>> = {
  codex: 1,
  'claude-code': 2,
  opencode: 3,
  cursor: 4,
  grok: 5,
  gemini: 7,
}

export function usageAgentChartSlot(agent: UsageAgentId): number | null {
  return AGENT_CHART_SLOTS[agent] ?? null
}

// ── Formatting ───────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const USD_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** "$3,691.59"; "<$0.01" for a cost too small to show as cents. */
export function formatUsageUsd(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01'
  return USD.format(value)
}

/** An axis tick: "$1,200", and cents only below ten dollars ("$2.50"). */
export function formatUsageUsdAxis(value: number): string {
  if (value === 0) return '$0'
  return value >= 10 ? USD_WHOLE.format(value) : USD.format(value)
}

/** "11.9B", "584M", "68.8K", "436": three significant figures at most. */
export function formatUsageTokens(value: number): string {
  const abs = Math.abs(value)
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, unit] of units) {
    if (abs >= size) {
      const scaled = value / size
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
      return `${Number(scaled.toFixed(digits))}${unit}`
    }
  }
  return String(Math.round(value))
}

/** "65.9%", "<0.1%", "100%". */
export function formatUsageShare(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%'
  const share = (part / whole) * 100
  if (share < 0.1) return '<0.1%'
  return `${Number(share.toFixed(1))}%`
}
