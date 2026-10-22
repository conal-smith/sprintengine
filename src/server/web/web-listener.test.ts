import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createWebListener, type WebListener } from './web-listener'
import { createPairRequests, type PairRequests } from './web-pair-requests'
import { createWebSessionStore, type WebSessionStore } from './web-sessions'
import { openWebStaticRoot } from './web-static'
import { createWebUploads, uploadOwnerDir } from './web-uploads'

// The web listener's controls, each a test that fails if the control is
// removed (phase 9 spec, 8.6).

let dir: string
let sessions: WebSessionStore
let listener: WebListener
let port: number
let connected: Array<{ stream: Duplex; who: unknown }>
let tunnelled: string[]
let pairRequests: PairRequests
const MINT_KEY = 'mint-key-for-the-test-only-0123456789'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-listener-'))
  const web = join(dir, 'web')
  mkdirSync(join(web, 'assets'), { recursive: true })
  writeFileSync(
    join(web, 'index.html'),
    '<!doctype html><meta name="sprintengine-web-build" content="build-one"><title>app</title>',
  )
  writeFileSync(join(web, 'pair.html'), '<!doctype html><title>pair</title>')
  writeFileSync(join(web, 'canvas-worker.html'), '<!doctype html><title>worker</title>')
  const script = 'console.log("app")'.repeat(100)
  writeFileSync(join(web, 'assets', 'app-abc123.js'), script)
  writeFileSync(join(web, 'assets', 'app-abc123.js.br'), brotliCompressSync(script))
  sessions = createWebSessionStore({ dataDir: dir, environmentId: '05763914-5fa0-449b-96d7-15af49e0ec86' })
  connected = []
  tunnelled = []
  listener = createWebListener({
    sessions,
    staticRoot: openWebStaticRoot(web),
    port: 0,
    publicOrigins: [],
    mintKey: MINT_KEY,
    pairRequests: (pairRequests = createPairRequests({ sessions })),
    uploads: createWebUploads({ dataDir: dir }),
    version: 'test',
    studio: { connect: (stream, who) => connected.push({ stream, who }) },
    tunnel: { attach: (client) => tunnelled.push(client.clientId), detach: () => undefined },
  })
  port = (await listener.start()).port
})

afterEach(async () => {
  await listener.stop()
  rmSync(dir, { recursive: true, force: true })
})

type Answer = { status: number; headers: IncomingHttpHeaders; body: string }

function ask(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const own = () => `http://127.0.0.1:${port}`

async function pair(): Promise<{ cookie: string; sessionId: string }> {
  const { code } = sessions.mintPairingCode()
  const answer = await ask('/pair/exchange', {
    method: 'POST',
    headers: { Origin: own(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(answer.status).toBe(200)
  const setCookie = answer.headers['set-cookie']?.[0] ?? ''
  return {
    cookie: setCookie.split(';')[0],
    sessionId: (JSON.parse(answer.body) as { session: { id: string } }).session.id,
  }
}

/** A raw upgrade: the status line, and the socket for reading what follows. */
function upgrade(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.once('data', (chunk: Buffer) => {
      const status = Number(/^HTTP\/1\.1 (\d+)/u.exec(chunk.toString('latin1'))?.[1] ?? 0)
      resolve({ status, socket })
    })
    socket.once('error', reject)
  })
}

test('the app page without a session goes to pairing', async () => {
  const answer = await ask('/')
  expect(answer.status).toBe(302)
  expect(answer.headers.location).toBe('./pair')
  // From a nested route, back to the root first, never to an app route of its own.
  expect((await ask('/a/b')).headers.location).toBe('../pair')
  expect((await ask('/pair/')).headers.location).toBe('../pair')
})

test('a rebinding Host is refused before anything is read', async () => {
  const answer = await ask('/pair', { headers: { Host: 'rebind.example' } })
  expect(answer.status).toBe(421)
})

test('a POST from another local port is refused, even one that would pair', async () => {
  const { code } = sessions.mintPairingCode()
  const answer = await ask('/pair/exchange', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(answer.status).toBe(403)
  // Refused at the door, so the code was never presented and still pairs.
  expect(sessions.exchange(code, { route: 'loopback' }).ok).toBe(true)
})

test('pairing sets an HttpOnly, SameSite=Strict cookie with no Domain, named for the environment', async () => {
  const { code } = sessions.mintPairingCode()
  const answer = await ask('/pair/exchange', {
    method: 'POST',
    headers: { Origin: own(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const cookie = answer.headers['set-cookie']?.[0] ?? ''
  expect(cookie).toMatch(/^se_s_057639145fa0=sesess_/u)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  expect(cookie).toContain('Path=/')
  expect(cookie).not.toMatch(/Domain=/iu)
})

test('the app page carries its security headers and is never cached', async () => {
  const { cookie } = await pair()
  const answer = await ask('/', { headers: { Cookie: cookie } })
  expect(answer.status).toBe(200)
  const csp = String(answer.headers['content-security-policy'])
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  expect(csp).not.toMatch(/script-src[^;]*blob:/u)
  expect(answer.headers['x-frame-options']).toBe('DENY')
  expect(answer.headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(answer.headers['cache-control']).toBe('no-store')
})

test('hashed assets are public, immutable, and sent precompressed when the browser takes it', async () => {
  const answer = await ask('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip, br' } })
  expect(answer.status).toBe(200)
  expect(answer.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(answer.headers['content-encoding']).toBe('br')
  expect(answer.headers['x-content-type-options']).toBe('nosniff')
})

test('a path that leaves the bundle is not served', async () => {
  writeFileSync(join(dir, 'secret.txt'), 'outside the bundle')
  expect((await ask('/assets/../../secret.txt')).status).not.toBe(200)
  expect((await ask('/%2e%2e/secret.txt')).status).not.toBe(200)
})

test('a cross-origin WebSocket upgrade is refused even with a valid cookie', async () => {
  const { cookie } = await pair()
  const { status, socket } = await upgrade('/ws', { Cookie: cookie, Origin: 'http://127.0.0.1:3000' })
  socket.destroy()
  expect(status).toBe(403)
  expect(connected).toHaveLength(0)
})

test('a cookie alone with no Origin does not upgrade', async () => {
  const { cookie } = await pair()
  const { status, socket } = await upgrade('/ws', { Cookie: cookie })
  socket.destroy()
  expect(status).toBe(403)
})

test('a ticket in the address does not stand in for an Origin where a cookie admits the socket', async () => {
  const { cookie } = await pair()
  const { status, socket } = await upgrade('/ws/ipc?ticket=anything', { Cookie: cookie })
  socket.destroy()
  expect(status).toBe(403)
  expect(tunnelled).toHaveLength(0)
})

test('a same-origin upgrade with the session is served as that session', async () => {
  const { cookie, sessionId } = await pair()
  const { status, socket } = await upgrade('/ws', { Cookie: cookie, Origin: own() })
  expect(status).toBe(101)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(connected).toHaveLength(1)
  expect((connected[0].who as { session: { id: string } }).session.id).toBe(sessionId)
  socket.destroy()
})

test('a ticket opens one socket, once', async () => {
  const { sessionId } = await pair()
  const { ticket } = sessions.mintTicket({ kind: 'session', sessionId })
  const first = await upgrade(`/ws?ticket=${ticket}`, {})
  expect(first.status).toBe(101)
  first.socket.destroy()
  const replay = await upgrade(`/ws?ticket=${ticket}`, {})
  replay.socket.destroy()
  expect(replay.status).toBe(401)
})

test('revoking a browser closes its sockets with 4401', async () => {
  const { cookie, sessionId } = await pair()
  const { status, socket } = await upgrade('/ws', { Cookie: cookie, Origin: own() })
  expect(status).toBe(101)
  const closed = new Promise<number>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      // An unmasked close frame from the server: opcode 0x8, then the code.
      if ((chunk[0] & 0x0f) === 0x8) resolve(chunk.readUInt16BE(2))
    })
  })
  sessions.revoke(sessionId)
  expect(await closed).toBe(4401)
  socket.destroy()
})

test('the window.api tunnel is an owner session’s only', async () => {
  const owner = await pair()
  const ok = await upgrade('/ws/ipc?windowId=primary', { Cookie: owner.cookie, Origin: own() })
  ok.socket.destroy()
  expect(ok.status).toBe(101)
  const reader = sessions.issue({ route: 'loopback', owner: false })
  if (!reader.ok) throw new Error('not paired')
  const refused = await upgrade('/ws/ipc', { Cookie: `${sessions.cookieName}=${reader.secret}`, Origin: own() })
  refused.socket.destroy()
  expect(refused.status).toBe(403)
  expect(tunnelled).toHaveLength(1)
})

test('studio-server pair mints a link with the run file key, and a browser cannot', async () => {
  const minted = await ask('/pair/mint', { method: 'POST', headers: { Authorization: `Bearer ${MINT_KEY}` } })
  expect(minted.status).toBe(200)
  expect((JSON.parse(minted.body) as { url: string }).url).toMatch(/\/pair#code=sepair_/u)
  const fromPage = await ask('/pair/mint', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MINT_KEY}`, Origin: own() },
  })
  expect(fromPage.status).toBe(403)
  const wrongKey = await ask('/pair/mint', { method: 'POST', headers: { Authorization: 'Bearer nope-nope-nope-nope' } })
  expect(wrongKey.status).toBe(403)
})

test('the session answers which web bundle is served now, so an older tab can offer a reload', async () => {
  const { cookie } = await pair()
  const before = JSON.parse((await ask('/api/session', { headers: { Cookie: cookie } })).body) as { build: string }
  expect(before.build).toBe('build-one')
  const file = join(dir, 'web', 'index.html')
  writeFileSync(file, '<!doctype html><meta name="sprintengine-web-build" content="build-two"><title>app</title>')
  // A rebuild in the same millisecond keeps its mtime; move it on so the cache reads again.
  utimesSync(file, new Date(), new Date(Date.now() + 5_000))
  const after = JSON.parse((await ask('/api/session', { headers: { Cookie: cookie } })).body) as { build: string }
  expect(after.build).toBe('build-two')
})

test('no GET changes anything: logging out takes a POST', async () => {
  const { cookie } = await pair()
  expect((await ask('/api/logout', { headers: { Cookie: cookie } })).status).toBe(404)
  expect((await ask('/api/session', { headers: { Cookie: cookie } })).status).toBe(200)
})

test('the canvas worker page may be framed by the app itself, and by nothing else', async () => {
  const answer = await ask('/canvas-worker.html')
  expect(answer.status).toBe(200)
  expect(String(answer.headers['content-security-policy'])).toContain("frame-ancestors 'self'")
  expect(answer.headers['x-frame-options']).toBe('SAMEORIGIN')
  expect(String((await ask('/pair')).headers['content-security-policy'])).toContain("frame-ancestors 'none'")
})

test('pairing by approval: asked from the page’s own origin only, collected once with the cookie', async () => {
  const foreign = await ask('/pair/request', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Phone' }),
  })
  expect(foreign.status).toBe(403)
  const asked = await ask('/pair/request', {
    method: 'POST',
    headers: { Origin: own(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Phone' }),
  })
  const { requestId, code, collect } = JSON.parse(asked.body) as { requestId: string; code: string; collect: string }
  const poll = () =>
    ask('/pair/request/collect', {
      method: 'POST',
      headers: { Origin: own(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, collect }),
    })
  expect(JSON.parse((await poll()).body)).toEqual({ status: 'pending' })
  expect(pairRequests.approve(requestId, code)).toEqual({ ok: true })
  const approved = await poll()
  expect(JSON.parse(approved.body).status).toBe('approved')
  expect(approved.headers['set-cookie']?.[0]).toMatch(/^se_s_057639145fa0=sesess_.*HttpOnly; SameSite=Strict/u)
  expect(JSON.parse((await poll()).body)).toEqual({ status: 'expired' })
})

test("a pairing request through this server's own tailscale serve says which tailnet account asks", async () => {
  const serveOrigin = 'https://mac-mini.tail1234.ts.net'
  const askVia = (host: string, origin: string) =>
    ask('/pair/request', {
      method: 'POST',
      headers: {
        Host: host,
        Origin: origin,
        'Content-Type': 'application/json',
        'Tailscale-User-Login': 'dev@example.com',
      },
      body: JSON.stringify({ name: 'Phone' }),
    })
  // Before serve is set up, its name is no host of this listener.
  expect((await askVia('mac-mini.tail1234.ts.net', serveOrigin)).status).toBe(421)
  listener.addTailscaleServeOrigin(serveOrigin)
  expect(listener.origins()).toContain(serveOrigin)
  expect((await askVia('mac-mini.tail1234.ts.net', serveOrigin)).status).toBe(200)
  // The same header on the loopback name is a local program's, and not believed.
  expect((await askVia(`127.0.0.1:${port}`, own())).status).toBe(200)
  const pending = pairRequests.pending()
  expect(pending.map((request) => [request.route, request.tailnetLogin ?? null])).toEqual([
    ['tailnet', 'dev@example.com'],
    ['loopback', null],
  ])
  expect(() => listener.addTailscaleServeOrigin('http://mac-mini.tail1234.ts.net')).toThrow(/HTTPS/u)
})

test('an owner browser uploads a dropped file and is answered its path; nobody else can', async () => {
  const owner = await pair()
  const upload = (headers: Record<string, string>) =>
    ask('/api/upload?name=report.txt', { method: 'POST', headers, body: 'quarterly numbers' })
  const saved = await upload({ Cookie: owner.cookie, Origin: own(), 'Content-Type': 'application/octet-stream' })
  expect(saved.status).toBe(200)
  const { path } = JSON.parse(saved.body) as { path: string }
  expect(path.startsWith(join(dir, 'web-uploads', uploadOwnerDir(owner.sessionId)))).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('quarterly numbers')
  // Another page on this machine: its origin is not this listener's.
  expect((await upload({ Cookie: owner.cookie, Origin: 'http://127.0.0.1:3000' })).status).toBe(403)
  expect((await upload({ Origin: own() })).status).toBe(401)
  const reader = sessions.issue({ route: 'loopback', owner: false })
  if (!reader.ok) throw new Error('not paired')
  expect((await upload({ Cookie: `${sessions.cookieName}=${reader.secret}`, Origin: own() })).status).toBe(403)
})
