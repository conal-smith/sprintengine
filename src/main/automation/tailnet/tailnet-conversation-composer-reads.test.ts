import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import type { TailnetScope } from '../../../shared/tailnet'
import { ConversationRuntime } from '../../conversation-runtime'
import { searchFiles } from '../../filesystem-search'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import {
  TAILNET_CONVERSATION_COMMANDS_PATH,
  TAILNET_CONVERSATION_FILES_PATH,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_PAIR_PATH,
} from './tailnet-routes'

// The composer's reads beside the socket, on a real gateway on loopback: a
// chat's folder searched for an @ (`conversation-files`) and its CLI's `/`
// list (`conversation-commands`), each under the scopes a read takes, and
// answering only paths inside the chat's folder.

const workspaceId = 'workspace'
const agentId = 'agent'

let workspaceRoot: string
let outsideRoot: string
let devicesDir: string
let runtime: ConversationRuntime
let devices: TailnetDeviceStore
let server: TailnetGatewayServer
let port: number
let operator: string
let reader: string
let stranger: string
const commandAsks: Array<{ cwd: string; refresh?: boolean }> = []

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'composer-reads-workspace-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'composer-reads-outside-'))
  devicesDir = mkdtempSync(join(tmpdir(), 'composer-reads-devices-'))
  mkdirSync(join(workspaceRoot, 'src'))
  writeFileSync(join(workspaceRoot, 'src', 'checkout.ts'), 'export {}\n')
  writeFileSync(join(outsideRoot, 'checkout-secret.ts'), 'secret\n')
  const provider = { ...createMockConversationProvider(), id: 'claude-agent' }
  runtime = new ConversationRuntime({ adapters: [provider], getProviderById: () => undefined })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.id,
    modelId: provider.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {
      searchFiles: (input) =>
        searchFiles(-1, {
          rootPath: input.rootPath,
          query: input.query,
          limit: input.limit,
          purpose: 'mention',
          channel: input.channel,
        }),
      commandsOf: async (input) => {
        commandAsks.push({ cwd: input.cwd, ...(input.refresh ? { refresh: true } : {}) })
        return {
          cli: input.cli,
          cwd: input.cwd,
          fetchedAt: 7,
          commands: [{ name: 'review', description: 'Review a pull request', source: 'cli' }],
        }
      },
    },
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
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  port = server.address()!.port
  operator = await pair(['conversation:read', 'conversation:operate'])
  reader = await pair(['conversation:read'])
  stranger = await pair(['workspace:read'])
})

afterAll(async () => {
  await server?.stop()
  await runtime?.shutdown()
  for (const dir of [workspaceRoot, outsideRoot, devicesDir]) if (dir) rmSync(dir, { recursive: true, force: true })
})

type Answer = { status: number; body: unknown }

function call(path: string, options: { token?: string; method?: string; json?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json))
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        agent: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null })
        })
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function pair(scopes: TailnetScope[]): Promise<string> {
  const offer = devices.offerPairing({ scopes })
  const answer = await call(TAILNET_PAIR_PATH, {
    method: 'POST',
    json: { pairingToken: offer.token, deviceName: 'laptop' },
  })
  assert.equal(answer.status, 200)
  const token = (answer.body as { deviceToken: string }).deviceToken
  assert.equal((await call(TAILNET_IDENTITY_PATH, { token })).status, 200)
  return token
}

const files = (query: string, chat = agentId) =>
  `${TAILNET_CONVERSATION_FILES_PATH}?${new URLSearchParams({ workspaceId, agentId: chat, query }).toString()}`
const commands = (refresh = false) =>
  `${TAILNET_CONVERSATION_COMMANDS_PATH}?${new URLSearchParams({ workspaceId, agentId, ...(refresh ? { refresh: '1' } : {}) }).toString()}`

test('the machine says it serves both reads and takes mentions', async () => {
  const health = await call(TAILNET_HEALTH_PATH)
  const capabilities = (health.body as { capabilities: string[] }).capabilities
  for (const capability of ['conversation-file-search', 'conversation-send-mentions', 'conversation-commands'])
    assert.ok(capabilities.includes(capability), capability)
})

test("a search answers the chat folder's matches by their paths in it", async () => {
  const answer = await call(files('checkout'), { token: reader })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  const entries = (answer.body as { entries: Array<{ path: string; kind: string }> }).entries
  assert.ok(entries.some((entry) => entry.path === 'src/checkout.ts' && entry.kind === 'file'))
  for (const entry of entries) {
    assert.ok(!entry.path.startsWith('/') && !entry.path.includes('..'), entry.path)
    assert.ok(!entry.path.includes('secret'), 'nothing outside the folder')
  }
})

test('an empty query matches nothing, and an overlong one is refused', async () => {
  const empty = await call(files(''), { token: reader })
  assert.deepEqual(empty, { status: 200, body: { entries: [], truncated: false } })
  const long = await call(files('x'.repeat(201)), { token: reader })
  assert.equal(long.status, 400)
})

test("the `/` list is the chat CLI's for its folder", async () => {
  const answer = await call(commands(), { token: reader })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, {
    cli: 'claude-code',
    fetchedAt: 7,
    commands: [{ name: 'review', description: 'Review a pull request', source: 'cli' }],
  })
  assert.deepEqual(commandAsks.at(-1), { cwd: workspaceRoot })
})

test('asking the CLI again is for a device that may operate the chat', async () => {
  const refused = await call(commands(true), { token: reader })
  assert.equal(refused.status, 403)
  const asked = await call(commands(true), { token: operator })
  assert.equal(asked.status, 200)
  assert.deepEqual(commandAsks.at(-1), { cwd: workspaceRoot, refresh: true })
})

test('neither read is answered without the conversation scope or a credential, or for a chat not here', async () => {
  assert.equal((await call(files('checkout'), { token: stranger })).status, 403)
  assert.equal((await call(commands(), { token: stranger })).status, 403)
  assert.equal((await call(files('checkout'))).status, 401)
  const unknown = await call(files('checkout', 'nobody'), { token: reader })
  assert.equal(unknown.status, 404)
  assert.equal((unknown.body as { error: { code: string } }).error.code, 'unknown_conversation')
})
