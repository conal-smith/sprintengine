import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { CONVERSATION_STALE_SEND_MS } from '../../packages/conversation-protocol/src/public'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import { workspaceStoreRoot } from './workspace-store'

// A paired device's message says when it was written (`composedAt`). One
// written longer ago than the lane's limit, and not confirmed by the person
// since, is refused `stale` with nothing recorded: a phone that slept with a
// message queued must not start a turn with it the next day without asking.

const HOUR = 3_600_000
const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function chat() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-stale-sends-'))
  roots.add(workspaceRoot)
  const clock = { now: Date.UTC(2026, 9, 20, 12, 15) }
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    now: () => clock.now,
    // A turn that completes on its own, with no approval to answer.
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
  })
  runtimes.add(runtime)
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
  assert.ok(started.ok)
  const messages = async () => {
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    return transcript.events.filter((event) => event.type === 'user_message')
  }
  const receipts = async () =>
    (await readdir(workspaceStoreRoot(workspaceRoot), { recursive: true }).catch(() => [] as string[])).filter(
      (entry) => entry.endsWith('.receipts.json'),
    )
  return { runtime, sessionId: started.session.sessionId, clock, messages, receipts }
}

test('a send written past the limit is refused stale, and nothing is recorded for it', async () => {
  const c = await chat()
  const refused = await c.runtime.sendTurn({
    sessionId: c.sessionId,
    commandId: 'phone-1',
    message: 'Run the migration',
    composedAt: c.clock.now - 23 * HOUR,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.ok ? undefined : refused.code, 'stale')
  assert.deepEqual(await c.messages(), [], 'no message in the chat')
  assert.deepEqual(await c.receipts(), [], 'no receipt kept for the id')
})

test('the person’s confirmation sends it under the same id, recorded with when it was written', async () => {
  const c = await chat()
  const composedAt = c.clock.now - 23 * HOUR
  const send = { sessionId: c.sessionId, commandId: 'phone-1', message: 'Run the migration', composedAt }
  assert.equal((await c.runtime.sendTurn(send)).ok, false)
  const confirmed = await c.runtime.sendTurn({ ...send, confirmedStale: true })
  assert.equal(confirmed.ok, true, confirmed.ok ? '' : confirmed.message)
  const [message] = await c.messages()
  assert.equal(message?.payload?.text, 'Run the migration')
  assert.equal(message?.payload?.commandId, 'phone-1')
  assert.equal(message?.payload?.composedAt, composedAt)
  // Asked again without the confirmation, it is answered from its receipt:
  // the message went, however old it is.
  const repeated = await c.runtime.sendTurn(send)
  assert.equal(repeated.ok, true)
  assert.equal((await c.messages()).length, 1)
})

test('a send inside the limit goes, and one that does not say when it was written goes as it always did', async () => {
  const c = await chat()
  const fresh = await c.runtime.sendTurn({
    sessionId: c.sessionId,
    commandId: 'phone-1',
    message: 'Fresh',
    composedAt: c.clock.now - CONVERSATION_STALE_SEND_MS + 1,
  })
  assert.equal(fresh.ok, true, fresh.ok ? '' : fresh.message)
  // An older phone names no time at all.
  const unsaid = await c.runtime.sendTurn({
    sessionId: c.sessionId,
    commandId: 'phone-2',
    message: 'From an older phone',
  })
  assert.equal(unsaid.ok, true, unsaid.ok ? '' : unsaid.message)
  const messages = await c.messages()
  assert.deepEqual(
    messages.map((event) => event.payload?.text),
    ['Fresh', 'From an older phone'],
  )
  assert.equal(messages[1]?.payload?.composedAt, undefined)
})
