import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import type { CliModelDiscoveryInput, CliModelDiscoveryResult } from '../../../shared/ipc/cli-model-discovery'
import type { AppSettings } from '../types/workspace'
import { forceCliModelRefresh, startCliModelDiscovery } from './cliModelDiscovery'

const CATALOG: DiscoveredCliModelCatalog = {
  models: [{ id: 'opus[1m]', displayName: 'Opus (1M context)', firstSeenAt: '2026-09-22T10:00:00.000Z' }],
  fetchedAt: '2026-09-22T10:00:00.000Z',
  source: 'agent-sdk',
  cliVersion: '2.1.280 (Claude Code)',
}

const result = (entries: CliModelDiscoveryResult['entries']): CliModelDiscoveryResult => ({
  entries,
  startedAt: '2026-09-22T10:00:00.000Z',
  finishedAt: '2026-09-22T10:00:01.000Z',
})

function fakeStore(appSettings: Pick<AppSettings, 'cliModelCatalog' | 'cliRuntimes'>) {
  const writes: Array<[string, DiscoveredCliModelCatalog | null]> = []
  return {
    writes,
    getState: () => ({
      appSettings,
      setCliModelCatalog: (cli: string, catalog: DiscoveredCliModelCatalog | null) => void writes.push([cli, catalog]),
    }),
  }
}

function fakeApi(answer: (input?: CliModelDiscoveryInput) => Promise<CliModelDiscoveryResult>) {
  const listeners = new Set<(result: CliModelDiscoveryResult) => void>()
  const inputs: Array<CliModelDiscoveryInput | undefined> = []
  return {
    inputs,
    listeners,
    push: (value: CliModelDiscoveryResult) => listeners.forEach((listener) => listener(value)),
    cliModelsDiscover: (input?: CliModelDiscoveryInput) => {
      inputs.push(input)
      return answer(input)
    },
    onCliModelsChanged: (cb: (value: CliModelDiscoveryResult) => void) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}

const RUNTIMES = { codex: { command: 'codex' } } as unknown as AppSettings['cliRuntimes']

test('a pushed catalog is stored; a skipped or failed entry changes nothing', () => {
  const store = fakeStore({ cliRuntimes: RUNTIMES })
  const api = fakeApi(async () => result([]))
  const handle = startCliModelDiscovery(store, api)
  api.push(
    result([
      { cli: 'claude-code', catalog: CATALOG },
      { cli: 'codex', catalog: null, error: 'Codex did not print its model list as JSON.' },
      { cli: 'grok', catalog: null, skipped: 'not-installed' },
    ]),
  )
  assert.deepEqual(store.writes, [['claude-code', CATALOG]])
  handle.stop()
  assert.equal(api.listeners.size, 0, 'stop lets go of the subscription')
  api.push(result([{ cli: 'claude-code', catalog: CATALOG }]))
  assert.equal(store.writes.length, 1)
})

test('refresh sends what the store holds and applies the answer', async () => {
  const held = { 'claude-code': { ...CATALOG, fetchedAt: '2026-09-21T10:00:00.000Z' } }
  const store = fakeStore({ cliRuntimes: RUNTIMES, cliModelCatalog: held })
  const api = fakeApi(async () =>
    result([
      { cli: 'claude-code', catalog: CATALOG, skipped: 'fresh' },
      { cli: 'kimi-code', catalog: null, skipped: 'no-probe' },
    ]),
  )
  const { refreshCliModels } = startCliModelDiscovery(store, api)
  const answer = await refreshCliModels({ force: true })
  assert.deepEqual(api.inputs, [{ cliRuntimes: RUNTIMES, previous: held, force: true }])
  assert.equal(answer?.entries.length, 2)
  assert.deepEqual(store.writes, [['claude-code', CATALOG]])

  await refreshCliModels({ clis: ['codex'] })
  assert.deepEqual(api.inputs[1], { cliRuntimes: RUNTIMES, previous: held, clis: ['codex'] })
})

test('no bridge, or a bridge that fails, leaves the store alone', async () => {
  const store = fakeStore({ cliRuntimes: RUNTIMES })
  assert.equal(await startCliModelDiscovery(store, null).refreshCliModels(), null)
  const failing = fakeApi(async () => Promise.reject(new Error('no handler registered')))
  assert.equal(await startCliModelDiscovery(store, failing).refreshCliModels(), null)
  assert.deepEqual(store.writes, [])
})

function fakeActivity() {
  let focused = true
  const listeners = new Set<(state: { visible: boolean; focused: boolean }) => void>()
  return {
    get: () => ({ visible: true, focused }),
    subscribe: (listener: (state: { visible: boolean; focused: boolean }) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set: (next: boolean) => {
      focused = next
      for (const listener of listeners) listener({ visible: true, focused })
    },
    listeners,
  }
}

test('Re-check asks every CLI again, whatever is cached, and stores what comes back', async () => {
  const store = fakeStore({ cliModelCatalog: { codex: CATALOG }, cliRuntimes: {} })
  const api = fakeApi(async () => result([{ cli: 'codex', catalog: CATALOG }]))
  await forceCliModelRefresh(store, api)
  assert.equal(api.inputs[0]?.force, true)
  assert.deepEqual(api.inputs[0]?.previous, { codex: CATALOG })
  assert.deepEqual(store.writes, [['codex', CATALOG]])
})

test('coming back to the window asks again, at most once in a while, and stop lets go', async () => {
  const store = fakeStore({ cliModelCatalog: {}, cliRuntimes: {} })
  const api = fakeApi(async () => result([]))
  const activity = fakeActivity()
  let clock = 0
  const handle = startCliModelDiscovery(store, api, activity, () => clock)

  activity.set(false)
  activity.set(true)
  assert.equal(api.inputs.length, 0, 'it has only just asked')

  clock += 6 * 60 * 1000
  activity.set(false)
  assert.equal(api.inputs.length, 0, 'leaving the window asks nothing')
  activity.set(true)
  assert.equal(api.inputs.length, 1)
  assert.equal(api.inputs[0]?.force, undefined, 'main answers from its cache while the catalog is fresh')

  handle.stop()
  assert.equal(activity.listeners.size, 0)
})
