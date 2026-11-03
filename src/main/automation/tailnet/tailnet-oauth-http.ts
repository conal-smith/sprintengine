import { randomBytes } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import type { McpToolCallEvent } from '../mcp-dispatch'
import { hashSecret, secretsMatch } from './secret-hash'
import {
  checkRedirectUri,
  OAUTH_PENDING_AUTHORIZATION_TTL_MS,
  PKCE_S256_CHALLENGE_SHAPE,
  readScopeParameter,
  redirectUriRegistered,
  type OAuthPendingAuthorization,
  type TailnetOAuthStore,
} from './tailnet-oauth'
import type { TailnetDeviceStore } from './tailnet-devices'
import type { TailnetPeerIdentity } from './tailnet-peer-identity'
import {
  TAILNET_MCP_PATH,
  TAILNET_OAUTH_AUTHORIZE_PATH,
  TAILNET_OAUTH_REGISTER_PATH,
  TAILNET_OAUTH_REVOKE_PATH,
  TAILNET_OAUTH_TOKEN_PATH,
  TAILNET_OAUTH_WAIT_PATH,
} from './tailnet-routes'

// The HTTP face of Studio's OAuth authorization server, for the MCP endpoint
// (the state it keeps is `tailnet-oauth.ts`). Served on the tailnet listener,
// and on the loopback listener Tailscale Serve fronts with HTTPS.
//
// Discovery follows the MCP authorization spec: a 401 from the MCP endpoint
// names the protected resource metadata (RFC 9728), which names this server
// as its authorization server, whose metadata (RFC 8414) names the endpoints
// below. Every URL in those documents is built on the origin the client
// itself used — the Host it sent, checked against the names this Studio
// answers to — so a client that came in over https://<node>.ts.net is told
// https://<node>.ts.net throughout, and one on the tailnet address is told
// that. A Host this Studio does not answer to is refused (421) rather than
// echoed: a name that resolves here without being this machine's is how a web
// page rebinds DNS onto a tailnet listener.
//
// The sign-in page approves nothing. It raises a pair request (the same one a
// machine asking to pair raises, marked as a sign-in), shows the six digits
// the person types into the Studio window to allow it, and refreshes itself
// until that window has answered; only then does it send the browser back to
// the client, with a code or with the refusal. Nothing on the page, and no
// request to this server, can say yes.

const MAX_FORM_BYTES = 16 * 1024
const MAX_STATE_LENGTH = 2048
/** How often the sign-in page asks again while it waits for the Studio window. */
const WAIT_REFRESH_SECONDS = 2
/** Sign-ins one peer may start a minute. A retry replaces the last; this stops a loop doing it forever. */
const AUTHORIZE_PER_PEER_PER_MINUTE = 6

/** Which listener a request arrived on: the tailnet address, or loopback behind Tailscale Serve. */
export type TailnetListenerKind = 'tailnet' | 'serve'

/** The origins this Studio answers to, by listener. The first tailnet origin is the one named when Host is not one of them. */
export type TailnetPublicOrigins = { tailnet: string[]; serve: string | null }

export type TailnetOAuthRequestContext = {
  via: TailnetListenerKind
  /** The calling node's tailnet address as the transport proved it. */
  peerAddress: string
  identify: () => Promise<TailnetPeerIdentity | null>
}

export type TailnetOAuthHttp = {
  /** Answer `request` if it is one of the OAuth routes; resolves false for any other path. */
  handle(request: IncomingMessage, response: ServerResponse, context: TailnetOAuthRequestContext): Promise<boolean>
  /** The origin a request came in on, if it is one of this Studio's. */
  originFor(request: IncomingMessage, via: TailnetListenerKind): string | null
  /** The origin named when a request's own is unknown. */
  primaryOrigin(via: TailnetListenerKind): string | null
  /** Every resource identifier this Studio's MCP endpoint answers to, canonical. */
  resources(): Set<string>
}

export function createTailnetOAuthHttp(options: {
  store: TailnetOAuthStore
  devices: TailnetDeviceStore
  origins: () => TailnetPublicOrigins
  /** A sign-in was asked for: the surfaces that answer pair requests refresh. */
  onPairRequested?: () => void
  onToolCall?: (event: McpToolCallEvent) => void
  now?: () => number
  log?: (message: string) => void
}): TailnetOAuthHttp {
  const now = options.now ?? (() => Date.now())
  const authorizeAttempts = new Map<string, number[]>()

  function originsFor(via: TailnetListenerKind): string[] {
    const known = options.origins()
    return via === 'serve' ? (known.serve ? [known.serve] : []) : known.tailnet
  }

  function originFor(request: IncomingMessage, via: TailnetListenerKind): string | null {
    const host = typeof request.headers.host === 'string' ? request.headers.host.trim() : ''
    if (!host) return null
    const candidate = canonicalOrigin(`${via === 'serve' ? 'https' : 'http'}://${host}`)
    if (!candidate) return null
    return originsFor(via).find((origin) => canonicalOrigin(origin) === candidate) ?? null
  }

  function resources(): Set<string> {
    const known = options.origins()
    const all = [...known.tailnet, ...(known.serve ? [known.serve] : [])]
    return new Set(
      all.flatMap((origin) => [canonicalOrigin(origin) ?? origin]).map((origin) => `${origin}${TAILNET_MCP_PATH}`),
    )
  }

  /** The MCP resource a `resource` parameter names, if it is this Studio's (its origin or its MCP endpoint). */
  function ownResource(value: string): string | null {
    const canonical = canonicalResource(value)
    if (!canonical) return null
    const ours = resources()
    if (ours.has(canonical)) return canonical
    const withPath = `${canonical}${TAILNET_MCP_PATH}`
    return ours.has(withPath) ? withPath : null
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: TailnetOAuthRequestContext,
  ): Promise<boolean> {
    const url = parseUrl(request.url)
    const path = url.pathname
    const method = request.method ?? 'GET'
    const route = ROUTES.get(path)
    if (!route) return false
    if (!route.methods.includes(method)) {
      response.setHeader('Allow', route.methods.join(', '))
      writeJson(response, 405, {
        error: 'invalid_request',
        error_description: `${path} answers ${route.methods.join(' and ')}.`,
      })
      return true
    }
    const origin = originFor(request, context.via)
    if (!origin) {
      const named = originsFor(context.via)
      const answer = {
        error: 'invalid_request',
        error_description: `This Studio does not answer to that host name. Address it as ${named.join(' or ') || 'its tailnet address'}.`,
      }
      if (route.kind === 'page') writePage(response, 421, misdirectedPage(named))
      else writeJson(response, 421, answer)
      return true
    }
    switch (route.kind) {
      case 'resource-metadata':
        writeJson(response, 200, {
          resource: `${origin}${TAILNET_MCP_PATH}`,
          authorization_servers: [origin],
          scopes_supported: [...TAILNET_SCOPES],
          bearer_methods_supported: ['header'],
          resource_name: 'SprintEngine Studio',
        })
        return true
      case 'server-metadata':
        writeJson(response, 200, serverMetadata(origin))
        return true
      case 'register':
        await register(request, response)
        return true
      case 'page':
        if (path === TAILNET_OAUTH_AUTHORIZE_PATH) await authorize(url, response, context, origin)
        else wait(url, response)
        return true
      case 'token':
        await token(request, response, context)
        return true
      case 'revoke':
        await revoke(request, response)
        return true
    }
  }

  async function register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, response, 'json')
    if (body === undefined) return
    const outcome = options.store.registerClient(body)
    if (!outcome.ok) {
      writeJson(response, outcome.status ?? 400, { error: outcome.error, error_description: outcome.description })
      return
    }
    writeJson(response, 201, {
      client_id: outcome.client.clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: outcome.client.clientName,
      redirect_uris: outcome.client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  }

  async function authorize(
    url: URL,
    response: ServerResponse,
    context: TailnetOAuthRequestContext,
    origin: string,
  ): Promise<void> {
    const query = url.searchParams
    const repeated = AUTHORIZE_PARAMS.find((name) => query.getAll(name).length > 1)
    const clientId = query.get('client_id') ?? ''
    if (!clientId)
      return writePage(response, 400, errorPage('The sign-in link names no client.', 'It has no client_id.'))
    const client = options.store.clientFor(clientId)
    if (!client)
      return writePage(
        response,
        400,
        errorPage(
          'Studio does not know this client.',
          'Remove this server from the client and add it again, so it registers with this Studio afresh.',
        ),
      )
    const asked = query.get('redirect_uri')
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null)
    if (!redirectUri)
      return writePage(
        response,
        400,
        errorPage(
          'The sign-in link names no return address.',
          'It has no redirect_uri, and the client registered more than one.',
        ),
      )
    if (!redirectUriRegistered(redirectUri, client.redirectUris))
      return writePage(
        response,
        400,
        errorPage(
          'The sign-in link returns somewhere the client did not register.',
          'Studio sends a sign-in only back to an address the client registered, so this one is not followed.',
        ),
      )
    const redirectKind = checkRedirectUri(redirectUri)!
    // From here the return address is known good, so errors go back to the
    // client as RFC 6749 4.1.2.1 has them, where it can say what went wrong.
    const rawState = query.get('state')
    const state = rawState !== null && rawState.length <= MAX_STATE_LENGTH ? rawState : null
    const refuse = (error: string, description: string): void =>
      redirect(response, redirectUri, { error, error_description: description, state, iss: origin })
    if (repeated) return refuse('invalid_request', `${repeated} is given more than once.`)
    if (rawState !== null && state === null) return refuse('invalid_request', 'state is too long.')
    if (query.get('response_type') !== 'code')
      return refuse('unsupported_response_type', 'Only response_type=code is offered.')
    const challenge = query.get('code_challenge') ?? ''
    if (!challenge)
      return refuse('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.')
    if (query.get('code_challenge_method') !== 'S256')
      return refuse('invalid_request', 'Only code_challenge_method=S256 is offered.')
    if (!PKCE_S256_CHALLENGE_SHAPE.test(challenge))
      return refuse('invalid_request', 'code_challenge is not an S256 challenge.')
    const named = query.get('resource')
    const resource = named === null ? `${canonicalOrigin(origin) ?? origin}${TAILNET_MCP_PATH}` : ownResource(named)
    if (!resource) return refuse('invalid_target', 'resource is not this Studio’s MCP endpoint.')
    const requested = readScopeParameter(query.get('scope'))
    const scopes: TailnetScope[] = requested.length > 0 ? requested : [...TAILNET_SCOPES]

    if (!allowAttempt(context.peerAddress))
      return refuse(
        'temporarily_unavailable',
        'Too many sign-ins were started from this machine just now. Wait a minute.',
      )
    const peer = await context.identify()
    const key = randomBytes(24).toString('base64url')
    const raised = options.devices.requestPairing({
      deviceName: client.clientName,
      peerNode: peer?.name ?? null,
      peerAddress: context.peerAddress,
      peer,
      collectHash: hashSecret(key),
      requestedScopes: scopes,
      oauth: {
        clientName: client.clientName,
        redirectHost: redirectKind.host,
        redirectKind: redirectKind.kind,
      },
    })
    if (!raised.ok) {
      if (raised.code === 'denied_recently') return refuse('access_denied', raised.message)
      return refuse('temporarily_unavailable', raised.message)
    }
    const pending: OAuthPendingAuthorization = {
      requestId: raised.request.id,
      keyHash: hashSecret(key),
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      state,
      codeChallenge: challenge,
      resource,
      issuer: origin,
      expiresAtMs: now() + OAUTH_PENDING_AUTHORIZATION_TTL_MS,
    }
    options.store.beginAuthorization(pending)
    // Audited as a pair request is: a stranger asking for access is a
    // security event whether or not anyone approves it.
    options.onToolCall?.({
      context: {
        metadata: {
          kind: 'remote-tailnet',
          deviceName: client.clientName,
          ...(peer?.name ? { peerNode: peer.name } : {}),
        },
      },
      tool: 'tailnet.oauth_authorize',
      args: {
        clientId: client.clientId,
        redirectHost: redirectKind.host,
        peerAddress: context.peerAddress,
        scopes: scopes.join(', '),
      },
      durationMs: 0,
    })
    options.onPairRequested?.()
    const next = new URL(TAILNET_OAUTH_WAIT_PATH, `${origin}/`)
    next.searchParams.set('id', raised.request.id)
    next.searchParams.set('key', key)
    response.statusCode = 303
    response.setHeader('Location', `${next.pathname}${next.search}`)
    setPageHeaders(response)
    response.end()
  }

  function wait(url: URL, response: ServerResponse): void {
    const id = url.searchParams.get('id') ?? ''
    const key = url.searchParams.get('key') ?? ''
    const pending = id ? options.store.pendingAuthorization(id) : null
    if (!pending || !secretsMatch(hashSecret(key), pending.keyHash))
      return writePage(
        response,
        404,
        errorPage('This sign-in is no longer waiting.', 'Start again from your MCP client; it will open a new page.'),
      )
    const outcome = options.devices.collectPairRequest(id, key, null, { oauth: true })
    const back = (params: Record<string, string>): void => {
      options.store.endAuthorization(id)
      redirect(response, pending.redirectUri, { ...params, state: pending.state, iss: pending.issuer })
    }
    switch (outcome.status) {
      case 'pending':
        return writePage(
          response,
          200,
          waitingPage(pending, outcome.comparisonCode, outcome.expiresAt),
          WAIT_REFRESH_SECONDS,
        )
      case 'approved': {
        const code = options.store.issueCode({ pending, deviceId: outcome.deviceId })
        return back({ code })
      }
      case 'denied':
        return back({ error: 'access_denied', error_description: 'The person at Studio declined this sign-in.' })
      case 'expired':
        return back({ error: 'access_denied', error_description: 'Nobody answered the sign-in in Studio in time.' })
    }
  }

  async function token(
    request: IncomingMessage,
    response: ServerResponse,
    context: TailnetOAuthRequestContext,
  ): Promise<void> {
    const form = await readBody(request, response, 'form')
    if (form === undefined) return
    const repeated = TOKEN_PARAMS.find((name) => form.getAll(name).length > 1)
    if (repeated) return tokenError(response, 'invalid_request', `${repeated} is given more than once.`)
    const basic = basicClientId(request)
    const clientId = form.get('client_id') ?? basic
    const namedResource = form.get('resource')
    const resource = namedResource === null ? null : ownResource(namedResource)
    if (namedResource !== null && !resource)
      return tokenError(response, 'invalid_target', 'resource is not this Studio’s MCP endpoint.')
    const peer = await context.identify()
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? ''
      const verifier = form.get('code_verifier') ?? ''
      const redirectUri = form.get('redirect_uri') ?? ''
      if (!code || !clientId || !verifier || !redirectUri)
        return tokenError(response, 'invalid_request', 'code, redirect_uri, client_id and code_verifier are required.')
      const outcome = options.store.redeemCode({
        code,
        clientId,
        redirectUri,
        codeVerifier: verifier,
        resource,
      })
      if (!outcome.ok) return tokenError(response, outcome.error, outcome.description)
      // The grant is held to the node that redeemed the code: that is the
      // machine the client runs on, which is what every later call comes from.
      const bound = options.devices.verifyPeer(outcome.deviceId, peer)
      if (!bound.ok) {
        options.devices.revokeDevice(outcome.deviceId)
        return tokenError(response, 'invalid_grant', bound.message)
      }
      return tokenSuccess(response, outcome.tokens)
    }
    if (grantType === 'refresh_token') {
      const refreshToken = form.get('refresh_token') ?? ''
      if (!refreshToken) return tokenError(response, 'invalid_request', 'refresh_token is required.')
      const outcome = options.store.refresh({
        refreshToken,
        clientId,
        resource,
        admit: (deviceId) => {
          const check = options.devices.verifyPeer(deviceId, peer)
          return check.ok ? null : { ok: false, error: 'invalid_grant', description: check.message }
        },
      })
      if (!outcome.ok) return tokenError(response, outcome.error, outcome.description)
      return tokenSuccess(response, outcome.tokens)
    }
    return tokenError(response, 'unsupported_grant_type', 'Only authorization_code and refresh_token are offered.')
  }

  async function revoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readBody(request, response, 'form')
    if (form === undefined) return
    // RFC 7009 2.2: an unknown or already revoked token is answered as revoked.
    options.store.revokeToken(form.get('token') ?? '')
    writeJson(response, 200, {})
  }

  function allowAttempt(peer: string): boolean {
    const at = now()
    const recent = (authorizeAttempts.get(peer) ?? []).filter((time) => time > at - 60_000)
    if (recent.length >= AUTHORIZE_PER_PEER_PER_MINUTE) {
      authorizeAttempts.set(peer, recent)
      return false
    }
    recent.push(at)
    authorizeAttempts.set(peer, recent)
    if (authorizeAttempts.size > 256) authorizeAttempts.delete(authorizeAttempts.keys().next().value!)
    return true
  }

  return {
    handle,
    originFor,
    primaryOrigin: (via) => originsFor(via)[0] ?? null,
    resources,
  }
}

type RouteKind = 'resource-metadata' | 'server-metadata' | 'register' | 'page' | 'token' | 'revoke'

/** The well-known documents and the endpoints they name. The path-suffixed resource document is RFC 9728 3.1's. */
const ROUTES: ReadonlyMap<string, { kind: RouteKind; methods: string[] }> = new Map([
  ['/.well-known/oauth-protected-resource', { kind: 'resource-metadata', methods: ['GET'] }],
  [`/.well-known/oauth-protected-resource${TAILNET_MCP_PATH}`, { kind: 'resource-metadata', methods: ['GET'] }],
  ['/.well-known/oauth-authorization-server', { kind: 'server-metadata', methods: ['GET'] }],
  [TAILNET_OAUTH_REGISTER_PATH, { kind: 'register', methods: ['POST'] }],
  [TAILNET_OAUTH_AUTHORIZE_PATH, { kind: 'page', methods: ['GET'] }],
  [TAILNET_OAUTH_WAIT_PATH, { kind: 'page', methods: ['GET'] }],
  [TAILNET_OAUTH_TOKEN_PATH, { kind: 'token', methods: ['POST'] }],
  [TAILNET_OAUTH_REVOKE_PATH, { kind: 'revoke', methods: ['POST'] }],
] as const)

const AUTHORIZE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const
const TOKEN_PARAMS = [
  'grant_type',
  'code',
  'redirect_uri',
  'client_id',
  'code_verifier',
  'refresh_token',
  'resource',
  'scope',
] as const

function serverMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${TAILNET_OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TAILNET_OAUTH_TOKEN_PATH}`,
    registration_endpoint: `${origin}${TAILNET_OAUTH_REGISTER_PATH}`,
    revocation_endpoint: `${origin}${TAILNET_OAUTH_REVOKE_PATH}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...TAILNET_SCOPES],
    authorization_response_iss_parameter_supported: true,
  }
}

/**
 * `scheme://host[:port]`, lowercased, the scheme's default port dropped, or
 * null for anything that is not an origin.
 */
export function canonicalOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password)
    return null
  return `${url.protocol}//${url.host}`
}

/**
 * A resource indicator (RFC 8707 2) in the form it is compared in: an absolute
 * http(s) URI with no fragment, scheme and host lowercased, the default port
 * dropped, and no trailing slash (the MCP spec's canonical form).
 */
export function canonicalResource(value: string): string | null {
  if (value.includes('#')) return null
  const origin = canonicalOrigin(value)
  if (!origin) return null
  const url = new URL(value)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${origin}${path}${url.search}`
}

/** Send the browser back to a registered redirect URI with the answer in its query (RFC 6749 4.1.2, RFC 9207). */
function redirect(response: ServerResponse, redirectUri: string, params: Record<string, string | null>): void {
  const target = new URL(redirectUri)
  for (const [name, value] of Object.entries(params)) if (value !== null) target.searchParams.set(name, value)
  response.statusCode = 303
  response.setHeader('Location', target.toString())
  setPageHeaders(response)
  response.end()
}

function tokenSuccess(
  response: ServerResponse,
  tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number; scopes: TailnetScope[] },
): void {
  response.setHeader('Pragma', 'no-cache')
  writeJson(response, 200, {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresInSeconds,
    refresh_token: tokens.refreshToken,
    scope: tokens.scopes.join(' '),
  })
}

function tokenError(response: ServerResponse, error: string, description: string): void {
  response.setHeader('Pragma', 'no-cache')
  writeJson(response, 400, { error, error_description: description })
}

/** A client id carried as HTTP Basic credentials, for a client that sends it there. The secret part is not ours to check: none is issued. */
function basicClientId(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  const match = typeof header === 'string' ? /^Basic\s+([A-Za-z0-9+/=]+)$/iu.exec(header.trim()) : null
  if (!match) return null
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  const id = colon >= 0 ? decoded.slice(0, colon) : decoded
  try {
    return decodeURIComponent(id.replace(/\+/gu, ' ')) || null
  } catch {
    return null
  }
}

async function readBody(request: IncomingMessage, response: ServerResponse, as: 'json'): Promise<unknown | undefined>
async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
  as: 'form',
): Promise<URLSearchParams | undefined>
async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
  as: 'json' | 'form',
): Promise<unknown | URLSearchParams | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_FORM_BYTES) {
        writeJson(response, 413, { error: 'invalid_request', error_description: 'The request body is too large.' })
        await new Promise<void>((resolve) => {
          response.once('finish', resolve)
          response.once('close', resolve)
        })
        return undefined
      }
      chunks.push(buffer)
    }
  } catch {
    writeJson(response, 400, { error: 'invalid_request', error_description: 'The request body could not be read.' })
    return undefined
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const type = (request.headers['content-type'] ?? '').toLowerCase()
  if (as === 'form') {
    // RFC 6749 says form-encoded; a JSON body of strings is read the same way
    // rather than refused, since some clients send one.
    if (type.startsWith('application/json')) {
      const parsed = parseJsonObject(text)
      if (!parsed) {
        writeJson(response, 400, { error: 'invalid_request', error_description: 'The request body is not valid.' })
        return undefined
      }
      const form = new URLSearchParams()
      for (const [name, value] of Object.entries(parsed)) if (typeof value === 'string') form.append(name, value)
      return form
    }
    return new URLSearchParams(text)
  }
  try {
    return JSON.parse(text)
  } catch {
    writeJson(response, 400, {
      error: 'invalid_client_metadata',
      error_description: 'The registration is not valid JSON.',
    })
    return undefined
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

// ── The sign-in pages ──────────────────────────────────────────────────────
// Plain HTML with no script, no images and no forms: there is nothing on them
// to press. A waiting page refreshes itself (a meta refresh, which needs no
// script) until the Studio window answers. Everything a client said about
// itself is escaped and shown as text, never as a link.

function setPageHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  // The waiting page's URL carries the key that collects the answer.
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  )
}

type Page = { title: string; body: string }

function writePage(response: ServerResponse, status: number, page: Page, refreshSeconds?: number): void {
  if (response.headersSent || response.writableEnded) return
  setPageHeaders(response)
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${escapeHtml(page.title)}</title><style>${PAGE_STYLE}</style></head><body><main>${page.body}</main></body></html>`
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
  response.end(html)
}

const PAGE_STYLE =
  ':root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
  'body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:Canvas;color:CanvasText}' +
  'main{max-width:30rem;padding:2rem;line-height:1.5}h1{font-size:1.25rem;margin:0 0 .75rem}' +
  '.code{font:600 2.25rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;margin:1rem 0}' +
  'dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:1rem 0}dt{opacity:.7}dd{margin:0;word-break:break-all}' +
  'p.note{opacity:.7;font-size:.9rem}'

function waitingPage(pending: OAuthPendingAuthorization, comparisonCode: string, expiresAt: string): Page {
  const redirectHost = (() => {
    try {
      return new URL(pending.redirectUri).hostname
    } catch {
      return ''
    }
  })()
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000))
  return {
    title: 'Approve in Studio',
    body:
      `<h1>Approve this sign-in in Studio</h1>` +
      `<p><strong>${escapeHtml(pending.clientName)}</strong> is asking for access to this Studio. ` +
      `Open the Studio window on that machine and type this code where it asks:</p>` +
      `<p class="code" aria-label="Code">${escapeHtml(comparisonCode.replace(/(\d{3})(\d{3})/u, '$1 $2'))}</p>` +
      `<dl><dt>Client</dt><dd>${escapeHtml(pending.clientName)}</dd><dt>Returns to</dt><dd>${escapeHtml(redirectHost)}</dd></dl>` +
      `<p class="note">This page cannot approve anything; only the Studio window can. It moves on by itself once Studio has answered, ` +
      `and the request lapses in about ${minutes} minute${minutes === 1 ? '' : 's'}. If you did not start this, decline it in Studio.</p>`,
  }
}

function errorPage(heading: string, detail: string): Page {
  return { title: heading, body: `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>` }
}

function misdirectedPage(origins: string[]): Page {
  return errorPage(
    'This Studio does not answer to that name.',
    `Address it as ${origins.join(' or ') || 'its tailnet address'}, and start the sign-in again from your MCP client.`,
  )
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

// The base is a placeholder: only the path and query are read.
function parseUrl(url: string | undefined): URL {
  try {
    return new URL(url ?? '/', 'http://tailnet.invalid')
  } catch {
    return new URL('/', 'http://tailnet.invalid')
  }
}
