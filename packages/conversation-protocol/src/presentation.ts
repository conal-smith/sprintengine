import type { ConversationJsonValue, ConversationToolKind, ConversationToolStatus } from './tool-types.js'
import { inferConversationToolKind } from './toolKind.js'
import { labelCommand as describeCommand } from './commandLabel.js'

export type PresentableTool = {
  kind?: ConversationToolKind
  name: string
  input?: ConversationJsonValue
  status?: ConversationToolStatus | 'running' | 'done'
  exitCode?: number
  summary?: string
  subagentType?: string
  /** An MCP tool's own title, and its server's name, where the provider names them. */
  displayTitle?: string
  serverName?: string
}
export type ToolPresentation = {
  icon: ConversationToolKind
  verb: string
  title: string
  subtitle?: string
  tone: 'neutral' | 'running' | 'ok' | 'error' | 'declined'
}
const verbs: Record<ConversationToolKind, [string, string]> = {
  command: ['Ran', 'Running'],
  file_read: ['Read', 'Reading'],
  file_edit: ['Edited', 'Editing'],
  file_write: ['Wrote', 'Writing'],
  search: ['Searched', 'Searching'],
  list: ['Listed', 'Listing'],
  web: ['Fetched', 'Fetching'],
  mcp: ['Called', 'Calling'],
  subagent: ['Ran', 'Running'],
  todo: ['Updated', 'Updating'],
  other: ['Called', 'Calling'],
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function read(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof input[key] === 'string') return input[key]
  return ''
}
function basename(path: string) {
  return path.split(/[\\/]/).at(-1) || path
}
function shorten(value: string, maximum = 72, keepEnd = 0) {
  if (value.length <= maximum) return value
  if (keepEnd > 0) {
    // Keep the action verb even for a directory name longer than the budget.
    const tail = Math.min(keepEnd, maximum - 8)
    return `${value.slice(0, maximum - tail - 1)}…${value.slice(-tail)}`
  }
  return value.slice(0, Math.max(1, maximum - 1)) + '…'
}
// Steps with no kind of their own that still say what they did better than
// their tool's name does.
function otherTitle(name: string, input: Record<string, unknown>, live: boolean): string {
  if (name === 'GenerateImage') return live ? 'Generating image' : 'Generated image'
  if (name === 'Sleep') {
    const ms = typeof input.durationMs === 'number' ? input.durationMs : 0
    const span = ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`
    return `${live ? 'Waiting' : 'Waited'} ${span}`
  }
  // Codex drives the computer and runs scripts through JavaScript REPL tools
  // whose names ("cua_repl.js", "js") say nothing; each call carries a title
  // the model wrote for it, and a computer-use script imports the sky module.
  if (name === 'js' || name === 'cua_repl.js' || name === 'node_repl.js') {
    const title = read(input, 'title').trim()
    if (title) return shorten(title)
    const code = read(input, 'code')
    if (name === 'cua_repl.js' || /\bsky\s*\./.test(code) || /["']@oai\/sky["']/.test(code))
      return live ? 'Using the computer' : 'Used the computer'
    return live ? 'Running JavaScript' : 'Ran JavaScript'
  }
  return name
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}
// An MCP call as "Server: tool". The title and server name the provider got
// from the server come first; without them the wire name is made readable:
// `mcp__claude_ai_Gmail__search_threads` reads "Gmail: search threads", a
// claude.ai connector's prefix dropped and underscores and dashes spaced.
function mcpTitle(name: string, displayTitle: string, serverName: string): string {
  const wire = name.replace(/^mcp(?:__|[.:/])/i, '')
  const split = wire.indexOf('__')
  const readable = (value: string) => value.replace(/[_-]+/g, ' ').trim()
  const server = serverName || (split > 0 ? readable(wire.slice(0, split).replace(/^claude_ai_/, '')) : '')
  const tool = displayTitle || readable(split > 0 ? wire.slice(split + 2) : wire) || name
  return server && !tool.toLowerCase().startsWith(server.toLowerCase()) ? `${server}: ${tool}` : tool
}

/** Presentation is shared by desktop and remote clients; malformed tools stay readable. */
export function presentToolItem(
  item: PresentableTool,
  labelCommand?: (command: string) => { title: string } | string,
): ToolPresentation {
  const safe = record(item)
  const name = typeof safe.name === 'string' ? safe.name : 'Tool'
  const kind =
    safe.kind && Object.hasOwn(verbs, String(safe.kind))
      ? (safe.kind as ConversationToolKind)
      : inferConversationToolKind(name)
  const input = record(safe.input)
  const live = safe.status === 'running'
  const verb = verbs[kind][live ? 1 : 0]
  const path = read(input, 'path', 'file_path', 'filePath')
  const legacy =
    typeof safe.summary === 'string'
      ? safe.summary.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `), '')
      : ''
  let title: string
  switch (kind) {
    case 'command': {
      const command = read(input, 'command', 'cmd') || legacy
      const label = labelCommand?.(command) ?? describeCommand(command).label
      title =
        typeof label === 'string' ? label : label?.title || `${verb} ${command.trim().split(/\s/)[0] || 'command'}`
      break
    }
    case 'file_read':
    case 'file_edit':
    case 'file_write':
      title = `${verb} ${basename(path || legacy) || 'file'}`
      break
    case 'search':
      title = `${verb} for “${read(input, 'pattern', 'query') || legacy}”`
      break
    case 'list':
      title = `${verb} ${read(input, 'path', 'directory') || legacy || 'files'}`
      break
    case 'web': {
      const query = read(input, 'query')
      const url = read(input, 'url')
      let host = url
      try {
        host = new URL(url).host
      } catch {
        /* A malformed URL still has a readable label. */
      }
      title = query
        ? `${live ? 'Searching' : 'Searched'} the web for “${query}”`
        : `${verb} ${host || legacy || 'web page'}`
      break
    }
    case 'mcp':
      title = mcpTitle(name, text(safe.displayTitle), text(safe.serverName))
      break
    case 'subagent':
      title = `${safe.subagentType || read(input, 'subagent_type') || 'Agent'}: ${read(input, 'description', 'prompt') || legacy}`
      break
    case 'todo':
      title = `${verb} plan`
      break
    default:
      title = otherTitle(name, input, live)
  }
  const exitCode = typeof safe.exitCode === 'number' ? safe.exitCode : undefined
  const tone = live
    ? 'running'
    : safe.status === 'declined' || safe.status === 'stopped'
      ? 'declined'
      : safe.status === 'error' && exitCode === undefined
        ? 'error'
        : exitCode
          ? 'neutral'
          : safe.status === 'ok'
            ? 'ok'
            : 'neutral'
  const subtitlePath = path || (kind === 'file_read' || kind === 'file_edit' || kind === 'file_write' ? legacy : '')
  return {
    icon: kind,
    verb,
    title: shorten(title, 72, kind === 'list' ? basename(title).length : 0),
    ...(exitCode ? { subtitle: `exit ${exitCode}` } : subtitlePath ? { subtitle: subtitlePath } : {}),
    tone,
  }
}

export function toolActionVerb(name: string, live: boolean): string {
  if (name === 'WebSearch') return live ? 'Searching' : 'Searched'
  const kind = inferConversationToolKind(name)
  return kind === 'other' || kind === 'mcp' ? `${live ? 'Calling' : 'Called'} ${name}` : verbs[kind][live ? 1 : 0]
}

export function summarizeToolGroup(items: PresentableTool[]): string {
  const counts = new Map<ConversationToolKind, number>()
  for (const item of items) {
    const kind = presentToolItem(item).icon
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const nouns: Record<ConversationToolKind, string> = {
    command: 'command',
    file_read: 'file',
    file_edit: 'file',
    file_write: 'file',
    search: 'query',
    list: 'directory',
    web: 'page',
    mcp: 'tool',
    subagent: 'agent',
    todo: 'plan',
    other: 'tool',
  }
  const plurals: Partial<Record<string, string>> = { directory: 'directories', query: 'queries' }
  const clauses = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, count]) => {
      const noun = nouns[kind]
      return `${verbs[kind][0].toLowerCase()} ${count} ${count === 1 ? noun : (plurals[noun] ?? `${noun}s`)}`
    })
  const joined =
    clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}` : clauses[0] || 'No tool calls'
  return joined[0].toUpperCase() + joined.slice(1)
}
