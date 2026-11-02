import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import { workspaceLifecycleSnapshot } from '../../shared/workspace-lifecycle'
import { createConversationLifecycle } from './conversation-lifecycle'

// Every decision about a chat's rest is main's, taken on the reading of the
// chat it was made on: one made on a chat that has moved on since is refused,
// and the clock that stamps it is main's, read as it lands.

const DAY = 24 * 60 * 60 * 1000
const BORN = 1_000_000_000_000

function fixture(record: Partial<WorkspaceRegistryRecord> = {}, options: { working?: boolean; busy?: boolean } = {}) {
  const stored = {
    id: 'ws-1',
    name: 'Fix the login',
    mode: 'standard',
    createdAt: BORN,
    autoSettleEnabled: true,
    ...record,
  } as WorkspaceRegistryRecord
  const writes: Array<{ patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  let clock = BORN + 10 * DAY
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (_workspaceId, patch, actor) => {
      writes.push({ patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('nothing here moves the visit clock'),
    isWorking: () => options.working === true,
    ...(options.busy !== undefined ? { isBusy: () => options.busy === true } : {}),
    now: () => clock,
  })
  return {
    stored,
    writes,
    lifecycle,
    snapshot: () => workspaceLifecycleSnapshot(stored),
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

test('a sweep settle lands with the clock read as it lands, as Studio, and records no hand decision', () => {
  const f = fixture()
  const snapshot = f.snapshot()
  f.advance(5_000)
  const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'settle', snapshot })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1', settledAt: f.now() })
  assert.equal(f.stored.settledAt, f.now(), 'stamped with main’s clock at commit, not the decider’s')
  assert.equal(f.stored.settledOverride, null)
  assert.equal(f.writes[0]?.actor, 'system')
})

test('a sweep decision taken on a chat that has changed since is refused', () => {
  const f = fixture()
  const snapshot = f.snapshot()
  // A message lands between the reading and the commit.
  f.stored.lastUserMessageAt = f.now()
  const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'settle', snapshot })
  assert.equal(result.ok === false && result.code, 'stale')
  assert.equal(f.writes.length, 0, 'nothing is written')

  // So is one whose rest moved meanwhile: a hand Settle made between.
  const g = fixture()
  const before = g.snapshot()
  g.lifecycle.settle('ws-1', true, 'ui')
  const woke = g.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'wake', snapshot: before })
  assert.equal(woke.ok === false && woke.code, 'stale')
  assert.equal(typeof g.stored.settledAt, 'number', 'the hand Settle stands')
})

test('a sweep settle is refused for a chat a hand decision, a star, a snooze or the switch has taken out of reach', () => {
  const cases: Array<[string, Partial<WorkspaceRegistryRecord>]> = [
    ['held active by an Un-settle', { settledOverride: 'active' }],
    ['starred', { highlight: { starred: true, color: null } }],
    ['asleep', { snoozedUntil: BORN + 20 * DAY }],
    ['switched off', { autoSettleEnabled: null }],
  ]
  for (const [why, record] of cases) {
    const f = fixture(record)
    const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'settle', snapshot: f.snapshot() })
    assert.equal(result.ok === false && result.code, 'not_applicable', why)
    assert.equal(f.writes.length, 0, why)
  }
})

test('a sweep wake of a chat already awake writes nothing, so a repeated decision is harmless', () => {
  const f = fixture()
  const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'wake', snapshot: f.snapshot() })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1', settledAt: null })
  assert.equal(f.writes.length, 0)
})

test('a window’s Settle is decided on its reading: a stale one is refused with the chat as main has it', () => {
  const f = fixture()
  const seen = f.snapshot()
  // A phone settled it a moment before the window's click arrived.
  f.lifecycle.settle('ws-1', true, 'mobile')
  const answer = f.lifecycle.fromWindow({ workspaceId: 'ws-1', intent: { kind: 'unsettle' }, snapshot: seen })
  assert.equal(answer.ok, false)
  assert.equal(answer.ok === false && answer.code, 'stale')
  assert.deepEqual(answer.ok === false && answer.current, f.snapshot(), 'the answer carries the chat as it stands')
  assert.equal(typeof f.stored.settledAt, 'number', 'and the chat stays as main has it')
})

test('a window’s reading ahead of main on the keystroke clock is not stale, and the clock lands with the Settle', () => {
  const f = fixture({ lastTerminalActivityAt: BORN + DAY })
  const seen = { ...f.snapshot(), activityAt: BORN + 2 * DAY }
  const answer = f.lifecycle.fromWindow({
    workspaceId: 'ws-1',
    intent: { kind: 'settle', lastInputAt: BORN + 2 * DAY },
    snapshot: seen,
  })
  assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' })
  assert.equal(f.stored.settledOverride, 'settled')
  assert.equal(f.stored.lastTerminalActivityAt, BORN + 2 * DAY, 'main is never behind the decision')
})

test('a window’s Settle and Snooze wait only for an agent at work, not one waiting on the person', () => {
  // Waiting on a question: working to a phone's Settle, not busy to the row menu's.
  const waiting = fixture({}, { working: true, busy: false })
  const settled = waiting.lifecycle.fromWindow({
    workspaceId: 'ws-1',
    intent: { kind: 'settle' },
    snapshot: waiting.snapshot(),
  })
  assert.deepEqual(settled, { ok: true, workspaceId: 'ws-1' })
  assert.equal(waiting.lifecycle.settle('ws-1', false, 'ui').ok, true)
  assert.equal(waiting.lifecycle.settle('ws-1', true, 'mobile').ok, false, 'a phone’s Settle is still refused')

  const atWork = fixture({}, { working: true, busy: true })
  const snoozed = atWork.lifecycle.fromWindow({
    workspaceId: 'ws-1',
    intent: { kind: 'snooze', until: atWork.now() + DAY },
    snapshot: atWork.snapshot(),
  })
  assert.equal(snoozed.ok === false && snoozed.code, 'working')
  assert.equal(atWork.stored.snoozedUntil ?? null, null)
})

test('Un-settle hands back the snooze the Settle displaced, from the undo taken as it landed', () => {
  const f = fixture({ snoozedUntil: BORN + 12 * DAY })
  f.lifecycle.fromWindow({ workspaceId: 'ws-1', intent: { kind: 'settle' }, snapshot: f.snapshot() })
  assert.equal(typeof f.stored.settledAt, 'number')
  // Something with no say in the rest lost the snooze underneath it (a
  // window on an older build writing the record whole).
  f.stored.snoozedUntil = null
  const answer = f.lifecycle.fromWindow({ workspaceId: 'ws-1', intent: { kind: 'unsettle' }, snapshot: f.snapshot() })
  assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' })
  assert.equal(f.stored.settledAt, null)
  assert.equal(f.stored.settledOverride, 'active')
  assert.equal(f.stored.snoozedUntil, BORN + 12 * DAY, 'the chat goes back to sleep where it was')
})

test('the undo is spent by a wake: activity, or a snooze woken by hand, does not bring it back', () => {
  const f = fixture({ snoozedUntil: BORN + 12 * DAY })
  f.lifecycle.settle('ws-1', true, 'ui')
  f.lifecycle.snooze('ws-1', null, 'mobile')
  assert.equal(f.stored.snoozedUntil, null)
  f.lifecycle.settle('ws-1', false, 'ui')
  assert.equal(f.stored.snoozedUntil ?? null, null, 'a snooze woken by hand stays woken')

  const g = fixture({ snoozedUntil: BORN + 12 * DAY })
  g.lifecycle.settle('ws-1', true, 'ui')
  g.lifecycle.noteUserMessage('ws-1', g.now(), 'gateway')
  assert.equal(g.stored.settledAt, null, 'a message wakes the chat')
  assert.equal(g.stored.snoozedUntil ?? null, null, 'and the chat is back now, not asleep')
})

test('an undo whose snooze has run out restores nothing', () => {
  const f = fixture({ snoozedUntil: BORN + 10 * DAY + 1_000 })
  f.lifecycle.settle('ws-1', true, 'ui')
  f.stored.snoozedUntil = null
  f.advance(2_000)
  f.lifecycle.settle('ws-1', false, 'ui')
  assert.equal(f.stored.snoozedUntil ?? null, null)
})
