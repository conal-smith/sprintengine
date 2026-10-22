import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

import {
  STUDIO_HELLO_TIMEOUT_MS,
  STUDIO_MAX_CLIENT_FRAME_BYTES,
  STUDIO_MAX_FRAME_BYTES,
  STUDIO_METHODS,
  STUDIO_TOPICS,
  checkStudioProtocolVersion,
  isStudioMethod,
  isStudioTopic,
  parseStudioClientFrame,
  parseStudioTopicParams,
  studioClientFrameIds,
  studioScopesGrant,
  studioWireFrames,
  type ConversationServerFrame,
  type StudioByeCode,
  type StudioClientInfo,
  type StudioErrorBody,
  type StudioGrant,
  type StudioRequestFrame,
  type StudioConversationKey,
  type StudioServerFrame,
  type StudioSubscribeFrame,
  type StudioTopic,
  type StudioTopicParams,
  type StudioWelcomeFrame,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationEvent, ConversationKey, ConversationSessionFrame } from '../../shared/conversation-runtime'
import {
  conversationDeltaKey,
  conversationSnapshotParts,
  type ConversationSnapshotFrame,
} from '../conversation-stream-shaping'
import { studioErrorId, type StudioRpcAnswer, type StudioRpcRouter } from './studio-rpc-router'
import type { ClientToolConnection, ClientToolRegistry } from '../tools/client-tool-registry'
import type { StudioFiles } from './studio-files'
import type { StudioPullRequests } from '../pull-requests/pull-request-domain'
import type { StudioLocalServers } from '../local-servers/local-server-domain'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioChatBackend,
  StudioConversationBackend,
  StudioRequestContext,
} from './studio-rpc-types'

// One client's connection to the Studio RPC: newline-delimited JSON on a
// stream socket, a `hello` first, then requests and subscriptions multiplexed
// until either end closes.
//
// The outbound side is the tailnet conversation lane's, applied to many
// streams at once. A join's replay — a snapshot, or the events after a cursor,
// then the fence — is queued as one paced unit that does not count against the
// bound on live frames behind it, so a large catch-up is never mistaken for a
// reader that stopped. Live frames waiting behind a slow reader merge where
// they can (consecutive deltas of one message; a tool's newer partial output
// replaces its older one), so a streaming reply is one entry however long the
// reader stalls. A reader that stops reading outgrows the bound and is sent
// `bye resync_required` with a growing delay, then closed; it reconnects and
// resumes from its cursors. Writes wait for the socket to drain, so what is
// waiting is in the queue the bound measures and not in the socket's buffer.
//
// The stream need not be a socket. Studio's own windows each reach the RPC
// over a port main hands them (`studio-frame-port.ts`), one frame per message.
// Those connections are the app's own chat view (`ownWindow`): what they are
// sent is not redacted, and what they do is not audited, as over IPC.
//
// A connection whose grant may offer tools is also one end of the client
// tools registry: Studio sends it `call` and `cancel` frames for the tools it
// offered, and it answers with `reply` and `progress`. Those two are never
// answered: one in the wrong shape is logged and dropped, and one from a
// connection that never could have been sent a call is a frame out of place.

// A hello is small; a first line bigger than this is not a Studio client.
const MAX_HELLO_BYTES = 64 * 1024
// A client frame over the protocol's cap is skipped and refused, not
// buffered; one beyond this is not a Studio client and closes.
const MAX_SKIPPED_CLIENT_FRAME_BYTES = 16 * 1024 * 1024
const MAX_LIVE_FRAMES = 1024
const MAX_LIVE_BYTES = 4 * 1024 * 1024
const MAX_LIVE_BYTES_BEHIND_REPLAY = 16 * 1024 * 1024
const MAX_BULK_BYTES = 48 * 1024 * 1024
// One logical response (a tool detail, a diff) above this is not sent at all.
const MAX_LOGICAL_FRAME_BYTES = 32 * 1024 * 1024
const MAX_IN_FLIGHT_READS = 8
const MAX_IN_FLIGHT_COMMANDS = 32
const MAX_SUBSCRIPTIONS = 32
// Studio's own window asks what its IPC asked, which never answered busy: a
// transcript checks every file it links, and a window follows every chat it
// shows. Its bounds are there to stop a runaway, not to pace a view.
const OWN_WINDOW_MAX_IN_FLIGHT = 512
const OWN_WINDOW_MAX_SUBSCRIPTIONS = 512
const BUSY_RETRY_MS = 250
const SUBSCRIBE_RETRY_MS = 2_000
// How long a closing connection waits for the client to read its `bye`.
const BYE_GRACE_MS = 1_000
// File searches are kept by main per caller number; a connection's numbers
// start well clear of any window's webContents id, which counts up from 1.
let nextSlot = 1_000_000_000

export type StudioRpcConnection = {
  readonly connectionId: string
  /** The client this connection authenticated as, once it has. */
  clientId(): string | null
  /** Tell the client why, then close. */
  bye(code: StudioByeCode, message: string, retryAfterMs?: number): void
  isClosed(): boolean
}

export type StudioRpcConnectionOptions = {
  socket: Duplex
  connectionId: string
  authenticator: StudioAuthenticator
  router: StudioRpcRouter
  backend: StudioConversationBackend
  /** The chat surface: its push streams, and the file searches a closed connection leaves behind. */
  chat?: () => StudioChatBackend | null
  /** One of Studio's own windows, over the port main handed it. Default false. */
  ownWindow?: boolean
  /** The desktop's own shell, over a port main holds: it may offer the built-in toolsets. Default false. */
  shell?: boolean
  /** Audit its mutations even when it is Studio's own view (an owner's web tab). */
  audited?: boolean
  /** Hold the folders it names to the ones Studio knows: a browser on the tailnet. */
  knownFoldersOnly?: boolean
  /** The client tools registry, when this Studio serves client tools. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots: the `files.watch` stream. */
  files?: StudioFiles
  /** The pull requests the conversations opened: the `pullRequests.changed` stream. */
  pullRequests?: StudioPullRequests
  /** The local servers the conversations started: the `localServers.changed` stream. */
  localServers?: StudioLocalServers
  /** The welcome's server-wide members: who this Studio is and what it serves. */
  welcome: () => Omit<StudioWelcomeFrame, 't' | 'grant' | 'pairing'>
  /** The delay a client that fell behind is told to wait; it should grow with repeated resyncs. */
  resyncRetryAfterMs?: (clientId: string) => number
  audit?: (entry: StudioAuditEntry) => void
  onClosed(connection: StudioRpcConnection): void
  helloTimeoutMs?: number
  /** Whether one more connection for this client is allowed, asked once it has authenticated. */
  admitClient?: (clientId: string) => boolean
  log?: (message: string) => void
}

type LiveEntry = {
  kind: 'live'
  frame: StudioServerFrame
  /** The frame as encoded when queued; dropped when a later delta extends it in place. */
  json?: string
  bytes: number
  sub?: string
  delta?: { key: string; event: ConversationEvent }
  partialToolUseId?: string
}
type BulkEntry = { kind: 'bulk'; lines: Iterator<string>; bytes: number; started: boolean; sub?: string }

type Subscription = {
  id: string
  topic: StudioTopic
  /** The conversation followed; null for a push topic, which follows none. */
  key: ConversationKey | null
  /** Frames of the join, until its fence; null once the replay is queued. */
  replay: ConversationServerFrame[] | null
  handle: { dispose(): void } | null
}

export function createStudioRpcConnection(options: StudioRpcConnectionOptions): StudioRpcConnection {
  const { socket, authenticator, router, backend } = options
  const ownWindow = options.ownWindow === true
  const maxReads = ownWindow ? OWN_WINDOW_MAX_IN_FLIGHT : MAX_IN_FLIGHT_READS
  const maxCommands = ownWindow ? OWN_WINDOW_MAX_IN_FLIGHT : MAX_IN_FLIGHT_COMMANDS
  const maxSubscriptions = ownWindow ? OWN_WINDOW_MAX_SUBSCRIPTIONS : MAX_SUBSCRIPTIONS
  // What a client is shown of an event; a window of Studio's own is shown it as IPC shows it.
  const redact = <T>(value: T): T => (ownWindow ? value : backend.redact(value))
  const context: StudioRequestContext = {
    connectionId: options.connectionId,
    slot: nextSlot++,
    ownWindow,
    ...(options.audited === undefined ? {} : { audited: options.audited }),
    ...(options.knownFoldersOnly ? { knownFoldersOnly: true } : {}),
  }
  let state: 'hello' | 'open' | 'closed' = 'hello'
  let clientId: string | null = null
  let clientName = ''
  let frameSequence = 0
  const pending: Array<LiveEntry | BulkEntry> = []
  let liveFrames = 0
  let liveBytes = 0
  let bulkBytes = 0
  const bulkWaiters: Array<{ bytes: number; resolve: () => void }> = []
  let writing = false
  let readsInFlight = 0
  let commandsInFlight = 0
  const subscriptions = new Map<string, Subscription>()
  // Subscriptions whose replay is still queued or being written.
  const replaying = new Set<string>()
  const releases: Array<() => void> = []
  let helloTimer: ReturnType<typeof setTimeout> | undefined
  // Whether this connection is one end of the client tools registry.
  let toolsAttached = false

  const nextFrameId = () => `${options.connectionId}:${++frameSequence}`
  // Read through a call, so a check after an await is not narrowed away.
  const closed = () => state === 'closed'

  const connection: StudioRpcConnection = {
    connectionId: options.connectionId,
    clientId: () => clientId,
    bye: (code, message, retryAfterMs) => bye(code, message, retryAfterMs),
    isClosed: () => state === 'closed',
  }

  // ── Closing ───────────────────────────────────────────────────────────────

  function shutdown(): void {
    if (state === 'closed') return
    state = 'closed'
    clearTimeout(helloTimer)
    if (toolsAttached) options.tools?.detach(options.connectionId)
    pending.length = 0
    liveFrames = liveBytes = bulkBytes = 0
    for (const waiter of bulkWaiters.splice(0)) waiter.resolve()
    for (const subscription of subscriptions.values()) subscription.handle?.dispose()
    subscriptions.clear()
    replaying.clear()
    for (const release of releases.splice(0)) release()
    try {
      options.chat?.()?.releaseFileSearches(context.slot)
    } catch {
      // Nothing of this connection's is left to end.
    }
    options.router.connectionClosed(options.connectionId)
    options.onClosed(connection)
  }

  function bye(code: StudioByeCode, message: string, retryAfterMs?: number): void {
    if (state === 'closed') return
    // Written ahead of anything still queued: what is queued is exactly what
    // a revoked or fallen-behind client should no longer be sent.
    if (!socket.destroyed) {
      try {
        socket.write(
          `${JSON.stringify({ t: 'bye', code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })}\n`,
        )
        socket.end()
      } catch {
        /* The peer already left. */
      }
      // A client that never reads its end must not hold the socket open.
      setTimeout(() => socket.destroy(), BYE_GRACE_MS).unref?.()
    }
    shutdown()
  }

  function resync(): void {
    const retryAfterMs = clientId ? (options.resyncRetryAfterMs?.(clientId) ?? 1_000) : 1_000
    bye(
      'resync_required',
      'This app fell too far behind its streams. Reconnect and resume from your cursors.',
      retryAfterMs,
    )
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Write one line: `true` when the stream took it at once, else a promise
   * that settles once it drains. A frame the stream takes at once is gone
   * before the next is queued, so nothing merges unless the reader is behind.
   */
  function writeLine(line: string): true | Promise<void> {
    if (state === 'closed' || socket.destroyed) return true
    if (socket.write(`${line}\n`)) return true
    return new Promise((resolve) => {
      const done = () => {
        socket.off('drain', done)
        socket.off('close', done)
        resolve()
      }
      socket.on('drain', done)
      socket.on('close', done)
    })
  }

  function releaseBulkWaiters(): void {
    while (bulkWaiters.length && (bulkBytes === 0 || bulkBytes + bulkWaiters[0].bytes <= MAX_BULK_BYTES))
      bulkWaiters.shift()!.resolve()
  }

  async function drain(): Promise<void> {
    if (writing) return
    writing = true
    try {
      while (!closed() && pending.length) {
        const entry = pending[0]
        if (entry.kind === 'live') {
          pending.shift()
          liveFrames--
          liveBytes -= entry.bytes
          // A logical frame's chunks go out back to back, with nothing between.
          for (const line of studioWireFrames(entry.json ?? JSON.stringify(entry.frame), nextFrameId())) {
            if (closed()) break
            const written = writeLine(line)
            if (written !== true) await written
          }
          continue
        }
        entry.started = true
        const next = entry.lines.next()
        if (next.done) {
          pending.shift()
          bulkBytes -= entry.bytes
          if (entry.sub !== undefined) replaying.delete(entry.sub)
          releaseBulkWaiters()
          continue
        }
        // A replay yields after every line, taken or not, so a large one never
        // holds the process; live frames queued meanwhile wait behind it.
        await writeLine(next.value)
      }
    } finally {
      writing = false
    }
  }

  function extend(into: LiveEntry & { delta: object }, event: ConversationEvent): void {
    const text = String(event.payload!.text)
    const merged = into.delta.event
    merged.payload = { ...merged.payload, text: String(merged.payload!.text) + text }
    merged.seq = event.seq
    into.json = undefined
    const grown = Buffer.byteLength(JSON.stringify(text)) - 2
    into.bytes += grown
    liveBytes += grown
  }

  function removeLive(entry: LiveEntry): void {
    const index = pending.indexOf(entry)
    if (index < 0) return
    pending.splice(index, 1)
    liveFrames--
    liveBytes -= entry.bytes
  }

  /** Queue one live frame, merging it into what already waits where it can. */
  function enqueueLive(frame: StudioServerFrame, sub?: string, encoded?: string): void {
    if (state === 'closed') return
    const event = frame.t === 'frame' && frame.frame.type === 'event' ? (frame.frame.event as ConversationEvent) : null
    const key = event ? conversationDeltaKey(event) : null
    const tail = pending.at(-1)
    const behindReplay = sub !== undefined && replaying.has(sub)
    const byteBound = behindReplay ? MAX_LIVE_BYTES_BEHIND_REPLAY : MAX_LIVE_BYTES
    if (key && event && tail?.kind === 'live' && tail.delta?.key === key && tail.sub === sub) {
      // Only an unsent frame is ever in the queue, so this merges only while
      // the reader is behind. The merged delta keeps its first id and takes
      // the last sequence, which is how a stored run reads back too.
      extend(tail as LiveEntry & { delta: object }, event)
      if (liveBytes > byteBound) resync()
      return
    }
    const toolUseId =
      event?.type === 'tool_output' && typeof event.payload?.toolUseId === 'string' ? event.payload.toolUseId : null
    if (toolUseId)
      for (const queued of pending.filter(
        (entry): entry is LiveEntry =>
          entry.kind === 'live' && entry.sub === sub && entry.partialToolUseId === toolUseId,
      ))
        removeLive(queued)
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
      ...(sub === undefined ? {} : { sub }),
      // The merge edits the event in place, so it holds its own copy.
      ...(key && event
        ? { delta: { key, event: (frame as { frame: { event: ConversationEvent } }).frame.event } }
        : {}),
      ...(toolUseId && event?.payload?.partial === true ? { partialToolUseId: toolUseId } : {}),
    })
    liveFrames++
    liveBytes += bytes
    void drain()
  }

  function enqueueBulk(lines: Iterator<string>, bytes: number, sub?: string): void {
    if (state === 'closed') return
    pending.push({ kind: 'bulk', lines, bytes, started: false, ...(sub === undefined ? {} : { sub }) })
    bulkBytes += bytes
    void drain()
  }

  /** A request's answer: small ones queue live, large ones wait for bulk room, one too large is refused. */
  async function respond(id: string, answer: StudioRpcAnswer): Promise<void> {
    if (state === 'closed') return
    const frame: StudioServerFrame = answer.ok
      ? { t: 'res', id, ok: true, result: answer.result }
      : { t: 'res', id, ok: false, error: answer.error }
    const json = JSON.stringify(frame)
    const bytes = Buffer.byteLength(json)
    if (bytes > MAX_LOGICAL_FRAME_BYTES) {
      refuseRequest(id, {
        code: 'too_large',
        message: `The answer is over the ${MAX_LOGICAL_FRAME_BYTES / (1024 * 1024)} MB a frame may carry. Ask for less.`,
      })
      return
    }
    if (bytes <= STUDIO_MAX_FRAME_BYTES) {
      enqueueLive(frame, undefined, json)
      return
    }
    if (bulkBytes > 0 && bulkBytes + bytes > MAX_BULK_BYTES)
      await new Promise<void>((resolve) => bulkWaiters.push({ bytes, resolve }))
    enqueueBulk(studioWireFrames(json, nextFrameId())[Symbol.iterator](), bytes)
  }

  function refuseRequest(id: string, error: StudioErrorBody): void {
    enqueueLive({ t: 'res', id, ok: false, error })
  }

  function subscriptionFailed(
    id: string,
    code: string,
    message: string,
    retryAfterMs?: number,
    errorId?: string,
  ): void {
    enqueueLive({
      t: 'subFailed',
      sub: id,
      code,
      message,
      retryable: retryAfterMs !== undefined,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(errorId === undefined ? {} : { errorId }),
    })
  }

  // ── Streams ───────────────────────────────────────────────────────────────

  function redactedSnapshotPart(part: ConversationSnapshotFrame): ConversationSnapshotFrame {
    return { ...part, page: { ...part.page, events: part.page.events.map((event) => redact(event)) } }
  }

  /** Everything a join produced, queued as one paced unit ahead of the live events that follow it. */
  function sendReplay(frames: ConversationServerFrame[], subscription: Subscription): void {
    const sub = subscription.id
    // A replay stops at the next whole frame once its subscription is gone:
    // the rest of a snapshot, or its fence, would hand the client a cursor for
    // a stream it no longer holds.
    const current = () => state !== 'closed' && subscriptions.get(sub) === subscription
    const envelope = (json: string) => `{"t":"frame","sub":${JSON.stringify(sub)},"frame":${json}}`
    function* wire(json: string): Generator<string> {
      yield* studioWireFrames(envelope(json), nextFrameId())
    }
    let bytes = 0
    const producers: Array<() => Iterable<string>> = []
    for (const source of frames) {
      if (source.type === 'snapshot') {
        // Redacted a part at a time as the writer reaches it, never whole: a
        // snapshot can run to tens of megabytes.
        const parts = conversationSnapshotParts(source as ConversationSnapshotFrame, redactedSnapshotPart)
        bytes += parts.bytes
        producers.push(() => parts.frames(wire, current))
      } else {
        const json = JSON.stringify(
          source.type === 'event' ? { ...source, event: redact(source.event as ConversationEvent) } : source,
        )
        bytes += Buffer.byteLength(json)
        producers.push(() => wire(json))
      }
    }
    replaying.add(sub)
    enqueueBulk(
      (function* () {
        for (const [index, produce] of producers.entries()) {
          if (!current()) return
          // The fence is the replay's last frame. Once it is on its way the
          // client holds a newer cursor, so live frames behind it count against
          // the usual bound again.
          if (index === producers.length - 1) replaying.delete(sub)
          yield* produce()
        }
      })(),
      bytes,
      sub,
    )
  }

  function dropSubscription(subscription: Subscription): void {
    if (subscriptions.get(subscription.id) !== subscription) return
    subscriptions.delete(subscription.id)
    subscription.handle?.dispose()
    replaying.delete(subscription.id)
    // What it left waiting to be sent is for a stream the client no longer holds.
    for (const entry of [...pending]) {
      if (entry.sub !== subscription.id) continue
      if (entry.kind === 'live') removeLive(entry)
      else if (!entry.started) {
        pending.splice(pending.indexOf(entry), 1)
        bulkBytes -= entry.bytes
      }
    }
    releaseBulkWaiters()
  }

  function onFollowFrame(subscription: Subscription, source: ConversationSessionFrame): void {
    if (state === 'closed' || subscriptions.get(subscription.id) !== subscription) return
    // The grant is read again before anything goes out, not only when the
    // client sends: a client that only listens is held to a revoke or a
    // narrowed grant by its next outbound frame even if the revoke listener
    // never reached this connection.
    const grant = liveGrant()
    if (!grant) return
    if (!studioScopesGrant(grant.scopes, STUDIO_TOPICS[subscription.topic].scope)) {
      refreshGrant()
      return
    }
    if (source.type === 'error') {
      // The join could not read the log. Retryable: a log being written by a
      // turn that is starting is readable a moment later.
      dropSubscription(subscription)
      // The runtime's words can name paths and processes: a client is told in
      // stable ones with an id the log keeps them under. Studio's own window
      // reads them as its IPC gives them.
      if (ownWindow) subscriptionFailed(subscription.id, 'unavailable', source.message, SUBSCRIBE_RETRY_MS)
      else {
        const errorId = studioErrorId()
        options.log?.(`Studio RPC conversation.session failed [${errorId}]: ${source.message}`)
        subscriptionFailed(
          subscription.id,
          'unavailable',
          'Studio could not read this conversation just now.',
          SUBSCRIBE_RETRY_MS,
          errorId,
        )
      }
      return
    }
    // Every snapshot and fence names its conversation, as on the tailnet.
    if (!subscription.key) return
    const key = { workspaceId: subscription.key.workspaceId, agentId: subscription.key.agentId }
    const frame: ConversationServerFrame =
      source.type === 'snapshot' || source.type === 'synchronized' ? { ...source, key } : source
    if (subscription.replay) {
      subscription.replay.push(frame)
      if (frame.type === 'synchronized') {
        const frames = subscription.replay
        subscription.replay = null
        sendReplay(frames, subscription)
      }
      return
    }
    if (frame.type === 'event') {
      const event = redact(frame.event as ConversationEvent)
      // A copy the queue may extend in place without touching the runtime's own.
      const owned =
        event === frame.event ? { ...event, ...(event.payload ? { payload: { ...event.payload } } : {}) } : event
      enqueueLive({ t: 'frame', sub: subscription.id, frame: { type: 'event', event: owned } }, subscription.id)
      return
    }
    enqueueLive({ t: 'frame', sub: subscription.id, frame }, subscription.id)
  }

  function subscribe(frame: StudioSubscribeFrame, grant: StudioGrant): void {
    if (!isStudioTopic(frame.topic)) {
      subscriptionFailed(frame.id, 'unknown_topic', `No topic "${frame.topic}".`)
      return
    }
    if (subscriptions.has(frame.id)) {
      subscriptionFailed(frame.id, 'duplicate_subscription', 'That subscription id is already open on this connection.')
      return
    }
    if (subscriptions.size >= maxSubscriptions) {
      subscriptionFailed(frame.id, 'busy', 'Too many streams are open on this connection.', BUSY_RETRY_MS)
      return
    }
    const spec = STUDIO_TOPICS[frame.topic]
    if (spec.owner && !grant.owner) {
      subscriptionFailed(frame.id, 'owner_required', 'This stream is served to Studio’s own connections only.')
      return
    }
    if (!studioScopesGrant(grant.scopes, spec.scope)) {
      subscriptionFailed(frame.id, 'scope_required', `This app's grant does not include "${spec.scope}".`)
      return
    }
    const parsed = parseStudioTopicParams(frame.topic, frame.params)
    if (!parsed.ok) {
      subscriptionFailed(frame.id, parsed.code, parsed.message)
      return
    }
    if (spec.push) {
      subscribePush(frame.id, frame.topic, parsed.params)
      return
    }
    const wireKey = (parsed.params as { key: StudioConversationKey }).key
    if (wireKey.workspaceRoot !== undefined && !grant.owner) {
      subscriptionFailed(
        frame.id,
        'owner_required',
        'Only Studio’s own connections may name a conversation by its folder.',
      )
      return
    }
    // An owner names the folder a chat in a run worktree is kept in; anyone
    // else's key is resolved by its workspace, as on the tailnet.
    const key =
      wireKey.workspaceRoot === undefined
        ? backend.resolveKey(wireKey.workspaceId, wireKey.agentId)
        : { workspaceRoot: wireKey.workspaceRoot, workspaceId: wireKey.workspaceId, agentId: wireKey.agentId }
    if (!key) {
      subscriptionFailed(
        frame.id,
        'not_found',
        `No conversation "${wireKey.agentId}" in workspace "${wireKey.workspaceId}" here.`,
      )
      return
    }
    const subscription: Subscription = { id: frame.id, topic: frame.topic, key, replay: [], handle: null }
    subscriptions.set(frame.id, subscription)
    const handle = backend.follow(
      key,
      {
        ...(frame.cursor ? { afterSeq: frame.cursor.afterSeq, generation: frame.cursor.generation } : {}),
        ...((parsed.params as { turnLimit?: number }).turnLimit === undefined
          ? {}
          : { turnLimit: (parsed.params as { turnLimit?: number }).turnLimit }),
      },
      (source) => onFollowFrame(subscription, source),
    )
    subscription.handle = handle
    // Dropped while the follow was being set up (a failure it delivered at once).
    if (subscriptions.get(frame.id) !== subscription) handle.dispose()
    void handle.ready.catch(() => undefined)
  }

  /** A topic with no cursor: each payload is sent as it comes, and nothing is replayed. */
  function subscribePush(id: string, topic: StudioTopic, params?: unknown): void {
    if (topic === 'tools.catalog') {
      subscribeCatalog(id)
      return
    }
    if (topic === 'files.watch') {
      subscribeWatch(id, params as StudioTopicParams<'files.watch'>)
      return
    }
    if (topic === 'pullRequests.changed') {
      subscribePullRequests(id)
      return
    }
    if (topic === 'localServers.changed') {
      subscribeLocalServers(id)
      return
    }
    const chat = options.chat?.() ?? null
    if (!chat || topic !== 'conversation.commands') {
      subscriptionFailed(id, 'unavailable', `This Studio does not serve ${topic}.`)
      return
    }
    const subscription: Subscription = { id, topic, key: null, replay: null, handle: null }
    subscriptions.set(id, subscription)
    const stop = chat.onCommandsChanged((catalog) => {
      if (state === 'closed' || subscriptions.get(id) !== subscription) return
      // The grant is read again before anything goes out, as for a conversation.
      const grant = liveGrant()
      if (!grant) return
      if (!studioScopesGrant(grant.scopes, STUDIO_TOPICS[topic].scope)) {
        refreshGrant()
        return
      }
      enqueueLive({ t: 'push', sub: id, payload: redact(catalog) }, id)
    })
    subscription.handle = { dispose: stop }
  }

  /** One directory's changed names, as they happen, until the client unsubscribes or the folder goes. */
  function subscribeWatch(id: string, params: StudioTopicParams<'files.watch'>): void {
    const files = options.files
    if (!files) {
      subscriptionFailed(id, 'unavailable', 'This Studio does not serve files.watch.')
      return
    }
    const subscription: Subscription = { id, topic: 'files.watch', key: null, replay: null, handle: null }
    subscriptions.set(id, subscription)
    void files
      .watch(
        params.root,
        params.path,
        (names) => {
          if (state === 'closed' || subscriptions.get(id) !== subscription) return
          const grant = liveGrant()
          if (!grant) return
          if (!studioScopesGrant(grant.scopes, STUDIO_TOPICS['files.watch'].scope)) {
            refreshGrant()
            return
          }
          enqueueLive({ t: 'push', sub: id, payload: { names } }, id)
        },
        () => {
          // The folder stopped reporting (removed, or the watcher failed): the
          // client is told, and may follow it again.
          if (state === 'closed' || subscriptions.get(id) !== subscription) return
          subscriptions.delete(id)
          subscriptionFailed(id, 'unavailable', 'Studio stopped watching that folder.', SUBSCRIBE_RETRY_MS)
        },
      )
      .then(
        (watched) => {
          if (!watched.ok) {
            if (subscriptions.get(id) === subscription) {
              subscriptions.delete(id)
              subscriptionFailed(id, watched.code, watched.message)
            }
            return
          }
          if (state === 'closed' || subscriptions.get(id) !== subscription) watched.dispose()
          else subscription.handle = { dispose: () => watched.dispose() }
        },
        () => {
          if (subscriptions.get(id) !== subscription) return
          subscriptions.delete(id)
          subscriptionFailed(id, 'unavailable', 'Studio could not watch that folder.', SUBSCRIBE_RETRY_MS)
        },
      )
  }

  /** What moved in the pull request record, as it moves: the client asks for the lists it shows. */
  function subscribePullRequests(id: string): void {
    const pullRequests = options.pullRequests
    if (!pullRequests) {
      subscriptionFailed(id, 'unavailable', 'This Studio does not serve pullRequests.changed.')
      return
    }
    const subscription: Subscription = { id, topic: 'pullRequests.changed', key: null, replay: null, handle: null }
    subscriptions.set(id, subscription)
    const stop = pullRequests.onChanged((change) => {
      if (state === 'closed' || subscriptions.get(id) !== subscription) return
      const grant = liveGrant()
      if (!grant) return
      if (!studioScopesGrant(grant.scopes, STUDIO_TOPICS['pullRequests.changed'].scope)) {
        refreshGrant()
        return
      }
      enqueueLive({ t: 'push', sub: id, payload: change }, id)
    })
    subscription.handle = { dispose: stop }
  }

  /** What moved among the linked local servers, as it moves: the client asks for the lists it shows. */
  function subscribeLocalServers(id: string): void {
    const localServers = options.localServers
    if (!localServers) {
      subscriptionFailed(id, 'unavailable', 'This Studio does not serve localServers.changed.')
      return
    }
    const subscription: Subscription = { id, topic: 'localServers.changed', key: null, replay: null, handle: null }
    subscriptions.set(id, subscription)
    const stop = localServers.onChanged((change) => {
      if (state === 'closed' || subscriptions.get(id) !== subscription) return
      const grant = liveGrant()
      if (!grant) return
      if (!studioScopesGrant(grant.scopes, STUDIO_TOPICS['localServers.changed'].scope)) {
        refreshGrant()
        return
      }
      enqueueLive({ t: 'push', sub: id, payload: change }, id)
    })
    subscription.handle = { dispose: stop }
  }

  /** The client toolsets this client may see, whole, after each change; a burst of changes is one push. */
  function subscribeCatalog(id: string): void {
    const tools = options.tools
    if (!tools) {
      subscriptionFailed(id, 'unavailable', 'This Studio does not serve tools.catalog.')
      return
    }
    const subscription: Subscription = { id, topic: 'tools.catalog', key: null, replay: null, handle: null }
    subscriptions.set(id, subscription)
    let queued = false
    const stop = tools.subscribe(() => {
      if (queued) return
      queued = true
      setImmediate(() => {
        queued = false
        if (state === 'closed' || subscriptions.get(id) !== subscription) return
        const grant = liveGrant()
        if (!grant) return
        if (!studioScopesGrant(grant.scopes, STUDIO_TOPICS['tools.catalog'].scope)) {
          refreshGrant()
          return
        }
        enqueueLive(
          {
            t: 'push',
            sub: id,
            payload: { toolsets: tools.catalog({ clientId: grant.clientId, owner: grant.owner }) },
          },
          id,
        )
      })
    })
    subscription.handle = { dispose: stop }
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  function request(frame: StudioRequestFrame, grant: StudioGrant): void {
    if (!isStudioMethod(frame.method)) {
      refuseRequest(frame.id, { code: 'unknown_method', message: `No method "${frame.method}".` })
      return
    }
    const method = frame.method
    const mutation = STUDIO_METHODS[method].mutation
    // Bounded per connection: one client cannot queue unbounded reads or
    // turns. Over the bound the request is answered busy, and the connection
    // stays open.
    if (mutation ? commandsInFlight >= maxCommands : readsInFlight >= maxReads) {
      refuseRequest(frame.id, {
        code: 'busy',
        message: 'Too many requests are in flight on this connection.',
        retryAfterMs: BUSY_RETRY_MS,
      })
      return
    }
    if (mutation) commandsInFlight++
    else readsInFlight++
    void router
      .handle(grant, method, frame.params, context)
      .then(
        (answer) => respond(frame.id, answer),
        () => refuseRequest(frame.id, { code: 'unavailable', message: 'Studio could not carry that out.' }),
      )
      .finally(() => {
        if (mutation) commandsInFlight--
        else readsInFlight--
      })
  }

  function hello(value: unknown): void {
    clearTimeout(helloTimer)
    const frame = parseStudioClientFrame(value)
    if (!frame || frame.t !== 'hello') {
      bye('hello_required', 'The first frame must be a hello carrying a token or a pairing code.')
      return
    }
    const version = checkStudioProtocolVersion(frame.protocolVersion, frame.minProtocolVersion ?? frame.protocolVersion)
    if (!version.ok) {
      bye('unsupported_protocol_version', version.message)
      return
    }
    const outcome = authenticator.authenticate(frame.auth, frame.client)
    if (!outcome.ok) {
      options.audit?.({
        clientId: null,
        clientName: frame.client.name,
        tool: 'studio.auth_refused',
        ok: false,
        code: 'unauthorized',
        durationMs: 0,
      })
      bye('unauthorized', outcome.message)
      return
    }
    // One app cannot take every connection the listener allows.
    if (options.admitClient && !options.admitClient(outcome.grant.clientId)) {
      bye('too_many_connections', 'This app has as many connections open as Studio allows one app.', 1_000)
      return
    }
    state = 'open'
    clientId = outcome.grant.clientId
    clientName = outcome.grant.name
    if (outcome.pairingToken) options.audit?.({ clientId, clientName, tool: 'studio.paired', ok: true, durationMs: 0 })
    // Revocation and a narrowed grant reach a connection that is open now,
    // not just its next request.
    releases.push(
      authenticator.onRevoked((revoked) => {
        if (revoked === clientId) bye('revoked', 'This app was revoked in Studio’s Settings.')
      }),
      authenticator.onGrantChanged((changed) => {
        if (changed === clientId) refreshGrant()
      }),
    )
    authenticator.recordSeen?.(clientId)
    enqueueLive({
      t: 'welcome',
      ...options.welcome(),
      grant: outcome.grant,
      ...(outcome.pairingToken ? { pairing: { token: outcome.pairingToken } } : {}),
    })
    // Attached once its welcome is queued, so a call sent to a process that is
    // coming back reaches it after the welcome it waits for.
    if (options.tools && studioScopesGrant(outcome.grant.scopes, 'tools:offer')) {
      options.tools.attach(toolsConnection(outcome.grant, frame.client))
      toolsAttached = true
    }
  }

  /**
   * This connection as the registry holds it. What kind of client it is, and
   * so which of the shell's toolsets it may offer, is read only from an
   * owner's grant, or asserted by the transport for the desktop's own port.
   */
  function toolsConnection(grant: StudioGrant, client: StudioClientInfo): ClientToolConnection {
    const shellPort = options.shell === true
    const kind = shellPort ? 'desktop' : grant.owner ? (client.kind ?? 'app') : 'app'
    const shell: ClientToolConnection['shell'] = shellPort
      ? 'all'
      : !grant.owner
        ? null
        : kind === 'desktop'
          ? 'all'
          : kind === 'headless'
            ? ['browser', 'canvas']
            : kind === 'web'
              ? ['canvas']
              : null
    return {
      connectionId: options.connectionId,
      clientId: grant.clientId,
      clientName: grant.owner && client.name ? client.name : grant.name,
      kind,
      // A client that names no process run gets one of its own per
      // connection: nothing is redelivered to it after a drop.
      instanceId: client.instanceId ?? `connection-${options.connectionId}-${randomBytes(6).toString('hex')}`,
      owner: grant.owner,
      shell,
      audited: !shellPort,
      send: (toolFrame) => enqueueLive(toolFrame),
    }
  }

  /** The grant as it is now, or null after closing for a revoked client. */
  function liveGrant(): StudioGrant | null {
    const grant = clientId ? authenticator.grantFor(clientId) : null
    if (!grant) bye('revoked', 'This app was revoked in Studio’s Settings.')
    return grant
  }

  function refreshGrant(): void {
    const grant = liveGrant()
    if (!grant) return
    for (const subscription of [...subscriptions.values()]) {
      const scope = STUDIO_TOPICS[subscription.topic].scope
      if (studioScopesGrant(grant.scopes, scope)) continue
      dropSubscription(subscription)
      subscriptionFailed(subscription.id, 'scope_required', `This app's grant no longer includes "${scope}".`)
    }
  }

  function handleLine(line: string): void {
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      bye('invalid_frame', 'A frame was not JSON.')
      return
    }
    if (state === 'hello') {
      hello(value)
      return
    }
    const frame = parseStudioClientFrame(value)
    if (!frame) {
      // An answer to a call is never answered back: one Studio cannot read is
      // dropped. A reply that still names its call settles it `invalid_result`,
      // so the agent is not left to the call's deadline.
      const type = (value as { t?: unknown } | null)?.t
      if ((type === 'reply' || type === 'progress') && toolsAttached) {
        options.log?.(`Studio RPC dropped a ${type} it could not read from ${clientName || 'a client'}.`)
        const callId = (value as { id?: unknown }).id
        if (type === 'reply' && typeof callId === 'string' && callId.length > 0 && callId.length <= 200)
          options.tools?.unreadableReply(options.connectionId, callId)
        return
      }
      const ids = studioClientFrameIds(value)
      const message = 'That frame is not in the documented shape.'
      if (ids.requestId) refuseRequest(ids.requestId, { code: 'invalid_frame', message })
      else if (ids.subscriptionId) subscriptionFailed(ids.subscriptionId, 'invalid_frame', message)
      else bye('invalid_frame', message)
      return
    }
    if (frame.t === 'hello') {
      bye('invalid_frame', 'This connection has already said hello.')
      return
    }
    const grant = liveGrant()
    if (!grant) return
    if (frame.t === 'reply' || frame.t === 'progress') {
      if (!toolsAttached || !options.tools?.mayAnswer(options.connectionId)) {
        bye('invalid_frame', 'This connection was never sent a call to answer.')
        return
      }
      if (frame.t === 'reply') options.tools.reply(options.connectionId, frame)
      else options.tools.progress(options.connectionId, frame)
      return
    }
    if (frame.t === 'req') request(frame, grant)
    else if (frame.t === 'sub') subscribe(frame, grant)
    else {
      const subscription = subscriptions.get(frame.id)
      if (subscription) dropSubscription(subscription)
    }
  }

  /** A line over the cap, refused under the id at its start: a client puts ids ahead of a long message. */
  function refuseOversized(prefix: string): void {
    const field = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,200})"`).exec(prefix)?.[1]
    const message = `A frame may be at most ${STUDIO_MAX_CLIENT_FRAME_BYTES} bytes.`
    const id = field('id')
    const type = field('t')
    if (state === 'open' && id && type === 'req') refuseRequest(id, { code: 'too_large', message })
    else if (state === 'open' && id && type === 'sub') subscriptionFailed(id, 'too_large', message)
    else bye('invalid_frame', message)
  }

  let parts: Buffer[] = []
  let size = 0
  let skipping: { prefix: string; skipped: number } | null = null
  socket.on('data', (chunk: Buffer | string) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let start = 0
    while (state !== 'closed' && start <= data.length) {
      const newline = data.indexOf(0x0a, start)
      const piece = data.subarray(start, newline === -1 ? data.length : newline)
      const limit = state === 'hello' ? MAX_HELLO_BYTES : STUDIO_MAX_CLIENT_FRAME_BYTES
      if (skipping) {
        skipping.skipped += piece.length
        if (skipping.skipped > MAX_SKIPPED_CLIENT_FRAME_BYTES) {
          bye('invalid_frame', 'A frame far over the size limit is not a Studio client’s.')
          return
        }
      } else if (size + piece.length > limit) {
        if (state === 'hello') {
          bye('hello_required', 'The first frame must be a hello.')
          return
        }
        skipping = {
          prefix: Buffer.concat([...parts, piece])
            .subarray(0, 4096)
            .toString('utf8'),
          skipped: size + piece.length,
        }
        parts = []
        size = 0
      } else if (piece.length) {
        parts.push(piece)
        size += piece.length
      }
      if (newline === -1) return
      if (skipping) {
        const { prefix } = skipping
        skipping = null
        refuseOversized(prefix)
      } else {
        const line = Buffer.concat(parts).toString('utf8')
        parts = []
        size = 0
        // A fault handling one frame must not reach the event loop of the app
        // this runs inside: the client is told, and resumes on a new connection.
        try {
          handleLine(line)
        } catch (error) {
          options.log?.(`Studio RPC frame failed: ${error instanceof Error ? error.message : String(error)}`)
          bye('internal_error', 'Studio could not handle that frame. Reconnect and resume.', 1_000)
          return
        }
      }
      start = newline + 1
    }
  })
  socket.on('end', () => shutdown())
  socket.on('close', () => shutdown())
  socket.on('error', () => shutdown())

  helloTimer = setTimeout(() => {
    // With a delay: a hello that came too late is a slow machine, not a
    // client that will never say one, and a client may connect again.
    if (state === 'hello') bye('hello_required', 'No hello arrived in time.', 1_000)
  }, options.helloTimeoutMs ?? STUDIO_HELLO_TIMEOUT_MS)
  helloTimer.unref?.()

  return connection
}
