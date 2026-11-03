import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

// The module run states a window pushes to main: nothing before the
// third-party modules have loaded, only module chats, and a burst of store
// changes as one reading.

const loadedListeners = new Set<() => void>()
vi.mock('../modules', () => ({
  onThirdPartyRendererModulesLoaded: (listener: () => void) => {
    loadedListeners.add(listener)
    return () => loadedListeners.delete(listener)
  },
}))
vi.mock('./workspaceRunGlyph', () => ({
  deriveWorkspaceRunGlyph: (workspace: { id: string }) =>
    workspace.id === 'running' ? { state: 'in_progress', live: true, label: 'Running' } : null,
}))
let workspaces: Array<{ id: string; mode: string }> = []
const storeListeners = new Set<(state: unknown, previous: unknown) => void>()
vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspaces }),
    subscribe: (listener: (state: unknown, previous: unknown) => void) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
  },
}))

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

test('nothing is pushed before the modules load; then module chats only, a burst as one reading', async () => {
  vi.useFakeTimers()
  const pushes: unknown[] = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { setModuleRunStates: async (states: unknown) => void pushes.push(states) },
  }
  const { initModuleRunStateSync } = await import('./moduleRunStateSync')
  workspaces = [
    { id: 'plain', mode: 'standard' },
    { id: 'running', mode: 'probe-type' },
    { id: 'quiet', mode: 'probe-type' },
  ]
  const stop = initModuleRunStateSync()
  assert.deepEqual(pushes, [], 'a provider not loaded yet would read every run as none')
  for (const listener of loadedListeners) listener()
  assert.deepEqual(pushes, [{ running: 'in_progress', quiet: null }], 'standard chats are not module chats')

  const before = { workspaces }
  workspaces = [...workspaces, { id: 'later', mode: 'probe-type' }]
  for (let i = 0; i < 5; i += 1) for (const listener of storeListeners) listener({ workspaces }, before)
  assert.equal(pushes.length, 1, 'gathered, not pushed per change')
  vi.advanceTimersByTime(600)
  assert.equal(pushes.length, 2)
  assert.deepEqual(pushes[1], { running: 'in_progress', quiet: null, later: null })
  vi.advanceTimersByTime(30_000)
  assert.equal(pushes.length, 2, 'an unchanged reading is not sent again')
  stop()
})
