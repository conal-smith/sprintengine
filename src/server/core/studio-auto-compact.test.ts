import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { AUTO_COMPACT_ORIGIN, createStudioAutoCompact } from './studio-auto-compact'

// The core's wiring: a chat's events make it look again, its record says
// whether the chat compacts, and the send is Studio's own `/compact` through
// a host whose sends carry the auto-compact origin.

const NOW = Date.UTC(2026, 9, 21, 9, 0, 0)

const summary: ConversationSessionSummary = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  providerId: 'claude-agent',
  modelId: 'default',
  status: 'ready',
  phase: 'completed',
  createdAt: NOW,
  updatedAt: NOW,
  promptCache: { ttl: '5m', expiresAt: NOW + 30_000, recacheTokens: 221_000 },
}

function wired(record: { autoCompactEnabled?: boolean | null; settledAt?: number | null } | null) {
  const listeners: Array<(event: ConversationEvent) => void> = []
  const timers: Array<() => void> = []
  const commands: Array<{ origin: unknown; clientId: string; command: unknown }> = []
  let origin: unknown
  const compact = createStudioAutoCompact({
    conversations: {
      listSessions: () => ({ ok: true, sessions: [summary] }),
      onEvent: (listener) => {
        listeners.push(listener)
        return () => undefined
      },
    },
    workspaceRecord: () => (record ? { ...record, agents: { 'agent-1': {} } } : null),
    enabledByDefault: () => false,
    createHost: (options) => {
      origin = options.origin
      return {
        resolveKey: (workspaceId, agentId) => ({ workspaceRoot: '/Users/dev/app', workspaceId, agentId }),
        command: async (_key, clientId, _commandId, command) => {
          commands.push({ origin, clientId, command })
          return { ok: true } as never
        },
      }
    },
    now: () => NOW,
    setTimer: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimer: () => undefined,
  })
  const run = async () => {
    for (const callback of timers.splice(0)) callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const say = (type: ConversationEvent['type']) => {
    for (const listener of listeners)
      listener({ ...summary, id: 'e', type, createdAt: NOW } as unknown as ConversationEvent)
  }
  return { compact, commands, run, say }
}

test('a chat’s turn ending makes the core look again, and it sends Studio’s own /compact', async () => {
  const chat = wired({ autoCompactEnabled: true })
  chat.say('turn_completed')
  await chat.run() // the debounced look
  await chat.run() // the compaction, due now
  assert.deepEqual(chat.commands, [
    {
      origin: AUTO_COMPACT_ORIGIN,
      clientId: 'studio-auto-compact',
      command: { kind: 'send', message: '/compact' },
    },
  ])
})

test('streamed text does not make it look', async () => {
  const chat = wired({ autoCompactEnabled: true })
  chat.say('content_delta')
  await chat.run()
  assert.equal(chat.compact.armed(), 0)
})

test('a chat switched off, settled, or not in the registry is not compacted', async () => {
  for (const record of [
    { autoCompactEnabled: false },
    { autoCompactEnabled: null },
    { autoCompactEnabled: true, settledAt: NOW },
    null,
  ]) {
    const chat = wired(record)
    chat.compact.recompute()
    await chat.run()
    assert.deepEqual(chat.commands, [], JSON.stringify(record))
  }
})
