import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's Handoff (`conversation-handoff`): the chat is handed off
// as its own Handoff here hands it off, and the file stays on this machine.

async function fixture(options: { handoff?: boolean; start?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-handoff-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ handoff: options.handoff ?? true })
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
  if (options.start !== false) {
    const started = await runtime.startSession({
      ...key,
      providerId: adapter.id,
      modelId: adapter.listModels()[0]!,
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
  }
  return {
    key,
    host,
    runtime,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a listed chat says whether it can be handed off', async () => {
  const can = await fixture({ handoff: true })
  const cannot = await fixture({ handoff: false })
  try {
    assert.equal((await can.host.list())[0]!.capabilities?.handoff, true)
    assert.equal((await cannot.host.list())[0]!.capabilities?.handoff, false)
  } finally {
    await can.cleanup()
    await cannot.cleanup()
  }
})

test("a device's Handoff reaches the runtime as this machine's own, and the file's path stays here", async () => {
  const f = await fixture()
  try {
    const handoff = vi
      .spyOn(f.runtime, 'handoffConversation')
      .mockResolvedValue({ ok: true, path: join(f.key.workspaceRoot, 'handoff.md') })
    const handed = await f.host.command(f.key, 'phone', 'handoff-1', { kind: 'handoff' })
    assert.deepEqual(handed, { ok: true })
    assert.deepEqual(handoff.mock.calls, [[{ key: f.key }]])
  } finally {
    await f.cleanup()
  }
})

test('the same command sent again after a dropped connection is the same handoff', async () => {
  const f = await fixture()
  try {
    const handoff = vi.spyOn(f.runtime, 'handoffConversation').mockResolvedValue({ ok: true, path: '/x.md' })
    assert.equal((await f.host.command(f.key, 'phone', 'handoff-1', { kind: 'handoff' })).ok, true)
    assert.equal((await f.host.command(f.key, 'phone', 'handoff-1', { kind: 'handoff' })).ok, true)
    assert.equal(handoff.mock.calls.length, 1)
    // A new press is a new handoff, which the runtime answers for itself.
    await f.host.command(f.key, 'phone', 'handoff-2', { kind: 'handoff' })
    assert.equal(handoff.mock.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a refusal is said in words and not kept: once the turn ends the same press may go', async () => {
  const f = await fixture()
  try {
    const handoff = vi
      .spyOn(f.runtime, 'handoffConversation')
      .mockResolvedValueOnce({ ok: false, message: 'Wait for the turn to finish.' })
      .mockResolvedValueOnce({ ok: true, path: '/x.md' })
    const refused = await f.host.command(f.key, 'phone', 'handoff-1', { kind: 'handoff' })
    assert.equal(refused.ok, false)
    assert.equal(refused.message, 'Wait for the turn to finish.')
    assert.equal((await f.host.command(f.key, 'phone', 'handoff-1', { kind: 'handoff' })).ok, true)
    assert.equal(handoff.mock.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a chat at rest is handed off from its transcript, not resumed first', async () => {
  const f = await fixture({ start: false })
  try {
    const start = vi.spyOn(f.runtime, 'startSession')
    vi.spyOn(f.runtime, 'handoffConversation').mockResolvedValue({ ok: true, path: '/x.md' })
    assert.equal((await f.host.command(f.key, 'phone', 'handoff-1', { kind: 'handoff' })).ok, true)
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
