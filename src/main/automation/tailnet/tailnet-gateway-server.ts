import { randomBytes, randomUUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { pipeline } from 'stream/promises'

import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../../shared/mcp/protocol'
import { STUDIO_MCP_SERVER_NAME } from '../../../shared/product-identity'
import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
} from '../../../shared/modules/mcp-tools'
import {
  createMcpDispatcher,
  type McpClientToolHooks,
  type McpToolCallEvent,
  declaredProtocolVersion,
  isRecord,
  jsonRpcErrorResponse,
  jsonRpcIdOf,
  unsupportedProtocolVersionMessage,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  type McpDispatchGate,
} from '../mcp-dispatch'
import { isAllowedTailnetBindAddress } from './tailnet-interface'
import {
  TAILNET_CAPABILITIES,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_EVENTS_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_CONVERSATION_PATH,
  TAILNET_CONVERSATION_IMAGE_PATH,
  TAILNET_TRANSPORT_VERSION,
  TAILNET_UPLOAD_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import { openConversationImage } from './tailnet-conversation-images'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_DOWNSCALED_UPLOAD_BYTES,
} from '../../../shared/conversation-attachments'
import type { ConversationImageDownscaler } from '../../conversation-image-downscale'
import { imageWithinDecodeLimits } from '../../../shared/image-dimensions'
import { MAX_TAILNET_FILE_BYTES, type TailnetFileUploads } from './tailnet-file-uploads'
import {
  createResyncBackoff,
  createTailnetConversationStream,
  type TailnetConversationStream,
} from './tailnet-conversation-stream'
import type { ConversationGatewayHost } from './tailnet-conversation-host'
import type { TailnetCollectOutcome, TailnetDeviceStore, TailnetPeerCheck } from './tailnet-devices'
import type { TailnetPeerResolver } from './tailnet-peer-identity'
import { TAILNET_PEER_REFUSED_AUDIT_TOOL } from '../gateway-audit'
import { normalizeAddress } from './tailnet-peer-identity'
import { parseTailnetEndpoint } from './tailnet-remote-client'
import { normalizeTailnetScopes, type TailnetReverseGrant } from '../../../shared/tailnet'
import { tailnetScopeGrantsAccess, type TailnetDevice, type TailnetScope } from '../../../shared/tailnet'
import { localOnlyGatewayToolReason, requiredScopeForTool } from './tailnet-scopes'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  enableTcpKeepAlive,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_GOING_AWAY,
  WEBSOCKET_CLOSE_REVOKED,
} from './websocket-frames'

// The opt-in tailnet listener: the same ~60-tool gateway surface the local
// socket serves, reachable from another machine on the tailnet.
//
// This reverses the gateway's original loopback-only decision for the remote case only, and does so
// under the epic's constraints: bound to the Tailscale interface address and
// nothing else, off unless a person enabled it, every request carrying a device
// token the desktop minted, every remote mutation audited with the device and
// the Tailscale peer it came from. The Unix socket is untouched — local clients
// keep using it, with filesystem permissions still their whole auth model.
//
// A device token is also held to the tailnet node it was paired from: every
// authenticated route and every WebSocket upgrade goes through `admitPeer`,
// which asks whois who is calling and refuses a token presented from any other
// node. The threat model is on `verifyPeer` in `tailnet-devices.ts`.
//
// The transport is deliberately NOT spec Streamable HTTP. It is a small,
// explicit surface: one JSON-in/JSON-out MCP endpoint, plus WebSockets for
// clients that need a persistent channel — the RPC stream (tool-list
// notifications, connection-scoped identity), the change feed, and the
// conversation socket. No SSE, no session resumption — those are
// advertised nowhere, so nothing can quietly depend on a half version.

export {
  TAILNET_HEALTH_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_WS_TICKET_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_CONVERSATION_PATH,
  // The wire's own version and feature list live beside the paths; re-exported
  // here so a caller that already imports the server keeps one import.
  TAILNET_CAPABILITIES,
  TAILNET_TRANSPORT_VERSION,
} from './tailnet-routes'

/** The advisory connection-metadata declaration; only the stateful WebSocket can hold it. */
const CONNECT_METHOD = 'sprintengine.studio/connect'

const MAX_MCP_BODY_BYTES = 1024 * 1024
const MAX_CONTROL_BODY_BYTES = 64 * 1024
/** Long enough to open a socket, short enough that a leaked URL is worthless. */
const WS_TICKET_TTL_MS = 30_000

export type TailnetGatewayServerOptions = {
  bindAddress: string
  /** 0 binds an ephemeral port; only tests use it, since a discoverable listener needs a fixed one. */
  port: number
  serverName: string
  serverVersion: string
  /** The tools a connection may see, per request: client tools differ by connection. */
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[]
  /** Client tools: a stream is told alone when its list grows. */
  clientTools?: McpClientToolHooks & { track(context: McpConnectionContext, notify: () => void): () => void }
  /** The gateway's own mutation classification, so scopes cannot drift from the audit's. */
  isMutation: (toolName: string) => boolean
  devices: TailnetDeviceStore
  peers: TailnetPeerResolver
  conversations?: ConversationGatewayHost
  /**
   * Where a file a device sends with a message is kept (`upload?kind=file`):
   * Studio's own store, never a project's folder. Without it this build
   * refuses a file upload as unavailable; pictures are unaffected.
   */
  fileUploads?: TailnetFileUploads
  /**
   * Shrinks a picture a device uploaded to the size the model takes, by the
   * composer's rules (src/main/conversation-image-downscale.ts), before it is
   * kept. Given, an upload may be up to MAX_DOWNSCALED_UPLOAD_BYTES and this
   * machine advertises `conversation-image-downscale`; what is kept is still
   * held to MAX_ATTACHMENT_BYTES. Absent (a server with no image codec), an
   * upload is kept as it came, under MAX_ATTACHMENT_BYTES.
   */
  downscaleUpload?: ConversationImageDownscaler
  /**
   * Fired when a peer asks to pair, so the surfaces that answer these
   * can refresh without polling. It carries no detail: a listener's job is to
   * go and read the requests, not to be told about one it has not authorised.
   */
  onPairRequested?: () => void
  /**
   * An approved asker's collect carried the reverse half of a both-ways
   * pairing (phase 6): a device the asker minted for THIS machine on its own
   * listener. Only fired for a grant whose endpoint is the asker's own
   * transport-proven address — a body cannot point this machine's credential
   * store at a third party — and only on the collect that took our token,
   * so it rides on an approval a person here already gave.
   */
  onReverseGrant?: (input: { grant: TailnetReverseGrant; askerName: string; peerNode: string | null }) => void
  /**
   * Device activity, for the live-state push (remote-sessions-ux): a device's
   * RPC stream opening or closing — fired exactly once per transition, so the
   * service above derives "connected" without holding a socket reference of
   * its own — and every
   * authenticated HTTP call (`request`), which is activity on a device that
   * may hold no socket at all. Opens and requests carry the peer as the
   * transport saw it, resolved at the same point `recordSeen` is.
   */
  onActivity?: (event: TailnetGatewayActivity) => void
  onToolCall?: (event: McpToolCallEvent) => void
  now?: () => number
  log?: (message: string) => void
  /** The change feed's per-kind push floor; tests shorten it. */
  changePushIntervalMs?: number
}

type TailnetGatewayPeer = { peerNode: string | null; peerAddress: string }

export type TailnetGatewayActivity =
  | ({ kind: 'stream'; device: TailnetDevice; open: true } & TailnetGatewayPeer)
  | { kind: 'stream'; device: TailnetDevice; open: false }
  | ({ kind: 'request'; device: TailnetDevice } & TailnetGatewayPeer)

export type TailnetGatewayServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** The address actually bound, or null while stopped. */
  address(): { address: string; port: number } | null
  notifyToolsListChanged(): void
  /**
   * Tell every device on the change feed that this machine's workspace list
   * changed. Throttled here, so a burst is one push; the device re-reads
   * through workspace.list.
   */
  notifyWorkspacesChanged(): void
  /**
   * The conversation list changed: one started, ended, or moved phase (a turn
   * began, finished, or waits on a person). A device re-reads through the
   * conversation socket's `list`, which its own grant governs.
   */
  notifyConversationsChanged(): void
  /** Live WebSocket streams, by device — diagnostics and tests. */
  streamCount(): number
  /** Live change-feed sockets — diagnostics and tests. */
  eventStreamCount(): number
}

type StreamSession = {
  socket: Duplex
  deviceId: string
  /** The device as authenticated at upgrade, for the close announcement. */
  device: TailnetDevice
  context: McpConnectionContext
  /** Ends the stream's place among the connections client tools tell about a longer list. */
  untrack?: () => void
}

type EventStream = { socket: Duplex; deviceId: string }

type ChangeKind = 'workspaces' | 'conversations'

/**
 * The floor between two pushes of one kind. A second is what stops a busy
 * conversation turning into a re-read per event on every paired machine.
 */
const TAILNET_CHANGE_PUSH_INTERVAL_MS = 1_000

export function createTailnetGatewayServer(options: TailnetGatewayServerOptions): TailnetGatewayServer {
  // What this machine says it can do: every capability, but shrinking an
  // upload where nothing here can.
  const capabilities: readonly string[] = options.downscaleUpload
    ? TAILNET_CAPABILITIES
    : TAILNET_CAPABILITIES.filter((capability) => capability !== 'conversation-image-downscale')
  // The most an upload may be as it arrives.
  const uploadCeiling = options.downscaleUpload ? MAX_DOWNSCALED_UPLOAD_BYTES : MAX_ATTACHMENT_BYTES
  const now = options.now ?? (() => Date.now())
  let server: Server | null = null
  let unsubscribeRevocations: (() => void) | null = null
  const streams = new Set<StreamSession>()
  const conversationStreams = new Set<TailnetConversationStream>()
  // Conversation images are opaque, short-lived inputs, not workspace files.
  // Stage them under a process-owned private directory so workspace symlinks
  // cannot redirect a remote upload into another part of the filesystem.
  let conversationUploadDirectory: Promise<string> | null = null
  // Per device, so a phone that keeps falling behind is told to wait longer
  // each time instead of reconnecting straight into the same backlog.
  const conversationResyncDelay = createResyncBackoff(now)
  const eventStreams = new Set<EventStream>()
  const tickets = new Map<string, { deviceId: string; expiresAtMs: number }>()

  // ── The change feed ───────────────────────────────────────────────────────
  // A revision per kind, so a watcher that reconnects can see it missed
  // something and re-read; a throttle per kind, so a burst is one push.
  const changePushIntervalMs = Math.max(0, options.changePushIntervalMs ?? TAILNET_CHANGE_PUSH_INTERVAL_MS)
  const changeRevisions: Record<ChangeKind, number> = { workspaces: 0, conversations: 0 }
  const changePush: Record<ChangeKind, { lastSentAt: number; timer: ReturnType<typeof setTimeout> | null }> = {
    workspaces: { lastSentAt: Number.NEGATIVE_INFINITY, timer: null },
    conversations: { lastSentAt: Number.NEGATIVE_INFINITY, timer: null },
  }

  function notifyChanged(what: ChangeKind): void {
    changeRevisions[what] += 1
    // Nobody is watching: the revision is all a later watcher needs, since
    // its `hello` carries it. Arming a timer here would wake this machine on
    // every turn of every chat for a push with no one to receive it.
    if (eventStreams.size === 0) return
    const state = changePush[what]
    // A push already queued carries this revision too.
    if (state.timer) return
    const elapsed = now() - state.lastSentAt
    if (elapsed >= changePushIntervalMs) {
      pushChanged(what)
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      pushChanged(what)
    }, changePushIntervalMs - elapsed)
    state.timer.unref?.()
  }

  function pushChanged(what: ChangeKind): void {
    changePush[what].lastSentAt = now()
    if (eventStreams.size === 0) return
    const payload = encodeTextFrame(JSON.stringify({ type: 'changed', what, revision: changeRevisions[what] }))
    for (const stream of eventStreams) {
      if (!stream.socket.destroyed) stream.socket.write(payload)
    }
  }

  function openEventStream(socket: Duplex, device: TailnetDevice, head: Buffer): void {
    const stream: EventStream = { socket, deviceId: device.id }
    eventStreams.add(stream)
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)
    const drop = (): void => {
      eventStreams.delete(stream)
    }
    const consume = (chunk: Buffer): void => {
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') {
        closeEventStream(stream, decoded.code, decoded.reason)
        return
      }
      for (const frame of decoded.frames) {
        if (frame.kind === 'close') {
          closeEventStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, '')
          return
        }
        if (frame.kind === 'ping' && !socket.destroyed) socket.write(encodePongFrame(frame.payload))
        // Text frames are ignored: this channel speaks server → client only.
      }
    }
    // Where things stand, at once: a watcher that reconnected after a change
    // it missed compares revisions and re-reads without waiting for the next.
    socket.write(
      encodeTextFrame(
        JSON.stringify({
          type: 'hello',
          revisions: { ...changeRevisions },
        }),
      ),
    )
    if (head?.length) consume(head)
    socket.on('data', consume)
    socket.on('end', () => {
      drop()
      socket.destroy()
    })
    socket.on('close', drop)
    socket.on('error', () => {
      drop()
      socket.destroy()
    })
  }

  function closeEventStream(stream: EventStream, code: number, reason: string): void {
    eventStreams.delete(stream)
    if (stream.socket.destroyed) return
    try {
      stream.socket.write(encodeCloseFrame(code, reason))
    } catch {
      // The peer is already gone; ending below is the whole cleanup.
    }
    stream.socket.end()
  }

  const dispatcher = createMcpDispatcher({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    resolveTools: options.resolveTools,
    ...(options.clientTools ? { clientTools: options.clientTools } : {}),
    onToolCall: options.onToolCall,
  })

  async function start(): Promise<void> {
    if (server) return
    // The bind guard is the epic's hard rule and it runs BEFORE listen(), so a
    // misconfigured address can never produce even a momentarily-open port.
    if (!isAllowedTailnetBindAddress(options.bindAddress)) {
      throw new Error(
        `Refusing to bind the tailnet gateway to ${options.bindAddress || '(empty)'}: only a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48) or loopback is allowed.`,
      )
    }
    const next = createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        options.log?.(`tailnet gateway request failed: ${message(error)}`)
        writeJson(response, 500, { error: { code: 'internal_error', message: 'The request could not be completed.' } })
      })
    })
    next.on('upgrade', (request, socket, head) => {
      void handleUpgrade(request, socket, head).catch((error) => {
        options.log?.(`tailnet gateway upgrade failed: ${message(error)}`)
        rejectUpgrade(socket, 500, 'internal_error')
      })
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        next.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        next.removeListener('error', onError)
        resolve()
      }
      next.once('error', onError)
      next.once('listening', onListening)
      next.listen(options.port, options.bindAddress)
    })
    next.on('error', (error) => options.log?.(`tailnet gateway server error: ${error.message}`))
    // Revocation must reach a device that is already mid-stream, not just its
    // next request: a live WebSocket would otherwise keep serving a device the
    // user just removed.
    // The files a removed device sent go with it, as a removed browser's do.
    const unsubscribeRevoked = options.devices.onDeviceRevoked((deviceId) => {
      closeStreamsFor(deviceId)
      try {
        options.fileUploads?.forgetDevice(deviceId)
      } catch (error) {
        options.log?.(`tailnet uploads of a removed device were not removed: ${message(error)}`)
      }
    })
    // A narrowed grant reaches an open conversation socket the same way: it
    // re-reads the device and closes, or stops accepting commands. The RPC
    // stream needs no push: it re-reads the device on every message it answers.
    const unsubscribeScopes = options.devices.onDeviceScopesChanged((device) => {
      for (const conversation of [...conversationStreams])
        if (conversation.deviceId === device.id) conversation.refreshScopes()
    })
    unsubscribeRevocations = () => {
      unsubscribeRevoked()
      unsubscribeScopes()
    }
    server = next
  }

  async function stop(): Promise<void> {
    const current = server
    if (!current) return
    server = null
    unsubscribeRevocations?.()
    unsubscribeRevocations = null
    tickets.clear()
    for (const stream of [...streams]) {
      // Send the close frame, then destroy rather than waiting for the peer's
      // reply: a client that never answers must not be able to hang shutdown.
      closeStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
      stream.socket.destroy()
    }
    streams.clear()
    for (const conversation of [...conversationStreams])
      conversation.close(WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
    conversationStreams.clear()
    for (const state of Object.values(changePush)) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
    }
    for (const stream of [...eventStreams]) {
      closeEventStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
      stream.socket.destroy()
    }
    eventStreams.clear()
    await new Promise<void>((resolve) => current.close(() => resolve()))
    if (conversationUploadDirectory) {
      const directory = await conversationUploadDirectory.catch(() => null)
      conversationUploadDirectory = null
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * One image from a paired device, for a conversation it may operate.
   *
   * The file lands in a private staging directory, never in the workspace, and
   * the answer is an opaque id rather than a path: only the device that
   * uploaded it can spend that id, and only on a send to the same
   * conversation. `kind=conversation` is still read off older phones' requests
   * and still means the only thing it can.
   *
   * Streamed to disk with the ceiling enforced as the bytes arrive, so an
   * oversized upload is cut off mid-flight rather than buffered to discover
   * its size — and the part-written file is removed.
   *
   * `kind=file` is a file of any type instead (`conversation-message-files`),
   * up to 25 MB, kept in Studio's own store rather than staged: the send that
   * spends its id attaches it by path, and the agent reads it there.
   */
  async function handleUpload(
    request: IncomingMessage,
    response: ServerResponse,
    device: TailnetDevice,
    url: URL,
  ): Promise<void> {
    if (!tailnetScopeGrantsAccess(new Set(device.scopes), 'conversation:operate')) {
      writeJson(response, 403, {
        error: {
          code: 'tailnet_scope_required',
          message: 'This device may read conversations but not attach files to them.',
        },
      })
      return
    }
    const conversations = options.conversations
    if (!conversations) {
      writeJson(response, 501, {
        error: { code: 'upload_unavailable', message: 'This build cannot receive uploads for this session.' },
      })
      return
    }
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
    const name = url.searchParams.get('name')?.trim() ?? ''
    if (!sessionId || !name) {
      writeJson(response, 400, {
        error: { code: 'invalid_arguments', message: 'An upload needs a sessionId and a name.' },
      })
      return
    }
    const conversation = (await conversations.list()).find((candidate) => candidate.sessionId === sessionId)
    if (!conversation || !conversations.resolveKey(conversation.workspaceId, conversation.agentId)) {
      writeJson(response, 404, {
        error: { code: 'unknown_conversation', message: 'No eligible conversation on this machine has that id.' },
      })
      return
    }
    const mediaType = (headerOf(request, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (url.searchParams.get('kind') === 'file') {
      await receiveFile(request, response, device, { sessionId, name, mediaType })
      return
    }
    if (!ATTACHABLE_IMAGE_TYPES.includes(mediaType as (typeof ATTACHABLE_IMAGE_TYPES)[number])) {
      writeJson(response, 415, {
        error: { code: 'invalid_media_type', message: 'Only PNG, JPEG, WebP and GIF images can be attached.' },
      })
      return
    }
    if (conversation.capabilities?.images !== true) {
      writeJson(response, 409, {
        error: { code: 'images_unsupported', message: 'This conversation cannot accept images.' },
      })
      return
    }
    // A declared length over the cap is refused before a byte is read.
    const declared = Number(request.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > uploadCeiling) {
      // Drained before the answer, not after: see `drainRefusedBody`.
      if (await drainRefusedBody(request, uploadCeiling)) writeTooLarge(response, uploadCeiling)
      return
    }
    try {
      // Created once and shared, but a failed creation is not remembered: the
      // next upload tries again instead of every upload failing until the app
      // restarts.
      if (!conversationUploadDirectory) {
        const creating = mkdtemp(join(tmpdir(), 'studio-conversation-images-'))
        conversationUploadDirectory = creating
        creating.catch(() => {
          if (conversationUploadDirectory === creating) conversationUploadDirectory = null
        })
      }
      const uploadPath = join(await conversationUploadDirectory, randomUUID())
      const written = await streamUploadToDisk(request, uploadPath, uploadCeiling)
      // Measured before anything decodes it: a small file can declare a picture
      // of billions of pixels, and every view of the chat would decode it.
      if (!imageWithinDecodeLimits(await readFile(uploadPath))) {
        await rm(uploadPath, { force: true }).catch(() => {})
        writeJson(response, 413, {
          error: {
            code: 'image_too_large',
            message: 'That picture is too large to open: over 16384 pixels a side, or 100 megapixels.',
          },
        })
        return
      }
      // Sized for the model here, on receipt, as the composer sizes what it
      // stages: a phone's photo is several thousand pixels a side, and Claude
      // refuses one over 2000 once a thread holds more than 20 images.
      const kept = options.downscaleUpload
        ? await shrinkUpload(uploadPath, written, mediaType, options.downscaleUpload)
        : { bytes: written, mediaType }
      if (kept.bytes > MAX_ATTACHMENT_BYTES) {
        await rm(uploadPath, { force: true }).catch(() => {})
        writeJson(response, 413, {
          error: {
            code: 'too_large',
            message: `That picture is still over the ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit after resizing.`,
          },
        })
        return
      }
      const uploadId = conversations.registerUpload?.({
        deviceId: device.id,
        sessionId,
        path: uploadPath,
        name,
        mediaType: kept.mediaType,
        bytes: kept.bytes,
        dispose: () => {
          void rm(uploadPath, { force: true }).catch(() => {})
        },
      })
      if (!uploadId) {
        await rm(uploadPath, { force: true }).catch(() => {})
        writeJson(response, 503, { error: { code: 'upload_unavailable' } })
        return
      }
      writeJson(response, 200, { uploadId, bytes: written })
    } catch (error) {
      if (error instanceof UploadTooLarge) {
        // Drained before the answer, not after: see `drainRefusedBody`.
        if (await drainRefusedBody(request, uploadCeiling)) writeTooLarge(response, uploadCeiling)
        return
      }
      options.log?.(`tailnet upload failed: ${message(error)}`)
      // A staging directory removed underneath the app (a temp cleaner) is
      // made again on the next upload.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') conversationUploadDirectory = null
      writeJson(response, 500, { error: { code: 'internal_error', message: 'The file could not be written.' } })
    }
  }

  /**
   * One file of any type for a chat's next message, written where Studio keeps
   * a device's files (tailnet-file-uploads.ts) under its own name made safe,
   * and answered with an id only this device can spend on this chat, as a
   * picture's is. The scope and the chat were checked by the caller. The type
   * the device declared is recorded, never trusted to mean anything: no
   * provider is handed these bytes, only their path.
   */
  async function receiveFile(
    request: IncomingMessage,
    response: ServerResponse,
    device: TailnetDevice,
    input: { sessionId: string; name: string; mediaType: string },
  ): Promise<void> {
    const conversations = options.conversations
    const store = options.fileUploads
    if (!conversations?.registerUpload || !store) {
      writeJson(response, 501, {
        error: { code: 'upload_unavailable', message: 'This build cannot receive files for a chat.' },
      })
      return
    }
    const declared = Number(request.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > MAX_TAILNET_FILE_BYTES) {
      if (await drainRefusedBody(request, MAX_TAILNET_FILE_BYTES)) writeTooLarge(response, MAX_TAILNET_FILE_BYTES)
      return
    }
    let place: ReturnType<TailnetFileUploads['place']> | null = null
    try {
      place = store.place(device.id, input.name)
      const written = await streamUploadToDisk(request, place.path, MAX_TAILNET_FILE_BYTES)
      const kept = place
      const uploadId = conversations.registerUpload({
        deviceId: device.id,
        sessionId: input.sessionId,
        path: kept.path,
        name: kept.name,
        mediaType: MEDIA_TYPE_SHAPE.test(input.mediaType) ? input.mediaType : 'application/octet-stream',
        bytes: written,
        kind: 'file',
        dispose: () => {
          try {
            kept.remove()
          } catch {
            // Pruned with the week's others instead.
          }
        },
      })
      writeJson(response, 200, { uploadId, bytes: written, name: kept.name })
    } catch (error) {
      try {
        place?.remove()
      } catch {
        // Pruned with the week's others instead.
      }
      if (error instanceof UploadTooLarge) {
        if (await drainRefusedBody(request, MAX_TAILNET_FILE_BYTES)) writeTooLarge(response, MAX_TAILNET_FILE_BYTES)
        return
      }
      options.log?.(`tailnet file upload failed: ${message(error)}`)
      writeJson(response, 500, { error: { code: 'internal_error', message: 'The file could not be written.' } })
    }
  }

  /**
   * The picture one step of a chat made or looked at, streamed as it is on disk.
   *
   * The device names the chat and the step; the conversation's record of that
   * step names the file. A `path` in the query is never read. The bytes are
   * served under the type their first bytes say, and cached privately for a
   * day: a step's picture never changes, and a phone scrolling back through a
   * chat should not fetch it twice.
   *
   * `attachment` in place of `toolUseId` names a picture the person sent with
   * a message instead (`conversation-message-images`), by the ref its
   * `user_message` recorded, and is served the same way.
   */
  async function handleConversationImage(response: ServerResponse, device: TailnetDevice, url: URL): Promise<void> {
    if (!tailnetScopeGrantsAccess(new Set(device.scopes), 'conversation:read')) {
      writeJson(response, 403, {
        error: { code: 'tailnet_scope_required', message: 'This device may not read conversations on this machine.' },
      })
      return
    }
    const conversations = options.conversations
    const workspaceId = url.searchParams.get('workspaceId')?.trim() ?? ''
    const agentId = url.searchParams.get('agentId')?.trim() ?? ''
    const toolUseId = url.searchParams.get('toolUseId')?.trim() ?? ''
    const attachment = url.searchParams.get('attachment')?.trim() ?? ''
    if (!workspaceId || !agentId || !toolUseId === !attachment) {
      writeJson(response, 400, {
        error: {
          code: 'invalid_arguments',
          message: 'A picture is named by workspaceId, agentId and one of toolUseId or attachment.',
        },
      })
      return
    }
    const key = conversations?.resolveKey(workspaceId, agentId) ?? null
    if (attachment) {
      await serveSentImage(response, key, attachment)
      return
    }
    const found = key && conversations?.toolImagePath ? await conversations.toolImagePath(key, toolUseId) : null
    if (!found || (!found.ok && found.code === 'unknown_conversation')) {
      writeJson(response, 404, {
        error: { code: 'unknown_conversation', message: 'No eligible conversation on this machine has that id.' },
      })
      return
    }
    if (!found.ok) {
      writeJson(response, 404, {
        error: { code: 'unknown_image', message: 'That step of the conversation shows no picture.' },
      })
      return
    }
    const opened = await openConversationImage(found.path)
    if (!opened.ok) {
      writeJson(response, opened.refusal.status, {
        error: { code: opened.refusal.code, message: opened.refusal.message },
      })
      return
    }
    const { file, size, mediaType } = opened.image
    if (response.headersSent || response.writableEnded) {
      await file.close().catch(() => undefined)
      return
    }
    response.writeHead(200, {
      'Content-Type': mediaType,
      'Content-Length': size,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    })
    // Never empty: an empty file has no first bytes to be a picture by.
    // Bounded to the size the headers promised: a file that grows while it is
    // read is not allowed to overrun its own Content-Length.
    const source = file.createReadStream({ start: 0, end: size - 1, autoClose: true })
    try {
      await pipeline(source, response)
    } catch (error) {
      // The client went away, or the file did. The status line is already
      // sent, so the only honest thing left is to cut the connection.
      options.log?.(`tailnet conversation image failed: ${message(error)}`)
      response.destroy()
    }
  }

  /** A picture sent with one of a chat's messages, read whole from the attachment store (at most 5 MB). */
  async function serveSentImage(
    response: ServerResponse,
    key: ReturnType<ConversationGatewayHost['resolveKey']>,
    ref: string,
  ): Promise<void> {
    const conversations = options.conversations
    const found = key && conversations?.sentImage ? await conversations.sentImage(key, ref) : null
    if (!found || (!found.ok && found.code === 'unknown_conversation')) {
      writeJson(response, 404, {
        error: { code: 'unknown_conversation', message: 'No eligible conversation on this machine has that id.' },
      })
      return
    }
    if (!found.ok) {
      writeJson(response, 404, {
        error: { code: 'unknown_image', message: 'That picture is not one this conversation was sent.' },
      })
      return
    }
    if (response.headersSent || response.writableEnded) return
    response.writeHead(200, {
      'Content-Type': found.mediaType,
      'Content-Length': found.bytes.length,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(found.bytes)
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Any `Origin` means a browser made this request. No client of this
    // transport is a browser, and a page on a tailnet machine must not be able
    // to drive the gateway through a user's browser (DNS-rebinding class).
    // Refusing outright is the honest rule; there is no origin to allow.
    if (request.headers.origin) {
      writeJson(response, 403, {
        error: {
          code: 'origin_not_allowed',
          message: 'Browser-originated requests are not accepted on this transport.',
        },
      })
      return
    }
    const path = pathOf(request.url)
    const method = request.method ?? 'GET'

    if (method === 'GET' && path === TAILNET_HEALTH_PATH) {
      // Unauthenticated on purpose: peer discovery probes it to learn
      // that a machine speaks this transport. It therefore says only what a
      // prospective client must know to talk, and nothing about this machine,
      // its user, its workspaces, or whether any device is paired.
      writeJson(response, 200, {
        product: STUDIO_MCP_SERVER_NAME,
        transportVersion: TAILNET_TRANSPORT_VERSION,
        capabilities: [...capabilities],
        protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      })
      return
    }

    if (method === 'POST' && path === TAILNET_PAIR_PATH) {
      const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
      if (body === undefined) return
      const outcome = options.devices.redeemPairing({
        token: isRecord(body) ? body.pairingToken : undefined,
        deviceName: isRecord(body) ? body.deviceName : undefined,
        // The node redeeming the code is the one the new token is bound to.
        peer: await options.peers.identify(normalizeAddress(request.socket.remoteAddress)),
      })
      if (!outcome.ok) {
        // 401 for a bad or missing credential, 400 for a malformed request:
        // a client must be able to tell "wrong code" from "you forgot a field".
        const status = outcome.code === 'invalid_device_name' ? 400 : 401
        writeJson(response, status, { error: { code: outcome.code, message: outcome.message } })
        return
      }
      writeJson(response, 200, {
        deviceId: outcome.device.id,
        deviceName: outcome.device.name,
        deviceToken: outcome.deviceToken,
        scopes: outcome.device.scopes,
        // What it just paired with, in the exchange it already made: a client
        // learns the wire it is on without a second call to health.
        transportVersion: TAILNET_TRANSPORT_VERSION,
        capabilities: [...capabilities],
      })
      return
    }

    if (path === TAILNET_PAIR_REQUEST_PATH && (method === 'POST' || method === 'GET')) {
      await handlePairRequest(request, response, method)
      return
    }
    if (path === TAILNET_PAIR_COLLECT_PATH && method === 'POST') {
      await handlePairCollect(request, response)
      return
    }

    const device = authenticate(request)
    if (!device) {
      writeUnauthorized(response)
      return
    }
    // Every route below — identity, upload, conversation-image, ws-ticket and
    // the MCP endpoint — is behind this one check, so none can skip it.
    const admitted = await admitPeer(device, request.socket.remoteAddress, path)
    if (!admitted.ok) {
      writePeerRefused(response, admitted)
      return
    }
    const { peerNode, peerAddress } = admitted
    options.devices.recordSeen(device.id, peerNode)
    options.onActivity?.({ kind: 'request', device, peerNode, peerAddress })

    if (method === 'GET' && path === TAILNET_IDENTITY_PATH) {
      // How the device should draw this desktop: the kind and colour the
      // person chose, else the defaults another desktop gives it. Absent from
      // a desktop built before it was sent, and from one with no conversation
      // lane; a device draws its own default then.
      let machine: { kind: string; color: string } | null = null
      try {
        machine = options.conversations?.machine?.() ?? null
      } catch {
        machine = null
      }
      writeJson(response, 200, {
        ...(machine ? { machine } : {}),
        deviceId: device.id,
        deviceName: device.name,
        scopes: device.scopes,
        serverInfo: { name: options.serverName, version: options.serverVersion },
        transportVersion: TAILNET_TRANSPORT_VERSION,
        capabilities: [...capabilities],
        protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      })
      return
    }

    if (method === 'POST' && path === TAILNET_UPLOAD_PATH) {
      await handleUpload(request, response, device, parseUrl(request.url))
      return
    }

    if (method === 'GET' && path === TAILNET_CONVERSATION_IMAGE_PATH) {
      await handleConversationImage(response, device, parseUrl(request.url))
      return
    }

    if (method === 'POST' && path === TAILNET_WS_TICKET_PATH) {
      // The upgrade carries its credential in the query string, where it lands
      // in proxy logs and browser history — so what it carries is a 30-second
      // single-use ticket, never the long-lived device token.
      const ticket = `mctk_${randomBytes(24).toString('base64url')}`
      const expiresAtMs = now() + WS_TICKET_TTL_MS
      pruneTickets()
      tickets.set(ticket, { deviceId: device.id, expiresAtMs })
      writeJson(response, 200, { ticket, expiresAt: new Date(expiresAtMs).toISOString(), path: TAILNET_STREAM_PATH })
      return
    }

    if (method === 'POST' && path === TAILNET_MCP_PATH) {
      const body = await readJsonBody(request, response, MAX_MCP_BODY_BYTES)
      if (body === undefined) return
      // This endpoint is stateless: every POST builds a fresh context, so a
      // connection-scoped declaration has nothing to attach to. Accepting it
      // and discarding it would be the silent fallback the norms forbid — the
      // caller would believe it had declared an identity it did not. Say so
      // instead, and name the channel that does hold state. Answered here
      // rather than in dispatch because the declaration is a NOTIFICATION: over
      // HTTP there is always a response to put the refusal in, over JSON-RPC
      // alone there would not be.
      if (isRecord(body) && body.method === CONNECT_METHOD) {
        writeJson(response, 400, {
          error: {
            code: 'stateless_transport',
            message: `${CONNECT_METHOD} needs a connection to attach to. Open a WebSocket at ${TAILNET_STREAM_PATH} with a ticket from ${TAILNET_WS_TICKET_PATH} and declare it there.`,
          },
        })
        return
      }
      const answer = await handleMessage(
        body,
        contextFor(device, peerNode),
        device,
        headerOf(request, 'mcp-protocol-version'),
      )
      // A notification has no answer; 202 says "accepted, nothing to return".
      if (!answer) writeJson(response, 202, {})
      else writeJson(response, 200, answer)
      return
    }

    writeJson(response, 404, {
      error: { code: 'not_found', message: `No tailnet gateway route for ${method} ${path}.` },
    })
  }

  /** Run one JSON-RPC message; returns the response object, or null for a notification. */
  /**
   * Pairing by approval, both halves.
   *
   * Unauthenticated, and deliberately ahead of the auth gate: a peer asking to
   * be paired has no credential yet, which is the whole point. What stands in
   * for one is the person at this machine, and the peer identity the store
   * records is the one this transport established — `whois` on the socket's own
   * address — never anything the body claimed.
   */
  async function handlePairRequest(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    if (method === 'GET') {
      const query = parseUrl(request.url ?? '').searchParams
      const outcome = options.devices.collectPairRequest(
        query.get('id') ?? '',
        query.get('secret') ?? '',
        await options.peers.identify(normalizeAddress(request.socket.remoteAddress)),
      )
      // Every outcome is a 200: "your request was declined" and "it lapsed" are
      // answers to a well-formed question, not failures of it. The client
      // branches on `status`, which it must do anyway.
      writeJson(response, 200, wireCollectOutcome(outcome))
      return
    }

    const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
    if (body === undefined) return
    const peerAddress = normalizeAddress(request.socket.remoteAddress)
    const peer = await options.peers.identify(peerAddress)
    const outcome = options.devices.requestPairing({
      deviceName: isRecord(body) ? body.deviceName : undefined,
      // Unresolvable stays null and the panel says so, rather than the request
      // being refused: whois is unavailable on any machine without the
      // Tailscale CLI, and that must not make the feature unusable.
      peerNode: peer?.name ?? null,
      peerAddress: peerAddress ?? '',
      // What an approval binds the new device to.
      peer,
      collectHash: isRecord(body) ? body.collectHash : undefined,
      // What the asker asked to be allowed to do. A request, not a grant: it
      // decides what the answering surface opens pre-ticked to, and the person
      // there decides what is actually given.
      requestedScopes: isRecord(body) ? body.scopes : undefined,
    })
    if (!outcome.ok) {
      // 429 for the caps, 400 for a malformed request: a client must be able to
      // tell "ask again later" from "you sent the wrong thing".
      const status = outcome.code === 'invalid_device_name' || outcome.code === 'invalid_collect_hash' ? 400 : 429
      writeJson(response, status, { error: { code: outcome.code, message: outcome.message } })
      return
    }
    // Audited like any other classified mutation, and for the same reason: a
    // stranger asking for access to this machine is a security event whether or
    // not anyone approves it. There is no device yet, so the record carries the
    // name asked for and the peer the transport proved — never a deviceId.
    options.onToolCall?.({
      context: {
        metadata: {
          kind: 'remote-tailnet',
          deviceName: outcome.request.deviceName,
          ...(outcome.request.peerNode ? { peerNode: outcome.request.peerNode } : {}),
        },
      },
      tool: 'tailnet.pair_request',
      args: { deviceName: outcome.request.deviceName, peerAddress: outcome.request.peerAddress },
      durationMs: 0,
    })
    options.onPairRequested?.()
    writeJson(response, 200, {
      requestId: outcome.request.id,
      // Echoed so the asking machine can show the digits beside the ones now on
      // the other screen. It is not a credential; comparing is its whole job.
      comparisonCode: outcome.request.comparisonCode,
      expiresAt: outcome.request.expiresAt,
    })
  }

  /**
   * The collect as a POST (phase 6): the same answer the GET gives, plus the
   * one thing a GET cannot carry — the asker's reverse grant, adopted only
   * when this very collect hands the asker OUR token (the approval a person
   * here gave), and only when its endpoint is the address the asker is
   * calling from. Anything else about the grant is refused silently: the
   * pairing the person approved still completes; the extra half does not.
   */
  async function handlePairCollect(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
    if (body === undefined) return
    const record = isRecord(body) ? body : {}
    const peerAddress = normalizeAddress(request.socket.remoteAddress)
    const outcome = options.devices.collectPairRequest(
      typeof record.id === 'string' ? record.id : '',
      typeof record.secret === 'string' ? record.secret : '',
      await options.peers.identify(peerAddress),
    )
    if (outcome.status === 'approved' && outcome.asker && isRecord(record.reverse)) {
      const grant = readReverseGrant(record.reverse, peerAddress)
      if (grant) {
        options.onReverseGrant?.({
          grant,
          askerName: outcome.asker.deviceName,
          peerNode: outcome.asker.peerNode,
        })
      } else {
        options.log?.(
          `tailnet gateway ignored a reverse grant from ${peerAddress || 'an unknown address'}: ` +
            "its endpoint was not the asker's own address or it was malformed.",
        )
      }
    }
    writeJson(response, 200, wireCollectOutcome(outcome))
  }

  async function handleMessage(
    parsed: unknown,
    context: McpConnectionContext,
    device: TailnetDevice,
    protocolHeader: string | null,
  ): Promise<Record<string, unknown> | null> {
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return jsonRpcErrorResponse(
        jsonRpcIdOf(parsed),
        JSONRPC_INVALID_REQUEST,
        'Request is not a JSON-RPC 2.0 message.',
      )
    }
    const id = jsonRpcIdOf(parsed)
    const isNotification = id === null && !('id' in parsed)
    const params = isRecord(parsed.params) ? parsed.params : {}
    const declared = declaredProtocolVersion(params, protocolHeader)
    if (declared.kind === 'unsupported') {
      const detail = unsupportedProtocolVersionMessage(declared.value)
      if (isNotification) {
        options.log?.(`tailnet gateway refused ${parsed.method}: ${detail}`)
        return null
      }
      return jsonRpcErrorResponse(id, JSONRPC_INVALID_PARAMS, detail)
    }
    try {
      const outcome = await dispatcher.dispatch(parsed.method, params, context, gateFor(device))
      if (isNotification) return null
      if (outcome.kind === 'no_response') return { jsonrpc: '2.0', id, result: {} }
      if (outcome.kind === 'error') return jsonRpcErrorResponse(id, outcome.code, outcome.errorMessage)
      return { jsonrpc: '2.0', id, result: outcome.value }
    } catch (error) {
      options.log?.(`tailnet tool dispatch threw: ${message(error)}`)
      if (isNotification) return null
      return jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message(error)}`)
    }
  }

  /** The device's scopes, applied to what it may see and what it may run. */
  function gateFor(device: TailnetDevice): McpDispatchGate {
    const granted = new Set<TailnetScope>(device.scopes)
    const scopeAllows = (toolName: string): boolean =>
      tailnetScopeGrantsAccess(granted, requiredScopeForTool(toolName, options.isMutation(toolName)))
    return {
      // Local-only first, and independent of scopes: a local-only tool is not
      // something a wider grant unlocks, it is off this transport entirely.
      filterTools: (tools) =>
        tools.filter((tool) => localOnlyGatewayToolReason(tool.name) === null && scopeAllows(tool.name)),
      authorizeToolCall: (toolName) => {
        const localOnly = localOnlyGatewayToolReason(toolName)
        if (localOnly) return toolError('tailnet_local_only', localOnly)
        return scopeAllows(toolName)
          ? null
          : toolError(
              'tailnet_scope_required',
              `This device is not granted "${requiredScopeForTool(toolName, options.isMutation(toolName))}", which "${toolName}" requires. Re-pair the device with that scope in Settings.`,
            )
      },
    }
  }

  function contextFor(device: TailnetDevice, peerNode: string | null): McpConnectionContext {
    return {
      metadata: {
        kind: 'remote-tailnet',
        deviceId: device.id,
        deviceName: device.name,
        ...(peerNode ? { peerNode } : {}),
        // The listener proved which paired device this is before dispatch.
        verified: true,
      },
    }
  }

  function authenticate(request: IncomingMessage): TailnetDevice | null {
    const header = headerOf(request, 'authorization') ?? ''
    const prefix = 'Bearer '
    return header.startsWith(prefix) ? options.devices.authenticate(header.slice(prefix.length).trim()) : null
  }

  /**
   * The second half of authentication: is this device's token being presented
   * from the tailnet node it was issued to? whois on the socket's own address
   * answers, never anything the request says about itself.
   *
   * A refusal is audited as a refused call, with the device whose token it was
   * and the node that presented it: a token turning up on the wrong machine is
   * the event the owner most needs to see, whether or not anything was served.
   *
   * Loopback needs no exception: whois cannot name 127.0.0.1, so a bound device
   * is refused there like anywhere else whois cannot answer. Tests inject a
   * resolver (`peers`) that names the nodes they need.
   */
  async function admitPeer(
    device: TailnetDevice,
    remoteAddress: string | undefined,
    route: string,
  ): Promise<({ ok: true } & TailnetGatewayPeer) | Extract<TailnetPeerCheck, { ok: false }>> {
    const peerAddress = normalizeAddress(remoteAddress)
    const peer = await options.peers.identify(peerAddress)
    // Read after the await: a device revoked while whois ran is refused here.
    const check = options.devices.verifyPeer(device.id, peer)
    const peerNode = peer?.name ?? null
    if (check.ok) return { ok: true, peerNode, peerAddress }
    options.log?.(
      `tailnet gateway refused device ${device.id} from ${peerNode ?? (peerAddress || 'an unknown address')}: ${check.code}`,
    )
    options.onToolCall?.({
      context: contextFor(device, peerNode),
      tool: TAILNET_PEER_REFUSED_AUDIT_TOOL,
      args: { path: route, peerAddress, ...(peer?.stableNodeId ? { peerNodeId: peer.stableNodeId } : {}) },
      durationMs: 0,
      result: toolError(check.code, check.message),
    })
    return check
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (request.headers.origin) return rejectUpgrade(socket, 403, 'origin_not_allowed')
    const path = pathOf(request.url)
    if (path !== TAILNET_STREAM_PATH && path !== TAILNET_CONVERSATION_PATH && path !== TAILNET_EVENTS_PATH) {
      return rejectUpgrade(socket, 404, 'not_found')
    }
    if ((headerOf(request, 'upgrade') ?? '').toLowerCase() !== 'websocket')
      return rejectUpgrade(socket, 400, 'not_a_websocket_upgrade')
    if ((headerOf(request, 'sec-websocket-version') ?? '') !== '13')
      return rejectUpgrade(socket, 400, 'unsupported_websocket_version')
    const key = headerOf(request, 'sec-websocket-key')
    if (!key) return rejectUpgrade(socket, 400, 'missing_websocket_key')

    const query = queryOf(request.url)
    const device = redeemTicket(query.get('ticket'))
    if (!device) return rejectUpgrade(socket, 401, 'unauthorized')
    // The ticket was minted behind `admitPeer`, but it rides in a URL; the
    // socket presenting it is held to the device's node all the same.
    const admitted = await admitPeer(device, remoteAddressOf(socket), path)
    if (!admitted.ok) return rejectUpgrade(socket, 401, admitted.code)
    const { peerNode, peerAddress } = admitted

    if (path === TAILNET_EVENTS_PATH) {
      // Any paired device may watch: the feed says only that something
      // changed, and what the device may then read is decided by the tools'
      // own scopes. No `onActivity`: a watcher is ambient, not a connection.
      options.devices.recordSeen(device.id, peerNode)
      acceptUpgrade(socket, key)
      openEventStream(socket, device, head)
      return
    }

    if (path === TAILNET_CONVERSATION_PATH) {
      if (!options.conversations) return rejectUpgrade(socket, 503, 'conversation_streaming_unavailable')
      // Peer discovery above awaited external work. Revocation or a narrowed
      // grant during that await must not create a stream after the listener
      // for it has already fired.
      const currentDevice = options.devices.listDevices().find((entry) => entry.id === device.id)
      if (!currentDevice) return rejectUpgrade(socket, 401, 'unauthorized')
      if (!tailnetScopeGrantsAccess(new Set(currentDevice.scopes), 'conversation:read'))
        return rejectUpgrade(socket, 403, 'conversation_scope_required')
      options.devices.recordSeen(currentDevice.id, peerNode)
      acceptUpgrade(socket, key)
      const registration: { stream: TailnetConversationStream | null } = { stream: null }
      const stream = createTailnetConversationStream({
        socket,
        deviceId: currentDevice.id,
        deviceName: currentDevice.name,
        // Read live, never captured: every frame and every scope change is
        // judged by the grant the device holds now.
        scopes: () => options.devices.listDevices().find((entry) => entry.id === currentDevice.id)?.scopes ?? null,
        host: options.conversations,
        // A `hello` names the conversation capabilities among what `health` and `identity` advertise.
        capabilities,
        onClosed: () => {
          if (registration.stream) conversationStreams.delete(registration.stream)
        },
        resyncRetryAfterMs: () => conversationResyncDelay(currentDevice.id),
        // The device is the connection's identity; the conversation and the
        // command id are the targets. A message's text never reaches the audit.
        audit: (entry) =>
          options.onToolCall?.({
            context: contextFor(currentDevice, peerNode),
            tool: entry.tool,
            args: { ...entry.key, id: entry.commandId },
            durationMs: entry.durationMs,
            result: entry.ok
              ? toolSuccess({ ok: true })
              : toolError(entry.code ?? 'unavailable', 'The conversation command was not carried out.'),
          }),
      })
      registration.stream = stream
      if (!stream.isClosed()) conversationStreams.add(stream)
      if (head?.length) socket.emit('data', head)
      return
    }

    options.devices.recordSeen(device.id, peerNode)
    acceptUpgrade(socket, key)

    const session: StreamSession = { socket, deviceId: device.id, device, context: contextFor(device, peerNode) }
    streams.add(session)
    session.untrack = options.clientTools?.track(session.context, () =>
      sendStream(session, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
    )
    options.onActivity?.({ kind: 'stream', device, open: true, peerNode, peerAddress })
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)
    // Serialize per connection so a client's messages are answered in order.
    let pending = Promise.resolve()

    const consume = (chunk: Buffer): void => {
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') {
        closeStream(session, decoded.code, decoded.reason)
        return
      }
      for (const frame of decoded.frames) {
        if (frame.kind === 'close') {
          closeStream(session, WEBSOCKET_CLOSE_GOING_AWAY, '')
          return
        }
        if (frame.kind === 'ping') {
          socket.write(encodePongFrame(frame.payload))
          continue
        }
        if (frame.kind !== 'text') continue
        const text = frame.text
        // One message that throws must not skip every message after it.
        pending = pending
          .then(() => handleStreamMessage(session, text))
          .catch((error: unknown) => {
            options.log?.(`tailnet stream message failed: ${message(error)}`)
          })
      }
    }

    if (head?.length) consume(head)
    socket.on('data', (chunk: Buffer) => consume(chunk))
    // An upgraded socket is half-open: a peer that disconnects makes Node emit
    // `end`, not `close` (the write side is still ours). Both are handled, or a
    // dropped client stays in `streams` for the life of the process and every
    // tool-list notification writes into a socket nobody is reading.
    socket.on('end', () => {
      dropStream(session)
      socket.destroy()
    })
    socket.on('close', () => dropStream(session))
    socket.on('error', () => {
      dropStream(session)
      socket.destroy()
    })
  }

  /**
   * Untrack a stream and announce the close exactly once, whichever of the
   * teardown paths (peer end/close/error, revocation, server stop) runs first —
   * `streams.delete` returning false is what dedupes.
   */
  function dropStream(session: StreamSession): void {
    if (streams.delete(session)) {
      session.untrack?.()
      options.onActivity?.({ kind: 'stream', device: session.device, open: false })
    }
  }

  async function handleStreamMessage(session: StreamSession, text: string): Promise<void> {
    // Re-check the device on every message, not only at upgrade: authorization
    // on a long-lived socket must follow the store, and the revocation listener
    // is a fast path, not the guarantee.
    const device = options.devices.listDevices().find((candidate) => candidate.id === session.deviceId)
    if (!device) {
      closeStream(session, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      sendStream(session, jsonRpcErrorResponse(null, JSONRPC_PARSE_ERROR, 'Request is not valid JSON.'))
      return
    }
    try {
      const answer = await handleMessage(parsed, session.context, device, null)
      if (answer) sendStream(session, answer)
    } catch (error) {
      // A request that failed past its handler (a result JSON cannot encode)
      // is still answered, so the device is not left waiting on its id; a
      // notification has no id to answer.
      const id = (parsed as { id?: unknown } | null)?.id
      if (typeof id === 'string' || typeof id === 'number') {
        sendStream(session, jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, 'The request failed.'))
      }
      throw error
    }
  }

  function redeemTicket(ticket: string | null): TailnetDevice | null {
    pruneTickets()
    if (!ticket) return null
    const entry = tickets.get(ticket)
    if (!entry) return null
    // Single use: consumed whether or not the device still exists.
    tickets.delete(ticket)
    if (entry.expiresAtMs <= now()) return null
    return options.devices.listDevices().find((device) => device.id === entry.deviceId) ?? null
  }

  function pruneTickets(): void {
    const current = now()
    for (const [ticket, entry] of tickets) if (entry.expiresAtMs <= current) tickets.delete(ticket)
  }

  function closeStreamsFor(deviceId: string): void {
    for (const stream of [...streams]) {
      if (stream.deviceId === deviceId) closeStream(stream, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
    }
    for (const conversation of [...conversationStreams]) {
      if (conversation.deviceId === deviceId)
        conversation.close(WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
    }
    for (const stream of [...eventStreams]) {
      if (stream.deviceId === deviceId)
        closeEventStream(stream, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
    }
    for (const [ticket, entry] of tickets) if (entry.deviceId === deviceId) tickets.delete(ticket)
  }

  /**
   * Write the RFC 6455 handshake response for an accepted upgrade, and turn on
   * TCP keepalive for the socket's life.
   *
   * Keepalive is the kernel's, so it costs this process no wakeups, and it is
   * what finds a peer that vanished without a close — a laptop that slept, a
   * Wi-Fi change, a re-keyed tunnel. The change feed sends nothing while
   * nothing changes, so without it a dead watcher would sit in `eventStreams`
   * until a later push failed, which may be never.
   */
  function acceptUpgrade(socket: Duplex, key: string): void {
    enableTcpKeepAlive(socket)
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    )
  }

  function closeStream(session: StreamSession, code: number, reason: string): void {
    dropStream(session)
    if (session.socket.destroyed) return
    try {
      session.socket.write(encodeCloseFrame(code, reason))
    } catch {
      // The peer is already gone; destroying below is the whole cleanup.
    }
    session.socket.end()
  }

  function sendStream(session: StreamSession, payload: Record<string, unknown>): void {
    if (session.socket.destroyed) return
    session.socket.write(encodeTextFrame(JSON.stringify(payload)))
  }

  /**
   * Read and parse a JSON body, answering the client on failure.
   *
   * Returns `undefined` when it already wrote the response — callers must
   * return immediately on that, and must not treat it as a valid body.
   */
  async function readJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
    maxBytes: number,
  ): Promise<unknown | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > maxBytes) {
          // Answer first, then stop reading. Breaking out of `for await`
          // destroys the request stream, so the response has to be on the wire
          // before that happens or the client sees a reset with no reason.
          writeJson(response, 413, {
            error: { code: 'body_too_large', message: `Request body exceeds the ${maxBytes}-byte limit.` },
          })
          // A client that hangs up first never lets the answer finish.
          await new Promise<void>((resolve) => {
            response.once('finish', resolve)
            response.once('close', resolve)
          })
          break
        }
        chunks.push(buffer)
      }
    } catch (error) {
      writeJson(response, 400, { error: { code: 'body_read_failed', message: message(error) } })
      return undefined
    }
    if (response.headersSent) return undefined
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      writeJson(response, 400, { error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } })
      return undefined
    }
  }

  return {
    start,
    stop,
    isRunning: () => server !== null,
    address: () => {
      const bound = server?.address()
      return bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null
    },
    notifyToolsListChanged: () => {
      for (const stream of streams) sendStream(stream, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    },
    notifyWorkspacesChanged: () => notifyChanged('workspaces'),
    notifyConversationsChanged: () => notifyChanged('conversations'),
    eventStreamCount: () => eventStreams.size,
    streamCount: () => streams.size,
  }
}

/** The collect outcome as the asker may see it: never who asked (it knows) nor the store's bookkeeping. */
function wireCollectOutcome(outcome: TailnetCollectOutcome): Record<string, unknown> {
  const { asker: _asker, ...wire } = outcome
  return wire
}

/**
 * Read a reverse grant off a collect body, or null when it must not be kept.
 *
 * The endpoint's host must be the address the collect arrived from. That is
 * the one fact the transport proves about the asker, and it is what stops a
 * peer from handing this machine a credential that dials somewhere else.
 */
function readReverseGrant(value: Record<string, unknown>, peerAddress: string): TailnetReverseGrant | null {
  if (!peerAddress) return null
  const endpoint = typeof value.endpoint === 'string' ? parseTailnetEndpoint(value.endpoint) : null
  if (!endpoint || normalizeAddress(endpoint.host) !== peerAddress) return null
  const deviceToken = typeof value.deviceToken === 'string' ? value.deviceToken.trim() : ''
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim() : ''
  if (!deviceToken || !deviceId) return null
  const machineName = typeof value.machineName === 'string' ? value.machineName.trim().slice(0, 120) : ''
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim().slice(0, 120) : ''
  return {
    endpoint: `${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`,
    machineName: machineName || endpoint.host,
    deviceId,
    deviceName,
    deviceToken,
    scopes: normalizeTailnetScopes(value.scopes),
  }
}

function writeUnauthorized(response: ServerResponse): void {
  response.setHeader('WWW-Authenticate', 'Bearer realm="sprintengine-studio-tailnet"')
  writeJson(response, 401, {
    error: {
      code: 'unauthorized',
      message: 'A paired device token is required. Pair this machine in Settings → Remote.',
    },
  })
}

/** A valid token presented from the wrong node, or from one whois could not name. */
function writePeerRefused(response: ServerResponse, refusal: { code: string; message: string }): void {
  response.setHeader('WWW-Authenticate', 'Bearer realm="sprintengine-studio-tailnet"')
  writeJson(response, 401, { error: { code: refusal.code, message: refusal.message } })
}

function writeTooLarge(response: ServerResponse, ceiling: number): void {
  writeJson(response, 413, {
    error: {
      code: 'too_large',
      message: `That file is over the ${Math.floor(ceiling / (1024 * 1024))}MB limit.`,
    },
  })
}

/** A declared `type/subtype`, recorded as sent; anything else is recorded as bytes. */
const MEDIA_TYPE_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u

/**
 * The upload at `path`, shrunk in place for the model, and what is kept: its
 * size and type. One the downscaler leaves alone, or that cannot be read or
 * rewritten, is kept as it came.
 */
async function shrinkUpload(
  path: string,
  bytes: number,
  mediaType: string,
  downscale: ConversationImageDownscaler,
): Promise<{ bytes: number; mediaType: string }> {
  const received = { bytes, mediaType }
  try {
    const original = await readFile(path)
    if (original.byteLength !== bytes) return received
    const shrunk = await downscale(original, mediaType)
    if (shrunk.bytes === original || (shrunk.mediaType === mediaType && Buffer.from(shrunk.bytes).equals(original)))
      return received
    if (!ATTACHABLE_IMAGE_TYPES.includes(shrunk.mediaType as (typeof ATTACHABLE_IMAGE_TYPES)[number])) return received
    await writeFile(path, shrunk.bytes)
    return { bytes: shrunk.bytes.byteLength, mediaType: shrunk.mediaType }
  } catch {
    return received
  }
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  // The catch-all 500 in the request handler can fire after a route already
  // answered; writing a second status line would throw over the first one.
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Nothing here is cacheable, and a proxy holding a tool result would be a
    // correctness bug before it was a privacy one.
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const reason =
    status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 503
            ? 'Service Unavailable'
            : 'Bad Request'
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nX-Tailnet-Error: ${code}\r\n\r\n`)
  }
  socket.destroy()
}

/**
 * The peer address of an upgraded connection.
 *
 * Node types the `upgrade` socket as `Duplex` because the server may be TLS,
 * but every socket this plain-HTTP server upgrades is a `net.Socket` and
 * carries `remoteAddress`. Read defensively rather than casting the whole
 * socket: an address we cannot read means an unresolved peer, not a crash.
 */
function remoteAddressOf(socket: Duplex): string {
  const value = (socket as { remoteAddress?: unknown }).remoteAddress
  return typeof value === 'string' ? value : ''
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? (value[0] ?? null) : null
}

function pathOf(url: string | undefined): string {
  return parseUrl(url).pathname
}

function queryOf(url: string | undefined): URLSearchParams {
  return parseUrl(url).searchParams
}

// How much of an already-refused body is read and thrown away before the
// connection is cut instead, as a multiple of the ceiling it overshot, and how
// long that is given. Generous enough that
// an honest client which overshot the ceiling always gets its sentence (the
// phone's own screenshot is megabytes, not gigabytes), small enough that a
// client streaming without end is hung up on rather than served forever.
const REFUSED_BODY_DRAIN_FACTOR = 4
const REFUSED_BODY_DRAIN_MS = 15_000

/**
 * Discard the rest of a body that has already been refused, and only then let
 * the answer be written.
 *
 * The tempting move is to hang up — the decision is made, the sink is gone, and
 * the remaining megabytes have nowhere to land. But destroying the socket races
 * the response's own flush: the client's next write fails with EPIPE and it
 * never reads the 413, so "That file is over the 5MB limit." is replaced by a
 * connection reset and the phone can only say something went wrong. Losing the
 * sentence is worse than reading bytes we intend to throw away, because the
 * sentence is the entire reason the limit is stated on the wire.
 *
 * Draining AFTER the answer is written is not enough, which is what this looked
 * like until 2026-09-08. A client that asked for `Connection: close` — which is
 * every request made without a keep-alive agent — makes the response the last
 * one on that socket, and Node destroys the socket the moment that response
 * finishes, whether or not the request body has been read. The drain never got
 * a turn, and the client writing the tail of its file saw EPIPE instead of the
 * 413. So the body is drained first and the answer written after: by then the
 * request is complete, and the close that follows is orderly.
 *
 * In practice almost nothing is read: the phone checks the size before it
 * starts. A client that keeps sending past the budget above is not one that is
 * waiting to be told why, so it is cut off — and this answers `false`, because
 * writing a sentence into a socket that has just been destroyed is not sending
 * it, it is only pretending to.
 *
 * @returns whether the body ended, and so whether an answer can still be sent.
 */
async function drainRefusedBody(request: IncomingMessage, ceiling: number): Promise<boolean> {
  const maxDiscarded = REFUSED_BODY_DRAIN_FACTOR * ceiling
  if (request.readableEnded || request.complete) return true
  return await new Promise<boolean>((resolve) => {
    let discarded = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (drained: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('close', onEnd)
      request.off('error', onEnd)
      resolve(drained)
    }
    // A client that hangs up mid-refusal has answered the question itself:
    // there is no body left to read and nobody left to read the answer.
    const onEnd = (): void => settle(request.readableEnded)
    const giveUp = (): void => {
      if (settled) return
      settle(false)
      request.destroy()
    }
    const onData = (chunk: Buffer): void => {
      discarded += chunk.length
      if (discarded > maxDiscarded) giveUp()
    }
    timer = setTimeout(giveUp, REFUSED_BODY_DRAIN_MS)
    // Never hold the process open for a body nobody is waiting on.
    timer.unref?.()
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('close', onEnd)
    request.on('error', onEnd)
    request.resume()
  })
}

/** Thrown when a body runs past the ceiling mid-flight. */
class UploadTooLarge extends Error {}

/**
 * Stream a request body into the staging directory.
 *
 * The ceiling is counted as the bytes arrive rather than trusted from
 * `content-length`, which a client controls and can simply omit. A body that
 * runs past it is cut off and the part-written file removed: a truncated
 * image handed to an agent is worse than no image, because the agent cannot
 * tell the difference.
 */
async function streamUploadToDisk(request: IncomingMessage, path: string, maxBytes: number): Promise<number> {
  const { mkdir, rm } = await import('node:fs/promises')
  const { createWriteStream } = await import('node:fs')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  const sink = createWriteStream(path, { flags: 'wx' })
  let created = false
  sink.once('open', () => {
    created = true
  })
  let written = 0
  try {
    await new Promise<void>((resolve, reject) => {
      const count = (chunk: Buffer): void => {
        written += chunk.length
        if (written > maxBytes) fail(new UploadTooLarge('upload over the ceiling'))
      }
      // Every listener this put on the request comes off again, because the
      // request outlives the sink: a refused body is drained afterwards, and a
      // counter still attached would re-fire the failure on every drained chunk.
      const detach = (): void => {
        request.off('data', count)
        request.off('error', fail)
      }
      const fail = (error: Error) => {
        detach()
        request.unpipe(sink)
        sink.destroy()
        reject(error)
      }
      request.on('data', count)
      request.on('error', fail)
      sink.on('error', fail)
      sink.on('finish', () => {
        detach()
        resolve()
      })
      request.pipe(sink)
    })
  } catch (error) {
    // An exclusive-create failure means the path belongs to someone else.
    // Cleanup may remove only the partial file this request actually created.
    if (created) await rm(path, { force: true }).catch(() => {})
    throw error
  }
  return written
}

// The base is a placeholder: only the path and query are ever read from it, and
// a request line is always origin-form on this server.
function parseUrl(url: string | undefined): URL {
  try {
    return new URL(url ?? '/', 'http://tailnet.invalid')
  } catch {
    return new URL('/', 'http://tailnet.invalid')
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
