import assert from 'node:assert/strict'
import { beforeAll, test } from 'vitest'

import type { Workspace, WorkspaceWindowState } from '../types/workspace'
import type { WorkspaceFieldsPatch, WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import { takeWorkspacesSettledElsewhere, takeWorkspacesSnoozedElsewhere } from '../utils/settledElsewhere'

// What reaches this window from a Settle or a Snooze made somewhere else, and
// what this window says when a chat is on screen in it or is starred here.

const broadcastListeners: Array<(event: WorkspaceSyncEvent) => void> = []
const dispatched: Array<{ type: string; payload: Record<string, unknown> }> = []
let sequence = 0
let store: typeof import('./workspaceStore')

function windowState(): WorkspaceWindowState {
  return {
    id: 'A',
    kind: 'primary',
    workspaceIds: ['ws-open', 'ws-resting'],
    activeWorkspaceId: 'ws-open',
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

/** One field patch over the bus, as main broadcasts one, applied before this resolves. */
async function arrive(workspaceId: string, patch: WorkspaceFieldsPatch): Promise<void> {
  sequence += 1
  for (const listener of broadcastListeners)
    listener({
      id: `workspace-sync-${sequence}`,
      type: 'workspace.fields_updated',
      sourceWindowId: 'primary',
      sequence,
      createdAt: 1_000 + sequence,
      payload: { workspaceId, patch, editedAt: 1_000 + sequence },
    })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

beforeAll(async () => {
  const stored: Record<string, string> = { 'sprintengine.workspaceStorageLiveSync': '1' }
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
        workspaceSyncDispatch: (command: { type: string; payload: Record<string, unknown> }) => {
          dispatched.push(command)
          return Promise.resolve({ ok: false as const, reason: 'unseeded', message: 'unseeded' })
        },
        workspaceSyncGetSnapshot: () => Promise.resolve(snapshot),
        workspaceSyncGetEventsAfter: () => Promise.resolve([]),
        onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => {
          broadcastListeners.push(cb)
          return () => undefined
        },
      },
      addEventListener: () => {},
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })
  store = await import('./workspaceStore')
  await store.__workspaceStoreBackupRecoveryPromise
  store.useWorkspaceStore.setState({
    workspaces: [workspace('ws-open'), workspace('ws-resting', { settledAt: 10, settledOverride: 'settled' })],
    activeWorkspaceId: 'ws-open',
    primaryWorkspaceWindowId: 'A',
    workspaceWindows: [windowState()],
    workspaceRegistryEmptyState: null,
  })
  assert.ok(broadcastListeners.length > 0, 'the sync client listens from store init')
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  takeWorkspacesSettledElsewhere()
})

test('a chat settled through a patch from elsewhere is noted for the sidebar to finish the Settle', async () => {
  await arrive('ws-open', { settledAt: 2_000, settledOverride: 'settled', snoozedUntil: null })
  assert.equal(store.useWorkspaceStore.getState().workspaces.find((w) => w.id === 'ws-open')?.settledAt, 2_000)
  assert.deepEqual(takeWorkspacesSettledElsewhere(), ['ws-open'])
  assert.deepEqual(takeWorkspacesSettledElsewhere(), [], 'each note is taken once')
})

test('a patch that settles nothing new is not noted', async () => {
  await arrive('ws-resting', { settledAt: 3_000, settledOverride: 'settled' })
  await arrive('ws-resting', { lastVisitedAt: 3_100 })
  assert.deepEqual(takeWorkspacesSettledElsewhere(), [])
})

test('a visit here moves the visit clock forward only, and tells main', () => {
  dispatched.length = 0
  const { recordWorkspaceVisit } = store.useWorkspaceStore.getState()
  recordWorkspaceVisit('ws-resting', 5_000)
  recordWorkspaceVisit('ws-resting', 4_000)
  const resting = store.useWorkspaceStore.getState().workspaces.find((w) => w.id === 'ws-resting')
  assert.equal(resting?.lastVisitedAt, 5_000)
  assert.equal(resting?.settledAt, 3_000, 'a visit is not activity: a settled chat stays settled')
  const visits = dispatched.filter((command) => command.type === 'workspace.update_fields')
  assert.deepEqual(
    visits.map((command) => command.payload.patch),
    [{ lastVisitedAt: 5_000 }],
  )
})

test('a chat snoozed through a patch from elsewhere is noted for the sidebar to pause, once', async () => {
  takeWorkspacesSnoozedElsewhere()
  const wake = Date.now() + 3_600_000
  await arrive('ws-open', { settledAt: null, settledOverride: 'active' })
  await arrive('ws-open', { snoozedUntil: wake })
  assert.equal(store.useWorkspaceStore.getState().workspaces.find((w) => w.id === 'ws-open')?.snoozedUntil, wake)
  assert.deepEqual(takeWorkspacesSnoozedElsewhere(), ['ws-open'])
  await arrive('ws-open', { snoozedUntil: wake + 1 })
  assert.deepEqual(takeWorkspacesSnoozedElsewhere(), [], 'a chat already asleep is not paused again')
  await arrive('ws-open', { snoozedUntil: null })
  assert.deepEqual(takeWorkspacesSnoozedElsewhere(), [], 'a wake is not a snooze')
})

test('a star and a colour set here are told to main, as every hand-edited field is', () => {
  dispatched.length = 0
  const { setWorkspaceHighlight, clearWorkspaceHighlight } = store.useWorkspaceStore.getState()
  setWorkspaceHighlight('ws-open', { starred: true })
  setWorkspaceHighlight('ws-open', { color: 'green' })
  clearWorkspaceHighlight('ws-open')
  const patches = dispatched
    .filter((command) => command.type === 'workspace.update_fields')
    .map((command) => command.payload.patch)
  assert.deepEqual(patches, [
    { highlight: { starred: true, color: null } },
    { highlight: { starred: true, color: 'green' } },
    { highlight: null },
  ])
})
