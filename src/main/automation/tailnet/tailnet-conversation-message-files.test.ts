import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import { ConversationAttachmentStore } from '../../conversation-attachment-store'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetFileUploads, MAX_TAILNET_FILE_BYTES, TAILNET_UPLOADS_DIRNAME } from './tailnet-file-uploads'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import {
  TAILNET_CAPABILITIES,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_UPLOAD_PATH,
} from './tailnet-routes'

// Files of any type a paired device sends with a message: a real gateway on
// loopback, the real conversation host and a runtime with the mock provider.
// The upload is written into Studio's own store, never the project's folder,
// and the send that spends it attaches it to the message by that path.

const workspaceId = 'workspace'
const agentId = 'agent'
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n')

let workspaceRoot: string
let dataDir: string
let devicesDir: string
let uploadsRoot: string
let runtime: ConversationRuntime
let host: ConversationGatewayHost
let devices: TailnetDeviceStore
let server: TailnetGatewayServer
let port: number
let sessionId: string
let operator: { token: string; deviceId: string }
let reader: { token: string; deviceId: string }

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'message-files-workspace-'))
  dataDir = mkdtempSync(join(tmpdir(), 'message-files-data-'))
  devicesDir = mkdtempSync(join(tmpdir(), 'message-files-devices-'))
  uploadsRoot = join(dataDir, TAILNET_UPLOADS_DIRNAME)
  const provider = createMockConversationProvider()
  runtime = new ConversationRuntime({
    adapters: [provider],
    getProviderById: () => undefined,
    attachmentStore: new ConversationAttachmentStore(dataDir),
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.id,
    modelId: provider.listModels()[0],
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  sessionId = started.session.sessionId
  host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
  )
  devices = createTailnetDeviceStore({ resolveUserDataDir: () => devicesDir })
  server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    conversations: host,
    fileUploads: createTailnetFileUploads({ root: uploadsRoot }),
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  port = server.address()!.port
  operator = await pair(['conversation:read', 'conversation:operate'])
  reader = await pair(['conversation:read'])
})

afterAll(async () => {
  await server?.stop()
  await runtime?.shutdown()
  for (const dir of [workspaceRoot, dataDir, devicesDir]) if (dir) rmSync(dir, { recursive: true, force: true })
})

type Answer = { status: number; body: Buffer }

function call(
  path: string,
  options: { token?: string; method?: string; json?: unknown; raw?: Buffer; contentType?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.json === undefined ? options.raw : Buffer.from(JSON.stringify(options.json))
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        agent: false,
        headers: {
          ...(options.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function pair(scopes: TailnetScope[]): Promise<{ token: string; deviceId: string }> {
  const offer = devices.offerPairing({ scopes })
  const answer = await call(TAILNET_PAIR_PATH, {
    method: 'POST',
    json: { pairingToken: offer.token, deviceName: 'android-phone' },
  })
  assert.equal(answer.status, 200)
  const token = (JSON.parse(answer.body.toString('utf8')) as { deviceToken: string }).deviceToken
  const identity = await call(TAILNET_IDENTITY_PATH, { token })
  return { token, deviceId: (JSON.parse(identity.body.toString('utf8')) as { deviceId: string }).deviceId }
}

function uploadPath(name: string, kind = 'file'): string {
  return `${TAILNET_UPLOAD_PATH}?${new URLSearchParams({ kind, sessionId, name }).toString()}`
}

function key() {
  const found = host.resolveKey(workspaceId, agentId)
  assert.ok(found)
  return found
}

function json<T>(answer: Answer): T {
  return JSON.parse(answer.body.toString('utf8')) as T
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

async function upload(
  name: string,
  bytes: Buffer,
  contentType = 'application/pdf',
): Promise<{ uploadId: string; bytes: number; name: string }> {
  const answer = await call(uploadPath(name), { token: operator.token, method: 'POST', raw: bytes, contentType })
  assert.equal(answer.status, 200, answer.body.toString('utf8'))
  return json(answer)
}

async function sentFiles(commandId: string): Promise<unknown> {
  await runtime.flushTranscripts()
  const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId, agentId })
  assert.ok(transcript.ok)
  const sent = transcript.events.find(
    (event) => event.type === 'user_message' && event.payload?.commandId === commandId,
  )
  return sent?.payload?.files
}

test('the desktop says a message can carry files', async () => {
  assert.ok((TAILNET_CAPABILITIES as readonly string[]).includes('conversation-message-files'))
  const health = json<{ capabilities: string[] }>(await call(TAILNET_HEALTH_PATH))
  assert.ok(health.capabilities.includes('conversation-message-files'))
})

test('a file of any type is kept in Studio’s own store under its own name, never in the project', async () => {
  const answer = await upload('report.pdf', PDF)
  assert.equal(answer.bytes, PDF.length)
  assert.equal(answer.name, 'report.pdf')
  const kept = filesUnder(uploadsRoot).filter((path) => path.endsWith(`${sep}report.pdf`))
  assert.equal(kept.length, 1)
  assert.deepEqual(readFileSync(kept[0]!), PDF)
  assert.deepEqual(filesUnder(workspaceRoot), [])
})

test('the send that spends a file’s id attaches it to the message by its path, and the file stays', async () => {
  const { uploadId } = await upload('notes.txt', Buffer.from('three things to fix'), 'text/plain')
  const sent = await host.command(key(), operator.deviceId, 'send-file', {
    kind: 'send',
    message: 'read this',
    uploadIds: [uploadId],
  })
  assert.ok(sent.ok, sent.ok ? '' : String(sent.message))
  const files = (await sentFiles('send-file')) as Array<{ path: string }>
  assert.equal(files.length, 1)
  assert.ok(files[0]!.path.startsWith(uploadsRoot + sep), files[0]!.path)
  assert.ok(files[0]!.path.endsWith(`${sep}notes.txt`))
  // The agent reads it by that path, now or in a later turn.
  assert.equal(readFileSync(files[0]!.path, 'utf8'), 'three things to fix')
  const again = await host.command(key(), operator.deviceId, 'send-again', {
    kind: 'send',
    message: 'and again',
    uploadIds: [uploadId],
  })
  assert.equal(again.ok, false, 'a sent file’s id is spent')
  assert.match(String(!again.ok && again.message), /upload reference is unavailable/u)
})

test('a file sent beside a picture goes with it, each as what it is', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
  const picture = await call(uploadPath('IMG_0001.png', 'conversation'), {
    token: operator.token,
    method: 'POST',
    raw: png,
    contentType: 'image/png',
  })
  assert.equal(picture.status, 200)
  const file = await upload('data.csv', Buffer.from('a,b\n1,2\n'), 'text/csv')
  const sent = await host.command(key(), operator.deviceId, 'send-both', {
    kind: 'send',
    message: 'both',
    uploadIds: [json<{ uploadId: string }>(picture).uploadId, file.uploadId],
  })
  assert.ok(sent.ok, sent.ok ? '' : String(sent.message))
  await runtime.flushTranscripts()
  const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId, agentId })
  assert.ok(transcript.ok)
  const message = transcript.events.find(
    (event) => event.type === 'user_message' && event.payload?.commandId === 'send-both',
  )
  const files = message?.payload?.files as Array<{ path: string }>
  assert.deepEqual(
    files.map((entry) => entry.path.split(sep).pop()),
    ['data.csv'],
  )
  const pictures = message?.payload?.attachments as Array<{ name: string }>
  assert.deepEqual(
    pictures.map((entry) => entry.name),
    ['IMG_0001.png'],
  )
})

test('another device cannot spend a file’s id', async () => {
  const { uploadId } = await upload('secret.txt', Buffer.from('mine'), 'text/plain')
  const sent = await host.command(key(), reader.deviceId, 'send-stolen', {
    kind: 'send',
    message: 'take it',
    uploadIds: [uploadId],
  })
  assert.equal(sent.ok, false)
  assert.match(String(!sent.ok && sent.message), /File upload reference is unavailable/u)
})

test('a name is one safe segment, whatever it says', async () => {
  const answer = await upload('../../../etc/passwd', Buffer.from('not a password file'), 'text/plain')
  assert.equal(answer.name, 'passwd')
  const kept = filesUnder(uploadsRoot).filter((path) => path.endsWith(`${sep}passwd`))
  assert.equal(kept.length, 1)
  assert.ok(!relative(uploadsRoot, kept[0]!).startsWith('..'))
  const dotted = await upload('.env', Buffer.from('KEY=1'), 'text/plain')
  assert.equal(dotted.name, 'env')
})

test('a type that is not a media type is kept as bytes, and the upload still lands', async () => {
  const answer = await upload('blob.bin', Buffer.from([1, 2, 3]), 'not a type')
  assert.equal(answer.bytes, 3)
})

test('a file over 25 MB is refused with the limit named, and nothing is left behind', async () => {
  const before = filesUnder(uploadsRoot).length
  const answer = await call(uploadPath('huge.zip'), {
    token: operator.token,
    method: 'POST',
    raw: Buffer.alloc(MAX_TAILNET_FILE_BYTES + 1),
    contentType: 'application/zip',
  })
  assert.equal(answer.status, 413)
  assert.equal(json<{ error: { code: string; message: string } }>(answer).error.code, 'too_large')
  assert.match(json<{ error: { message: string } }>(answer).error.message, /25MB/u)
  assert.equal(filesUnder(uploadsRoot).length, before)
})

test('a picture upload still takes pictures only', async () => {
  const answer = await call(uploadPath('report.pdf', 'conversation'), {
    token: operator.token,
    method: 'POST',
    raw: PDF,
    contentType: 'application/pdf',
  })
  assert.equal(answer.status, 415)
  assert.equal(json<{ error: { code: string } }>(answer).error.code, 'invalid_media_type')
})

test('a device that may only read a chat cannot send it a file', async () => {
  const answer = await call(uploadPath('report.pdf'), {
    token: reader.token,
    method: 'POST',
    raw: PDF,
    contentType: 'application/pdf',
  })
  assert.equal(answer.status, 403)
  assert.equal(json<{ error: { code: string } }>(answer).error.code, 'tailnet_scope_required')
})

test('a device with no conversation grant is refused too', async () => {
  const outsider = await pair(TAILNET_SCOPES.filter((scope) => !scope.startsWith('conversation:')))
  const answer = await call(uploadPath('report.pdf'), {
    token: outsider.token,
    method: 'POST',
    raw: PDF,
    contentType: 'application/pdf',
  })
  assert.equal(answer.status, 403)
})

test('the files a removed device sent go with it', async () => {
  const leaving = await pair(['conversation:read', 'conversation:operate'])
  const answer = await call(uploadPath('leaving.txt'), {
    token: leaving.token,
    method: 'POST',
    raw: Buffer.from('bye'),
    contentType: 'text/plain',
  })
  assert.equal(answer.status, 200)
  const kept = filesUnder(uploadsRoot).find((path) => path.endsWith(`${sep}leaving.txt`))
  assert.ok(kept)
  assert.ok(devices.revokeDevice(leaving.deviceId))
  assert.equal(existsSync(kept), false)
  assert.equal(existsSync(dirname(dirname(kept))), false)
  // Another device's files are not touched.
  assert.ok(filesUnder(uploadsRoot).some((path) => path.endsWith(`${sep}report.pdf`)))
})
