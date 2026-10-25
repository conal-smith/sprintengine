import type { Duplex } from 'stream'
import { homedir } from 'node:os'

import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_FRAME_BYTES,
  CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  CONVERSATION_PROTOCOL_VERSION,
  CONVERSATION_RESYNC_CLOSE_CODE,
  CONVERSATION_SCOPE_CLOSE_CODE,
  conversationCloseReason,
  explainRejectedConversationMessage,
  parseConversationClientMessage,
  type ConversationClientMessage,
  type ConversationCommandKind,
  type ConversationFrameRejection,
  type ConversationHelloAnswer,
  type ConversationQueuedFrame,
  type ConversationScheduledFrame,
  type ConversationServerFrame,
  type ConversationWireErrorCode,
} from '../../../../packages/conversation-protocol/src/public'
import { tailnetScopeGrantsAccess, type TailnetScope } from '../../../shared/tailnet'
import type { ConversationEvent, ConversationKey } from '../../../shared/conversation-runtime'
import {
  CONVERSATION_CHUNK_CHARS,
  conversationDeltaKey,
  conversationSnapshotParts,
  type ConversationSnapshotFrame,
} from '../../../server/conversation-stream-shaping'
import type { ConversationGatewayHost } from './tailnet-conversation-host'
import { redactConversationValue } from '../../conversation-tool-details'
import {
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
  WEBSOCKET_CLOSE_GOING_AWAY,
  WEBSOCKET_CLOSE_REVOKED,
} from './websocket-frames'

// Live frames waiting behind a slow reader. Consecutive deltas of one message
// merge into the frame already waiting and a tool's newer partial output
// replaces its older one, so a streaming reply is one entry however long the
// reader stalls. Only a reader that stops reading reaches these.
const MAX_LIVE_FRAMES = 256
const MAX_LIVE_BYTES = 4 * 1024 * 1024
// Live frames queued behind a replay still being paced out are bounded by
// bytes alone, and generously: a busy turn during a large catch-up is not a
// reader that stopped, and a resync before the fence would hand the client
// the same cursor, and so the same replay, again.
const MAX_LIVE_BYTES_BEHIND_REPLAY = 16 * 1024 * 1024
// Replay and large responses are produced one wire frame at a time, paced by
// socket write completion, and do not count against the live limits. A read
// waits for room here instead of failing.
const MAX_BULK_BYTES = 48 * 1024 * 1024
// One logical response (a tool detail, a diff) above this is not sent at all.
const MAX_LOGICAL_FRAME_BYTES = 32 * 1024 * 1024
// The socket's own buffer beyond the frame being written: pings and a pong.
const MAX_SOCKET_BUFFER_BYTES = 2 * 1024 * 1024
// A client frame over the protocol's cap is skipped and refused, not
// buffered; one beyond this is not a conversation client and closes.
const MAX_SKIPPED_CLIENT_FRAME_BYTES = 16 * 1024 * 1024
const MAX_IN_FLIGHT_READS = 4
const MAX_IN_FLIGHT_COMMANDS = 16
const BUSY_RETRY_MS = 250
const SUBSCRIBE_RETRY_MS = 2_000
const PING_MS = 25_000
const PONG_TIMEOUT_MS = 60_000

const COMMAND_KINDS: Record<ConversationCommandKind, true> = {
  send: true,
  interrupt: true,
  resolveApproval: true,
  answerQuestion: true,
  resolvePlan: true,
  setPermissionPreset: true,
  setModel: true,
  cancelQueued: true,
  stopSubagent: true,
  scheduleSend: true,
  sendScheduledNow: true,
  cancelScheduled: true,
}

/**
 * The audit names of remote conversation commands. They are mutations in the
 * gateway's own classification, which is what puts every one of them — a
 * refused one included — in the audit beside the MCP tools a device calls.
 */
export const CONVERSATION_COMMAND_TOOL_NAMES: readonly string[] = Object.keys(COMMAND_KINDS).map(
  (kind) => `conversation.${kind}`,
)

/** One remote command as the audit records it: who, which conversation, what kind, how it ended. Never its text. */
export type ConversationCommandAudit = {
  tool: string
  commandId: string
  key: Pick<ConversationKey, 'workspaceId' | 'agentId'> | null
  ok: boolean
  code?: ConversationWireErrorCode
  durationMs: number
}

export type TailnetConversationStream = {
  deviceId: string
  close(code: number, reason: string): void
  isClosed(): boolean
  /** Re-read the device's grant: close without read, stop accepting commands without operate. */
  refreshScopes(): void
}

export type TailnetConversationStreamOptions = {
  socket: Duplex
  deviceId: string
  deviceName: string
  /**
   * The device's grant: a fixed set, or a function that reads the current one
   * (null once the device is gone). A function is consulted on every frame
   * and on `refreshScopes`, so a grant narrowed mid-stream applies at once.
   */
  scopes: readonly TailnetScope[] | (() => readonly TailnetScope[] | null)
  host: ConversationGatewayHost
  onClosed(): void
  audit(entry: ConversationCommandAudit): void
  /**
   * What this machine advertises. A `hello` is answered with the conversation
   * capabilities among them; absent, with none.
   */
  capabilities?: readonly string[]
  /** How long a client should wait before reconnecting after this socket falls too far behind. */
  resyncRetryAfterMs?: () => number
  now?: () => number
}

/**
 * The delay a device is told to wait after a resync close. It doubles with
 * each resync inside a few minutes, so a client that keeps falling behind
 * backs off instead of reconnecting straight into the same backlog.
 */
export function createResyncBackoff(now: () => number = Date.now): (deviceId: string) => number {
  const history = new Map<string, { count: number; at: number }>()
  return (deviceId) => {
    const at = now()
    const prior = history.get(deviceId)
    const count = prior && at - prior.at < 5 * 60_000 ? prior.count + 1 : 1
    history.set(deviceId, { count, at })
    return Math.min(60_000, 1_000 * 2 ** (count - 1))
  }
}

/** A frame this socket sends: the first version's, and what the full contract added since. */
type OutgoingFrame = ConversationServerFrame | ConversationQueuedFrame | ConversationScheduledFrame

type LiveEntry = {
  kind: 'live'
  frame: OutgoingFrame
  /**
   * The frame as encoded when it was queued, so the writer does not encode it
   * a second time. Dropped when a later delta extends the frame in place.
   */
  json?: string
  bytes: number
  subscription?: number
  // Consecutive deltas of one message extend this frame's event in place.
  delta?: { key: string; event: ConversationEvent }
  // A partial tool output a newer output for the same tool replaces.
  partialToolUseId?: string
}
type BulkEntry = {
  kind: 'bulk'
  frames: Iterator<string>
  bytes: number
  started: boolean
  subscription?: number
}

/** A single scoped socket: replay, a synchronization fence, then live events. */
export function createTailnetConversationStream(options: TailnetConversationStreamOptions): TailnetConversationStream {
  const { socket, host } = options
  const readScopes = typeof options.scopes === 'function' ? options.scopes : () => options.scopes as TailnetScope[]
  let mayRead = false
  let mayOperate = false
  const now = options.now ?? Date.now
  let closed = false
  const pending: Array<LiveEntry | BulkEntry> = []
  let liveFrames = 0
  let liveBytes = 0
  let bulkBytes = 0
  const bulkWaiters: Array<{ bytes: number; resolve: () => void }> = []
  let writing = false
  let lastPong = now()
  let currentKey: ConversationKey | null = null
  let subscription: { dispose(): void } | null = null
  // What this desktop holds for the chat followed, told to a client that
  // asked (`watchQueued`); it ends when the socket follows another chat.
  let queuedWatch: { chat: string; stop(): void } | null = null
  // What it has scheduled into that chat for a time (`watchScheduled`),
  // which ends the same way.
  let scheduledWatch: { chat: string; stop(): void } | null = null
  const stopQueuedWatch = (): void => {
    queuedWatch?.stop()
    queuedWatch = null
  }
  const stopScheduledWatch = (): void => {
    scheduledWatch?.stop()
    scheduledWatch = null
  }
  const stopWatches = (): void => {
    stopQueuedWatch()
    stopScheduledWatch()
  }
  let frameSequence = 0
  let subscriptionGeneration = 0
  let readsInFlight = 0
  let commandsInFlight = 0
  // Subscriptions whose replay is still queued or being written.
  const replaying = new Set<number>()

  const close = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    subscriptionGeneration++
    pending.length = 0
    for (const waiter of bulkWaiters.splice(0)) waiter.resolve()
    subscription?.dispose()
    subscription = null
    stopWatches()
    clearInterval(heartbeat)
    if (!socket.destroyed) {
      try {
        socket.write(encodeCloseFrame(code, reason))
      } catch {
        /* Peer already left. */
      }
      socket.end()
    }
    options.onClosed()
  }
  // The reader stopped reading: live events outgrew their bound. The frame
  // says why and when to come back, ahead of whatever is still buffered, and
  // the close reason repeats the delay for a client that only sees the close.
  const resync = (): void => {
    if (closed) return
    const retryAfterMs = options.resyncRetryAfterMs?.() ?? 1_000
    if (!socket.destroyed) {
      try {
        socket.write(
          encodeTextFrame(
            JSON.stringify({
              type: 'error',
              code: 'resync_required',
              message: 'This device fell too far behind the conversation. Reconnect with your last cursor.',
              retryAfterMs,
            } satisfies ConversationServerFrame),
          ),
        )
      } catch {
        /* Peer already left. */
      }
    }
    close(CONVERSATION_RESYNC_CLOSE_CODE, conversationCloseReason('resync_required', retryAfterMs))
  }
  const writeText = (json: string): Promise<void> =>
    new Promise((resolve) => {
      if (closed || socket.destroyed) {
        resolve()
        return
      }
      const frame = encodeTextFrame(json)
      if (
        frame.length > CONVERSATION_MAX_FRAME_BYTES ||
        socket.writableLength + frame.length > MAX_SOCKET_BUFFER_BYTES
      ) {
        resync()
        resolve()
        return
      }
      socket.write(frame, () => resolve())
    })
  const writeControl = (frame: Buffer): void => {
    if (closed || socket.destroyed) return
    if (socket.writableLength + frame.length > MAX_SOCKET_BUFFER_BYTES) {
      resync()
      return
    }
    socket.write(frame)
  }
  /** One logical frame as the wire frames that carry it: itself, or its chunks. */
  function* wireFrames(json: string): Generator<string> {
    if (Buffer.byteLength(json) <= CONVERSATION_MAX_FRAME_BYTES) {
      yield json
      return
    }
    const frameId = `${options.deviceId}:${++frameSequence}`
    const total = Math.ceil(json.length / CONVERSATION_CHUNK_CHARS)
    for (let index = 0; index < total; index++) {
      yield JSON.stringify({
        type: 'chunk',
        frameId,
        index,
        total,
        json: json.slice(index * CONVERSATION_CHUNK_CHARS, (index + 1) * CONVERSATION_CHUNK_CHARS),
      } satisfies ConversationServerFrame)
    }
  }
  const releaseBulkWaiters = (): void => {
    while (bulkWaiters.length && (bulkBytes === 0 || bulkBytes + bulkWaiters[0].bytes <= MAX_BULK_BYTES))
      bulkWaiters.shift()!.resolve()
  }
  const drain = async (): Promise<void> => {
    if (writing) return
    writing = true
    try {
      while (!closed && pending.length) {
        const entry = pending[0]
        if (entry.kind === 'live') {
          pending.shift()
          liveFrames--
          liveBytes -= entry.bytes
          for (const json of wireFrames(entry.json ?? JSON.stringify(entry.frame))) {
            if (closed) break
            await writeText(json)
          }
          continue
        }
        entry.started = true
        const next = entry.frames.next()
        if (next.done) {
          pending.shift()
          bulkBytes -= entry.bytes
          if (entry.subscription !== undefined) replaying.delete(entry.subscription)
          releaseBulkWaiters()
          continue
        }
        await writeText(next.value)
      }
    } finally {
      writing = false
    }
  }
  // Paths are rewritten against the conversation the socket follows, so its
  // own files read workspace-relative, as they do on the desktop.
  const redact = <T>(frame: T, workspaceRoot: string | null = currentKey?.workspaceRoot ?? null): T =>
    redactHostPaths(redactConversationValue(frame), { home: homedir(), workspaceRoot })
  /** Extend a waiting delta with a later one of the same message. */
  const extend = (into: LiveEntry & { delta: object }, event: ConversationEvent): void => {
    const text = String(event.payload!.text)
    const merged = into.delta.event
    merged.payload = { ...merged.payload, text: String(merged.payload!.text) + text }
    merged.seq = event.seq
    into.json = undefined
    const grown = Buffer.byteLength(JSON.stringify(text)) - 2
    into.bytes += grown
    liveBytes += grown
  }
  const mergeable = (entry: LiveEntry | BulkEntry | undefined, key: string, subscription?: number) =>
    entry?.kind === 'live' && entry.delta?.key === key && entry.subscription === subscription
  const removeLive = (entry: LiveEntry): void => {
    const index = pending.indexOf(entry)
    // Already folded into its neighbour by an earlier removal.
    if (index < 0) return
    pending.splice(index, 1)
    liveFrames--
    liveBytes -= entry.bytes
    // Two runs of one message that the removed frame kept apart are adjacent
    // now, so they become one, as if it had never been between them.
    const before = pending[index - 1]
    const after = pending[index]
    if (before?.kind === 'live' && before.delta && after?.kind === 'live' && after.delta) {
      if (mergeable(after, before.delta.key, before.subscription)) {
        extend(before as LiveEntry & { delta: object }, after.delta.event)
        pending.splice(index, 1)
        liveFrames--
        liveBytes -= after.bytes
      }
    }
  }
  /** Queue one live frame, merging it into what already waits where it can. */
  const sendLive = (source: OutgoingFrame, subscription?: number): void => {
    if (closed) return
    enqueueLive(redact(source), subscription)
  }
  /** Queue a frame already redacted, and encoded when the caller had to encode it anyway. */
  const enqueueLive = (frame: OutgoingFrame, subscription?: number, encoded?: string): void => {
    const event = frame.type === 'event' ? (frame.event as ConversationEvent) : null
    const key = event ? conversationDeltaKey(event) : null
    const tail = pending.at(-1)
    const behindReplay = subscription !== undefined && replaying.has(subscription)
    const byteBound = behindReplay ? MAX_LIVE_BYTES_BEHIND_REPLAY : MAX_LIVE_BYTES
    if (key && event && mergeable(tail, key, subscription)) {
      // Only an unsent frame is ever in the queue, so this merges only while
      // the reader is behind. The merged delta keeps its first id and takes
      // the last sequence, which is how a stored run reads back too.
      extend(tail as LiveEntry & { delta: object }, event)
      if (liveBytes > byteBound) resync()
      return
    }
    const toolUseId =
      event?.type === 'tool_output' && typeof event.payload?.toolUseId === 'string' ? event.payload.toolUseId : null
    if (toolUseId) {
      for (const queued of pending.filter(
        (entry): entry is LiveEntry => entry.kind === 'live' && entry.partialToolUseId === toolUseId,
      ))
        removeLive(queued)
    }
    const json = encoded ?? JSON.stringify(frame)
    const bytes = Buffer.byteLength(json)
    if ((!behindReplay && liveFrames >= MAX_LIVE_FRAMES) || liveBytes + bytes > byteBound) {
      resync()
      return
    }
    pending.push({
      kind: 'live',
      frame,
      json,
      bytes,
      ...(subscription === undefined ? {} : { subscription }),
      ...(key && event ? { delta: { key, event } } : {}),
      ...(toolUseId && event?.payload?.partial === true ? { partialToolUseId: toolUseId } : {}),
    })
    liveFrames++
    liveBytes += bytes
    void drain()
  }
  const sendBulk = (frames: Iterator<string>, bytes: number, subscription?: number): void => {
    if (closed) return
    pending.push({
      kind: 'bulk',
      frames,
      bytes,
      started: false,
      ...(subscription === undefined ? {} : { subscription }),
    })
    bulkBytes += bytes
    void drain()
  }
  /**
   * A response to a request: small ones queue live, large ones wait for bulk
   * room and stream in chunks, and one too large to send at all is answered
   * as `too_large` under its request id. The socket stays open either way.
   */
  const respond = async (source: Extract<ConversationServerFrame, { type: 'result' | 'sessions' }>): Promise<void> => {
    if (closed) return
    const redacted = redact(source)
    const json = JSON.stringify(redacted)
    const bytes = Buffer.byteLength(json)
    if (bytes > MAX_LOGICAL_FRAME_BYTES) {
      sendLive({
        type: 'result',
        requestId: source.requestId,
        ok: false,
        code: 'too_large',
        message: `The response is over the ${MAX_LOGICAL_FRAME_BYTES / (1024 * 1024)} MB limit a remote device can receive.`,
      })
      return
    }
    if (bytes <= CONVERSATION_MAX_FRAME_BYTES) {
      // Already redacted and encoded: queued as it is, not redacted again.
      enqueueLive(redacted, undefined, json)
      return
    }
    if (bulkBytes > 0 && bulkBytes + bytes > MAX_BULK_BYTES)
      await new Promise<void>((resolve) => bulkWaiters.push({ bytes, resolve }))
    sendBulk(wireFrames(json), bytes)
  }
  /** Everything a join produced, streamed as one paced unit ahead of the live events that follow it. */
  const sendReplay = (frames: ConversationServerFrame[], subscription: number): void => {
    let bytes = 0
    const encoded: Array<() => Generator<string>> = []
    // A replay stops at the next whole frame once its subscription is
    // replaced: the rest of another conversation's snapshot, or its fence,
    // would hand the client a cursor for the wrong conversation.
    const current = () => !closed && subscription === subscriptionGeneration
    // Read now, while the subscription it belongs to is the current one.
    const workspaceRoot = currentKey?.workspaceRoot ?? null
    for (const source of frames) {
      if (source.type === 'snapshot') {
        // Redacted a part at a time as the paced writer reaches it, not all
        // at once here: a snapshot can run to tens of megabytes, and redacting
        // it whole blocked the main thread for hundreds of milliseconds on
        // every join without a cursor. Measured before redaction, which only
        // moves its size a little; a part that outgrows a frame is chunked.
        const parts = conversationSnapshotParts(source as ConversationSnapshotFrame, (part) =>
          redact(part, workspaceRoot),
        )
        bytes += parts.bytes
        encoded.push(() => parts.frames(wireFrames, current))
      } else {
        const frame = redact(source, workspaceRoot)
        const json = JSON.stringify(frame)
        bytes += Buffer.byteLength(json)
        encoded.push(() => wireFrames(json))
      }
    }
    replaying.add(subscription)
    sendBulk(
      (function* () {
        for (const [index, produce] of encoded.entries()) {
          if (!current()) return
          // The fence is the replay's last frame. Once it is on its way the
          // client holds a newer cursor, so live frames behind it count
          // against the usual bound again: a resync from here on still moves
          // the client forward, and one that has stopped reading is found.
          if (index === encoded.length - 1) replaying.delete(subscription)
          yield* produce()
        }
      })(),
      bytes,
      subscription,
    )
  }
  const error = (code: ConversationWireErrorCode, message: string): void => sendLive({ type: 'error', code, message })
  const result = (
    requestId: string,
    value: { ok: true } | { ok: false; code?: string; message: string },
  ): Promise<void> => {
    if (value.ok) return respond({ type: 'result', requestId, ok: true, data: value })
    const code =
      value.code === 'not_found' ? 'not_found' : value.code === 'invalid_input' ? 'invalid_frame' : 'unavailable'
    return respond({ type: 'result', requestId, ok: false, code, message: value.message })
  }
  const requireKey = (requestId: string): ConversationKey | null => {
    if (currentKey) return currentKey
    sendLive({ type: 'result', requestId, ok: false, code: 'not_found' })
    return null
  }
  /** A subscription that did not start, correlated by its key, and whether trying again can help. */
  const subscribeFailed = (
    key: Extract<ConversationClientMessage, { type: 'subscribe' }>['key'],
    code: ConversationWireErrorCode,
    message: string,
    retryAfterMs?: number,
  ): void =>
    sendLive({
      type: 'subscribeFailed',
      key: { workspaceId: key.workspaceId, agentId: key.agentId },
      code,
      message,
      retryable: retryAfterMs !== undefined,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  /** What subscriptions other than `keep` left waiting to be sent: stale once the client asked for another. */
  const dropQueued = (keep?: number): void => {
    for (const entry of [...pending]) {
      if (entry.subscription === undefined || entry.subscription === keep) continue
      if (entry.kind === 'live') removeLive(entry)
      else if (!entry.started) {
        pending.splice(pending.indexOf(entry), 1)
        bulkBytes -= entry.bytes
        replaying.delete(entry.subscription)
      }
    }
    releaseBulkWaiters()
  }
  /**
   * The client asked to follow another conversation and could not: it follows
   * none now. Commands carry no key, so one sent next must not land on the
   * conversation it moved away from.
   */
  const unfollow = (): void => {
    subscription?.dispose()
    subscription = null
    currentKey = null
    stopWatches()
    dropQueued()
  }
  const subscribe = async (frame: Extract<ConversationClientMessage, { type: 'subscribe' }>): Promise<void> => {
    const key = host.resolveKey(frame.key.workspaceId, frame.key.agentId)
    if (!key) {
      unfollow()
      subscribeFailed(frame.key, 'not_found', 'Conversation is unavailable.')
      return
    }
    subscription?.dispose()
    const generation = ++subscriptionGeneration
    // What an earlier subscription left waiting to be sent is stale now.
    dropQueued(generation)
    // A watch on another chat's held messages ends with the move; one on this
    // chat (a client joining it again) carries on.
    if (queuedWatch && queuedWatch.chat !== chatId(key)) stopQueuedWatch()
    if (scheduledWatch && scheduledWatch.chat !== chatId(key)) stopScheduledWatch()
    currentKey = key
    // Every snapshot and fence names the conversation it belongs to, so a
    // client can refuse one for a conversation it no longer follows.
    const wireKey = { workspaceId: key.workspaceId, agentId: key.agentId }
    // Frames before the fence are the join's replay. They are collected and
    // sent as one paced unit, so a catch-up of two thousand events or a large
    // snapshot never counts against the bound on live events behind it.
    let replay: ConversationServerFrame[] | null = []
    const cursor = { afterSeq: frame.afterSeq, generation: frame.generation, turnLimit: frame.turnLimit }
    const joined = host.subscribe(key, cursor, (source) => {
      if (closed || generation !== subscriptionGeneration) return
      if (source.type === 'error') {
        // The join could not read the transcript. A command must not land
        // on a conversation this socket never synchronized with.
        replay = null
        if (currentKey === key) currentKey = null
        subscribeFailed(frame.key, 'unavailable', source.message, SUBSCRIBE_RETRY_MS)
        return
      }
      const event: ConversationServerFrame =
        source.type === 'snapshot' || source.type === 'synchronized' ? { ...source, key: wireKey } : source
      if (!replay) {
        sendLive(event, generation)
        return
      }
      replay.push(event)
      if (event.type === 'synchronized') {
        const frames = replay
        replay = null
        sendReplay(frames, generation)
      }
    })
    subscription = joined
    await joined.ready
  }
  const handle = async (frame: ConversationClientMessage): Promise<void> => {
    if (!mayRead) {
      error('conversation_scope_required', 'This device has no conversation read grant.')
      return
    }
    if (frame.type === 'hello') {
      const answer: ConversationHelloAnswer = {
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        minProtocolVersion: CONVERSATION_PROTOCOL_MIN_SUPPORTED,
        capabilities: (options.capabilities ?? []).filter((name) =>
          (CONVERSATION_CAPABILITIES as readonly string[]).includes(name),
        ),
      }
      await respond({ type: 'result', requestId: frame.requestId, ok: true, data: answer })
      return
    }
    if (frame.type === 'list') {
      await respond({ type: 'sessions', requestId: frame.requestId, sessions: await host.list() })
      return
    }
    if (frame.type === 'subscribe') {
      await subscribe(frame)
      return
    }
    if (frame.type === 'loadEarlier') {
      const key = requireKey(frame.requestId)
      if (key) await result(frame.requestId, await host.loadEarlier(key, frame.beforeCursor, frame.turnLimit))
      return
    }
    if (frame.type === 'getToolDetail') {
      const key = requireKey(frame.requestId)
      if (key) await result(frame.requestId, await host.getToolDetail(key, frame.toolUseId))
      return
    }
    if (frame.type === 'getTurnDiff') {
      const key = requireKey(frame.requestId)
      if (key) await result(frame.requestId, await host.getTurnDiff(key, frame.turnSeq, frame.path))
      return
    }
    if (frame.type === 'watchQueued') {
      const key = requireKey(frame.requestId)
      if (!key) return
      if (!host.watchQueued) {
        await result(frame.requestId, { ok: false, message: 'This desktop holds no queued messages.' })
        return
      }
      await result(frame.requestId, { ok: true })
      // Asked again after each fence: the watch is begun afresh, so the client
      // is told what is held now even when nothing changed meanwhile.
      stopQueuedWatch()
      if (closed || !currentKey || chatId(currentKey) !== chatId(key)) return
      const wireKey = { workspaceId: key.workspaceId, agentId: key.agentId }
      const stop = host.watchQueued(wireKey, (messages) => sendLive({ type: 'queued', key: wireKey, messages }))
      queuedWatch = { chat: chatId(key), stop }
      return
    }
    if (frame.type === 'watchScheduled') {
      const key = requireKey(frame.requestId)
      if (!key) return
      if (!host.watchScheduled) {
        await result(frame.requestId, { ok: false, message: 'This desktop schedules no messages from another device.' })
        return
      }
      await result(frame.requestId, { ok: true })
      // Begun afresh after each fence, as the held messages' watch is.
      stopScheduledWatch()
      if (closed || !currentKey || chatId(currentKey) !== chatId(key)) return
      const wireKey = { workspaceId: key.workspaceId, agentId: key.agentId }
      const stop = host.watchScheduled(wireKey, (messages) => sendLive({ type: 'scheduled', key: wireKey, messages }))
      scheduledWatch = { chat: chatId(key), stop }
      return
    }
    if (frame.type === 'command') {
      const started = now()
      const key = currentKey
      const finish = (
        ok: boolean,
        code?: ConversationWireErrorCode,
        message?: string,
        notice?: string,
        retryAfterMs?: number,
      ): void => {
        options.audit({
          tool: `conversation.${frame.command.kind}`,
          commandId: frame.commandId,
          key: key ? { workspaceId: key.workspaceId, agentId: key.agentId } : null,
          ok,
          ...(code ? { code } : {}),
          durationMs: now() - started,
        })
        sendLive({
          type: 'commandResult',
          commandId: frame.commandId,
          ok,
          ...(code ? { code } : {}),
          ...(message ? { message } : {}),
          ...(notice ? { notice } : {}),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        })
      }
      if (!mayOperate) return finish(false, 'conversation_operate_required')
      if (!key) return finish(false, 'not_found')
      const commandResult = await host.command(key, options.deviceId, frame.commandId, frame.command)
      if (commandResult.ok) finish(true, undefined, undefined, commandResult.notice)
      // This lane names no fingerprint, so a conflict cannot come back on it.
      else
        finish(
          false,
          commandResult.code === undefined || commandResult.code === 'command_id_conflict'
            ? 'unavailable'
            : commandResult.code,
          commandResult.message,
          undefined,
          commandResult.code === 'busy' ? commandResult.retryAfterMs : undefined,
        )
    }
  }
  // Reads and commands are bounded per socket: one device cannot queue up
  // unbounded transcript reads or turns. Over the bound the request is
  // answered as busy, with a delay, and the socket stays open.
  const admit = (frame: ConversationClientMessage): boolean => {
    const busy = { ok: false as const, code: 'busy' as const, retryAfterMs: BUSY_RETRY_MS }
    if (frame.type === 'command') {
      if (commandsInFlight < MAX_IN_FLIGHT_COMMANDS) return true
      sendLive({ type: 'commandResult', commandId: frame.commandId, ...busy })
      return false
    }
    if (readsInFlight < MAX_IN_FLIGHT_READS) return true
    if (frame.type === 'subscribe') {
      unfollow()
      subscribeFailed(frame.key, 'busy', 'Too many requests.', BUSY_RETRY_MS)
    } else sendLive({ type: 'result', requestId: frame.requestId, ...busy })
    return false
  }
  /** A handler that threw still settles what the client sent, under its own id. */
  const failed = (frame: ConversationClientMessage): void => {
    const message = 'Conversation operation failed.'
    if (frame.type === 'command')
      sendLive({ type: 'commandResult', commandId: frame.commandId, ok: false, code: 'unavailable', message })
    else if (frame.type === 'subscribe') subscribeFailed(frame.key, 'unavailable', message, SUBSCRIBE_RETRY_MS)
    else sendLive({ type: 'result', requestId: frame.requestId, ok: false, code: 'unavailable', message })
  }
  /**
   * A frame the protocol refused, answered under the id it carries: a command
   * as its `commandResult` — audited like any other command attempt — and a
   * read as its `result`. Only a frame with no usable id gets a bare error.
   */
  const refuse = (rejection: ConversationFrameRejection): void => {
    const { code, message, commandId, commandKind, requestId } = rejection
    if (commandId) {
      if (commandKind && Object.hasOwn(COMMAND_KINDS, commandKind))
        options.audit({
          tool: `conversation.${commandKind}`,
          commandId,
          key: currentKey ? { workspaceId: currentKey.workspaceId, agentId: currentKey.agentId } : null,
          ok: false,
          code,
          durationMs: 0,
        })
      sendLive({ type: 'commandResult', commandId, ok: false, code, message })
    } else if (requestId) sendLive({ type: 'result', requestId, ok: false, code, message })
    else error(code, message)
  }

  /** Apply the grant as it is now. False when the socket had to close. */
  const applyScopes = (): boolean => {
    if (closed) return false
    const scopes = readScopes()
    if (!scopes) {
      close(WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
      return false
    }
    const grants = new Set(scopes)
    mayRead = tailnetScopeGrantsAccess(grants, 'conversation:read')
    mayOperate = tailnetScopeGrantsAccess(grants, 'conversation:operate')
    if (mayRead) return true
    // Sent directly: whatever is still queued is exactly what the device may
    // no longer read.
    pending.length = 0
    try {
      socket.write(
        encodeTextFrame(
          JSON.stringify({
            type: 'error',
            code: 'conversation_scope_required',
            message: 'This device has no conversation read grant.',
          } satisfies ConversationServerFrame),
        ),
      )
    } catch {
      /* Peer already left. */
    }
    close(CONVERSATION_SCOPE_CLOSE_CODE, 'conversation_scope_required')
    return false
  }

  const heartbeat = setInterval(() => {
    if (closed) return
    if (now() - lastPong > PONG_TIMEOUT_MS) {
      close(WEBSOCKET_CLOSE_GOING_AWAY, 'pong_timeout')
      return
    }
    writeControl(encodePingFrame())
  }, PING_MS)
  heartbeat.unref()
  const stream = { deviceId: options.deviceId, close, isClosed: () => closed, refreshScopes: () => void applyScopes() }
  if (!applyScopes()) return stream

  const decoder = createWebSocketFrameDecoder(
    CONVERSATION_MAX_CLIENT_FRAME_BYTES,
    'server',
    MAX_SKIPPED_CLIENT_FRAME_BYTES,
  )
  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      close(decoded.code, decoded.reason)
      return
    }
    for (const frame of decoded.frames) {
      if (closed) return
      if (frame.kind === 'close') {
        close(WEBSOCKET_CLOSE_GOING_AWAY, '')
        return
      }
      if (frame.kind === 'pong') {
        lastPong = now()
        continue
      }
      if (frame.kind === 'ping') {
        writeControl(encodePongFrame(frame.payload))
        continue
      }
      if (frame.kind === 'oversized') {
        refuse(oversizedRejection(frame.prefix))
        continue
      }
      if (frame.kind !== 'text') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.text)
      } catch {
        error('invalid_frame', 'Frame must be JSON.')
        continue
      }
      const clientFrame = parseConversationClientMessage(parsed)
      if (!clientFrame) {
        refuse(explainRejectedConversationMessage(parsed))
        continue
      }
      if (!applyScopes()) return
      if (!admit(clientFrame)) continue
      const isCommand = clientFrame.type === 'command'
      if (isCommand) commandsInFlight++
      else readsInFlight++
      void handle(clientFrame)
        .catch(() => failed(clientFrame))
        .finally(() => {
          if (isCommand) commandsInFlight--
          else readsInFlight--
        })
    }
  })
  socket.on('end', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('close', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('error', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  return stream
}

/** A chat's identity as one string, whatever root a key carries beside it. */
const chatId = (key: Pick<ConversationKey, 'workspaceId' | 'agentId'>): string =>
  JSON.stringify([key.workspaceId, key.agentId])

/**
 * The refusal for a frame too large to read, from the start of it that was
 * kept: enough to name the command or request it was, since a client puts
 * those ids ahead of a long message.
 */
function oversizedRejection(prefix: string): ConversationFrameRejection {
  const field = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,200})"`).exec(prefix)?.[1]
  const type = field('type')
  const commandId = type === 'command' ? field('commandId') : undefined
  const requestId = type !== 'command' ? field('requestId') : undefined
  const commandKind = type === 'command' ? field('kind') : undefined
  return {
    code: 'too_large',
    message: `A frame may be at most ${CONVERSATION_MAX_CLIENT_FRAME_BYTES} bytes.`,
    ...(commandId ? { commandId } : {}),
    ...(commandKind ? { commandKind } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

// Characters that continue a path segment. A prefix only matches when what
// follows it does not continue its last segment, so `/Users/dev` never matches
// inside `/Users/developer` or `/Users/dev.old`.
const SEGMENT_CHAR = String.raw`[\w.~\-]`
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type PathRewriter = (text: string) => string
const rewriters = new Map<string, PathRewriter>()

/** A path as a pattern matching it with either separator: Windows accepts `C:/Users` as readily as `C:\\Users`. */
const pathPattern = (path: string) =>
  path
    .split(/[\\/]+/)
    .map(escapeRegExp)
    .join(String.raw`[\\/]`)
/** The same path as a `file:` URL spells it: forward slashes, each segment percent-encoded. */
const urlPathPattern = (path: string) =>
  path
    .split(/[\\/]+/)
    .map((segment) => escapeRegExp(encodeURIComponent(segment).replace(/%3A/gi, ':')))
    .join('/')

function pathRewriter(home: string, workspaceRoot: string | null): PathRewriter {
  const cacheKey = JSON.stringify([home, workspaceRoot])
  const cached = rewriters.get(cacheKey)
  if (cached) return cached
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  // A prefix starts a path: at the start of the text, or after a character
  // that cannot be inside one. A path inside a URL is the URL step's.
  const start = String.raw`(?<![\w.~\-/\\])`
  const steps: Array<[RegExp, string]> = []
  const homeRoot = home.replace(/[\\/]+$/, '')
  // A `file:` URL stays a URL: its home prefix becomes `/[home]`, so
  // `file:///Users/dev/a.ts` reads `file:///[home]/a.ts` rather than losing
  // the slash that makes it absolute. A drive-letter home sits after one more
  // slash (`file:///C:/Users/dev`), a URL may spell the home encoded, and in
  // a URL an escape (`%20`) continues a segment.
  if (homeRoot.length > 1)
    steps.push([
      new RegExp(
        String.raw`file://(?:/(?=[A-Za-z]:))?(?:${pathPattern(homeRoot)}|${urlPathPattern(homeRoot)})(?![\w.~\-%])`,
        flags,
      ),
      'file:///[home]',
    ])
  const root = workspaceRoot?.replace(/[\\/]+$/, '') ?? ''
  if (root.length > 1) {
    const prefix = pathPattern(root)
    // In the workspace: the path from its root, and the root itself as `.`.
    steps.push([new RegExp(`${start}${prefix}[\\\\/](?=${SEGMENT_CHAR})`, flags), ''])
    steps.push([new RegExp(`${start}${prefix}(?!${SEGMENT_CHAR})`, flags), '.'])
  }
  if (homeRoot.length > 1)
    steps.push([new RegExp(`${start}${pathPattern(homeRoot)}(?!${SEGMENT_CHAR})`, flags), '[home]'])
  const rewrite: PathRewriter = (text) =>
    steps.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
  if (rewriters.size > 64) rewriters.clear()
  rewriters.set(cacheKey, rewrite)
  return rewrite
}

/**
 * Host paths as a remote reader sees them. A path inside the conversation's
 * workspace becomes relative to it, as the desktop shows it; anything else in
 * the home directory starts `[home]`. Only whole path segments match, and a
 * path that merely contains the home path further along is left alone.
 */
export function redactHostPaths<T>(value: T, input: { home: string; workspaceRoot: string | null }): T {
  const rewrite = pathRewriter(input.home, input.workspaceRoot)
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') return rewrite(entry)
    if (Array.isArray(entry)) return entry.map(walk)
    if (entry && typeof entry === 'object')
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, walk(child)]))
    return entry
  }
  return walk(value) as T
}
