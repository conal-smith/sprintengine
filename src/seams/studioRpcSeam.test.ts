import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, test } from 'vitest'

import {
  StudioError,
  type ConversationFollowFrame,
  type ConversationEventStream,
} from '../../packages/agent-sdk/src/index'
import { connectToStudio } from '../../packages/agent-sdk/src/node'
import type { StudioClient } from '../../packages/agent-sdk/src/client'
import {
  STUDIO_CHAT_METHODS,
  STUDIO_METHODS,
  type StudioChatMethod,
  type StudioMethod,
} from '../../packages/studio-protocol/src/public'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../shared/workspace-registry'
import type { Workspace } from '../renderer/src/types/workspace'
import { createStaticAppIdentity } from '../server/platform/app-identity'
import { createLocalClientBus } from '../server/platform/client-bus'
import { STUDIO_LOCAL_APPS_CHANGED_CHANNEL, type StudioLocalAppsStatus } from '../shared/studio-local-apps'
import { createGatewayAuditStore } from '../main/automation/gateway-audit'
import { createConversationGatewayHost } from '../main/automation/tailnet/tailnet-conversation-host'
import { createConversationLaunchService } from '../main/conversation-launch-service'
import { ConversationRuntime } from '../main/conversation-runtime'
import { createStudioConversationBackend } from '../main/studio-rpc/studio-conversation-backend'
import { createStudioRpcService, type StudioRpcService } from '../main/studio-rpc/studio-rpc-service'
import { createWorkspaceRegistryService } from '../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../main/workspace-sync-service'

// ── Seam: a local app, the SDK, the Studio RPC and a real chat ──────────────
//
// Each side is tested on its own: the protocol's validators, the RPC against a
// fake backend, the SDK against that same RPC. What none of them shows is that
// the client the SDK ships and the server the app ships agree end to end. This
// suite wires the app's own pieces — the conversation runtime with a stand-in
// provider as the only fake, the launch service, the workspace bus, the
// conversation host the tailnet lane wraps, the local app store and the
// gateway's audit — and drives them with the SDK over a real socket:
//
//   SDK connectToStudio ─ owner socket ─ connection ─ router ─ backend
//     ─ conversation host / launch service ─ ConversationRuntime ─ events back

let root: string
let userData: string
let service: StudioRpcService
let runtime: ConversationRuntime
const bus = createLocalClientBus()
const published: Array<{ topic: string; payload: unknown }> = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-rpc-seam-'))
  userData = join(root, 'user-data')
  const folder = join(root, 'project')
  await mkdir(folder, { recursive: true })
  await mkdir(userData, { recursive: true })
  const workspace: Workspace = {
    id: 'ws-a',
    name: 'ws-a',
    mode: 'standard',
    folderPath: folder,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: [toWorkspaceRegistryRecord(workspace, 1)],
    }),
    now: () => 1000,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => 1000 })
  const event = (
    base: { sessionId: string; workspaceId: string; agentId: string; providerId: string; modelId: string },
    type: ConversationEventType,
    payload: Record<string, unknown> = {},
  ): ConversationEvent => ({ id: '', ...base, type, createdAt: 0, payload })
  runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    adapters: [
      {
        id: 'claude-agent',
        displayName: 'Claude Code',
        sessions: 'stateful',
        listModels: () => ['default', 'sonnet'],
        startSession: (input) => [event(input, 'session_started'), event(input, 'session_ready')],
        async *sendTurn(input) {
          yield event(input, 'turn_started', { turnId: input.turnId })
          yield event(input, 'content_delta', { turnId: input.turnId, text: `re: ${input.message}` })
          yield event(input, 'turn_completed', { turnId: input.turnId })
        },
        resolveApproval: () => [],
        setPermissionPreset: async () => ({ ok: true }),
        interrupt: () => [],
        stopSession: (input) => [event(input, 'session_closed')],
      },
    ],
  })
  // As app-services wires them.
  const launch = createConversationLaunchService({
    getWorkspace: (id) => registry.getRecord(id),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => sync.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => registry.getRecords(),
    createWorkspace: (request) => {
      const created = sync.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => sync.removeWorkspace(workspaceId, 'system'),
    startSession: (input) => runtime.startSession(input),
    send: (input) => runtime.sendTurn(input),
  })
  const audit = createGatewayAuditStore({ resolveUserDataDir: () => userData })
  bus.subscribe((topic, payload) => published.push({ topic, payload }))
  service = createStudioRpcService({
    // The platform's pieces, as a standalone server would install them.
    paths: { dataDir: () => userData },
    identity: createStaticAppIdentity({ version: '0.0.0-seam' }),
    clients: bus,
    backend: () =>
      createStudioConversationBackend({
        host: createConversationGatewayHost(
          runtime,
          (workspaceId) => registry.getRecord(workspaceId)?.folderPath ?? null,
          () =>
            registry
              .getRecords()
              .filter((record) => Boolean(record.folderPath))
              .map((record) => ({ workspaceId: record.id, workspaceRoot: record.folderPath! })),
          (key) => registry.getRecord(key.workspaceId)?.agents[key.agentId]?.cliPermissionPreset ?? 'auto',
        ),
        launch: (request) => launch.launch(request),
        listSessions: (input) => runtime.listSessions(input),
        stopSession: (input) => runtime.stopSession(input),
        getWorkspaceAgents: () => sync.getSnapshot().state.workspaces,
      }),
    audit: () => audit,
  })
  await service.start()
  assert.equal(service.getStatus().lastError, null)
  assert.equal(service.getStatus().running, true)
})

afterAll(async () => {
  await service.stop()
  await runtime.shutdown()
  await rm(root, { recursive: true, force: true })
})

async function pairedClient(scopes: string[], ceiling: string): Promise<StudioClient> {
  const { code } = service.offer({ name: 'seam-app', scopes, ceiling })
  return connectToStudio({
    name: 'seam-app',
    pairingCode: code,
    tokenFile: join(root, `token-${Math.random().toString(36).slice(2)}`),
    dataDir: userData,
  })
}

async function until(stream: ConversationEventStream, done: (frame: ConversationFollowFrame) => boolean) {
  const seen: ConversationFollowFrame[] = []
  for (;;) {
    const step = await stream.next()
    if (step.done) return seen
    seen.push(step.value)
    if (done(step.value)) return seen
  }
}
const texts = (frames: ConversationFollowFrame[]) =>
  frames.flatMap((frame) =>
    frame.type === 'event' && frame.event.type === 'content_delta' ? [String(frame.event.payload?.text)] : [],
  )

test('a paired app starts a chat, follows it and drives it, held to its ceiling', async () => {
  const client = await pairedClient(['conversation:read', 'conversation:operate', 'conversation:create'], 'auto')
  try {
    assert.equal(client.supports('conversation-create'), true)
    const chat = await client.createConversation({
      workspaceId: 'ws-a',
      cli: 'claude-code',
      prompt: 'hello',
      permissionPreset: 'bypass',
      commandId: 'make-chat',
    })
    // Asked for bypass, given the ceiling.
    assert.equal(chat.info.permissionPreset, 'auto')
    const stream = chat.events()
    const opening = await until(stream, (frame) => frame.type === 'event' && frame.event.type === 'turn_completed')
    const snapshot = opening.find((frame) => frame.type === 'snapshot')
    const snapshotTexts =
      snapshot?.type === 'snapshot'
        ? snapshot.page.events.flatMap((event) => (event.type === 'content_delta' ? [String(event.payload?.text)] : []))
        : []
    assert.deepEqual([...snapshotTexts, ...texts(opening)].join(''), 're: hello')
    assert.ok(stream.cursor)

    await chat.send('again')
    const second = await until(stream, (frame) => frame.type === 'event' && frame.event.type === 'turn_completed')
    assert.deepEqual(texts(second), ['re: again'])

    // A retried create finds the chat the first one made; another create
    // under the same id is another command, and is refused.
    const request = {
      workspaceId: 'ws-a',
      cli: 'claude-code',
      prompt: 'hello',
      permissionPreset: 'bypass' as const,
      commandId: 'make-chat',
    }
    const retried = await client.conversations.create(request)
    assert.equal(retried.ok && retried.conversation.agentId, chat.ref.agentId)
    const other = await client.conversations.create({ ...request, prompt: 'something else' })
    assert.equal(!other.ok && other.code, 'command_id_conflict')

    // The listing the app reads is the conversation lane's own thread shape.
    const listed = (await client.conversations.list()).find((thread) => thread.agentId === chat.ref.agentId)
    assert.equal(listed?.permissionPreset, 'auto')

    // No catalog on this machine for the chat's CLI: refused in the lane's own word.
    await assert.rejects(chat.setModel('sonnet'), (error: StudioError) => error.code === 'unsupported_model')
    const lowered = await chat.setPermissions({ preset: 'manual' })
    assert.equal(lowered.permissionPreset, 'manual')
    stream.close()

    // The audit names the app by the identity its token proved, and never a message.
    const auditText = await readFile(join(userData, 'sprintengine-studio-mcp-audit.jsonl'), 'utf8')
    const lines = auditText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; connection: { kind: string; clientName?: string } })
    assert.ok(lines.some((line) => line.tool === 'conversation.create' && line.connection.kind === 'studio-client'))
    assert.ok(lines.some((line) => line.tool === 'conversation.send' && line.connection.clientName === 'seam-app'))
    assert.equal(auditText.includes('again'), false)
  } finally {
    client.close()
  }
})

test('a stop resent after the chat started again does not stop it again', async () => {
  const client = await pairedClient(['conversation:read', 'conversation:operate', 'conversation:create'], 'auto')
  try {
    const chat = await client.createConversation({ workspaceId: 'ws-a', cli: 'claude-code' })
    const live = () => {
      const listed = runtime.listSessions({ workspaceId: 'ws-a', agentId: chat.ref.agentId })
      return listed.ok ? listed.sessions.filter((session) => session.status !== 'stopped') : []
    }
    await chat.stop({ commandId: 'halt' })
    assert.equal(live().length, 0)
    // The chat is sent to again, which starts its session again.
    await chat.send('back again')
    assert.equal(live().length, 1)
    // The same stop, as a client resends it after a reconnect.
    await chat.stop({ commandId: 'halt' })
    assert.equal(live().length, 1)
  } finally {
    client.close()
  }
})

test('revoking the app in Settings ends its stream and its client', async () => {
  const client = await pairedClient(['conversation:read', 'conversation:create'], 'manual')
  const chat = await client.createConversation({ workspaceId: 'ws-a', cli: 'claude-code' })
  const stream = chat.events()
  await until(stream, (frame) => frame.type === 'synchronized')
  const app = service.getStatus().apps.find((entry) => entry.id === client.grant.clientId)
  assert.equal(app?.connected, true)
  published.length = 0
  service.revoke(client.grant.clientId)
  await assert.rejects(stream.next(), (error: StudioError) => error.code === 'revoked')
  // Settings hears it on the platform's client bus, with the app gone.
  const pushed = published.filter((entry) => entry.topic === STUDIO_LOCAL_APPS_CHANGED_CHANNEL).at(-1)
  assert.equal(
    (pushed?.payload as StudioLocalAppsStatus | undefined)?.apps.some((entry) => entry.id === client.grant.clientId),
    false,
  )
  // Parked, not retrying: another try would only be refused again.
  for (let tries = 0; client.state !== 'parked' && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.state, 'parked')
  await assert.rejects(client.request('server.info', {}), (error: StudioError) => error.code === 'revoked')
})

test('every method the server serves has its call in the SDK, under the same scope', async () => {
  // The SDK's ref-level service, call by call, to the method each one sends.
  const sdkCalls: Record<StudioMethod, string> = {
    'server.info': 'request',
    'server.ping': 'request',
    'conversation.list': 'conversations.list',
    'conversation.create': 'conversations.create',
    'conversation.send': 'conversations.send',
    'conversation.interrupt': 'conversations.interrupt',
    'conversation.resolveApproval': 'conversations.respondToApproval',
    'conversation.answerQuestion': 'conversations.answerQuestion',
    'conversation.resolvePlan': 'conversations.resolvePlan',
    'conversation.setPermissionPreset': 'conversations.setPermissionPreset',
    'conversation.setModel': 'conversations.setModel',
    'conversation.stop': 'conversations.stop',
    // Taking back a held message is Studio's own windows', called by name.
    'conversation.cancelQueued': 'request',
    // So is stopping one agent of a chat, an owner's for now: no SDK call names it yet.
    'conversation.stopSubagent': 'request',
    // And a chat's effort, its MCP servers and its agent's restart, owners' for
    // now, as a chat followed from another desktop uses them.
    'conversation.setReasoningEffort': 'request',
    'conversation.mcpServerAction': 'request',
    'conversation.restartSession': 'request',
    'conversation.loadEarlier': 'conversations.loadEarlier',
    'conversation.toolDetail': 'conversations.toolDetail',
    'conversation.turnDiff': 'conversations.turnDiff',
    // The chat surface is Studio's own windows' and is called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_CHAT_METHODS).map((method) => [method, 'request'])) as Record<
      StudioChatMethod,
      string
    >),
    // Client tools: a withdrawal is the offered toolset's own `withdraw`, and
    // opening a chat to an app is Studio's own windows' and called by name.
    'tools.offer': 'tools.offer',
    'tools.withdraw': 'tools.offer',
    'tools.focus': 'tools.focus',
    'tools.catalog': 'tools.catalog',
    'tools.grant': 'request',
    'tools.grants': 'request',
    // Files by root are Studio's own clients' (the canvas over a server's boards), called by name.
    'files.roots': 'request',
    'files.list': 'request',
    'files.read': 'request',
    'files.write': 'request',
    'files.remove': 'request',
    // A Studio's pull requests are its own clients' marks, called by name.
    'pullRequests.list': 'request',
    'pullRequests.refresh': 'request',
    'pullRequests.noteWork': 'request',
    'pullRequests.noteToolCall': 'request',
    'pullRequests.link': 'request',
    'pullRequests.unwatch': 'request',
    // So are its local servers.
    'localServers.list': 'request',
    'localServers.run': 'request',
    'localServers.stop': 'request',
    'localServers.remove': 'request',
  }
  assert.deepEqual(Object.keys(sdkCalls).sort(), Object.keys(STUDIO_METHODS).sort())
  const client = await pairedClient(['conversation:read'], 'manual')
  try {
    for (const call of Object.values(sdkCalls)) {
      const [owner, name] = call.includes('.') ? call.split('.') : [null, call]
      const target = (owner ? (client as never)[owner] : client) as Record<string, unknown>
      assert.equal(typeof target[name!], 'function', call)
    }
    // A read-only app is refused every mutation by the server, in the shape the SDK reads.
    const ref = { workspaceId: 'ws-a', agentId: 'nobody' }
    const service = client.conversations
    const refusals: Record<string, () => Promise<{ ok: boolean; code?: string }>> = {
      'conversation.send': () => service.send(ref, { message: 'x' }),
      'conversation.interrupt': () => service.interrupt(ref),
      'conversation.resolveApproval': () => service.respondToApproval(ref, { requestId: 'r', decision: 'deny' }),
      'conversation.answerQuestion': () => service.answerQuestion(ref, { requestId: 'r', answers: {} }),
      'conversation.resolvePlan': () => service.resolvePlan(ref, { requestId: 'r', decision: 'reject' }),
      'conversation.setPermissionPreset': () => service.setPermissionPreset(ref, 'auto'),
      'conversation.setModel': () => service.setModel(ref, 'm'),
      'conversation.stop': () => service.stop(ref),
      'conversation.create': () => service.create({ workspaceId: 'ws-a' }),
    }
    const mutations = Object.entries(STUDIO_METHODS).filter(([, spec]) => spec.mutation && !spec.owner)
    assert.deepEqual(mutations.map(([method]) => method).sort(), Object.keys(refusals).sort())
    for (const [method] of mutations) {
      const answer = await refusals[method]()
      assert.deepEqual([method, answer.ok, answer.code], [method, false, 'scope_required'])
    }
    // The chat surface is refused to any app that is not Studio's own, whatever it was granted.
    for (const method of Object.keys(STUDIO_CHAT_METHODS) as StudioChatMethod[]) {
      const refused = await client.request(method, {} as never).then(
        () => null,
        (error: { code?: string }) => error.code,
      )
      assert.deepEqual([method, refused], [method, 'owner_required'])
    }
    const info = await client.request('server.info', {})
    assert.equal(info.grant.clientId, client.grant.clientId)
  } finally {
    client.close()
  }
})
