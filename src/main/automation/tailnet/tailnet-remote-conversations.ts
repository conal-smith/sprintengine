import { randomBytes } from 'crypto'

import {
  CONVERSATION_RESYNC_CLOSE_CODE,
  CONVERSATION_SCOPE_CLOSE_CODE,
  conversationCloseRetryAfterMs,
  type ConversationClientFrame,
} from '../../../../packages/conversation-protocol/src'
import {
  explainRejectedConversationMessage,
  parseConversationClientMessage,
  type ConversationClientMessage,
} from '../../../../packages/conversation-protocol/src/clientFrames'
import {
  CONVERSATION_QUEUED_SENDS_CAPABILITY,
  CONVERSATION_SCHEDULED_SENDS_CAPABILITY,
  conversationPeerSupports,
} from '../../../../packages/conversation-protocol/src/handshake'
import {
  isKnownConversationServerFrameType,
  parseConversationServerFrame,
  parseConversationWireEvent,
  type ConversationParsedServerFrame,
  type ConversationWirePage,
} from '../../../../packages/conversation-protocol/src/serverFrames'
import { backoffDelayMs } from '../../../shared/exponentialBackoff'
import type {
  ConversationEvent,
  ConversationPage,
  ConversationPageResult,
  ConversationToolDetail,
  ConversationToolDetailResult,
  ConversationTurnDiffResult,
} from '../../../shared/conversation-runtime'
import { tailnetScopeGrantsAccess, type TailnetScope } from '../../../shared/tailnet'
import type {
  MeshConversationAccess,
  MeshConversationCommandResult,
  MeshConversationFrame,
  MeshConversationKey,
  MeshConversationListResult,
  MeshLinkState,
  MeshQueuedMessage,
  MeshScheduledMessage,
} from '../../../shared/tailnet-mesh'
import { asRecord } from '../../../shared/records'
import type { RemoteConversationCache, RemoteConversationCacheRecord } from './tailnet-remote-conversation-cache'
import {
  openRemoteConversationSocket,
  type RemoteJsonSocket,
  type RemoteJsonSocketHandlers,
  type TailnetEndpoint,
} from './tailnet-remote-client'

// Following conversations on another machine: the chat half of the Mesh.
//
// A followed conversation is one socket (that route follows one conversation
// at a time), shared by every window showing it, re-dialled with backoff when
// the link drops, and resumed from where this machine's copy ends rather than
// replayed from the start: the far end sends only the events after the
// cursor, then its `synchronized` fence, then live events.
//
// The copy outlives the process. The transcript tail
// and its cursor are kept on disk (`tailnet-remote-conversation-cache.ts`), so
// a restart here shows the conversation at once and asks only for what it
// missed. A reset from the far end — another log generation, a cursor too far
// behind — replaces the copy with the snapshot it sends.
//
// Every server frame is validated against the protocol before it touches the
// copy. A frame of a known type in the wrong shape ends the follow with a
// sentence rather than being skipped: skipping an event and then advancing the
// cursor past it would lose it for good.

/** First retry is fast (a Wi-Fi blip), then backs off. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
/**
 * After this many failed dials the link stops saying "reconnecting", says the
 * peer is not answering, and stops dialling: the follow is parked until
 * something says the machine may be back (see `resume`).
 */
const OFFLINE_AFTER_ATTEMPTS = 3
/** Every wait between dials is this many times longer on battery. */
const BATTERY_STRETCH = 4
/** A read the far end answers `busy` is asked again, but not forever. */
const MAX_BUSY_RETRIES = 5
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_LIST_TIMEOUT_MS = 15_000
/**
 * The longest a streaming reply's kept copy may lag what is on screen. The
 * copy is written whole, so a save per delta would rewrite megabytes several
 * times a second; the moments that matter (a fence, a turn ending, a question
 * for the person) are saved at once instead, and this only bounds what a
 * crash in the middle of a long turn could lose. Losing it costs a re-read,
 * never an event: the cursor is written with the tail it vouches for, so an
 * older copy simply asks the far end for more.
 */
const DEFAULT_SAVE_DELAY_MS = 8_000
/** Events after which the copy is saved at once rather than on the slow beat. */
const SAVE_BOUNDARY_EVENTS: ReadonlySet<string> = new Set([
  'turn_completed',
  'turn_failed',
  'approval_requested',
  'session_closed',
])
/** The protocol's largest logical frame, plus the envelope a chunk's text is re-escaped in. */
const MAX_REASSEMBLED_CHARS = 40 * 1024 * 1024
/** How much of a transcript this machine keeps. Older turns stay a `loadEarlier` away. */
const MAX_CACHED_EVENTS = 4_000
const MAX_CACHED_CHARS = 8 * 1024 * 1024

/** The credential and address main dials a paired machine with. Never leaves main. */
type RemoteConversationConnection = {
  id: string
  machineName: string
  endpoint: TailnetEndpoint
  token: string
  scopes: readonly TailnetScope[]
}

export type RemoteConversationsOptions = {
  resolveConnection(connectionId: string): RemoteConversationConnection | null
  cache: RemoteConversationCache
  /** The machine answered with our credential refused: revoked over there. */
  onUnauthorized?(connectionId: string, detail: string): void
  /** The machine answered a dial: it is reachable. */
  onReachable?(connectionId: string): void
  /**
   * A follow on this machine stopped dialling after failing long enough to
   * read offline. It stays parked until `resume` or `onWake`; the owner
   * decides when the machine is worth asking again.
   */
  onAway?(connectionId: string): void
  /** Whether the machine runs on battery: the save beat and the retry cap stretch while it does. */
  isOnBattery?(): boolean
  /** What the machine last said it serves; null or absent while it has not said. */
  capabilitiesOf?(connectionId: string): readonly string[] | null | undefined
  openSocket?: typeof openRemoteConversationSocket
  retry?: { baseMs: number; maxMs: number }
  requestTimeoutMs?: number
  commandTimeoutMs?: number
  listTimeoutMs?: number
  livenessTimeoutMs?: number
  saveDelayMs?: number
  log?(message: string): void
}

export type RemoteConversations = {
  list(connectionId: string): Promise<MeshConversationListResult>
  follow(input: {
    followId: string
    key: MeshConversationKey
    turnLimit?: number
    emit(frame: MeshConversationFrame): void
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  unfollow(followId: string): void
  loadEarlier(key: MeshConversationKey, beforeCursor: number, turnLimit?: number): Promise<ConversationPageResult>
  toolDetail(key: MeshConversationKey, toolUseId: string): Promise<ConversationToolDetailResult>
  turnDiff(key: MeshConversationKey, turnSeq: number, path?: string): Promise<ConversationTurnDiffResult>
  command(key: MeshConversationKey, command: unknown): Promise<MeshConversationCommandResult>
  /** Re-dial every follow waiting out a backoff or parked offline: a lid opening should reconnect at once. */
  onWake(): void
  /** Re-dial the parked follows on one machine: it just answered something else. */
  resume(connectionId: string): void
  /** Whether any follow on this machine is parked, waiting for `resume`. */
  parkedOn(connectionId: string): boolean
  /** End every follow on a machine and delete what was kept of its conversations. */
  forgetConnection(connectionId: string, reason: string): Promise<void>
  shutdown(): void
}

type ResultFrame = Extract<ConversationParsedServerFrame, { type: 'result' }>
type PendingRequest = { resolve(frame: ResultFrame | { failure: string; code: string }): void; timer: NodeJS.Timeout }
type PendingCommand = {
  commandId: string
  frame: Extract<ConversationClientMessage, { type: 'command' }>
  resolve(result: MeshConversationCommandResult): void
  timer: NodeJS.Timeout | null
  retry: NodeJS.Timeout | null
  sent: boolean
}

type Follow = {
  id: string
  key: MeshConversationKey
  turnLimit?: number
  listeners: Map<string, (frame: MeshConversationFrame) => void>
  record: RemoteConversationCacheRecord | null
  /** Characters of each cached event, parallel to `record.page.events`, for the size bound. */
  sizes: number[]
  chars: number
  loaded: Promise<void>
  socket: RemoteJsonSocket | null
  synchronized: boolean
  waiters: Array<(ok: boolean) => void>
  parts: { total: number; pages: Array<ConversationWirePage | undefined>; frame: SnapshotFrame } | null
  chunk: { frameId: string; total: number; parts: string[]; chars: number } | null
  attempts: number
  retryTimer: NodeJS.Timeout | null
  /** The pending retry honours a delay the far end advised, which a wake must not cut short. */
  retryAdvised: boolean
  /** Offline and not dialling: waits for `resume` or a wake instead of a timer. */
  parked: boolean
  /**
   * A dial is between its ticket and its socket. A second dial started then
   * would open a second socket and orphan one of them, answering the far
   * end's pings forever; it is folded into `redial` instead.
   */
  dialing: boolean
  /** Asked to dial again while a dial was out: the one in flight may carry a stale credential. */
  redial: boolean
  resyncAfterMs: number | null
  released: boolean
  finished: boolean
  state: MeshLinkState
  detail: string
  access: MeshConversationAccess | null
  code?: string
  requests: Map<string, PendingRequest>
  commands: Map<string, PendingCommand>
  requestSequence: number
  saveTimer: NodeJS.Timeout | null
  dirty: boolean
  /**
   * What the machine last said it holds for this conversation until its turn
   * ends; null until it has said. Kept, not cached on disk: it stands while
   * the link is down, since the machine holds them all the same.
   */
  queued: MeshQueuedMessage[] | null
  /** What the machine last said it has scheduled into the conversation, for a window that joins later. */
  scheduled: MeshScheduledMessage[] | null
}
type SnapshotFrame = Extract<ConversationParsedServerFrame, { type: 'snapshot' }>

const followIdOf = (key: MeshConversationKey) => JSON.stringify([key.connectionId, key.workspaceId, key.agentId])

export function createRemoteConversations(options: RemoteConversationsOptions): RemoteConversations {
  const openSocket = options.openSocket ?? openRemoteConversationSocket
  const retry = options.retry ?? { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS
  const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS
  const stretch = (): number => (options.isOnBattery?.() ? BATTERY_STRETCH : 1)
  const follows = new Map<string, Follow>()
  const listenerFollow = new Map<string, Follow>()

  const emit = (follow: Follow, frame: MeshConversationFrame): void => {
    for (const listener of follow.listeners.values()) listener(frame)
  }
  const linkFrame = (follow: Follow): MeshConversationFrame => ({
    type: 'link',
    state: follow.state,
    detail: follow.detail,
    access: follow.access,
    ...(follow.code ? { code: follow.code } : {}),
  })
  const link = (follow: Follow, state: MeshLinkState, detail: string, code?: string): void => {
    follow.state = state
    follow.detail = detail
    follow.code = code
    emit(follow, linkFrame(follow))
  }
  const machineName = (follow: Follow) =>
    options.resolveConnection(follow.key.connectionId)?.machineName ?? 'that machine'
  const accessOf = (scopes: readonly TailnetScope[]): MeshConversationAccess | null => {
    const granted = new Set(scopes)
    if (tailnetScopeGrantsAccess(granted, 'conversation:operate')) return 'operate'
    return tailnetScopeGrantsAccess(granted, 'conversation:read') ? 'read' : null
  }

  // ── The kept copy ─────────────────────────────────────────────────────────

  const emptyRecord = (): RemoteConversationCacheRecord => ({
    generation: null,
    lastSeq: null,
    page: { events: [], hasMore: false, beforeCursor: null },
  })
  const adopt = (follow: Follow, record: RemoteConversationCacheRecord): void => {
    follow.record = record
    follow.sizes = record.page.events.map((event) => JSON.stringify(event).length)
    follow.chars = follow.sizes.reduce((sum, size) => sum + size, 0)
    trim(follow)
  }
  /** Keep the newest events within the bounds; what is dropped stays reachable through `loadEarlier`. */
  const trim = (follow: Follow): void => {
    const record = follow.record
    if (!record) return
    let drop = 0
    while (
      record.page.events.length - drop > 1 &&
      (record.page.events.length - drop > MAX_CACHED_EVENTS || follow.chars > MAX_CACHED_CHARS)
    ) {
      follow.chars -= follow.sizes[drop]
      drop++
    }
    if (!drop) return
    const events = record.page.events.slice(drop)
    follow.sizes = follow.sizes.slice(drop)
    record.page = { events, hasMore: true, beforeCursor: events[0]?.seq ?? record.page.beforeCursor }
  }
  /**
   * Add one live event to the copy. A text delta that continues the last one
   * is merged into it, as the far end's own log merges such a run: the merged
   * event keeps the first id and takes the last sequence, so the copy stays
   * small and the cursor still names the newest event held.
   */
  const append = (follow: Follow, event: ConversationEvent): void => {
    const record = (follow.record ??= emptyRecord())
    const events = record.page.events
    const last = events.at(-1)
    const key = deltaKey(event)
    if (last && key && deltaKey(last) === key) {
      const text = String(event.payload!.text)
      events[events.length - 1] = {
        ...last,
        seq: event.seq,
        payload: { ...last.payload, text: String(last.payload!.text) + text },
      }
      // Grown by the added text as it encodes, not re-measured: a long reply
      // arrives as thousands of deltas, and re-encoding the whole run for
      // each would cost the square of its length.
      const grown = JSON.stringify(text).length - 2
      follow.chars += grown
      follow.sizes[follow.sizes.length - 1] += grown
    } else {
      const size = JSON.stringify(event).length
      events.push(event)
      follow.sizes.push(size)
      follow.chars += size
    }
    if (event.seq !== undefined) record.lastSeq = Math.max(record.lastSeq ?? 0, event.seq)
    trim(follow)
  }
  /** The copy as a page to hand a window: its own array, so later appends never reach a frame already sent. */
  const pageOf = (record: RemoteConversationCacheRecord): ConversationPage => ({
    ...record.page,
    events: [...record.page.events],
  })
  /** Write the copy now, if anything in it changed since the last write. */
  const persistNow = (follow: Follow): void => {
    if (follow.saveTimer) clearTimeout(follow.saveTimer)
    follow.saveTimer = null
    if (!follow.dirty || !follow.record) return
    follow.dirty = false
    // Encoded before `save` returns, so the copy may keep growing meanwhile.
    void options.cache.save(follow.key, follow.record)
  }
  /**
   * Mark the copy changed and make sure a write follows within the slow beat.
   * A throttle, not a debounce: a reply that streams for minutes is still
   * written every few seconds, never only at its end.
   */
  const persistSoon = (follow: Follow): void => {
    follow.dirty = true
    if (follow.saveTimer) return
    follow.saveTimer = setTimeout(() => persistNow(follow), saveDelayMs * stretch())
    follow.saveTimer.unref?.()
  }

  // ── The link ──────────────────────────────────────────────────────────────

  const send = (follow: Follow, frame: ConversationClientMessage): boolean => {
    if (!follow.socket?.isOpen()) return false
    follow.socket.send(frame as unknown as Record<string, unknown>)
    return true
  }
  const subscribe = (follow: Follow): void => {
    const record = follow.record
    // A cursor is only offered with the generation it was read from; a copy
    // without one asks for a snapshot, which is what it needs.
    const cursor =
      record?.generation && record.lastSeq !== null ? { afterSeq: record.lastSeq, generation: record.generation } : {}
    send(follow, {
      type: 'subscribe',
      key: { workspaceId: follow.key.workspaceId, agentId: follow.key.agentId },
      ...cursor,
      ...(follow.turnLimit === undefined ? {} : { turnLimit: follow.turnLimit }),
    })
  }

  async function dial(follow: Follow): Promise<void> {
    if (follow.released || follow.finished || follow.socket || follow.dialing) return
    const connection = options.resolveConnection(follow.key.connectionId)
    if (!connection) {
      finish(follow, 'That machine is no longer paired here.', 'unknown_connection')
      return
    }
    follow.parked = false
    follow.access = accessOf(connection.scopes) ?? follow.access
    link(
      follow,
      follow.attempts === 0 ? 'connecting' : 'reconnecting',
      follow.attempts === 0 ? `Connecting to ${connection.machineName}.` : `Reconnecting to ${connection.machineName}.`,
    )
    let socket: RemoteJsonSocket | null = null
    const handlers: RemoteJsonSocketHandlers = {
      onFrame: (frame) => {
        if (socket && follow.socket === socket) receive(follow, frame)
      },
      onClosed: ({ code, reason }) => {
        if (socket && follow.socket === socket) closed(follow, code, reason)
      },
    }
    follow.dialing = true
    let opened: Awaited<ReturnType<typeof openSocket>>
    try {
      opened = await openSocket({
        endpoint: connection.endpoint,
        token: connection.token,
        handlers,
        ...(options.livenessTimeoutMs === undefined ? {} : { livenessTimeoutMs: options.livenessTimeoutMs }),
      })
    } finally {
      follow.dialing = false
    }
    if (follow.released || follow.finished) {
      follow.redial = false
      if (opened.ok) opened.value.close('Stopped following.')
      return
    }
    if (follow.redial) {
      // Asked again while this dial was out (a re-follow after it ended): this
      // dial may carry the credential that ended it, so it gives way.
      follow.redial = false
      if (opened.ok) opened.value.close('Reconnecting.')
      void dial(follow)
      return
    }
    if (!opened.ok) {
      if (opened.code === 'unauthorized') {
        options.onUnauthorized?.(connection.id, opened.message)
        finish(follow, opened.message, 'unauthorized')
        return
      }
      if (opened.code === 'conversation_scope_required') {
        follow.access = null
        finish(follow, opened.message, opened.code)
        return
      }
      if (opened.code === 'http_404') {
        finish(
          follow,
          `${connection.machineName} does not serve conversations. Update Studio there to follow them from here.`,
          'conversations_unsupported',
        )
        return
      }
      scheduleRetry(follow, opened.message)
      return
    }
    socket = opened.value
    follow.socket = socket
    follow.synchronized = false
    options.onReachable?.(connection.id)
    subscribe(follow)
  }

  function scheduleRetry(follow: Follow, reason: string, advisedMs?: number): void {
    if (follow.released || follow.finished || follow.retryTimer || follow.parked) return
    const maxMs = retry.maxMs * stretch()
    const delayMs = advisedMs ?? backoffDelayMs(follow.attempts, { baseMs: retry.baseMs, maxMs }) ?? maxMs
    follow.retryAdvised = advisedMs !== undefined
    if (advisedMs === undefined) follow.attempts += 1
    if (advisedMs !== undefined) link(follow, 'reconnecting', reason)
    else if (follow.attempts > OFFLINE_AFTER_ATTEMPTS) {
      // Not answering: stop dialling. A sleeping machine was costing a ticket
      // request and a link frame to every window every few seconds for as
      // long as its pane stayed open. The owner watches for it to come back
      // (a reachability answer, a wake, the person returning to the app) and
      // calls `resume`.
      follow.parked = true
      link(follow, 'offline', reason)
      options.onAway?.(follow.key.connectionId)
      return
    } else link(follow, 'reconnecting', reason)
    follow.retryTimer = setTimeout(() => {
      follow.retryTimer = null
      follow.retryAdvised = false
      void dial(follow)
    }, delayMs)
    follow.retryTimer.unref?.()
  }

  function closed(follow: Follow, code: number | null, reason: string): void {
    follow.socket = null
    follow.synchronized = false
    follow.parts = null
    follow.chunk = null
    for (const [requestId, request] of follow.requests) {
      follow.requests.delete(requestId)
      clearTimeout(request.timer)
      request.resolve({ failure: `The connection to ${machineName(follow)} dropped. Try again.`, code: 'disconnected' })
    }
    // A command already sent is sent again after the next fence under the same
    // id: the far end answers a repeat from its receipt, so a send it accepted
    // before the drop is not accepted twice.
    for (const command of follow.commands.values()) command.sent = false
    if (follow.released || follow.finished) return
    if (code === 4401) {
      options.onUnauthorized?.(follow.key.connectionId, reason)
      finish(follow, reason, 'revoked')
      return
    }
    if (code === CONVERSATION_SCOPE_CLOSE_CODE) {
      follow.access = null
      finish(
        follow,
        `This pairing may no longer read conversations on ${machineName(follow)}. Pair again with conversation access.`,
        'conversation_scope_required',
      )
      return
    }
    if (code === CONVERSATION_RESYNC_CLOSE_CODE) {
      // The far end said when to come back; coming back sooner would only
      // land in the same backlog.
      const advised = conversationCloseRetryAfterMs(reason) ?? follow.resyncAfterMs ?? retry.baseMs
      follow.resyncAfterMs = null
      scheduleRetry(follow, `Catching up with ${machineName(follow)}.`, advised)
      return
    }
    scheduleRetry(follow, reason)
  }

  /** End a follow for good: it will not come back without being asked again. */
  function finish(follow: Follow, detail: string, code: string): void {
    if (follow.finished) return
    follow.finished = true
    follow.parked = false
    if (follow.retryTimer) clearTimeout(follow.retryTimer)
    follow.retryTimer = null
    const socket = follow.socket
    follow.socket = null
    socket?.close(detail)
    settle(follow, detail, code)
    link(follow, 'closed', detail, code)
  }

  /** Fail everything waiting on a follow that will not answer. */
  function settle(follow: Follow, detail: string, code: string): void {
    for (const waiter of follow.waiters.splice(0)) waiter(false)
    for (const [requestId, request] of follow.requests) {
      follow.requests.delete(requestId)
      clearTimeout(request.timer)
      request.resolve({ failure: detail, code })
    }
    for (const [commandId, command] of follow.commands) {
      follow.commands.delete(commandId)
      if (command.timer) clearTimeout(command.timer)
      if (command.retry) clearTimeout(command.retry)
      command.resolve({ ok: false, code, message: detail })
    }
  }

  function release(follow: Follow): void {
    if (follow.released) return
    follow.released = true
    follows.delete(follow.id)
    if (follow.retryTimer) clearTimeout(follow.retryTimer)
    follow.retryTimer = null
    const socket = follow.socket
    follow.socket = null
    socket?.close('Stopped following.')
    settle(follow, 'The conversation was closed here.', 'closed')
    persistNow(follow)
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  function receive(follow: Follow, raw: unknown): void {
    // A frame type this build does not know is a newer desktop's addition.
    if (!isKnownConversationServerFrameType(raw)) return
    const frame = parseConversationServerFrame(raw)
    if (!frame) {
      finish(follow, `${machineName(follow)} sent a conversation frame this build could not read.`, 'protocol')
      return
    }
    // A snapshot, fence or event for another conversation is never applied
    // to this one's copy: its cursor would be a cursor into the wrong log.
    const named =
      frame.type === 'snapshot' ||
      frame.type === 'synchronized' ||
      frame.type === 'queued' ||
      frame.type === 'scheduled'
        ? frame.key
        : frame.type === 'event'
          ? { workspaceId: frame.event.workspaceId, agentId: frame.event.agentId }
          : undefined
    if (named && (named.workspaceId !== follow.key.workspaceId || named.agentId !== follow.key.agentId)) return
    switch (frame.type) {
      case 'chunk': {
        const chunk =
          follow.chunk?.frameId === frame.frameId
            ? follow.chunk
            : { frameId: frame.frameId, total: frame.total, parts: [], chars: 0 }
        if (chunk.total !== frame.total || frame.index !== chunk.parts.length) {
          finish(follow, `${machineName(follow)} sent a conversation frame out of order.`, 'protocol')
          return
        }
        chunk.parts.push(frame.json)
        chunk.chars += frame.json.length
        if (chunk.chars > MAX_REASSEMBLED_CHARS) {
          finish(follow, `${machineName(follow)} sent a conversation frame larger than any it may send.`, 'protocol')
          return
        }
        follow.chunk = chunk
        if (chunk.parts.length < chunk.total) return
        follow.chunk = null
        let whole: unknown
        try {
          whole = JSON.parse(chunk.parts.join(''))
        } catch {
          finish(follow, `${machineName(follow)} sent a conversation frame this build could not read.`, 'protocol')
          return
        }
        receive(follow, whole)
        return
      }
      case 'snapshot': {
        if (!frame.part) {
          applySnapshot(follow, frame, frame.page)
          return
        }
        const parts =
          follow.parts?.total === frame.part.total
            ? follow.parts
            : {
                total: frame.part.total,
                pages: Array.from<ConversationWirePage | undefined>({ length: frame.part.total }),
                frame,
              }
        parts.pages[frame.part.index] = frame.page
        follow.parts = parts
        if (parts.pages.some((page) => page === undefined)) return
        follow.parts = null
        const pages = parts.pages as ConversationWirePage[]
        applySnapshot(follow, parts.frame, {
          ...pages[0],
          events: pages.flatMap((page) => page.events),
        })
        return
      }
      case 'event': {
        const event = frame.event as ConversationEvent
        const held = follow.record?.lastSeq ?? null
        // A repeat of what the copy holds: the overlap between a catch-up and
        // live events already queued behind it.
        if (event.seq !== undefined && held !== null && event.seq <= held) return
        append(follow, event)
        // A turn's end, or a question for the person, is where a restart
        // should find the copy; everything between is on the slow beat.
        if (SAVE_BOUNDARY_EVENTS.has(event.type)) {
          follow.dirty = true
          persistNow(follow)
        } else persistSoon(follow)
        emit(follow, { type: 'event', event })
        return
      }
      case 'synchronized': {
        const record = (follow.record ??= emptyRecord())
        const generation = frame.generation ?? record.generation
        const lastSeq = Math.max(record.lastSeq ?? 0, frame.seq)
        // A reconnect that found nothing new moves neither, and rewriting the
        // whole copy to say so would be a write for nothing.
        if (generation !== record.generation || lastSeq !== record.lastSeq) follow.dirty = true
        record.generation = generation
        record.lastSeq = lastSeq
        follow.synchronized = true
        follow.attempts = 0
        persistNow(follow)
        link(follow, 'live', `Following on ${machineName(follow)}.`)
        emit(follow, {
          type: 'synchronized',
          seq: frame.seq,
          ...(frame.generation ? { generation: frame.generation } : {}),
        })
        for (const waiter of follow.waiters.splice(0)) waiter(true)
        for (const command of follow.commands.values()) if (!command.sent) dispatch(follow, command)
        watchQueued(follow)
        watchScheduled(follow)
        return
      }
      case 'queued': {
        follow.queued = frame.messages
        emit(follow, { type: 'queued', messages: frame.messages })
        return
      }
      case 'scheduled': {
        follow.scheduled = frame.messages
        emit(follow, { type: 'scheduled', messages: frame.messages })
        return
      }
      case 'subscribeFailed': {
        if (frame.key.workspaceId !== follow.key.workspaceId || frame.key.agentId !== follow.key.agentId) return
        if (!frame.retryable) {
          finish(follow, frame.message || 'That conversation is not available to this pairing.', frame.code)
          return
        }
        const socket = follow.socket
        const timer = setTimeout(() => {
          if (follow.socket === socket && !follow.released && !follow.finished) subscribe(follow)
        }, frame.retryAfterMs ?? retry.baseMs)
        timer.unref?.()
        return
      }
      case 'result': {
        const request = follow.requests.get(frame.requestId)
        if (!request) return
        follow.requests.delete(frame.requestId)
        clearTimeout(request.timer)
        request.resolve(frame)
        return
      }
      case 'commandResult': {
        const command = follow.commands.get(frame.commandId)
        if (!command) return
        if (frame.code === 'busy') {
          command.retry = setTimeout(() => {
            command.retry = null
            if (follow.commands.has(command.commandId)) dispatch(follow, command)
          }, frame.retryAfterMs ?? retry.baseMs)
          command.retry.unref?.()
          return
        }
        follow.commands.delete(frame.commandId)
        if (command.timer) clearTimeout(command.timer)
        if (frame.ok) {
          if (follow.access !== 'operate') {
            follow.access = 'operate'
            emit(follow, linkFrame(follow))
          }
          command.resolve({ ok: true, ...(frame.notice ? { notice: frame.notice } : {}) })
          return
        }
        if (frame.code === 'conversation_operate_required') {
          follow.access = 'read'
          emit(follow, linkFrame(follow))
        }
        command.resolve({
          ok: false,
          code: frame.code ?? 'unavailable',
          message: frame.message ?? commandRefusal(frame.code, machineName(follow)),
        })
        return
      }
      case 'error': {
        if (frame.code === 'resync_required') {
          follow.resyncAfterMs = frame.retryAfterMs ?? null
          return
        }
        // The close that follows says what to do; the error only says why.
        if (frame.code === 'conversation_scope_required') return
        emit(follow, { type: 'error', message: frame.message })
        return
      }
      case 'sessions':
        return
    }
  }

  function applySnapshot(follow: Follow, frame: SnapshotFrame, page: ConversationWirePage): void {
    const events = page.events as ConversationEvent[]
    const lastSeq = events.reduce<number | null>(
      (max, event) => (event.seq === undefined ? max : Math.max(max ?? 0, event.seq)),
      null,
    )
    // A snapshot is always the whole tail: whatever the copy held is replaced.
    adopt(follow, { generation: frame.generation ?? null, lastSeq, page: { ...page, events } })
    persistSoon(follow)
    emit(follow, {
      type: 'snapshot',
      page: pageOf(follow.record!),
      ...(frame.reset ? { reset: true as const } : {}),
      ...(frame.generation ? { generation: frame.generation } : {}),
    })
  }

  // ── Requests and commands ─────────────────────────────────────────────────

  function whenSynchronized(follow: Follow): Promise<boolean> {
    if (follow.synchronized && follow.socket) return Promise.resolve(true)
    if (follow.finished || follow.released) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = follow.waiters.indexOf(settleWaiter)
        if (index >= 0) follow.waiters.splice(index, 1)
        resolve(false)
      }, requestTimeoutMs)
      timer.unref?.()
      const settleWaiter = (ok: boolean) => {
        clearTimeout(timer)
        resolve(ok)
      }
      follow.waiters.push(settleWaiter)
    })
  }

  /** One read on a followed conversation, retried while the far end says it is busy. */
  async function request(
    key: MeshConversationKey,
    build: (requestId: string) => ConversationClientFrame,
  ): Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }> {
    const follow = follows.get(followIdOf(key))
    if (!follow) return { ok: false, code: 'not_following', message: 'Open this conversation before reading from it.' }
    for (let attempt = 0; ; attempt++) {
      if (!(await whenSynchronized(follow)))
        return { ok: false, code: 'unavailable', message: `Not connected to ${machineName(follow)}.` }
      const requestId = `r${++follow.requestSequence}`
      const answer = await new Promise<ResultFrame | { failure: string; code: string }>((resolve) => {
        const timer = setTimeout(() => {
          follow.requests.delete(requestId)
          resolve({ failure: `${machineName(follow)} did not answer in time.`, code: 'timeout' })
        }, requestTimeoutMs)
        timer.unref?.()
        follow.requests.set(requestId, { resolve, timer })
        if (!send(follow, build(requestId))) {
          follow.requests.delete(requestId)
          clearTimeout(timer)
          resolve({ failure: `Not connected to ${machineName(follow)}.`, code: 'unavailable' })
        }
      })
      if ('failure' in answer) return { ok: false, code: answer.code, message: answer.failure }
      if (answer.ok) return { ok: true, data: answer.data }
      if (answer.code === 'busy' && attempt < MAX_BUSY_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, answer.retryAfterMs ?? retry.baseMs))
        continue
      }
      return {
        ok: false,
        code: answer.code ?? 'unavailable',
        message: answer.message ?? readRefusal(answer.code, machineName(follow)),
      }
    }
  }

  /**
   * Ask the machine to say what it holds for this conversation, after each
   * fence: a new socket, or the same one joined again, starts with no watch.
   * Asked of a machine that has not said what it serves as well, which answers
   * a request it does not know with a refusal nobody waits on; never of one
   * that said and left `conversation-queued-sends` out.
   */
  function watchQueued(follow: Follow): void {
    const capabilities = options.capabilitiesOf?.(follow.key.connectionId)
    if (capabilities && !conversationPeerSupports(capabilities, CONVERSATION_QUEUED_SENDS_CAPABILITY)) return
    send(follow, { type: 'watchQueued', requestId: `queued-${++follow.requestSequence}` })
  }

  /**
   * Ask the machine to say what it has scheduled into this conversation,
   * after each fence, as `watchQueued` asks what it holds. Never of a machine
   * that said what it serves and left `conversation-scheduled-sends` out;
   * one that has not said answers a request it does not know with a refusal
   * nobody waits on.
   */
  function watchScheduled(follow: Follow): void {
    const capabilities = options.capabilitiesOf?.(follow.key.connectionId)
    if (capabilities && !conversationPeerSupports(capabilities, CONVERSATION_SCHEDULED_SENDS_CAPABILITY)) return
    send(follow, { type: 'watchScheduled', requestId: `scheduled-${++follow.requestSequence}` })
  }

  function dispatch(follow: Follow, command: PendingCommand): void {
    if (!follow.synchronized) return
    command.sent = send(follow, command.frame)
  }

  function unfollow(followId: string): void {
    const follow = listenerFollow.get(followId)
    if (!follow) return
    listenerFollow.delete(followId)
    follow.listeners.delete(followId)
    if (follow.listeners.size === 0) release(follow)
  }

  // ── The door ──────────────────────────────────────────────────────────────

  return {
    async list(connectionId) {
      const connection = options.resolveConnection(connectionId)
      if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
      const access = accessOf(connection.scopes)
      if (!access)
        return {
          ok: false,
          code: 'conversation_scope_required',
          message: `This pairing may not read conversations on ${connection.machineName}. Pair again with conversation access.`,
        }
      // A short-lived socket: a list is a glance, and a follow's socket is
      // scoped to the conversation it follows.
      let settle: (result: MeshConversationListResult) => void = () => undefined
      const answered = new Promise<MeshConversationListResult>((resolve) => (settle = resolve))
      const opened = await openSocket({
        endpoint: connection.endpoint,
        token: connection.token,
        handlers: {
          onFrame: (raw) => {
            const frame = isKnownConversationServerFrameType(raw) ? parseConversationServerFrame(raw) : null
            if (frame?.type === 'sessions' && frame.requestId === 'list')
              settle({ ok: true, conversations: frame.sessions, access, modelSwitch: false })
            else if (frame?.type === 'result' && frame.requestId === 'list' && !frame.ok)
              settle({
                ok: false,
                code: frame.code ?? 'unavailable',
                message: frame.message ?? 'The list was refused.',
              })
            else if (frame?.type === 'error' && frame.code !== 'resync_required')
              settle({ ok: false, code: frame.code, message: frame.message })
          },
          onClosed: ({ reason }) => settle({ ok: false, code: 'unavailable', message: reason }),
        },
      })
      if (!opened.ok) {
        if (opened.code === 'unauthorized') options.onUnauthorized?.(connection.id, opened.message)
        return {
          ok: false,
          code: opened.code === 'http_404' ? 'conversations_unsupported' : opened.code,
          message:
            opened.code === 'http_404'
              ? `${connection.machineName} does not serve conversations. Update Studio there to follow them from here.`
              : opened.message,
        }
      }
      options.onReachable?.(connection.id)
      opened.value.send({ type: 'list', requestId: 'list' })
      const timer = setTimeout(
        () => settle({ ok: false, code: 'timeout', message: `${connection.machineName} did not answer in time.` }),
        listTimeoutMs,
      )
      timer.unref?.()
      const result = await answered
      clearTimeout(timer)
      opened.value.close('Listed.')
      return result
    },

    async follow(input) {
      const key = input.key
      if (!key.connectionId || !key.workspaceId || !key.agentId)
        return { ok: false, code: 'invalid_arguments', message: 'Name the machine and conversation to follow.' }
      if (!options.resolveConnection(key.connectionId))
        return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
      // One window following twice under one id replaces its old listener.
      unfollow(input.followId)
      const id = followIdOf(key)
      let follow = follows.get(id)
      if (!follow) {
        const created: Follow = {
          id,
          key: { ...key },
          ...(input.turnLimit === undefined ? {} : { turnLimit: input.turnLimit }),
          listeners: new Map(),
          record: null,
          sizes: [],
          chars: 0,
          loaded: Promise.resolve(),
          socket: null,
          synchronized: false,
          waiters: [],
          parts: null,
          chunk: null,
          attempts: 0,
          retryTimer: null,
          retryAdvised: false,
          parked: false,
          dialing: false,
          redial: false,
          resyncAfterMs: null,
          released: false,
          finished: false,
          state: 'connecting',
          detail: 'Connecting.',
          access: null,
          requests: new Map(),
          commands: new Map(),
          requestSequence: 0,
          saveTimer: null,
          dirty: false,
          queued: null,
          scheduled: null,
        }
        created.loaded = options.cache.load(key).then(
          (record) => {
            if (record && !created.record) adopt(created, record)
          },
          () => undefined,
        )
        follows.set(id, created)
        follow = created
        void created.loaded.then(() => dial(created))
      } else if (follow.finished) {
        // Asked again after it ended — a re-pair, a grant restored: start over
        // from the copy, not from nothing.
        follow.finished = false
        follow.attempts = 0
        follow.code = undefined
        if (follow.dialing) follow.redial = true
        else void dial(follow)
      } else if (follow.parked) {
        // Another window opening it is a person asking for it now.
        void dial(follow)
      }
      const joined = follow
      joined.listeners.set(input.followId, input.emit)
      listenerFollow.set(input.followId, joined)
      await joined.loaded
      if (joined.released || !joined.listeners.has(input.followId)) return { ok: true }
      // The copy first, as a hydrated conversation — on screen at once, even
      // with the machine asleep — then the link, then whatever arrives live.
      if (joined.record) {
        input.emit({
          type: 'snapshot',
          page: pageOf(joined.record),
          ...(joined.record.generation ? { generation: joined.record.generation } : {}),
        })
        input.emit({
          type: 'synchronized',
          seq: joined.record.lastSeq ?? 0,
          ...(joined.record.generation ? { generation: joined.record.generation } : {}),
        })
      }
      input.emit(linkFrame(joined))
      // A second window on the conversation is told what the machine holds,
      // as the first was.
      if (joined.queued) input.emit({ type: 'queued', messages: joined.queued })
      if (joined.scheduled) input.emit({ type: 'scheduled', messages: joined.scheduled })
      return { ok: true }
    },

    unfollow,

    async loadEarlier(key, beforeCursor, turnLimit) {
      const answer = await request(key, (requestId) => ({
        type: 'loadEarlier',
        requestId,
        beforeCursor,
        ...(turnLimit === undefined ? {} : { turnLimit }),
      }))
      if (!answer.ok) return { ok: false, message: answer.message }
      const page = readPage(asRecord(answer.data)?.page)
      return page
        ? { ok: true, page }
        : { ok: false, message: 'That machine answered with a page this build cannot read.' }
    },

    async toolDetail(key, toolUseId) {
      const answer = await request(key, (requestId) => ({ type: 'getToolDetail', requestId, toolUseId }))
      if (!answer.ok)
        return { ok: false, code: answer.code === 'not_found' ? 'not_found' : 'unavailable', message: answer.message }
      const detail = asRecord(asRecord(answer.data)?.detail)
      if (!detail || typeof detail.status !== 'string' || typeof detail.clipped !== 'boolean')
        return {
          ok: false,
          code: 'unavailable',
          message: 'That machine answered with a tool detail this build cannot read.',
        }
      return { ok: true, detail: detail as unknown as ConversationToolDetail }
    },

    async turnDiff(key, turnSeq, path) {
      const answer = await request(key, (requestId) => ({
        type: 'getTurnDiff',
        requestId,
        turnSeq,
        ...(path === undefined ? {} : { path }),
      }))
      if (!answer.ok) return { ok: false, message: answer.message }
      const data = asRecord(answer.data)
      const diff = asRecord(data?.diff)
      if (!diff || !Array.isArray(diff.files))
        return { ok: false, message: 'That machine answered with a diff this build cannot read.' }
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
      return {
        ok: true,
        diff: { files: diff.files as never, submodulesExcluded: true },
        ...(text(data?.patch) === undefined ? {} : { patch: text(data?.patch) }),
        ...(text(data?.original) === undefined ? {} : { original: text(data?.original) }),
        ...(text(data?.modified) === undefined ? {} : { modified: text(data?.modified) }),
      }
    },

    async command(key, command) {
      const follow = follows.get(followIdOf(key))
      if (!follow || follow.released)
        return { ok: false, code: 'not_following', message: 'Open this conversation before sending to it.' }
      if (follow.finished) return { ok: false, code: follow.code ?? 'closed', message: follow.detail }
      const commandId = `desk-${randomBytes(12).toString('base64url')}`
      // The same validation the far end applies: a permanent rule is refused
      // here with the far end's own words, without a trip. The full
      // contract's, so a queued send keeps its `queue`.
      const candidate = { type: 'command', commandId, command }
      const frame = parseConversationClientMessage(candidate)
      if (!frame || frame.type !== 'command') {
        const rejection = explainRejectedConversationMessage(candidate)
        return { ok: false, code: rejection.code, message: rejection.message }
      }
      if (follow.access === 'read')
        return {
          ok: false,
          code: 'conversation_operate_required',
          message: `This pairing may follow conversations on ${machineName(follow)} but not drive them.`,
        }
      return new Promise<MeshConversationCommandResult>((resolve) => {
        // A send is answered when its turn ends, which may be long after it
        // started, as it is on the desktop itself. Only the other commands,
        // which are answered at once, are given up on. A queued send is
        // answered once it is held, but waits out a dropped link like any
        // send: given up on, it would be kept here as well as held there.
        const timer =
          frame.command.kind === 'send'
            ? null
            : setTimeout(() => {
                const pending = follow.commands.get(commandId)
                follow.commands.delete(commandId)
                if (pending?.retry) clearTimeout(pending.retry)
                resolve({
                  ok: false,
                  code: 'timeout',
                  message: `${machineName(follow)} did not confirm this in time. It may still have been carried out.`,
                })
              }, commandTimeoutMs)
        timer?.unref?.()
        const pending: PendingCommand = { commandId, frame, resolve, timer, retry: null, sent: false }
        follow.commands.set(commandId, pending)
        dispatch(follow, pending)
      })
    },

    onWake() {
      for (const follow of follows.values()) {
        if (follow.released || follow.finished || follow.socket || follow.dialing || follow.retryAdvised) continue
        if (!follow.retryTimer && !follow.parked) continue
        if (follow.retryTimer) clearTimeout(follow.retryTimer)
        follow.retryTimer = null
        void dial(follow)
      }
    },

    resume(connectionId) {
      for (const follow of follows.values()) {
        if (follow.key.connectionId !== connectionId || !follow.parked) continue
        void dial(follow)
      }
    },

    parkedOn(connectionId) {
      for (const follow of follows.values()) if (follow.key.connectionId === connectionId && follow.parked) return true
      return false
    },

    async forgetConnection(connectionId, reason) {
      for (const follow of [...follows.values()]) {
        if (follow.key.connectionId !== connectionId) continue
        finish(follow, reason, 'unknown_connection')
        follow.dirty = false
        release(follow)
        for (const followId of follow.listeners.keys()) listenerFollow.delete(followId)
      }
      await options.cache.forgetConnection(connectionId)
    },

    shutdown() {
      for (const follow of [...follows.values()]) {
        if (follow.saveTimer) clearTimeout(follow.saveTimer)
        follow.saveTimer = null
        if (follow.dirty && follow.record) options.cache.saveNow(follow.key, follow.record)
        follow.dirty = false
        release(follow)
      }
      listenerFollow.clear()
    },
  }
}

/** A `loadEarlier` page off the wire, validated event by event. */
function readPage(value: unknown): ConversationPage | null {
  const page = asRecord(value)
  if (!page || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean') return null
  const beforeCursor =
    typeof page.beforeCursor === 'number' && Number.isSafeInteger(page.beforeCursor) ? page.beforeCursor : null
  const events: ConversationEvent[] = []
  for (const entry of page.events) {
    const event = parseConversationWireEvent(entry)
    if (!event) return null
    events.push(event as ConversationEvent)
  }
  return { events, hasMore: page.hasMore, beforeCursor }
}

/**
 * A merge key for a text delta whose payload is only its text and turn, or
 * null — the rule the far end's own log merges runs by.
 */
function deltaKey(event: ConversationEvent): string | null {
  if (event.type !== 'content_delta' && event.type !== 'reasoning_delta') return null
  const payload = event.payload
  if (!payload || typeof payload.text !== 'string') return null
  for (const key of Object.keys(payload)) if (key !== 'text' && key !== 'turnId') return null
  return JSON.stringify([
    event.type,
    event.sessionId,
    event.agentId,
    event.providerId,
    event.modelId,
    payload.turnId ?? null,
  ])
}

function readRefusal(code: string | undefined, machine: string): string {
  if (code === 'too_large') return `That is more than ${machine} can send to another device.`
  if (code === 'not_found') return `${machine} no longer has that.`
  return `${machine} could not answer that.`
}

function commandRefusal(code: string | undefined, machine: string): string {
  if (code === 'conversation_operate_required')
    return `This pairing may follow conversations on ${machine} but not drive them.`
  if (code === 'not_found') return `That conversation is no longer available on ${machine}.`
  return `${machine} did not carry that out.`
}

/** A conversation key out of untrusted IPC input, or null. */
export function meshConversationKeyOf(value: unknown): MeshConversationKey | null {
  const record = asRecord(value)
  if (!record) return null
  const { connectionId, workspaceId, agentId } = record
  return typeof connectionId === 'string' &&
    connectionId &&
    typeof workspaceId === 'string' &&
    workspaceId &&
    workspaceId.length <= 200 &&
    typeof agentId === 'string' &&
    agentId &&
    agentId.length <= 200
    ? { connectionId, workspaceId, agentId }
    : null
}
