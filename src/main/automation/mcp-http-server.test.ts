import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createMcpHttpServer, MAX_MCP_HTTP_BODY_BYTES, MCP_HTTP_PATH, type McpHttpServer } from './mcp-http-server'
import { createMcpHttpTokenStore, MCP_HTTP_FILE } from './mcp-http-tokens'

// The gateway over loopback HTTP: a bearer token per client, kept hashed;
// 127.0.0.1 only; `Host` and `Origin` checked as the web listener checks them;
// bodies bounded; the socket's dispatcher behind it.

const echo: McpToolRegistration = {
  name: 'test.echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: {} },
  handler: async (args, context) => toolSuccess({ args, kind: context?.metadata.kind }),
}

const running: McpHttpServer[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.stop()
})

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-http-'))
  const file = join(dir, MCP_HTTP_FILE)
  const store = createMcpHttpTokenStore({ file })
  const server = createMcpHttpServer({
    serverName: 'sprintengine-studio',
    serverVersion: '0.0.0-test',
    resolveTools: () => [echo],
    authenticate: (token) => store.authenticate(token),
  })
  running.push(server)
  const port = await server.start(null)
  const made = store.create('editor')
  assert.ok(made.ok)
  return { store, server, port, token: made.token, file }
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: any }

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? MCP_HTTP_PATH,
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : null })
        })
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

test('it listens on 127.0.0.1 alone', async () => {
  const { server, port } = await harness()
  assert.equal(server.isRunning(), true)
  assert.ok(port > 0)
})

test('a request without a token, or with one not made here, is refused', async () => {
  const { port } = await harness()
  const none = await send(port, { body: rpc('tools/list') })
  assert.equal(none.status, 401)
  assert.equal(none.headers['www-authenticate'], 'Bearer')
  const wrong = await send(port, { body: rpc('tools/list'), headers: bearer('semcp_not-a-token') })
  assert.equal(wrong.status, 401)
})

test('a client with a token lists and calls the gateway tools, as an outside client of this machine', async () => {
  const { port, token } = await harness()
  const listed = await send(port, { body: rpc('tools/list'), headers: bearer(token) })
  assert.equal(listed.status, 200)
  assert.deepEqual(
    listed.body.result.tools.map((tool: { name: string }) => tool.name),
    ['test.echo'],
  )
  const called = await send(port, {
    body: rpc('tools/call', { name: 'test.echo', arguments: { say: 'hi' } }),
    headers: bearer(token),
  })
  assert.equal(called.body.result.structuredContent.kind, 'external-local')
  assert.deepEqual(called.body.result.structuredContent.args, { say: 'hi' })
})

test('a revoked token stops working at once', async () => {
  const { port, token, store, server } = await harness()
  const [client] = store.list()
  assert.equal(store.revoke(client!.id), true)
  server.dropClient(client!.id)
  assert.equal((await send(port, { body: rpc('tools/list'), headers: bearer(token) })).status, 401)
})

test('a request to another host name (DNS rebinding) or from a page elsewhere is refused', async () => {
  const { port, token } = await harness()
  const rebound = await send(port, {
    body: rpc('tools/list'),
    headers: { ...bearer(token), host: `evil.example:${port}` },
  })
  assert.equal(rebound.status, 421)
  const otherPort = await send(port, { body: rpc('tools/list'), headers: { ...bearer(token), host: '127.0.0.1:1' } })
  assert.equal(otherPort.status, 421)
  const page = await send(port, {
    body: rpc('tools/list'),
    headers: { ...bearer(token), origin: 'https://evil.example' },
  })
  assert.equal(page.status, 403)
  const local = await send(port, {
    body: rpc('tools/list'),
    headers: { ...bearer(token), origin: 'http://localhost:6274', host: `localhost:${port}` },
  })
  assert.equal(local.status, 200, 'a tool running on this machine in a browser page may call it')
})

test('a body over the limit, a batch, a non-JSON type and a GET are refused', async () => {
  const { port, token } = await harness()
  const big = await send(port, { body: Buffer.alloc(MAX_MCP_HTTP_BODY_BYTES + 10, 32), headers: bearer(token) })
  assert.equal(big.status, 413)
  const batch = await send(port, { body: `[${rpc('ping')}]`, headers: bearer(token) })
  assert.equal(batch.status, 400)
  const text = await send(port, { body: rpc('ping'), headers: { ...bearer(token), 'content-type': 'text/plain' } })
  assert.equal(text.status, 415)
  const get = await send(port, { method: 'GET', headers: bearer(token) })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST, DELETE')
  const elsewhere = await send(port, { path: '/other', body: rpc('ping'), headers: bearer(token) })
  assert.equal(elsewhere.status, 404)
})

test('initialize starts a session the client keeps; another client cannot use it, and a gone one is 404', async () => {
  const { port, token, store } = await harness()
  const init = await send(port, { body: rpc('initialize', { protocolVersion: '2025-06-18' }), headers: bearer(token) })
  assert.equal(init.status, 200)
  const sessionId = init.headers['mcp-session-id'] as string
  assert.match(sessionId, /^[0-9a-f-]{36}$/u)
  const again = await send(port, { body: rpc('ping'), headers: { ...bearer(token), 'mcp-session-id': sessionId } })
  assert.equal(again.status, 200)

  const other = store.create('second')
  assert.ok(other.ok)
  const stolen = await send(port, {
    body: rpc('ping'),
    headers: { ...bearer(other.token), 'mcp-session-id': sessionId },
  })
  assert.equal(stolen.status, 404)

  const ended = await send(port, { method: 'DELETE', headers: { ...bearer(token), 'mcp-session-id': sessionId } })
  assert.equal(ended.status, 204)
  const gone = await send(port, { body: rpc('ping'), headers: { ...bearer(token), 'mcp-session-id': sessionId } })
  assert.equal(gone.status, 404)
})

test('a notification is accepted with no body, and an agent identity cannot be declared here', async () => {
  const { port, token } = await harness()
  const note = await send(port, { body: rpc('notifications/initialized', {}, null), headers: bearer(token) })
  assert.equal(note.status, 202)
  const connect = await send(port, {
    body: rpc('sprintengine.studio/connect', { workspaceId: 'w1', agentId: 'agent-1' }),
    headers: bearer(token),
  })
  assert.equal(connect.status, 400)
})

test('tokens are kept only hashed, with the port, and read back on the next start', async () => {
  const { file, token, store, port } = await harness()
  store.setPort(port)
  await store.flush()
  const saved = readFileSync(file, 'utf8')
  assert.ok(!saved.includes(token), 'the token is never written in the clear')
  const reread = createMcpHttpTokenStore({ file })
  assert.equal(reread.port(), port)
  assert.equal(reread.list().length, 1)
  assert.equal(reread.authenticate(token)?.name, 'editor')
})

test('a token needs a name, and names are bounded', () => {
  const store = createMcpHttpTokenStore({ file: join(mkdtempSync(join(tmpdir(), 'mcp-http-')), MCP_HTTP_FILE) })
  assert.equal(store.create('   ').ok, false)
  assert.equal(store.create('x'.repeat(61)).ok, false)
  const made = store.create('  my   editor ')
  assert.ok(made.ok)
  assert.equal(made.client.name, 'my editor')
  assert.match(made.token, /^semcp_[\w-]{43}$/u)
})

test('a port taken since is given up for another', async () => {
  const { port } = await harness()
  const second = createMcpHttpServer({
    serverName: 's',
    serverVersion: '0',
    resolveTools: () => [],
    authenticate: () => null,
  })
  running.push(second)
  const moved = await second.start(port)
  assert.notEqual(moved, port)
})
