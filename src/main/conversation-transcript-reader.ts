import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { openConfinedExistingFile, readBoundedConversationFile } from './conversation-file-access'
import { expandCoalescedDeltas } from './conversation-event-log'
import { MAX_CONVERSATION_TRANSCRIPT_BYTES } from './conversation-persistence'
import { conversationConfinementRoot } from './workspace-store'
import { inferConversationToolKind } from '../shared/conversation/toolKind'
import type { ConversationEvent, ConversationPage } from '../shared/conversation-runtime'

/**
 * Bounded reads of a chat's JSONL transcript, from the end backwards.
 *
 * Everything a client asks of a transcript is about its end: the last few
 * turns to show, the events after the last one it saw, the page just before
 * the oldest one it holds. Reading the whole file for each of those made a
 * reconnect cost the size of the chat, and put a hard ceiling on how long a
 * chat could grow before it could no longer be opened at all. Here each
 * question reads only as far back as its answer reaches, in fixed chunks, with
 * a byte budget per question.
 *
 * Records are read as they are stored: one line per event, or one merged line
 * for a run of deltas that carries each delta's sequence number in `parts`.
 * Pages and catch-up keep a merged run as one event whose `seq` is the run's
 * last, rather than one event per token, so a snapshot of a streamed answer is
 * a few records instead of thousands of envelopes. A transcript written before
 * sequence numbers were stored is read forwards once and numbered by position,
 * as it always was.
 */

export type ConversationTranscriptLimits = {
  /** Largest read that holds a transcript in memory: the whole of a legacy one, or the tail of `readTranscript`. */
  fullReadBytes: number
  /** Byte budget of one snapshot or earlier page; it ends early, turn-aligned where it can be. */
  pageBytes: number
  /** A reconnect further behind than either of these gets a fresh snapshot instead of the missed events. */
  catchUpEvents: number
  catchUpBytes: number
}

export const DEFAULT_TRANSCRIPT_LIMITS: ConversationTranscriptLimits = {
  fullReadBytes: MAX_CONVERSATION_TRANSCRIPT_BYTES,
  pageBytes: 8 * 1024 * 1024,
  catchUpEvents: 2000,
  catchUpBytes: 8 * 1024 * 1024,
}

/** Generation of a transcript that does not exist yet. */
const EMPTY_TRANSCRIPT_GENERATION = 'empty'

const CHUNK_BYTES = 64 * 1024
const HEAD_BYTES = 64 * 1024
// One record longer than this is skipped rather than assembled in memory.
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const MAX_CONCURRENT_READS = 4
const MAX_CACHED_OFFSETS = 4096
// The parsed ends of the transcripts read most recently, kept so reading one
// again parses only what was appended since. The bytes are the source lines'.
const PARSED_TAIL_TRANSCRIPTS = 8
const PARSED_TAIL_BYTES = 24 * 1024 * 1024

type DeltaPart = [string, number, number, number?]

type TranscriptRecord = {
  event: ConversationEvent & { parts?: DeltaPart[] }
  firstSeq: number
  lastSeq: number
  // Where the line starts in the file; absent for records of a legacy read.
  offset?: number
  bytes: number
}

type Records = AsyncIterable<TranscriptRecord>

/**
 * The newest records of one transcript as parsed, newest first, covering the
 * file from `start` to `end` without a gap. A transcript is only ever appended
 * to, so while its file and first line are the same and it has not shrunk,
 * these are still its records; whatever lies past `end` is newer.
 */
type ParsedTail = {
  ino: number
  generation: string
  start: number
  end: number
  bytes: number
  records: TranscriptRecord[]
}

export type TranscriptSyncResult =
  | { kind: 'events'; events: ConversationEvent[]; head: number; generation: string }
  | { kind: 'snapshot'; page: ConversationPage; head: number; generation: string }

class LegacyTranscript extends Error {}

export class ConversationTranscriptReader {
  private readonly limits: ConversationTranscriptLimits
  private active = 0
  private readonly waiting: Array<() => void> = []
  // Where page-start records live, so paging back does not rescan from the end.
  private readonly offsets = new Map<string, { generation: string; bySeq: Map<number, number> }>()
  // Least recently read first.
  private readonly tails = new Map<string, ParsedTail>()

  constructor(limits: Partial<ConversationTranscriptLimits> = {}) {
    this.limits = { ...DEFAULT_TRANSCRIPT_LIMITS, ...limits }
  }

  forget(path: string): void {
    this.offsets.delete(path)
    this.tails.delete(path)
  }

  /**
   * What a subscriber needs to join: the events after `afterSeq` when the
   * cursor provably belongs to this log (same generation, not ahead of it, not
   * too far behind), otherwise the last `turnLimit` turns to replace whatever
   * it holds.
   */
  sync(
    root: string,
    path: string,
    input: { afterSeq?: number; generation?: string; turnLimit?: number; forceSnapshot?: boolean },
  ): Promise<TranscriptSyncResult> {
    return this.read(root, path, async (records, generation) => {
      const { afterSeq } = input
      if (
        !input.forceSnapshot &&
        afterSeq !== undefined &&
        Number.isSafeInteger(afterSeq) &&
        afterSeq >= 0 &&
        input.generation === generation
      ) {
        const caught = await this.after(records, afterSeq)
        if (caught) return { kind: 'events' as const, ...caught, generation }
      }
      const { page, head } = await this.page(path, generation, records, input.turnLimit)
      return { kind: 'snapshot' as const, page, head, generation }
    })
  }

  /** The `turnLimit` turns that end just before `beforeCursor`. */
  before(root: string, path: string, beforeCursor: number, turnLimit?: number): Promise<ConversationPage> {
    return this.read(root, path, async (records, generation, file) => {
      const cached = this.offsets.get(path)
      const offset = cached?.generation === generation ? cached.bySeq.get(beforeCursor) : undefined
      // Within the parsed tail, skipping to the cursor costs no read.
      const tail = this.tails.get(path)
      const parsed = tail?.generation === generation && offset !== undefined && offset > tail.start
      const source =
        offset !== undefined && file && !parsed ? backwardRecords(file, offset) : skipFrom(records, beforeCursor)
      return (await this.page(path, generation, source, turnLimit)).page
    })
  }

  /**
   * The newest events, oldest first: expanded to one per sequence number, or
   * with `compact`, as stored, a merged run of deltas as one event carrying
   * the run's text, for a reader that only folds the text.
   */
  tail(
    root: string,
    path: string,
    limit: { events?: number; bytes?: number; compact?: boolean } = {},
  ): Promise<ConversationEvent[]> {
    return this.read(root, path, async (records) => {
      const maxBytes = limit.bytes ?? this.limits.fullReadBytes
      const maxEvents = limit.events ?? Number.POSITIVE_INFINITY
      const newest: ConversationEvent[][] = []
      let bytes = 0
      let count = 0
      for await (const record of records) {
        bytes += record.bytes
        if (bytes > maxBytes && newest.length > 0) break
        const expanded = limit.compact ? [compact(record)] : expandCoalescedDeltas({ ...record.event })
        newest.push(expanded)
        count += expanded.length
        if (count >= maxEvents) break
      }
      const events = newest.reverse().flat()
      return Number.isFinite(maxEvents) ? events.slice(-maxEvents) : events
    })
  }

  /**
   * The newest turn as stored, oldest first: the events back to and including
   * the newest user message, a merged run of deltas as one event. A turn
   * longer than `bytes` comes back as its newest part, without the message.
   */
  lastTurn(root: string, path: string, bytes: number): Promise<ConversationEvent[]> {
    return this.read(root, path, async (records) => {
      const newest: ConversationEvent[] = []
      let read = 0
      for await (const record of records) {
        read += record.bytes
        if (read > bytes && newest.length > 0) break
        newest.push(compact(record))
        if (record.event.type === 'user_message') break
      }
      return newest.reverse()
    })
  }

  /**
   * The newest stored event matching `predicate`, scanning back as far as it
   * takes, or with `maxBytes`, no further back than that many bytes.
   */
  findLast(
    root: string,
    path: string,
    predicate: (event: ConversationEvent) => boolean,
    maxBytes = Number.POSITIVE_INFINITY,
  ): Promise<ConversationEvent | undefined> {
    return this.read(root, path, async (records) => {
      let read = 0
      for await (const record of records) {
        if (predicate(record.event)) return { ...record.event }
        read += record.bytes
        if (read > maxBytes) break
      }
      return undefined
    })
  }

  /** The oldest stored event matching `predicate` within the first `maxBytes` of the log. */
  async findFirst(
    root: string,
    path: string,
    predicate: (event: ConversationEvent) => boolean,
    maxBytes = 1024 * 1024,
  ): Promise<ConversationEvent | undefined> {
    return this.withFile(root, path, async (file) => {
      if (!file) return undefined
      const { size } = await file.stat()
      const buffer = Buffer.alloc(Math.min(size, maxBytes))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      const complete = text.slice(0, text.lastIndexOf('\n') + 1)
      for (const line of complete.split('\n')) {
        const event = parseRecordEvent(line)
        if (event && predicate(event)) return event
      }
      return undefined
    })
  }

  private async after(
    records: Records,
    afterSeq: number,
  ): Promise<{ events: ConversationEvent[]; head: number } | null> {
    const newer: TranscriptRecord[] = []
    let head: number | null = null
    let bytes = 0
    let reachedCursor = false
    for await (const record of records) {
      head ??= record.lastSeq
      if (afterSeq > head || head - afterSeq > this.limits.catchUpEvents) return null
      if (record.lastSeq <= afterSeq) {
        reachedCursor = true
        break
      }
      bytes += record.bytes
      if (bytes > this.limits.catchUpBytes) return null
      newer.push(record)
      if (record.firstSeq <= afterSeq) {
        reachedCursor = true
        break
      }
    }
    head ??= 0
    if (afterSeq > head) return null
    // Every record is newer than a non-zero cursor: this log begins after it,
    // so it is not the log the cursor came from.
    if (!reachedCursor && afterSeq > 0) return null
    const events = newer.reverse().map((record, index) => compact(record, index === 0 ? afterSeq : undefined))
    return { events, head }
  }

  private async page(
    path: string,
    generation: string,
    records: Records,
    requested = 10,
  ): Promise<{ page: ConversationPage; head: number }> {
    const limit = Math.max(1, Math.min(100, Math.floor(requested) || 10))
    const page: TranscriptRecord[] = []
    const prefix: TranscriptRecord[] = []
    let turns = 0
    let bytes = 0
    let hasMore = false
    let head: number | null = null
    for await (const record of records) {
      head ??= record.lastSeq
      if (turns === limit) {
        // Enough turns; what is left before the oldest belongs to this page
        // only if no earlier turn exists (the session's opening events).
        bytes += record.bytes
        if (record.event.type === 'user_message' || bytes > this.limits.pageBytes) {
          hasMore = true
          break
        }
        prefix.push(record)
        continue
      }
      if (page.length > 0 && bytes + record.bytes > this.limits.pageBytes) {
        hasMore = true
        break
      }
      bytes += record.bytes
      page.push(record)
      if (record.event.type === 'user_message') turns++
    }
    const kept = hasMore ? page : [...page, ...prefix]
    const oldest = kept.at(-1)
    if (oldest?.offset !== undefined) this.remember(path, generation, oldest.firstSeq, oldest.offset)
    return {
      page: {
        events: kept.reverse().map((record) => compact(record)),
        hasMore,
        beforeCursor: oldest?.firstSeq ?? null,
      },
      head: head ?? 0,
    }
  }

  private remember(path: string, generation: string, seq: number, offset: number): void {
    let cached = this.offsets.get(path)
    if (!cached || cached.generation !== generation) {
      cached = { generation, bySeq: new Map() }
      this.offsets.set(path, cached)
    }
    if (cached.bySeq.size >= MAX_CACHED_OFFSETS) cached.bySeq.clear()
    cached.bySeq.set(seq, offset)
  }

  /**
   * Run `work` over the transcript's records, newest first. A transcript with
   * unnumbered records is re-run over a forward read that numbers them by
   * position, bounded like any whole-file read.
   */
  private read<T>(
    root: string,
    path: string,
    work: (records: Records, generation: string, file?: FileHandle) => Promise<T>,
  ): Promise<T> {
    return this.withFile(root, path, async (file) => {
      if (!file) {
        this.tails.delete(path)
        return work(emptyRecords(), EMPTY_TRANSCRIPT_GENERATION)
      }
      const { size, ino } = await file.stat()
      const generation = await readGeneration(file, size)
      try {
        return await work(await this.tailRecords(path, file, size, ino, generation), generation, file)
      } catch (error) {
        if (!(error instanceof LegacyTranscript)) throw error
        this.tails.delete(path)
      }
      const raw = await readBoundedConversationFile(file, this.limits.fullReadBytes)
      return work(legacyRecords(raw.toString('utf8')), generation)
    })
  }

  /**
   * The transcript's records newest first, as `backwardRecords` reads them,
   * with the parsed tail standing in for the part of the file it covers: only
   * what was appended since is read and parsed, and the records a reader goes
   * on to read from disk are added to the tail, within its budget.
   */
  private async tailRecords(
    path: string,
    file: FileHandle,
    size: number,
    ino: number,
    generation: string,
  ): Promise<Records> {
    let tail = this.tails.get(path)
    this.tails.delete(path)
    // A tail with no records has no boundary a newer read could start from.
    if (tail && (!tail.records.length || tail.ino !== ino || tail.generation !== generation || tail.end > size))
      tail = undefined
    if (tail && size > tail.end) {
      const appended: TranscriptRecord[] = []
      let bytes = 0
      for await (const record of backwardRecords(file, size, tail.end)) {
        appended.push(record)
        bytes += record.bytes
        // Further behind than one budget: what is held is not worth joining up.
        if (bytes > this.tailLimit()) break
      }
      if (bytes > this.tailLimit()) tail = undefined
      else if (appended.length) {
        const newest = appended[0]
        tail = {
          ...tail,
          end: newest.offset! + newest.bytes,
          bytes: tail.bytes + bytes,
          records: [...appended, ...tail.records],
        }
        trimTail(tail, this.tailLimit())
      }
    }
    tail ??= { ino, generation, start: size, end: size, bytes: 0, records: [] }
    this.tails.set(path, tail)
    this.trimTails()
    return extendTail(this.tails, path, tail, file, this.tailLimit())
  }

  private tailLimit(): number {
    return Math.min(PARSED_TAIL_BYTES, this.limits.pageBytes + this.limits.pageBytes / 4)
  }

  private trimTails(): void {
    let bytes = 0
    for (const tail of this.tails.values()) bytes += tail.bytes
    for (const [path, tail] of this.tails) {
      if (this.tails.size <= PARSED_TAIL_TRANSCRIPTS && bytes <= PARSED_TAIL_BYTES) break
      this.tails.delete(path)
      bytes -= tail.bytes
    }
  }

  private async withFile<T>(root: string, path: string, work: (file: FileHandle | null) => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      let file: FileHandle
      try {
        file = await openConfinedExistingFile(await conversationConfinementRoot(root, path), path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await work(null)
        throw error
      }
      try {
        return await work(file)
      } finally {
        await file.close()
      }
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_READS) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }
}

/**
 * A log's identity: a hash of its first line. The first record carries an event
 * id that is unique to the run that created the log, so a deleted and
 * recreated transcript never matches a cursor from the old one, and nothing
 * has to be stored beside the log to keep the two in step.
 */
async function readGeneration(file: FileHandle, size: number): Promise<string> {
  if (size === 0) return EMPTY_TRANSCRIPT_GENERATION
  const buffer = Buffer.alloc(Math.min(size, HEAD_BYTES))
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
  const head = buffer.subarray(0, bytesRead)
  const newline = head.indexOf(0x0a)
  return createHash('sha256')
    .update(newline < 0 ? head : head.subarray(0, newline))
    .digest('base64url')
    .slice(0, 22)
}

/**
 * Complete records ending at or before `end`, newest first. Whatever follows
 * the last newline is an append still in progress (or nothing, when the file
 * ends with one) and is left for the next read; the event in it has not been
 * published.
 */
async function* backwardRecords(file: FileHandle, end: number, floor = 0): Records {
  let position = end
  let carry: Buffer[] = []
  let carryBytes = 0
  let oversized = false
  let trailing = true
  const chunk = Buffer.alloc(CHUNK_BYTES)
  const emit = (offset: number): TranscriptRecord | null => {
    const skipped = oversized || trailing
    const line = Buffer.concat(carry, carryBytes)
    carry = []
    carryBytes = 0
    oversized = false
    trailing = false
    if (skipped || line.length === 0) return null
    return parseRecord(line.toString('utf8'), offset, line.length + 1)
  }
  while (position > floor) {
    const length = Math.min(CHUNK_BYTES, position - floor)
    const start = position - length
    let read = 0
    while (read < length) {
      const { bytesRead } = await file.read(chunk, read, length - read, start + read)
      if (!bytesRead) throw new Error('Conversation transcript shrank while it was read.')
      read += bytesRead
    }
    let segmentEnd = length
    for (let index = length - 1; index >= 0; index--) {
      if (chunk[index] !== 0x0a) continue
      prepend(chunk.subarray(index + 1, segmentEnd))
      const record = emit(start + index + 1)
      if (record) yield record
      segmentEnd = index
    }
    prepend(chunk.subarray(0, segmentEnd))
    position = start
  }
  const first = emit(floor)
  if (first) yield first

  function prepend(bytes: Buffer): void {
    if (bytes.length === 0 || oversized) return
    carryBytes += bytes.length
    if (carryBytes > MAX_RECORD_BYTES) {
      oversized = true
      carry = []
      carryBytes = 0
      return
    }
    carry.unshift(Buffer.from(bytes))
  }
}

function parseRecord(line: string, offset: number, bytes: number): TranscriptRecord | null {
  const event = parseRecordEvent(line) as TranscriptRecord['event'] | null
  if (!event) return null
  if (typeof event.seq !== 'number') throw new LegacyTranscript()
  let lastSeq = event.seq
  if (Array.isArray(event.parts)) {
    for (const part of event.parts) {
      if (!Array.isArray(part) || typeof part[3] !== 'number') throw new LegacyTranscript()
      lastSeq = Math.max(lastSeq, part[3])
    }
  }
  return { event, firstSeq: event.seq, lastSeq, offset, bytes }
}

function parseRecordEvent(line: string): ConversationEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as ConversationEvent
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null
    if (parsed.type === 'tool_started' && parsed.payload && !parsed.payload.kind)
      parsed.payload.kind = inferConversationToolKind(String(parsed.payload.name ?? parsed.payload.tool ?? ''))
    return parsed
  } catch {
    // A torn or corrupt line (a crash mid-append) is skipped.
    return null
  }
}

/** A legacy transcript read forwards, each event numbered by position where it has no number. */
async function* legacyRecords(raw: string): Records {
  const events: ConversationEvent[] = []
  for (const line of raw.split('\n')) {
    const event = parseRecordEvent(line)
    if (event) events.push(...expandCoalescedDeltas(event))
  }
  let seq = 0
  for (const event of events) {
    event.seq = typeof event.seq === 'number' && event.seq > seq ? event.seq : seq + 1
    seq = event.seq
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    yield { event, firstSeq: event.seq!, lastSeq: event.seq!, bytes: JSON.stringify(event).length + 1 }
  }
}

async function* emptyRecords(): Records {}

/**
 * The tail's records, then the file's older ones read from where it starts.
 * A record read from disk joins the tail while the tail is still the one held
 * for the path and the record is the very next one back, so the tail never has
 * a gap; once the read reaches the head of the file the tail is the whole log.
 */
async function* extendTail(
  tails: Map<string, ParsedTail>,
  path: string,
  tail: ParsedTail,
  file: FileHandle,
  limit: number,
): Records {
  let index = 0
  while (index < tail.records.length) yield tail.records[index++]
  let from = tail.start
  if (from === 0) return
  let joining = true
  for await (const record of backwardRecords(file, from)) {
    joining &&= tails.get(path) === tail && tail.start === from && tail.bytes + record.bytes <= limit
    if (joining) {
      if (!tail.records.length) tail.end = record.offset! + record.bytes
      tail.records.push(record)
      tail.bytes += record.bytes
      tail.start = from = record.offset!
    }
    yield record
  }
  if (joining && tails.get(path) === tail && tail.start === from) tail.start = 0
}

function trimTail(tail: ParsedTail, limit: number): void {
  while (tail.bytes > limit && tail.records.length) {
    const oldest = tail.records.pop()!
    tail.bytes -= oldest.bytes
    tail.start = tail.records.length ? tail.records.at(-1)!.offset! : tail.end
  }
}

async function* skipFrom(records: Records, beforeCursor: number): Records {
  for await (const record of records) if (record.lastSeq < beforeCursor) yield record
}

/**
 * One record as one event: a merged run of deltas stays merged, numbered with
 * its last delta's sequence. With `afterSeq`, only the deltas after it are
 * kept — a reconnect can land in the middle of a run.
 */
function compact(record: TranscriptRecord, afterSeq?: number): ConversationEvent {
  const { parts, ...event } = record.event
  if (!Array.isArray(parts) || parts.length === 0) return { ...event, seq: record.lastSeq }
  const text = typeof event.payload?.text === 'string' ? event.payload.text : null
  if (afterSeq === undefined || record.firstSeq > afterSeq || text === null) return { ...event, seq: record.lastSeq }
  let offset = 0
  let index = 0
  while (index < parts.length && (parts[index][3] ?? 0) <= afterSeq) offset += parts[index++][2]
  const first = parts[index]
  return {
    ...event,
    id: first?.[0] ?? event.id,
    createdAt: first?.[1] ?? event.createdAt,
    seq: record.lastSeq,
    payload: { ...event.payload, text: text.slice(offset) },
  }
}
