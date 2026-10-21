import { expect, test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../src/protocol.js'
import { projectConversation } from '../src/conversationProjection.js'
import { deriveConversationTimelineRows } from '../src/conversationTimeline.js'
import { applyEvent, createConversationProjectionState } from '../src/incrementalConversationProjection.js'

// A handoff, and Studio's own compaction before a cache expired, as the
// projection and the timeline draw them.

function event(type: ConversationEventType, at: number, payload: Record<string, unknown> = {}): ConversationEvent {
  return {
    id: `event-${at}`,
    seq: at,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'claude-sonnet-4-5',
    type,
    createdAt: at,
    payload,
  }
}

const FILE = '/Users/dev/.sprintengine/workspaces/app/conversations/workspace/handoffs/agent-20261021-0942.md'

const handedOff: ConversationEvent[] = [
  event('user_message', 1, { turnId: 't1', text: 'Fix the test' }),
  event('turn_started', 2, { turnId: 't1' }),
  event('usage_updated', 3, {
    turnId: 't1',
    contextWindow: 1_000_000,
    contextUsed: 221_000,
    promptCache: { ttl: '5m', cached: true, recacheTokens: 221_000 },
  }),
  event('content_delta', 4, { turnId: 't1', text: 'Fixed.' }),
  event('turn_completed', 5, { turnId: 't1' }),
  event('context_handed_off', 6, { path: FILE, preTokens: 221_000, seedOwed: true, providerSessionId: null }),
  event('session_updated', 7, { historySeeded: true }),
  event('user_message', 8, { turnId: 't2', text: 'Where were we?' }),
  event('turn_started', 9, { turnId: 't2' }),
  event('content_delta', 10, { turnId: 't2', text: 'Reading the file.' }),
  event('turn_completed', 11, { turnId: 't2' }),
]

test('a handoff is a divider between the turns it came between, the history above it kept', () => {
  const projection = projectConversation(handedOff)
  expect(projection.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'handoff', 'user', 'assistant'])
  const handoff = projection.entries[2]
  expect(handoff).toEqual({ kind: 'handoff', id: 'event-6', path: FILE, preTokens: 221_000, createdAt: 6 })
  const rows = deriveConversationTimelineRows(projection.entries, false)
  expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'handoff', 'user', 'assistant'])
  // The pointer is never a message: the person's words are.
  expect(rows.filter((row) => row.kind === 'user').map((row) => row.kind === 'user' && row.entry.text)).toEqual([
    'Fix the test',
    'Where were we?',
  ])
})

test('a handoff resets the prompt cache and the context, as a compaction does', () => {
  const before = projectConversation(handedOff.slice(0, 5))
  expect(before.promptCache?.recacheTokens).toBe(221_000)
  expect(before.usage?.contextUsed).toBe(221_000)
  const after = projectConversation(handedOff.slice(0, 6))
  expect(after.promptCache).toEqual({ ttl: '5m', expiresAt: null, recacheTokens: null })
  expect(after.usage?.contextUsed).toBeUndefined()
  expect(after.usage?.contextWindow).toBe(1_000_000)
})

test('the incremental projection draws the same divider', () => {
  let state = createConversationProjectionState()
  for (const each of handedOff) state = applyEvent(state, each)
  expect(state.projection.entries.map((entry) => entry.kind)).toEqual(projectConversation(handedOff).entries.map((entry) => entry.kind))
})

test('a handoff taken back by Edit from here before it leaves the view with its turn', () => {
  const rewound = [
    ...handedOff,
    event('session_updated', 12, { rewoundFromSeq: 1, providerSessionId: null }),
  ]
  expect(projectConversation(rewound).entries).toEqual([])
})

test('Studio’s own compaction before the cache expired draws its divider and no message', () => {
  const events = [
    event('user_message', 1, { turnId: 't1', text: 'Fix the test' }),
    event('turn_started', 2, { turnId: 't1' }),
    event('turn_completed', 3, { turnId: 't1' }),
    event('user_message', 4, {
      turnId: 't2',
      text: '/compact',
      origin: { kind: 'studio', reason: 'auto-compact' },
    }),
    event('turn_started', 5, { turnId: 't2' }),
    event('context_compacted', 6, { turnId: 't2', trigger: 'manual', preTokens: 221_000, postTokens: 30_000 }),
    event('turn_completed', 7, { turnId: 't2' }),
  ]
  const entries = projectConversation(events).entries
  const compaction = entries.find((entry) => entry.kind === 'compaction')
  expect(compaction).toMatchObject({ beforeCacheExpiry: true, preTokens: 221_000, postTokens: 30_000 })
  const rows = deriveConversationTimelineRows(entries, false)
  expect(rows.filter((row) => row.kind === 'user')).toHaveLength(1)
  expect(rows.some((row) => row.kind === 'compaction')).toBe(true)
})
