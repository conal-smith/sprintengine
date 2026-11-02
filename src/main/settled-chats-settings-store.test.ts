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
