import { randomBytes } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { createFilesystemReadHandlers } from '../../main/filesystem-read'
import { createFilesystemWatchSearchHandlers } from '../../main/filesystem-watch-search-handlers'
import { GitHubTokenStore } from '../../main/github-token-store'
import type { StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import { createWorkspaceBackupService } from '../../main/workspace-backup'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import { registerServerDomainIpc, type ServerDomainIpcHandles } from '../desktop/server-ipc'
import { createIpcTunnel } from '../ipc/ipc-tunnel'
import { writeFileAtomicSync } from '../platform/atomic-file'
import type { LocalClientBus } from '../platform/client-bus'
import type { StudioAuthenticator } from '../rpc/studio-rpc-types'
import {
  WEB_BROWSE_FOLDERS_CHANNEL,
  WEB_DEVICES_APPROVE_CHANNEL,
  WEB_DEVICES_CHANGED_CHANNEL,
  WEB_DEVICES_DECLINE_CHANNEL,
  WEB_DEVICES_LINK_CHANNEL,
  WEB_DEVICES_RENAME_CHANNEL,
  WEB_DEVICES_REVOKE_CHANNEL,
  WEB_DEVICES_STATUS_CHANNEL,
  type WebDevicesStatus,
  WEB_EMBEDS_CREATE_CHANNEL,
  WEB_EMBEDS_LIST_CHANNEL,
  WEB_EMBEDS_REVOKE_CHANNEL,
  WEB_PREVIEWS_CHANGED_CHANNEL,
  WEB_PREVIEWS_CLOSE_CHANNEL,
  WEB_PREVIEWS_LIST_CHANNEL,
  WEB_PREVIEWS_OPEN_CHANNEL,
} from '../../shared/web-client'
import { createPreviewService } from './preview-service'
import { createPairRequests } from './web-pair-requests'
import { guardWebTunnelPort } from './web-tunnel-guard'
import { toolError, toolSuccess } from '../../shared/modules/mcp-tools'
import { browseFolders, type FolderBrowserInput } from './folder-browser'
import { createWebListener, type WebListener } from './web-listener'
import { createWebSessionStore, type WebSessionStore } from './web-sessions'
import { openWebStaticRoot, type WebStaticRoot } from './web-static'
import { createEmbedRoutes } from './embed-routes'
import { createEmbedStore, gateEmbedFrames, type EmbedCreateInput, type EmbedStore } from './embeds'
import { WEB_RUN_FILENAME, readWebRunFile, type WebRunFile } from './web-run-file'
import { serveWebOnTailnet, type WebTailscaleServe } from './web-tailscale-serve'
import { createWebUploads } from './web-uploads'

// The web client's side of a standalone server (phase 9): the web listener,
// the browser sessions it admits, and what a web tab reaches through it. Off
// unless `studio-server serve --web` asks for it, so a server nobody opened a
// browser to answers no HTTP at all.
//
// A web tab is Studio's own renderer in a browser. It reaches the server two
// ways, both over the listener and both behind its session cookie:
//
// - the Studio protocol (`/ws`), which the chat view rides as it does in a
//   desktop window;
// - the `window.api` domains the server owns, over the same IPC tunnel the
//   desktop's windows use when the server runs out of process (`/ws/ipc`,
//   owner sessions only). Phase 10 turns those channels into protocol methods
//   one domain at a time; until then the tunnel is how the renderer's
//   workspace list, launch settings and the rest reach a server it does not
//   share a process with.
//
// The run file (`run/web.json`, 0600 in the owner-only `run/`) says where the
// listener is and holds the key `studio-server pair` mints a code with: being
// able to read it is being this server's owner on this machine.

export type WebFrontDoorOptions = {
  port: number
  publicOrigins: readonly string[]
  devOrigin?: string | null
  /** Where `build:web` wrote the bundle. */
  staticDir: string | null
  /** Third-party renderer modules on the web (R61): off unless the owner switches them on. */
  thirdPartyModules?: boolean
  /** Publish the listener on the tailnet over HTTPS with `tailscale serve`, on this port (R19). */
  tailscaleServe?: { port: number } | null
}

export type WebFrontDoor = {
  listener: WebListener
  sessions: WebSessionStore
  url: string
  stop(): Promise<void>
}

/** The authenticator an embed's socket says hello under: its ticket was the proof, and the embed is read live. */
export function embedAuthenticator(embeds: EmbedStore, embedId: string): StudioAuthenticator {
  const clientId = `embed:${embedId}`
  return {
    authenticate() {
      const grant = embeds.grantFor(embedId)
      return grant ? { ok: true, grant } : { ok: false, message: 'This embed was revoked or has expired.' }
    },
    grantFor: (id) => (id === clientId ? embeds.grantFor(embedId) : null),
    onRevoked: (listener) =>
      embeds.onRevoked((revoked) => {
        if (revoked === embedId) listener(clientId)
      }),
    onGrantChanged: () => () => undefined,
  }
}

/** The authenticator a session's socket says hello under: the cookie was the proof, at the upgrade. */
export function sessionAuthenticator(sessions: WebSessionStore, sessionId: string): StudioAuthenticator {
  const clientId = `web:${sessionId}`
  return {
    authenticate() {
      const grant = sessions.grantFor(sessionId)
      return grant
        ? { ok: true, grant }
        : { ok: false, message: 'This browser’s pairing was removed or has expired. Pair it again.' }
    },
    grantFor: (id) => (id === clientId ? sessions.grantFor(sessionId) : null),
    onRevoked: (listener) =>
      sessions.onRevoked((revoked) => {
        if (revoked === sessionId) listener(clientId)
      }),
    onGrantChanged: () => () => undefined,
    recordSeen: () => sessions.recordSeen(sessionId),
  }
}

export async function startWebFrontDoor(input: {
  core: StudioCore
  gateway: StudioGateway
  rpc: StudioRpcService
  clients: LocalClientBus
  environmentId: string
  version: string
  options: WebFrontDoorOptions
  log?: (message: string) => void
}): Promise<WebFrontDoor> {
  const { core, gateway, rpc } = input
  const dataDir = core.platform.paths.dataDir()
  const sessions = createWebSessionStore({ dataDir, environmentId: input.environmentId, log: input.log })

  // The tunnel's clients are web tabs. Everything the server publishes to its
  // clients reaches them as the push it is in a desktop window.
  const tunnel = createIpcTunnel({ log: input.log })
  const stopForwarding = input.clients.subscribe((topic, payload, target) => tunnel.publish(topic, payload, target))
  let domains: ServerDomainIpcHandles | null = null
  domains = registerServerDomainIpc(tunnel.registry as unknown as Parameters<typeof registerServerDomainIpc>[0], {
    core,
    gateway,
    studioRpc: rpc,
    githubTokenStore: new GitHubTokenStore(),
    workspaceBackup: createWorkspaceBackupService({
      resolveUserDataDir: () => dataDir,
      readRegistry: () => core.workspaceRegistry.getState(),
      minRegistryIntervalMs: 10_000,
    }),
    // No terminals on the web (ruling a): a chat is not handed to one.
    terminalHandoff: async () => ({ ok: false, message: 'Terminals are not available in a browser.' }),
    files: { ...createFilesystemWatchSearchHandlers(), ...createFilesystemReadHandlers() },
    // The cookie checked at the upgrade is the check: only an owner's session reaches the tunnel.
    assertAppSender: () => undefined,
  })

  // The web tab's own channels, beside the domains every window reaches.
  // A tailnet browser chooses among the workspaces the server knows (spec 6.5).
  tunnel.registry.handle(WEB_BROWSE_FOLDERS_CHANNEL, (event, request: FolderBrowserInput) =>
    onLoopback(event)
      ? browseFolders(request ?? {})
      : { ok: false, message: 'Folders are browsed from a browser on the machine Studio runs on.' },
  )

  // Previews: an agent's dev server on an origin of its own, per session.
  // Each tab's tunnel belongs to the session whose cookie opened it.
  const sessionOfClient = new Map<string, string>()
  // The loopback name each tab was opened on: its previews open on the same one.
  const loopbackNameOfClient = new Map<string, '127.0.0.1' | 'localhost'>()
  let listenerPort: number | null = null
  const previews = createPreviewService({
    ownPorts: () => (listenerPort === null ? [] : [listenerPort]),
    studioOrigins: () => (listenerPort === null ? [] : listener.origins()),
    log: input.log,
  })
  const sessionFor = (event: { caller: { clientId: string } }): string => {
    const sessionId = sessionOfClient.get(event.caller.clientId)
    if (!sessionId) throw new Error('This tab is not paired with Studio.')
    return sessionId
  }
  // A folder Studio already has a workspace for, spelled as that workspace has it.
  const isWorkspaceFolder = (folderPath: string): boolean => {
    const plain = (path: string) => path.replace(/[\\/]+$/u, '')
    const asked = plain(folderPath)
    return core.workspaceRegistry
      .getRecords()
      .some((record) => !!record.folderPath && plain(record.folderPath) === asked)
  }
  const onLoopback = (event: { caller: { clientId: string } }): boolean =>
    sessions.get(sessionOfClient.get(event.caller.clientId) ?? '')?.route === 'loopback'
  // A preview exposes the server's loopback to the device, so a tailnet
  // browser does not open one (R77: not granted to tailnet pairings by default).
  tunnel.registry.handle(WEB_PREVIEWS_LIST_CHANNEL, (event) => {
    sessionFor(event)
    return onLoopback(event) ? previews.list() : { ports: [] }
  })
  tunnel.registry.handle(WEB_PREVIEWS_OPEN_CHANNEL, (event, request: { port?: unknown; typed?: unknown } | null) =>
    onLoopback(event)
      ? previews.open({
          port: request?.port,
          sessionId: sessionFor(event),
          typed: request?.typed === true,
          name: loopbackNameOfClient.get(event.caller.clientId) ?? '127.0.0.1',
        })
      : { ok: false, message: 'Previews open in a browser on the machine Studio runs on.' },
  )
  tunnel.registry.handle(WEB_PREVIEWS_CLOSE_CHANNEL, (event, request: { previewId?: unknown } | null) =>
    typeof request?.previewId === 'string' ? previews.close(request.previewId, sessionFor(event)) : false,
  )
  const stopPreviewPushes = previews.onChanged((sessionId, open) => {
    for (const [clientId, owner] of sessionOfClient) {
      if (owner === sessionId) tunnel.publish(WEB_PREVIEWS_CHANGED_CHANNEL, open, { clientId })
    }
  })
  // A removed browser's previews close with it.
  const stopPreviewRevocations = sessions.onRevoked((sessionId) => void previews.closeSession(sessionId))
  // A removed browser's uploads go with it.
  const uploads = createWebUploads({ dataDir })
  const stopUploadRevocations = sessions.onRevoked((sessionId) => uploads.forgetSession(sessionId))

  // Devices: the browsers paired here, and the ones asking by approval.
  const pairRequests = createPairRequests({ sessions })
  const devicesStatus = (clientId?: string): WebDevicesStatus => {
    const current = clientId ? sessionOfClient.get(clientId) : undefined
    return {
      devices: sessions.list().map((session) => ({
        id: session.id,
        name: session.name,
        route: session.route,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        current: session.id === current,
      })),
      requests: pairRequests.pending(),
      origins: listener.origins(),
    }
  }
  const announceDevices = () => {
    for (const clientId of sessionOfClient.keys())
      tunnel.publish(WEB_DEVICES_CHANGED_CHANNEL, devicesStatus(clientId), { clientId })
  }
  const stopRequestPushes = pairRequests.onChanged(announceDevices)
  const stopRevokePushes = sessions.onChanged(announceDevices)
  tunnel.registry.handle(WEB_DEVICES_STATUS_CHANNEL, (event) => devicesStatus(event.caller.clientId))
  tunnel.registry.handle(WEB_DEVICES_REVOKE_CHANNEL, (_event, request: { id?: unknown } | null) =>
    typeof request?.id === 'string' ? sessions.revoke(request.id) : false,
  )
  tunnel.registry.handle(WEB_DEVICES_RENAME_CHANNEL, (_event, request: { id?: unknown; name?: unknown } | null) => {
    return (
      typeof request?.id === 'string' && typeof request.name === 'string' && sessions.rename(request.id, request.name)
    )
  })
  // A pairing link for another browser, on one of this server's own origins.
  tunnel.registry.handle(WEB_DEVICES_LINK_CHANNEL, (_event, request: { origin?: unknown } | null) => {
    const origin =
      typeof request?.origin === 'string' && listener.origins().includes(request.origin) ? request.origin : undefined
    return listener.pairingUrl(origin)
  })
  tunnel.registry.handle(
    WEB_DEVICES_APPROVE_CHANNEL,
    (_event, request: { requestId?: unknown; code?: unknown } | null) =>
      typeof request?.requestId === 'string' && typeof request.code === 'string'
        ? pairRequests.approve(request.requestId, request.code)
        : { ok: false, message: 'Name the request and the code it shows.' },
  )
  tunnel.registry.handle(WEB_DEVICES_DECLINE_CHANNEL, (_event, request: { requestId?: unknown } | null) =>
    typeof request?.requestId === 'string' ? pairRequests.decline(request.requestId) : false,
  )

  // Embeds: one conversation, read-only, framed by the pages their owner named.
  const embeds = createEmbedStore({ dataDir, log: input.log })
  tunnel.registry.handle(WEB_EMBEDS_CREATE_CHANNEL, (_event, request: EmbedCreateInput & { origin?: unknown }) => {
    const created = embeds.create(request ?? { conversation: {} })
    if (!created.ok) return created
    const base =
      typeof request?.origin === 'string' && listener.origins().includes(request.origin) ? request.origin : null
    return {
      ok: true,
      embed: created.embed,
      token: created.token,
      url: `${base ?? listener.origins()[0]}/embed/conversation/${created.embed.embedId}#token=${created.token}`,
    }
  })
  tunnel.registry.handle(WEB_EMBEDS_LIST_CHANNEL, () => embeds.list())
  tunnel.registry.handle(WEB_EMBEDS_REVOKE_CHANNEL, (_event, request: { embedId?: unknown } | null) =>
    typeof request?.embedId === 'string' ? embeds.revoke(request.embedId) : false,
  )
  const stopEmbedRevocations = embeds.onRevoked((embedId) => listener.closeEmbedSockets(embedId))
  // A session or an embed that runs out is pruned when its store is next
  // read, and the prune is what closes its sockets with 4401. A tab's tunnel
  // reads no store per frame, so the stores are read once a minute: what ran
  // out is closed within a minute of it, whether anything else asks or not.
  const expiry = setInterval(() => {
    sessions.list()
    embeds.list()
  }, 60_000)
  expiry.unref()

  const mintKey = randomBytes(32).toString('base64url')
  let staticRoot: WebStaticRoot | null = null
  const listener = createWebListener({
    sessions,
    staticRoot: (staticRoot =
      input.options.staticDir && existsSync(input.options.staticDir)
        ? openWebStaticRoot(input.options.staticDir)
        : null),
    port: input.options.port,
    publicOrigins: input.options.publicOrigins,
    devOrigin: input.options.devOrigin ?? null,
    mintKey,
    pairRequests,
    uploads,
    version: input.version,
    thirdPartyModules: () => input.options.thirdPartyModules === true,
    studio: {
      connect(stream, who) {
        if ('session' in who) {
          rpc.connectWeb(stream, {
            authenticator: sessionAuthenticator(sessions, who.session.id),
            ownWindow: who.session.owner,
          })
          return
        }
        if (who.ticket.kind === 'session') {
          rpc.connectWeb(stream, {
            authenticator: sessionAuthenticator(sessions, who.ticket.sessionId),
            ownWindow: false,
            // A browser on the tailnet searches only the folders Studio knows.
            knownFoldersOnly: sessions.get(who.ticket.sessionId)?.route !== 'loopback',
          })
          return
        }
        const embed = embeds.get(who.ticket.embedId)
        if (!embed) {
          stream.destroy()
          return
        }
        // Read-only by its grant, and held to its one conversation by the gate.
        rpc.connectWeb(gateEmbedFrames(stream, embed.conversation), {
          authenticator: embedAuthenticator(embeds, embed.embedId),
          ownWindow: false,
        })
      },
    },
    tunnel: {
      attach: (client, port, session, origin) => {
        sessionOfClient.set(client.clientId, session.id)
        loopbackNameOfClient.set(client.clientId, new URL(origin).hostname === 'localhost' ? 'localhost' : '127.0.0.1')
        // What a tab may reach is the web client's share, and what it changes is audited.
        tunnel.attach(
          client,
          guardWebTunnelPort(port, {
            audit: (entry) =>
              gateway.gatewayAudit().record({
                connection: {
                  kind: 'studio-client',
                  clientId: `web:${session.id}`,
                  clientName: `Browser: ${session.name}`,
                },
                tool: entry.channel,
                durationMs: entry.durationMs,
                args: entry.workspaceId ? { workspaceId: entry.workspaceId } : {},
                result: entry.ok ? toolSuccess({ ok: true }) : toolError('failed', 'The call did not succeed.'),
              }),
            log: input.log,
            ...(session.route === 'loopback' ? {} : { knownFolder: isWorkspaceFolder }),
          }),
        )
      },
      detach: (clientId) => {
        sessionOfClient.delete(clientId)
        loopbackNameOfClient.delete(clientId)
        tunnel.detach(clientId)
      },
    },
    extraRoutes: [
      createEmbedRoutes({
        embeds,
        sessions,
        staticRoot: () => staticRoot,
        pageHeaders: (origin, frameAncestors) => listener.pageHeaders(origin, frameAncestors),
        mintKey,
      }),
    ],
    log: input.log,
  })
  const { port } = await listener.start()
  listenerPort = port
  const url = `http://127.0.0.1:${port}`

  let tailnet: WebTailscaleServe | null = null
  if (input.options.tailscaleServe) {
    try {
      tailnet = await serveWebOnTailnet({
        localPort: port,
        servePort: input.options.tailscaleServe.port,
        runDir: join(dataDir, 'run'),
        log: input.log,
      })
    } catch (error) {
      await listener.stop().catch(() => undefined)
      throw error
    }
    listener.addTailscaleServeOrigin(tailnet.origin)
  }

  const runFile = join(dataDir, 'run', WEB_RUN_FILENAME)
  const body: WebRunFile = { pid: process.pid, port, url, origins: listener.origins(), mintKey }
  writeFileAtomicSync(runFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, exactMode: true })

  return {
    listener,
    sessions,
    url,
    async stop() {
      clearInterval(expiry)
      stopForwarding()
      stopPreviewPushes()
      stopPreviewRevocations()
      stopUploadRevocations()
      stopEmbedRevocations()
      stopRequestPushes()
      stopRevokePushes()
      await tailnet?.stop().catch(() => undefined)
      await previews.stop()
      await listener.stop()
      for (const client of tunnel.clients()) tunnel.detach(client.clientId)
      await domains?.conversationCommands.dispose().catch(() => undefined)
      domains = null
      // Only this run's file: another server may have written its own since.
      if (readWebRunFile(dataDir)?.pid === process.pid) {
        try {
          unlinkSync(runFile)
        } catch {
          // Already gone.
        }
      }
    },
  }
}
