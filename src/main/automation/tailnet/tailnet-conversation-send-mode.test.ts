import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationHeldMessages } from './tailnet-conversation-host'

// A paired device's send that says the mode its turn runs in
// (`conversation-send-mode`): the turn runs in it, as one this machine's own
// chat sends, and a message in a mode of its own is never held for later,
// where it would go in the default one.

async function fixture(options: { steer?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-send-mode-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ steer: options.steer ?? true })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const holds: string[] = []
  const heldMessages: ConversationHeldMessages = {
    hold: (_chat, text) => {
      holds.push(text)
      return { ok: true }
    },
    cancel: () => ({ ok: false, message: 'Nothing is held.' }),
    list: () => [],
    onChanged: () => () => undefined,
  }
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { heldMessages },
  )
  const started = await runtime.startSession({
    ...key,
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  return {
    key,
    host,
    runtime,
    holds,
    session: started.session,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a send that says its mode reaches the runtime in that mode, and one that does not in the default', async () => {
  const f = await fixture()
  try {
    const send = vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({ ok: true, session: f.session })
    assert.equal(
      (await f.host.command(f.key, 'phone', 'ask-1', { kind: 'send', message: 'Why?', mode: 'ask' })).ok,
      true,
    )
    assert.equal(send.mock.calls[0]![0].mode, 'ask')
    await f.host.command(f.key, 'phone', 'send-2', { kind: 'send', message: 'Fix it' })
    assert.equal(send.mock.calls[1]![0].mode, undefined)
  } finally {
    await f.cleanup()
  }
})

test('a listed chat says whether its provider plans', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.host.list())[0]!.capabilities?.planMode, true)
  } finally {
    await f.cleanup()
  }
})

test('a steer in a mode of its own that the turn cannot take is refused busy, not held for the default mode', async () => {
  const f = await fixture({ steer: false })
  try {
    vi.spyOn(f.runtime, 'listSessions').mockReturnValue({
      ok: true,
      sessions: [{ ...f.session, status: 'active' }],
    })
    const answer = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Only look, change nothing',
      steer: true,
      mode: 'ask',
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'busy')
    assert.deepEqual(f.holds, [])
  } finally {
    await f.cleanup()
  }
})
