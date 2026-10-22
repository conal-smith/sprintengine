import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, test, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: undefined, BrowserWindow: { fromWebContents: () => null } }))

const { guardIpcMain } = await import('./app-ipc')

// Every registration in main goes through `guardIpcMain`; these drive it with a
// stand-in for Electron's ipcMain and a sender per kind of window main opens.

const RENDERER = 'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer'

type FakeSender = { getType(): string }
type FakeEvent = {
  sender: FakeSender
  senderFrame: { url: string; parent: object | null } | null
  returnValue?: unknown
}

function sender(url: string, options: { type?: string; parent?: object | null; frame?: boolean } = {}): FakeEvent {
  return {
    sender: { getType: () => options.type ?? 'window' },
    senderFrame: options.frame === false ? null : { url, parent: options.parent ?? null },
  }
}

// The windows main opens (ipc-sender.ts's inventory), as their senders appear.
const WINDOWS = {
  workspace: sender(`${RENDERER}/index.html?windowId=primary&restoreDetached=1`),
  detachedWorkspace: sender(`${RENDERER}/index.html?windowId=window-2&restoreDetached=0`),
  diagnostics: sender(`${RENDERER}/index.html?view=diagnostics`),
  diffWindow: sender(`${RENDERER}/index.html?aux=diff&repoPath=%2FUsers%2Fdev%2Fproject`),
  editorWindow: sender(`${RENDERER}/index.html?aux=file&path=%2FUsers%2Fdev%2Fproject%2FREADME.md`),
  paneWindow: sender(`${RENDERER}/index.html?aux=pane&popOutId=p1`),
  canvasWorker: sender(`${RENDERER}/canvas-worker.html`),
  splash: sender(`${RENDERER}/splash.html?channel=stable`),
  pdfExport: sender('file:///var/folders/xy/T/sprintengine-chat-export-1/page.html'),
  pageWindow: sender('https://example.com/'),
}

class FakeIpcMain extends EventEmitter {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
    this.handlers.set(channel, handler)
  }
  handleOnce(): void {
    throw new Error('the guard registers once-handlers itself')
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel)
  }
  async invoke(channel: string, event: FakeEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for '${channel}'`)
    return handler(event, ...args)
  }
}

function setup() {
  const electron = new FakeIpcMain()
  const refused: string[] = []
  const ipc = guardIpcMain(electron as never, { onRefused: (channel) => refused.push(channel) })
  return { electron, ipc, refused }
}

afterEach(() => {
  delete process.env['ELECTRON_RENDERER_URL']
})

test('a webview guest is refused, on an invoke and on a send', async () => {
  const { electron, ipc, refused } = setup()
  let ran = 0
  ipc.handle('terminal:spawn', () => ++ran)
  ipc.on('terminal:write', () => ran++)
  // A guest shows a web page, but even one that reached the app's own URL is
  // still a guest.
  const guest = sender(`${RENDERER}/index.html`, { type: 'webview' })
  await assert.rejects(electron.invoke('terminal:spawn', guest), /answers only SprintEngine Studio's own windows/)
  electron.emit('terminal:write', guest, 'session', 'ls\r')
  assert.equal(ran, 0)
  assert.deepEqual(refused, ['terminal:spawn', 'terminal:write'])
})

test('a subframe of the app window is refused', async () => {
  const { electron, ipc } = setup()
  ipc.handle('fs:writefile', () => 'written')
  const subframe = sender(`${RENDERER}/index.html`, { parent: {} })
  await assert.rejects(electron.invoke('fs:writefile', subframe, '/Users/dev/x', 'y'))
  // A frame already gone, and contents that are not a window's own.
  await assert.rejects(electron.invoke('fs:writefile', sender(`${RENDERER}/index.html`, { frame: false })))
  await assert.rejects(electron.invoke('fs:writefile', sender(`${RENDERER}/index.html`, { type: 'browserView' })))
  assert.equal(await electron.invoke('fs:writefile', WINDOWS.workspace), 'written')
})

test("each of the app's windows is heard on any channel", async () => {
  const { electron, ipc } = setup()
  ipc.handle('terminal:spawn', (_event, input) => input)
  const heard: string[] = []
  ipc.on('window:minimize', (_event, name: string) => heard.push(name))
  for (const name of ['workspace', 'detachedWorkspace', 'diagnostics', 'diffWindow', 'editorWindow', 'paneWindow']) {
    const event = WINDOWS[name as keyof typeof WINDOWS]
    assert.equal(await electron.invoke('terminal:spawn', event, name), name)
    electron.emit('window:minimize', event, name)
  }
  assert.equal(heard.length, 6)
})

test('the canvas worker is heard on its own channels and nowhere else', async () => {
  const { electron, ipc } = setup()
  const said: unknown[] = []
  ipc.on('canvas-worker:ready', (_event, report) => said.push(report))
  ipc.on('canvas-worker:response', (_event, response) => said.push(response))
  ipc.handle('terminal:spawn', () => 'spawned')
  ipc.on('terminal:write', () => said.push('typed'))
  electron.emit('canvas-worker:ready', WINDOWS.canvasWorker, { loaded: [] })
  electron.emit('canvas-worker:response', WINDOWS.canvasWorker, { requestId: 'r1' })
  electron.emit('terminal:write', WINDOWS.canvasWorker, 'session', 'x')
  await assert.rejects(electron.invoke('terminal:spawn', WINDOWS.canvasWorker))
  assert.deepEqual(said, [{ loaded: [] }, { requestId: 'r1' }])
})

test('the launch plate, the PDF export window and web pages are heard nowhere', async () => {
  const { electron, ipc } = setup()
  ipc.handle('terminal:spawn', () => 'spawned')
  ipc.on('canvas-worker:ready', () => assert.fail('heard'))
  for (const event of [WINDOWS.splash, WINDOWS.pdfExport, WINDOWS.pageWindow]) {
    await assert.rejects(electron.invoke('terminal:spawn', event))
    electron.emit('canvas-worker:ready', event, {})
  }
})

test('under the dev server, its origin serves the app and the canvas worker', async () => {
  process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
  const { electron, ipc } = setup()
  ipc.handle('terminal:spawn', () => 'spawned')
  const ready: unknown[] = []
  ipc.on('canvas-worker:ready', (_event, report) => ready.push(report))
  assert.equal(await electron.invoke('terminal:spawn', sender('http://localhost:5173/?windowId=primary')), 'spawned')
  electron.emit('canvas-worker:ready', sender('http://localhost:5173/canvas-worker.html'), 'ok')
  await assert.rejects(electron.invoke('terminal:spawn', sender('http://localhost:5173/canvas-worker.html')))
  await assert.rejects(electron.invoke('terminal:spawn', sender('http://localhost:5174/')))
  assert.deepEqual(ready, ['ok'])
})

test('a refused sendSync is answered, so its window does not hang', () => {
  const { electron, ipc } = setup()
  ipc.on('app:sync', (event: { returnValue?: unknown }) => {
    event.returnValue = 'secret'
  })
  const guest = { ...sender('https://example.com/', { type: 'webview' }), returnValue: 'unset' }
  electron.emit('app:sync', guest)
  assert.equal(guest.returnValue, undefined)
})

test('a once-listener and a once-handler are spent only by an accepted sender', async () => {
  const { electron, ipc } = setup()
  let booted = 0
  ipc.once('app:boot-complete', () => booted++)
  electron.emit('app:boot-complete', WINDOWS.pageWindow)
  electron.emit('app:boot-complete', WINDOWS.workspace)
  electron.emit('app:boot-complete', WINDOWS.workspace)
  assert.equal(booted, 1)

  ipc.handleOnce('app:once', () => 'answered')
  await assert.rejects(electron.invoke('app:once', WINDOWS.pageWindow))
  assert.equal(await electron.invoke('app:once', WINDOWS.workspace), 'answered')
  await assert.rejects(electron.invoke('app:once', WINDOWS.workspace), /No handler registered/)
})

test('removing a listener removes what was registered for it', () => {
  const { electron, ipc } = setup()
  let heard = 0
  const listener = () => heard++
  ipc.on('window:dock-diff-ack', listener)
  assert.equal(electron.listenerCount('window:dock-diff-ack'), 1)
  ipc.removeListener('window:dock-diff-ack', listener)
  assert.equal(electron.listenerCount('window:dock-diff-ack'), 0)
  ipc.on('window:dock-diff-ack', listener)
  ipc.off('window:dock-diff-ack', listener)
  electron.emit('window:dock-diff-ack', WINDOWS.workspace)
  assert.equal(heard, 0)
  // Everything else is Electron's own.
  ipc.handle('x', () => 1)
  ipc.removeHandler('x')
  assert.equal(electron.handlers.has('x'), false)
})

test('a refusal is reported once per channel', async () => {
  const { electron, ipc, refused } = setup()
  ipc.handle('terminal:spawn', () => 'spawned')
  await assert.rejects(electron.invoke('terminal:spawn', WINDOWS.pageWindow))
  await assert.rejects(electron.invoke('terminal:spawn', WINDOWS.pageWindow))
  assert.deepEqual(refused, ['terminal:spawn'])
})
