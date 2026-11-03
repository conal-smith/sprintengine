/**
 * The main-owned copy of Settings ▸ Settled chats. Real tmpdir, no Electron and
 * no window: this is the read main's rest sweep makes with nothing open.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createSettledChatsSettingsStore } from './settled-chats-settings-store'

const DEFAULT = { settleOnPullRequestMerge: true, keepChatsWithOpenPullRequest: true, autoSettleAfterDays: 3 }

async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-settled-chats-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('with nothing pushed it reads as the window defaults', async () => {
  await withUserData(async (dir) => {
    assert.deepEqual(createSettledChatsSettingsStore({ resolveUserDataDir: () => dir }).get(), DEFAULT)
  })
})

test('an unreadable file reads as the defaults too', async () => {
  await withUserData(async (dir) => {
    await writeFile(join(dir, 'settled-chats.json'), '{ not json')
    assert.deepEqual(createSettledChatsSettingsStore({ resolveUserDataDir: () => dir }).get(), DEFAULT)
  })
})

test('a push persists, normalized, survives a fresh process, and tells its listeners once', async () => {
  await withUserData(async (dir) => {
    const store = createSettledChatsSettingsStore({ resolveUserDataDir: () => dir })
    let heard = 0
    store.subscribe(() => {
      heard += 1
    })
    store.set({ settleOnPullRequestMerge: false, keepChatsWithOpenPullRequest: false, autoSettleAfterDays: 400 })
    const expected = { settleOnPullRequestMerge: false, keepChatsWithOpenPullRequest: false, autoSettleAfterDays: 90 }
    assert.deepEqual(store.get(), expected, 'out-of-range days are brought into range')
    assert.equal(heard, 1)
    store.set(expected)
    assert.equal(heard, 1, 'an unchanged push tells nobody')
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'settled-chats.json'), 'utf8')), expected)
    assert.deepEqual(createSettledChatsSettingsStore({ resolveUserDataDir: () => dir }).get(), expected)
  })
})

test('defaults read from no file are not the person’s choice until a window pushes, even the defaults', async () => {
  await withUserData(async (dir) => {
    const store = createSettledChatsSettingsStore({ resolveUserDataDir: () => dir })
    let heard = 0
    store.subscribe(() => {
      heard += 1
    })
    assert.equal(store.known(), false, 'no file: the sweep has nothing to act on yet')
    store.set(DEFAULT)
    assert.equal(store.known(), true, 'a push at the defaults is still the person’s choice')
    assert.equal(heard, 1, 'and is news to the sweep')
    assert.equal(
      createSettledChatsSettingsStore({ resolveUserDataDir: () => dir }).known(),
      true,
      'a file read is known',
    )
  })
})

test('a push that could not be written is still known for the rest of the run', async () => {
  const store = createSettledChatsSettingsStore({ resolveUserDataDir: () => '/nonexistent/settled-chats-dir' })
  assert.equal(store.known(), false)
  store.set({ autoSettleAfterDays: 5 })
  assert.equal(store.known(), true)
  assert.equal(store.get().autoSettleAfterDays, 5)
})
