import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// A worktree chat whose pool slot was given back while it sat idle has its
// branch checked out again before any agent runs in its folder, whoever sent
// the turn (worktree-pool/chat-folder-guard.ts): the runtime asks before a
// session starts and before every turn of a resting one.
test('a session start and each turn ask for the chat’s folder first, and a refusal stops them with its reason', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const asked: Array<{ workspaceId: string; workspaceRoot: string }> = []
  let refusal: string | null = null
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    // A turn that ends at once, so the session is resting before the next.
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
    prepareChatFolder: async (input) => {
      asked.push(input)
      return refusal ? { ok: false, message: refusal } : { ok: true }
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.deepEqual(asked, [{ workspaceId: 'workspace', workspaceRoot }], 'asked before the session started')

    const rested = new Promise<void>((resolve) => runtime.onSessionIdle(() => resolve()))
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })).ok, true)
    assert.equal(asked.length, 2, 'asked again before the turn')
    await rested

    refusal = 'This chat’s worktree could not be brought back: the branch is checked out elsewhere.'
    const refused = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'again' })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok ? null : refused.message, refusal)
    const notStarted = await runtime.startSession({
      ...key,
      agentId: 'other',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.equal(notStarted.ok, false)
    assert.equal(notStarted.ok ? null : notStarted.message, refusal)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
