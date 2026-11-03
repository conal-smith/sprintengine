import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import { toolSuccess, type McpToolRegistration } from '../../../shared/modules/mcp-tools'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import {
  checkRedirectUri,
  createTailnetOAuthStore,
  OAUTH_ACCESS_TOKEN_TTL_MS,
  OAUTH_GRANT_TTL_MS,
  pkceMatches,
  redirectUriRegistered,
  TAILNET_OAUTH_FILENAME,
  type TailnetOAuthStore,
} from './tailnet-oauth'
import { canonicalResource } from './tailnet-oauth-http'
import type { TailnetPeerIdentity } from './tailnet-peer-identity'
import { createTailnetRemoteService } from './tailnet-service'
import { writeTailnetSettings } from './tailnet-settings'
import {
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_OAUTH_AUTHORIZE_PATH,
  TAILNET_OAUTH_REGISTER_PATH,
  TAILNET_OAUTH_REVOKE_PATH,
  TAILNET_OAUTH_TOKEN_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'

// OAuth sign-in for the tailnet MCP endpoint, against the real listener on
// loopback with a real device store and OAuth store. Who whois says is calling
// comes from an injected resolver a case can move between nodes, and the
// clock is one the case can wind forward.

const MAC_MINI: TailnetPeerIdentity = {
  name: 'mac-mini.tail1234.ts.net',
  stableNodeId: 'nMacMini1CNTRL',
  loginName: 'dev@example.com',
}
const BUILD_BOX: TailnetPeerIdentity = {
  name: 'build-box.tail1234.ts.net',
  stableNodeId: 'nBuildBox2CNTRL',
  loginName: 'dev@example.com',
}

const REDIRECT = 'http://localhost:33418/callback'

type Gateway = {
  server: TailnetGatewayServer
  devices: TailnetDeviceStore
  oauth: TailnetOAuthStore
  port: number
  origin: string
  dir: string
  callFrom(peer: TailnetPeerIdentity | null): void
  advance(ms: number): void
}

function tools(): McpToolRegistration[] {
  const tool = (name: string): McpToolRegistration => ({
    name,
    description: `Test ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => toolSuccess({ ok: true, tool: name }),
  })
  return [tool('workspace.list'), tool('backlog.update'), tool('tailnet.status')]
}

async function withGateway(run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-oauth-'))
  let caller: TailnetPeerIdentity | null = MAC_MINI
  let offset = 0
  const clock = () => Date.now() + offset
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir, now: () => new Date(clock()) })
  const oauth = createTailnetOAuthStore({ resolveUserDataDir: () => dir, devices, now: clock })
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => tools(),
    isMutation: (name) => name === 'backlog.update',
    devices,
    peers: { identify: async () => caller, resolve: async () => caller?.name ?? null },
    oauth: { store: oauth },
    now: clock,
  })
  await server.start()
  const port = server.address()!.port
  try {
    await run({
      server,
      devices,
      oauth,
      port,
      origin: `http://127.0.0.1:${port}`,
      dir,
      callFrom: (peer) => {
        caller = peer
      },
      advance: (ms) => {
        offset += ms
      },
    })
  } finally {
    oauth.dispose()
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }

function http(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body ?? ''
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          Host: options.host ?? `127.0.0.1:${port}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json })
        })
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return http(port, 'POST', path, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function postForm(port: number, path: string, fields: Record<string, string>) {
  return http(port, 'POST', path, {
    body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
}

function mcp(port: number, token: string, body: unknown, headers: Record<string, string> = {}) {
  return postJson(port, TAILNET_MCP_PATH, body, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    ...headers,
  })
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(gateway: Gateway, redirectUris = [REDIRECT]): Promise<string> {
  const answer = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, {
    client_name: 'Claude Code (studio)',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
  assert.equal(answer.status, 201, answer.text)
  return answer.json.client_id as string
}

function authorizePath(params: Record<string, string>): string {
  return `${TAILNET_OAUTH_AUTHORIZE_PATH}?${new URLSearchParams(params).toString()}`
}

type SignIn = { clientId: string; verifier: string; waitPath: string; requestId: string; code: string; state: string }

/** Register, open the sign-in page, and read what the page shows: up to the point the person must answer. */
async function startSignIn(gateway: Gateway, extra: Record<string, string> = {}): Promise<SignIn> {
  const clientId = await register(gateway)
  const { verifier, challenge } = pkce()
  const state = randomBytes(8).toString('hex')
  const opened = await http(
    gateway.port,
    'GET',
    authorizePath({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: `${gateway.origin}${TAILNET_MCP_PATH}`,
      scope: TAILNET_SCOPES.join(' '),
      ...extra,
    }),
  )
  assert.equal(opened.status, 303, opened.text)
  const waitPath = String(opened.headers.location)
  const page = await http(gateway.port, 'GET', waitPath)
  assert.equal(page.status, 200)
  const code = /class="code"[^>]*>(\d{3}) (\d{3})</u.exec(page.text)
  assert.ok(code, 'the waiting page shows the six digits')
  const requestId = new URL(waitPath, gateway.origin).searchParams.get('id')!
  return { clientId, verifier, waitPath, requestId, code: `${code[1]}${code[2]}`, state }
}

/** The person types the code into the Studio window and allows it. */
function approve(gateway: Gateway, signIn: SignIn, scopes: TailnetScope[] = [...TAILNET_SCOPES]): void {
  const outcome = gateway.devices.approvePairRequest({ id: signIn.requestId, scopes, code: signIn.code, via: 'ipc' })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
}

/** The browser comes back to the waiting page and is sent on to the client with its code. */
async function codeFor(gateway: Gateway, signIn: SignIn): Promise<string> {
  const back = await http(gateway.port, 'GET', signIn.waitPath)
  assert.equal(back.status, 303)
  const location = new URL(String(back.headers.location))
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT)
  assert.equal(location.searchParams.get('state'), signIn.state)
  assert.equal(location.searchParams.get('iss'), gateway.origin)
  return location.searchParams.get('code')!
}

async function exchange(gateway: Gateway, signIn: SignIn, code: string) {
  return postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
    grant_type: 'authorization_code',
    code,
    client_id: signIn.clientId,
    redirect_uri: REDIRECT,
    code_verifier: signIn.verifier,
    resource: `${gateway.origin}${TAILNET_MCP_PATH}`,
  })
}

async function signedIn(
  gateway: Gateway,
  scopes?: TailnetScope[],
): Promise<{ signIn: SignIn; access: string; refresh: string }> {
  const signIn = await startSignIn(gateway)
  approve(gateway, signIn, scopes)
  const tokens = await exchange(gateway, signIn, await codeFor(gateway, signIn))
  assert.equal(tokens.status, 200, tokens.text)
  return { signIn, access: tokens.json.access_token, refresh: tokens.json.refresh_token }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}

// ── Discovery ─────────────────────────────────────────────────────────────

test('an unauthenticated MCP request is told where to sign in', async () => {
  await withGateway(async (gateway) => {
    const answer = await mcp(gateway.port, '', initialize, { Authorization: '' })
    assert.equal(answer.status, 401)
    const challenge = String(answer.headers['www-authenticate'])
    assert.match(challenge, /^Bearer realm="sprintengine-studio-tailnet"/u)
    assert.ok(
      challenge.includes(
        `resource_metadata="${gateway.origin}/.well-known/oauth-protected-resource${TAILNET_MCP_PATH}"`,
      ),
    )
    assert.doesNotMatch(challenge, /error=/u, 'no token, so no invalid_token')
    assert.equal(answer.json.error.code, 'unauthorized')
  })
})

test('the resource and server metadata name this origin throughout', async () => {
  await withGateway(async (gateway) => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      `/.well-known/oauth-protected-resource${TAILNET_MCP_PATH}`,
    ]) {
      const resource = await http(gateway.port, 'GET', path)
      assert.equal(resource.status, 200)
      assert.deepEqual(resource.json, {
        resource: `${gateway.origin}${TAILNET_MCP_PATH}`,
        authorization_servers: [gateway.origin],
        scopes_supported: [...TAILNET_SCOPES],
        bearer_methods_supported: ['header'],
        resource_name: 'SprintEngine Studio',
      })
    }
    const server = await http(gateway.port, 'GET', '/.well-known/oauth-authorization-server')
    assert.equal(server.status, 200)
    assert.equal(server.json.issuer, gateway.origin)
    assert.equal(server.json.token_endpoint, `${gateway.origin}${TAILNET_OAUTH_TOKEN_PATH}`)
    assert.deepEqual(server.json.code_challenge_methods_supported, ['S256'])
    assert.deepEqual(server.json.token_endpoint_auth_methods_supported, ['none'])
    assert.equal(server.json.registration_endpoint, `${gateway.origin}${TAILNET_OAUTH_REGISTER_PATH}`)
    assert.equal(server.json.authorization_response_iss_parameter_supported, true)
    assert.equal(server.headers['cache-control'], 'no-store')
  })
})

test('a Host this Studio does not answer to is refused, never echoed', async () => {
  await withGateway(async (gateway) => {
    const answer = await http(gateway.port, 'GET', '/.well-known/oauth-authorization-server', {
      host: 'evil.example.com',
    })
    assert.equal(answer.status, 421)
    assert.doesNotMatch(answer.text, /evil\.example\.com/u)
    const page = await http(gateway.port, 'GET', authorizePath({ client_id: 'x' }), { host: 'evil.example.com' })
    assert.equal(page.status, 421)
  })
})

test('a browser request is refused outright, metadata and token endpoint included', async () => {
  await withGateway(async (gateway) => {
    const answer = await http(gateway.port, 'GET', '/.well-known/oauth-authorization-server', {
      headers: { Origin: 'https://evil.example.com' },
    })
    assert.equal(answer.status, 403)
    const tokenCall = await http(gateway.port, 'POST', TAILNET_OAUTH_TOKEN_PATH, {
      body: 'grant_type=refresh_token&refresh_token=x',
      headers: { Origin: gateway.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    assert.equal(tokenCall.status, 403)
  })
})

// ── Registration ──────────────────────────────────────────────────────────

test('registration takes loopback and https redirect URIs and nothing else', async () => {
  await withGateway(async (gateway) => {
    const good = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, {
      client_name: 'Codex',
      redirect_uris: ['http://127.0.0.1:1455/auth/callback', 'https://app.example.com/cb'],
    })
    assert.equal(good.status, 201)
    assert.match(good.json.client_id, /^mcc_/u)
    assert.equal(good.json.token_endpoint_auth_method, 'none')
    assert.equal(good.json.client_secret, undefined, 'a public client is issued no secret')
    for (const bad of [
      'cursor://anysphere/callback',
      'http://app.example.com/cb',
      'https://app.example.com/cb#frag',
      'https://user:pass@app.example.com/cb',
      'javascript:alert(1)',
    ]) {
      const refused = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, { redirect_uris: [bad] })
      assert.equal(refused.status, 400, bad)
      assert.equal(refused.json.error, 'invalid_redirect_uri', bad)
    }
    const noUris = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, { client_name: 'x' })
    assert.equal(noUris.json.error, 'invalid_redirect_uri')
    const wrongGrant = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, {
      redirect_uris: [REDIRECT],
      grant_types: ['client_credentials'],
    })
    assert.equal(wrongGrant.json.error, 'invalid_client_metadata')
  })
})

test('a registration is its signed client id, so nothing is stored and nothing can be forged', async () => {
  await withGateway(async (gateway) => {
    const named = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, {
      client_name: 'Evil\u202eedoC\u0000 <script>',
      redirect_uris: [REDIRECT],
    })
    assert.equal(named.json.client_name, 'Evil edoC <script>')
    for (let index = 0; index < 20; index += 1)
      assert.equal(
        (await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, { redirect_uris: [REDIRECT] })).status,
        201,
      )
    assert.equal(
      existsSync(join(gateway.dir, TAILNET_OAUTH_FILENAME))
        ? readFileSync(join(gateway.dir, TAILNET_OAUTH_FILENAME), 'utf8').includes('redirect')
        : false,
      false,
    )
    const clientId = named.json.client_id as string
    assert.equal(gateway.oauth.clientFor(clientId)?.clientName, 'Evil edoC <script>')
    // A client id rewritten to add a redirect URI no longer verifies.
    const [body, signature] = clientId.slice('mcc_'.length).split('.')
    const forged = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))
    forged.r.push('https://evil.example.com/cb')
    const forgedId = `mcc_${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`
    assert.equal(gateway.oauth.clientFor(forgedId), null)
    const tooMany = await postJson(gateway.port, TAILNET_OAUTH_REGISTER_PATH, {
      redirect_uris: Array.from({ length: 6 }, (_, index) => `http://localhost:${4000 + index}/cb`),
    })
    assert.equal(tooMany.json.error, 'invalid_redirect_uri')
  })
})

// ── The sign-in ───────────────────────────────────────────────────────────

test('the full sign-in: approved in Studio, tokens, and the MCP endpoint over Streamable HTTP', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    // The request is waiting in Studio as an OAuth sign-in, without the code.
    const waiting = gateway.devices.listPairRequests()
    assert.equal(waiting.length, 1)
    assert.equal(waiting[0]!.oauth?.clientName, 'Claude Code (studio)')
    assert.equal(waiting[0]!.oauth?.redirectHost, 'localhost')
    assert.equal(waiting[0]!.peerNode, MAC_MINI.name)
    assert.equal(JSON.stringify(waiting).includes(signIn.code), false, 'the list never carries the code')
    // The page refreshes itself and has nothing to press.
    const page = await http(gateway.port, 'GET', signIn.waitPath)
    assert.match(page.text, /<meta http-equiv="refresh"/u)
    assert.doesNotMatch(page.text, /<form|<script|<button|<a /iu)
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/u)
    assert.equal(page.headers['referrer-policy'], 'no-referrer')

    approve(gateway, signIn, ['workspace:read', 'backlog:read'])
    const code = await codeFor(gateway, signIn)
    const tokens = await exchange(gateway, signIn, code)
    assert.equal(tokens.status, 200, tokens.text)
    assert.equal(tokens.json.token_type, 'Bearer')
    assert.equal(tokens.json.expires_in, OAUTH_ACCESS_TOKEN_TTL_MS / 1000)
    assert.equal(tokens.json.scope, 'workspace:read backlog:read')
    assert.match(tokens.json.access_token, /^mcat_/u)
    assert.match(tokens.json.refresh_token, /^mcrt_/u)
    assert.equal(tokens.headers['cache-control'], 'no-store')

    // The client is a device in Settings → Remote, held to the node that redeemed the code.
    const device = gateway.devices.listDevices().find((entry) => entry.origin.kind === 'oauth')
    assert.ok(device)
    assert.equal(device.name, 'Claude Code (studio)')
    // Only hashes reach disk.
    const stored = readFileSync(join(gateway.dir, TAILNET_OAUTH_FILENAME), 'utf8')
    assert.equal(stored.includes(tokens.json.access_token), false)
    assert.equal(stored.includes(tokens.json.refresh_token), false)

    const access = tokens.json.access_token as string
    const init = await mcp(gateway.port, access, initialize)
    assert.equal(init.status, 200, init.text)
    assert.equal(init.json.result.protocolVersion, '2025-06-18')
    const session = String(init.headers['mcp-session-id'])
    assert.ok(session.length > 20, 'a session is minted on initialize')

    const initialized = await mcp(
      gateway.port,
      access,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' },
    )
    assert.equal(initialized.status, 202)
    assert.equal(initialized.text, '', 'a notification is accepted with no body')

    const listed = await mcp(
      gateway.port,
      access,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' },
    )
    // Granted workspace:read and backlog:read: the read tool, not the mutation, never the local-only one.
    assert.deepEqual(
      listed.json.result.tools.map((tool: { name: string }) => tool.name),
      ['workspace.list'],
    )
    const refused = await mcp(gateway.port, access, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'backlog.update', arguments: {} },
    })
    assert.equal(refused.json.result.isError, true)
    assert.match(JSON.stringify(refused.json.result), /tailnet_scope_required/u)
    const localOnly = await mcp(gateway.port, access, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'tailnet.status', arguments: {} },
    })
    assert.match(JSON.stringify(localOnly.json.result), /tailnet_local_only/u)

    // A session another device's or unknown is 404, so the client initializes again.
    const lost = await mcp(
      gateway.port,
      access,
      { jsonrpc: '2.0', id: 5, method: 'ping' },
      { 'Mcp-Session-Id': 'nope' },
    )
    assert.equal(lost.status, 404)

    // Widened from Settings, the same token sees more at once.
    gateway.devices.updateDeviceScopes(device.id, [...TAILNET_SCOPES])
    const widened = await mcp(gateway.port, access, { jsonrpc: '2.0', id: 6, method: 'tools/list' })
    assert.deepEqual(
      widened.json.result.tools.map((tool: { name: string }) => tool.name),
      ['workspace.list', 'backlog.update'],
    )
  })
})

test('an OAuth sign-in is granted at most what it asked for', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway, { scope: 'workspace:read offline_access' })
    assert.deepEqual(gateway.devices.listPairRequests()[0]!.requestedScopes, ['workspace:read'])
    approve(gateway, signIn, [...TAILNET_SCOPES])
    const tokens = await exchange(gateway, signIn, await codeFor(gateway, signIn))
    assert.equal(tokens.json.scope, 'workspace:read')
  })
})

test('approval happens only in the Studio window', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    // Not by a tool, even one holding the code.
    const byTool = gateway.devices.approvePairRequest({
      id: signIn.requestId,
      scopes: [...TAILNET_SCOPES],
      code: signIn.code,
      via: 'tool',
    })
    assert.equal(byTool.ok, false)
    assert.equal(!byTool.ok && byTool.code, 'approve_in_window')
    // Not by the pair-request collect, even with the page's key.
    const key = new URL(signIn.waitPath, gateway.origin).searchParams.get('key')!
    const collected = await postJson(gateway.port, TAILNET_PAIR_COLLECT_PATH, { id: signIn.requestId, secret: key })
    assert.deepEqual(collected.json, { status: 'expired' })
    // Not by the page, which offers nothing but itself, and keeps waiting.
    const again = await http(gateway.port, 'GET', signIn.waitPath)
    assert.equal(again.status, 200)
    // And not with a guessed key.
    const guessed = await http(gateway.port, 'GET', signIn.waitPath.replace(/key=[^&]+/u, 'key=guess'))
    assert.equal(guessed.status, 404)
    // A wrong code in the window does not approve it either.
    const wrong = gateway.devices.approvePairRequest({ id: signIn.requestId, scopes: [], code: '000000', via: 'ipc' })
    assert.equal(wrong.ok, false)
  })
})

test('declined in Studio, the browser is sent back with access_denied', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    assert.equal(gateway.devices.denyPairRequest(signIn.requestId), true)
    const back = await http(gateway.port, 'GET', signIn.waitPath)
    assert.equal(back.status, 303)
    const location = new URL(String(back.headers.location))
    assert.equal(location.searchParams.get('error'), 'access_denied')
    assert.equal(location.searchParams.get('state'), signIn.state)
    assert.equal(gateway.devices.listDevices().length, 0)
  })
})

test('a retried sign-in replaces the one it left waiting', async () => {
  await withGateway(async (gateway) => {
    await startSignIn(gateway)
    const second = await startSignIn(gateway)
    const waiting = gateway.devices.listPairRequests()
    assert.equal(waiting.length, 1)
    assert.equal(waiting[0]!.id, second.requestId)
  })
})

test('redirect URIs are matched exactly, loopback on any port, and a bad one is never followed', async () => {
  await withGateway(async (gateway) => {
    const clientId = await register(gateway)
    const { challenge } = pkce()
    const base = {
      response_type: 'code',
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
    }
    for (const redirect of [
      'https://evil.example.com/cb',
      'http://localhost:33418/other',
      'http://127.0.0.1:33418/callback',
    ]) {
      const refused = await http(gateway.port, 'GET', authorizePath({ ...base, redirect_uri: redirect }))
      assert.equal(refused.status, 400, redirect)
      assert.equal(refused.headers.location, undefined, `${redirect} is not followed`)
    }
    const otherPort = await http(
      gateway.port,
      'GET',
      authorizePath({ ...base, redirect_uri: 'http://localhost:50123/callback' }),
    )
    assert.equal(otherPort.status, 303, 'a loopback redirect URI matches on any port')
    const unknownClient = await http(
      gateway.port,
      'GET',
      authorizePath({ ...base, client_id: 'mcc_nope', redirect_uri: REDIRECT }),
    )
    assert.equal(unknownClient.status, 400)
    assert.equal(unknownClient.headers.location, undefined)
    assert.match(unknownClient.text, /does not know this client/u)
  })
})

test('a bad authorization request goes back to the client as an RFC 6749 error', async () => {
  await withGateway(async (gateway) => {
    const clientId = await register(gateway)
    const { challenge } = pkce()
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    }
    const cases: Array<[Record<string, string>, string]> = [
      [{ code_challenge: '' }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://other.example.com/mcp' }, 'invalid_target'],
    ]
    for (const [override, error] of cases) {
      const answer = await http(gateway.port, 'GET', authorizePath({ ...base, ...override }))
      assert.equal(answer.status, 303, JSON.stringify(override))
      const location = new URL(String(answer.headers.location))
      assert.equal(location.searchParams.get('error'), error, JSON.stringify(override))
      assert.equal(location.searchParams.get('state'), 'xyz')
      assert.equal(location.searchParams.get('iss'), gateway.origin)
    }
    assert.equal(gateway.devices.listPairRequests().length, 0, 'no bad request reached the person')
    // The origin alone is this Studio too.
    const byOrigin = await http(gateway.port, 'GET', authorizePath({ ...base, resource: `${gateway.origin}/` }))
    assert.match(String(byOrigin.headers.location), /authorize\/wait/u)
  })
})

// ── Tokens ────────────────────────────────────────────────────────────────

test('a code needs its PKCE verifier and is spent the first time it is presented', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    approve(gateway, signIn)
    const code = await codeFor(gateway, signIn)
    const wrong = await exchange(gateway, { ...signIn, verifier: pkce().verifier }, code)
    assert.equal(wrong.status, 400)
    assert.equal(wrong.json.error, 'invalid_grant')
    const afterWrong = await exchange(gateway, signIn, code)
    assert.equal(afterWrong.json.error, 'invalid_grant', 'a guess spends the code')
  })
})

test('a code redeemed twice revokes what it minted', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    approve(gateway, signIn)
    const code = await codeFor(gateway, signIn)
    const missingRedirect = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'authorization_code',
      code,
      client_id: signIn.clientId,
      code_verifier: signIn.verifier,
    })
    assert.equal(
      missingRedirect.json.error,
      'invalid_request',
      'redirect_uri is required, and the code is not spent by a malformed request',
    )
    const good = await exchange(gateway, signIn, code)
    assert.equal(good.status, 200, good.text)
    const replayed = await exchange(gateway, signIn, code)
    assert.equal(replayed.json.error, 'invalid_grant')
    assert.equal(gateway.devices.listDevices().length, 0, 'the grant the code minted is gone')
    const after = await mcp(gateway.port, good.json.access_token, initialize)
    assert.equal(after.status, 401)
  })
})

test('a code expires', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    approve(gateway, signIn)
    const code = await codeFor(gateway, signIn)
    gateway.advance(2 * 60 * 1000)
    const late = await exchange(gateway, signIn, code)
    assert.equal(late.json.error, 'invalid_grant')
  })
})

test('refresh tokens rotate, and a replayed one revokes the grant', async () => {
  await withGateway(async (gateway) => {
    const { signIn, refresh } = await signedIn(gateway)
    const first = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: signIn.clientId,
    })
    assert.equal(first.status, 200, first.text)
    assert.notEqual(first.json.refresh_token, refresh)
    const working = await mcp(gateway.port, first.json.access_token, initialize)
    assert.equal(working.status, 200)
    // The old one, presented again: two parties hold this grant.
    const replay = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
    })
    assert.equal(replay.json.error, 'invalid_grant')
    assert.equal(gateway.devices.listDevices().length, 0)
    const revoked = await mcp(gateway.port, first.json.access_token, initialize)
    assert.equal(revoked.status, 401)
    assert.match(String(revoked.headers['www-authenticate']), /error="invalid_token"/u)
    const newer = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: first.json.refresh_token,
    })
    assert.equal(newer.json.error, 'invalid_grant')
  })
})

test('an access token expires after an hour, and the sign-in after 30 days however it is used', async () => {
  await withGateway(async (gateway) => {
    const { access, refresh } = await signedIn(gateway)
    gateway.advance(OAUTH_ACCESS_TOKEN_TTL_MS + 1000)
    const expired = await mcp(gateway.port, access, initialize)
    assert.equal(expired.status, 401)
    assert.equal(expired.json.error.code, 'token_expired')
    assert.match(String(expired.headers['www-authenticate']), /error="invalid_token"/u)
    const refreshed = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
    })
    assert.equal(refreshed.status, 200)
    // Refreshed every day, it still ends at 30 days.
    let current = refreshed.json.refresh_token as string
    for (let day = 1; day < 30; day += 1) {
      gateway.advance(24 * 60 * 60 * 1000)
      const next = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
        grant_type: 'refresh_token',
        refresh_token: current,
      })
      if (next.status !== 200) break
      current = next.json.refresh_token
      assert.ok(next.json.expires_in <= OAUTH_ACCESS_TOKEN_TTL_MS / 1000)
    }
    gateway.advance(OAUTH_GRANT_TTL_MS)
    const ended = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: current,
    })
    assert.equal(ended.json.error, 'invalid_grant')
    assert.equal(gateway.devices.listDevices().length, 0, 'the ended sign-in and its device are gone')
  })
})

test('a grant is held to the node that redeemed its code', async () => {
  await withGateway(async (gateway) => {
    const { access, refresh } = await signedIn(gateway)
    gateway.callFrom(BUILD_BOX)
    const elsewhere = await mcp(gateway.port, access, initialize)
    assert.equal(elsewhere.status, 401)
    assert.equal(elsewhere.json.error.code, 'peer_mismatch')
    const refreshElsewhere = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
    })
    assert.equal(refreshElsewhere.json.error, 'invalid_grant')
    // Refused without spending it: the client on its own node still refreshes.
    gateway.callFrom(MAC_MINI)
    const home = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
    })
    assert.equal(home.status, 200)
  })
})

test('revoking the device in Settings stops its tokens at once', async () => {
  await withGateway(async (gateway) => {
    const { access, refresh } = await signedIn(gateway)
    const device = gateway.devices.listDevices()[0]!
    gateway.devices.revokeDevice(device.id)
    assert.equal((await mcp(gateway.port, access, initialize)).status, 401)
    const refreshed = await postForm(gateway.port, TAILNET_OAUTH_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
    })
    assert.equal(refreshed.json.error, 'invalid_grant')
  })
})

test('a client revokes its own refresh token (RFC 7009)', async () => {
  await withGateway(async (gateway) => {
    const { access, refresh } = await signedIn(gateway)
    const answer = await postForm(gateway.port, TAILNET_OAUTH_REVOKE_PATH, { token: refresh })
    assert.equal(answer.status, 200)
    assert.equal((await mcp(gateway.port, access, initialize)).status, 401)
    const unknown = await postForm(gateway.port, TAILNET_OAUTH_REVOKE_PATH, { token: 'mcrt_nothing' })
    assert.equal(unknown.status, 200)
  })
})

test('an access token opens the MCP endpoint and no other route', async () => {
  await withGateway(async (gateway) => {
    const { access } = await signedIn(gateway)
    for (const [method, path] of [
      ['GET', TAILNET_IDENTITY_PATH],
      ['POST', TAILNET_WS_TICKET_PATH],
    ] as const) {
      const answer = await http(gateway.port, method, path, {
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      })
      assert.equal(answer.status, 401, path)
      assert.equal(answer.json.error.code, 'wrong_resource', path)
    }
  })
})

test('an approved sign-in whose browser never came back leaves nothing behind', async () => {
  await withGateway(async (gateway) => {
    const signIn = await startSignIn(gateway)
    approve(gateway, signIn)
    assert.equal(gateway.devices.listDevices().length, 1)
    gateway.advance(16 * 60 * 1000)
    gateway.oauth.sweep()
    assert.equal(gateway.devices.listDevices().length, 0)
  })
})

// ── The MCP endpoint, for everyone ────────────────────────────────────────

test('Streamable HTTP: GET and DELETE are 405, mirrored headers must match the body, versions are checked', async () => {
  await withGateway(async (gateway) => {
    const offer = gateway.devices.offerPairing({ scopes: [...TAILNET_SCOPES] })
    const paired = await postJson(gateway.port, TAILNET_PAIR_PATH, { pairingToken: offer.token, deviceName: 'phone' })
    const token = paired.json.deviceToken as string
    for (const method of ['GET', 'DELETE']) {
      const answer = await http(gateway.port, method, TAILNET_MCP_PATH, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(answer.status, 405, method)
      assert.equal(answer.headers.allow, 'POST')
    }
    const mismatch = await mcp(
      gateway.port,
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'Mcp-Method': 'tools/call' },
    )
    assert.equal(mismatch.status, 400)
    assert.equal(mismatch.json.error.code, -32020)
    const nameMismatch = await mcp(
      gateway.port,
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } },
      { 'Mcp-Method': 'tools/call', 'Mcp-Name': `=?base64?${Buffer.from('backlog.update').toString('base64')}?=` },
    )
    assert.equal(nameMismatch.json.error.code, -32020)
    const nameMatch = await mcp(
      gateway.port,
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } },
      { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'workspace.list' },
    )
    assert.equal(nameMatch.status, 200)
    const unsupported = await mcp(
      gateway.port,
      token,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { 'MCP-Protocol-Version': '2099-01-01' },
    )
    assert.equal(unsupported.status, 400)
    assert.ok(unsupported.json.error.data.supported.includes('2025-06-18'))
    const response = await mcp(gateway.port, token, { jsonrpc: '2.0', id: 9, result: {} })
    assert.equal(response.status, 202)
    const batch = await mcp(gateway.port, token, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    assert.equal(batch.status, 400)
    // The device token keeps working on the MCP endpoint, as it always did.
    const ping = await mcp(gateway.port, token, { jsonrpc: '2.0', id: 1, method: 'ping' })
    assert.deepEqual(ping.json, { jsonrpc: '2.0', id: 1, result: {} })
  })
})

test('a pairing code sent as a bearer token is told what to do with it', async () => {
  await withGateway(async (gateway) => {
    const offer = gateway.devices.offerPairing({ scopes: [...TAILNET_SCOPES] })
    for (const bearer of [offer.token, `sprintengine-tailnet://pair?endpoint=127.0.0.1:1&token=${offer.token}`]) {
      const answer = await mcp(gateway.port, bearer, initialize)
      assert.equal(answer.status, 401)
      assert.equal(answer.json.error.code, 'pairing_code_not_a_token')
      assert.match(answer.json.error.message, /POST \/tailnet\/v1\/pair/u)
      assert.match(String(answer.headers['www-authenticate']), /resource_metadata=/u)
    }
    // And the offer is not spent by it.
    assert.ok(gateway.devices.getPairingState())
  })
})

// ── Pure rules ────────────────────────────────────────────────────────────

test('the pure rules: redirect URIs, PKCE, resource indicators', () => {
  assert.deepEqual(checkRedirectUri('http://[::1]:4000/cb'), { kind: 'loopback', host: '[::1]' })
  assert.equal(checkRedirectUri('http://localhost.evil.com/cb'), null)
  assert.equal(redirectUriRegistered('http://127.0.0.1:9/cb', ['http://127.0.0.1:1/cb']), true)
  assert.equal(redirectUriRegistered('http://127.0.0.1:9/cb?x=1', ['http://127.0.0.1:1/cb']), false)
  assert.equal(redirectUriRegistered('https://a.example.com:9/cb', ['https://a.example.com:1/cb']), false)
  const { verifier, challenge } = pkce()
  assert.equal(pkceMatches(verifier, challenge), true)
  assert.equal(pkceMatches('short', challenge), false)
  assert.equal(
    canonicalResource('HTTPS://Mac-Mini.Example.TS.NET:443/tailnet/v1/mcp/'),
    'https://mac-mini.example.ts.net/tailnet/v1/mcp',
  )
  assert.equal(canonicalResource('https://mac-mini.example.ts.net/#x'), null)
  assert.equal(canonicalResource('mac-mini.example.ts.net'), null)
})

test('the store keeps its signing key across restarts and no registration at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-oauth-store-'))
  try {
    const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    const store = createTailnetOAuthStore({ resolveUserDataDir: () => dir, devices })
    const registered = store.registerClient({ redirect_uris: [REDIRECT] })
    assert.equal(registered.ok, true)
    store.dispose()
    // The signing key survives a restart, so a client registered before one is still known.
    const reread = createTailnetOAuthStore({ resolveUserDataDir: () => dir, devices })
    assert.ok(registered.ok && reread.clientFor(registered.client.clientId))
    reread.dispose()
    const stored = JSON.parse(readFileSync(join(dir, TAILNET_OAUTH_FILENAME), 'utf8'))
    assert.deepEqual(stored.grants, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Behind Tailscale Serve ────────────────────────────────────────────────

test('behind Tailscale Serve, X-Forwarded-For is the peer there and only there, and Host must be the HTTPS name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-oauth-serve-'))
  const asked: string[] = []
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  const oauth = createTailnetOAuthStore({ resolveUserDataDir: () => dir, devices })
  let tailnetOrigin = ''
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => tools(),
    isMutation: () => false,
    devices,
    peers: {
      identify: async (address) => {
        asked.push(address)
        return MAC_MINI
      },
      resolve: async () => MAC_MINI.name,
    },
    oauth: { store: oauth },
    publicOrigins: () => ({ tailnet: [tailnetOrigin], serve: 'https://mac-mini.example.ts.net' }),
  })
  await server.start()
  try {
    const port = server.address()!.port
    tailnetOrigin = `http://127.0.0.1:${port}`
    const servePort = await server.openServeListener()
    assert.equal(server.serveAddress()?.port, servePort)
    const metadata = await http(servePort, 'GET', '/.well-known/oauth-authorization-server', {
      host: 'mac-mini.example.ts.net',
    })
    assert.equal(metadata.status, 200)
    assert.equal(metadata.json.issuer, 'https://mac-mini.example.ts.net')
    assert.equal(metadata.json.token_endpoint, `https://mac-mini.example.ts.net${TAILNET_OAUTH_TOKEN_PATH}`)
    const wrongHost = await http(servePort, 'GET', '/.well-known/oauth-authorization-server')
    assert.equal(wrongHost.status, 421, 'the loopback listener answers to the HTTPS name only')
    const unauthorized = await http(servePort, 'POST', TAILNET_MCP_PATH, {
      host: 'mac-mini.example.ts.net',
      body: JSON.stringify(initialize),
      headers: { 'Content-Type': 'application/json' },
    })
    assert.match(
      String(unauthorized.headers['www-authenticate']),
      /resource_metadata="https:\/\/mac-mini\.example\.ts\.net\/\.well-known\/oauth-protected-resource\/tailnet\/v1\/mcp"/u,
    )

    const offer = devices.offerPairing({ scopes: [...TAILNET_SCOPES] })
    const paired = await postJson(port, TAILNET_PAIR_PATH, { pairingToken: offer.token, deviceName: 'phone' })
    const token = paired.json.deviceToken as string
    asked.length = 0
    await http(servePort, 'POST', TAILNET_MCP_PATH, {
      host: 'mac-mini.example.ts.net',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Forwarded-For': '100.64.0.9',
      },
    })
    assert.deepEqual(asked, ['100.64.0.9'], 'behind Serve, the forwarded tailnet address is the peer')
    asked.length = 0
    await http(servePort, 'POST', TAILNET_MCP_PATH, {
      host: 'mac-mini.example.ts.net',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': '8.8.8.8' },
    })
    assert.deepEqual(asked, [''], 'an address off the tailnet is no peer at all')
    asked.length = 0
    await mcp(port, token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'X-Forwarded-For': '100.64.0.9' })
    assert.deepEqual(asked, ['127.0.0.1'], 'on the tailnet listener the header is ignored')
    await server.closeServeListener()
    assert.equal(server.serveAddress(), null)
  } finally {
    oauth.dispose()
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the service publishes HTTPS when asked, names it in the MCP URL, and takes it down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-oauth-https-'))
  const published: number[] = []
  const withdrawn: number[] = []
  let refuse = false
  writeTailnetSettings(dir, { enabled: true, port: await freePort(), notifications: false })
  const service = createTailnetRemoteService({
    resolveUserDataDir: () => dir,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => tools(),
    isMutation: () => false,
    resolveBindAddress: () => '127.0.0.1',
    resolveSelfDnsName: async () => 'mac-mini.example.ts.net',
    createPeerResolver: () => ({ identify: async () => MAC_MINI, resolve: async () => MAC_MINI.name }),
    publishHttps: async (localPort) => {
      published.push(localPort)
      return refuse
        ? { ok: false, message: 'Tailscale already serves something else on HTTPS port 443.' }
        : { ok: true, origin: 'https://mac-mini.example.ts.net' }
    },
    withdrawHttps: async (localPort) => {
      withdrawn.push(localPort)
    },
  })
  try {
    const started = await service.initialize()
    assert.equal(started.mcp?.https.state, 'off')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(
      service.getStatus().mcp?.url,
      `http://mac-mini.example.ts.net:${started.port}${TAILNET_MCP_PATH}`,
      'the MagicDNS name, once known',
    )
    const on = await service.setHttps(true)
    assert.equal(on.mcp?.https.state, 'on')
    assert.equal(on.mcp?.url, `https://mac-mini.example.ts.net${TAILNET_MCP_PATH}`)
    assert.equal(published.length, 1)
    assert.ok(published[0]! > 0 && published[0] !== started.port, 'Serve is pointed at the loopback listener')
    const off = await service.setHttps(false)
    assert.equal(off.mcp?.https.state, 'off')
    assert.deepEqual(withdrawn, published)
    assert.equal(off.mcp?.url, `http://mac-mini.example.ts.net:${started.port}${TAILNET_MCP_PATH}`)
    refuse = true
    const refused = await service.setHttps(true)
    assert.equal(refused.mcp?.https.state, 'error')
    assert.match(refused.mcp?.https.message ?? '', /something else/u)
    assert.equal(refused.mcp?.url?.startsWith('http://'), true)
  } finally {
    await service.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
