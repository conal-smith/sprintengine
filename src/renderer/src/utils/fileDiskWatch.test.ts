import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { FileWatchEvent } from '../../../shared/ipc/filesystem'
import { createFileDiskWatcher, type FileDiskWatchApi } from './fileDiskWatch'

type FakeWatch = { path: string; cb: (event: FileWatchEvent) => void; stopped: boolean }

function fakeApi(options: { refuse?: (path: string) => boolean } = {}) {
  const watches: FakeWatch[] = []
  const api: FileDiskWatchApi = {
    watchPath: async (path, cb) => {
      if (options.refuse?.(path)) throw new Error(`Cannot watch missing path: ${path}`)
      const watch: FakeWatch = { path, cb, stopped: false }
      watches.push(watch)
      return async () => {
        watch.stopped = true
      }
    },
  }
  return { api, watches }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const change = (...paths: string[]): FileWatchEvent => ({ eventType: 'change', path: paths[0] ?? null, paths })

test('tabs in one folder share one watch, which closes with the last of them', async () => {
  const { api, watches } = fakeApi()
  const watcher = createFileDiskWatcher(() => api, { debounceMs: 5 })
  const stopA = watcher.watch('/Users/dev/acme/src/a.ts', () => {})
  const stopB = watcher.watch('/Users/dev/acme/src/b.ts', () => {})
  const stopC = watcher.watch('/Users/dev/acme/docs/c.md', () => {})
  await tick()
  assert.deepEqual(
    watches.map((watch) => watch.path),
    ['/Users/dev/acme/src', '/Users/dev/acme/docs'],
  )
  assert.equal(watcher.folderCount(), 2)

  stopA()
  await tick()
  assert.equal(watches[0].stopped, false, 'b.ts still needs src/')
  stopB()
  stopC()
  await tick()
  assert.equal(watches[0].stopped, true)
  assert.equal(watches[1].stopped, true)
  assert.equal(watcher.folderCount(), 0)
})

test('only the file’s own name wakes it, and a burst wakes it once', async () => {
  const { api, watches } = fakeApi()
  const watcher = createFileDiskWatcher(() => api, { debounceMs: 10 })
  let a = 0
  let b = 0
  watcher.watch('/Users/dev/acme/src/a.ts', () => a++)
  watcher.watch('/Users/dev/acme/src/b.ts', () => b++)
  await tick()
  const [watch] = watches

  watch.cb(change('a.ts'))
  watch.cb(change('a.ts', '.a.ts.tmp'))
  watch.cb(change('nested/a.ts'))
  await tick(30)
  assert.equal(a, 1, 'three events inside the debounce, one re-read')
  assert.equal(b, 0, 'a sibling’s change, or a same-named file deeper down, is not b.ts’s')

  watch.cb({ eventType: 'rename', path: null, paths: [], overflow: true })
  await tick(30)
  assert.equal(a, 2, 'an overflowed burst may have touched anything')
  assert.equal(b, 1)
})

test('a folder that cannot be watched is silent, not an error', async () => {
  const { api, watches } = fakeApi({ refuse: (path) => path.startsWith('/remote') })
  const watcher = createFileDiskWatcher(() => api, { debounceMs: 5 })
  let calls = 0
  const stop = watcher.watch('/remote/acme/src/a.ts', () => calls++)
  await tick(20)
  assert.equal(watches.length, 0)
  assert.equal(calls, 0)
  stop()

  const noApi = createFileDiskWatcher(() => ({}), { debounceMs: 5 })
  noApi.watch('/Users/dev/acme/src/a.ts', () => calls++)()
  assert.equal(calls, 0)
})

test('a tab closed before its watch started still stops it', async () => {
  const { api, watches } = fakeApi()
  const watcher = createFileDiskWatcher(() => api, { debounceMs: 5 })
  watcher.watch('/Users/dev/acme/src/a.ts', () => {})()
  await tick()
  assert.equal(watches.length, 1)
  assert.equal(watches[0].stopped, true)
})

test('a pending re-read is dropped with the tab', async () => {
  const { api, watches } = fakeApi()
  const watcher = createFileDiskWatcher(() => api, { debounceMs: 10 })
  let calls = 0
  const stop = watcher.watch('/Users/dev/acme/src/a.ts', () => calls++)
  await tick()
  watches[0].cb(change('a.ts'))
  stop()
  await tick(30)
  assert.equal(calls, 0)
})
