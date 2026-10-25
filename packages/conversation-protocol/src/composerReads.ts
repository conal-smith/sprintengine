// What a client's composer reads from the desktop a chat runs on, beside the
// socket: the files and folders a mention may name (`conversation-file-search`)
// and the slash commands the chat's CLI runs there (`conversation-commands`).
// Each is a plain GET answered in JSON, read here member by member: another
// machine's words are not trusted to be the shape they claim.

/** The most matches a file search answers with. */
export const CONVERSATION_MAX_FILE_SEARCH_RESULTS = 50
/** The longest query a file search takes. */
export const CONVERSATION_MAX_FILE_SEARCH_QUERY_CHARS = 200
/** The most commands a command list carries. */
export const CONVERSATION_MAX_COMMANDS = 500

/** One match of a file search: a file or folder, by its path relative to the chat's folder. */
export type ConversationFileSearchEntry = { path: string; kind: 'file' | 'folder' }

/**
 * `GET conversation-files?workspaceId=&agentId=&query=` (`limit` optional, at
 * most `CONVERSATION_MAX_FILE_SEARCH_RESULTS`): the files and folders in the
 * chat's folder whose names match, best first, each by its path relative to
 * that folder with `/` between segments. `truncated` says there were more.
 * What a client mentions from it goes back in a `send`'s `mentions`.
 */
export type ConversationFileSearchAnswer = { entries: ConversationFileSearchEntry[]; truncated: boolean }

/** Where a listed command comes from, as the desktop's own `/` menu groups it. */
export type ConversationWireCommandSource = 'cli' | 'custom' | 'skill'

/** One slash command the chat's CLI runs, as the desktop's own `/` menu lists it. */
export type ConversationWireSlashCommand = {
  /** Without the leading slash, e.g. `compact`, `review`, `acme:deploy`. */
  name: string
  description?: string
  /** What the command expects after it, e.g. `[pr-number]`. */
  argumentHint?: string
  aliases?: string[]
  /** What choosing it puts in the composer when that is not `/name `. */
  insertText?: string
  source: ConversationWireCommandSource
}

/**
 * `GET conversation-commands?workspaceId=&agentId=` (`refresh=1` to ask the
 * CLI again now): what the chat's CLI reported it runs in the chat's folder.
 * `fetchedAt` is when it answered (epoch ms), 0 before it has; `error` says
 * why the last ask failed, `commands` then holding the last good list.
 * Studio's own commands are the client's, and are never in it.
 */
export type ConversationCommandsAnswer = {
  cli: string
  commands: ConversationWireSlashCommand[]
  fetchedAt: number
  error?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function words(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

// A relative path inside the chat's folder, and nothing a client could read
// as a path of its own.
function relativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.split(/[\\/]/u).includes('..')
  )
}

/** A file search's answer, or null when it is not one. An entry that is not a relative path is dropped. */
export function parseConversationFileSearchAnswer(value: unknown): ConversationFileSearchAnswer | null {
  if (!record(value) || !Array.isArray(value.entries)) return null
  const entries: ConversationFileSearchEntry[] = []
  for (const entry of value.entries) {
    if (entries.length >= CONVERSATION_MAX_FILE_SEARCH_RESULTS) break
    if (!record(entry) || !relativePath(entry.path) || (entry.kind !== 'file' && entry.kind !== 'folder')) continue
    entries.push({ path: entry.path, kind: entry.kind })
  }
  return { entries, truncated: value.truncated === true }
}

const COMMAND_SOURCES = new Set<ConversationWireCommandSource>(['cli', 'custom', 'skill'])
const COMMAND_NAME = /^[^\s/][^\s]{0,199}$/u

/** A command list's answer, or null when it is not one. A command this client cannot read is dropped. */
export function parseConversationCommandsAnswer(value: unknown): ConversationCommandsAnswer | null {
  if (!record(value) || typeof value.cli !== 'string' || !value.cli || !Array.isArray(value.commands)) return null
  const fetchedAt =
    typeof value.fetchedAt === 'number' && Number.isSafeInteger(value.fetchedAt) && value.fetchedAt >= 0
      ? value.fetchedAt
      : 0
  const commands: ConversationWireSlashCommand[] = []
  for (const entry of value.commands) {
    if (commands.length >= CONVERSATION_MAX_COMMANDS) break
    if (!record(entry) || typeof entry.name !== 'string' || !COMMAND_NAME.test(entry.name)) continue
    // Studio's own commands are each client's own, never the desktop's to list.
    if (!COMMAND_SOURCES.has(entry.source as ConversationWireCommandSource)) continue
    const description = words(entry.description, 500)
    const argumentHint = words(entry.argumentHint, 200)
    const insertText = words(entry.insertText, 200)
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.filter((alias): alias is string => typeof alias === 'string' && COMMAND_NAME.test(alias))
      : []
    commands.push({
      name: entry.name,
      source: entry.source as ConversationWireCommandSource,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      ...(aliases.length ? { aliases: aliases.slice(0, 20) } : {}),
      ...(insertText ? { insertText } : {}),
    })
  }
  const error = words(value.error, 2_000)
  return { cli: value.cli.slice(0, 200), commands, fetchedAt, ...(error ? { error } : {}) }
}
