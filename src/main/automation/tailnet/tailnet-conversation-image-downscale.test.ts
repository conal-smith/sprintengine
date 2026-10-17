import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { MAX_ATTACHMENT_BYTES, MAX_DOWNSCALED_UPLOAD_BYTES } from '../../../shared/conversation-attachments'
import type { ConversationImageDownscaler } from '../../conversation-image-downscale'
import type { ConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import { TAILNET_HEALTH_PATH, TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH, TAILNET_UPLOAD_PATH } from './tailnet-routes'

// A picture a phone uploads for a chat, on a real gateway on loopback: shrunk
// for the model on receipt where this machine can (`conversation-image-downscale`),
// which also lets the upload be larger as it arrives; kept as it came, under
// the old 5MB, where it cannot.

const MB = 1024 * 1024

type Registered = Parameters<NonNullable<ConversationGatewayHost['registerUpload']>>[0]

type Gateway = {
  server: TailnetGatewayServer
  port: number
  token: string
  registered: Registered[]
  dirs: string[]
}

const shrinkCalls: Array<{ bytes: number; mediaType: string }> = []
// What the stand-in downscaler answers for an upload of a given size.
let shrinkTo: (bytes: Uint8Array, mediaType: string) => { bytes: Uint8Array; mediaType: string } = (_, mediaType) => ({
  bytes: new Uint8Array(400_000).fill(7),
  mediaType,
})
const downscale: ConversationImageDownscaler = async (bytes, mediaType) => {
  shrinkCalls.push({ bytes: bytes.byteLength, mediaType })
  return shrinkTo(bytes, mediaType)
}

let shrinking: Gateway
let plain: Gateway

async function gateway(downscaleUpload?: ConversationImageDownscaler): Promise<Gateway> {
  const devicesDir = mkdtempSync(join(tmpdir(), 'image-downscale-devices-'))
  const registered: Registered[] = []
  const host = {
    list: async () => [
      { sessionId: 'sess-1', workspaceId: 'workspace', agentId: 'agent', capabilities: { images: true } },
    ],
    resolveKey: (workspaceId: string, agentId: string) => ({ workspaceId, agentId, workspaceRoot: '/Users/dev/app' }),
    registerUpload: (input: Registered) => {
      registered.push(input)
      return `upload-${registered.length}`
    },
  } as unknown as ConversationGatewayHost
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => devicesDir })
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    conversations: host,
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
    ...(downscaleUpload ? { downscaleUpload } : {}),
  })
  await server.start()
  const port = server.address()!.port
  const offer = devices.offerPairing({ scopes: ['conversation:read', 'conversation:operate'] })
  const paired = await call(port, TAILNET_PAIR_PATH, {
    method: 'POST',
    json: { pairingToken: offer.token, deviceName: 'android-phone' },
  })
  assert.equal(paired.status, 200)
  const token = (JSON.parse(paired.body) as { deviceToken: string }).deviceToken
  return { server, port, token, registered, dirs: [devicesDir] }
}

beforeAll(async () => {
  shrinking = await gateway(downscale)
  plain = await gateway()
})

afterAll(async () => {
  for (const each of [shrinking, plain]) {
    await each?.server.stop()
    for (const dir of each?.dirs ?? []) rmSync(dir, { recursive: true, force: true })
  }
})

type Answer = { status: number; body: string }

function call(
  port: number,
  path: string,
  options: { method?: string; token?: string; json?: unknown; image?: { bytes: Buffer; mediaType: string } } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload =
      options.json !== undefined ? Buffer.from(JSON.stringify(options.json)) : (options.image?.bytes ?? undefined)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        agent: false,
        headers: {
          ...(options.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.image ? { 'Content-Type': options.image.mediaType } : {}),
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function upload(target: Gateway, bytes: Buffer, mediaType = 'image/jpeg'): Promise<Answer> {
  const query = new URLSearchParams({ sessionId: 'sess-1', name: 'IMG_0001.jpg' })
  return call(target.port, `${TAILNET_UPLOAD_PATH}?${query.toString()}`, {
    method: 'POST',
    token: target.token,
    image: { bytes, mediaType },
  })
}

const capabilitiesOf = (answer: Answer) => (JSON.parse(answer.body) as { capabilities: string[] }).capabilities

test('a machine that can shrink an upload says so, and one that cannot does not', async () => {
  for (const path of [TAILNET_HEALTH_PATH, TAILNET_IDENTITY_PATH]) {
    const yes = await call(shrinking.port, path, { token: shrinking.token })
    const no = await call(plain.port, path, { token: plain.token })
    assert.ok(capabilitiesOf(yes).includes('conversation-image-downscale'), path)
    assert.ok(!capabilitiesOf(no).includes('conversation-image-downscale'), path)
    assert.ok(capabilitiesOf(no).includes('conversation-message-images'), 'nothing else is taken away')
  }
})

test('a camera photo over 5MB is taken, shrunk, and kept at the shrunk size', async () => {
  shrinkCalls.length = 0
  const photo = Buffer.alloc(8 * MB, 1)
  const answer = await upload(shrinking, photo)
  assert.equal(answer.status, 200, answer.body)
  assert.deepEqual(shrinkCalls, [{ bytes: 8 * MB, mediaType: 'image/jpeg' }])
  const kept = shrinking.registered.at(-1)!
  assert.equal(kept.bytes, 400_000)
  assert.equal(kept.mediaType, 'image/jpeg')
  assert.equal(readFileSync(kept.path).byteLength, 400_000, 'the file the send reads is the shrunk one')
})

test('a shrunk picture may change type, and the type it is kept as is the new one', async () => {
  shrinkTo = () => ({ bytes: new Uint8Array(300_000), mediaType: 'image/jpeg' })
  try {
    const answer = await upload(shrinking, Buffer.alloc(7 * MB, 2), 'image/png')
    assert.equal(answer.status, 200, answer.body)
    assert.equal(shrinking.registered.at(-1)!.mediaType, 'image/jpeg')
  } finally {
    shrinkTo = (_, mediaType) => ({ bytes: new Uint8Array(400_000).fill(7), mediaType })
  }
})

test('a picture still over 5MB after shrinking is refused, and nothing is kept', async () => {
  const before = shrinking.registered.length
  shrinkTo = (bytes, mediaType) => ({ bytes, mediaType })
  try {
    const answer = await upload(shrinking, Buffer.alloc(6 * MB, 3))
    assert.equal(answer.status, 413)
    const error = (JSON.parse(answer.body) as { error: { code: string; message: string } }).error
    assert.equal(error.code, 'too_large')
    assert.match(error.message, /still over the 5MB limit after resizing/)
    assert.equal(shrinking.registered.length, before)
  } finally {
    shrinkTo = (_, mediaType) => ({ bytes: new Uint8Array(400_000).fill(7), mediaType })
  }
})

test('a small picture the downscaler leaves alone is kept as it came', async () => {
  shrinkTo = (bytes, mediaType) => ({ bytes, mediaType })
  try {
    const answer = await upload(shrinking, Buffer.alloc(100_000, 4))
    assert.equal(answer.status, 200, answer.body)
    assert.equal(shrinking.registered.at(-1)!.bytes, 100_000)
  } finally {
    shrinkTo = (_, mediaType) => ({ bytes: new Uint8Array(400_000).fill(7), mediaType })
  }
})

test('an upload over 20MB is refused even where pictures are shrunk', async () => {
  const answer = await upload(shrinking, Buffer.alloc(MAX_DOWNSCALED_UPLOAD_BYTES + 1, 5))
  assert.equal(answer.status, 413)
  assert.match(answer.body, /over the 20MB limit/)
})

test('where nothing shrinks a picture, the old 5MB still holds and nothing is resized', async () => {
  shrinkCalls.length = 0
  const answer = await upload(plain, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 6))
  assert.equal(answer.status, 413)
  assert.match(answer.body, /over the 5MB limit/)
  const small = await upload(plain, Buffer.alloc(200_000, 6))
  assert.equal(small.status, 200)
  assert.equal(plain.registered.at(-1)!.bytes, 200_000)
  assert.deepEqual(shrinkCalls, [])
})
