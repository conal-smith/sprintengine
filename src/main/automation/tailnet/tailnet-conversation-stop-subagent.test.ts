import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's Stop on one agent (`conversation-stop-subagent`): the
// agent stops as its own Stop here stops it, and the chat goes on.

async function fixture(options: { stopSubagent?: boolean; start?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-stop-subagent-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ stopSubagent: options.stopSubagent ?? true })
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

test('a listed chat says whether one of its agents can be stopped by itself', async () => {
  const can = await fixture({ stopSubagent: true })
  const cannot = await fixture({ stopSubagent: false })
  try {
    assert.equal((await can.host.list())[0]!.capabilities?.stopSubagent, true)
    assert.equal((await cannot.host.list())[0]!.capabilities?.stopSubagent, false)
  } finally {
    await can.cleanup()
    await cannot.cleanup()
  }
})

test("a device's Stop on one agent reaches the chat's runtime as that agent's own Stop", async () => {
  const f = await fixture()
  try {
    const stop = vi.spyOn(f.runtime, 'stopSubagent').mockResolvedValue({ ok: true, session: f.session! })
    const interrupt = vi.spyOn(f.runtime, 'interrupt')
    const stopped = await f.host.command(f.key, 'phone', 'stop-1', { kind: 'stopSubagent', toolUseId: 'toolu_agent' })
    assert.equal(stopped.ok, true)
    assert.deepEqual(stop.mock.calls, [[{ sessionId: f.session!.sessionId, toolUseId: 'toolu_agent' }]])
    assert.equal(interrupt.mock.calls.length, 0, 'the chat and its turn are left alone')
  } finally {
    await f.cleanup()
  }
})

test('an agent that is not running is refused in words', async () => {
  const f = await fixture()
  try {
    const stopped = await f.host.command(f.key, 'phone', 'stop-1', { kind: 'stopSubagent', toolUseId: 'toolu_gone' })
    assert.equal(stopped.ok, false)
    assert.match(stopped.message ?? '', /not running any more|cannot stop one agent/)
  } finally {
    await f.cleanup()
  }
})

test('a chat at rest is not resumed to stop an agent: there is none running', async () => {
  const f = await fixture({ start: false })
  try {
    const start = vi.spyOn(f.runtime, 'startSession')
    const stopped = await f.host.command(f.key, 'phone', 'stop-1', { kind: 'stopSubagent', toolUseId: 'toolu_agent' })
    assert.equal(stopped.ok, false)
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
