import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type { MockAdapterTurnInput } from './providers/conversation-provider-adapter'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// A chat launched in a mode stays in it, whoever sends the turn: main's sends
// name no mode, and a window's name `default`.

async function fixture(held: 'plan' | 'ask' | undefined, capabilities = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-held-mode-'))
  const adapter = createMockConversationProvider(capabilities)
  const modes: Array<MockAdapterTurnInput['mode']> = []
  const sendTurn = adapter.sendTurn.bind(adapter)
  adapter.sendTurn = (input) => {
    modes.push(input.mode)
    return sendTurn(input)
  }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    heldChatMode: () => held,
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  return {
    modes,
    send: (mode?: 'default' | 'plan' | 'ask') =>
      runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello', ...(mode ? { mode } : {}) }),
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a send naming no mode runs in the chat's held mode", async () => {
  const f = await fixture('ask')
  try {
    assert.equal((await f.send()).ok, true)
    assert.deepEqual(f.modes, ['ask'])
  } finally {
    await f.cleanup()
  }
})

test("a window's default send cannot take a held chat out of its mode", async () => {
  const f = await fixture('plan')
  try {
    assert.equal((await f.send('default')).ok, true)
    assert.deepEqual(f.modes, ['plan'])
  } finally {
    await f.cleanup()
  }
})

test('a chat held to nothing runs the mode the send names', async () => {
  const f = await fixture(undefined)
  try {
    await f.send('ask')
    assert.deepEqual(f.modes, ['ask'])
  } finally {
    await f.cleanup()
  }
})

test('a read-only mode is refused where the provider has no way to run it, never run writable', async () => {
  const f = await fixture(undefined, { planMode: false })
  try {
    const asked = await f.send('ask')
    assert.equal(asked.ok, false)
    assert.match(!asked.ok ? asked.message : '', /does not support ask mode/)
    assert.deepEqual(f.modes, [])
  } finally {
    await f.cleanup()
  }
})
