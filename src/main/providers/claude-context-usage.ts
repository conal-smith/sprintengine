import type {
  ConversationContextBreakdown,
  ConversationContextCategory,
  ConversationContextItem,
  ConversationContextMcpServer,
} from '../../shared/conversation-runtime'

// Claude Code's `/context` reading, as the SDK's `getContextUsage` answers it,
// in the shape the composer strip's breakdown draws. Read loosely: the answer
// comes from whichever Claude Code the chat runs, which can be older or newer
// than the SDK's typings, so every field is checked rather than trusted, and
// a row that is not a name and a count is dropped rather than drawn as zero.

type Loose = Record<string, unknown>

const KINDS = new Set<ConversationContextCategory['kind']>(['used', 'free', 'buffer', 'deferred'])

/** The `mcp__<server>__` prefix every MCP tool's wire name carries, which the server's row already says. */
export function mcpToolShortName(name: string, server: string): string {
  const prefix = `mcp__${server}__`
  if (name.startsWith(prefix)) return name.slice(prefix.length)
  const loose = /^mcp__.+?__(.+)$/u.exec(name)
  return loose?.[1] ?? name
}

export function contextBreakdownFromSdk(
  answer: unknown,
  { estimated, measuredAt }: { estimated: boolean; measuredAt: number },
): ConversationContextBreakdown | null {
  if (!isObject(answer)) return null
  const usedTokens = count(answer.totalTokens)
  // The window the reading's own percentage is of: the compaction window
  // where one applies, which is what fills up first.
  const windowTokens = positiveCount(answer.rawMaxTokens) ?? positiveCount(answer.maxTokens)
  if (usedTokens === null || windowTokens === null) return null

  const categories: ConversationContextCategory[] = []
  for (const row of list(answer.categories)) {
    const name = text(row.name)
    const tokens = count(row.tokens)
    if (name === null || tokens === null) continue
    const kind = categoryKind(row, name)
    // A zero row says nothing, except the free space, whose absence would
    // read as a full window.
    if (tokens === 0 && kind !== 'free') continue
    categories.push({ name, tokens, kind })
  }

  const servers = new Map<string, ConversationContextMcpServer>()
  for (const row of list(answer.mcpTools)) {
    const name = text(row.name)
    const server = text(row.serverName)
    const tokens = count(row.tokens)
    if (name === null || server === null || tokens === null) continue
    const loaded = row.isLoaded !== false
    const entry = servers.get(server) ?? { name: server, tokens: 0, tools: [] }
    entry.tools.push({ name: mcpToolShortName(name, server), tokens, loaded })
    if (loaded) entry.tokens += tokens
    servers.set(server, entry)
  }
  const mcpServers = [...servers.values()]
  for (const server of mcpServers) server.tools.sort(heaviestFirst)
  mcpServers.sort(heaviestFirst)

  const skillRows = isObject(answer.skills) ? list(answer.skills.skillFrontmatter) : []
  const skills = items(skillRows, 'name', 'source')
  const memoryFiles = items(list(answer.memoryFiles), 'path', 'type')
  const agents = items(list(answer.agents), 'agentType', 'source')

  const threshold = positiveCount(answer.autoCompactThreshold)
  return {
    model: text(answer.model) ?? '',
    usedTokens,
    windowTokens,
    categories,
    mcpServers,
    skills,
    memoryFiles,
    agents,
    autoCompactAt: answer.isAutoCompactEnabled === true && threshold !== null ? threshold : null,
    estimated,
    measuredAt,
  }
}

// Classified by the kind the CLI gives each row, never by its English name —
// except for a CLI too old to give one, where the name is all there is.
function categoryKind(row: Loose, name: string): ConversationContextCategory['kind'] {
  if (typeof row.kind === 'string' && KINDS.has(row.kind as ConversationContextCategory['kind']))
    return row.kind as ConversationContextCategory['kind']
  if (row.isDeferred === true) return 'deferred'
  if (/^free/iu.test(name)) return 'free'
  if (/buffer/iu.test(name)) return 'buffer'
  return 'used'
}

function items(rows: Loose[], nameKey: string, detailKey: string): ConversationContextItem[] {
  const out: ConversationContextItem[] = []
  for (const row of rows) {
    const name = text(row[nameKey])
    const tokens = count(row.tokens)
    if (name === null || tokens === null) continue
    const detail = text(row[detailKey])
    out.push(detail ? { name, tokens, detail } : { name, tokens })
  }
  return out.sort(heaviestFirst)
}

function heaviestFirst(a: { name: string; tokens: number }, b: { name: string; tokens: number }): number {
  return b.tokens - a.tokens || a.name.localeCompare(b.name)
}

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function list(value: unknown): Loose[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function positiveCount(value: unknown): number | null {
  const n = count(value)
  return n !== null && n > 0 ? n : null
}
