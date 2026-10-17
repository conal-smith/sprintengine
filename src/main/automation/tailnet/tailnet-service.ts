import { join } from 'node:path'

import type { McpConnectionContext, McpToolRegistration } from '../../../shared/modules/mcp-tools'
import {
  normalizeTailnetScopes,
  TAILNET_SCOPES,
  type TailnetApprovePairRequestView,
  type TailnetDevice,
  type TailnetDeviceOrigin,
  type TailnetLiveState,
  type TailnetPairRequest,
  type TailnetPairRequestPhase,
  type TailnetPairingOfferView,
  type TailnetPushPayload,
  type TailnetRemoteStatus,
  type TailnetReverseGrant,
  type TailnetScope,
} from '../../../shared/tailnet'
import type { TailnetPeerScan } from '../../../shared/tailnet-peers'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import {
  createTailnetGatewayServer,
  type TailnetGatewayActivity,
  type TailnetGatewayServer,
  type TailnetGatewayServerOptions,
} from './tailnet-gateway-server'
import { isInsideWsl, resolveTailnetInterface, TAILNET_IN_WSL_ENV } from './tailnet-interface'
import { createTailnetPeerResolver, type TailnetPeerIdentity, type TailnetPeerResolver } from './tailnet-peer-identity'
import { createTailnetPeerScanner, type TailnetPeerScanner } from './tailnet-peers'
import { readTailnetSettings, writeTailnetSettings, type TailnetSettings } from './tailnet-settings'
import type { ConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetFileUploads, TAILNET_UPLOADS_DIRNAME } from './tailnet-file-uploads'
import type { McpToolCallEvent } from '../mcp-dispatch'

// Lifecycle for tailnet remote control: settings, paired devices, and the
// listener itself.
//
// Off is the resting state and the only state a build ships in. `initialize`
// starts the listener ONLY when a persisted setting says a person turned it on
// AND this machine actually has a Tailscale interface — no tailnet, no
// listener, and the reason is reported rather than silently swallowed.

/**
 * What approving a request answers with. Aliased from the shared view rather
 * than restated: Settings reads the same shape over IPC, and two declarations
 * of it would be two things to keep in step.
 */
export type TailnetApprovePairRequestResult = TailnetApprovePairRequestView

export type TailnetRemoteService = {
  /** Start the listener if, and only if, it is enabled and a tailnet exists. */
  initialize(): Promise<TailnetRemoteStatus>
  getStatus(): TailnetRemoteStatus
  setEnabled(enabled: boolean): Promise<TailnetRemoteStatus>
  /**
   * Mint a one-time pairing code. The token is returned once and never
   * re-readable. `origin` is recorded on the device that redeems it: the
   * Settings button passes nothing (a carried code); an agent passes itself.
   */
  offerPairing(input?: { scopes?: unknown; origin?: TailnetDeviceOrigin }): TailnetPairingOfferView
  /**
   * The reverse half of a both-ways pairing (phase 6): mint a device HERE for
   * the machine this Studio is about to ask to drive, so the approval over
   * there can carry a grant back. Null while nothing is listening — a token
   * for a listener that is down would be a credential pointing at nothing —
   * and the caller says so instead of offering it.
   */
  grantReverseDevice(input: {
    machineName: string
    scopes: TailnetScope[]
    /** whois for the machine being asked, which is the one that will present this token. */
    peer?: TailnetPeerIdentity | null
  }): {
    device: TailnetDevice
    deviceToken: string
    endpoint: string
  } | null
  cancelPairing(): TailnetRemoteStatus
  revokeDevice(deviceId: string): TailnetRemoteStatus
  /**
   * Widen (or narrow) an already-paired device's scopes from this keyboard.
   *
   * The counterpart to revoke, and the answer to the one thing pairing could
   * not do: a device paired before a scope existed, or paired for a narrower
   * job, could only ever be revoked and paired again. Throws on an
   * unknown id — the caller is a surface acting on a row it can see, so an id
   * that is not here is a bug, not a state to render.
   */
  updateDeviceScopes(deviceId: string, scopes: unknown): TailnetRemoteStatus
  /**
   * Answer a pairing request that arrived from another machine, with the
   * scopes chosen HERE.
   *
   * `via` says which door the answer came through, and exists only so the audit
   * is written exactly once: a `tailnet.*` tool call is already audited by
   * dispatch, so only the IPC path records here.
   */
  approvePairRequest(input: {
    id: string
    scopes?: unknown
    /** The six digits on the asker's screen, typed here (phase 2). */
    code?: unknown
    via?: 'ipc' | 'tool'
  }): TailnetApprovePairRequestResult
  denyPairRequest(id: string, via?: 'ipc' | 'tool'): TailnetRemoteStatus
  /**
   * Machines on this tailnet, and which of them answer as a Studio.
   *
   * Independent of this machine's own listener: discovering somewhere to
   * connect TO does not require having enabled being connected to.
   */
  listPeers(): Promise<TailnetPeerScan>
  /**
   * Tailscale's name for a tailnet address, or null.
   *
   * Shared with the Mesh client so a machine this Studio pairs WITH
   * is labelled by the same resolver — and the same ~5-minute cache — that names
   * the peers driving this one. Two resolvers would mean two `whois` spawns for
   * one question.
   */
  resolvePeerName(address: string): Promise<string | null>
  /** The whole whois answer for a tailnet address, from the same resolver and cache. */
  resolvePeerIdentity(address: string): Promise<TailnetPeerIdentity | null>
  /**
   * Live connections, derived from the listener's open sockets — which devices
   * hold a stream right now. Nothing here is persisted; it is exactly what the
   * sockets say.
   */
  getLiveState(): TailnetLiveState
  notifyToolsListChanged(): void
  /** The change feed: this machine's workspace list, or conversation list, changed. No-ops with no listener. */
  notifyWorkspacesChanged(): void
  notifyConversationsChanged(): void
  shutdown(): Promise<void>
}

export type TailnetRemoteServiceOptions = {
  resolveUserDataDir: () => string
  serverName: string
  serverVersion: string
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[]
  clientTools?: TailnetGatewayServerOptions['clientTools']
  isMutation: (toolName: string) => boolean
  onToolCall?: (event: McpToolCallEvent) => void
  conversations?: ConversationGatewayHost
  /** Shrinks an uploaded picture for the model; see the gateway's own option. */
  downscaleUpload?: TailnetGatewayServerOptions['downscaleUpload']
  /**
   * The live-state push (remote-sessions-ux): fired on every observable change
   * — listener up/down, a pair request arriving or resolving, a device's
   * socket opening or closing. Each
   * payload carries a fresh status + live snapshot beside the event, so a
   * consumer that stores the latest can never drift by missing one.
   */
  onEvent?: (payload: TailnetPushPayload) => void
  /**
   * An approved asker delivered the reverse half of a both-ways pairing
   * (phase 6): a device it minted for this machine. Wired to the mesh, which
   * stores it as a machine this Studio can drive. The gateway has already
   * checked the grant's endpoint is the asker's own address.
   */
  onReverseGrant?: (input: { grant: TailnetReverseGrant; askerName: string; peerNode: string | null }) => void
  /** Injected in tests. Production reads this machine's real interfaces. */
  resolveBindAddress?: () => string | null
  /**
   * Whether this process runs inside WSL, where the listener is refused
   * unless the owner set `SPRINTENGINE_TAILNET_IN_WSL=1`. Tests stand in.
   */
  insideWsl?: () => boolean
  /**
   * How often to look for a Tailscale interface while the listener is enabled
   * and waiting for one. Tests drive it down; nothing else sets it.
   */
  interfaceWatchMs?: number
  createPeerScanner?: () => TailnetPeerScanner
  createDeviceStore?: (options: {
    resolveUserDataDir: () => string
    log?: (message: string) => void
  }) => TailnetDeviceStore
  createPeerResolver?: () => TailnetPeerResolver
  log?: (message: string) => void
}

/**
 * How often to look for a Tailscale interface while the listener is enabled
 * and waiting for one. Thirty seconds: Tailscale takes seconds to come up
 * after login, and a person who just started it will not notice half a minute.
 */
const INTERFACE_WATCH_MS = 30_000

export function createTailnetRemoteService(options: TailnetRemoteServiceOptions): TailnetRemoteService {
  const devices = (options.createDeviceStore ?? createTailnetDeviceStore)({
    resolveUserDataDir: options.resolveUserDataDir,
    log: options.log,
  })
  const peers = (options.createPeerResolver ?? (() => createTailnetPeerResolver({ log: options.log })))()
  const peerScanner = (options.createPeerScanner ?? (() => createTailnetPeerScanner({ log: options.log })))()
  const resolveBindAddress = options.resolveBindAddress ?? (() => resolveTailnetInterface()?.address ?? null)
  const interfaceWatchMs = options.interfaceWatchMs ?? INTERFACE_WATCH_MS

  let settings: TailnetSettings | null = null
  let lastError: string | null = null
  let server: TailnetGatewayServer | null = null
  // The address the running listener was bound to. Resolved ONCE per listener
  // lifetime: `resolveTailnetInterface` walks `os.networkInterfaces()`, and
  // every push payload carries a status — a socket event per keystroke must
  // not re-enumerate the machine's interfaces to report an address that
  // cannot have changed while the listener stayed bound to it.
  let boundAddress: string | null = null
  /**
   * Set while the listener is enabled but has no interface to bind to.
   *
   * Tailscale starting a few seconds AFTER the app is the ordinary case on a
   * login-item launch, and without this the listener lost that race
   * permanently: `startServer` recorded "no Tailscale interface was found" and
   * nothing ever looked again, so the setting read `enabled: true` while
   * nothing was listening and the only cure was toggling it by hand. Reported
   * by the owner on 2026-09-05 after a phone sat on "the desktop did not
   * answer" against a machine whose Studio was running the whole time.
   */
  let interfaceWatch: ReturnType<typeof setInterval> | null = null

  // ── live-connection accounting (remote-sessions-ux) ────────────────────────
  // A count, not a boolean: one device may hold several streams (two clients
  // under one pairing), and "connected" must only fall when the LAST one closes.
  type LiveEntry = {
    deviceName: string
    streamCount: number
    connectedSince: number | null
    lastActivityAt: number | null
    peerNode: string | null
    peerAddress: string | null
  }
  const live = new Map<string, LiveEntry>()
  // Requests already announced, so the gateway's detail-free "a request
  // arrived" callback can be diffed into per-request received events, and each
  // gets one expiry timer that announces the resolution nobody typed.
  const announcedRequests = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; deviceName: string; peerNode: string | null; expiresAt: string }
  >()
  // Every emit — and every snapshot read — is stamped with this. It only goes
  // up, so a subscriber can order what it hears against what it read.
  let revision = 0

  function emit(event: TailnetPushPayload['event']): void {
    revision += 1
    options.onEvent?.({ revision, event, status: getStatus(), live: getLiveState() })
  }

  function getLiveState(): TailnetLiveState {
    return {
      revision,
      devices: [...live.entries()]
        .filter(([, entry]) => isLiveConnected(entry))
        .map(([deviceId, entry]) => ({
          deviceId,
          deviceName: entry.deviceName,
          connected: true,
          connectedSince: entry.connectedSince,
          lastActivityAt: entry.lastActivityAt,
          peerNode: entry.peerNode,
          peerAddress: entry.peerAddress,
        })),
    }
  }

  function liveEntryFor(deviceId: string, deviceName: string): LiveEntry {
    const existing = live.get(deviceId)
    if (existing) {
      existing.deviceName = deviceName
      return existing
    }
    const created: LiveEntry = {
      deviceName,
      streamCount: 0,
      connectedSince: null,
      lastActivityAt: null,
      peerNode: null,
      peerAddress: null,
    }
    live.set(deviceId, created)
    return created
  }

  function isLiveConnected(entry: LiveEntry): boolean {
    return entry.streamCount > 0
  }

  function handleActivity(event: TailnetGatewayActivity): void {
    const now = Date.now()
    if (event.kind === 'request') {
      // An authenticated HTTP call is liveness without a socket: it refreshes
      // the device's activity and peer while it holds one, and is otherwise
      // forgotten — an entry per stateless call would be a leak, and a
      // device with no socket is not "connected" (the field's contract).
      const entry = live.get(event.device.id)
      if (!entry) return
      entry.deviceName = event.device.name
      entry.lastActivityAt = now
      entry.peerNode = event.peerNode
      entry.peerAddress = event.peerAddress
      return
    }
    const entry = liveEntryFor(event.device.id, event.device.name)
    const wasConnected = isLiveConnected(entry)
    entry.lastActivityAt = now
    if (event.open) {
      entry.peerNode = event.peerNode
      entry.peerAddress = event.peerAddress
    }
    entry.streamCount = Math.max(0, entry.streamCount + (event.open ? 1 : -1))
    const connected = isLiveConnected(entry)
    if (connected && !wasConnected) entry.connectedSince = now
    if (!connected) live.delete(event.device.id)
    if (connected !== wasConnected) {
      emit({ kind: 'device-connection', deviceId: event.device.id, deviceName: event.device.name, connected })
    }
  }

  /**
   * Diff the store's outstanding requests against what has been announced.
   * New ones get a received event and an expiry timer; ones the store no
   * longer lists get the phase that ended them. Every mutation path and every
   * expiry timer funnels through this one diff, so received always pairs
   * with exactly one terminal phase no matter which door the change came
   * through — and a request nobody answers still lapses visibly instead of
   * vanishing between reads.
   *
   * `answered` names the requests the CALLER just ended and how; anything
   * else that went missing lapsed if its deadline has passed, and was
   * otherwise cancelled underneath it (the listener stopping).
   */
  function announcePairRequests(answered?: { ids: Iterable<string>; phase: TailnetPairRequestPhase }): void {
    const answeredIds = new Set(answered?.ids ?? [])
    const outstanding = devices.listPairRequests()
    const outstandingIds = new Set(outstanding.map((request) => request.id))
    for (const request of outstanding) {
      if (announcedRequests.has(request.id)) continue
      const untilExpiry = Math.max(250, Date.parse(request.expiresAt) - Date.now() + 250)
      const timer = setTimeout(() => announcePairRequests(), untilExpiry)
      timer.unref?.()
      announcedRequests.set(request.id, {
        timer,
        deviceName: request.deviceName,
        peerNode: request.peerNode,
        expiresAt: request.expiresAt,
      })
      emit({
        kind: 'pair-request',
        phase: 'received',
        requestId: request.id,
        deviceName: request.deviceName,
        peerNode: request.peerNode,
      })
    }
    for (const [id, entry] of [...announcedRequests]) {
      if (outstandingIds.has(id)) continue
      clearTimeout(entry.timer)
      announcedRequests.delete(id)
      const lapsed = Date.parse(entry.expiresAt) <= Date.now()
      const phase: TailnetPairRequestPhase =
        answered && answeredIds.has(id) ? answered.phase : lapsed ? 'expired' : 'cancelled'
      emit({ kind: 'pair-request', phase, requestId: id, deviceName: entry.deviceName, peerNode: entry.peerNode })
    }
  }

  function loadSettings(): TailnetSettings {
    if (settings) return settings
    const read = readTailnetSettings(options.resolveUserDataDir())
    settings = read.settings
    if (read.error) {
      lastError = read.error
      options.log?.(read.error)
    }
    return settings
  }

  /**
   * Write the audit record for an answer given at this keyboard.
   *
   * The record is about the PEER that was granted or refused, so it carries
   * that identity rather than a local one — which is the fact anyone reading
   * the log later needs.
   */
  function auditAnswer(tool: string, request: TailnetPairRequest | undefined, scopes?: TailnetScope[]): void {
    if (!request) return
    options.onToolCall?.({
      context: {
        metadata: {
          kind: 'remote-tailnet',
          deviceName: request.deviceName,
          ...(request.peerNode ? { peerNode: request.peerNode } : {}),
        },
      },
      tool,
      args: {
        peerAddress: request.peerAddress,
        ...(scopes ? { scopes: scopes.join(', ') } : {}),
      },
      durationMs: 0,
    })
  }

  function getStatus(): TailnetRemoteStatus {
    const current = loadSettings()
    const bound = server?.address() ?? null
    return {
      enabled: current.enabled,
      running: server?.isRunning() ?? false,
      endpoint: bound ? formatEndpoint(bound.address, bound.port) : null,
      port: current.port,
      // The cached bind while the listener holds it; a live look only when
      // there is no listener to have cached one (the Settings knock).
      tailnetAddress: boundAddress ?? resolveBindAddress(),
      lastError,
      notifications: current.notifications,
      devices: devices.listDevices(),
      pairing: devices.getPairingState(),
      pairRequests: devices.listPairRequests(),
    }
  }

  /**
   * Start the listener. Resolves to whether a listener event was emitted, so
   * the caller can guarantee exactly one announcement per state change: a
   * refusal (no interface) and a failure (port taken) both announce
   * `running: false` with the reason — a window must learn at boot that the
   * port is taken, not when someone opens Settings.
   */
  async function startServer(): Promise<boolean> {
    if (server?.isRunning()) return false
    const current = loadSettings()
    if (!current.enabled) return false
    if ((options.insideWsl ?? isInsideWsl)() && process.env[TAILNET_IN_WSL_ENV] !== '1') {
      // Mirrored networking shows the PC's Tailscale address in here too, and
      // the Windows desktop already listens on it for this machine.
      lastError =
        'Remote control does not listen from inside WSL: the Windows desktop serves this PC on the tailnet, WSL chats included.'
      options.log?.(lastError)
      emit({ kind: 'listener', running: false, error: lastError })
      return true
    }
    const bindAddress = resolveBindAddress()
    if (!bindAddress) {
      // Explicit refusal, not a fallback to another interface: the whole point
      // of this listener is that it is reachable ONLY over the tailnet.
      //
      // A refusal, not a verdict: the interface may simply not be up YET, so
      // this also arms the watcher that binds the moment one appears.
      lastError =
        'Tailnet remote control is enabled but no Tailscale interface was found on this machine. Waiting for Tailscale to come up.'
      options.log?.(lastError)
      watchForInterface()
      emit({ kind: 'listener', running: false, error: lastError })
      return true
    }
    const next = createTailnetGatewayServer({
      bindAddress,
      port: current.port,
      serverName: options.serverName,
      serverVersion: options.serverVersion,
      resolveTools: options.resolveTools,
      ...(options.clientTools ? { clientTools: options.clientTools } : {}),
      isMutation: options.isMutation,
      devices,
      peers,
      conversations: options.conversations,
      // The files a device sends with a message, kept in Studio's own data
      // folder beside a browser's uploads, never in a project's folder.
      fileUploads: createTailnetFileUploads({ root: join(options.resolveUserDataDir(), TAILNET_UPLOADS_DIRNAME) }),
      ...(options.downscaleUpload ? { downscaleUpload: options.downscaleUpload } : {}),
      onToolCall: options.onToolCall,
      onPairRequested: () => announcePairRequests(),
      onReverseGrant: (input) => {
        options.onReverseGrant?.(input)
        // A both-ways pairing lands a machine in the mesh on THIS side without
        // any window having asked: the audit says so, like any other grant.
        options.onToolCall?.({
          context: {
            metadata: {
              kind: 'remote-tailnet',
              deviceName: input.askerName,
              ...(input.peerNode ? { peerNode: input.peerNode } : {}),
            },
          },
          tool: 'tailnet.reverse_grant',
          args: { endpoint: input.grant.endpoint, scopes: input.grant.scopes.join(', ') },
          durationMs: 0,
        })
      },
      onActivity: (event) => handleActivity(event),
      log: options.log,
    })
    try {
      await next.start()
      server = next
      boundAddress = bindAddress
      lastError = null
      // The beat goes on while the listener holds the address: it is what
      // notices the address leaving.
      watchForInterface()
      emit({ kind: 'listener', running: true })
    } catch (error) {
      await next.stop().catch(() => {})
      // A port already taken is not a "not yet": nothing about the interface
      // will change it, so the beat stops rather than re-announcing forever.
      stopWatchingForInterface()
      lastError = `Tailnet remote control failed to start: ${message(error)}`
      options.log?.(lastError)
      emit({ kind: 'listener', running: false, error: lastError })
    }
    return true
  }

  /**
   * The interface heartbeat, in BOTH directions: bind when Tailscale comes up,
   * and stand down when it goes away under a listener that is already bound.
   *
   * A poll rather than an OS interface event: `resolveTailnetInterface` reads
   * `os.networkInterfaces()`, Node has no portable "interface changed" signal,
   * and the check is cheap against a thirty-second beat. It stops itself when
   * the setting is turned off, so a machine that never runs Tailscale pays one
   * enumeration every half minute and nothing else.
   *
   * The stand-down half exists because nothing else notices: quitting
   * Tailscale takes the 100.64/10 address off the interface, but the socket
   * already bound to it stays open as far as Node is concerned, so
   * `isRunning()` kept answering true and every surface kept saying "Serving"
   * against a machine nothing could reach. Reported by the owner on
   * 2026-09-05, having disconnected Tailscale and watched the glyph stay green.
   */
  function watchForInterface(): void {
    if (interfaceWatch) return
    interfaceWatch = setInterval(() => {
      // Re-read rather than trust the closure: the setting can be turned off,
      // or another path can have started the listener, while this was waiting.
      if (!loadSettings().enabled) {
        stopWatchingForInterface()
        return
      }
      const address = resolveBindAddress()
      if (server?.isRunning()) {
        // A different address is the same fact as none: Tailscale came back on
        // a new one, and a socket bound to the old one reaches nobody. The
        // next beat binds the new address.
        if (boundAddress !== null && address !== boundAddress) void standDown()
        return
      }
      if (!address) return
      void startServer()
    }, interfaceWatchMs)
    // Never hold the process open for a listener that has not started.
    interfaceWatch.unref?.()
  }

  /**
   * Drop a listener whose interface went away, and keep watching for it to
   * come back. Distinct from `stopServer`, which is someone ASKING for the
   * listener to stop and therefore ends the watch too.
   */
  async function standDown(): Promise<void> {
    const current = server
    server = null
    boundAddress = null
    if (current) {
      try {
        await current.stop()
      } catch (error) {
        options.log?.(`Tailnet remote control could not close its listener cleanly: ${message(error)}`)
      }
    }
    // Whatever the gateway was holding cannot be holding it any more: the
    // address those sockets arrived on is gone.
    live.clear()
    lastError =
      'Tailnet remote control stopped: Tailscale is no longer up on this machine. Waiting for it to come back.'
    options.log?.(lastError)
    emit({ kind: 'listener', running: false, error: lastError })
  }

  function stopWatchingForInterface(): void {
    if (!interfaceWatch) return
    clearInterval(interfaceWatch)
    interfaceWatch = null
  }

  /** Stop the listener. Resolves to whether a listener event was emitted. */
  async function stopServer(): Promise<boolean> {
    stopWatchingForInterface()
    const current = server
    server = null
    boundAddress = null
    if (!current) return false
    try {
      await current.stop()
    } catch (error) {
      lastError = `Tailnet remote control failed to stop cleanly: ${message(error)}`
      options.log?.(lastError)
    }
    // The gateway's close path announced every socket teardown; whatever is
    // left is bookkeeping for a listener that no longer exists.
    live.clear()
    emit({ kind: 'listener', running: false, error: lastError })
    return true
  }

  return {
    async initialize(): Promise<TailnetRemoteStatus> {
      await startServer()
      return getStatus()
    },

    getStatus,

    async setEnabled(enabled): Promise<TailnetRemoteStatus> {
      const current = loadSettings()
      settings = { ...current, enabled: enabled === true }
      try {
        writeTailnetSettings(options.resolveUserDataDir(), settings)
        lastError = null
      } catch (error) {
        lastError = `Could not persist the tailnet remote setting: ${message(error)}`
        options.log?.(lastError)
      }
      let announced: boolean
      if (settings.enabled) announced = await startServer()
      else {
        // Turning it off also drops any outstanding pairing: a code minted for
        // a listener that no longer answers is a credential with no purpose.
        // The same for requests waiting to be answered — nobody can collect
        // an approval through a listener that is down, so they are cancelled
        // and said to be, rather than left answerable until they lapse.
        devices.cancelPairing()
        announcePairRequests({ ids: devices.cancelPairRequests(), phase: 'cancelled' })
        announced = await stopServer()
      }
      // Exactly one listener announcement per call: start/stop emit on every
      // transition, refusal, and failure, and this covers the remaining case —
      // the setting flipped while the listener state did not (enabling an
      // already-running listener, disabling one that never ran). Every other
      // window would otherwise keep a status this call just falsified.
      if (!announced) {
        emit(
          server?.isRunning()
            ? { kind: 'listener', running: true }
            : { kind: 'listener', running: false, error: lastError },
        )
      }
      return getStatus()
    },

    offerPairing(input): TailnetPairingOfferView {
      const requested = normalizeTailnetScopes(input?.scopes)
      // No scopes asked for means every scope.
      const scopes = requested.length > 0 ? requested : [...TAILNET_SCOPES]
      const offer = devices.offerPairing({ scopes, origin: input?.origin ?? { kind: 'code', by: null } })
      // The offer's existence (never its token) is status other windows show.
      emit({ kind: 'devices-changed' })
      const bound = server?.address() ?? null
      return {
        token: offer.token,
        scopes: offer.scopes,
        expiresAt: offer.expiresAt,
        // Null while the listener is down: a QR pointing at nothing is worse
        // than none, and the caller can see from the status why.
        pairingUrl: bound ? pairingUrl(bound.address, bound.port, offer.token) : null,
      }
    },

    grantReverseDevice(input) {
      const bound = server?.address() ?? null
      if (!bound) return null
      const minted = devices.mintDevice({
        name: input.machineName,
        scopes: input.scopes,
        origin: { kind: 'reverse', by: input.machineName },
        // Bound to the machine this one is asking to drive: it is the one that
        // will hold this token and dial back in with it.
        peer: input.peer ?? null,
      })
      emit({ kind: 'devices-changed' })
      return { ...minted, endpoint: formatEndpoint(bound.address, bound.port) }
    },

    approvePairRequest(input): TailnetApprovePairRequestResult {
      const requestId = typeof input.id === 'string' ? input.id : ''
      const answered = devices.listPairRequests().find((request) => request.id === requestId)
      const outcome = devices.approvePairRequest({
        id: requestId,
        scopes: normalizeTailnetScopes(input.scopes),
        code: input.code,
      })
      if (!outcome.ok) {
        if (outcome.code === 'code_mismatch') {
          if (outcome.declined) {
            // The third wrong code declined it: announced exactly as a
            // pressed Decline is, so every surface and the asker's poll agree.
            if (input.via !== 'tool') auditAnswer('tailnet.deny_pair_request', answered)
            announcePairRequests({ ids: [requestId], phase: 'denied' })
          }
          return {
            ok: false,
            code: 'code_mismatch',
            message: outcome.message,
            attemptsLeft: outcome.attemptsLeft,
            declined: outcome.declined,
            status: getStatus(),
          }
        }
        return { ok: false, code: outcome.code, message: outcome.message, status: getStatus() }
      }
      if (input.via !== 'tool') auditAnswer('tailnet.approve_pair_request', answered, outcome.device.scopes)
      // Approved from whichever surface answered; every other one hears it.
      announcePairRequests({ ids: [requestId], phase: 'approved' })
      emit({ kind: 'devices-changed' })
      // A new device changes what `tools/list` answers for it, and the panel
      // needs the device to appear in the same read that reports success.
      return { ok: true, device: outcome.device, status: getStatus() }
    },

    denyPairRequest(id, via): TailnetRemoteStatus {
      const requestId = typeof id === 'string' ? id : ''
      const answered = devices.listPairRequests().find((request) => request.id === requestId)
      const denied = devices.denyPairRequest(requestId)
      if (denied && via !== 'tool') auditAnswer('tailnet.deny_pair_request', answered)
      announcePairRequests(denied ? { ids: [requestId], phase: 'denied' } : undefined)
      return getStatus()
    },

    cancelPairing(): TailnetRemoteStatus {
      devices.cancelPairing()
      emit({ kind: 'devices-changed' })
      return getStatus()
    },

    revokeDevice(deviceId): TailnetRemoteStatus {
      devices.revokeDevice(deviceId)
      emit({ kind: 'devices-changed' })
      return getStatus()
    },

    updateDeviceScopes(deviceId, scopes): TailnetRemoteStatus {
      devices.updateDeviceScopes(typeof deviceId === 'string' ? deviceId : '', scopes)
      // What a device may do changed, so what `tools/list` answers for it did
      // too — and every window showing the row needs the new set.
      emit({ kind: 'devices-changed' })
      server?.notifyToolsListChanged()
      return getStatus()
    },

    listPeers(): Promise<TailnetPeerScan> {
      // The configured port, not the bound one: discovery probes the port THIS
      // machine would use, which is the convention the other machines follow.
      // A scan works with the local listener off — you can look for somewhere
      // to connect to without having opened your own door.
      return peerScanner.scan({ port: loadSettings().port })
    },

    resolvePeerName(address): Promise<string | null> {
      return peers.resolve(address)
    },

    resolvePeerIdentity(address): Promise<TailnetPeerIdentity | null> {
      return peers.identify(address)
    },

    getLiveState,

    notifyToolsListChanged(): void {
      server?.notifyToolsListChanged()
    },

    notifyWorkspacesChanged(): void {
      server?.notifyWorkspacesChanged()
    },

    notifyConversationsChanged(): void {
      server?.notifyConversationsChanged()
    },

    async shutdown(): Promise<void> {
      // A request for a listener that is going away cannot be collected;
      // say so (the same `cancelled` a stop announces) before the timers go.
      const cancelled = devices.cancelPairRequests()
      if (cancelled.length > 0) announcePairRequests({ ids: cancelled, phase: 'cancelled' })
      for (const [, entry] of announcedRequests) clearTimeout(entry.timer)
      announcedRequests.clear()
      stopWatchingForInterface()
      await stopServer()
    },
  }
}

/** IPv6 literals need brackets before a port; IPv4 must not have them. */
export function formatEndpoint(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
}

/**
 * One scannable string carrying everything a client needs to pair: where to
 * reach the listener, and the one-time code. A custom scheme rather than an
 * http URL so scanning it in a browser cannot accidentally spend the code.
 */
export function pairingUrl(address: string, port: number, token: string): string {
  const query = new URLSearchParams({ endpoint: formatEndpoint(address, port), token })
  return `sprintengine-tailnet://pair?${query.toString()}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
