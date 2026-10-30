import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import {
  applyWorkspaceFieldsPatch,
  type WorkspaceFieldsPatch,
  type WorkspaceSyncEvent,
} from '../../shared/workspace-sync'
import { settleWorkspacePatch } from '../../shared/workspace-lifecycle'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { conversationSessionWorking, terminalAgentWorking } from '../../shared/conversation/phase'
import {
  createConversationLifecycle,
  createConversationListChangeFilter,
  movesWorkspaceList,
} from './conversation-lifecycle'
import { createConversationTools } from './conversation-tools'

const NOW = 1_000_000

function fixture(
  record: Partial<WorkspaceRegistryRecord> | null,
  options: { working?: boolean; chatTurnEnd?: number | (() => Promise<number | undefined>) } = {},
) {
  const stored = record
    ? ({ id: 'ws-1', name: 'Fix the login', createdAt: 10, ...record } as WorkspaceRegistryRecord)
    : null
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const clock = { at: NOW }
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (stored && workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      // Applied the way main's reducer applies it, clocks only forward.
      if (stored) applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: (workspaceId, lastVisitedAt, actor) => {
      // The service's own command: it stamps the rewind, nobody else may.
      const patch = { lastVisitedAt, visitRewoundAt: clock.at }
      writes.push({ workspaceId, patch, actor })
      if (stored) applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    isWorking: () => options.working === true,
    latestChatTurnEnd: () => (typeof options.chatTurnEnd === 'function' ? options.chatTurnEnd() : options.chatTurnEnd),
    now: () => clock.at,
  })
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
  })
  const toolNamed = (name: string) => tools.find((candidate) => candidate.name === name)!
  return {
    stored,
    writes,
    clock,
    lifecycle,
    settle: toolNamed('conversation.settle'),
    visit: toolNamed('conversation.visit'),
    markUnread: toolNamed('conversation.mark_unread'),
  }
}

const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }

test('settling writes the row menu’s own Settle patch, as the paired device', async () => {
  const f = fixture({ lastTerminalActivityAt: 500, snoozedUntil: 2_000_000 })
  const result = await f.settle.handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: NOW })
  assert.deepEqual(f.writes, [
    {
      workspaceId: 'ws-1',
      patch: settleWorkspacePatch({ lastTerminalActivityAt: 500, snoozedUntil: 2_000_000 }, NOW, 'settled'),
      actor: 'mobile',
    },
  ])
})

test('settled: false brings a chat back and holds it out of the sweep, as Un-settle does', async () => {
  const f = fixture({ settledAt: 900, settledOverride: 'settled' })
  const result = await f.settle.handler({ workspaceId: 'ws-1', settled: false })
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: null })
  assert.deepEqual(f.writes, [
    { workspaceId: 'ws-1', patch: { settledAt: null, settledOverride: 'active' }, actor: 'gateway' },
  ])
})

test('bringing a chat back hands back a snooze its Settle kept, and drops one that ran out meanwhile', async () => {
  const kept = fixture({ settledAt: 900, settledOverride: 'settled', snoozedUntil: 2_000_000 })
  await kept.settle.handler({ workspaceId: 'ws-1', settled: false })
  assert.deepEqual(kept.writes, [
    { workspaceId: 'ws-1', patch: { settledAt: null, settledOverride: 'active' }, actor: 'gateway' },
  ])
  const ranOut = fixture({ settledAt: 900, settledOverride: 'settled', snoozedUntil: 950 })
  await ranOut.settle.handler({ workspaceId: 'ws-1', settled: false })
  assert.deepEqual(ranOut.writes, [
    {
      workspaceId: 'ws-1',
      patch: { settledAt: null, settledOverride: 'active', snoozedUntil: null },
      actor: 'gateway',
    },
  ])
})

test('settling a settled chat again writes nothing and answers when it was settled', async () => {
  const f = fixture({ settledAt: 900 })
  const result = await f.settle.handler({ workspaceId: 'ws-1' })
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: 900 })
  assert.deepEqual(f.writes, [])
})

test('a chat whose agent is working is not settled', async () => {
  const f = fixture({}, { working: true })
  const result = await f.settle.handler({ workspaceId: 'ws-1' })
  assert.equal(result.isError, true)
  assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'working')
  assert.deepEqual(f.writes, [])
})

test('an unknown chat is refused by name, by both tools', async () => {
  const f = fixture(null)
  for (const handler of [f.settle.handler, f.visit.handler]) {
    const result = await handler({ workspaceId: 'ws-9' })
    assert.equal(result.isError, true)
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')
  }
})

test('bad arguments are refused before anything is read', async () => {
  const f = fixture({})
  const refusals = [
    await f.settle.handler({}),
    await f.settle.handler({ workspaceId: 'ws-1', settled: 'yes' }),
    await f.visit.handler({ workspaceId: '  ' }),
    await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 'now' }),
    await f.visit.handler({ workspaceId: 'ws-1', visitedAt: -5 }),
  ]
  for (const result of refusals)
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.deepEqual(f.writes, [])
})

test('a visit moves the visit clock forward and touches nothing else', async () => {
  const f = fixture({ lastVisitedAt: 100, settledAt: 50, lastUserMessageAt: 40 })
  const result = await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 700 }, TAILNET)
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 700 })
  assert.deepEqual(f.writes, [{ workspaceId: 'ws-1', patch: { lastVisitedAt: 700 }, actor: 'mobile' }])
  assert.equal(f.stored?.settledAt, 50, 'a settled chat stays settled')
  assert.equal(f.stored?.lastUserMessageAt, 40, 'a visit is not a message')
})

test('an earlier visit changes nothing and answers the clock as it stands', async () => {
  const f = fixture({ lastVisitedAt: 800 })
  const result = await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 700 })
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 800 })
  assert.deepEqual(f.writes, [])
})

test('a visit is never later than this machine’s own now, and defaults to it', async () => {
  const ahead = fixture({})
  await ahead.visit.handler({ workspaceId: 'ws-1', visitedAt: NOW + 60_000 })
  assert.equal(ahead.stored?.lastVisitedAt, NOW)
  const omitted = fixture({})
  await omitted.visit.handler({ workspaceId: 'ws-1' })
  assert.equal(omitted.stored?.lastVisitedAt, NOW)
})

test('Mark unread moves the visit clock back to just before the latest finish, and stamps that it did', async () => {
  const f = fixture({ lastVisitedAt: 9_000, lastTurnEndedAt: 4_000 }, { chatTurnEnd: 5_000 })
  const result = await f.markUnread.handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 4_999 })
  assert.deepEqual(f.writes, [
    { workspaceId: 'ws-1', patch: { lastVisitedAt: 4_999, visitRewoundAt: NOW }, actor: 'mobile' },
  ])
  // Main's reducer takes the earlier clock: the rewind stamp is what allows it.
  assert.equal(f.stored?.lastVisitedAt, 4_999)
  assert.equal(f.stored?.visitRewoundAt, NOW)
})

test("a chat's terminal agents' finish counts as well as its chats'", async () => {
  const f = fixture({ lastVisitedAt: 9_000, lastTurnEndedAt: 6_000 }, { chatTurnEnd: 5_000 })
  assert.deepEqual(await f.lifecycle.markUnread('ws-1', 'ui'), { ok: true, workspaceId: 'ws-1', lastVisitedAt: 5_999 })
})

test('a chat already unread from further back keeps its clock, and still says it was marked', async () => {
  const f = fixture({ lastVisitedAt: 1_000 }, { chatTurnEnd: 5_000 })
  assert.deepEqual(await f.lifecycle.markUnread('ws-1', 'ui'), { ok: true, workspaceId: 'ws-1', lastVisitedAt: 1_000 })
  assert.deepEqual(f.writes[0]?.patch, { lastVisitedAt: 1_000, visitRewoundAt: NOW })
})

test('a finish on record only in the transcripts, as after a restart, can be marked unread', async () => {
  // A chat-only conversation keeps no `lastTurnEndedAt` on the record, and
  // after a restart no session holds it: its transcript index does.
  const f = fixture({ lastVisitedAt: 9_000 }, { chatTurnEnd: async () => 6_000 })
  assert.deepEqual(await f.lifecycle.markUnread('ws-1', 'ui'), { ok: true, workspaceId: 'ws-1', lastVisitedAt: 5_999 })
})

test('a chat whose agent has finished nothing is not marked, and an unknown one is refused by name', async () => {
  const nothing = fixture({ lastVisitedAt: 1_000 })
  const refused = await nothing.markUnread.handler({ workspaceId: 'ws-1' })
  assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'nothing_finished')
  assert.deepEqual(nothing.writes, [])
  const unknown = fixture(null)
  const missing = await unknown.markUnread.handler({ workspaceId: 'ws-9' })
  assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')
  const bad = await unknown.markUnread.handler({})
  assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
})

test('a visit after Mark unread moves the clock forward again, as reading it does', async () => {
  const f = fixture({ lastVisitedAt: 9_000 }, { chatTurnEnd: 5_000 })
  await f.lifecycle.markUnread('ws-1', 'ui')
  f.clock.at = NOW + 1_000
  await f.visit.handler({ workspaceId: 'ws-1', visitedAt: NOW + 500 })
  assert.equal(f.stored?.lastVisitedAt, NOW + 500)
})

test('a visit stamped before a Mark unread, arriving after it, does not undo it', async () => {
  const f = fixture({ lastVisitedAt: 1_000 }, { chatTurnEnd: 5_000 })
  f.clock.at = 8_000
  await f.lifecycle.markUnread('ws-1', 'ui')
  assert.equal(f.stored?.lastVisitedAt, 1_000)
  f.clock.at = 9_000
  // A phone's reading from before the mark, sent late.
  const late = await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 7_000 })
  assert.deepEqual(late.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 1_000 })
  const atTheMark = await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 8_000 })
  assert.deepEqual(atTheMark.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 1_000 })
  assert.equal(f.writes.length, 1, 'only the mark was written')
  // One taken after it reads the chat again.
  await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 8_500 })
  assert.equal(f.stored?.lastVisitedAt, 8_500)
})

test('a message from a paired device moves the message clock and wakes a resting chat', () => {
  const f = fixture({ settledAt: 900, settledOverride: 'settled', lastUserMessageAt: 100 })
  f.lifecycle.noteUserMessage('ws-1', 2_000, 'gateway')
  assert.deepEqual(f.writes, [
    {
      workspaceId: 'ws-1',
      patch: { settledAt: null, settledOverride: null, lastUserMessageAt: 2_000 },
      actor: 'gateway',
    },
  ])
})

test('a message older than the clock writes nothing', () => {
  const f = fixture({ lastUserMessageAt: 3_000 })
  f.lifecycle.noteUserMessage('ws-1', 2_000, 'gateway')
  assert.deepEqual(f.writes, [])
})

function fieldsEvent(workspaceId: string, patch: WorkspaceFieldsPatch): WorkspaceSyncEvent {
  return {
    id: 'e',
    type: 'workspace.fields_updated',
    sourceWindowId: 'primary',
    sequence: 1,
    createdAt: 1,
    payload: { workspaceId, patch, editedAt: 1 },
  }
}

test('a settle, a message or a rename moves the conversation list a paired device reads', () => {
  const changed = createConversationListChangeFilter({ turnEndOf: () => undefined })
  assert.equal(changed(fieldsEvent('ws-1', { settledAt: 5 })), true)
  assert.equal(changed(fieldsEvent('ws-1', { settledAt: null, settledOverride: 'active' })), true)
  assert.equal(changed(fieldsEvent('ws-1', { lastUserMessageAt: 5 })), true)
  assert.equal(
    changed({
      id: 'e',
      type: 'workspace.renamed',
      sourceWindowId: 'primary',
      sequence: 2,
      createdAt: 1,
      payload: { workspaceId: 'ws-1', name: 'Fix the login', editedAt: 1 },
    } as WorkspaceSyncEvent),
    true,
  )
  assert.equal(changed(fieldsEvent('ws-1', { lastTerminalActivityAt: 5 })), false, 'a keystroke is not in the list')
})

test('a visit moves the list the first time, and again only once a turn has ended since', () => {
  let turnEnd: number | undefined = 100
  const changed = createConversationListChangeFilter({ turnEndOf: () => turnEnd })
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 200 })), true, 'the first visit this run')
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 210 })), false, 'a visit with nothing new seen')
  turnEnd = 215
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 220 })), true, 'the first visit since a finish')
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 230 })), false)
})

test('Mark unread moves the list every time: the clock went back, which every device has to hear', () => {
  const changed = createConversationListChangeFilter({ turnEndOf: () => 100 })
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 200 })), true)
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 99, visitRewoundAt: 300 })), true)
  // Read again: the first visit since the rewind is news too.
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 400 })), true)
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 410 })), false)
})

test('a patch of the clocks alone does not move the workspace list, which carries none of them', () => {
  assert.equal(movesWorkspaceList(fieldsEvent('ws-1', { lastVisitedAt: 200 })), false, 'a visit stamp')
  assert.equal(movesWorkspaceList(fieldsEvent('ws-1', { lastVisitedAt: 99, visitRewoundAt: 300 })), false)
  assert.equal(movesWorkspaceList(fieldsEvent('ws-1', { lastTerminalActivityAt: 5, lastTurnEndedAt: 6 })), false)
  assert.equal(movesWorkspaceList(fieldsEvent('ws-1', { lastUserMessageAt: 5 })), false)
  // A field the list does carry, alone or beside a clock, still moves it.
  assert.equal(movesWorkspaceList(fieldsEvent('ws-1', { settledAt: 5, lastTerminalActivityAt: 4 })), true)
  assert.equal(movesWorkspaceList(fieldsEvent('ws-1', { folderPath: '/Users/dev/app' })), true)
  assert.equal(
    movesWorkspaceList({
      id: 'e',
      type: 'workspace.renamed',
      sourceWindowId: 'primary',
      sequence: 2,
      createdAt: 1,
      payload: { workspaceId: 'ws-1', name: 'Fix the login', editedAt: 1 },
    } as WorkspaceSyncEvent),
    true,
  )
})

const summary = (fields: Partial<ConversationSessionSummary>): ConversationSessionSummary =>
  ({
    sessionId: 'conv-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'mock',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }) as ConversationSessionSummary

test('a chat Settle waits on counts every agent still at work, whatever its parent says', () => {
  const working = [
    summary({ status: 'active', phase: 'running' }),
    summary({ status: 'starting', phase: 'starting' }),
    // Stopped on the person: settling would end the turn that waits on them.
    summary({ status: 'awaiting_approval', phase: 'waiting_for_approval' }),
    summary({ status: 'ready', phase: 'waiting_for_input' }),
    // An agent it launched goes on under a parent that failed or waits.
    summary({ status: 'failed', phase: 'failed', backgroundAgents: 1 }),
    summary({ status: 'ready', phase: 'waiting_for_input', backgroundAgents: 2 }),
    summary({ status: 'ready', phase: 'completed', backgroundAgents: 1 }),
  ]
  for (const session of working) assert.equal(conversationSessionWorking(session), true, JSON.stringify(session))
  const resting = [
    summary({ status: 'ready', phase: 'completed' }),
    summary({ status: 'ready', phase: 'idle' }),
    summary({ status: 'failed', phase: 'failed' }),
    // Nothing is left to end in a stopped session.
    summary({ status: 'stopped', phase: 'running', backgroundAgents: 1 }),
  ]
  for (const session of resting) assert.equal(conversationSessionWorking(session), false, JSON.stringify(session))
})

test('an agent terminal mid-turn is working only while its process is there to run it', () => {
  assert.equal(terminalAgentWorking({ processAlive: true, activity: { kind: 'working' } }), true)
  assert.equal(terminalAgentWorking({ processAlive: false, activity: { kind: 'working' } }), false)
  assert.equal(terminalAgentWorking({ processAlive: true, activity: { kind: 'idle' } }), false)
  assert.equal(terminalAgentWorking({ processAlive: true }), false)
})
