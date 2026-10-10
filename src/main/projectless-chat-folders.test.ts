import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createProjectlessChatFolder, ensureProjectlessChatsRoot } from './projectless-chat-folders'

const homes: string[] = []

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'projectless-chats-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const NOW = () => new Date(2026, 9, 10, 9, 0)

test('the root is made in the home folder and answered', async () => {
  const home = await fakeHome()
  const root = await ensureProjectlessChatsRoot({ home: () => home })
  assert.equal(root, join(home, '.sprintengine', 'chats'))
  assert.ok((await stat(root)).isDirectory())
  assert.equal(await ensureProjectlessChatsRoot({ home: () => home }), root, 'a second call finds it there')
})

test('each chat gets a new folder in the root, named after its first words', async () => {
  const home = await fakeHome()
  const folder = await createProjectlessChatFolder('Plan a trip to Lisbon', {
    home: () => home,
    now: NOW,
    newId: () => 'ab12cd34',
  })
  assert.equal(folder, join(home, '.sprintengine', 'chats', '2026-10-10-plan-a-trip-to-lisbon-ab12cd34'))
  assert.ok((await stat(folder)).isDirectory())
})

test('a name already taken tries again with a fresh id, so two chats never share a folder', async () => {
  const home = await fakeHome()
  const ids = ['same0001', 'same0001', 'other002']
  const deps = { home: () => home, now: NOW, newId: () => ids.shift() ?? 'spare003' }
  const first = await createProjectlessChatFolder('hello', deps)
  const second = await createProjectlessChatFolder('hello', deps)
  assert.notEqual(first, second)
  assert.deepEqual((await readdir(join(home, '.sprintengine', 'chats'))).sort(), [
    '2026-10-10-hello-other002',
    '2026-10-10-hello-same0001',
  ])
})

test('a failure other than a taken name is not retried', async () => {
  const home = await fakeHome()
  let calls = 0
  await assert.rejects(
    createProjectlessChatFolder('hello', {
      home: () => home,
      now: NOW,
      makeDir: async (_path, options) => {
        if (options?.recursive) return
        calls += 1
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    }),
    /permission denied/,
  )
  assert.equal(calls, 1)
})
