import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null } }))

const { guardIpcSenders } = await import('./ipc-sender-guard')

// Enough of `ipcMain` to register on and to play a renderer against: an
// EventEmitter for messages, a channel map for invokes.
function fakeIpcMain() {
  const emitter = new EventEmitter()
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = Object.assign(emitter, {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`)
      handlers.set(channel, handler)
    },
    handleOnce(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
      ipc.handle(channel, handler)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
  })
  const invoke = async (channel: string, event: unknown, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for '${channel}'`)
    return handler(event, ...args)
  }
  return { ipc: ipc as unknown as Electron.IpcMain, emitter, handlers, invoke }
}

const app = { from: 'app' }
const guest = { from: 'guest' }
const isTrusted = (event: unknown) => event === app

test('an invoke from anything but the app is refused before the handler runs', async () => {
  const { ipc, invoke } = fakeIpcMain()
  const refused: string[] = []
  guardIpcSenders(ipc, isTrusted, (channel) => refused.push(channel))
  let reads = 0
  ipc.handle('fs:readfile', (_event, path: string) => {
    reads += 1
    return `contents of ${path}`
  })
  assert.equal(await invoke('fs:readfile', app, '/Users/dev/notes.txt'), 'contents of /Users/dev/notes.txt')
  await assert.rejects(invoke('fs:readfile', guest, '/Users/dev/.ssh/id_ed25519'), /did not come from/)
  assert.equal(reads, 1)
  assert.deepEqual(refused, ['fs:readfile'])
})

test('a message from anything but the app never reaches its listener', () => {
  const { ipc, emitter } = fakeIpcMain()
  guardIpcSenders(ipc, isTrusted)
  const heard: unknown[] = []
  ipc.on('terminal:write', (_event, data) => heard.push(data))
  emitter.emit('terminal:write', guest, 'rm -rf ~\r')
  emitter.emit('terminal:write', app, 'ls\r')
  assert.deepEqual(heard, ['ls\r'])
})

test('a once listener is spent only by the app, not by a foreign message sent first', () => {
  const { ipc, emitter } = fakeIpcMain()
  guardIpcSenders(ipc, isTrusted)
  let booted = 0
  ipc.once('app:boot-complete', () => {
    booted += 1
  })
  emitter.emit('app:boot-complete', guest)
  emitter.emit('app:boot-complete', app)
  emitter.emit('app:boot-complete', app)
  assert.equal(booted, 1)
  assert.equal(emitter.listenerCount('app:boot-complete'), 0)
})

test('handleOnce is spent only by the app', async () => {
  const { ipc, invoke, handlers } = fakeIpcMain()
  guardIpcSenders(ipc, isTrusted)
  ipc.handleOnce('pair:answer', () => 'ok')
  await assert.rejects(invoke('pair:answer', guest))
  assert.equal(await invoke('pair:answer', app), 'ok')
  assert.equal(handlers.has('pair:answer'), false)
})

test('removing a listener removes the guarded one ipcMain holds', () => {
  const { ipc, emitter } = fakeIpcMain()
  guardIpcSenders(ipc, isTrusted)
  const heard: string[] = []
  const onAck = () => heard.push('ack')
  ipc.on('window:dock-diff-ack', onAck)
  ipc.on('window:dock-diff-ack', onAck)
  assert.equal(emitter.listenerCount('window:dock-diff-ack'), 2)
  ipc.removeListener('window:dock-diff-ack', onAck)
  assert.equal(emitter.listenerCount('window:dock-diff-ack'), 1)
  ipc.off('window:dock-diff-ack', onAck)
  assert.equal(emitter.listenerCount('window:dock-diff-ack'), 0)
  emitter.emit('window:dock-diff-ack', app)
  assert.deepEqual(heard, [])
})

test('handlers registered through a wrapper of ipcMain are guarded too, and the guard goes on once', async () => {
  const { ipc, invoke } = fakeIpcMain()
  guardIpcSenders(ipc, isTrusted)
  guardIpcSenders(ipc, () => true)
  // As `machineAwareIpc` does: a proxy whose `handle` calls ipcMain's own.
  const wrapper = { handle: (channel: string, listener: () => unknown) => ipc.handle(channel, listener) }
  wrapper.handle('git:status', () => 'clean')
  assert.equal(await invoke('git:status', app), 'clean')
  await assert.rejects(invoke('git:status', guest), /did not come from/)
})
