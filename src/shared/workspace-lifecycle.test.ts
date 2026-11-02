import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../renderer/src/types/workspace'
import {
  lifecycleSnapshotIsStale,
  parseWorkspaceLifecycleRequest,
  parseWorkspaceLifecycleSnapshot,
  workspaceLifecycleSnapshot,
} from './workspace-lifecycle'

const NOW = 1_000_000_000_000
const HOUR = 60 * 60 * 1000

const chat = (fields: Partial<Workspace> = {}) => ({ id: 'w', createdAt: NOW - 10 * HOUR, ...fields }) as Workspace

test('a snapshot is stale once the rest, the sleep or the activity has moved past it', () => {
  const before = chat({ lastTurnEndedAt: NOW - HOUR })
  const snapshot = workspaceLifecycleSnapshot(before)
  assert.equal(lifecycleSnapshotIsStale(before, snapshot), false, 'the chat it was taken of')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, settledAt: NOW }), snapshot), true, 'settled since')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, snoozedUntil: NOW + HOUR }), snapshot), true, 'snoozed')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, settledOverride: 'active' }), snapshot), true)
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, lastUserMessageAt: NOW }), snapshot), true, 'a message')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, lastTurnEndedAt: NOW }), snapshot), true, 'a turn end')
  // A reading that knows more than the record (a window ahead of main on the
  // keystroke clock) is current.
  assert.equal(lifecycleSnapshotIsStale(before, { ...snapshot, activityAt: NOW }), false)
  // Absent and null read alike.
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, settledAt: null }), snapshot), false)
})

test('a snapshot and a request from across a process boundary are parsed, and junk refused', () => {
  const snapshot = workspaceLifecycleSnapshot(chat({ snoozedUntil: NOW + HOUR }))
  assert.deepEqual(parseWorkspaceLifecycleSnapshot(snapshot), snapshot)
  assert.equal(parseWorkspaceLifecycleSnapshot({ ...snapshot, activityAt: 'soon' }), null)
  assert.equal(parseWorkspaceLifecycleSnapshot({ ...snapshot, settledOverride: 'maybe' }), null)
  assert.equal(parseWorkspaceLifecycleSnapshot(null), null)
  assert.deepEqual(parseWorkspaceLifecycleRequest({ workspaceId: ' w ', intent: { kind: 'wake' }, snapshot }), {
    workspaceId: 'w',
    intent: { kind: 'wake' },
    snapshot,
  })
  assert.equal(parseWorkspaceLifecycleRequest({ workspaceId: 'w', intent: { kind: 'snooze' }, snapshot }), null)
  assert.equal(parseWorkspaceLifecycleRequest({ workspaceId: 'w', intent: { kind: 'delete' }, snapshot }), null)
  assert.equal(parseWorkspaceLifecycleRequest({ workspaceId: '', intent: { kind: 'wake' }, snapshot }), null)
})
