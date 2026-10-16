import assert from 'node:assert/strict'
import { workspaceStorePath } from '../workspace-store'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { createModuleStorageRegistry, type ModuleStorageChange, type ModuleStorageRegistry } from './module-storage'

// Module storage beyond one key at a time: a prefix-filtered list, a batch
// read, a change signal that covers a `git pull` as well as the module's own
// writes, and the module's private directory for data past the value limit.

let temp = ''
let userData = ''
let workspaceRoot = ''
let storage: ModuleStorageRegistry

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'module-storage-query-'))
  userData = join(temp, 'user-data')
  workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  storage = createModuleStorageRegistry({ userDataDir: () => userData, watchIntervalMs: 20 })
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('list takes a prefix and keeps the keys sorted', async () => {
  for (const key of ['decision.002', 'handoff.001', 'decision.001', 'index']) {
    await storage.set('decision-log', { key, value: key, workspaceRoot })
  }
  assert.deepEqual(await storage.list('decision-log', { workspaceRoot, prefix: 'decision.' }), {
    ok: true,
    keys: ['decision.001', 'decision.002'],
  })
  assert.deepEqual(await storage.list('decision-log', { workspaceRoot, prefix: 'nothing' }), { ok: true, keys: [] })
  assert.deepEqual(await storage.list('decision-log', { workspaceRoot }), {
    ok: true,
    keys: ['decision.001', 'decision.002', 'handoff.001', 'index'],
  })
})

test('getMany returns the keys that are set and leaves the rest out', async () => {
  await storage.set('decision-log', { key: 'a', value: { n: 1 }, workspaceRoot })
  await storage.set('decision-log', { key: 'b', value: [2], workspaceRoot })
  assert.deepEqual(await storage.getMany('decision-log', { keys: ['a', 'b', 'never', 'a'], workspaceRoot }), {
    ok: true,
    values: { a: { n: 1 }, b: [2] },
  })
})

test('getMany refuses an invalid key and fails loudly on a corrupt record', async () => {
  const invalid = await storage.getMany('decision-log', { keys: ['ok', '../escape'] })
  assert.equal(invalid.ok === false && invalid.code, 'invalid_key')
  const notArray = await storage.getMany('decision-log', { keys: 'a' as never })
  assert.equal(notArray.ok === false && notArray.code, 'invalid_key')

  await storage.set('decision-log', { key: 'good', value: 1 })
  await writeFile(join(userData, 'module-storage', 'decision-log', 'bad.json'), '{ not json')
  const corrupt = await storage.getMany('decision-log', { keys: ['good', 'bad'] })
  assert.equal(corrupt.ok === false && corrupt.code, 'io_error')
  assert.match(corrupt.ok === false ? corrupt.message : '', /"bad"/)
})

test("a watch hears the module's own writes and deletes at once", async () => {
  const changes: ModuleStorageChange[] = []
  const stop = storage.watch('decision-log', { workspaceRoot }, (change) => changes.push(change))
  try {
    await storage.set('decision-log', { key: 'decision.001', value: 'x', workspaceRoot })
    assert.deepEqual(changes, [{ keys: ['decision.001'] }])
    await storage.delete('decision-log', { key: 'decision.001', workspaceRoot })
    assert.deepEqual(changes, [{ keys: ['decision.001'] }, { keys: ['decision.001'] }])
    // Another scope's write is not this watch's business.
    await storage.set('decision-log', { key: 'global', value: 1 })
    await storage.set('other-module', { key: 'decision.001', value: 1, workspaceRoot })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(changes.length, 2)
  } finally {
    stop()
  }
})

test('a watch hears a change made outside the registry, such as another window’s', async () => {
  await storage.set('decision-log', { key: 'decision.001', value: 'first', workspaceRoot })
  const changes: ModuleStorageChange[] = []
  const stop = storage.watch('decision-log', { workspaceRoot }, (change) => changes.push(change))
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const folder = workspaceStorePath(workspaceRoot, 'modules', 'decision-log')
    await writeFile(join(folder, 'decision.002.json'), '"pulled"')
    await rm(join(folder, 'decision.001.json'))
    await waitFor(() => changes.some((change) => change.keys.includes('decision.002')))
    await waitFor(() => changes.flatMap((change) => change.keys).includes('decision.001'))
  } finally {
    stop()
  }
})

test('after unsubscribing nothing more is heard', async () => {
  const listener = vi.fn()
  const stop = storage.watch('decision-log', {}, listener)
  stop()
  await storage.set('decision-log', { key: 'a', value: 1 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(listener.mock.calls.length, 0)
})

test('a watch on a relative workspace root throws', () => {
  assert.throws(() => storage.watch('decision-log', { workspaceRoot: 'relative/path' }, () => {}), /absolute/)
})

test('the data directory is per module, under user data, and created on demand', () => {
  const dir = storage.dataDir('insights')
  assert.equal(dir, join(userData, 'module-data', 'insights'))
  assert.equal(existsSync(dir), true)
  assert.throws(() => storage.dataDir('../escape'), /not usable/)
})
