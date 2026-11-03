import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, test, vi } from 'vitest'

import {
  openRemoteConversationSocket,
  openRemoteEventsSocket,
  uploadRemoteConversationImage,
} from './tailnet-remote-client'
import {
  TAILNET_CONVERSATION_PATH,
  TAILNET_EVENTS_PATH,
  TAILNET_UPLOAD_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodePingFrame,
  encodePongFrame,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_TCP_KEEPALIVE_MS,
} from './websocket-frames'

// The conversation socket's liveness, against a listener that is only as much
// of one as the socket needs: a ticket, an upgrade, and pings when the test
// says. This end listens; it never pings. The change feed's socket pings only
// when asked to, for a wake to tell a live socket from a dead one.

type Far = {
  server: Server
  port: number
  /** The far end's side of the upgraded socket, once there is one. */
  socket: () => Socket | null
  /** Control frames this end sent, by kind. */
  received: { ping: number; pong: number }
  /** Whether the far end answers this end's pings. */
  answering: { value: boolean }
}

let far: Far | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  far?.socket()?.destroy()
  await new Promise<void>((resolve) => far?.server.close(() => resolve()) ?? resolve())
  far = null
})

async function startFar(path = TAILNET_CONVERSATION_PATH): Promise<Far> {
  let upgraded: Socket | null = null
  const received = { ping: 0, pong: 0 }
  const answering = { value: true }
  const server = createServer((request, response) => {
    if (request.url === TAILNET_WS_TICKET_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ticket: 'ticket' }))
      return
    }
    response.writeHead(404).end()
  })
  server.on('upgrade', (request, socket: Socket) => {
    assert.ok(request.url?.startsWith(path))
    const key = String(request.headers['sec-websocket-key'])
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
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES, 'server')
    socket.on('data', (chunk: Buffer) => {
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') return
      for (const frame of decoded.frames) {
        if (frame.kind === 'ping') {
          received.ping += 1
          if (answering.value) socket.write(encodePongFrame(frame.payload))
        }
        if (frame.kind === 'pong') received.pong += 1
      }
    })
    socket.on('error', () => undefined)
    upgraded = socket
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port, socket: () => upgraded, received, answering }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a conversation socket listens for the far end instead of pinging it, and ends when the far end goes quiet', async () => {
  far = await startFar()
  const keepAlive = vi.spyOn((await import('node:net')).Socket.prototype, 'setKeepAlive')
  const closes: string[] = []
  const opened = await openRemoteConversationSocket({
    endpoint: { host: '127.0.0.1', port: far.port },
    token: 'token',
    livenessTimeoutMs: 400,
    handlers: { onFrame: () => undefined, onClosed: ({ reason }) => closes.push(reason) },
  })
  assert.ok(opened.ok, opened.ok ? '' : opened.message)
  assert.ok(
    keepAlive.mock.calls.some(([enable, delay]) => enable === true && delay === WEBSOCKET_TCP_KEEPALIVE_MS),
    'the kernel watches the connection',
  )

  // The far end pings well inside the window: the link stays up, and this end
  // only answers.
  const beat = setInterval(() => far?.socket()?.write(encodePingFrame()), 40)
  try {
    await sleep(900)
    assert.equal(opened.value.isOpen(), true, 'a far end that keeps pinging keeps the link')
    assert.equal(far.received.ping, 0, 'this end never pings')
    assert.ok(far.received.pong > 0, 'it answers the far end')
  } finally {
    clearInterval(beat)
  }

  // The far end goes quiet without a close (a lid, a dropped route).
  await sleep(1_500)
  assert.equal(opened.value.isOpen(), false, 'silence past the window ends the link')
  assert.deepEqual(closes, ['That machine stopped answering.'])
})

test('a change feed answers a ping while its socket carries frames, and stops answering once it is closed', async () => {
  far = await startFar(TAILNET_EVENTS_PATH)
  const opened = await openRemoteEventsSocket({
    endpoint: { host: '127.0.0.1', port: far.port },
    token: 'token',
    handlers: { onFrame: () => undefined, onClosed: () => undefined },
  })
  assert.ok(opened.ok, opened.ok ? '' : opened.message)
  await opened.value.ping()
  assert.equal(far.received.ping, 1, 'one ping, answered')

  // A far end that has gone silent leaves the ping waiting (the caller's
  // deadline decides), and closing the socket ends the wait.
  far.answering.value = false
  let settled: string | null = null
  const unanswered = opened.value.ping().then(
    () => (settled = 'answered'),
    (error: Error) => (settled = error.message),
  )
  await sleep(200)
  assert.equal(settled, null, 'no pong, no answer')
  opened.value.close('Stopped watching.')
  await unanswered
  assert.equal(settled, 'Stopped watching.')
  await assert.rejects(opened.value.ping(), /Stopped watching/u)
})

test('an image goes up the upload route as its own bytes, and the answer names its upload or says why not', async () => {
  const seen: Array<{ method?: string; url?: string; headers: Record<string, unknown>; body: Buffer }> = []
  let answer: { status: number; body?: unknown } = { status: 200, body: { uploadId: 'upload-1', bytes: 4 } }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) })
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  far = {
    server,
    port: (server.address() as { port: number }).port,
    socket: () => null,
    received: { ping: 0, pong: 0 },
    answering: { value: true },
  }
  const upload = () =>
    uploadRemoteConversationImage({
      endpoint: { host: '127.0.0.1', port: far!.port },
      token: 'device-token',
      sessionId: 'session 1',
      name: 'screen shot.png',
      mediaType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })

  assert.deepEqual(await upload(), { ok: true, value: { uploadId: 'upload-1' } })
  const [request] = seen
  assert.equal(request.method, 'POST')
  const url = new URL(request.url ?? '', 'http://far.invalid')
  assert.equal(url.pathname, TAILNET_UPLOAD_PATH)
  assert.equal(url.searchParams.get('sessionId'), 'session 1')
  assert.equal(url.searchParams.get('name'), 'screen shot.png')
  assert.equal(request.headers['content-type'], 'image/png', 'the type is the image’s, not JSON')
  assert.equal(request.headers.authorization, 'Bearer device-token')
  assert.equal(request.headers.origin, undefined, 'no Origin, which the listener refuses')
  assert.deepEqual([...request.body], [0x89, 0x50, 0x4e, 0x47], 'the bytes as they are, not encoded')

  answer = {
    status: 409,
    body: { error: { code: 'images_unsupported', message: 'This conversation cannot accept images.' } },
  }
  assert.deepEqual(await upload(), {
    ok: false,
    code: 'images_unsupported',
    message: 'This conversation cannot accept images.',
  })
  answer = { status: 401 }
  const revoked = await upload()
  assert.equal(revoked.ok ? '' : revoked.code, 'unauthorized')
  answer = { status: 404 }
  const older = await upload()
  assert.equal(older.ok ? '' : older.code, 'http_404', 'a route the machine does not have is told apart')
})
