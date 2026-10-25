import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's server rows on a live chat (`conversation-mcp-server-actions`):
// a reconnect or a switch reaches the chat's runtime as this machine's own
// rows reach it, and a sign-in, whose callback this machine's CLI waits for,
// is never offered.

async function fixture(options: { start?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-mcp-server-actions-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ mcpServerActions: ['reconnect', 'enable', 'disable', 'sign-in'] })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {},
  )
  const started =
    options.start === false
      ? null
      : await runtime.startSession({
          ...key,
          providerId: adapter.id,
          modelId: adapter.listModels()[0]!,
          permissionPreset: 'bypass',
        })
  if (started) assert.ok(started.ok)
  return {
    key,
    host,
    runtime,
    session: started?.ok ? started.session : null,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a listed chat names what may be done to its servers from a device, a sign-in left out', async () => {
  const f = await fixture()
  try {
    assert.deepEqual((await f.host.list())[0]!.capabilities?.mcpServerActions, ['reconnect', 'enable', 'disable'])
  } finally {
    await f.cleanup()
  }
})

test("a device's reconnect reaches the chat's runtime as its own server row's does", async () => {
  const f = await fixture()
  try {
    const action = vi.spyOn(f.runtime, 'mcpServerAction').mockResolvedValue({ ok: true })
    const done = await f.host.command(f.key, 'phone', 'mcp-1', {
      kind: 'mcpServerAction',
      serverId: 'github',
      action: 'reconnect',
    })
    assert.deepEqual(done, { ok: true })
    assert.deepEqual(action.mock.calls, [
      [{ sessionId: f.session!.sessionId, serverId: 'github', action: 'reconnect' }],
    ])
    action.mockResolvedValue({ ok: false, message: 'This chat cannot do that to its MCP servers.' })
    const refused = await f.host.command(f.key, 'phone', 'mcp-2', {
      kind: 'mcpServerAction',
      serverId: 'github',
      action: 'disable',
    })
    assert.deepEqual(refused, { ok: false, message: 'This chat cannot do that to its MCP servers.' })
  } finally {
    await f.cleanup()
  }
})

test('a chat at rest is not resumed to reach its servers, and says why', async () => {
  const f = await fixture({ start: false })
  try {
    vi.spyOn(f.runtime, 'listThreads').mockResolvedValue({
      ok: true,
      threads: [{ agentId: 'agent', providerId: 'mock-provider', model: 'mock-model' } as never],
    })
    const start = vi.spyOn(f.runtime, 'startSession')
    const done = await f.host.command(f.key, 'phone', 'mcp-1', {
      kind: 'mcpServerAction',
      serverId: 'github',
      action: 'reconnect',
    })
    assert.equal(done.ok, false)
    assert.match(done.message ?? '', /no agent running/)
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
