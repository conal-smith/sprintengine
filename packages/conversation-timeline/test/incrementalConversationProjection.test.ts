import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../src/protocol.js'
import { projectConversation } from '../src/conversationProjection.js'
import { deriveConversationTimelineRows } from '../src/conversationTimeline.js'
import {
  applyEvent,
  createConversationProjectionState,
  prependEvents,
  syncConversationProjection,
} from '../src/incrementalConversationProjection.js'

function event(type: ConversationEventType, index: number, payload: Record<string, unknown>): ConversationEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'provider',
    modelId: 'model',
    type,
    createdAt: index * 10,
    payload,
  }
}

test('initial snapshots and reconnect batches fold once while preserving settled entry identities', () => {
  const userTurns: [] = []
  const events: ConversationEvent[] = []
  for (let i = 0; i < 5000; i++) {
    events.push(event('user_message', i * 4, { turnId: `turn-${i}`, text: `Prompt ${i}` }))
    events.push(event('turn_started', i * 4 + 1, { turnId: `turn-${i}` }))
    events.push(event('content_delta', i * 4 + 2, { turnId: `turn-${i}`, text: 'Answer' }))
    events.push(event('turn_completed', i * 4 + 3, { turnId: `turn-${i}` }))
  }
  const snapshot = syncConversationProjection(createConversationProjectionState([], userTurns), events, userTurns)
  assert.equal(snapshot.projection.entries.length, 10_000)
  const nextEvents = [
    ...events,
    event('user_message', 20_001, { turnId: 'next', text: 'Follow up' }),
    event('turn_started', 20_002, { turnId: 'next' }),
    event('content_delta', 20_003, { turnId: 'next', text: 'New answer' }),
  ]
  const continued = syncConversationProjection(snapshot, nextEvents, userTurns)
  assert.equal(continued.projection.entries[0], snapshot.projection.entries[0])
  assert.equal(continued.projection.entries[9_999], snapshot.projection.entries[9_999])
  assert.deepEqual(continued.projection, projectConversation(nextEvents, userTurns))
  assert.equal(syncConversationProjection(continued, nextEvents, userTurns), continued)
})

test('incremental projection equals the reference fold after every event', () => {
  const events = [
    event('session_started', 0, {}),
    event('user_message', 1, { turnId: 'a', text: 'Go' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('reasoning_delta', 3, { turnId: 'a', text: 'think' }),
    event('reasoning_delta', 4, { turnId: 'a', text: ' more' }),
    event('content_delta', 5, { turnId: 'a', text: 'Hello' }),
    event('content_delta', 6, { turnId: 'a', text: ' world' }),
    event('tool_started', 7, {
      turnId: 'a',
      toolUseId: 'parent',
      name: 'Task',
      kind: 'subagent',
      summary: 'Explore',
      subagentLane: true,
    }),
    event('tool_started', 8, {
      turnId: 'a',
      toolUseId: 'child',
      name: 'Read',
      kind: 'file_read',
      parentToolUseId: 'parent',
      input: { path: 'src/a.ts' },
    }),
    event('tool_output', 9, { turnId: 'a', toolUseId: 'child', output: 'sour', partial: true, status: 'ok' }),
    event('tool_output', 19, {
      turnId: 'a',
      toolUseId: 'child',
      preview: 'source',
      output: 'source',
      totalBytes: 6,
      truncated: false,
      status: 'ok',
      exitCode: 0,
    }),
    event('approval_requested', 10, {
      turnId: 'a',
      requestId: 'request',
      summary: 'Run command',
      action: 'Bash',
      input: { command: 'rg text' },
      cwd: '/workspace',
      originAgentId: 'child-agent',
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    }),
    event('approval_resolved', 11, {
      turnId: 'a',
      requestId: 'request',
      approved: true,
      autoApproved: true,
      ruleLabel: 'Run rg in this workspace',
    }),
    event('usage_updated', 12, { inputTokens: 22, outputTokens: 14 }),
    event('turn_completed', 13, { turnId: 'a', costUsd: 0.02, durationMs: 100, numTurns: 1 }),
    event('user_message', 14, { turnId: 'b', text: 'Next' }),
    event('turn_started', 15, { turnId: 'b' }),
    event('content_delta', 16, { turnId: 'b', text: 'Answer' }),
    event('tool_output', 17, {
      turnId: 'b',
      toolUseId: 'parent',
      preview: 'done',
      output: 'done',
      totalBytes: 4,
      truncated: false,
      status: 'ok',
    }),
    event('turn_failed', 18, { turnId: 'b', reason: 'failed', message: 'Oops' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    const before = state.projection.entries
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), item.type)
    if (item.type === 'content_delta' && before.length === state.projection.entries.length) {
      for (let i = 0; i < before.length; i++) {
        const entry = before[i]
        if (entry?.kind !== 'assistant' || entry.turnId !== item.payload?.turnId) {
          assert.equal(state.projection.entries[i], before[i])
        }
      }
    }
  }

  const later = events.slice(12)
  const prepended = prependEvents(createConversationProjectionState(later), events.slice(0, 12))
  assert.deepEqual(prepended.projection, projectConversation(events))
})

test('partial command output updates the running row without settling it', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, { turnId: 'a', toolUseId: 'command', name: 'Bash' }),
    event('tool_output', 3, { turnId: 'a', toolUseId: 'command', output: 'first', partial: true, status: 'ok' }),
  ]
  const partial = projectConversation(events).entries.find((entry) => entry.kind === 'tool')
  assert.equal(partial?.status, 'running')
  assert.equal(partial?.output, 'first')
  let state = createConversationProjectionState(events.slice(0, 2))
  state = applyEvent(state, events[2])
  assert.deepEqual(state.projection, projectConversation(events))
  const final = event('tool_output', 4, { turnId: 'a', toolUseId: 'command', output: 'first\nlast', status: 'ok' })
  state = applyEvent(state, final)
  assert.deepEqual(state.projection, projectConversation([...events, final]))
  const completed = state.projection.entries.find((entry) => entry.kind === 'tool')
  assert.equal(completed?.status, 'done')
  assert.equal(completed?.output, 'first\nlast')
})

test('prose before each tool remains ordered separately from the final answer', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('content_delta', 2, { turnId: 'a', text: 'I will inspect the file.' }),
    event('tool_started', 3, { turnId: 'a', toolUseId: 'read', name: 'Read' }),
    event('tool_started', 4, { turnId: 'a', toolUseId: 'read', name: 'Read', input: { path: 'src/a.ts' } }),
    event('tool_started', 41, { turnId: 'a', toolUseId: 'nested', name: 'Read', parentToolUseId: 'read' }),
    event('content_delta', 5, { turnId: 'a', text: 'Now I will run a check.' }),
    event('tool_started', 6, { turnId: 'a', toolUseId: 'check', name: 'Bash' }),
    event('content_delta', 7, { turnId: 'a', text: 'Everything passed.' }),
  ]
  let state = createConversationProjectionState()
  for (const item of events) state = applyEvent(state, item)
  assert.deepEqual(state.projection, projectConversation(events))
  const assistant = state.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind, 'assistant')
  if (assistant?.kind !== 'assistant') throw new Error('Missing assistant entry')
  assert.equal(assistant?.text, 'Everything passed.')
  assert.deepEqual(assistant?.intermediateText, [
    { text: 'I will inspect the file.', beforeToolUseId: 'read' },
    { text: 'Now I will run a check.', beforeToolUseId: 'check' },
  ])
})

test('row derivation reuses objects whose entries did not change', () => {
  const events = [
    event('user_message', 1, { turnId: 'a', text: 'First' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('content_delta', 3, { turnId: 'a', text: 'One' }),
    event('turn_completed', 4, { turnId: 'a' }),
    event('user_message', 5, { turnId: 'b', text: 'Second' }),
    event('turn_started', 6, { turnId: 'b' }),
    event('content_delta', 7, { turnId: 'b', text: 'Two' }),
  ]
  let state = createConversationProjectionState(events)
  const before = deriveConversationTimelineRows(state.projection.entries, state.projection.activeTurn)
  state = applyEvent(state, event('content_delta', 8, { turnId: 'b', text: ' more' }))
  const after = deriveConversationTimelineRows(state.projection.entries, state.projection.activeTurn, before)
  for (let index = 0; index < before.length; index++) {
    if (before[index]?.id !== 'assistant:b') assert.equal(after[index], before[index])
  }
  assert.notEqual(
    after.find((row) => row.id === 'assistant:b'),
    before.find((row) => row.id === 'assistant:b'),
  )
})

test('checkpoint metadata and revert marks survive replay and undo', () => {
  const start = { ...event('user_message', 1, { turnId: 'a', text: 'First' }), seq: 10 }
  const second = { ...event('user_message', 4, { turnId: 'b', text: 'Second' }), seq: 20 }
  const events = [
    start,
    event('turn_started', 2, { turnId: 'a' }),
    event('turn_completed', 3, {
      turnId: 'a',
      checkpointTurnSeq: 10,
      checkpointAvailable: true,
      checkpointSummary: { files: 2, addedLines: 3, removedLines: 1 },
    }),
    second,
    event('turn_started', 5, { turnId: 'b' }),
    event('turn_completed', 6, {
      turnId: 'b',
      checkpointTurnSeq: 20,
      checkpointAvailable: true,
      checkpointSummary: { files: 1, addedLines: 1, removedLines: 0 },
    }),
    event('session_updated', 7, { revertedAfterSeq: 10, undo: false }),
  ]
  const projected = projectConversation(events)
  assert.equal(projected.revertedAfterSeq, 10)
  const firstUser = projected.entries.find((entry) => entry.kind === 'user' && entry.seq === 10)
  const firstAssistant = projected.entries.find((entry) => entry.kind === 'assistant' && entry.turnId === 'a')
  const secondUser = projected.entries.find((entry) => entry.kind === 'user' && entry.seq === 20)
  const secondAssistant = projected.entries.find((entry) => entry.kind === 'assistant' && entry.turnId === 'b')
  assert.equal(firstUser?.kind === 'user' && firstUser.reverted, true)
  assert.equal(firstAssistant?.kind === 'assistant' && firstAssistant.reverted, true)
  assert.equal(secondUser?.kind === 'user' && secondUser.reverted, true)
  assert.equal(secondAssistant?.kind === 'assistant' && secondAssistant.reverted, true)
  assert.deepEqual(firstAssistant?.kind === 'assistant' ? firstAssistant.checkpointSummary : undefined, {
    files: 2,
    addedLines: 3,
    removedLines: 1,
  })
  const restored = projectConversation([...events, event('session_updated', 8, { revertedAfterSeq: 10, undo: true })])
  assert.equal(
    restored.entries.some((entry) => (entry.kind === 'user' || entry.kind === 'assistant') && entry.reverted),
    false,
  )
})

test('a revert marks only the turns between its checkpoint and the revert itself', () => {
  const turn = (id: string, seq: number, at: number): ConversationEvent[] => [
    { ...event('user_message', at, { turnId: id, text: id }), seq },
    { ...event('turn_started', at + 1, { turnId: id }), seq: seq + 1 },
    {
      ...event('turn_completed', at + 2, {
        turnId: id,
        checkpointTurnSeq: seq,
        checkpointAvailable: true,
        checkpointSummary: { files: 1, addedLines: 1, removedLines: 0 },
      }),
      seq: seq + 2,
    },
  ]
  const revertOf = (afterSeq: number, seq: number, undo = false) => ({
    ...event('session_updated', seq, { revertedAfterSeq: afterSeq, undo }),
    seq,
  })
  const marks = (events: ConversationEvent[]) =>
    projectConversation(events).entries.flatMap((entry) => {
      if (entry.kind !== 'user' && entry.kind !== 'assistant') return []
      const name = entry.kind === 'user' ? entry.text : `reply-${entry.turnId}`
      return [`${name}:${entry.reverted ? `reverted/${entry.undoRevertSeq ?? 'kept'}` : 'live'}`]
    })
  const history = [...turn('a', 10, 1), ...turn('b', 20, 5), revertOf(20, 30), ...turn('c', 40, 10)]
  // The turn sent after the revert keeps its own revert action.
  assert.deepEqual(marks(history), [
    'a:live',
    'reply-a:live',
    'b:reverted/20',
    'reply-b:reverted/20',
    'c:live',
    'reply-c:live',
  ])
  let state = createConversationProjectionState()
  for (const item of history) state = applyEvent(state, item)
  assert.deepEqual(state.projection, projectConversation(history))

  // A second revert stacks: only the latest one offers an undo, and undoing
  // it leaves the first one in effect.
  const stacked = [...history, revertOf(40, 50), ...turn('d', 60, 20)]
  assert.deepEqual(marks(stacked), [
    'a:live',
    'reply-a:live',
    'b:reverted/kept',
    'reply-b:reverted/kept',
    'c:reverted/40',
    'reply-c:reverted/40',
    'd:live',
    'reply-d:live',
  ])
  const undone = [...stacked, revertOf(40, 70, true)]
  assert.equal(projectConversation(undone).revertedAfterSeq, 20)
  assert.deepEqual(marks(undone).slice(2, 6), ['b:reverted/20', 'reply-b:reverted/20', 'c:live', 'reply-c:live'])

  // Undoing a revert replaces whatever changed files after it. Right after the
  // revert nothing has; once a later turn ran, or a newer revert was undone and
  // the older one is offered again, its undo has to say it replaces that work.
  // The undo each revert still offers, and whether it replaces later work.
  const undoOffers = (events: ConversationEvent[]) => [
    ...new Set(
      projectConversation(events).entries.flatMap((entry) =>
        entry.kind === 'user' && entry.undoRevertSeq !== undefined
          ? [`${entry.undoRevertSeq}:${entry.undoOverwritesLaterWork ? 'replaces later work' : 'clean'}`]
          : [],
      ),
    ),
  ]
  const twoTurns = [...turn('a', 10, 1), ...turn('b', 20, 5)]
  assert.deepEqual(undoOffers([...twoTurns, revertOf(20, 30)]), ['20:clean'])
  assert.deepEqual(undoOffers(history), ['20:replaces later work'])
  assert.deepEqual(undoOffers([...twoTurns, revertOf(20, 30), revertOf(10, 31)]), ['10:clean'])
  assert.deepEqual(undoOffers([...twoTurns, revertOf(20, 30), revertOf(10, 31), revertOf(10, 32, true)]), [
    '20:replaces later work',
  ])
  assert.deepEqual(undoOffers(undone), ['20:replaces later work'])
})

test('a failed turn settles the tool calls it left running', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, { turnId: 'a', toolUseId: 'command', name: 'Bash' }),
    event('tool_started', 3, { turnId: 'a', toolUseId: 'read', name: 'Read' }),
    event('tool_output', 4, { turnId: 'a', toolUseId: 'read', output: 'text', status: 'ok' }),
    event('turn_failed', 5, { turnId: 'a', reason: 'failed', message: 'Provider exited' }),
  ]
  const tools = projectConversation(events).entries.filter((entry) => entry.kind === 'tool')
  assert.deepEqual(
    tools.map((tool) => tool.kind === 'tool' && [tool.id, tool.status, tool.outputStatus, tool.completedAt]),
    [
      ['command', 'done', 'stopped', 50],
      ['read', 'done', 'ok', 40],
    ],
  )
})

test('an empty content delta ends the reasoning window in the incremental fold too', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('reasoning_delta', 2, { turnId: 'a', text: 'think' }),
    event('content_delta', 3, { turnId: 'a', text: '' }),
    event('content_delta', 4, { turnId: 'a', text: 'Answer' }),
    event('content_delta', 5, { turnId: 'b', text: '' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix))
  }
  const assistant = state.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' && assistant.reasoningDurationMs, 10)
})

test('a retry notice is the working line until the turn says anything else, in both folds', () => {
  const working = (entries: ReturnType<typeof projectConversation>['entries']) =>
    deriveConversationTimelineRows(entries, true).find((row) => row.kind === 'working')
  const events = [
    event('user_message', 1, { turnId: 'a', text: 'Go' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('turn_retrying', 3, {
      turnId: 'a',
      attempt: 1,
      maxAttempts: 10,
      retryInMs: 500,
      error: 'authentication_failed',
      status: 401,
    }),
    event('turn_retrying', 4, { turnId: 'a', attempt: 2, maxAttempts: 10, retryInMs: 1000 }),
    event('content_delta', 5, { turnId: 'a', text: 'Hello' }),
    event('content_delta', 6, { turnId: 'a', text: ' world' }),
  ]
  const labels: (string | undefined)[] = []
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix))
    const row = working(state.projection.entries)
    labels.push(row?.kind === 'working' ? row.label : undefined)
  }
  assert.deepEqual(labels.slice(1), [
    'Thinking…',
    'Couldn’t authenticate · retrying (1 of 10)…',
    // A later notice replaces the earlier one; no response at all is a connection failure.
    'Couldn’t connect · retrying (2 of 10)…',
    // The call went through: the notice is gone for good.
    'Replying…',
    'Replying…',
  ])
  const assistant = state.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' ? assistant.retry : 'missing', undefined)
})

test('a compaction is the working line until the summary lands or the turn goes on, in both folds', () => {
  const working = (entries: ReturnType<typeof projectConversation>['entries']) =>
    deriveConversationTimelineRows(entries, true).find((row) => row.kind === 'working')
  const events = [
    event('user_message', 1, { turnId: 'a', text: '/compact' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('context_compacting', 3, { turnId: 'a' }),
    // A usage report can land mid-summary; the summary is still the step.
    event('usage_updated', 4, { turnId: 'a', contextUsed: 180_000 }),
    event('context_compacted', 5, { turnId: 'a', trigger: 'manual', postTokens: 12_000 }),
    // On its own when the window filled, then the reply carries on.
    event('context_compacting', 6, { turnId: 'a' }),
    event('content_delta', 7, { turnId: 'a', text: 'Hello' }),
  ]
  const labels: (string | undefined)[] = []
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix))
    const row = working(state.projection.entries)
    labels.push(row?.kind === 'working' ? row.label : undefined)
  }
  assert.deepEqual(labels.slice(1), [
    'Thinking…',
    'Compacting…',
    'Compacting…',
    'Thinking…',
    'Compacting…',
    'Replying…',
  ])
  const failed = projectConversation([
    event('turn_started', 1, { turnId: 'a' }),
    event('context_compacting', 2, { turnId: 'a' }),
    event('turn_failed', 3, { reason: 'interrupted' }),
  ])
  const assistant = failed.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' ? assistant.compacting : 'missing', undefined)
})

test('a turn that gives up after retrying shows the failure, not the retry', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('turn_retrying', 2, { turnId: 'a', attempt: 10, maxAttempts: 10, retryInMs: 30_000, status: 529 }),
    event('turn_failed', 3, { reason: 'provider', message: 'Overloaded' }),
  ]
  const projection = projectConversation(events)
  const assistant = projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' && assistant.status, 'failed')
  assert.equal(assistant?.kind === 'assistant' ? assistant.retry : 'missing', undefined)
  assert.equal(
    deriveConversationTimelineRows(projection.entries, false).some((row) => row.kind === 'working'),
    false,
  )
})

test('incremental deltas are substantially cheaper than full refolds', () => {
  const seed: ConversationEvent[] = [event('turn_started', 0, { turnId: 'a' })]
  for (let i = 1; i <= 5000; i++) seed.push(event('content_delta', i, { turnId: 'a', text: 'x' }))
  const deltas = Array.from({ length: 1000 }, (_, i) => event('content_delta', i + 5001, { turnId: 'a', text: 'y' }))
  let state = createConversationProjectionState(seed)
  let start = performance.now()
  for (const delta of deltas) state = applyEvent(state, delta)
  const incrementalMs = performance.now() - start
  const all = seed.slice()
  start = performance.now()
  for (const delta of deltas) {
    all.push(delta)
    projectConversation(all)
  }
  const foldMs = performance.now() - start
  assert.ok(foldMs >= incrementalMs * 20, `incremental ${incrementalMs.toFixed(1)}ms, fold ${foldMs.toFixed(1)}ms`)
})

test('an interrupt without a turn id closes the open reasoning run in the incremental fold too', () => {
  const events = [
    event('user_message', 1, { turnId: 'a', text: 'Go' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('turn_completed', 3, { turnId: 'a' }),
    event('user_message', 4, { turnId: 'b', text: 'Again' }),
    event('turn_started', 5, { turnId: 'b' }),
    event('reasoning_delta', 6, { turnId: 'b', text: 'think' }),
    event('turn_failed', 7, { reason: 'interrupted' }),
    // A straggler after the interrupt must not count the thinking again.
    event('content_delta', 9, { turnId: 'b', text: 'late' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), item.type)
  }
  const assistant = state.projection.entries.find((entry) => entry.kind === 'assistant' && entry.turnId === 'b')
  assert.equal(assistant?.kind === 'assistant' && assistant.reasoningDurationMs, 10)
})

test('a second stretch of thinking after prose is live and starts its own paragraph', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('reasoning_delta', 2, { turnId: 'a', text: 'Read the plan.' }),
    event('content_delta', 3, { turnId: 'a', text: 'Here is the plan.' }),
    event('reasoning_delta', 4, { turnId: 'a', text: 'Now the edge' }),
    event('reasoning_delta', 5, { turnId: 'a', text: ' cases.' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  const live: (boolean | undefined)[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), item.type)
    const entry = state.projection.entries.find((candidate) => candidate.kind === 'assistant')
    live.push(entry?.kind === 'assistant' ? entry.reasoningLive : undefined)
  }
  assert.deepEqual(live, [undefined, true, undefined, true, true])
  const assistant = state.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' && assistant.reasoning, 'Read the plan.\n\nNow the edge cases.')
  assert.equal(assistant?.kind === 'assistant' && assistant.reasoningDurationMs, 10)
  const settled = applyEvent(state, event('turn_completed', 6, { turnId: 'a' }))
  const done = settled.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(done?.kind === 'assistant' && done.reasoningLive, undefined)
  assert.equal(done?.kind === 'assistant' && done.reasoningDurationMs, 30)
})

// One list of local turns for a whole run: a new list is a new set of turns.
const noTurns: [] = []

test('a coalesced batch of tokens appends incrementally instead of refolding the log', () => {
  const events: ConversationEvent[] = []
  for (let i = 0; i < 2000; i++) {
    events.push(event('user_message', i * 3, { turnId: `turn-${i}`, text: `Prompt ${i}` }))
    events.push(event('content_delta', i * 3 + 1, { turnId: `turn-${i}`, text: 'Answer' }))
    events.push(event('turn_completed', i * 3 + 2, { turnId: `turn-${i}` }))
  }
  events.push(event('user_message', 7000, { turnId: 'live', text: 'Go' }))
  events.push(event('turn_started', 7001, { turnId: 'live' }))
  events.push(event('reasoning_delta', 7002, { turnId: 'live', text: 'think' }))
  const hydrated = syncConversationProjection(createConversationProjectionState(), events, noTurns)
  const frame = [
    ...events,
    event('reasoning_delta', 7003, { turnId: 'live', text: ' harder' }),
    event('content_delta', 7004, { turnId: 'live', text: 'Hel' }),
    event('content_delta', 7005, { turnId: 'live', text: 'lo' }),
    event('content_delta', 7006, { turnId: 'live', text: ' there' }),
  ]
  const next = syncConversationProjection(hydrated, frame, noTurns)
  assert.deepEqual(next.projection, projectConversation(frame))
  // Only a token moved: nothing derived from the transcript's shape is stale.
  assert.equal(next.structureRevision, hydrated.structureRevision)
  const live = hydrated.projection.entries.length - 1
  for (let index = 0; index < live; index++)
    assert.equal(next.projection.entries[index], hydrated.projection.entries[index])
  // The caller's arrays are read, never written.
  assert.equal(frame.length, events.length + 4)
})

test('a batch mixing steps and tokens matches the reference fold at every size', () => {
  const base = [event('user_message', 0, { turnId: 'a', text: 'Go' }), event('turn_started', 1, { turnId: 'a' })]
  const tail: ConversationEvent[] = []
  for (let i = 0; i < 12; i++) {
    tail.push(event('content_delta', 10 + i * 4, { turnId: 'a', text: `step ${i} ` }))
    tail.push(
      event('tool_started', 11 + i * 4, { turnId: 'a', toolUseId: `t${i}`, name: 'Read', input: { path: `${i}.ts` } }),
    )
    tail.push(event('tool_output', 12 + i * 4, { turnId: 'a', toolUseId: `t${i}`, output: 'part', partial: true }))
    tail.push(event('tool_output', 13 + i * 4, { turnId: 'a', toolUseId: `t${i}`, output: 'done', status: 'ok' }))
  }
  tail.push(event('turn_completed', 100, { turnId: 'a' }))
  // One step at a time, a few at once, and more steps than a batch refolds for.
  for (const size of [1, 3, 9, tail.length]) {
    let state = syncConversationProjection(createConversationProjectionState(), base, noTurns)
    for (let end = 0; end < tail.length; end += size) {
      const events = [...base, ...tail.slice(0, end + size)]
      state = syncConversationProjection(state, events, noTurns)
      assert.deepEqual(state.projection, projectConversation(events), `batch of ${size} at ${end}`)
    }
  }
})

test('appending to a state read from a caller never writes to the caller', () => {
  const events = [event('user_message', 0, { turnId: 'a', text: 'Go' }), event('turn_started', 1, { turnId: 'a' })]
  const synced = syncConversationProjection(createConversationProjectionState(), events, noTurns)
  const first = applyEvent(synced, event('content_delta', 2, { turnId: 'a', text: 'one' }))
  const branch = applyEvent(synced, event('content_delta', 3, { turnId: 'a', text: 'two' }))
  const again = applyEvent(first, event('content_delta', 4, { turnId: 'a', text: ' more' }))
  assert.equal(events.length, 2)
  const text = (state: typeof first) => state.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(text(first)?.kind === 'assistant' && text(first)?.text, 'one')
  assert.equal(text(branch)?.kind === 'assistant' && text(branch)?.text, 'two')
  assert.equal(text(again)?.kind === 'assistant' && text(again)?.text, 'one more')
})

test('a token keeps the streaming turn row’s steps and decisions lists', () => {
  const events = [
    event('user_message', 0, { turnId: 'a', text: 'Go' }),
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, { turnId: 'a', toolUseId: 't1', name: 'Read', input: { path: 'a.ts' } }),
    event('tool_output', 3, { turnId: 'a', toolUseId: 't1', output: 'a', status: 'ok' }),
    event('approval_requested', 4, { turnId: 'a', requestId: 'r', summary: 'Run', action: 'Bash' }),
    event('approval_resolved', 5, { turnId: 'a', requestId: 'r', approved: true }),
    event('content_delta', 6, { turnId: 'a', text: 'Hel' }),
  ]
  let state = createConversationProjectionState(events)
  const before = deriveConversationTimelineRows(state.projection.entries, state.projection.activeTurn)
  state = applyEvent(state, event('content_delta', 7, { turnId: 'a', text: 'lo' }))
  const after = deriveConversationTimelineRows(state.projection.entries, state.projection.activeTurn, before)
  const turn = (rows: typeof before) => rows.find((row) => row.kind === 'assistant')
  const [was, now] = [turn(before), turn(after)]
  assert.ok(was?.kind === 'assistant' && now?.kind === 'assistant')
  assert.notEqual(now, was)
  assert.equal(now.tools, was.tools)
  assert.equal(now.decisions, was.decisions)
})

test('subagent progress, subagent words and usage reports fold incrementally, as the fold does', () => {
  const events = [
    event('user_message', 0, { turnId: 'a', text: 'Fan out' }),
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, {
      turnId: 'a',
      toolUseId: 'lane',
      name: 'Task',
      subagentLane: true,
      subagentType: 'Explore',
    }),
    event('tool_started', 3, { turnId: 'a', toolUseId: 'inner', name: 'Read', parentToolUseId: 'lane' }),
    event('subagent_status', 4, {
      toolUseId: 'lane',
      status: 'running',
      lastToolName: 'Read',
      usage: { totalTokens: 10, toolUses: 1, durationMs: 5 },
    }),
    event('subagent_message', 5, { parentToolUseId: 'lane', text: 'Looking at the reader.' }),
    event('subagent_message', 6, { parentToolUseId: 'inner', text: 'A child speaks.', truncated: true }),
    event('usage_updated', 7, {
      turnId: 'a',
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 5,
      promptCache: { cached: true, ttl: '5m' },
    }),
    event('usage_updated', 8, { outputTokens: 9 }),
    event('subagent_message', 9, { parentToolUseId: 'nowhere', text: 'Before its lane.' }),
    event('subagent_status', 10, { toolUseId: 'lane', status: 'completed', endedAt: 95 }),
    event('subagent_status', 11, { toolUseId: 'lane', status: 'running' }),
    event('subagent_status', 12, { toolUseId: 'nowhere', status: 'failed', error: 'boom' }),
    event('usage_updated', 13, { turnId: 'unknown', inputTokens: 1 }),
    event('turn_completed', 14, { turnId: 'a' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), `${item.type} ${item.id}`)
  }
})

// Recorded from a real chat: its Claude Code process ended under five running
// agents, and the next turn resumed each with SendMessage. A transcript from
// before the provider said so names only the SendMessage call; one written
// since names the lane and says the agent resumed. Either way the lane the
// agent started in reopens, and the SendMessage call stays a plain call.
test('an agent resumed after its process ended reopens the lane it started in', () => {
  const lane = (projection: ReturnType<typeof projectConversation>, id: string) => {
    const entry = projection.entries.find((candidate) => candidate.kind === 'tool' && candidate.id === id)
    return entry?.kind === 'tool' ? entry : undefined
  }
  const spawn = [
    event('user_message', 0, { turnId: 'a', text: 'Build it' }),
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, { turnId: 'a', toolUseId: 'agent', name: 'Agent', subagentLane: true }),
    event('subagent_status', 3, { toolUseId: 'agent', taskId: 'task', status: 'running', background: true }),
    event('turn_completed', 4, { turnId: 'a' }),
    event('subagent_status', 5, {
      toolUseId: 'agent',
      taskId: 'task',
      status: 'stopped',
      background: true,
      error: 'The agent stopped when its Claude Code process ended.',
    }),
    event('user_message', 6, { turnId: 'b', text: 'Did you stop?' }),
    event('turn_started', 7, { turnId: 'b' }),
    event('tool_started', 8, { turnId: 'b', toolUseId: 'send', name: 'SendMessage' }),
  ]
  const transcripts = {
    // Also what a provider writes after an app restart, when nothing remembers
    // the lane: only the task id says where the answer belongs.
    'written before the fix': [
      event('subagent_status', 9, { toolUseId: 'send', taskId: 'task', status: 'running', background: true }),
      event('tool_output', 10, { turnId: 'b', toolUseId: 'send', output: 'Resuming agent', status: 'ok' }),
      event('subagent_status', 11, { toolUseId: 'send', taskId: 'task', status: 'running', lastToolName: 'Bash' }),
    ],
    'written since': [
      event('subagent_status', 9, { toolUseId: 'agent', taskId: 'task', status: 'running', resumed: true }),
      event('tool_output', 10, { turnId: 'b', toolUseId: 'send', output: 'Resuming agent', status: 'ok' }),
      event('subagent_status', 11, { toolUseId: 'agent', taskId: 'task', status: 'running', lastToolName: 'Bash' }),
    ],
  }
  // How each ends: the agent's answer, then its last status.
  const finish = (laneId: string) => [
    event('tool_output', 12, {
      toolUseId: laneId,
      taskId: 'task',
      backgroundResult: true,
      output: 'Built it.',
      status: 'ok',
    }),
    event('subagent_status', 13, { toolUseId: laneId, taskId: 'task', status: 'completed' }),
  ]
  for (const [name, resume] of Object.entries(transcripts)) {
    const events = [...spawn, ...resume]
    let state = createConversationProjectionState()
    const prefix: ConversationEvent[] = []
    for (const item of events) {
      state = applyEvent(state, item)
      prefix.push(item)
      assert.deepEqual(state.projection, projectConversation(prefix), `${name}: ${item.type} ${item.id}`)
    }
    const agent = lane(state.projection, 'agent')
    assert.equal(agent?.status, 'running', `${name}: the lane runs again`)
    assert.equal(agent?.agent?.state, 'running')
    assert.equal(agent?.agent?.error, undefined, `${name}: and no longer says why it stopped`)
    assert.equal(agent?.agent?.lastToolName, 'Bash', `${name}: and shows what the agent is doing`)
    assert.equal(lane(state.projection, 'send')?.agent, undefined, `${name}: SendMessage is not a lane`)

    for (const item of finish(name === 'written since' ? 'agent' : 'send')) {
      state = applyEvent(state, item)
      prefix.push(item)
      assert.deepEqual(state.projection, projectConversation(prefix), `${name}: ${item.type} ${item.id}`)
    }
    assert.equal(lane(state.projection, 'agent')?.output, 'Built it.', `${name}: the answer lands in the agent's lane`)
    assert.equal(lane(state.projection, 'agent')?.agent?.state, 'completed')
    assert.equal(lane(state.projection, 'send')?.output, 'Resuming agent', `${name}: and not on SendMessage`)

    // A late stop carrying the resume flag (the runtime copies the last status
    // it knew onto the stop it writes when a session ends) never reopens it.
    const late = event('subagent_status', 14, { toolUseId: 'agent', taskId: 'task', status: 'stopped', resumed: true })
    state = applyEvent(state, late)
    prefix.push(late)
    assert.deepEqual(state.projection, projectConversation(prefix), `${name}: late stop`)
    assert.equal(lane(state.projection, 'agent')?.status, 'done', `${name}: a finished lane stays closed`)
  }
})

// The lane's call is on a page not loaded yet: the SendMessage's statuses must
// not land on the SendMessage row in the incremental path while the fold files
// them, pending, under the lane.
test('a resumed agent whose lane is on an unloaded page agrees with the fold', () => {
  const events = [
    event('subagent_status', 0, { toolUseId: 'agent', taskId: 'task', status: 'running', background: true }),
    event('user_message', 1, { turnId: 'b', text: 'Did you stop?' }),
    event('turn_started', 2, { turnId: 'b' }),
    event('tool_started', 3, { turnId: 'b', toolUseId: 'send', name: 'SendMessage' }),
    event('subagent_status', 4, { toolUseId: 'send', taskId: 'task', status: 'running', lastToolName: 'Bash' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), `${item.type} ${item.id}`)
  }
})

test('a refold keeps unchanged entries without serialising them, and hands tool input through', () => {
  const input = { file_path: 'src/a.ts', content: 'x'.repeat(100_000) }
  const events = [
    event('user_message', 0, { turnId: 'a', text: 'Write it' }),
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, { turnId: 'a', toolUseId: 'w', name: 'Write', input }),
    event('tool_output', 3, { turnId: 'a', toolUseId: 'w', output: 'ok', status: 'ok' }),
    event('content_delta', 4, { turnId: 'a', text: 'Done.' }),
  ]
  let state = createConversationProjectionState(events)
  const tool = state.projection.entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' && tool.input, input)
  const agentTypes = state.projection.agentTypes
  const user = state.projection.entries[0]
  const stringify = JSON.stringify
  let serialised = 0
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    serialised++
    return stringify(...args)
  }) as typeof JSON.stringify
  try {
    state = applyEvent(state, event('turn_completed', 5, { turnId: 'a' }))
  } finally {
    JSON.stringify = stringify
  }
  assert.equal(serialised, 0)
  assert.equal(
    state.projection.entries.find((entry) => entry.kind === 'tool'),
    tool,
  )
  assert.equal(state.projection.entries[0], user)
  assert.equal(state.projection.agentTypes, agentTypes)
})

test("a step's returned pictures are projected the same by the fold and the incremental projection", () => {
  const events = [
    event('user_message', 1, { turnId: 'a', text: 'Screenshot the page' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('tool_started', 3, { turnId: 'a', toolUseId: 'shot', name: 'browser_screenshot', input: {} }),
    event('tool_output', 4, {
      turnId: 'a',
      toolUseId: 'shot',
      output: 'Captured 1280×800.',
      status: 'ok',
      // A path that is not text is not a picture; at most eight are kept.
      images: ['/Users/dev/Library/Studio/conversation-images/s/shot-1.png', 7, ...Array(9).fill('/x.png')],
    }),
    event('turn_completed', 5, { turnId: 'a' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), item.type)
  }
  const tool = state.projection.entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' && tool.images?.length, 8)
  assert.equal(tool?.kind === 'tool' && tool.images?.[0], '/Users/dev/Library/Studio/conversation-images/s/shot-1.png')
})

test('a step that returned no pictures carries no images member at all', () => {
  const events = [
    event('tool_started', 1, { turnId: 'a', toolUseId: 'ls', name: 'Bash', input: { command: 'ls' } }),
    event('tool_output', 2, { turnId: 'a', toolUseId: 'ls', output: 'a.ts', status: 'ok', images: [] }),
  ]
  const tool = projectConversation(events).entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool && 'images' in tool, false)
})
