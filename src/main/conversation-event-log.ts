import { dirname } from 'path'
import { openConfinedExistingFile } from './conversation-file-access'
import { openConversationAppendFile } from './conversation-persistence'
import { conversationConfinementRoot } from './workspace-store'

import type { ConversationEvent } from '../shared/conversation-runtime'

/**
 * The append side of a chat's JSONL transcript.
 *
 * Every event gets its sequence number before it reaches this log, and the
 * runtime publishes an event to subscribers only once the append for it has
 * resolved — so any sequence number a client has seen is on disk, and a client
 * that drops and reconnects can ask for "everything after N" instead of the
 * whole chat again. That makes the write sit on the live path, so it is
 * batched rather than awaited event by event:
 *
 *  - Events queue in memory. A boundary event (anything that is not a delta or
 *    a partial tool output) writes the queue at once, itself included; deltas
 *    wait at most {@link DEFAULT_DELTA_FLUSH_MS}, partial tool output at most
 *    {@link DEFAULT_TOOL_OUTPUT_FLUSH_MS}. A streaming chat therefore costs one
 *    write per flush window rather than one per token, and on-screen latency is
 *    bounded by the window.
 *  - Consecutive deltas of one kind in one turn are merged into a single
 *    record. A merged record keeps the first delta's envelope and carries
 *    `parts` — each original delta's id, timestamp, length and sequence — so
 *    {@link expandCoalescedDeltas} can hand a reader the exact events that were
 *    published live.
 *  - A partial tool output replaces the one before it for the same tool while
 *    both are still queued: each carries the latest preview, so the earlier one
 *    is dead weight on disk. Its append resolves `superseded` and the runtime
 *    does not publish it. Dropping it never exposes a sequence number past the
 *    durable end of the log, because the record that replaced it is written in
 *    the same batch with a higher one.
 *  - One append stream stays open per transcript file and every write goes
 *    through it in order, so on-disk order is sequence order.
 */

/** How long a delta may sit in memory before its batch is written anyway. */
export const DEFAULT_DELTA_FLUSH_MS = 40

/** How long a partial tool output may wait; later output for the same tool replaces it meanwhile. */
const DEFAULT_TOOL_OUTPUT_FLUSH_MS = 500

/**
 * How long one write may take before it counts as failed. Events are published
 * only once their write settles, so a write that never does (a hung network
 * volume, a wedged disk) would otherwise stall the chat without a word.
 */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000

/**
 * How an append ended. `superseded`: a later event for the same tool replaced
 * this one before it was written. `failed`: the write failed and was reported
 * through `onError`; the event is not on disk.
 */
export type ConversationAppendOutcome = 'written' | 'superseded' | 'failed'

/** `[event id, createdAt, text length, seq]` for one delta folded into a merged record. */
type DeltaPart = [string, number, number, number?]

type PersistedEvent = ConversationEvent & { parts?: DeltaPart[] }

type DeltaRun = { event: ConversationEvent; text: string; parts: DeltaPart[] }

type Entry =
  | { kind: 'run'; run: DeltaRun }
  | { kind: 'event'; event: ConversationEvent; partialToolUseId?: string; superseded?: boolean }

type Waiter = {
  entry: Entry
  resolve: (outcome: ConversationAppendOutcome) => void
  reject: (error: unknown) => void
}

export type AppendStream = {
  write(chunk: string): Promise<void>
  close(): Promise<void>
}

export type ConversationEventLogOptions = {
  flushDelayMs?: number
  toolOutputFlushDelayMs?: number
  writeTimeoutMs?: number
  openStream?: (filePath: string, storageRoot?: string) => Promise<AppendStream>
  onError?: (filePath: string, error: unknown) => void
}

type FileLog = {
  storageRoot?: string
  entries: Entry[]
  waiters: Waiter[]
  timer: NodeJS.Timeout | null
  deadline: number
  stream: Promise<AppendStream> | null
  // Every write and close for this file, in order. Never rejects.
  tail: Promise<void>
}

export class ConversationEventLog {
  private readonly files = new Map<string, FileLog>()
  // Closes still in flight, so a log reopened for the same file queues its
  // first write behind the old stream's last one.
  private readonly closing = new Map<string, Promise<void>>()
  private readonly flushDelayMs: number
  private readonly toolOutputFlushDelayMs: number
  private readonly writeTimeoutMs: number
  private readonly openStream: (filePath: string, storageRoot?: string) => Promise<AppendStream>
  private readonly onError: (filePath: string, error: unknown) => void

  constructor(options: ConversationEventLogOptions = {}) {
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_DELTA_FLUSH_MS)
    this.toolOutputFlushDelayMs = Math.max(
      this.flushDelayMs,
      options.toolOutputFlushDelayMs ?? Math.max(DEFAULT_TOOL_OUTPUT_FLUSH_MS, this.flushDelayMs),
    )
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS
    this.openStream = options.openStream ?? openAppendStream
    this.onError = options.onError ?? (() => undefined)
  }

  /**
   * Record `event`. Settles once the batch holding it has been written (or it
   * was superseded before that). A write failure resolves `failed` after
   * `onError` has seen it — a transcript that cannot be written must not take
   * the live chat down — and rejects only when `onError` itself throws.
   */
  append(filePath: string, event: ConversationEvent, storageRoot?: string): Promise<ConversationAppendOutcome> {
    const log = this.fileLog(filePath)
    log.storageRoot ??= storageRoot
    const done = new Promise<ConversationAppendOutcome>((resolve, reject) => {
      const entry = this.enqueue(log, event)
      log.waiters.push({ entry, resolve, reject })
    })
    if (isDelta(event)) this.schedule(filePath, log, this.flushDelayMs)
    else if (partialToolUseId(event)) this.schedule(filePath, log, this.toolOutputFlushDelayMs)
    else void this.write(filePath, log)
    return done
  }

  /**
   * Write whatever is queued — for one file, or for all of them — and wait
   * for it to be on disk. A file whose log is being closed (the idle sweep, a
   * session stopping) is already detached from `files`, but its last chunk may
   * still be in flight: a reader that flushes before reading waits for that
   * close too, or it could read the transcript without its tail.
   */
  async flush(filePath?: string): Promise<void> {
    const targets =
      filePath === undefined ? new Set([...this.files.keys(), ...this.closing.keys()]) : new Set([filePath])
    await Promise.all(
      Array.from(targets, (path) => {
        const log = this.files.get(path)
        // A log reopened during a close queues behind it (its tail starts from
        // the close), so its own write covers both.
        if (log) return this.write(path, log)
        return this.closing.get(path) ?? Promise.resolve()
      }),
    )
  }

  /** Flush and close one file's stream. A later append simply opens a new one. */
  async close(filePath: string): Promise<void> {
    const log = this.files.get(filePath)
    // Already closing: the caller still expects it closed when this settles.
    if (!log) return this.closing.get(filePath)
    // Detached first, so an append that lands while this close is in flight
    // starts a new log (queued behind this close) instead of adding to one
    // that is about to be closed and forgotten.
    this.files.delete(filePath)
    const done = this.write(filePath, log).then(async () => {
      const stream = log.stream
      log.stream = null
      if (!stream) return
      try {
        await (await stream).close()
      } catch (error) {
        this.reportQuietly(filePath, error)
      }
    })
    this.closing.set(filePath, done)
    await done
    if (this.closing.get(filePath) === done) this.closing.delete(filePath)
  }

  /**
   * Close every stream. An append racing the shutdown opens a fresh log while
   * the first pass is closing, so this repeats until nothing is left open —
   * a stream opened and never closed is a descriptor the garbage collector
   * ends up closing, which newer Node versions treat as an error.
   */
  async closeAll(): Promise<void> {
    while (this.files.size > 0 || this.closing.size > 0) {
      await Promise.all([
        ...Array.from(this.files.keys(), (path) => this.close(path)),
        ...Array.from(this.closing.values()),
      ])
    }
  }

  private fileLog(filePath: string): FileLog {
    let log = this.files.get(filePath)
    if (!log) {
      const tail = this.closing.get(filePath) ?? Promise.resolve()
      log = { entries: [], waiters: [], timer: null, deadline: 0, stream: null, tail }
      this.files.set(filePath, log)
    }
    return log
  }

  private enqueue(log: FileLog, event: ConversationEvent): Entry {
    if (isDelta(event)) {
      const text = deltaText(event)
      const last = log.entries.at(-1)
      if (text !== null && last?.kind === 'run' && canExtend(last.run, event)) {
        last.run.text += text
        last.run.parts.push([event.id, event.createdAt, text.length, event.seq])
        return last
      }
      const entry: Entry =
        text === null
          ? { kind: 'event', event }
          : { kind: 'run', run: { event, text, parts: [[event.id, event.createdAt, text.length, event.seq]] } }
      log.entries.push(entry)
      return entry
    }
    const toolUseId = toolOutputId(event)
    if (toolUseId !== null) {
      // Latest preview wins: anything queued for this tool is replaced by this
      // event, whether it is another partial or the final output.
      for (const queued of log.entries)
        if (queued.kind === 'event' && queued.partialToolUseId === toolUseId) queued.superseded = true
    }
    const partial = partialToolUseId(event)
    const entry: Entry = { kind: 'event', event, ...(partial ? { partialToolUseId: partial } : {}) }
    log.entries.push(entry)
    return entry
  }

  private schedule(filePath: string, log: FileLog, delayMs: number): void {
    const deadline = Date.now() + delayMs
    if (log.timer && log.deadline <= deadline) return
    if (log.timer) clearTimeout(log.timer)
    log.deadline = deadline
    log.timer = setTimeout(() => {
      log.timer = null
      void this.write(filePath, log)
    }, delayMs)
    log.timer.unref?.()
  }

  private write(filePath: string, log: FileLog): Promise<void> {
    if (log.timer) {
      clearTimeout(log.timer)
      log.timer = null
    }
    if (log.entries.length === 0) return log.tail
    const entries = log.entries
    const waiters = log.waiters
    log.entries = []
    log.waiters = []
    const chunk = entries
      .filter((entry) => entry.kind === 'run' || !entry.superseded)
      .map((entry) => (entry.kind === 'run' ? serializeRun(entry.run) : serialize(entry.event)))
      .join('')
    const outcome = (entry: Entry, ok: boolean): ConversationAppendOutcome =>
      entry.kind === 'event' && entry.superseded ? 'superseded' : ok ? 'written' : 'failed'
    log.tail = log.tail.then(async () => {
      let ok = true
      let timedOut = false
      let timer: NodeJS.Timeout | undefined
      try {
        if (chunk) {
          if (!log.stream) log.stream = this.openStream(filePath, log.storageRoot)
          const stream = log.stream
          await Promise.race([
            stream.then((open) => open.write(chunk)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true
                reject(new Error(`Writing the conversation transcript took longer than ${this.writeTimeoutMs} ms.`))
              }, this.writeTimeoutMs)
              timer.unref?.()
            }),
          ]).finally(() => clearTimeout(timer))
        }
      } catch (error) {
        ok = false
        // Drop the broken stream so the next write reopens rather than failing
        // forever on a handle that is gone. A stream whose write never settled
        // may never close either, so that close is not waited for.
        const broken = log.stream
        log.stream = null
        const closing = broken?.then((stream) => stream.close()).catch(() => undefined)
        if (!timedOut) await closing
        try {
          this.onError(filePath, error)
        } catch (reported) {
          for (const waiter of waiters) waiter.reject(reported)
          return
        }
      }
      for (const waiter of waiters) waiter.resolve(outcome(waiter.entry, ok))
    })
    return log.tail
  }

  private reportQuietly(filePath: string, error: unknown): void {
    try {
      this.onError(filePath, error)
    } catch {
      // A close failure has no caller left to tell.
    }
  }
}

/**
 * The events a reader should see for one persisted record: a merged delta
 * record back into the deltas it was built from, anything else as it is.
 */
export function expandCoalescedDeltas(record: ConversationEvent): ConversationEvent[] {
  const { parts, ...event } = record as PersistedEvent
  if (!Array.isArray(parts) || parts.length === 0) return [record]
  const text = deltaText(event)
  if (text === null || !parts.every(isDeltaPart)) return [event]
  if (parts.reduce((sum, part) => sum + part[2], 0) !== text.length) return [event]
  const expanded: ConversationEvent[] = []
  let offset = 0
  for (const [id, createdAt, length, seq] of parts) {
    expanded.push({
      ...event,
      id,
      createdAt,
      ...(typeof seq === 'number' ? { seq } : {}),
      payload: { ...event.payload, text: text.slice(offset, offset + length) },
    })
    offset += length
  }
  return expanded
}

function isDelta(event: ConversationEvent): boolean {
  return event.type === 'content_delta' || event.type === 'reasoning_delta'
}

function toolOutputId(event: ConversationEvent): string | null {
  if (event.type !== 'tool_output') return null
  const id = event.payload?.toolUseId
  return typeof id === 'string' && id ? id : null
}

/** A tool output that a later one for the same tool replaces, or null. */
function partialToolUseId(event: ConversationEvent): string | null {
  return event.payload?.partial === true ? toolOutputId(event) : null
}

/** The delta's text when its payload is exactly `{ turnId?, text }`, else null (written as-is). */
function deltaText(event: ConversationEvent): string | null {
  const payload = event.payload
  if (!payload || typeof payload.text !== 'string') return null
  for (const key of Object.keys(payload)) if (key !== 'text' && key !== 'turnId') return null
  return payload.text
}

function canExtend(run: DeltaRun, event: ConversationEvent): boolean {
  const head = run.event
  return (
    head.type === event.type &&
    head.sessionId === event.sessionId &&
    head.workspaceId === event.workspaceId &&
    head.agentId === event.agentId &&
    head.providerId === event.providerId &&
    head.modelId === event.modelId &&
    head.payload?.turnId === event.payload?.turnId
  )
}

function serialize(event: ConversationEvent): string {
  return `${JSON.stringify(event)}\n`
}

function serializeRun(run: DeltaRun): string {
  if (run.parts.length === 1) return serialize(run.event)
  const merged: PersistedEvent = {
    ...run.event,
    payload: { ...run.event.payload, text: run.text },
    parts: run.parts,
  }
  return serialize(merged)
}

function isDeltaPart(value: unknown): value is DeltaPart {
  return (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    Number.isInteger(value[2]) &&
    value[2] >= 0
  )
}

async function openAppendStream(filePath: string, storageRoot = dirname(filePath)): Promise<AppendStream> {
  const file = await openConversationAppendFile(storageRoot, filePath)
  let unterminated: boolean
  try {
    unterminated = await endsMidLine(storageRoot, filePath, (await file.stat()).size)
  } catch (error) {
    await file.close()
    throw error
  }
  return {
    write: async (chunk) => {
      // A crash or a full disk can leave the last record without its newline.
      // Appending straight after it would glue the next record onto the
      // fragment, and both would be unreadable although this write succeeded
      // and its events were published. The fragment gets a line of its own.
      await file.writeFile(unterminated ? `\n${chunk}` : chunk, 'utf8')
      unterminated = false
    },
    close: () => file.close(),
  }
}

async function endsMidLine(storageRoot: string, filePath: string, size: number): Promise<boolean> {
  if (size === 0) return false
  const reader = await openConfinedExistingFile(await conversationConfinementRoot(storageRoot, filePath), filePath)
  try {
    const last = Buffer.alloc(1)
    const { bytesRead } = await reader.read(last, 0, 1, size - 1)
    return bytesRead === 1 && last[0] !== 0x0a
  } finally {
    await reader.close()
  }
}
