import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

// The hidden canvas worker's window: sandboxed, isolated, on its own preload.

const created = vi.hoisted(() => [] as Array<{ webPreferences?: Record<string, unknown> }>)

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeContents extends EventEmitter {
    isDestroyed = () => false
    setWindowOpenHandler = () => {}
    send = () => {}
  }
  class FakeWindow extends EventEmitter {
    static getAllWindows = () => []
    webContents = new FakeContents()
    constructor(options: { webPreferences?: Record<string, unknown> }) {
      super()
      created.push(options)
    }
    isDestroyed = () => false
    destroy = () => {}
    loadFile = async () => {}
    loadURL = async () => {}
  }
  return { BrowserWindow: FakeWindow, app: { on: () => {}, off: () => {} } }
})

const { createCanvasWorkerTransport } = await import('./canvas-worker-window')

test('the worker window is sandboxed and carries only the worker preload', () => {
  const ipcMain = { on: () => {} }
  const transport = createCanvasWorkerTransport({ ipcMain: ipcMain as never })
  void transport.ensureStarted().catch(() => {})
  assert.equal(created.length, 1)
  const preferences = created[0]?.webPreferences ?? {}
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.match(String(preferences.preload), /[\\/]preload[\\/]canvas-worker\.js$/)
})
