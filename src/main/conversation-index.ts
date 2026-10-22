import type { FileHandle } from 'node:fs/promises'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openConfinedExistingFile } from './conversation-file-access'
import {
  MAX_CONVERSATION_METADATA_BYTES,
  MAX_CONVERSATION_TRANSCRIPT_BYTES,
  readConversationStorage,
  removeConversationStorage,
  writeConversationStorage,
} from './conversation-persistence'
import { conversationConfinementRoot, workspaceStorePath, workspaceStoreReady } from './workspace-store'
import { CONVERSATION_MAX_REPLY_PREVIEW } from '../../packages/conversation-protocol/src/public'
import {
  readConversationMessageOrigin,
  type ConversationEvent,
  type ConversationKey,
} from '../shared/conversation-runtime'
import type {
  ConversationSearchHit,
  ConversationSearchInput,
  ConversationThread,
  ConversationWorkspaceKey,
} from '../shared/conversation-index'

type Fingerprint = { file: string; size: number; mtime: number }
// 3 since a row carries `lastTurnEndedAt`: a version 2 cache has rows read
// before it was kept, so it is read again once rather than trusted, and every
// chat that ever finished a turn says when. 4 since it carries
// `lastAssistantText`, for the same reason: every chat that has a reply
// previews it.
const INDEX_VERSION = 4
type Index = { version: typeof INDEX_VERSION; threads: ConversationThread[]; files: Fingerprint[] }
/**
 * One transcript's row as it stood after reading the file up to `offset` (the
 * end of its last complete line), with what the row's counts are made from.
 * A transcript only grows, so the row after an append is this plus the lines
 * after `offset`; `head`, the file's first bytes, tells an append from a file
 * deleted and written again under the same name.
 */
type ThreadFold = {
  thread: ConversationThread | null
  turns: Set<string>
  // Turns Studio opened with its own `/compact` before the cache expired:
  // their end is not news for the person (`lastTurnEndedAt`).
  quietTurns: Set<string>
  costs: Map<string, number>
  offset: number
  head: Buffer
}
// Folds of the transcripts that changed this run, most recent last. Enough for
// the chats a person works in; one that drops out is read whole once more.
const MAX_CACHED_FOLDS = 64
const FOLD_HEAD_BYTES = 512
/** The folder (or file) name a chat's or agent's id is stored under in its store's `conversations/`. */
export const conversationStorageSegment = (value: string) => {
  const encoded = encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
  return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded
}
const segment = conversationStorageSegment
const directory = (key: ConversationWorkspaceKey) =>
  workspaceStorePath(key.workspaceRoot, 'conversations', segment(key.workspaceId))
export const conversationIndexTranscriptPath = (key: ConversationKey) =>
  join(directory(key), `${segment(key.agentId)}.jsonl`)
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

type IndexHooks = {
  flush?: (path: string) => Promise<void>
  close?: (path: string) => Promise<void>
  // A transcript longer than this is indexed and searched from its first
  // megabyte and its last `maxTranscriptBytes` only.
  maxTranscriptBytes?: number
}

/**
 * Cache only. Titles, including explicit renames, are recovered from transcript events.
 *
 * A listing re-reads only the transcripts that changed since `index.json` was
 * written, and a transcript that grew since this run last read it only from
 * where that read ended. Every other row comes from the cache as it is: one
 * chat's new turn, or its child reporting in, costs that chat's new lines, not
 * a parse of every chat in the workspace.
 */
export class ConversationIndex {
  private queues = new Map<string, Promise<unknown>>()
  private readonly folds = new Map<string, ThreadFold>()
  private readonly maxBytes: number
  constructor(private readonly hooks: IndexHooks = {}) {
    this.maxBytes = hooks.maxTranscriptBytes ?? MAX_CONVERSATION_TRANSCRIPT_BYTES
  }
  private async serialized<T>(key: ConversationWorkspaceKey, work: () => Promise<T>): Promise<T> {
    const path = directory(key),
      previous = this.queues.get(path) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(path, next)
    try {
      return await next
    } finally {
      if (this.queues.get(path) === next) this.queues.delete(path)
    }
  }
  async list(key: ConversationWorkspaceKey): Promise<ConversationThread[]> {
    return this.serialized(key, async () => {
      if (!(await safeDirectory(key))) return []
      const folder = directory(key)
      const files = await this.files(key)
      const cached = await readIndex(key.workspaceRoot, folder)
      if (cached && JSON.stringify(cached.files) === JSON.stringify(files)) return sorted(cached.threads)
      const rows = cachedRows(cached)
      const threads: ConversationThread[] = []
      for (const file of files) {
        const thread = await this.thread(key.workspaceRoot, folder, file, rows.get(file.file))
        if (thread) threads.push(thread)
      }
      await saveIndex(key.workspaceRoot, folder, { version: INDEX_VERSION, threads, files })
      return sorted(threads)
    })
  }
  /** Refresh one completed turn without rescanning every other transcript. */
  async refresh(key: ConversationKey): Promise<ConversationThread | null> {
    if (!key.agentId.trim()) throw new Error('Conversation identity is required.')
    return this.serialized(key, async () => {
      if (!(await safeDirectory(key))) return null
      const folder = directory(key)
      const name = `${segment(key.agentId)}.jsonl`
      await this.hooks.flush?.(join(folder, name))
      const current = await fingerprint(join(folder, name), name)
      const cache = await readIndex(key.workspaceRoot, folder)
      const rows = cachedRows(cache)
      const thread = current ? await this.thread(key.workspaceRoot, folder, current, rows.get(name)) : null
      if (cache) {
        const files = cache.files.filter((file) => file.file !== name)
        if (current) files.push(current)
        files.sort((a, b) => a.file.localeCompare(b.file))
        const threads = cache.threads.filter((entry) => entry.agentId !== key.agentId)
        if (thread) threads.push(thread)
        await saveIndex(key.workspaceRoot, folder, { version: INDEX_VERSION, threads, files })
      } else {
        const files = await this.files(key)
        const threads: ConversationThread[] = []
        for (const file of files) {
          const entry = file.file === name ? thread : await this.thread(key.workspaceRoot, folder, file)
          if (entry) threads.push(entry)
        }
        await saveIndex(key.workspaceRoot, folder, { version: INDEX_VERSION, threads, files })
      }
      return thread
    })
  }
  /** Incremental batches let IPC and remote consumers surface hits before scanning finishes. */
  async search(
    input: ConversationSearchInput,
    options: { signal?: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void } = {},
  ): Promise<ConversationSearchHit[]> {
    const query = input.query.trim().toLowerCase().slice(0, 500)
    if (!query || !(await safeDirectory(input))) return []
    const hits: ConversationSearchHit[] = [],
      pending: ConversationSearchHit[] = []
    for (const file of await this.files(input)) {
      options.signal?.throwIfAborted()
      const path = join(directory(input), file.file)
      const seen = new Set<string>(),
        tails = new Map<string, string>(),
        turnSeq = new Map<string, number>()
      let ordinal = 0
      // One unreadable transcript costs its own hits, not the whole search.
      // Only the two kinds of event a search reads are parsed: a transcript is
      // mostly tool output, and the palette searches every chat the sidebar
      // lists on each pause in typing, so parsing every line was most of it.
      const events = guarded(
        readEvents(input.workspaceRoot, path, this.maxBytes, options.signal, mightBeSearched),
        options.signal,
      )
      for await (const event of events) {
        ordinal = event.seq ?? ordinal + 1
        const turnId = text(event.payload?.turnId)
        if (event.type === 'user_message') turnSeq.set(turnId, ordinal)
        if (event.type !== 'user_message' && event.type !== 'content_delta') continue
        const key = `${event.type}:${turnId}`
        if (seen.has(key)) continue
        const value = `${tails.get(key) ?? ''}${text(event.payload?.text)}`
        const offset = value.toLowerCase().indexOf(query)
        tails.set(key, value.slice(-Math.max(160, query.length)))
        if (offset < 0) continue
        seen.add(key)
        const snippet = `${offset > 80 ? '…' : ''}${value.slice(Math.max(0, offset - 80), offset + query.length + 100)}${value.length > offset + query.length + 100 ? '…' : ''}`
        const hit: ConversationSearchHit = {
          agentId: event.agentId,
          seq: turnSeq.get(turnId) ?? ordinal,
          ...(turnId ? { turnId } : {}),
          snippet,
          from:
            event.type === 'content_delta'
              ? 'agent'
              : readConversationMessageOrigin(event.payload?.origin)
                ? 'studio'
                : 'person',
        }
        hits.push(hit)
        pending.push(hit)
        if (pending.length >= 20) options.onBatch?.(pending.splice(0))
        if (hits.length >= 200) {
          if (pending.length) options.onBatch?.(pending.splice(0))
          return hits
        }
      }
    }
    if (pending.length) options.onBatch?.(pending)
    return hits
  }
  /** Caller must reject active sessions and obtain explicit confirmation before deleting. */
  async delete(key: ConversationKey): Promise<void> {
    if (!key.agentId.trim()) throw new Error('Conversation identity is required.')
    await this.serialized(key, async () => {
      if (!(await safeDirectory(key))) return
      const path = conversationIndexTranscriptPath(key)
      await this.hooks.close?.(path)
      const file = await lstat(path).catch((error) => {
        if (isMissing(error)) return null
        throw error
      })
      if (file?.isSymbolicLink()) throw new Error('A conversation transcript cannot be a symbolic link.')
      this.folds.delete(path)
      if (file) await removeConversationStorage(key.workspaceRoot, path)
      const tools = join(directory(key), `${segment(key.agentId)}.tools`)
      const detail = await lstat(tools).catch((error) => {
        if (isMissing(error)) return null
        throw error
      })
      if (detail) await removeConversationStorage(key.workspaceRoot, tools)
      const cache = await readIndex(key.workspaceRoot, directory(key))
      if (cache)
        await saveIndex(key.workspaceRoot, directory(key), {
          ...cache,
          threads: cache.threads.filter((entry) => entry.agentId !== key.agentId),
          files: cache.files.filter((entry) => entry.file !== `${segment(key.agentId)}.jsonl`),
        })
    })
  }
  /**
   * One transcript's row: the cached one while the file is as it was cached,
   * else read from what this run already read of it onwards. A transcript that
   * cannot be read still gets a row — named from its file, dated from its last
   * write — so one damaged chat does not hide every other chat in the workspace.
   */
  private async thread(
    root: string,
    folder: string,
    file: Fingerprint,
    cached?: { file: Fingerprint; thread: ConversationThread },
  ): Promise<ConversationThread | null> {
    if (cached && cached.file.size === file.size && cached.file.mtime === file.mtime) return cached.thread
    const path = join(folder, file.file)
    try {
      const fold = await readThread(root, path, this.maxBytes, this.folds.get(path))
      this.folds.delete(path)
      this.folds.set(path, fold)
      if (this.folds.size > MAX_CACHED_FOLDS) this.folds.delete(this.folds.keys().next().value!)
      return fold.thread && { ...fold.thread }
    } catch (error) {
      this.folds.delete(path)
      // Gone since the directory was listed: it has no row, as it had none before it was written.
      if (isMissing(error)) return null
      console.warn(
        `[conversation-index] ${file.file} could not be indexed:`,
        error instanceof Error ? error.message : error,
      )
      return {
        agentId: fileAgentId(file.file),
        title: 'Unreadable conversation',
        titleSource: 'first-message',
        createdAt: file.mtime,
        updatedAt: file.mtime,
        turnCount: 0,
        model: '',
        providerId: '',
        lastSeq: 0,
        firstUserText: '',
      }
    }
  }
  private async files(key: ConversationWorkspaceKey): Promise<Fingerprint[]> {
    const entries = await readdir(directory(key), { withFileTypes: true })
    const files: Fingerprint[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(directory(key), entry.name)
      await this.hooks.flush?.(path)
      const value = await fingerprint(path, entry.name)
      if (value) files.push(value)
    }
    return files.sort((a, b) => a.file.localeCompare(b.file))
  }
}

/** The agent a transcript file is named for. A name this app did not encode (`50%.jsonl`) is used as it is. */
function fileAgentId(file: string): string {
  const name = file.slice(0, -'.jsonl'.length)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

async function safeDirectory(key: ConversationWorkspaceKey): Promise<boolean> {
  if (!key.workspaceRoot.trim() || !key.workspaceId.trim()) throw new Error('Workspace identity is required.')
  // Waits out the store's one-time move, so a listing right after an upgrade
  // reads the history it brings rather than an empty folder.
  let path = await workspaceStoreReady(key.workspaceRoot)
  for (const part of ['conversations', segment(key.workspaceId)]) {
    path = join(path, part)
    let value
    try {
      value = await lstat(path)
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    if (value.isSymbolicLink() || !value.isDirectory())
      throw new Error("Conversation storage must be a real directory within the workspace's store.")
  }
  return true
}
async function fingerprint(path: string, file: string): Promise<Fingerprint | null> {
  try {
    const value = await lstat(path)
    return value.isFile() && !value.isSymbolicLink() ? { file, size: value.size, mtime: value.mtimeMs } : null
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}
/** Where to read an oversized transcript: its opening and its end. */
const HEAD_BYTES = 1024 * 1024
const CHUNK_BYTES = 64 * 1024
/**
 * Whether a transcript line can be an event search reads. A cheap test on the
 * raw text, before the parse: an event's type is written in it, so a line
 * that names neither type is neither, whatever its payload holds.
 */
const mightBeSearched = (line: string) => line.includes('user_message') || line.includes('content_delta')
async function* readEvents(
  root: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
  keep?: (line: string) => boolean,
): AsyncIterable<ConversationEvent> {
  const info = await fingerprint(path, '')
  if (!info) return
  const file = await openConfinedExistingFile(await conversationConfinementRoot(root, path), path)
  try {
    const size = (await file.stat()).size
    for (const range of wholeFileRanges(size, maxBytes))
      for await (const line of readLines(file, range.start, range.end, signal)) {
        signal?.throwIfAborted()
        if (keep && !keep(line.text)) continue
        const event = parseEvent(line.text)
        if (event) yield event
      }
  } finally {
    await file.close()
  }
}
/** The whole file, or its opening and its last `maxBytes` when it is longer than that. */
function wholeFileRanges(size: number, maxBytes: number): Array<{ start: number; end: number }> {
  return size > maxBytes && size - maxBytes > HEAD_BYTES
    ? [
        { start: 0, end: HEAD_BYTES },
        { start: size - maxBytes, end: size },
      ]
    : [{ start: 0, end: size }]
}
/**
 * The complete lines between two byte offsets, each with the offset just past
 * its newline. What follows the last newline is an append still in progress
 * (or the cut end of a range) and is left for the next read. A range that
 * starts mid-line yields that line's tail, which does not parse and is skipped.
 */
async function* readLines(
  file: FileHandle,
  start: number,
  end: number,
  signal?: AbortSignal,
): AsyncIterable<{ text: string; next: number }> {
  const chunk = Buffer.alloc(CHUNK_BYTES)
  let carry: Buffer[] = []
  let position = start
  while (position < end) {
    signal?.throwIfAborted()
    const { bytesRead } = await file.read(chunk, 0, Math.min(CHUNK_BYTES, end - position), position)
    if (!bytesRead) return
    let lineStart = 0
    for (let index = chunk.indexOf(0x0a, 0); index >= 0 && index < bytesRead; index = chunk.indexOf(0x0a, index + 1)) {
      carry.push(chunk.subarray(lineStart, index))
      const text = Buffer.concat(carry).toString('utf8')
      carry = []
      lineStart = index + 1
      yield { text, next: position + lineStart }
    }
    if (lineStart < bytesRead) carry.push(Buffer.from(chunk.subarray(lineStart, bytesRead)))
    position += bytesRead
  }
}
function parseEvent(line: string): ConversationEvent | null {
  try {
    const value = record(JSON.parse(line))
    return typeof value.type === 'string' && typeof value.agentId === 'string' && typeof value.createdAt === 'number'
      ? (value as ConversationEvent)
      : null
  } catch {
    // A range cut mid-line leaves a fragment that does not parse; it is skipped.
    return null
  }
}
/** Rethrows cancellation; any other read failure ends that transcript's events. */
async function* guarded(events: AsyncIterable<ConversationEvent>, signal?: AbortSignal) {
  try {
    yield* events
  } catch (error) {
    if ((error as Error).name === 'AbortError' || signal?.aborted) throw error
  }
}
/**
 * A transcript's row, read on from `previous` when the file only grew since,
 * else read whole. An append larger than a whole read would be is read whole,
 * so a transcript past the read limit keeps being read from its two ends.
 */
async function readThread(root: string, path: string, maxBytes: number, previous?: ThreadFold): Promise<ThreadFold> {
  const file = await openConfinedExistingFile(await conversationConfinementRoot(root, path), path)
  try {
    const size = (await file.stat()).size
    const head = Buffer.alloc(Math.min(size, FOLD_HEAD_BYTES))
    await file.read(head, 0, head.length, 0)
    const appended =
      previous !== undefined &&
      previous.offset <= size &&
      size - previous.offset <= maxBytes &&
      head.subarray(0, previous.head.length).equals(previous.head)
    const fold: ThreadFold = appended
      ? {
          thread: previous.thread && { ...previous.thread },
          turns: new Set(previous.turns),
          quietTurns: new Set(previous.quietTurns),
          costs: new Map(previous.costs),
          offset: previous.offset,
          head: previous.head,
        }
      : { thread: null, turns: new Set(), quietTurns: new Set(), costs: new Map(), offset: 0, head: Buffer.alloc(0) }
    const ranges = appended ? [{ start: previous.offset, end: size }] : wholeFileRanges(size, maxBytes)
    for (const range of ranges)
      for await (const line of readLines(file, range.start, range.end)) {
        fold.offset = line.next
        const event = parseEvent(line.text)
        if (event) foldEvent(fold, event)
      }
    if (!appended) fold.head = Buffer.from(head.subarray(0, Math.min(head.length, fold.offset)))
    if (fold.thread) {
      fold.thread.turnCount = fold.turns.size
      if (fold.costs.size) fold.thread.totalCostUsd = [...fold.costs.values()].reduce((sum, cost) => sum + cost, 0)
    }
    return fold
  } finally {
    await file.close()
  }
}
function foldEvent(fold: ThreadFold, event: ConversationEvent): void {
  const thread = (fold.thread ??= {
    agentId: event.agentId,
    title: 'New conversation',
    titleSource: 'first-message',
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    turnCount: 0,
    model: event.modelId ?? '',
    providerId: event.providerId ?? '',
    lastSeq: 0,
    firstUserText: '',
  })
  thread.updatedAt = Math.max(thread.updatedAt, event.createdAt)
  thread.model = event.modelId || thread.model
  thread.providerId = event.providerId || thread.providerId
  const parts = record(event).parts
  const partSeqs = Array.isArray(parts)
    ? parts.flatMap((part) => (Array.isArray(part) && typeof part[3] === 'number' ? [part[3]] : []))
    : []
  thread.lastSeq = Math.max(thread.lastSeq, event.seq ?? thread.lastSeq + 1, ...partSeqs)
  // What a fork holds of the chat it came from was spent there: its own total
  // starts at its mark.
  if (event.type === 'session_updated' && event.payload?.forkedFrom && typeof event.payload.forkedFrom === 'object')
    fold.costs.clear()
  // When the agent last finished a turn, as the runtime's session reads it
  // (`lastTurnEndedAt`): a steered turn's end is not one, the work went on.
  // Nor is the end of Studio's own compaction before a cache expired: nothing
  // happened in the chat the person has to come and read.
  if (
    ((event.type === 'turn_completed' && event.payload?.steered !== true) || event.type === 'turn_failed') &&
    !fold.quietTurns.has(text(event.payload?.turnId))
  )
    thread.lastTurnEndedAt = Math.max(thread.lastTurnEndedAt ?? 0, event.createdAt)
  if (
    event.type === 'user_message' &&
    text(event.payload?.turnId) &&
    readConversationMessageOrigin(event.payload?.origin)?.reason === 'auto-compact'
  )
    fold.quietTurns.add(text(event.payload?.turnId))
  if (event.type === 'turn_completed') {
    const cost = event.payload?.costUsd
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
      fold.costs.set(text(event.payload?.turnId) || event.id, cost)
  }
  // The opening of the last reply, kept as the runtime's session keeps it: a
  // message from the person with words, or one Studio sent, starts the next
  // reply afresh; an image-only message from the person does not.
  if (
    event.type === 'user_message' &&
    (readConversationMessageOrigin(event.payload?.origin) || typeof event.payload?.text === 'string')
  )
    thread.lastAssistantText = ''
  else if (event.type === 'content_delta' && typeof event.payload?.text === 'string')
    thread.lastAssistantText = ((thread.lastAssistantText ?? '') + event.payload.text).slice(
      0,
      CONVERSATION_MAX_REPLY_PREVIEW,
    )
  if (event.type === 'user_message') {
    fold.turns.add(text(event.payload?.turnId) || event.id)
    // A message Studio sent the chat is not what the person opened it with.
    if (!thread.firstUserText && !readConversationMessageOrigin(event.payload?.origin)) {
      thread.firstUserText = text(event.payload?.text)
      if (thread.titleSource === 'first-message') thread.title = firstMessageTitle(thread.firstUserText)
    }
  }
  if (event.type === 'session_updated' && typeof event.payload?.conversationTitle === 'string') {
    const source = event.payload.titleSource
    if (source === 'user' || (source === 'generated' && thread.titleSource !== 'user')) {
      thread.title = event.payload.conversationTitle.slice(0, 200)
      thread.titleSource = source
    }
  }
}
/**
 * The cached rows by transcript file, with the fingerprint each was read at. A
 * row belongs to the file its agent's transcript is named for. A file no row
 * can be matched to (empty, or named for another agent) is read again.
 */
function cachedRows(cache: Index | null): Map<string, { file: Fingerprint; thread: ConversationThread }> {
  const rows = new Map<string, { file: Fingerprint; thread: ConversationThread }>()
  if (!cache) return rows
  const threads = new Map<string, ConversationThread>()
  for (const thread of cache.threads) threads.set(`${segment(thread.agentId)}.jsonl`, thread)
  for (const file of cache.files) {
    const thread = threads.get(file.file) ?? cache.threads.find((entry) => entry.agentId === fileAgentId(file.file))
    if (thread) rows.set(file.file, { file, thread })
  }
  return rows
}
/** A generated-title service can replace this ladder rung without changing index ownership. */
export function firstMessageTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 60) || 'New conversation'
}
const sorted = (threads: ConversationThread[]) => [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
async function readIndex(root: string, path: string): Promise<Index | null> {
  try {
    const file = join(path, 'index.json')
    if ((await lstat(file)).isSymbolicLink()) return null
    const value = record(
      JSON.parse((await readConversationStorage(root, file, MAX_CONVERSATION_METADATA_BYTES)).toString('utf8')),
    )
    if (value.version !== INDEX_VERSION || !Array.isArray(value.threads) || !Array.isArray(value.files)) return null
    if (
      !value.threads.every((thread) => {
        const item = record(thread)
        return (
          typeof item.agentId === 'string' &&
          typeof item.title === 'string' &&
          typeof item.model === 'string' &&
          typeof item.providerId === 'string' &&
          typeof item.firstUserText === 'string' &&
          Number.isFinite(item.createdAt) &&
          Number.isFinite(item.updatedAt) &&
          Number.isSafeInteger(item.turnCount) &&
          Number.isSafeInteger(item.lastSeq) &&
          (item.lastTurnEndedAt === undefined || Number.isFinite(item.lastTurnEndedAt)) &&
          (item.lastAssistantText === undefined || typeof item.lastAssistantText === 'string') &&
          (item.totalCostUsd === undefined ||
            (typeof item.totalCostUsd === 'number' && Number.isFinite(item.totalCostUsd) && item.totalCostUsd >= 0)) &&
          ['first-message', 'user', 'generated'].includes(text(item.titleSource))
        )
      })
    )
      return null
    if (
      !value.files.every((file) => {
        const item = record(file)
        return (
          typeof item.file === 'string' &&
          item.file.endsWith('.jsonl') &&
          !/[\\/]/u.test(item.file) &&
          Number.isFinite(item.size) &&
          Number.isFinite(item.mtime)
        )
      })
    )
      return null
    return value as Index
  } catch {
    return null
  }
}
async function saveIndex(root: string, path: string, value: Index): Promise<void> {
  await writeConversationStorage(root, join(path, 'index.json'), `${JSON.stringify(value)}\n`)
}
