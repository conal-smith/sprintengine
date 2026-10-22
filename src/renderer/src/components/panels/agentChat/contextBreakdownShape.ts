import type {
  ConversationContextBreakdown,
  ConversationContextCategory,
  ConversationContextItem,
} from '../../../../../shared/conversation-runtime'

// The breakdown's picture, worked out apart from its drawing so it can be
// tested: the bar's segments and their colours, and the one item worth
// calling out.

/** The bar's segments, in the agent's own order, each a share of the window. */
export type ContextSegment = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer'
  /** 0–1 of the bar. */
  share: number
  /** The `--chart-*` slot a `used` row is drawn in; null for free space and the buffer, which are not content. */
  slot: number | 'other' | null
}

// Slots run in the order the drawn rows do: the first content row takes
// `--chart-1`, the next `--chart-2`, and so on. The palette's colour-vision
// safety is between neighbouring slots, and the bar sets rows side by side in
// the agent's own order, so the only pairs that ever touch are pairs the
// palette was checked for. A fixed slot per row name would break that the
// moment a row between two others is empty (no custom agents puts MCP tools
// beside skills, a pair that reads alike under deuteranopia). A chat's rows
// rarely come and go, so in practice a row keeps its colour; where one does
// arrive, the legend beside every swatch still names it.
const SLOT_COUNT = 8

export function contextSegments(breakdown: ConversationContextBreakdown): ContextSegment[] {
  const rows = breakdown.categories.filter(
    (row): row is ConversationContextCategory & { kind: ContextSegment['kind'] } => row.kind !== 'deferred',
  )
  // Shares of the window, or of the rows' own sum where that is larger (a
  // window read over its limit), so the bar never runs past its end.
  const whole = Math.max(
    breakdown.windowTokens,
    rows.reduce((sum, row) => sum + row.tokens, 0),
  )
  if (whole <= 0) return []
  let next = 1
  return rows.map((row) => {
    let slot: ContextSegment['slot'] = null
    if (row.kind === 'used') slot = next <= SLOT_COUNT ? next++ : 'other'
    return { name: row.name, tokens: row.tokens, kind: row.kind, share: row.tokens / whole, slot }
  })
}

/** The rows the window lists but does not hold: tool schemas loaded only when used. */
export function deferredRows(breakdown: ConversationContextBreakdown): ConversationContextCategory[] {
  return breakdown.categories.filter((row) => row.kind === 'deferred')
}

export type ContextHeaviest = { group: 'mcp' | 'skill' | 'memory' | 'agent'; name: string; tokens: number }

/**
 * The single heaviest thing a person chose to load — an MCP server, a skill,
 * a memory file or a custom agent — the one to look at first when the window
 * is fuller than it should be. The conversation itself and the agent's own
 * system prompt are not candidates: they are not something to take out.
 */
export function heaviestLoaded(breakdown: ConversationContextBreakdown): ContextHeaviest | null {
  const candidates: ContextHeaviest[] = [
    ...breakdown.mcpServers.map((server) => ({ group: 'mcp' as const, name: server.name, tokens: server.tokens })),
    ...breakdown.skills.map((item) => ({ group: 'skill' as const, name: item.name, tokens: item.tokens })),
    ...breakdown.memoryFiles.map((item) => ({ group: 'memory' as const, name: item.name, tokens: item.tokens })),
    ...breakdown.agents.map((item) => ({ group: 'agent' as const, name: item.name, tokens: item.tokens })),
  ]
  let best: ContextHeaviest | null = null
  for (const candidate of candidates)
    if (candidate.tokens > 0 && (!best || candidate.tokens > best.tokens)) best = candidate
  return best
}

/** "4%", "<1%", "38%": a share of the window, whole percent. */
export function contextShareLabel(tokens: number, windowTokens: number): string {
  if (windowTokens <= 0 || tokens <= 0) return '0%'
  const percent = (tokens / windowTokens) * 100
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

/** A memory file's path cut to what tells two apart: its last two parts. */
export function memoryFileLabel(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

/** A group's total, from its items. */
export function groupTokens(items: ReadonlyArray<Pick<ConversationContextItem, 'tokens'>>): number {
  return items.reduce((sum, item) => sum + item.tokens, 0)
}
