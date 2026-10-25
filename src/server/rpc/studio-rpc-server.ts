import { arch, platform } from 'node:os'
import type { Duplex } from 'node:stream'

import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  CONVERSATION_PROTOCOL_VERSION,
  STUDIO_CAPABILITIES,
  STUDIO_CHAT_CAPABILITIES,
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_BOARD_FILES_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY,
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_LOCAL_SERVERS_CAPABILITY,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  type StudioEnvironment,
  type StudioWelcomeFrame,
} from '../../../packages/studio-protocol/src/public'
import { createStudioRpcConnection, type StudioRpcConnection } from './studio-rpc-connection'
import { createStudioRpcListener, type StudioRpcListener } from './studio-rpc-listener'
import { createStudioRpcRouter } from './studio-rpc-router'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { StudioFiles } from './studio-files'
import type { StudioPullRequests } from '../pull-requests/pull-request-domain'
import type { StudioLocalServers } from '../local-servers/local-server-domain'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioChatBackend,
  StudioConversationBackend,
} from './studio-rpc-types'

// The Studio RPC as one piece: the owner socket, a connection per client, and
// the router behind them. Main constructs it with the conversations it serves
// and who may connect; nothing here knows it is inside Electron.
//
// Two ways in share the one router. The listener accepts clients on the owner
// socket; `attach` takes a connection main already holds the other end of (a
// window's port), with that connection's own authenticator. The receipts and
// uploads the router keeps are the same for both, so a window that reconnects
// finds what it left.

/**
 * The conversation capabilities the socket serves: every one the contract
 * defines, but the five that describe the tailnet lane's own transport — a
 * picture route beside its WebSocket, the sent pictures that route also
 * serves, the files its upload route takes, the upload route's shrinking of a
 * picture on receipt (this socket's own uploads are kept as they came), and a
 * `hello` frame on it, which here is the connection's own handshake —
 * `conversation-lifecycle`, whose
 * settle and visit are gateway tools this socket has no method for, and
 * `conversation-queued-sends`, whose `queued` frames its conversation topic
 * does not carry. Nor the composer's two reads of a chat's folder
 * (`conversation-file-search`, `conversation-commands`), routes beside the
 * tailnet's socket that this one has no method for; a window on it reads its
 * own files and command lists. A send's `mentions` it does take
 * (`conversation-send-mentions`): its `conversation.send` reads the lane's own
 * validator and reaches the same host.
 */
export const STUDIO_RPC_CONVERSATION_CAPABILITIES: string[] = CONVERSATION_CAPABILITIES.filter(
  (capability) =>
    capability !== 'conversation-images' &&
    capability !== 'conversation-message-images' &&
    capability !== 'conversation-message-files' &&
    capability !== 'conversation-image-downscale' &&
    capability !== 'conversation-hello' &&
    capability !== 'conversation-lifecycle' &&
    capability !== 'conversation-queued-sends' &&
    capability !== 'conversation-file-search' &&
    capability !== 'conversation-commands',
)

export type StudioRpcServerOptions = {
  dataDir: string
  version: string
  /** Minted once per data directory; see `StudioEnvironment.id`. */
  environmentId: string
  /** Where this Studio runs, from how its server was started; `local` when not said. */
  hostKind?: StudioEnvironment['hostKind']
  backend: StudioConversationBackend
  /** The chat surface, when main has given one; its capabilities are advertised only then. */
  chat?: () => StudioChatBackend | null
  authenticator: StudioAuthenticator
  audit?: (entry: StudioAuditEntry) => void
  /** Client toolsets: offered here, listed to agents by the gateway. Advertised as `client-tools` only when given. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots, for owners. Advertised as `files-write` only when given. */
  files?: StudioFiles
  /** The pull requests the conversations opened, for owners. Advertised as `pull-requests` and `pull-request-tool-calls` only when given. */
  pullRequests?: StudioPullRequests
  /** The local servers the conversations started, for owners. Advertised as `local-servers` only when given. */
  localServers?: StudioLocalServers
  resyncRetryAfterMs?: (clientId: string) => number
  socketPath?: string
  helloTimeoutMs?: number
  maxConnections?: number
  /** The most connections one client may hold at once; 8 unless set. */
  maxConnectionsPerClient?: number
  onConnectionsChanged?: () => void
  log?: (message: string) => void
}

/** A connection that did not come through the listener, and who may say hello on it. */
export type StudioRpcAttachOptions = {
  /** A window's port answers to the one ticket main minted for it. */
  authenticator: StudioAuthenticator
  /** One of Studio's own windows: shown conversations as its IPC shows them, and not audited. */
  ownWindow: boolean
  /**
   * The desktop's own shell, over a port main holds both ends of: it may
   * offer the built-in toolsets (`browser`, `canvas`), whatever its hello says.
   */
  shell?: boolean
  /** Audit its mutations although it is Studio's own view: an owner's web tab. */
  audited?: boolean
  /** Hold the folders it names to the ones Studio knows: a browser on the tailnet. */
  knownFoldersOnly?: boolean
}

export type StudioRpcServer = StudioRpcListener & {
  /** Serve a connection main holds the other end of. It ends when its stream does, or on `stop`. */
  attach(stream: Duplex, options: StudioRpcAttachOptions): StudioRpcConnection
}

export function createStudioRpcServer(options: StudioRpcServerOptions): StudioRpcServer {
  const perClient = options.maxConnectionsPerClient ?? 8
  const chat = () => options.chat?.() ?? null
  const welcome = (): Omit<StudioWelcomeFrame, 't' | 'grant' | 'pairing'> => ({
    protocolVersion: STUDIO_PROTOCOL_VERSION,
    minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
    server: { name: 'SprintEngine Studio', version: options.version },
    environment: { id: options.environmentId, hostKind: options.hostKind ?? 'local', os: platform(), arch: arch() },
    capabilities: STUDIO_CAPABILITIES.filter(
      (capability) =>
        (capability !== STUDIO_CLIENT_TOOLS_CAPABILITY || options.tools !== undefined) &&
        (capability !== STUDIO_BOARD_FILES_CAPABILITY || options.files !== undefined) &&
        ((capability !== STUDIO_PULL_REQUESTS_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_LINK_CAPABILITY) ||
          options.pullRequests !== undefined) &&
        (capability !== STUDIO_PULL_REQUEST_WATCH_CAPABILITY || options.pullRequests?.unwatch !== undefined) &&
        (capability !== STUDIO_LOCAL_SERVERS_CAPABILITY || options.localServers !== undefined) &&
        (chat() !== null || !(STUDIO_CHAT_CAPABILITIES as readonly string[]).includes(capability)),
    ),
    conversation: {
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      minProtocolVersion: CONVERSATION_PROTOCOL_MIN_SUPPORTED,
      capabilities: STUDIO_RPC_CONVERSATION_CAPABILITIES,
    },
  })
  const router = createStudioRpcRouter({
    backend: options.backend,
    chat,
    info: welcome,
    audit: options.audit,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
    ...(options.localServers ? { localServers: options.localServers } : {}),
    log: options.log,
  })
  // A revoked app's offers go at once, with its names: a later app that takes
  // one inherits nothing.
  const forgetRevoked = options.tools
    ? options.authenticator.onRevoked((clientId) => options.tools?.forgetClient(clientId))
    : null
  const attached = new Set<StudioRpcConnection>()
  let attachSequence = 0
  const listener: StudioRpcListener = createStudioRpcListener({
    dataDir: options.dataDir,
    version: options.version,
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    log: options.log,
    onConnectionsChanged: options.onConnectionsChanged,
    createConnection: (socket, connectionId, onClosed) =>
      createStudioRpcConnection({
        socket,
        connectionId,
        authenticator: options.authenticator,
        router,
        backend: options.backend,
        chat,
        welcome,
        audit: options.audit,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.files ? { files: options.files } : {}),
        ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
        ...(options.localServers ? { localServers: options.localServers } : {}),
        resyncRetryAfterMs: options.resyncRetryAfterMs,
        helloTimeoutMs: options.helloTimeoutMs,
        log: options.log,
        // Counted among the connections already authenticated as it; this one
        // has no client yet, so it is not among them.
        admitClient: (clientId) =>
          listener.connections().filter((connection) => connection.clientId() === clientId).length < perClient,
        onClosed,
      }),
  })
  return {
    ...listener,
    async stop(retryAfterMs = 1_000) {
      for (const connection of [...attached]) connection.bye('shutting_down', 'Studio is closing.', retryAfterMs)
      attached.clear()
      await listener.stop(retryAfterMs)
      router.close()
      forgetRevoked?.()
    },
    attach(stream, attachOptions) {
      const connection = createStudioRpcConnection({
        socket: stream,
        connectionId: `w${++attachSequence}`,
        authenticator: attachOptions.authenticator,
        router,
        backend: options.backend,
        chat,
        ownWindow: attachOptions.ownWindow,
        shell: attachOptions.shell === true,
        ...(attachOptions.audited === undefined ? {} : { audited: attachOptions.audited }),
        ...(attachOptions.knownFoldersOnly ? { knownFoldersOnly: true } : {}),
        welcome,
        audit: options.audit,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.files ? { files: options.files } : {}),
        ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
        ...(options.localServers ? { localServers: options.localServers } : {}),
        resyncRetryAfterMs: options.resyncRetryAfterMs,
        helloTimeoutMs: options.helloTimeoutMs,
        log: options.log,
        onClosed: (closed) => {
          attached.delete(closed)
        },
      })
      if (!connection.isClosed()) attached.add(connection)
      return connection
    },
  }
}
