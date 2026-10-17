import { expect, test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../src/protocol.js'
import { projectConversation, type TranscriptEntry } from '../src/conversationProjection.js'
import { deriveConversationTimelineRows } from '../src/conversationTimeline.js'
import { applyEvent, createConversationProjectionState } from '../src/incrementalConversationProjection.js'

// `at` is the event's clock in milliseconds, so reasoning durations are exact.
function event(
  type: ConversationEventType,
  at: number,
  payload: Record<string, unknown> = {},
  modelId = 'claude-sonnet-4-5',
): ConversationEvent {
  return {
    id: `event-${at}`,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId,
    type,
    createdAt: at,
    payload,
  }
}

const assistantOf = (entries: TranscriptEntry[], turnId = 't1') =>
  entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> =>
      entry.kind === 'assistant' && entry.turnId === turnId,
  )

// Think → step → think again → step → think → reply, as a turn with
// interleaved reasoning streams it.
const interleaved: ConversationEvent[] = [
  event('user_message', 0, { turnId: 't1', text: 'Fix the test' }),
  event('turn_started', 1, { turnId: 't1' }),
  event('reasoning_delta', 10, { turnId: 't1', text: 'Look at the failing test first.' }),
  event('tool_started', 40, { turnId: 't1', toolUseId: 'read', name: 'Read' }),
  event('tool_output', 50, { turnId: 't1', toolUseId: 'read', output: 'ok' }),
  event('reasoning_delta', 60, { turnId: 't1', text: 'The fixture is stale.' }),
  event('content_delta', 70, { turnId: 't1', text: 'Updating the fixture.' }),
  event('reasoning_delta', 80, { turnId: 't1', text: ' Then rerun.' }),
  event('tool_started', 100, { turnId: 't1', toolUseId: 'edit', name: 'Edit' }),
  event('tool_output', 110, { turnId: 't1', toolUseId: 'edit', output: 'ok' }),
  event('reasoning_delta', 120, { turnId: 't1', text: 'Done.' }),
  event('content_delta', 150, { turnId: 't1', text: 'Fixed.' }),
  event('turn_completed', 160, { turnId: 't1' }),
]

test('reasoning keeps its place before the step it led to, with the time it streamed', () => {
  const turn = assistantOf(projectConversation(interleaved).entries)!
  expect(turn.reasoningSegments).toEqual([
    { text: 'Look at the failing test first.', beforeToolUseId: 'read', durationMs: 30 },
    // Two runs split by prose belong to the same stretch before the next step,
    // each its own paragraph.
    { text: 'The fixture is stale.\n\nThen rerun.', beforeToolUseId: 'edit', durationMs: 30 },
  ])
  expect(turn.reasoning).toBe('Done.')
  expect(turn.reasoningDurationMs).toBe(30)
  expect(turn.intermediateText).toEqual([{ text: 'Updating the fixture.', beforeToolUseId: 'edit' }])
})

test('the incremental fold places reasoning exactly as the full fold does', () => {
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of interleaved) {
    state = applyEvent(state, item)
    prefix.push(item)
    expect(state.projection).toStrictEqual(projectConversation(prefix))
  }
})

test('reasoning still streaming has no duration yet', () => {
  const turn = assistantOf(
    projectConversation([
      event('turn_started', 1, { turnId: 't1' }),
      event('reasoning_delta', 10, { turnId: 't1', text: 'Hmm' }),
    ]).entries,
  )!
  expect(turn.reasoning).toBe('Hmm')
  expect(turn.reasoningDurationMs).toBeUndefined()
})

test('a turn keeps its own token counts and the credential source it ended under', () => {
  const projection = projectConversation([
    event('session_updated', 0, { apiKeySource: 'ANTHROPIC_API_KEY' }),
    event('turn_started', 1, { turnId: 't1' }),
    event('usage_updated', 2, { turnId: 't1', inputTokens: 12_000, outputTokens: 800 }),
    event('turn_completed', 3, { turnId: 't1', costUsd: 0.12 }),
    event('turn_started', 4, { turnId: 't2' }),
    event('usage_updated', 5, { turnId: 't2', outputTokens: 20 }),
    event('turn_completed', 6, { turnId: 't2' }),
  ])
  expect(assistantOf(projection.entries)).toMatchObject({
    inputTokens: 12_000,
    outputTokens: 800,
    costUsd: 0.12,
    apiKeySource: 'ANTHROPIC_API_KEY',
  })
  const second = assistantOf(projection.entries, 't2')!
  expect(second.inputTokens).toBeUndefined()
  expect(second.outputTokens).toBe(20)
})

test('the chat’s prompt cache and each turn’s cached share come off its usage reports', () => {
  const projection = projectConversation([
    event('turn_started', 1, { turnId: 't1' }),
    event('usage_updated', 2, { turnId: 't1', promptCache: { ttl: '1h', cached: true, recacheTokens: 310_000 } }),
    event('usage_updated', 3, { turnId: 't1', inputTokens: 12_000, cachedInputTokens: 11_000, outputTokens: 800 }),
    event('turn_completed', 4, { turnId: 't1' }),
  ])
  // Cold one lifetime after the request was seen to start: the same fold
  // main's runtime makes.
  expect(projection.promptCache).toEqual({ ttl: '1h', expiresAt: 2 + 60 * 60_000, recacheTokens: 310_000 })
  // A report carrying only the cache leaves the turn's counts alone.
  expect(assistantOf(projection.entries)).toMatchObject({
    inputTokens: 12_000,
    cachedInputTokens: 11_000,
    outputTokens: 800,
  })
  expect(projectConversation([event('turn_started', 1, { turnId: 't1' })]).promptCache).toBeNull()
})

test('the context window and how much of it is held come off the latest report, never a sum', () => {
  const events = [
    event('turn_started', 1, { turnId: 't1' }),
    // A request opens: its size is what the window holds now.
    event('usage_updated', 2, { turnId: 't1', contextUsed: 60_000 }),
    // The next request in the same turn sends the conversation again; the
    // window holds that, not the two added up.
    event('usage_updated', 3, { turnId: 't1', contextUsed: 64_000 }),
    // The turn's result names the window and the last request's size with its
    // output; its input count is a sum over requests and is not the window's.
    event('usage_updated', 4, {
      turnId: 't1',
      inputTokens: 124_000,
      outputTokens: 900,
      contextWindow: 200_000,
      contextUsed: 64_900,
    }),
    event('turn_completed', 5, { turnId: 't1' }),
    event('turn_started', 6, { turnId: 't2' }),
    // A mid-turn reading names no window: the one already known stays.
    event('usage_updated', 7, { turnId: 't2', contextUsed: 70_000 }),
  ]
  const projection = projectConversation(events)
  expect(projection.usage).toEqual({
    inputTokens: 124_000,
    outputTokens: 900,
    contextWindow: 200_000,
    contextUsed: 70_000,
  })
  // The incremental fold answers the same.
  let state = createConversationProjectionState()
  for (const item of events) state = applyEvent(state, item)
  expect(state.projection.usage).toEqual(projection.usage)
  // A window of zero is no reading, not an empty window.
  expect(projectConversation([event('usage_updated', 1, { contextWindow: 0, contextUsed: 5 })]).usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    contextUsed: 5,
  })
})

test('a compaction gives the context back: the window holds what the summary left', () => {
  const before = [
    event('turn_started', 1, { turnId: 't1' }),
    event('usage_updated', 2, { turnId: 't1', contextWindow: 200_000, contextUsed: 182_000 }),
  ]
  expect(
    projectConversation([...before, event('context_compacted', 3, { turnId: 't1', postTokens: 24_000 })]).usage,
  ).toMatchObject({ contextWindow: 200_000, contextUsed: 24_000 })
  // A compaction that does not say what it left leaves the window unread until
  // the next request says.
  const unread = projectConversation([...before, event('context_compacted', 3, { turnId: 't1' })]).usage
  expect(unread?.contextWindow).toBe(200_000)
  expect(unread?.contextUsed).toBeUndefined()
})

test('a compaction sits between its turn’s message and reply, or after the turn it followed', () => {
  const projection = projectConversation([
    event('user_message', 0, { turnId: 't1', text: 'First' }),
    event('turn_started', 1, { turnId: 't1' }),
    event('content_delta', 2, { turnId: 't1', text: 'One' }),
    event('turn_completed', 3, { turnId: 't1' }),
    event('context_compacted', 4, { trigger: 'manual', preTokens: 90_000 }),
    event('user_message', 5, { turnId: 't2', text: 'Second' }),
    event('turn_started', 6, { turnId: 't2' }),
    event('context_compacted', 7, { turnId: 't2', trigger: 'auto', preTokens: 180_000, postTokens: 20_000 }),
    event('content_delta', 8, { turnId: 't2', text: 'Two' }),
    event('turn_completed', 9, { turnId: 't2' }),
  ])
  expect(projection.entries.map((entry) => (entry.kind === 'compaction' ? entry.id : entry.kind))).toEqual([
    'user',
    'assistant',
    'event-4',
    'user',
    'event-7',
    'assistant',
  ])
  expect(projection.entries[4]).toEqual({
    kind: 'compaction',
    id: 'event-7',
    turnId: 't2',
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 20_000,
    createdAt: 7,
  })
  const rows = deriveConversationTimelineRows(projection.entries, projection.activeTurn)
  expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'compaction', 'user', 'compaction', 'assistant'])
})

test('a reply marks the model switch from the reply before it, and only then', () => {
  const turn = (id: string, at: number, modelId: string) => [
    event('user_message', at, { turnId: id, text: 'go' }, modelId),
    event('turn_started', at + 1, { turnId: id }, modelId),
    event('content_delta', at + 2, { turnId: id, text: 'done' }, modelId),
    event('turn_completed', at + 3, { turnId: id }, modelId),
  ]
  const projection = projectConversation([
    ...turn('t1', 0, 'claude-sonnet-4-5'),
    ...turn('t2', 10, 'claude-sonnet-4-5'),
    ...turn('t3', 20, 'claude-opus-4-5'),
    ...turn('t4', 30, 'claude-opus-4-5'),
  ])
  const rows = deriveConversationTimelineRows(projection.entries, projection.activeTurn)
  expect(rows.flatMap((row) => (row.kind === 'assistant' ? [row.modelSwitched ?? false] : []))).toEqual([
    false,
    false,
    true,
    false,
  ])
  // A re-derive keeps the settled rows it already had.
  const again = deriveConversationTimelineRows(projection.entries, projection.activeTurn, rows)
  expect(again.every((row, index) => row === rows[index])).toBe(true)
})

test('a plan request keeps the file the agent holds it in, including one recorded before the payload named it', () => {
  const planOf = (payload: Record<string, unknown>) =>
    projectConversation([
      event('turn_started', 1, { turnId: 't1' }),
      event('approval_requested', 2, { turnId: 't1', requestId: 'r1', kind: 'plan', plan: '# Plan', ...payload }),
    ]).entries.find((entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval')
  expect(planOf({ planFilePath: '/Users/dev/.claude/plans/a.md' })?.planFilePath).toBe('/Users/dev/.claude/plans/a.md')
  expect(planOf({ input: { plan: '# Plan', planFilePath: '/Users/dev/.claude/plans/b.md' } })?.planFilePath).toBe(
    '/Users/dev/.claude/plans/b.md',
  )
  expect(planOf({})?.planFilePath).toBeUndefined()
})

test('a message Studio sent keeps its origin on the user entry, the full and the incremental fold alike', () => {
  const events = [
    event('user_message', 0, { turnId: 't1', text: 'Start the scout' }),
    event('turn_completed', 5, { turnId: 't1' }),
    event('user_message', 10, {
      turnId: 't2',
      text: '[SprintEngine Studio] Agent Scout, which you launched, finished its turn.',
      origin: { kind: 'studio', reason: 'agent-notice' },
    }),
  ]
  const users = (entries: TranscriptEntry[]) =>
    entries.flatMap((entry) => (entry.kind === 'user' ? [entry.origin ?? null] : []))
  expect(users(projectConversation(events).entries)).toEqual([null, { kind: 'studio', reason: 'agent-notice' }])
  let state = createConversationProjectionState()
  for (const next of events) state = applyEvent(state, next)
  expect(users(state.projection.entries)).toEqual([null, { kind: 'studio', reason: 'agent-notice' }])
})

// The provider reports the whole list each time it changes; a session that
// starts again has a process of its own, which runs nothing yet.
test('the projection keeps the background work the session last reported, until a new session starts', () => {
  const monitor = { taskId: 'task_mon', kind: 'monitor', description: 'CI checks' }
  const server = { taskId: 'task_dev', kind: 'command', description: 'npm run dev' }
  const reported = (events: ConversationEvent[]) => projectConversation(events).backgroundTasks
  const opened = [event('session_started', 0), event('session_updated', 10, { backgroundTasks: [monitor, server] })]

  expect(reported(opened)).toEqual([monitor, server])
  expect(reported([...opened, event('session_updated', 20, { notice: 'Model changed' })])).toEqual([monitor, server])
  expect(reported([...opened, event('session_updated', 20, { backgroundTasks: [server] })])).toEqual([server])
  expect(reported([...opened, event('session_started', 30)])).toEqual([])
  expect(
    reported([
      event('session_updated', 10, { backgroundTasks: [{ taskId: 'x', kind: 'daemon' }, { kind: 'command' }] }),
    ]),
  ).toEqual([])
})

test('an MCP step keeps the title and server name its provider reported, through a second report', () => {
  const entries = projectConversation([
    event('user_message', 0, { turnId: 't1', text: 'Find the invoice' }),
    event('turn_started', 1, { turnId: 't1' }),
    event('tool_started', 10, {
      turnId: 't1',
      toolUseId: 'mail',
      name: 'mcp__claude_ai_Gmail__search_threads',
      displayTitle: 'Search threads',
      serverName: 'Gmail',
    }),
    // Reported again without them (its input filled in): they stay.
    event('tool_started', 11, { turnId: 't1', toolUseId: 'mail', name: 'mcp__claude_ai_Gmail__search_threads' }),
    event('tool_output', 20, { turnId: 't1', toolUseId: 'mail', output: '1 thread' }),
  ]).entries
  const tool = entries.find((entry) => entry.kind === 'tool' && entry.id === 'mail') as
    { displayTitle?: string; serverName?: string } | undefined
  expect([tool?.displayTitle, tool?.serverName]).toEqual(['Search threads', 'Gmail'])
})

// The provider says the goal when it changes, and null once there is none; a
// session that starts again says it again once it has read the thread's.
test('the projection keeps the goal the session last reported, until it is cleared or a new session starts', () => {
  const goal = { objective: 'make the parser tests pass', status: 'active' }
  const reported = (events: ConversationEvent[]) => projectConversation(events).goal
  const opened = [event('session_started', 0), event('session_updated', 10, { goal })]

  expect(reported(opened)).toEqual(goal)
  expect(reported([...opened, event('session_updated', 20, { notice: 'Model changed' })])).toEqual(goal)
  expect(reported([...opened, event('session_updated', 20, { goal: { ...goal, status: 'paused' } })])).toEqual({
    ...goal,
    status: 'paused',
  })
  expect(reported([...opened, event('session_updated', 20, { goal: null })])).toBeNull()
  expect(reported([...opened, event('session_started', 30)])).toBeNull()
})
