import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { test, vi } from 'vitest'
import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'

import type { MeshConversationFrame, MeshConversationKey } from '../../shared/tailnet-mesh'
import { ConversationRuntime } from '../conversation-runtime'
import { searchFiles } from '../filesystem-search'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet/tailnet-conversation-host'
import { createTailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetFileUploads, TAILNET_UPLOADS_DIRNAME } from './tailnet/tailnet-file-uploads'
import { createTailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet/tailnet-mesh-service'
import { createTailnetMeshStore } from './tailnet/tailnet-mesh-store'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet/tailnet-routes'
import { pairingUrl } from './tailnet/tailnet-service'

// A chat on a paired machine, composed from this desktop as one here is: its
// @ searches the chat's folder over there and the send names what was picked,
// a file attached here goes up with the message, and the `/` menu lists what
// the chat's CLI runs there. Both halves are real, over loopback: the gateway
// and its conversation host with a runtime on one side, the mesh service on
// the other.

const workspaceId = 'workspace'
const agentId = 'agent'

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate(), what)
}

async function startHarness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'remote-composer-host-'))
  const remoteDir = mkdtempSync(join(tmpdir(), 'remote-composer-devices-'))
  const remoteData = mkdtempSync(join(tmpdir(), 'remote-composer-data-'))
  const localDir = mkdtempSync(join(tmpdir(), 'remote-composer-local-'))
  mkdirSync(join(workspaceRoot, 'docs'))
  writeFileSync(join(workspaceRoot, 'docs', 'release-notes.md'), 'Ship on Friday.\n')
  // A Claude chat, so its CLI has a `/` list; the turns are the mock's.
  const provider = { ...createMockConversationProvider(), id: 'claude-agent' }
  const runtime = new ConversationRuntime({ adapters: [provider], getProviderById: () => undefined })
  const commandAsks: Array<{ cli: string; cwd: string; refresh?: boolean }> = []
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    undefined,
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
        commandAsks.push({ cli: input.cli, cwd: input.cwd, ...(input.refresh ? { refresh: true } : {}) })
        return {
          cli: input.cli,
          cwd: input.cwd,
          fetchedAt: 1_700_000_000_000,
          commands: [
            { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', source: 'cli' },
            { name: 'acme:deploy', source: 'custom' },
          ],
        }
      },
    },
  )
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => remoteDir })
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    conversations: host,
    fileUploads: createTailnetFileUploads({ root: join(remoteData, TAILNET_UPLOADS_DIRNAME) }),
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  const port = server.address()!.port
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => localDir,
    createStore: (options) => createTailnetMeshStore({ ...options, cipher: createSecretCipherStandIn() }),
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
    conversations: { retry: { baseMs: 20, maxMs: 200 }, saveDelayMs: 5, requestTimeoutMs: 5_000 },
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.id,
    modelId: provider.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const offer = devices.offerPairing({ scopes: ['conversation:read', 'conversation:operate'] })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  const key: MeshConversationKey = { connectionId: paired.connection.id, workspaceId, agentId }
  return {
    runtime,
    mesh,
    key,
    workspaceRoot,
    localDir,
    uploadsRoot: join(remoteData, TAILNET_UPLOADS_DIRNAME),
    commandAsks,
    async follow() {
      const frames: MeshConversationFrame[] = []
      const following = mesh.followConversation({
        followId: 'pane-1',
        key,
        turnLimit: 10,
        emit: (frame) => frames.push(frame),
      })
      assert.deepEqual(await following, { ok: true })
      await waitFor(
        () => frames.some((frame) => frame.type === 'link' && frame.state === 'live'),
        'the follow goes live',
      )
    },
    async close() {
      mesh.shutdown()
      await server.stop().catch(() => undefined)
      await runtime.shutdown()
      for (const dir of [workspaceRoot, remoteDir, remoteData, localDir]) rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('the list says the machine searches, takes mentions and files, and lists commands', async () => {
  const h = await startHarness()
  try {
    const listed = await h.mesh.listConversations(h.key.connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.mentions, true)
    assert.equal(listed.commands, true)
    assert.equal(listed.messageFiles, true)
  } finally {
    await h.close()
  }
})

test("an @ searches the chat's folder over there, and the send names what was picked", async () => {
  const h = await startHarness()
  try {
    await h.mesh.listConversations(h.key.connectionId)
    const found = await h.mesh.conversationSearchFiles({ key: h.key, query: 'release' })
    assert.ok(found.ok, found.ok ? '' : found.message)
    assert.ok(found.entries.some((entry) => entry.path === 'docs/release-notes.md' && entry.kind === 'file'))
    assert.deepEqual(await h.mesh.conversationSearchFiles({ key: h.key, query: '   ' }), {
      ok: true,
      entries: [],
      truncated: false,
    })

    await h.follow()
    const turns = vi.spyOn(h.runtime, 'sendTurn')
    const sent = await h.mesh.conversationSend({
      key: h.key,
      message: 'Summarise these',
      mentions: [{ path: 'docs/release-notes.md', kind: 'file' }],
    })
    assert.deepEqual(sent, { ok: true })
    assert.deepEqual(turns.mock.calls.at(-1)![0].mentions, [{ path: 'docs/release-notes.md', kind: 'file' }])

    // Never a path of this machine's: refused here, before anything is sent.
    const before = turns.mock.calls.length
    const absolute = await h.mesh.conversationSend({
      key: h.key,
      message: 'And this',
      mentions: [{ path: join(h.localDir, 'secret.txt'), kind: 'file' }],
    })
    assert.equal(absolute.ok ? '' : absolute.code, 'invalid_arguments')
    assert.equal(turns.mock.calls.length, before)
  } finally {
    await h.close()
  }
})

test('a file attached here goes up with the message, and the agent is handed its path there', async () => {
  const h = await startHarness()
  try {
    await h.mesh.listConversations(h.key.connectionId)
    await h.follow()
    const local = join(h.localDir, 'brief.pdf')
    const bytes = Buffer.from('%PDF-1.7\n% the brief\n')
    writeFileSync(local, bytes)
    const turns = vi.spyOn(h.runtime, 'sendTurn')
    const sent = await h.mesh.conversationSend({ key: h.key, message: 'Read the brief', files: [{ path: local }] })
    assert.deepEqual(sent, { ok: true })
    const files = turns.mock.calls.at(-1)![0].files ?? []
    assert.equal(files.length, 1)
    const there = files[0]!.path
    assert.notEqual(there, local, 'the path is the copy over there, never this machine’s')
    assert.ok(!relative(h.uploadsRoot, there).startsWith(`..${sep}`), 'kept in that machine’s own store')
    assert.ok(readFileSync(there).equals(bytes), 'the same bytes')

    // A file that is gone is refused in words, before a turn starts.
    const before = turns.mock.calls.length
    const gone = await h.mesh.conversationSend({
      key: h.key,
      message: 'And this',
      files: [{ path: join(h.localDir, 'missing.pdf') }],
    })
    assert.equal(gone.ok, false)
    assert.match(gone.ok ? '' : gone.message, /no longer there/u)
    // A queued message carries words alone.
    const queued = await h.mesh.conversationSend({
      key: h.key,
      message: 'Later',
      files: [{ path: local }],
      queue: true,
    })
    assert.equal(queued.ok ? '' : queued.code, 'invalid_arguments')
    assert.equal(turns.mock.calls.length, before)
  } finally {
    await h.close()
  }
})

test("the `/` menu lists what the chat's CLI runs in its folder over there", async () => {
  const h = await startHarness()
  try {
    await h.mesh.listConversations(h.key.connectionId)
    const listed = await h.mesh.conversationCommandList({ key: h.key })
    assert.deepEqual(listed, {
      ok: true,
      cli: 'claude-code',
      fetchedAt: 1_700_000_000_000,
      commands: [
        { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', source: 'cli' },
        { name: 'acme:deploy', source: 'custom' },
      ],
    })
    await h.mesh.conversationCommandList({ key: h.key, refresh: true })
    assert.deepEqual(h.commandAsks, [
      { cli: 'claude-code', cwd: h.workspaceRoot },
      { cli: 'claude-code', cwd: h.workspaceRoot, refresh: true },
    ])
  } finally {
    await h.close()
  }
})

/** A machine that answers pairing and identity with the capabilities given, and counts every other request. */
async function olderMachine(capabilities: string[]) {
  let asked = 0
  const device = {
    deviceId: 'device-1',
    deviceName: 'mac-mini',
    scopes: ['conversation:read', 'conversation:operate'],
    transportVersion: 2,
    capabilities,
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    request.resume()
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      asked++
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-composer-older-'))
  const mesh: TailnetMeshService = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  await mesh.checkReachability(paired.connection.id)
  return {
    mesh,
    dir,
    key: { connectionId: paired.connection.id, workspaceId: 'ws-1', agentId: 'agent-1' },
    asked: () => asked,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a machine that has not said it reaches a chat folder is refused in words, and never asked', async () => {
  const machine = await olderMachine(['conversations', 'upload', 'conversation-send-skills'])
  try {
    const before = machine.asked()
    const search = await machine.mesh.conversationSearchFiles({ key: machine.key, query: 'notes' })
    assert.equal(search.ok ? '' : search.code, 'mentions_unsupported')
    const commands = await machine.mesh.conversationCommandList({ key: machine.key })
    assert.equal(commands.ok ? '' : commands.code, 'commands_unsupported')
    const mentioned = await machine.mesh.conversationSend({
      key: machine.key,
      message: 'Read it',
      mentions: [{ path: 'notes.md', kind: 'file' }],
    })
    assert.equal(mentioned.ok ? '' : mentioned.code, 'mentions_unsupported')
    assert.match(mentioned.ok ? '' : mentioned.message, /Update SprintEngine Studio there/u)
    const local = join(machine.dir, 'brief.pdf')
    writeFileSync(local, 'brief')
    const attached = await machine.mesh.conversationSend({
      key: machine.key,
      message: 'Read it',
      files: [{ path: local }],
    })
    assert.equal(attached.ok ? '' : attached.code, 'files_unsupported')
    assert.equal(machine.asked(), before, 'nothing was asked over there')
  } finally {
    await machine.close()
  }
})
