import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { ConversationEvent } from '../../../shared/conversation-runtime'
import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import { ConversationRuntime } from '../../conversation-runtime'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'
import {
  CONVERSATION_IMAGE_MAX_BYTES,
  conversationImageFileOf,
  conversationImagePathOf,
  sniffConversationImage,
} from './tailnet-conversation-images'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet-mesh-service'
import { fetchRemoteConversationImage } from './tailnet-remote-client'
import { pairingUrl } from './tailnet-service'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import {
  TAILNET_CAPABILITIES,
  TAILNET_CONVERSATION_IMAGE_PATH,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_PAIR_PATH,
} from './tailnet-routes'

// The conversation-image route, end to end: a real gateway on loopback, the
// real conversation host, and a runtime whose transcript recorded the steps a
// provider announced. What the route serves is decided by that record and by
// the file's own bytes, so both are real here.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')

const workspaceId = 'workspace'
const agentId = 'agent'

type Step = { id: string; name: string; kind?: string; input: Record<string, unknown>; status?: string }

/** A provider whose turn announces the steps its message lists, as JSON. */
function stepProvider(): ConversationProviderAdapter {
  const base = createMockConversationProvider()
  return {
    ...base,
    sendTurn(input) {
      const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: 1,
        type,
        payload,
      })
      const steps = JSON.parse(input.message) as Step[]
      return [
        event('turn_started', { turnId: input.turnId }),
        ...steps.flatMap((step) => [
          event('tool_started', {
            turnId: input.turnId,
            toolUseId: step.id,
            name: step.name,
            ...(step.kind ? { kind: step.kind } : {}),
            input: step.input,
          }),
          // `pending` stands for a step still waiting on its approval: announced, never ended.
          ...(step.status === 'pending'
            ? []
            : [
                event('tool_output', {
                  turnId: input.turnId,
                  toolUseId: step.id,
                  output: 'done',
                  status: step.status ?? 'ok',
                }),
              ]),
        ]),
        event('turn_completed', { turnId: input.turnId }),
      ]
    },
  }
}

let workspaceRoot: string
let devicesDir: string
let files: string
let runtime: ConversationRuntime
let server: TailnetGatewayServer
let port: number
let reader: string
let noConversations: string
let elsewhere: string
let meshDir: string
let mesh: TailnetMeshService
let connectionId: string

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'conversation-images-workspace-'))
  devicesDir = mkdtempSync(join(tmpdir(), 'conversation-images-devices-'))
  files = mkdtempSync(join(tmpdir(), 'conversation-images-files-'))
  writeFileSync(join(files, 'generated.png'), PNG)
  // Named .png, but the bytes are a JPEG: the bytes decide.
  writeFileSync(join(files, 'screenshot.png'), JPEG)
  writeFileSync(join(workspaceRoot, 'relative.gif'), GIF)
  writeFileSync(join(files, 'notes.png'), 'these are words, not a picture')
  writeFileSync(join(files, 'notes.txt'), 'plain text')
  writeFileSync(join(files, 'huge.png'), PNG)
  truncateSync(join(files, 'huge.png'), CONVERSATION_IMAGE_MAX_BYTES + 1)
  writeFileSync(join(files, 'linked-target.webp'), WEBP)
  symlinkSync(join(files, 'linked-target.webp'), join(files, 'linked.webp'))
  mkdirSync(join(files, 'folder.png'))
  // Outside the chat's folder and Studio's picture folders, and a link in the
  // chat's folder that leads there.
  elsewhere = mkdtempSync(join(tmpdir(), 'conversation-images-elsewhere-'))
  writeFileSync(join(elsewhere, 'outside.png'), PNG)
  symlinkSync(join(elsewhere, 'outside.png'), join(workspaceRoot, 'leads-out.png'))

  const provider = stepProvider()
  runtime = new ConversationRuntime({ adapters: [provider], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
    undefined,
    undefined,
    undefined,
    undefined,
    // Stands for Studio's own picture folders, which a step's picture may be in.
    { imageRoots: () => [files] },
  )
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.id,
    modelId: provider.listModels()[0],
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const steps: Step[] = [
    // Codex announces a picture twice: once as it starts, and again with the
    // path once the picture is saved. The second word is the one that stands.
    { id: 'generate', name: 'GenerateImage', kind: 'other', input: { prompt: 'a lighthouse' } },
    {
      id: 'generate',
      name: 'GenerateImage',
      kind: 'other',
      input: { prompt: 'a lighthouse', path: join(files, 'generated.png') },
    },
    { id: 'read-image', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'screenshot.png') } },
    { id: 'read-relative', name: 'Read', input: { path: 'relative.gif' } },
    { id: 'read-outside', name: 'Read', kind: 'file_read', input: { file_path: join(elsewhere, 'outside.png') } },
    {
      id: 'read-leads-out',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(workspaceRoot, 'leads-out.png') },
    },
    { id: 'read-linked', name: 'Read', kind: 'file_read', input: { filePath: join(files, 'linked.webp') } },
    { id: 'read-text', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'notes.txt') } },
    { id: 'read-words', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'notes.png') } },
    { id: 'read-huge', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'huge.png') } },
    { id: 'read-missing', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'gone.png') } },
    { id: 'read-folder', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'folder.png') } },
    { id: 'edit-image', name: 'Write', kind: 'file_write', input: { file_path: join(files, 'generated.png') } },
    { id: 'generate-unsaved', name: 'GenerateImage', kind: 'other', input: { prompt: 'nothing saved' } },
    // Announced before the person answered, then declined: the chat shows
    // no picture, and neither does the route.
    {
      id: 'read-declined',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(files, 'screenshot.png') },
      status: 'declined',
    },
    {
      id: 'read-unanswered',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(files, 'screenshot.png') },
      status: 'pending',
    },
    {
      id: 'read-failed',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(files, 'screenshot.png') },
      status: 'error',
    },
  ]
  const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: JSON.stringify(steps) })
  assert.ok(sent.ok)
  await runtime.flushTranscripts()

  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => devicesDir })
  server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    conversations: host,
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  port = server.address()!.port
  const pair = async (scopes: TailnetScope[]): Promise<string> => {
    const offer = devices.offerPairing({ scopes })
    const answer = await get(TAILNET_PAIR_PATH, {
      method: 'POST',
      body: { pairingToken: offer.token, deviceName: 'android-phone' },
    })
    assert.equal(answer.status, 200)
    return (JSON.parse(answer.body.toString('utf8')) as { deviceToken: string }).deviceToken
  }
  reader = await pair(['conversation:read'])
  noConversations = await pair(TAILNET_SCOPES.filter((scope) => !scope.startsWith('conversation:')))

  // A second desktop, paired with this one, following its chats.
  meshDir = mkdtempSync(join(tmpdir(), 'conversation-images-mesh-'))
  mesh = createTailnetMeshService({
    resolveUserDataDir: () => meshDir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const offer = devices.offerPairing({ scopes: ['conversation:read'] })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  connectionId = paired.connection.id
})

afterAll(async () => {
  mesh?.shutdown()
  await server?.stop()
  await runtime?.shutdown()
  for (const dir of [workspaceRoot, devicesDir, files, meshDir, elsewhere])
    if (dir) rmSync(dir, { recursive: true, force: true })
})

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

function get(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        agent: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function imagePath(toolUseId: string, extra: Record<string, string> = {}, key = { workspaceId, agentId }): string {
  const query = new URLSearchParams({ ...key, toolUseId, ...extra })
  return `${TAILNET_CONVERSATION_IMAGE_PATH}?${query.toString()}`
}

function errorOf(answer: Answer): { code: string; message: string } {
  assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8')
  return (JSON.parse(answer.body.toString('utf8')) as { error: { code: string; message: string } }).error
}

test('a picture outside the chat’s folders and Studio’s picture folders is not served', async () => {
  for (const id of ['read-outside', 'read-leads-out']) {
    const answer = await get(imagePath(id), { token: reader })
    assert.equal(answer.status, 404, id)
    assert.equal(errorOf(answer).code, 'unknown_image', id)
  }
})

test('a generated picture is served as the bytes on disk, under the path its last announcement named', async () => {
  const answer = await get(imagePath('generate'), { token: reader })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'image/png')
  assert.equal(answer.headers['content-length'], String(PNG.length))
  assert.equal(answer.headers['cache-control'], 'private, max-age=86400')
  assert.deepEqual(answer.body, PNG)
})

test('a picture a step read is served under the type its bytes say, not its name', async () => {
  const answer = await get(imagePath('read-image'), { token: reader })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'image/jpeg', 'screenshot.png holds a JPEG')
  assert.deepEqual(answer.body, JPEG)
})

test('a relative path names a file in the chat’s folder, and a link is followed to the picture it names', async () => {
  const relative = await get(imagePath('read-relative'), { token: reader })
  assert.equal(relative.status, 200)
  assert.equal(relative.headers['content-type'], 'image/gif')
  assert.deepEqual(relative.body, GIF)
  const linked = await get(imagePath('read-linked'), { token: reader })
  assert.equal(linked.status, 200)
  assert.equal(linked.headers['content-type'], 'image/webp')
  assert.deepEqual(linked.body, WEBP)
})

test('a path in the query is never read: the step names the file', async () => {
  const answer = await get(imagePath('generate', { path: join(files, 'screenshot.png') }), { token: reader })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, PNG, 'the step’s own picture, not the one the query named')
  const unknown = await get(imagePath('no-such-step', { path: join(files, 'generated.png') }), { token: reader })
  assert.equal(unknown.status, 404)
  assert.equal(errorOf(unknown).code, 'unknown_image')
})

test('without a device token the route is refused, and without a conversation grant it says which scope', async () => {
  const anonymous = await get(imagePath('generate'))
  assert.equal(anonymous.status, 401)
  assert.equal(errorOf(anonymous).code, 'unauthorized')
  const wrongScope = await get(imagePath('generate'), { token: noConversations })
  assert.equal(wrongScope.status, 403)
  assert.equal(errorOf(wrongScope).code, 'tailnet_scope_required')
})

test('a request that does not name the chat and the step is refused as invalid', async () => {
  const answer = await get(`${TAILNET_CONVERSATION_IMAGE_PATH}?workspaceId=${workspaceId}&agentId=${agentId}`, {
    token: reader,
  })
  assert.equal(answer.status, 400)
  assert.equal(errorOf(answer).code, 'invalid_arguments')
})

test('a chat this machine does not have is an unknown conversation', async () => {
  for (const key of [
    { workspaceId: 'elsewhere', agentId },
    { workspaceId, agentId: 'nobody' },
  ]) {
    const answer = await get(imagePath('generate', {}, key), { token: reader })
    assert.equal(answer.status, 404)
    assert.equal(errorOf(answer).code, 'unknown_conversation')
  }
})

test('a step that is not there, shows no picture, or saved none is an unknown image', async () => {
  for (const toolUseId of [
    'no-such-step',
    'read-text',
    'edit-image',
    'generate-unsaved',
    'read-declined',
    'read-unanswered',
    'read-failed',
  ]) {
    const answer = await get(imagePath(toolUseId), { token: reader })
    assert.equal(answer.status, 404, toolUseId)
    assert.equal(errorOf(answer).code, 'unknown_image', toolUseId)
  }
})

test('a picture that is gone, or a path that is not a file, is an unknown image', async () => {
  for (const toolUseId of ['read-missing', 'read-folder']) {
    const answer = await get(imagePath(toolUseId), { token: reader })
    assert.equal(answer.status, 404, toolUseId)
    assert.equal(errorOf(answer).code, 'unknown_image', toolUseId)
  }
})

test('a file named like a picture whose bytes are not one is refused as not an image', async () => {
  const answer = await get(imagePath('read-words'), { token: reader })
  assert.equal(answer.status, 415)
  assert.equal(errorOf(answer).code, 'not_an_image')
})

test('a picture over the ceiling is refused as too large', async () => {
  const answer = await get(imagePath('read-huge'), { token: reader })
  assert.equal(answer.status, 413)
  assert.equal(errorOf(answer).code, 'image_too_large')
})

test('health and identity advertise the capability', async () => {
  assert.ok(TAILNET_CAPABILITIES.includes('conversation-images'))
  const health = JSON.parse((await get(TAILNET_HEALTH_PATH)).body.toString('utf8')) as { capabilities: string[] }
  assert.ok(health.capabilities.includes('conversation-images'))
  const identity = await get(TAILNET_IDENTITY_PATH, { token: reader })
  assert.ok(
    (JSON.parse(identity.body.toString('utf8')) as { capabilities: string[] }).capabilities.includes(
      'conversation-images',
    ),
  )
})

test('the four formats are told apart by their first bytes, and nothing else passes', () => {
  assert.equal(sniffConversationImage(PNG), 'image/png')
  assert.equal(sniffConversationImage(JPEG), 'image/jpeg')
  assert.equal(sniffConversationImage(WEBP), 'image/webp')
  assert.equal(sniffConversationImage(GIF), 'image/gif')
  assert.equal(sniffConversationImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffConversationImage(Buffer.from('BM')), null, 'a bitmap is not one of the four')
  assert.equal(sniffConversationImage(Buffer.alloc(0)), null)
})

test('only a generated picture or a read of a picture names a file', () => {
  assert.equal(
    conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: { path: '/tmp/a.png' } }),
    '/tmp/a.png',
  )
  assert.equal(
    conversationImagePathOf({ name: 'Read', kind: undefined, input: { file_path: '/tmp/a.jpg' } }),
    '/tmp/a.jpg',
  )
  assert.equal(conversationImagePathOf({ name: 'Read', kind: 'file_read', input: { file_path: '/tmp/a.ts' } }), null)
  assert.equal(conversationImagePathOf({ name: 'Bash', kind: 'command', input: { path: '/tmp/a.png' } }), null)
  assert.equal(conversationImagePathOf({ name: 'Write', kind: 'file_write', input: { file_path: '/tmp/a.png' } }), null)
  assert.equal(conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: {} }), null)
  assert.equal(conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: 'not an object' }), null)
})

// ── A paired desktop showing a remote chat's pictures ───────────────────────

test('a paired desktop fetches a step’s picture over the same route, as a data URL', async () => {
  const key = { connectionId, workspaceId, agentId }
  const generated = await mesh.conversationToolImage({ key, toolUseId: 'generate' })
  assert.deepEqual(generated, { ok: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` })
  const read = await mesh.conversationToolImage({ key, toolUseId: 'read-image' })
  assert.deepEqual(read, { ok: true, dataUrl: `data:image/jpeg;base64,${JPEG.toString('base64')}` })
  const missing = await mesh.conversationToolImage({ key, toolUseId: 'read-missing' })
  assert.equal(missing.ok, false)
  assert.equal(!missing.ok && missing.code, 'unknown_image')
  const invalid = await mesh.conversationToolImage({ key, toolUseId: '' })
  assert.equal(!invalid.ok && invalid.code, 'invalid_arguments')
})

test('a picture asked for again is found without scanning the transcript again', async () => {
  const lookups = vi.spyOn(runtime, 'findToolCall')
  try {
    const first = await get(imagePath('read-linked'), { token: reader })
    assert.equal(first.status, 200)
    const scans = lookups.mock.calls.length
    const [second, third] = await Promise.all([
      get(imagePath('read-linked'), { token: reader }),
      get(imagePath('read-linked'), { token: reader }),
    ])
    assert.equal(second.status, 200)
    assert.deepEqual(third.body, second.body)
    assert.equal(lookups.mock.calls.length, scans, 'the step was found once')
  } finally {
    lookups.mockRestore()
  }
})

test('windows asking a paired machine for the same picture share one fetch, and keep it', async () => {
  let fetches = 0
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read'],
    transportVersion: 2,
    capabilities: ['events', 'conversations', 'conversation-images'],
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    request.resume()
    if (path === TAILNET_CONVERSATION_IMAGE_PATH) {
      fetches++
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length })
      response.end(PNG)
      return
    }
    const body = path === TAILNET_PAIR_PATH ? { ...device, deviceToken: 'device-token' } : device
    response.writeHead(path === TAILNET_PAIR_PATH || path === TAILNET_IDENTITY_PATH ? 200 : 404, {
      'Content-Type': 'application/json',
    })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const peerPort = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'conversation-images-shared-'))
  const follower = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  try {
    const paired = await follower.pair({ pairingUrl: pairingUrl('127.0.0.1', peerPort, 'pairing-token') })
    assert.ok(paired.ok, paired.ok ? '' : paired.message)
    const key = { connectionId: paired.connection.id, workspaceId, agentId }
    const [a, b] = await Promise.all([
      follower.conversationToolImage({ key, toolUseId: 'generate' }),
      follower.conversationToolImage({ key, toolUseId: 'generate' }),
    ])
    const later = await follower.conversationToolImage({ key, toolUseId: 'generate' })
    const expected = { ok: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }
    assert.deepEqual([a, b, later], [expected, expected, expected])
    assert.equal(fetches, 1, 'one fetch across the wire')
    await follower.conversationToolImage({ key, toolUseId: 'another-step' })
    assert.equal(fetches, 2, 'another step is its own picture')
  } finally {
    follower.shutdown()
    await new Promise<void>((resolve) => peer.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A machine that speaks the transport but predates the route: it answers pairing and identity, and 404s the rest. */
async function olderMachine(capabilities: string[] | undefined) {
  let imageRequests = 0
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read'],
    transportVersion: 2,
    ...(capabilities ? { capabilities } : {}),
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    request.resume()
    if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
    if (path === TAILNET_IDENTITY_PATH) return json(200, device)
    if (path === TAILNET_CONVERSATION_IMAGE_PATH) imageRequests++
    return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const peerPort = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'conversation-images-older-'))
  const follower = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await follower.pair({ pairingUrl: pairingUrl('127.0.0.1', peerPort, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  return {
    mesh: follower,
    key: { connectionId: paired.connection.id, workspaceId, agentId },
    imageRequests: () => imageRequests,
    async close() {
      follower.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a machine whose handshake leaves the capability out is not asked, and its picture stays over there', async () => {
  const older = await olderMachine(['events', 'upload', 'conversations'])
  try {
    await older.mesh.checkReachability(older.key.connectionId)
    const answer = await older.mesh.conversationToolImage({ key: older.key, toolUseId: 'generate' })
    assert.equal(!answer.ok && answer.code, 'images_unsupported')
    assert.equal(older.imageRequests(), 0)
  } finally {
    await older.close()
  }
})

test('a machine that has not said what it can do is asked, and a route it does not have reads as unsupported', async () => {
  const older = await olderMachine(undefined)
  try {
    const answer = await older.mesh.conversationToolImage({ key: older.key, toolUseId: 'generate' })
    assert.equal(!answer.ok && answer.code, 'images_unsupported')
    assert.equal(older.imageRequests(), 1)
  } finally {
    await older.close()
  }
})

test('the fetch is bounded by the ceiling and re-reads the type off the bytes', async () => {
  let body = Buffer.alloc(0)
  let declare = true
  const peer = createServer((request, response) => {
    request.resume()
    response.writeHead(200, {
      'Content-Type': 'image/png',
      ...(declare ? { 'Content-Length': body.length } : {}),
    })
    response.end(body)
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const endpoint = { host: '127.0.0.1', port: (peer.address() as { port: number }).port }
  const fetch = (maxBytes: number) =>
    fetchRemoteConversationImage({ endpoint, token: 'token', workspaceId, agentId, toolUseId: 'step', maxBytes })
  try {
    body = Buffer.concat([PNG, Buffer.alloc(64)])
    const declared = await fetch(32)
    assert.equal(!declared.ok && declared.code, 'image_too_large')
    declare = false
    const streamed = await fetch(32)
    assert.equal(!streamed.ok && streamed.code, 'image_too_large', 'a body with no length is counted as it arrives')
    body = Buffer.from('not a picture at all')
    const words = await fetch(1024)
    assert.equal(!words.ok && words.code, 'not_an_image', 'the header said image/png; the bytes did not')
    body = WEBP
    const webp = await fetch(1024)
    assert.ok(webp.ok)
    assert.equal(webp.value.mediaType, 'image/webp')
  } finally {
    await new Promise<void>((resolve) => peer.close(() => resolve()))
  }
})

test("a WSL chat's picture paths are opened as Windows spells them", () => {
  // A drive mount is its drive; a path in the distribution its share, spelled as the folder is.
  assert.equal(
    conversationImageFileOf('/mnt/c/Users/dev/shot.png', 'C:\\Users\\dev\\repo', 'win32'),
    'C:\\Users\\dev\\shot.png',
  )
  assert.equal(
    conversationImageFileOf('/home/dev/repo/shot.png', '\\\\wsl$\\Ubuntu\\home\\dev\\repo', 'win32'),
    '//wsl$/Ubuntu/home/dev/repo/shot.png',
  )
  // A distribution the folder does not name cannot be guessed; elsewhere nothing changes.
  assert.equal(conversationImageFileOf('/home/dev/shot.png', 'C:\\repo', 'win32'), '/home/dev/shot.png')
  assert.equal(conversationImageFileOf('/Users/dev/shot.png', '/Users/dev/repo', 'darwin'), '/Users/dev/shot.png')
})
