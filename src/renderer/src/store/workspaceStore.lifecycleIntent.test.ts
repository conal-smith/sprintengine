import assert from 'node:assert/strict'
import { beforeAll, test } from 'vitest'

import type { Workspace, WorkspaceWindowState } from '../types/workspace'
import type { WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import type {
  WorkspaceLifecycleRequest,
  WorkspaceLifecycleResult,
  WorkspaceLifecycleSnapshot,
} from '../../../shared/workspace-lifecycle'

// A window's Settle and Snooze land here at once and go to main as the gesture
// they are, with the reading of the chat they were made on. A refusal names
// the chat as main has it, and the row goes back there.

const asked: WorkspaceLifecycleRequest[] = []
const resting: WorkspaceLifecycleSnapshot = {
  settledAt: 6_000,
  settledOverride: 'settled',
  snoozedUntil: null,
  activityAt: 500,
}
let answer: (request: WorkspaceLifecycleRequest) => WorkspaceLifecycleResult = (request) => ({
  ok: true,
  workspaceId: request.workspaceId,
  committed: resting,
})
const dispatched: string[] = []
let store: typeof import('./workspaceStore')

function windowState(): WorkspaceWindowState {
  return {
    id: 'A',
    kind: 'primary',
    workspaceIds: ['ws-1', 'ws-2'],
    activeWorkspaceId: 'ws-2',
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 1,
    lastFocusedAt: 1,
  }
}

function workspace(id: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, name: id, folderPath: null, agents: {}, createdAt: 1, ...extra } as unknown as Workspace
}

const row = (id: string) => store.useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!

beforeAll(async () => {
  const stored: Record<string, string> = {}
  const localStorageMock = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value
    },
    removeItem: (key: string) => {
      delete stored[key]
    },
  }
  const snapshot: WorkspaceSyncSnapshot = {
    sequence: 0,
    state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'A', workspaceWindows: [] },
  }
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { href: 'http://localhost/?windowId=A' },
      localStorage: localStorageMock,
      api: {
        workspaceSyncDispatch: (command: { type: string }) => {
          dispatched.push(command.type)
          return Promise.resolve({ ok: false as const, reason: 'unseeded', message: 'unseeded' })
        },
        workspaceSyncGetSnapshot: () => Promise.resolve(snapshot),
        workspaceSyncGetEventsAfter: () => Promise.resolve([]),
        onWorkspaceSyncEvent: (_cb: (event: WorkspaceSyncEvent) => void) => () => undefined,
        workspaceLifecycle: async (request: WorkspaceLifecycleRequest) => {
          asked.push(request)
          return answer(request)
        },
      },
      addEventListener: () => {},
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })
  store = await import('./workspaceStore')
  await store.__workspaceStoreBackupRecoveryPromise
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  store.useWorkspaceStore.setState({
    workspaces: [workspace('ws-1', { lastTerminalActivityAt: 500, lastUserMessageAt: 400 }), workspace('ws-2')],
    activeWorkspaceId: 'ws-2',
    primaryWorkspaceWindowId: 'A',
    workspaceWindows: [windowState()],
    workspaceRegistryEmptyState: null,
  })
})

test('a Settle applies at once and asks main with the reading it was made on, never as a field patch', async () => {
  asked.length = 0
  dispatched.length = 0
  const settling = store.useWorkspaceStore.getState().setWorkspaceSettled('ws-1', true)
  assert.equal(typeof row('ws-1').settledAt, 'number', 'the row moves before main answers')
  assert.deepEqual(await settling, { ok: true, workspaceId: 'ws-1', committed: resting })
  assert.equal(row('ws-1').settledAt, 6_000, 'the row takes main’s stamp, so the next gesture is made on it')
  const expected: WorkspaceLifecycleSnapshot = {
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    activityAt: 500,
  }
  assert.deepEqual(asked, [{ workspaceId: 'ws-1', snapshot: expected, intent: { kind: 'settle', lastInputAt: 500 } }])
  assert.equal(dispatched.includes('workspace.update_fields'), false, 'the rest is main’s to write')
})

test('a refused Un-settle puts the row back where main has it', async () => {
  const current: WorkspaceLifecycleSnapshot = {
    settledAt: 7_000,
    settledOverride: 'settled',
    snoozedUntil: null,
    activityAt: 500,
  }
  answer = () => ({ ok: false, code: 'stale', message: 'changed', current })
  const unsettling = store.useWorkspaceStore.getState().setWorkspaceSettled('ws-1', false)
  assert.equal(row('ws-1').settledAt, null, 'applied at once')
  const result = await unsettling
  assert.equal(result?.ok, false)
  assert.equal(row('ws-1').settledAt, 7_000, 'and back to main’s rest once main says no')
  assert.equal(row('ws-1').settledOverride, 'settled')
})

test('a Snooze goes to main as a snooze, and a refusal for an agent at work wakes the row again', async () => {
  asked.length = 0
  const wakeAt = Date.now() + 3_600_000
  answer = () => ({
    ok: false,
    code: 'working',
    message: 'still working',
    current: { settledAt: null, settledOverride: null, snoozedUntil: null, activityAt: 1 },
  })
  const snoozing = store.useWorkspaceStore.getState().setWorkspaceSnoozed('ws-2', wakeAt)
  assert.equal(row('ws-2').snoozedUntil, wakeAt)
  await snoozing
  assert.deepEqual(asked[0]?.intent, { kind: 'snooze', until: wakeAt })
  assert.equal(row('ws-2').snoozedUntil, null, 'the snooze main refused is taken back')
})

test('a quick Un-settle after a Settle is sent on the reading main answered the Settle with', async () => {
  asked.length = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const mainStamp: WorkspaceLifecycleSnapshot = {
    settledAt: 9_999,
    settledOverride: 'settled',
    snoozedUntil: null,
    activityAt: 500,
  }
  // Main's clock stamps the Settle differently from the window's.
  answer = (request) =>
    request.intent.kind === 'settle'
      ? { ok: true, workspaceId: request.workspaceId, committed: mainStamp }
      : {
          ok: true,
          workspaceId: request.workspaceId,
          committed: { settledAt: null, settledOverride: 'active', snoozedUntil: null, activityAt: 500 },
        }
  const api = (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api
  const realLifecycle = api.workspaceLifecycle as (request: WorkspaceLifecycleRequest) => Promise<unknown>
  api.workspaceLifecycle = async (request: WorkspaceLifecycleRequest) => {
    if (request.intent.kind === 'settle') await gate
    return realLifecycle(request)
  }
  try {
    const settling = store.useWorkspaceStore.getState().setWorkspaceSettled('ws-2', true)
    const unsettling = store.useWorkspaceStore.getState().setWorkspaceSettled('ws-2', false)
    assert.equal(row('ws-2').settledAt, null, 'the row reads the last gesture at once')
    release()
    await settling
    assert.equal(row('ws-2').settledAt, null, 'the first answer does not drag the row back meanwhile')
    await unsettling
    assert.deepEqual(asked[1]?.snapshot, mainStamp, 'the Un-settle is made on main’s stamp, not the window’s')
    assert.equal(row('ws-2').settledOverride, 'active')
  } finally {
    api.workspaceLifecycle = realLifecycle
  }
})

test('a gesture that could not reach main puts the row back where it was', async () => {
  const api = (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api
  const realLifecycle = api.workspaceLifecycle
  let calls = 0
  api.workspaceLifecycle = async () => {
    calls += 1
    throw new Error('the server is restarting')
  }
  try {
    const before = row('ws-1').settledAt
    const result = await store.useWorkspaceStore.getState().setWorkspaceSettled('ws-1', before === null)
    assert.equal(result?.ok === false && result.code, 'unreachable')
    assert.equal(calls, 2, 'asked once more before giving up')
    assert.equal(row('ws-1').settledAt, before, 'the row is where it was before the gesture')
  } finally {
    api.workspaceLifecycle = realLifecycle
  }
})
