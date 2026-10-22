import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationContextBreakdownResult, ConversationEvent } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// What fills a chat's context window is the provider's to say, asked through
// the runtime only where the provider declares it can; and a reading moves
// nothing: no event, no clock, nothing the idle sweep reads as activity.

const READING: ConversationContextBreakdownResult = {
  ok: true,
  breakdown: {
    model: 'mock-model',
    usedTokens: 10,
    windowTokens: 100,
    categories: [
      { name: 'Messages', tokens: 10, kind: 'used' },
      { name: 'Free space', tokens: 90, kind: 'free' },
    ],
    mcpServers: [],
    skills: [],
    memoryFiles: [],
    agents: [],
    autoCompactAt: null,
    estimated: true,
    measuredAt: 5,
  },
}

async function fixture(options: { capability?: boolean; read?: () => Promise<ConversationContextBreakdownResult> }) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'context-breakdown-'))
  let clock = 1_000_000
  const asked: string[] = []
  const mock = createMockConversationProvider(options.capability === false ? {} : { contextBreakdown: true })
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sessions: 'stateful',
        readContextBreakdown: (sessionId) => {
          asked.push(sessionId)
          return options.read ? options.read() : Promise.resolve(READING)
        },
      },
    ],
    getProviderById: () => undefined,
    now: () => clock,
  })
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
  assert.ok(started.ok)
  const published: ConversationEvent[] = []
  runtime.onEvent((event) => published.push(event))
  return {
    runtime,
    sessionId: started.session.sessionId,
    asked,
    published,
    tick: (ms: number) => (clock += ms),
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a reading goes to the provider and back, and moves nothing', async () => {
  const f = await fixture({})
  try {
    const before = f.runtime.listSessions()
    assert.ok(before.ok)
    f.tick(60_000)
    assert.deepEqual(await f.runtime.readContextBreakdown({ sessionId: f.sessionId }), READING)
    assert.deepEqual(f.asked, [f.sessionId])
    assert.deepEqual(f.published, [], 'no event is written or published for a reading')
    const after = f.runtime.listSessions()
    assert.ok(after.ok)
    assert.equal(after.sessions[0]!.updatedAt, before.sessions[0]!.updatedAt, 'the chat’s clock does not move')
  } finally {
    await f.cleanup()
  }
})

test('a provider that does not declare it is not asked', async () => {
  const f = await fixture({ capability: false })
  try {
    const result = await f.runtime.readContextBreakdown({ sessionId: f.sessionId })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'unsupported')
    assert.deepEqual(f.asked, [])
  } finally {
    await f.cleanup()
  }
})

test('an unknown session, and a provider that throws, answer in words', async () => {
  const f = await fixture({
    read: async () => {
      throw new Error('child went away')
    },
  })
  try {
    const unknown = await f.runtime.readContextBreakdown({ sessionId: 'nope' })
    assert.equal(!unknown.ok && unknown.reason, 'failed')
    const thrown = await f.runtime.readContextBreakdown({ sessionId: f.sessionId })
    assert.deepEqual(thrown, { ok: false, reason: 'failed', message: 'child went away' })
  } finally {
    await f.cleanup()
  }
})
