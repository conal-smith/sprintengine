import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MODULE_STORAGE_VALUE_LIMIT_BYTES, createModuleStorageRegistry } from './module-storage'
import { workspaceStorePath } from '../workspace-store'
import { test } from 'vitest'

test('module-storage', async () => {
  // The per-module storage contract: host-owned placement (the project's store
  // vs per-user data), module-scoped isolation by construction, locked-down keys,
  // JSON-only values with a size cap, atomic writes, and honest errors — a
  // corrupt record reads as io_error, never as silently missing.

  async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'module-storage-'))
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function main(): Promise<void> {
    await withTempDir(async (temp) => {
      const userData = join(temp, 'user-data')
      const workspaceRoot = join(temp, 'workspace')
      await mkdir(workspaceRoot, { recursive: true })
      const storage = createModuleStorageRegistry({ userDataDir: () => userData })

      // Missing key: found false, ok true — absence is not an error.
      assert.deepEqual(await storage.get('calendar', { key: 'events' }), { ok: true, value: undefined, found: false })

      // Global set/get round-trip lands under <userData>/module-storage/<moduleId>/.
      const globalValue = { theme: 'caramel', hours: [9, 17] }
      assert.deepEqual(await storage.set('calendar', { key: 'prefs', value: globalValue }), { ok: true })
      assert.deepEqual(await storage.get('calendar', { key: 'prefs' }), { ok: true, value: globalValue, found: true })
      assert.equal(existsSync(join(userData, 'module-storage', 'calendar', 'prefs.json')), true)

      // Workspace-scoped keys land in the project's store in the home folder,
      // `<store>/modules/<id>/`, and nothing lands in the project itself.
      assert.deepEqual(await storage.set('calendar', { key: 'events', value: [{ id: 'ev-1' }], workspaceRoot }), {
        ok: true,
      })
      assert.equal(existsSync(workspaceStorePath(workspaceRoot, 'modules', 'calendar', 'events.json')), true)
      assert.deepEqual(await readdir(workspaceRoot), [])
      assert.deepEqual(await storage.get('calendar', { key: 'events', workspaceRoot }), {
        ok: true,
        value: [{ id: 'ev-1' }],
        found: true,
      })
      // The two scopes are distinct namespaces for the same key.
      assert.deepEqual(await storage.get('calendar', { key: 'prefs', workspaceRoot }), {
        ok: true,
        value: undefined,
        found: false,
      })

      // Module isolation is by construction: another module never sees the keys.
      assert.deepEqual(await storage.list('planner', { workspaceRoot }), { ok: true, keys: [] })
      assert.deepEqual(await storage.list('calendar', { workspaceRoot }), { ok: true, keys: ['events'] })
      assert.deepEqual(await storage.list('calendar'), { ok: true, keys: ['prefs'] })

      // Key validation: separators, traversal, uppercase, leading dot all refuse.
      for (const key of ['../escape', 'a/b', 'UPPER', '.hidden', '', 'x'.repeat(65), 'con', 'nul.backup', 'com1']) {
        const result = await storage.set('calendar', { key, value: 1 })
        assert.equal(result.ok, false)
        if (!result.ok) assert.equal(result.code, 'invalid_key')
      }

      // Value validation: undefined and circular values refuse as invalid_value.
      const missing = await storage.set('calendar', { key: 'bad', value: undefined })
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.code, 'invalid_value')
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const cyclic = await storage.set('calendar', { key: 'bad', value: circular })
      assert.equal(cyclic.ok, false)
      if (!cyclic.ok) assert.equal(cyclic.code, 'invalid_value')

      // Size cap: 1 MB of serialized JSON is the ceiling.
      const oversized = await storage.set('calendar', {
        key: 'big',
        value: 'x'.repeat(MODULE_STORAGE_VALUE_LIMIT_BYTES),
      })
      assert.equal(oversized.ok, false)
      if (!oversized.ok) assert.equal(oversized.code, 'value_too_large')

      // Relative workspaceRoot refuses with a named cause.
      const relative = await storage.set('calendar', { key: 'events', value: [], workspaceRoot: 'relative/path' })
      assert.equal(relative.ok, false)
      if (!relative.ok) assert.equal(relative.code, 'invalid_workspace_root')

      // A corrupt record is an explicit io_error, never silently missing.
      await writeFile(join(userData, 'module-storage', 'calendar', 'prefs.json'), '{not json', 'utf8')
      const corrupt = await storage.get('calendar', { key: 'prefs' })
      assert.equal(corrupt.ok, false)
      if (!corrupt.ok) assert.equal(corrupt.code, 'io_error')

      // Atomic write discipline: a successful set never leaves the .tmp behind
      // and overwrites in place.
      assert.deepEqual(await storage.set('calendar', { key: 'prefs', value: 'fresh' }), { ok: true })
      assert.equal(existsSync(join(userData, 'module-storage', 'calendar', 'prefs.json.tmp')), false)
      assert.deepEqual(await storage.get('calendar', { key: 'prefs' }), { ok: true, value: 'fresh', found: true })
      assert.equal(await readFile(join(userData, 'module-storage', 'calendar', 'prefs.json'), 'utf8'), '"fresh"')

      // Delete: reports whether anything was removed; the key then reads absent.
      assert.deepEqual(await storage.delete('calendar', { key: 'prefs' }), { ok: true, deleted: true })
      assert.deepEqual(await storage.delete('calendar', { key: 'prefs' }), { ok: true, deleted: false })
      assert.deepEqual(await storage.get('calendar', { key: 'prefs' }), { ok: true, value: undefined, found: false })

      // What an older build kept in the project's `.sprintengine/modules/`, and
      // the move left there (a file git tracks), is not read: the store is.
      const planted = join(workspaceRoot, '.sprintengine', 'modules', 'calendar')
      await mkdir(planted, { recursive: true })
      await writeFile(join(planted, 'notes.json'), '"committed"')
      assert.deepEqual(await storage.get('calendar', { key: 'notes', workspaceRoot }), {
        ok: true,
        value: undefined,
        found: false,
      })
      assert.deepEqual(await storage.set('calendar', { key: 'notes', value: 'mine', workspaceRoot }), { ok: true })
      assert.equal(await readFile(join(planted, 'notes.json'), 'utf8'), '"committed"')

      // Concurrent sets serialize — last write wins, file stays valid JSON.
      await Promise.all(Array.from({ length: 8 }, (_, index) => storage.set('calendar', { key: 'race', value: index })))
      const settled = await storage.get('calendar', { key: 'race' })
      assert.equal(settled.ok, true)
      if (settled.ok) assert.equal(typeof settled.value, 'number')
    })

    console.log('module-storage tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
