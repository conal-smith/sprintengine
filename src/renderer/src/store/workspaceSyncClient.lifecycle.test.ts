import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceLifecycleRequest, WorkspaceLifecycleResult } from '../../../shared/workspace-lifecycle'
import { createWorkspaceSyncClient, type WorkspaceSyncClientApi } from './workspaceSyncClient'

// A window's gesture on a chat's rest, as the sync client asks main about it:
// an answer that never comes is no answer, and a yes lost on the way back is
// still a yes.

const snapshot = { settledAt: null, settledOverride: null, snoozedUntil: null, activityAt: 1 }
const settle: WorkspaceLifecycleRequest = { workspaceId: 'w', intent: { kind: 'settle' }, snapshot }

function client(workspaceLifecycle: (request: WorkspaceLifecycleRequest) => Promise<WorkspaceLifecycleResult>) {
  const api = {
    workspaceSyncDispatch: async () => ({ ok: false, reason: 'x', message: 'x' }),
    workspaceSyncGetSnapshot: async () => ({ sequence: 0, state: {} }),
    workspaceSyncGetEventsAfter: async () => [],
    onWorkspaceSyncEvent: () => () => undefined,
    workspaceLifecycle,
  } as unknown as WorkspaceSyncClientApi
  const ignore = () => undefined
  return createWorkspaceSyncClient({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: ignore,
    applyWorkspaceMoved: ignore,
    applyWorkspaceClosed: ignore,
    applyWorkspacePlacement: ignore,
    applyWorkspaceCreated: ignore,
    applyAgentTerminalSession: ignore,
    applyAgentTerminalLaunchState: ignore,
    applyWorkspaceRenamed: ignore,
    applyWorkspaceLayoutUpdated: ignore,
    applyWorkspaceFieldsUpdated: ignore,
    applyWorkspaceAgentUpdated: ignore,
    applyWorkspaceRemoved: ignore,
    applyRegistrySnapshot: ignore,
    logDiagnostic: ignore,
    lifecycleAnswerMs: 20,
  })
}

test('a gesture main never answers is asked once more, then answered unreachable, so the chat is not held', async () => {
  let asked = 0
  const result = await client(() => {
    asked += 1
    return new Promise<WorkspaceLifecycleResult>(() => undefined)
  }).dispatchLifecycleIntent(settle)
  assert.equal(asked, 2)
  assert.equal(result.ok === false && result.code, 'unreachable')
})

test('a retry main calls stale, on a chat that already stands as asked, is the lost yes', async () => {
  const resting = { ...snapshot, settledAt: 5, settledOverride: 'settled' as const }
  let asked = 0
  const result = await client(async () => {
    asked += 1
    // The first ask lands, and its answer is lost on the way back.
    if (asked === 1) throw new Error('the reply was lost')
    return { ok: false, code: 'stale', message: 'changed', current: resting }
  }).dispatchLifecycleIntent(settle)
  assert.deepEqual(result, { ok: true, workspaceId: 'w', committed: resting })
})

test('a stale answer on a chat that does not stand as asked stays a no, and so does one on a first ask', async () => {
  const awake = { ...snapshot, settledAt: null }
  let asked = 0
  const retried = await client(async () => {
    asked += 1
    if (asked === 1) throw new Error('lost')
    return { ok: false, code: 'stale', message: 'changed', current: awake }
  }).dispatchLifecycleIntent(settle)
  assert.equal(retried.ok === false && retried.code, 'stale')

  const resting = { ...snapshot, settledAt: 5, settledOverride: 'settled' as const }
  const first = await client(async () => ({
    ok: false,
    code: 'stale',
    message: 'changed',
    current: resting,
  })).dispatchLifecycleIntent(settle)
  assert.equal(first.ok, false, 'a first ask called stale was decided on a different chat, whatever it reads now')
})
