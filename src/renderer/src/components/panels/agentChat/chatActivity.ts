import type {
  ConversationImageAttachment,
  ConversationStoredImageAttachment,
} from '../../../../../shared/conversation-runtime'
import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'
import { STUDIO_MCP_SERVER_ID } from '../../../../../shared/product-identity'

// What the agent touched in one conversation, read off its transcript: the
// rows of the card on the chat's right (ChatActivityCard), and of the pill the
// title bar shows in its place when the chat is too narrow for it.
//
// A row appears the first time the agent touches that thing — edits a file,
// takes a page in the browser pane, draws on a canvas board, sends off an
// agent — and the rows keep that order for the rest of the chat, so the set
// reads as a short history of the run and a row someone found stays where it
// is. Library holds the images the chat carries, which is what came out of the
// run rather than a place the agent worked, so it is always last.
//
// "Live" is an agent in it right now: a tool call on it still running. That
// is the transcript's own word, so it holds for a chat on a paired machine as
// well as one here.

export type ChatActivityKind = 'changes' | 'files' | 'browser' | 'canvas' | 'agents' | 'library'

export type ChatImageSource =
  | { kind: 'attachment'; attachment: ConversationImageAttachment }
  | { kind: 'stored'; attachment: ConversationStoredImageAttachment }
  | { kind: 'tool'; toolUseId: string; path: string }

/** One image in the conversation, as the Library shows it. */
export type ChatImage = {
  /** Stable across redraws: the attachment's id, or the step and the file. */
  key: string
  /** Who put it in the chat: the person, or the agent through one of its tools. */
  from: 'you' | 'browser' | 'canvas' | 'agent'
  /** The person's turn it belongs to, which "Jump to message" scrolls to. */
  turnSeq?: number
  /** When, where the transcript says. */
  at?: number
  /** The picture's own name, or what its step was doing. */
  caption: string
  source: ChatImageSource
}

export type ChatActivity = {
  /** The rows, in the order the agent first touched each; Library last. */
  order: ChatActivityKind[]
  edits: {
    /** An edit is running now. */
    live: boolean
    /** Every file an edit named, absolute or as the tool gave it, first edit first. */
    paths: string[]
  }
  browser: { live: boolean; url: string | null } | null
  canvas: { live: boolean; board: string | null } | null
  agents: { total: number; working: number } | null
  /** Newest first. */
  images: ChatImage[]
}

const EMPTY: ChatActivity = {
  order: [],
  edits: { live: false, paths: [] },
  browser: null,
  canvas: null,
  agents: null,
  images: [],
}

/**
 * The tool's own name with any server prefix taken off, and whether it is one
 * of this app's: `mcp__sprintengine-studio__browser_open` (Claude Code),
 * `sprintengine-studio.browser_open` and `sprintengine-studio/browser_open`
 * (other runtimes) all read as `browser_open` from the studio server. A
 * browser tool another MCP server offers drives no tab of ours, so it is not
 * the Browser row.
 */
export function studioToolName(tool: Pick<TranscriptToolEntry, 'name' | 'serverName'>): string | null {
  const name = tool.name
  const studio = tool.serverName === STUDIO_MCP_SERVER_ID || name.includes(STUDIO_MCP_SERVER_ID)
  if (!studio) return null
  return name.split(/__|[./]/u).at(-1) ?? name
}

function inputString(tool: TranscriptToolEntry, ...keys: string[]): string | null {
  const input = tool.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

const EDIT_KINDS = new Set(['file_edit', 'file_write'])

function isEdit(tool: TranscriptToolEntry): boolean {
  return (
    (tool.toolKind !== undefined && EDIT_KINDS.has(tool.toolKind)) ||
    /^(Edit|MultiEdit|Write|apply_patch)$/u.test(tool.name)
  )
}

/** Every tool call in transcript order, a spawned agent's own calls after its lane. */
function* toolCalls(entries: readonly TranscriptEntry[]): Generator<TranscriptToolEntry> {
  const walk = function* (tool: TranscriptToolEntry): Generator<TranscriptToolEntry> {
    yield tool
    for (const child of tool.children ?? []) yield* walk(child)
  }
  for (const entry of entries) if (entry.kind === 'tool') yield* walk(entry)
}

const imageName = (path: string): string => path.split(/[\\/]/u).at(-1) ?? path

export function deriveChatActivity(entries: readonly TranscriptEntry[]): ChatActivity {
  if (!entries.length) return EMPTY
  const order: ChatActivityKind[] = []
  const touch = (...kinds: ChatActivityKind[]) => {
    for (const kind of kinds) if (!order.includes(kind)) order.push(kind)
  }
  const paths: string[] = []
  let editsLive = false
  let browser: ChatActivity['browser'] = null
  let canvas: ChatActivity['canvas'] = null
  let total = 0
  let working = 0
  const images: ChatImage[] = []
  // The person's turn the entries since belong to.
  let turnSeq: number | undefined

  for (const entry of entries) {
    if (entry.kind === 'user') {
      if (entry.seq !== undefined) turnSeq = entry.seq
      // Studio's own notices carry no pictures the person chose.
      if (entry.origin?.kind === 'studio') continue
      const live = entry.attachments ?? []
      // A bubble with its live send behind it draws that; replayed, the
      // transcript's references. Never both: they are the same pictures.
      if (live.length)
        for (const attachment of live)
          images.push({
            key: `attachment:${attachment.id}`,
            from: 'you',
            ...(turnSeq !== undefined ? { turnSeq } : {}),
            ...(entry.createdAt !== undefined ? { at: entry.createdAt } : {}),
            caption: attachment.name ?? 'Attached picture',
            source: { kind: 'attachment', attachment },
          })
      else
        for (const attachment of entry.storedAttachments ?? [])
          images.push({
            key: `attachment:${attachment.id}`,
            from: 'you',
            ...(turnSeq !== undefined ? { turnSeq } : {}),
            ...(entry.createdAt !== undefined ? { at: entry.createdAt } : {}),
            caption: attachment.name ?? 'Attached picture',
            source: { kind: 'stored', attachment },
          })
      continue
    }
    if (entry.kind !== 'tool') continue
    for (const tool of toolCalls([entry])) {
      const running = tool.status === 'running'
      const studio = studioToolName(tool)
      if (tool.subagentLane) {
        touch('agents')
        total += 1
        const state = tool.agent?.state ?? (running ? 'running' : 'completed')
        if (state === 'running') working += 1
      } else if (isEdit(tool)) {
        touch('changes', 'files')
        const path = inputString(tool, 'file_path', 'path', 'filePath', 'target_file')
        if (path && !paths.includes(path)) paths.push(path)
        if (running) editsLive = true
      } else if (studio?.startsWith('browser_')) {
        touch('browser')
        const url = inputString(tool, 'url')
        const seen = browser as ChatActivity['browser']
        browser = { live: running || Boolean(seen?.live), url: url ?? seen?.url ?? null }
      } else if (studio?.startsWith('canvas_')) {
        touch('canvas')
        const board = inputString(tool, 'board')
        const seen = canvas as ChatActivity['canvas']
        canvas = { live: running || Boolean(seen?.live), board: board ?? seen?.board ?? null }
      }
      if (tool.images?.length) {
        const from = studio?.startsWith('browser_') ? 'browser' : studio?.startsWith('canvas_') ? 'canvas' : 'agent'
        for (const path of tool.images)
          images.push({
            key: `tool:${tool.id}:${path}`,
            from,
            ...(turnSeq !== undefined ? { turnSeq } : {}),
            ...((tool.completedAt ?? tool.startedAt) !== undefined ? { at: tool.completedAt ?? tool.startedAt } : {}),
            caption: tool.summary?.trim() || imageName(path),
            source: { kind: 'tool', toolUseId: tool.id, path },
          })
      }
    }
  }

  if (images.length) order.push('library')
  else if (!order.length) return EMPTY
  return {
    order,
    edits: { live: editsLive, paths },
    browser,
    canvas,
    agents: total ? { total, working } : null,
    images: images.reverse(),
  }
}

/**
 * The folder every edited file shares, under `root` when it is inside it: what
 * the Files row names and opens the tree at. Null when the edits share none,
 * or there are none.
 */
export function sharedEditFolder(paths: readonly string[], root: string | null): string | null {
  const split = (path: string) => path.split(/[\\/]/u).filter(Boolean)
  const folders = paths.map((path) => split(path).slice(0, -1))
  if (!folders.length) return null
  const shared: string[] = []
  for (let index = 0; index < folders[0]!.length; index += 1) {
    const part = folders[0]![index]
    if (!folders.every((folder) => folder[index] === part)) break
    shared.push(part!)
  }
  if (!shared.length) return null
  const rootParts = root ? split(root) : []
  const inRoot = rootParts.length > 0 && rootParts.every((part, index) => shared[index] === part)
  const absolute = paths[0]!.startsWith('/') || /^[A-Za-z]:/u.test(paths[0]!)
  if (inRoot) return shared.slice(rootParts.length).join('/') || '.'
  return (absolute && !/^[A-Za-z]:/u.test(paths[0]!) ? '/' : '') + shared.join('/')
}
