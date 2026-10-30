import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { STUDIO_PROTOCOL_MIN_SUPPORTED, STUDIO_PROTOCOL_VERSION } from '../../../packages/studio-protocol/src/public'
import { secretsMatch } from '../../main/automation/tailnet/secret-hash'
import type { TunnelClient, TunnelPort } from '../ipc/ipc-tunnel'
import { gateWebRequest, normalizeOrigin, requestOrigin, type WebOriginPolicy } from './web-origins'
import {
  AUTHENTICATED_HEADERS,
  cookieValues,
  pageHeaders,
  readBody,
  sendJson,
  sendText,
  serializeCookie,
} from './web-http'
import type { WebRoute, WebSession, WebSessionStore, WebTicketSubject } from './web-sessions'
import { WEB_PAIRING_FAILED } from './web-sessions'
import type { PairRequests } from './web-pair-requests'
import {
  WEB_CLOSE_REVOKED,
  acceptWebSocket,
  refuseUpgrade,
  tunnelPortOf,
  webSocketKeyOf,
  webSocketStream,
  type WebSocketPeer,
} from './web-socket'
import { resolveStaticFile, serveStaticFile, type WebStaticRoot } from './web-static'
import type { WebUploads } from './web-uploads'

// The web listener: the Studio server's HTTP door for browsers (phase 9 spec,
// 3.1, 6.2 to 6.4). Off unless the owner turns it on; bound to loopback only.
// Off loopback it is reached through `tailscale serve`, which terminates HTTPS
// in front of it (R19), never as plain HTTP on a tailnet address.
//
//   GET  /.well-known/sprintengine-studio   who this is (no auth)
//   GET  /assets/*, /fonts/*, other files    the web bundle (no auth; cached)
//   GET  /pair                               the pairing page (no auth)
//   POST /pair/exchange                      a one-time code for a session cookie
//   POST /pair/mint                          a pairing code, for `studio-server pair` (the run file's key)
//   POST /pair/request                       ask to pair by approval; answers the six digits to show
//   POST /pair/request/collect               poll an approval; answers the session cookie once
//   GET  /api/session                        the session this cookie holds
//   POST /api/logout                         forget this browser
//   GET  /, any app route                    the app (session, else to /pair)
//   WS   /ws                                 the Studio protocol (cookie, or ?ticket=)
//   WS   /ws/ipc                             the window.api domains the server owns (owner cookie)
//
// Every request names this listener in `Host`; every upgrade and every
// request that is not a GET carries one of its origins exactly (web-origins).
// No GET changes anything.

const MAX_JSON_BODY_BYTES = 16 * 1024

export type WebStudioAttach = {
  /** Serve a Studio protocol connection over this stream for a browser session or a ticket's subject. */
  connect(stream: Duplex, who: { session: WebSession } | { ticket: WebTicketSubject }): void
}

export type WebTunnelAttach = {
  /** A tab's tunnel, the browser session it belongs to, and the origin the tab was opened on. */
  attach(client: TunnelClient, port: TunnelPort, session: WebSession, origin: string): void
  detach(clientId: string): void
}

/** A route a later part of the server adds (the embed's pages, previews' entry), tried before the app's fallback. */
export type WebExtraRoute = (context: {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  origin: string
  session: () => WebSession | null
}) => boolean | Promise<boolean>

export type WebListenerOptions = {
  sessions: WebSessionStore
  staticRoot: WebStaticRoot | null
  /** Port 0 picks one. */
  port: number
  publicOrigins: readonly string[]
  /** The renderer dev server, accepted as an origin and proxied to only with `--dev`. */
  devOrigin?: string | null
  /** A secret only a process that can read the run file holds: what `studio-server pair` proves itself with. */
  mintKey: string
  studio: WebStudioAttach
  tunnel?: WebTunnelAttach | null
  /** Pairing by approval: a browser asks, the owner types the digits it shows. */
  pairRequests?: PairRequests | null
  /** Files an owner's tab drops into a message, saved on the server for the agent to read by path. */
  uploads?: WebUploads | null
  /** Whether third-party renderer modules are on for the web (R61): their scripts are `blob:` URLs. */
  thirdPartyModules?: () => boolean
  version: string
  extraRoutes?: readonly WebExtraRoute[]
  log?: (message: string) => void
}

export type WebListener = {
  start(): Promise<{ port: number }>
  stop(): Promise<void>
  port(): number | null
  /** The origins this listener answers as (loopback names first). */
  origins(): string[]
  /** Close every socket an embed's tickets opened, with 4401: it was revoked or ran out. */
  closeEmbedSockets(embedId: string): void
  /** The page headers for a document this listener serves, framed only by `frameAncestors`. */
  pageHeaders(origin: string, frameAncestors?: readonly string[]): Record<string, string>
  /** A pairing URL for a fresh code, on the given origin (loopback by default). */
  pairingUrl(origin?: string): { url: string; expiresAt: string }
  /**
   * Add the HTTPS origin `tailscale serve` publishes this listener at, once
   * this server has set serve up itself: it becomes one of the listener's
   * origins. Serve's identity headers are not read from it: this listener is
   * on loopback, where any local program can send serve's name in `Host` and
   * any login it likes beside it.
   */
  addTailscaleServeOrigin(origin: string): void
}

function pathOf(request: IncomingMessage): URL {
  // The host is checked separately; this only parses the path and query.
  return new URL(request.url ?? '/', 'http://listener.invalid')
}

/**
 * The page with the server's OS in a meta tag, which the tab's `window.api`
 * reads as its `hostPlatform` before anything renders (phase 9 spec, 3.3).
 */
function withHostPlatform(html: string): string {
  return html.replace('<head>', `<head>\n    <meta name="sprintengine-host-platform" content="${process.platform}" />`)
}

function routeOf(host: string, policy: WebOriginPolicy): WebRoute {
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/u.test(host.toLowerCase())
  return loopback ? 'loopback' : policy.publicOrigins.length > 0 ? 'tailnet' : 'loopback'
}

export function createWebListener(options: WebListenerOptions): WebListener {
  let server: Server | null = null
  let boundPort: number | null = null
  // Every socket a session holds, so a revocation closes them at once.
  const socketsBySession = new Map<string, Set<WebSocketPeer>>()
  const stopRevocations = options.sessions.onRevoked((sessionId) => {
    for (const peer of socketsBySession.get(sessionId) ?? []) peer.close(WEB_CLOSE_REVOKED, 'This browser was removed.')
    socketsBySession.delete(sessionId)
  })

  let publicOrigins: readonly string[] = options.publicOrigins

  const policy = (): WebOriginPolicy => ({
    port: boundPort ?? options.port,
    publicOrigins,
    devOrigin: options.devOrigin ?? null,
  })

  function hold(sessionId: string, peer: WebSocketPeer): void {
    let set = socketsBySession.get(sessionId)
    if (!set) socketsBySession.set(sessionId, (set = new Set()))
    set.add(peer)
    peer.onClose(() => set.delete(peer))
  }

  function sessionOf(request: IncomingMessage): WebSession | null {
    return options.sessions.authenticate(cookieValues(request, options.sessions.cookieName))
  }

  function headersForPage(origin: string, frameAncestors?: readonly string[]): Record<string, string> {
    return pageHeaders({ origin, blobScripts: options.thirdPartyModules?.() === true, frameAncestors })
  }

  function sendPage(response: ServerResponse, html: string, origin: string): void {
    response.writeHead(200, {
      ...headersForPage(origin),
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(html)),
    })
    response.end(html)
  }

  function cookieIsSecure(origin: string): boolean {
    const url = new URL(origin)
    return url.protocol === 'https:' || url.hostname === 'localhost'
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? ''
    const url = pathOf(request)
    const method = request.method ?? 'GET'
    const originHeader = typeof request.headers.origin === 'string' ? request.headers.origin : undefined

    // `studio-server pair` and `embed` (and its `--list`, `--revoke`): a program on this machine that read the run file.
    // It sends no `Origin` (a browser always would on a POST), and its key is
    // the proof; the Host check below still applies.
    const minting = method === 'POST' && /^\/(pair\/mint|embed\/(mint|list|revoke))$/u.test(url.pathname)
    const gate = gateWebRequest(
      { method, host, origin: originHeader, upgrade: false, ticket: minting && originHeader === undefined },
      policy(),
    )
    if (!gate.ok && !(minting && gate.code === 'origin_required')) {
      sendText(response, gate.status, gate.code)
      return
    }
    const origin = requestOrigin(host, policy())

    if (minting && url.pathname === '/pair/mint') {
      const presented = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1] ?? ''
      if (originHeader !== undefined || !secretsMatch(presented, options.mintKey)) {
        sendJson(response, 403, { ok: false, message: 'Not allowed.' })
        return
      }
      sendJson(response, 200, { ok: true, ...listener.pairingUrl() })
      return
    }

    if (url.pathname === '/.well-known/sprintengine-studio' && (method === 'GET' || method === 'HEAD')) {
      sendJson(response, 200, {
        product: 'SprintEngine Studio',
        version: options.version,
        protocolVersion: STUDIO_PROTOCOL_VERSION,
        minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
        pair: '/pair',
        socket: '/ws',
      })
      return
    }

    if (url.pathname === '/pair/exchange' && method === 'POST') {
      let code = ''
      try {
        const body = JSON.parse((await readBody(request, MAX_JSON_BODY_BYTES)).toString('utf8')) as { code?: unknown }
        code = typeof body.code === 'string' ? body.code : ''
      } catch {
        sendJson(response, 400, { ok: false, message: WEB_PAIRING_FAILED })
        return
      }
      const exchanged = options.sessions.exchange(code, {
        userAgent: request.headers['user-agent'] ?? null,
        route: routeOf(host, policy()),
      })
      if (!exchanged.ok) {
        sendJson(response, 400, { ok: false, message: exchanged.message })
        return
      }
      const maxAge = (Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000
      sendJson(
        response,
        200,
        { ok: true, session: exchanged.session },
        {
          'Set-Cookie': serializeCookie(options.sessions.cookieName, exchanged.secret, {
            secure: cookieIsSecure(origin),
            maxAgeSeconds: maxAge,
          }),
        },
      )
      return
    }

    if (url.pathname === '/pair/request' && method === 'POST' && options.pairRequests) {
      let name: unknown
      try {
        name = (JSON.parse((await readBody(request, MAX_JSON_BODY_BYTES)).toString('utf8')) as { name?: unknown }).name
      } catch {
        name = undefined
      }
      const created = options.pairRequests.create({
        name,
        userAgent: request.headers['user-agent'] ?? null,
        route: routeOf(host, policy()),
      })
      sendJson(response, created.ok ? 200 : 429, created)
      return
    }

    if (url.pathname === '/pair/request/collect' && method === 'POST' && options.pairRequests) {
      let body: { requestId?: unknown; collect?: unknown } = {}
      try {
        body = JSON.parse((await readBody(request, MAX_JSON_BODY_BYTES)).toString('utf8')) as typeof body
      } catch {
        // An empty answer below.
      }
      const collected =
        typeof body.requestId === 'string' && typeof body.collect === 'string'
          ? options.pairRequests.collect(body.requestId, body.collect)
          : ({ status: 'expired' } as const)
      if (collected.status !== 'approved') {
        sendJson(response, 200, collected)
        return
      }
      const maxAge = (Date.parse(collected.session.expiresAt) - Date.now()) / 1000
      sendJson(
        response,
        200,
        { status: 'approved', session: collected.session },
        {
          'Set-Cookie': serializeCookie(options.sessions.cookieName, collected.secret, {
            secure: cookieIsSecure(origin),
            maxAgeSeconds: maxAge,
          }),
        },
      )
      return
    }

    if (url.pathname === '/api/session' && method === 'GET') {
      const session = sessionOf(request)
      if (!session) {
        sendJson(response, 401, { ok: false, message: 'This browser is not paired.' })
        return
      }
      options.sessions.recordSeen(session.id)
      sendJson(response, 200, {
        ok: true,
        session,
        version: options.version,
        build: options.staticRoot?.buildId() ?? null,
      })
      return
    }

    if (url.pathname === '/api/upload' && method === 'POST' && options.uploads) {
      const session = sessionOf(request)
      if (!session?.owner) {
        sendJson(response, session ? 403 : 401, { ok: false, message: 'Only a paired owner browser can upload.' })
        return
      }
      const saved = await options.uploads.save({ sessionId: session.id, name: url.searchParams.get('name'), request })
      sendJson(response, saved.ok ? 200 : saved.status, saved)
      return
    }

    if (url.pathname === '/api/logout' && method === 'POST') {
      const session = sessionOf(request)
      if (session) options.sessions.revoke(session.id)
      sendJson(
        response,
        200,
        { ok: true },
        {
          'Set-Cookie': serializeCookie(options.sessions.cookieName, '', {
            secure: cookieIsSecure(origin),
            maxAgeSeconds: 0,
          }),
        },
      )
      return
    }

    for (const route of options.extraRoutes ?? []) {
      if (await route({ request, response, url, origin, session: () => sessionOf(request) })) return
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
      sendText(response, 404, 'not_found')
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'method_not_allowed', { Allow: 'GET, HEAD' })
      return
    }

    const root = options.staticRoot
    if (!root) {
      sendText(response, 503, 'This server was built without the web client (npm run build:web).')
      return
    }

    // The pairing page's links are relative to `/pair`: under `/pair/` they
    // would name `/pair/assets/…`, which no file answers.
    if (url.pathname === '/pair/') {
      response.writeHead(302, { ...AUTHENTICATED_HEADERS, Location: '../pair', 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (url.pathname === '/pair') {
      const file = resolveStaticFile(root.directory, '/pair.html')
      if (!file) {
        sendText(response, 503, 'This server was built without the pairing page (npm run build:web).')
        return
      }
      serveStaticFile(request, response, file, '/pair.html', headersForPage(origin))
      return
    }

    // The bundle's own files. HTML among them is a page and carries a page's
    // headers; the app's index is not reachable this way without a session.
    const file = url.pathname === '/' ? null : resolveStaticFile(root.directory, url.pathname)
    if (file && !file.endsWith('index.html')) {
      serveStaticFile(
        request,
        response,
        file,
        url.pathname,
        url.pathname === '/canvas-worker.html'
          ? // The canvas worker runs in a hidden frame of the app's own page
            // (phase 9 spec, 3.8): framed by this origin, and by nothing else.
            { ...headersForPage(origin, ["'self'"]), 'X-Frame-Options': 'SAMEORIGIN' }
          : file.endsWith('.html')
            ? headersForPage(origin)
            : { 'Cross-Origin-Resource-Policy': 'same-origin' },
      )
      return
    }
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
      sendText(response, 404, 'not_found')
      return
    }

    // Any other path is an app route: the app, for a paired browser.
    const session = sessionOf(request)
    if (!session) {
      // Relative, for a server reached under a path of its own, and back to
      // its root first: from `/a/b`, `./pair` would be `/a/pair`, an app
      // route that redirects to itself.
      const toRoot = '../'.repeat(Math.max(0, url.pathname.split('/').length - 2)) || './'
      response.writeHead(302, { ...AUTHENTICATED_HEADERS, Location: `${toRoot}pair`, 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    options.sessions.recordSeen(session.id)
    const html = root.indexHtml()
    if (!html) {
      sendText(response, 503, 'This server was built without the web client (npm run build:web).')
      return
    }
    sendPage(response, withHostPlatform(html), origin)
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined)
    const url = pathOf(request)
    const ticket = url.searchParams.get('ticket')
    const gate = gateWebRequest(
      {
        method: request.method ?? 'GET',
        host: request.headers.host,
        origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
        upgrade: true,
        // Only where a ticket is what admits the socket: `/ws/ipc` admits by
        // the cookie alone, so a `?ticket=` there must not stand in for an Origin.
        ticket: ticket !== null && url.pathname === '/ws',
      },
      policy(),
    )
    if (!gate.ok) return refuseUpgrade(socket, gate.status, gate.code)
    const key = webSocketKeyOf(request)
    if (!key.ok) return refuseUpgrade(socket, 400, key.code)

    if (url.pathname === '/ws') {
      if (ticket !== null) {
        const subject = options.sessions.redeemTicket(ticket)
        if (!subject) return refuseUpgrade(socket, 401, 'ticket_spent_or_expired')
        const peer = acceptWebSocket(socket, key.key, head)
        hold(subject.kind === 'session' ? subject.sessionId : `embed:${subject.embedId}`, peer)
        options.studio.connect(webSocketStream(peer), { ticket: subject })
        return
      }
      const session = sessionOf(request)
      if (!session) return refuseUpgrade(socket, 401, 'unauthorized')
      const peer = acceptWebSocket(socket, key.key, head)
      hold(session.id, peer)
      options.studio.connect(webSocketStream(peer), { session })
      return
    }

    if (url.pathname === '/ws/ipc') {
      const tunnel = options.tunnel
      if (!tunnel) return refuseUpgrade(socket, 404, 'not_found')
      // The tunnelled domains are the owner's: they have no scopes of their own.
      const session = sessionOf(request)
      if (!session) return refuseUpgrade(socket, 401, 'unauthorized')
      if (!session.owner) return refuseUpgrade(socket, 403, 'owner_required')
      const peer = acceptWebSocket(socket, key.key, head)
      hold(session.id, peer)
      const windowId = url.searchParams.get('windowId')
      const clientId = `web-${session.id.slice(0, 8)}-${randomBytes(6).toString('hex')}`
      tunnel.attach(
        {
          clientId,
          windowId: windowId && /^[\w-]{1,64}$/u.test(windowId) ? windowId : null,
          kind: 'web-tab',
          workspaceWindow: true,
        },
        tunnelPortOf(peer),
        session,
        requestOrigin(request.headers.host ?? '', policy()),
      )
      peer.onClose(() => tunnel.detach(clientId))
      return
    }

    refuseUpgrade(socket, 404, 'not_found')
  }

  const listener: WebListener = {
    async start() {
      if (server) return { port: boundPort ?? options.port }
      const next = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          options.log?.(`web listener: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) sendText(response, 500, 'internal_error')
          else response.destroy()
        })
      })
      next.on('upgrade', (request, socket, head) => {
        try {
          handleUpgrade(request, socket, head)
        } catch (error) {
          options.log?.(`web listener upgrade: ${error instanceof Error ? error.message : String(error)}`)
          refuseUpgrade(socket, 400, 'internal_error')
        }
      })
      // Slow-header and whole-request limits for a listener any local page
      // can reach. The request limit is a whole upload's: 50 MB from a phone
      // on the tailnet takes minutes, and Node has no limit per route. Every
      // other body is a few kilobytes, read with a cap.
      next.headersTimeout = 20_000
      next.requestTimeout = 10 * 60_000
      await new Promise<void>((resolve, reject) => {
        next.once('error', reject)
        next.listen({ host: '127.0.0.1', port: options.port }, () => {
          next.removeListener('error', reject)
          resolve()
        })
      })
      next.on('error', (error) => options.log?.(`web listener error: ${error.message}`))
      const address = next.address()
      boundPort = typeof address === 'object' && address ? address.port : options.port
      server = next
      return { port: boundPort }
    },
    async stop() {
      stopRevocations()
      const current = server
      server = null
      for (const set of socketsBySession.values()) for (const peer of set) peer.close(1001, 'Studio is closing.')
      socketsBySession.clear()
      if (!current) return
      await new Promise<void>((resolve) => {
        current.close(() => resolve())
        current.closeAllConnections()
      })
    },
    port: () => boundPort,
    closeEmbedSockets(embedId) {
      const key = `embed:${embedId}`
      for (const peer of socketsBySession.get(key) ?? []) peer.close(WEB_CLOSE_REVOKED, 'This embed was revoked.')
      socketsBySession.delete(key)
    },
    pageHeaders: (origin, frameAncestors) =>
      pageHeaders({ origin, blobScripts: options.thirdPartyModules?.() === true, frameAncestors }),
    origins: () => {
      const port = boundPort ?? options.port
      return [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        ...publicOrigins.flatMap((origin) => normalizeOrigin(origin) ?? []),
      ]
    },
    addTailscaleServeOrigin(origin) {
      const normalized = normalizeOrigin(origin)
      if (!normalized?.startsWith('https://')) throw new Error(`Not an HTTPS origin: ${origin}`)
      if (!publicOrigins.includes(normalized)) publicOrigins = [...publicOrigins, normalized]
    },
    pairingUrl(origin) {
      const base = origin ?? `http://127.0.0.1:${boundPort ?? options.port}`
      const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/u.test(base)
      const minted = options.sessions.mintPairingCode({ route: isLoopback ? 'loopback' : 'tailnet' })
      return { url: `${base}/pair#code=${minted.code}`, expiresAt: minted.expiresAt }
    },
  }
  return listener
}
