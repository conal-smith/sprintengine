/**
 * The main-owned copy of the model-written chat titles setting. Real tmpdir,
 * no Electron and no window: this is the read main's titler makes for a chat
 * a phone started while nothing here was open.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTextGenerationSettingsStore } from './text-generation-settings-store'

const FILE_NAME = 'text-generation.json'
const MATCH_REPOSITORY = { mode: 'repository', instructions: '' }
const DEFAULT = { enabled: true, engine: null, writingStyle: MATCH_REPOSITORY }

async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-text-generation-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('with nothing pushed it reads as the window default: on, engine left to the installed CLIs', async () => {
  await withUserData(async (dir) => {
    assert.deepEqual(createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).get(), DEFAULT)
  })
})

test('a push persists and survives a fresh process', async () => {
  await withUserData(async (dir) => {
    const pushed = {
      enabled: true,
      engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
      writingStyle: MATCH_REPOSITORY,
    }
    createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).set(pushed)
    assert.deepEqual(JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8')), pushed)
    assert.deepEqual(createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).get(), pushed)
  })
})

test('turning it off is kept, and so is the engine chosen before', async () => {
  await withUserData(async (dir) => {
    const store = createTextGenerationSettingsStore({ resolveUserDataDir: () => dir })
    store.set({ enabled: false, engine: { cli: 'claude-code', model: '' } })
    assert.deepEqual(store.get(), {
      enabled: false,
      engine: { cli: 'claude-code', model: '' },
      writingStyle: MATCH_REPOSITORY,
    })
    assert.equal(createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).get().enabled, false)
  })
})

test('a push is normalized as the window normalizes it', async () => {
  await withUserData(async (dir) => {
    const store = createTextGenerationSettingsStore({ resolveUserDataDir: () => dir })
    store.set({ enabled: true, engine: { cli: '  codex ', model: ' gpt-5.6-luna ', reasoning: '  ' }, extra: 1 })
    assert.deepEqual(store.get(), {
      enabled: true,
      engine: { cli: 'codex', model: 'gpt-5.6-luna' },
      writingStyle: MATCH_REPOSITORY,
    })
  })
})

test('an unchanged push rewrites nothing and leaves no temp file', async () => {
  await withUserData(async (dir) => {
    const store = createTextGenerationSettingsStore({ resolveUserDataDir: () => dir })
    // The default pushed onto an empty directory is not a change either.
    store.set(DEFAULT)
    assert.deepEqual(await readdir(dir), [])
    store.set({ enabled: false, engine: null })
    store.set({ enabled: false, engine: null })
    assert.deepEqual(await readdir(dir), [FILE_NAME])
  })
})

test('the first push of a session compares against disk, not an unread cache', async () => {
  await withUserData(async (dir) => {
    await writeFile(join(dir, FILE_NAME), JSON.stringify({ enabled: false, engine: null }), 'utf8')
    createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).set(DEFAULT)
    assert.deepEqual(createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).get(), DEFAULT)
  })
})

test('a corrupt or wrong-shaped file reads as the default', async () => {
  for (const payload of ['{ not json', '[]', '"off"', '{"enabled":"no"}', '{}']) {
    await withUserData(async (dir) => {
      await writeFile(join(dir, FILE_NAME), payload, 'utf8')
      const store = createTextGenerationSettingsStore({ resolveUserDataDir: () => dir })
      assert.deepEqual(store.get(), DEFAULT, `payload ${payload} reads as the default`)
    })
  }
})

test('an unwritable location reports the failure and still applies in memory', async () => {
  await withUserData(async (dir) => {
    const diagnostics: string[] = []
    const store = createTextGenerationSettingsStore({
      resolveUserDataDir: () => join(dir, 'missing-parent', 'nested'),
      logDiagnostic: (input) => diagnostics.push(input.title),
    })
    store.set({ enabled: false, engine: null })
    assert.equal(store.get().enabled, false)
    assert.deepEqual(diagnostics, ['Chat title setting not saved'])
  })
})

test("main's copy keeps the writing style, and reads a missing or unknown one as the default", async () => {
  await withUserData(async (dir) => {
    const store = createTextGenerationSettingsStore({ resolveUserDataDir: () => dir })
    store.set({ enabled: true, engine: null, writingStyle: { mode: 'custom', instructions: 'Past tense.' } })
    assert.deepEqual(createTextGenerationSettingsStore({ resolveUserDataDir: () => dir }).get().writingStyle, {
      mode: 'custom',
      instructions: 'Past tense.',
    })
    store.set({ enabled: true, engine: null, writingStyle: { mode: 'emoji', instructions: 'x'.repeat(3_000) } })
    assert.deepEqual(store.get().writingStyle, { mode: 'repository', instructions: 'x'.repeat(2_000) })
  })
})
