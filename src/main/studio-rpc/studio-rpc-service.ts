import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { toolError, toolSuccess } from '../../shared/modules/mcp-tools'
import {
  STUDIO_LOCAL_APPS_CHANGED_CHANNEL,
  type StudioLocalAppOfferView,
  type StudioLocalAppToolReach,
  type StudioLocalAppsStatus,
} from '../../shared/studio-local-apps'
import type { AppIdentity } from '../../server/platform/app-identity'
import type { ClientBus } from '../../server/platform/client-bus'
import { studioPlatform } from '../../server/platform/platform'
import type { StudioPaths } from '../../server/platform/studio-paths'
import {
  createTicketAuthenticator,
  framePortStream,
  mintStudioTicket,
  type StudioFramePort,
} from '../../server/rpc/studio-frame-port'
import { inProcessStudioTransport } from '../../server/rpc/studio-in-process-port'
import { STUDIO_SCOPES, type StudioGrant } from '../../../packages/studio-protocol/src/public'
import type { StudioTransportFactory } from '../../../packages/agent-sdk/src/transport'
import {
  createStudioRpcServer,
  type StudioRpcServer,
  type StudioRpcServerOptions,
} from '../../server/rpc/studio-rpc-server'
import type { ClientToolRegistry } from '../../server/tools/client-tool-registry'
import type { StudioFiles } from '../../server/rpc/studio-files'
import type { StudioPullRequests } from '../../server/pull-requests/pull-request-domain'
import type { StudioLocalServers } from '../../server/local-servers/local-server-domain'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioChatBackend,
  StudioConversationBackend,
} from '../../server/rpc/studio-rpc-types'
import type { GatewayAuditStore } from '../automation/gateway-audit'
import { createResyncBackoff } from '../automation/tailnet/tailnet-conversation-stream'
import { createStudioLocalAppStore, type StudioLocalAppStore } from './studio-local-app-store'

// The Studio RPC inside the running app: the owner socket in <userData>/run,
// the paired local apps it admits, and the Settings front door that pairs and
// revokes them. Started with the app and stopped with it; a listener that
// cannot start (another Studio on this profile, a directory someone else owns)
// is reported in Settings and changes nothing else the app does.
//
// Studio's own windows reach the same RPC over a port each, which main hands
// them (`connectWindow`). That way in does not depend on the socket: a window
// connects whether or not the listener started, and keeps its connection
// while the socket is down.

export const STUDIO_ENVIRONMENT_FILENAME = 'studio-environment.json'
const REFUSAL_WINDOW_MS = 60_000
const REFUSALS_PER_WINDOW = 5

export type StudioRpcService = {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): StudioLocalAppsStatus
  /** Mint a one-time pairing code for an app, named and scoped in Settings. */
  offer(input: unknown): StudioLocalAppOfferView
  cancelOffer(id: unknown): StudioLocalAppsStatus
  /**
   * Revoke an app: its token, its connections, its toolset names and every
   * approval that allows one of its tools. The revocation itself is done when
   * this returns; the approvals are forgotten by the time it settles.
   */
  revoke(id: unknown): Promise<StudioLocalAppsStatus>
  /** Change which agents an app's tools reach. */
  setToolReach(id: unknown, reach: unknown): StudioLocalAppsStatus
  /** This run's owner credential, for the desktop's own client. Never written to disk. */
  ownerToken(): string
  /**
   * Serve a window over a port main holds the other end of. The answer names
   * the connection and the ticket its hello must present, once, within thirty
   * seconds; nothing longer-lived reaches the window.
   */
  connectWindow(port: StudioFramePort): { connectionId: string; ticket: string }
  /**
   * Serve the desktop's shell over a port main holds the other end of, when
   * the server runs in a process of its own (phase 6, 6.3): the shell role,
   * for a ticket good once, as `shellTransport` gives it in process.
   */
  connectShell(port: StudioFramePort): { connectionId: string; ticket: string }
  /**
   * Serve a WSL distribution's front door over a byte stream that already
   * proved it holds the owner token (phase 7): the shell role, as
   * `connectShell` serves the desktop's, for a ticket good once.
   */
  connectShellStream(stream: Duplex): { connectionId: string; ticket: string }
  /**
   * Serve a browser's socket from the web listener (phase 9): a web tab that
   * proved its session cookie at the upgrade, or a client that spent a
   * ticket. The authenticator is the session's or the ticket's; `ownWindow`
   * is true only for an owner's web tab, which is the app's own chat view in a
   * browser and asks what a window asks.
   */
  connectWeb(
    stream: Duplex,
    input: { authenticator: StudioAuthenticator; ownWindow: boolean; knownFoldersOnly?: boolean },
  ): { connectionId: string }
  /** The chat surface, from the handlers the app's own IPC serves its windows with. */
  provideChat(chat: StudioChatBackend): void
  /** Which agents a paired app's tools reach. */
  toolReachOf(clientId: string): StudioLocalAppToolReach
  /**
   * Connections for the desktop's own shell, in this process: each is served
   * as the shell (it may offer the built-in toolsets) and says hello with a
   * ticket minted for it alone.
   */
  shellTransport(): StudioTransportFactory
}

// Paths, the version and the push to Settings come from the Studio platform
// (src/server/platform), read when used, so the service runs unchanged on the
// Electron platform now and on a standalone server's later. No secret is
// sealed here: a paired app's token is kept only as its hash, which needs no
// cipher, and the owner token is never written down at all.
export type StudioRpcServiceOptions = {
  /** Defaults to the installed platform's: `dataDir` is where `run/` and the paired apps live. */
  paths?: Pick<StudioPaths, 'dataDir'>
  /** Defaults to the installed platform's: the version a welcome and the discovery file name. */
  identity?: AppIdentity
  /**
   * Defaults to the installed platform's. Every change to the paired apps is
   * published on `STUDIO_LOCAL_APPS_CHANGED_CHANNEL` with fresh status.
   */
  clients?: ClientBus
  /** Where this Studio runs, as its welcome says: `local` unless its server was started in WSL or over SSH. */
  hostKind?: StudioRpcServerOptions['hostKind']
  /** Built on first start: the conversation host it wraps is constructed late in the app's composition. */
  backend: () => StudioConversationBackend
  /** The gateway's audit, so one file records every listener's mutations. */
  audit: () => GatewayAuditStore
  /** The client toolsets the gateway lists to agents, offered over this RPC. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots, for owners (`files-write`). */
  files?: StudioFiles
  /** The pull requests the conversations opened, for owners (`pull-requests`). */
  pullRequests?: StudioPullRequests
  /** The local servers the conversations started, for owners (`local-servers`). */
  localServers?: StudioLocalServers
  /** Forget the saved approvals that allow a revoked app's tools. */
  forgetToolApprovals?: (toolsets: string[]) => Promise<unknown>
  log?: (message: string) => void
  /** A socket path or pipe name of the caller's choosing (tests). */
  socketPath?: string
  now?: () => number
}

/**
 * The id this data directory is known by to every client, minted the first
 * time it is asked for and kept for good, so a client that reaches this
 * Studio by two routes recognises it as one.
 */
export function readStudioEnvironmentId(userDataDir: string): string {
  const path = join(userDataDir, STUDIO_ENVIRONMENT_FILENAME)
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }
    if (typeof stored.id === 'string' && /^[0-9a-f-]{36}$/.test(stored.id)) return stored.id
  } catch {
    // Absent or unreadable: minted below.
  }
  const id = randomUUID()
  writeFileSync(path, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return id
}

/** The grant the desktop's own shell holds: the owner's, under the app's name. */
function shellGrant(): StudioGrant {
  return { clientId: 'owner', name: 'SprintEngine Studio', owner: true, scopes: [...STUDIO_SCOPES], ceiling: 'bypass' }
}

export function createStudioRpcService(options: StudioRpcServiceOptions): StudioRpcService {
  const dataDir = () => (options.paths ?? studioPlatform().paths).dataDir()
  const version = () => (options.identity ?? studioPlatform().identity).version()
  const clients = () => options.clients ?? studioPlatform().clients
  const now = options.now ?? Date.now
  let store: StudioLocalAppStore | null = null
  // Built on first need (a window connecting, or the socket starting) and kept
  // for the run: its router holds the receipts and uploads every way in shares.
  let server: StudioRpcServer | null = null
  let chat: StudioChatBackend | null = null
  let lastError: string | null = null
  let starting: Promise<void> | null = null

  const appStore = (): StudioLocalAppStore => {
    if (!store) {
      store = createStudioLocalAppStore({ resolveUserDataDir: dataDir, log: options.log })
      store.onChanged(() => announce())
      // What an app offers, and whether it is connected, shows on its row.
      options.tools?.subscribe(() => announceSoon())
    }
    return store
  }

  function status(): StudioLocalAppsStatus {
    const connected = new Set(
      (server?.connections() ?? []).map((connection) => connection.clientId()).filter((id) => id !== null),
    )
    return {
      running: server?.isRunning() ?? false,
      socketPath: server?.socketPath() ?? null,
      lastError,
      apps: appStore()
        .list()
        .map((app) => ({
          ...app,
          connected: connected.has(app.id),
          toolsets: options.tools?.toolsetsOf(app.id) ?? [],
        })),
      offers: appStore().offers(),
    }
  }
  let announcing = false
  /** A burst of offers and withdrawals is one push to Settings. */
  function announceSoon(): void {
    if (announcing) return
    announcing = true
    setImmediate(() => {
      announcing = false
      announce()
    })
  }
  function announce(): void {
    try {
      clients().publish(STUDIO_LOCAL_APPS_CHANGED_CHANNEL, status())
    } catch (error) {
      options.log?.(`Local apps push failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function authenticator(apps: StudioLocalAppStore): StudioAuthenticator {
    return {
      authenticate(auth) {
        if ('pairingCode' in auth) {
          const redeemed = apps.redeem(auth.pairingCode)
          return redeemed.ok
            ? { ok: true, grant: redeemed.grant, pairingToken: redeemed.token }
            : { ok: false, message: redeemed.message }
        }
        const grant = apps.authenticate(auth.token)
        return grant
          ? { ok: true, grant }
          : {
              ok: false,
              message: 'This app is not paired with Studio, or its pairing was revoked. Pair it again in Settings.',
            }
      },
      grantFor: (clientId) => apps.grantFor(clientId),
      onRevoked: (listener) => apps.onRevoked(listener),
      // A grant is fixed at pairing; it changes only by revocation.
      onGrantChanged: () => () => undefined,
      recordSeen: (clientId) => apps.recordSeen(clientId),
    }
  }

  // One record per mutation and per refusal at the door, into the gateway's
  // own audit: the app is the connection, the conversation and command id the
  // targets. A message's text never reaches it.
  // Refused credentials are kept, but not without bound: a process looping on a
  // bad token would otherwise rotate the 2 MB log and push out the records it
  // exists for. A few per minute are written; the rest are counted, and the
  // count rides on the next one written.
  const refusals = { windowStart: Number.NEGATIVE_INFINITY, written: 0, suppressed: 0 }
  function admitRefusal(): number | null {
    const at = now()
    if (at - refusals.windowStart >= REFUSAL_WINDOW_MS) {
      refusals.windowStart = at
      refusals.written = 0
    }
    if (refusals.written >= REFUSALS_PER_WINDOW) {
      refusals.suppressed++
      return null
    }
    refusals.written++
    const suppressed = refusals.suppressed
    refusals.suppressed = 0
    return suppressed
  }

  function audit(entry: StudioAuditEntry & { suppressed?: number }): void {
    if (entry.tool === 'studio.auth_refused') {
      const suppressed = admitRefusal()
      if (suppressed === null) return
      if (suppressed > 0) entry = { ...entry, suppressed }
    }
    options.audit().record({
      connection: {
        kind: 'studio-client',
        ...(entry.clientId ? { clientId: entry.clientId } : {}),
        clientName: entry.clientName,
      },
      tool: entry.tool,
      durationMs: entry.durationMs,
      args: {
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        ...(entry.commandId ? { id: entry.commandId } : {}),
        ...(entry.suppressed ? { suppressed: entry.suppressed } : {}),
        ...(entry.toolset ? { toolset: entry.toolset } : {}),
        ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
      },
      result: entry.ok
        ? toolSuccess({ ok: true })
        : toolError(entry.code ?? 'refused', 'The Studio RPC request was not carried out.'),
    })
  }

  // Pairing and revoking are the serving Studio's. One whose socket did not
  // start (another Studio serves this profile) would write the same store
  // under it, and its codes could never be redeemed here.
  function assertServing(): void {
    if (!server?.isRunning())
      throw new Error('This Studio is not serving the local app socket, so it cannot pair or revoke apps.')
  }

  function hub(): StudioRpcServer {
    if (server) return server
    const directory = dataDir()
    server = createStudioRpcServer({
      dataDir: directory,
      version: version(),
      environmentId: readStudioEnvironmentId(directory),
      ...(options.hostKind ? { hostKind: options.hostKind } : {}),
      backend: options.backend(),
      chat: () => chat,
      authenticator: authenticator(appStore()),
      audit,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.files ? { files: options.files } : {}),
      ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
      ...(options.localServers ? { localServers: options.localServers } : {}),
      resyncRetryAfterMs: createResyncBackoff(),
      onConnectionsChanged: () => announce(),
      ...(options.socketPath ? { socketPath: options.socketPath } : {}),
      log: options.log,
    })
    return server
  }

  async function startNow(): Promise<void> {
    try {
      await hub().start()
      lastError = null
    } catch (error) {
      lastError = `The local app socket did not start: ${error instanceof Error ? error.message : String(error)}`
      options.log?.(lastError)
    }
    announce()
  }

  return {
    start() {
      if (server?.isRunning()) return Promise.resolve()
      starting ??= startNow().finally(() => {
        starting = null
      })
      return starting
    },
    async stop() {
      await starting
      await server?.stop()
    },
    getStatus: status,
    // Pairing and revoking are recorded too: they decide who may connect.
    offer(input) {
      assertServing()
      const { offer, code } = appStore().offer(input)
      audit({ clientId: null, clientName: offer.name, tool: 'studio.settings.pairing_code', ok: true, durationMs: 0 })
      return { offer, code, status: status() }
    },
    cancelOffer(id) {
      if (typeof id === 'string') appStore().cancelOffer(id)
      return status()
    },
    // The revocation is carried out before this returns, and a Studio that is
    // not serving refuses at once; only the approvals are forgotten after.
    revoke(id) {
      assertServing()
      if (typeof id !== 'string') return Promise.resolve(status())
      const clientName =
        appStore()
          .list()
          .find((app) => app.id === id)?.name ?? id
      // Read before the revocation, which releases them.
      const held = options.tools?.toolsetsOf(id).map((toolset) => toolset.name) ?? []
      let revoked = false
      try {
        revoked = appStore().revoke(id)
      } catch (error) {
        audit({
          clientId: id,
          clientName,
          tool: 'studio.settings.revoke',
          ok: false,
          code: 'write_failed',
          durationMs: 0,
        })
        throw error
      }
      if (revoked) audit({ clientId: id, clientName, tool: 'studio.settings.revoke', ok: true, durationMs: 0 })
      // Its names are released, and the approvals that allowed its tools go
      // with them: a later app that takes a name inherits no "always allow".
      const released = [...new Set([...held, ...(options.tools?.forgetClient(id) ?? [])])]
      return (async () => {
        if (released.length)
          try {
            await options.forgetToolApprovals?.(released)
          } catch (error) {
            options.log?.(
              `The approvals for a revoked app's tools could not be forgotten: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        return status()
      })()
    },
    setToolReach(id, reach) {
      assertServing()
      if (typeof id !== 'string' || (reach !== 'own' && reach !== 'all')) return status()
      if (appStore().setToolReach(id, reach)) options.tools?.refresh()
      return status()
    },
    ownerToken: () => appStore().ownerToken(),
    connectWindow(port) {
      const ticket = mintStudioTicket()
      const connection = hub().attach(framePortStream(port), {
        authenticator: createTicketAuthenticator(ticket),
        // The window is the app's own chat view: shown conversations as its
        // IPC shows them, and its actions are not a client's to audit.
        ownWindow: true,
      })
      return { connectionId: connection.connectionId, ticket }
    },
    connectShell(port) {
      const ticket = mintStudioTicket()
      const connection = hub().attach(framePortStream(port), {
        authenticator: createTicketAuthenticator(ticket, { grant: shellGrant }),
        ownWindow: false,
        shell: true,
      })
      return { connectionId: connection.connectionId, ticket }
    },
    connectShellStream(stream) {
      const ticket = mintStudioTicket()
      const connection = hub().attach(stream, {
        authenticator: createTicketAuthenticator(ticket, { grant: shellGrant }),
        ownWindow: false,
        shell: true,
      })
      return { connectionId: connection.connectionId, ticket }
    },
    connectWeb(stream, input) {
      // A browser is a client of this server, whatever view it draws: audited.
      const connection = hub().attach(stream, {
        authenticator: input.authenticator,
        ownWindow: input.ownWindow,
        audited: true,
        ...(input.knownFoldersOnly ? { knownFoldersOnly: true } : {}),
      })
      return { connectionId: connection.connectionId }
    },
    provideChat(next) {
      chat = next
    },
    toolReachOf: (clientId) => appStore().toolReachOf(clientId),
    shellTransport() {
      return async () => {
        const ticket = mintStudioTicket()
        return inProcessStudioTransport(
          (stream) => {
            hub().attach(stream, {
              authenticator: createTicketAuthenticator(ticket, { grant: shellGrant }),
              ownWindow: false,
              shell: true,
            })
          },
          () => ({ token: ticket }),
        )()
      }
    },
  }
}
