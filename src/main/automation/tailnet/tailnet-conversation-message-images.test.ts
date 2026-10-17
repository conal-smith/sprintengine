import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import type { ConversationImageAttachment } from '../../../shared/conversation-runtime'
import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import { ConversationAttachmentStore } from '../../conversation-attachment-store'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import {
  TAILNET_CAPABILITIES,
  TAILNET_CONVERSATION_IMAGE_PATH,
  TAILNET_HEALTH_PATH,
  TAILNET_PAIR_PATH,
} from './tailnet-routes'

// The pictures a person sent with a message, served on the conversation-image
// route by the ref their `user_message` recorded: a real gateway on loopback,
// the real conversation host, and a runtime whose attachment store kept what
// each turn carried. What may be served is decided by the store's folder for
// the chat and by the bytes, so both are real here.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])

const workspaceId = 'workspace'
const agentId = 'agent'
const otherAgentId = 'other-agent'

let workspaceRoot: string
let dataDir: string
let devicesDir: string
let runtime: ConversationRuntime
let server: TailnetGatewayServer
let port: number
let reader: string
let noConversations: string
/** What each sent picture was recorded as, by the name it was sent under. */
const refs = new Map<string, string>()

function attachment(id: string, name: string, mediaType: string, bytes: Buffer): ConversationImageAttachment {
  return { id, name, mediaType, dataBase64: bytes.toString('base64'), byteLength: bytes.length }
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'message-images-workspace-'))
  dataDir = mkdtempSync(join(tmpdir(), 'message-images-data-'))
  devicesDir = mkdtempSync(join(tmpdir(), 'message-images-devices-'))
  const provider = createMockConversationProvider()
  runtime = new ConversationRuntime({
    adapters: [provider],
    getProviderById: () => undefined,
    attachmentStore: new ConversationAttachmentStore(dataDir),
  })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
  )
  const send = async (agent: string, attachments: ConversationImageAttachment[]) => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId,
      agentId: agent,
      providerId: provider.id,
      modelId: provider.listModels()[0],
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
    const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'look', attachments })
    assert.ok(sent.ok, sent.ok ? '' : sent.message)
  }
  await send(agentId, [
    attachment('photo', 'IMG_0001.png', 'image/png', PNG),
    // Sent as a PNG, but the bytes are a JPEG: the bytes decide.
    attachment('mislabelled', 'IMG_0002.png', 'image/png', JPEG),
    attachment('words', 'IMG_0003.png', 'image/png', Buffer.from('these are words, not a picture')),
  ])
  await send(otherAgentId, [attachment('elsewhere', 'IMG_0004.png', 'image/png', PNG)])
  await runtime.flushTranscripts()
  for (const agent of [agentId, otherAgentId]) {
    const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId, agentId: agent })
    assert.ok(transcript.ok)
    for (const event of transcript.events)
      if (event.type === 'user_message')
        for (const entry of (event.payload?.attachments ?? []) as Array<{ name: string; ref: string }>)
          refs.set(entry.name, entry.ref)
  }
  assert.equal(refs.size, 4, 'every sent picture was kept')

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
})

afterAll(async () => {
  await server?.stop()
  await runtime?.shutdown()
  for (const dir of [workspaceRoot, dataDir, devicesDir]) if (dir) rmSync(dir, { recursive: true, force: true })
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

function sentPath(ref: string, extra: Record<string, string> = {}, key = { workspaceId, agentId }): string {
  const query = new URLSearchParams({ ...key, attachment: ref, ...extra })
  return `${TAILNET_CONVERSATION_IMAGE_PATH}?${query.toString()}`
}

function errorOf(answer: Answer): { code: string; message: string } {
  return (JSON.parse(answer.body.toString('utf8')) as { error: { code: string; message: string } }).error
}

test('the desktop says it serves the pictures a message carried', async () => {
  assert.ok((TAILNET_CAPABILITIES as readonly string[]).includes('conversation-message-images'))
  const health = await get(TAILNET_HEALTH_PATH)
  const body = JSON.parse(health.body.toString('utf8')) as { capabilities: string[] }
  assert.ok(body.capabilities.includes('conversation-message-images'))
})

test('a sent picture is served as the store kept it, by the ref its message recorded', async () => {
  const answer = await get(sentPath(refs.get('IMG_0001.png')!), { token: reader })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'image/png')
  assert.equal(answer.headers['content-length'], String(PNG.length))
  assert.equal(answer.headers['cache-control'], 'private, max-age=86400')
  assert.equal(answer.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(answer.body, PNG)
})

test('a sent picture is served under the type its bytes say, and one that is not a picture is not served', async () => {
  const mislabelled = await get(sentPath(refs.get('IMG_0002.png')!), { token: reader })
  assert.equal(mislabelled.status, 200)
  assert.equal(mislabelled.headers['content-type'], 'image/jpeg')
  assert.deepEqual(mislabelled.body, JPEG)
  const words = await get(sentPath(refs.get('IMG_0003.png')!), { token: reader })
  assert.equal(words.status, 404)
  assert.equal(errorOf(words).code, 'unknown_image')
})

test('another chat’s picture is not served under this chat, though it is under its own', async () => {
  const ref = refs.get('IMG_0004.png')!
  const borrowed = await get(sentPath(ref), { token: reader })
  assert.equal(borrowed.status, 404)
  assert.equal(errorOf(borrowed).code, 'unknown_image')
  const own = await get(sentPath(ref, {}, { workspaceId, agentId: otherAgentId }), { token: reader })
  assert.equal(own.status, 200)
  assert.deepEqual(own.body, PNG)
})

test('a ref the store did not choose never reaches the disk', async () => {
  const folder = ConversationAttachmentStore.folderFor({ workspaceRoot, workspaceId, agentId })
  for (const ref of [
    '../../../etc/hosts',
    `${folder}/../${folder}/x.png`,
    `${folder}/not-a-uuid.png`,
    `${folder}`,
    join(workspaceRoot, 'photo.png'),
  ]) {
    const answer = await get(sentPath(ref), { token: reader })
    assert.equal(answer.status, 404, ref)
    assert.equal(errorOf(answer).code, 'unknown_image', ref)
  }
})

test('a chat this machine does not have is an unknown conversation', async () => {
  const answer = await get(sentPath(refs.get('IMG_0001.png')!, {}, { workspaceId: 'elsewhere', agentId }), {
    token: reader,
  })
  assert.equal(answer.status, 404)
  assert.equal(errorOf(answer).code, 'unknown_conversation')
})

test('a picture is named by a step or by a sent picture, never both', async () => {
  const answer = await get(sentPath(refs.get('IMG_0001.png')!, { toolUseId: 'step' }), { token: reader })
  assert.equal(answer.status, 400)
  assert.equal(errorOf(answer).code, 'invalid_arguments')
})

test('a device without a conversation grant is told which scope it lacks', async () => {
  const answer = await get(sentPath(refs.get('IMG_0001.png')!), { token: noConversations })
  assert.equal(answer.status, 403)
  assert.equal(errorOf(answer).code, 'tailnet_scope_required')
})
