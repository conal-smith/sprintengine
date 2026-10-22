import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'vitest'

import { createHtmlPreviewStore } from './html-preview'
import { registerHtmlPreviewIpc } from './ipc/html-preview-ipc'

test('a registered page is served at its URL until its window closes it', async () => {
  const store = createHtmlPreviewStore()
  const url = store.open('<script>1</script>', 7)
  assert.match(url, /^studio-preview:\/\/doc\/[0-9a-f-]{36}$/)
  const served = store.respond(url)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await served.text(), '<script>1</script>')
  // Another window cannot close it; its own can.
  store.close(url, 8)
  assert.equal(store.respond(url).status, 200)
  store.close(url, 7)
  assert.equal(store.respond(url).status, 404)
})

test('nothing else is served, and a closed window takes its pages with it', () => {
  const store = createHtmlPreviewStore()
  const url = store.open('<p>a</p>', 1)
  assert.equal(store.respond(url.replace('doc', 'other')).status, 404)
  assert.equal(store.respond(`${url}x`).status, 404)
  assert.equal(store.respond('studio-preview://doc/').status, 404)
  assert.equal(store.respond('not a url').status, 404)
  store.release(1)
  assert.equal(store.respond(url).status, 404)
})

test('the store keeps a bounded number of pages', () => {
  const store = createHtmlPreviewStore()
  const first = store.open('<p>0</p>', 1)
  for (let i = 1; i <= 16; i++) store.open(`<p>${i}</p>`, 1)
  assert.equal(store.respond(first).status, 404)
  assert.throws(() => store.open('x'.repeat(8 * 1024 * 1024 + 1), 1), /too large/)
})

test('the IPC registers pages under the asking window and forgets them when it goes', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = { handle: (channel: string, handler: never) => handlers.set(channel, handler) }
  const store = createHtmlPreviewStore()
  registerHtmlPreviewIpc(ipcMain as never, store)
  const sender = Object.assign(new EventEmitter(), { id: 42 })
  const url = (await handlers.get('html-preview:open')!({ sender }, '<p>x</p>')) as string
  assert.equal(store.respond(url).status, 200)
  sender.emit('destroyed')
  assert.equal(store.respond(url).status, 404)
  const again = (await handlers.get('html-preview:open')!({ sender }, '<p>y</p>')) as string
  await handlers.get('html-preview:close')!({ sender }, again)
  assert.equal(store.respond(again).status, 404)
})
