import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// One agent a chat spawned is stopped through its provider, by its lane, and
// only where the provider says it can: the chat's turn, or its rest between
// turns, is left as it was.

async function fixture(options: { capability: boolean; running?: Set<string> }) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'stop-subagent-'))
  const asked: Array<[string, string]> = []
  const running = options.running ?? new Set(['toolu_agent'])
  const mock = createMockConversationProvider(options.capability ? { stopSubagent: true } : {})
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        async stopSubagent(sessionId, toolUseId) {
          asked.push([sessionId, toolUseId])
          return running.delete(toolUseId)
        },
      },
    ],
    getProviderById: () => undefined,
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  assert.ok(started.ok)
  return {
    runtime,
    sessionId: started.session.sessionId,
    asked,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a running agent is stopped through the provider, between turns too, and the chat stays as it was', async () => {
  const f = await fixture({ capability: true })
  try {
    const result = await f.runtime.stopSubagent({ sessionId: f.sessionId, toolUseId: 'toolu_agent' })
    assert.equal(result.ok, true)
    assert.deepEqual(f.asked, [[f.sessionId, 'toolu_agent']])
    assert.equal(result.ok && result.session?.status, 'ready')
  } finally {
    await f.cleanup()
  }
})

test('an agent that is not running any more is said so', async () => {
  const f = await fixture({ capability: true, running: new Set() })
  try {
    assert.deepEqual(await f.runtime.stopSubagent({ sessionId: f.sessionId, toolUseId: 'toolu_gone' }), {
      ok: false,
      message: 'That agent is not running any more.',
    })
  } finally {
    await f.cleanup()
  }
})

test('a provider that does not say it can stop one agent is not asked to', async () => {
  const f = await fixture({ capability: false })
  try {
    const result = await f.runtime.stopSubagent({ sessionId: f.sessionId, toolUseId: 'toolu_agent' })
    assert.equal(result.ok, false)
    assert.deepEqual(f.asked, [])
  } finally {
    await f.cleanup()
  }
})

test('a stop for a chat that is not there is refused', async () => {
  const f = await fixture({ capability: true })
  try {
    assert.equal((await f.runtime.stopSubagent({ sessionId: 'nope', toolUseId: 'toolu_agent' })).ok, false)
    assert.deepEqual(f.asked, [])
  } finally {
    await f.cleanup()
  }
})
