import assert from 'node:assert/strict'
import { workspaceStoreRoot } from './workspace-store'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// A send turned away busy runs nothing, so nothing about it is written: a
// phone tries again every second while a turn runs, and each try used to be
// a receipts intent written and then removed.

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function receiptFiles(root: string): Promise<string[]> {
  const entries = await readdir(workspaceStoreRoot(root), { recursive: true }).catch(() => [] as string[])
  return entries.filter((entry) => entry.endsWith('.receipts.json'))
}

test('a send refused as busy writes no receipt, and the same id runs once the turn is over', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-busy-receipts-'))
  roots.add(workspaceRoot)
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  runtimes.add(runtime)
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  assert.ok(started.ok)
  const sessionId = started.session.sessionId

  // The mock's turn stops on an approval, which holds the chat.
  let requestId: string | undefined
  runtime.onEvent((event) => {
    if (event.type === 'approval_requested') requestId = String(event.payload?.requestId)
  })
  const first = await runtime.sendTurn({ sessionId, message: 'first' })
  assert.equal(first.ok, true)
  assert.ok(requestId, 'the turn waits on an approval')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const refused = await runtime.sendTurn({ sessionId, message: 'from the phone', commandId: 'phone-1' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'busy')
  }
  assert.deepEqual(await receiptFiles(workspaceRoot), [], 'nothing was recorded for a send that ran nothing')

  // A send made as a steer is not turned away up front: the steer path answers
  // it, and its refusal ran nothing either, so it is busy and kept nowhere.
  const steered = await runtime.sendTurn({ sessionId, message: 'steer', commandId: 'phone-steer', steer: true })
  assert.equal(steered.ok, false)
  assert.match(steered.ok ? '' : steered.message, /cannot take a message while it is working/)
  assert.equal(steered.ok ? undefined : steered.code, 'busy')

  assert.ok((await runtime.respondToRequest({ sessionId, requestId, approved: true })).ok)
  const sent = await runtime.sendTurn({ sessionId, message: 'from the phone', commandId: 'phone-1' })
  assert.equal(sent.ok, true, 'the same id runs once the chat is free')
  assert.equal((await receiptFiles(workspaceRoot)).length > 0, true)

  // The refused steer's id was never answered from a receipt: sent again once
  // the chat is free, it runs, as the next turn.
  assert.ok((await runtime.respondToRequest({ sessionId, requestId, approved: true })).ok)
  const resteered = await runtime.sendTurn({ sessionId, message: 'steer', commandId: 'phone-steer', steer: true })
  assert.equal(resteered.ok, true, resteered.ok ? '' : resteered.message)
})
