import { BrowserWindow, app, type IpcMain, type IpcMainEvent } from 'electron'
import { join } from 'path'

import type { CanvasWorkerReport, CanvasWorkerRequest, CanvasWorkerResponse } from '../../shared/canvas/worker-protocol'
import type { CanvasWorkerTransport } from './canvas-worker-host'

// The canvas worker's window: a renderer that exists only to hold a DOM.
//
// It is the third HTML entry in the app (after the shell and the splash) and it
// is loaded exactly the way `splash-window.ts` loads its own — dev serves it
// beside the shell, a packaged build has it next to `index.html` in the
// renderer output.
//
// Everything here is about the window NOT being an app window:
//
//   * `show: false` and never shown, `focusable: false`, `skipTaskbar: true`:
//     it is not in the Dock, the taskbar, the window switcher or the tab order,
//     and it cannot take focus from the person mid-sentence.
//   * It is not registered with `window-factory`'s workspace set, so it is not
//     a host the embedded browser adopts guests from and it receives none of
//     the pushes that go to workspace windows.
//   * It closes itself when it is the LAST window left. Electron only emits
//     `window-all-closed` when no BrowserWindow remains, and the app's quit,
//     tray and `activate` paths all hang off that event — a hidden window that
//     outlived the person's last real one would read as an app that refuses to
//     quit and will not reopen.
//
// The ready handshake is the worker's own word that its editor instance has
// mounted and its fonts are loaded; requests sent before that would be dropped
// by a page with no listener yet.

const READY_TIMEOUT_MS = 30_000

/**
 * The readiness payload, treated as input. It crosses from a renderer, and one
 * that hosts a third-party editor package at that, so it is read for the three
 * arrays it promises and nothing else.
 */
function asReport(input: unknown): CanvasWorkerReport {
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  // Bounded on both axes: a family name ends up in a log line and in the
  // warning every agent write carries, and neither is a place for whatever the
  // renderer felt like sending.
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, 32)
          .map((entry) => entry.slice(0, 200))
      : []
  return { loaded: strings(source.loaded), missing: strings(source.missing), errors: strings(source.errors) }
}

const READY_CHANNEL = 'canvas-worker:ready'
const REQUEST_CHANNEL = 'canvas-worker:request'
const RESPONSE_CHANNEL = 'canvas-worker:response'

// Every canvas worker window this process has open — at most one, but a
// WeakSet rather than a variable because the answer is asked from main code
// that has a window and wants to know what KIND it is.
//
// Main has several "find a window" paths that predate this window and read
// `BrowserWindow.getAllWindows()` directly: the one a terminal streams to when
// no window asked for it, the one the tray reopens, the one a notification
// brings forward, and "is any window open at all". Each of them means "a window
// the person is using", and with the pane closed and an agent drawing, this
// window is the only one there is — so each of them asks this first.
const canvasWorkerWindows = new WeakSet<BrowserWindow>()

/** Is this window the hidden canvas worker rather than one the person uses? */
export function isCanvasWorkerWindow(win: BrowserWindow): boolean {
  return canvasWorkerWindows.has(win)
}

export type CanvasWorkerWindowDeps = {
  ipcMain: IpcMain
  log?: (message: string, details?: Record<string, unknown>) => void
}

/**
 * The Electron half of the worker protocol.
 *
 * One transport for the app's life; the WINDOW behind it comes and goes (idle
 * disposal, a crash, a restart), which is why the ipc listeners are registered
 * once here and check the sender rather than being rebound per window.
 */
export function createCanvasWorkerTransport(deps: CanvasWorkerWindowDeps): CanvasWorkerTransport {
  const log = deps.log ?? (() => {})
  let win: BrowserWindow | null = null
  let ready: Promise<void> | null = null
  let signalReady: (() => void) | null = null
  let failReady: ((error: Error) => void) | null = null
  /** What the live worker said about its fonts, or null when none is up. */
  let report: CanvasWorkerReport | null = null

  const responseListeners = new Set<(response: CanvasWorkerResponse) => void>()
  const crashListeners = new Set<(reason: string) => void>()

  /** Only the worker's own page may speak on these channels. */
  const isWorker = (event: IpcMainEvent): boolean =>
    win !== null && !win.isDestroyed() && !win.webContents.isDestroyed() && event.sender === win.webContents

  deps.ipcMain.on(READY_CHANNEL, (event, incoming: unknown) => {
    if (!isWorker(event)) return
    report = asReport(incoming)
    signalReady?.()
    signalReady = null
    failReady = null
  })

  deps.ipcMain.on(RESPONSE_CHANNEL, (event, response: CanvasWorkerResponse) => {
    if (!isWorker(event)) return
    if (!response || typeof response !== 'object' || typeof response.requestId !== 'string') return
    for (const listener of [...responseListeners]) listener(response)
  })

  function crashed(reason: string): void {
    log('The canvas worker window went away', { reason })
    teardown()
    for (const listener of [...crashListeners]) listener(reason)
  }

  function teardown(): void {
    const going = win
    win = null
    ready = null
    // A report belongs to the worker that made it: the next one loads its own
    // fonts, and may well get them.
    report = null
    const fail = failReady
    signalReady = null
    failReady = null
    // A start still waiting on the handshake has to be told, or the host's
    // first call would sit on a promise for a window that no longer exists.
    fail?.(new Error('The canvas worker window closed before it was ready.'))
    if (going && !going.isDestroyed()) going.destroy()
  }

  /**
   * Close the worker once it is the only window left, so `window-all-closed`
   * fires the way it would have without it. Re-checked on a later tick because
   * `closed` fires while Electron is still tearing the window down.
   */
  function watchForLastWindow(worker: BrowserWindow): () => void {
    const check = (): void => {
      if (worker.isDestroyed()) return
      const others = BrowserWindow.getAllWindows().filter((other) => other !== worker && !other.isDestroyed())
      if (others.length > 0) return
      teardown()
    }
    const onClosed = (): void => {
      setTimeout(check, 0)
    }
    const watched = new Set<BrowserWindow>()
    const observe = (other: BrowserWindow): void => {
      if (other === worker || watched.has(other)) return
      watched.add(other)
      other.once('closed', onClosed)
    }
    for (const other of BrowserWindow.getAllWindows()) observe(other)
    const onCreated = (_event: unknown, created: BrowserWindow): void => observe(created)
    app.on('browser-window-created', onCreated)
    return () => {
      app.off('browser-window-created', onCreated)
      for (const other of watched) {
        if (!other.isDestroyed()) other.off('closed', onClosed)
      }
      watched.clear()
    }
  }

  function create(): Promise<void> {
    const worker = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      // Not a window the person can reach: no taskbar entry, no focus, no
      // chrome. It has a size only because the editor lays out against one.
      skipTaskbar: true,
      focusable: false,
      // Without this a window that is never shown never paints, and the editor
      // never measures the text it is asked to lay out.
      paintWhenInitiallyHidden: true,
      webPreferences: {
        // Its own preload, with the worker protocol and nothing else on it, in
        // a sandboxed renderer: the window hosts a third-party editor package,
        // and none of the app's surface is its business.
        preload: join(__dirname, '../preload/canvas-worker.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Geometry and image export are the whole job; a throttled timer here
        // turns a two-second export into a two-minute one whenever the app is
        // in the background, which is most of when an agent is drawing.
        backgroundThrottling: false,
      },
    })
    win = worker
    canvasWorkerWindows.add(worker)

    const stopWatchingWindows = watchForLastWindow(worker)

    // Nothing in this window navigates or opens anything. It loads one local
    // page and serves a protocol; a scene it imports is data, never a document.
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    worker.webContents.on('will-navigate', (event) => event.preventDefault())
    worker.webContents.on('render-process-gone', (_event, details) => crashed(`render-process-gone: ${details.reason}`))
    worker.webContents.on('unresponsive', () => crashed('unresponsive'))
    worker.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      // Only the page itself. A font or chunk that 404s is the worker's own
      // problem to report through the protocol, not a reason to kill it.
      if (!isMainFrame) return
      crashed(`did-fail-load: ${errorCode} ${errorDescription}`)
    })
    worker.on('closed', () => {
      stopWatchingWindows()
      if (win === worker) crashed('closed')
    })

    const handshake = new Promise<void>((settle, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The canvas worker did not report ready.'))
      }, READY_TIMEOUT_MS)
      signalReady = () => {
        clearTimeout(timer)
        settle()
      }
      failReady = (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      void worker.loadURL(new URL('canvas-worker.html', process.env['ELECTRON_RENDERER_URL']).toString())
    } else {
      void worker.loadFile(join(__dirname, '../renderer/canvas-worker.html'))
    }

    return handshake
  }

  return {
    ensureStarted(): Promise<void> {
      if (win && !win.isDestroyed() && ready) return ready
      // A start that fails takes the window with it, so the next call builds a
      // fresh one rather than waiting on a page that never answered.
      const started = create().catch((error: unknown) => {
        teardown()
        throw error
      })
      ready = started
      return started
    },

    post(request: CanvasWorkerRequest): void {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        throw new Error('The canvas worker window is gone.')
      }
      win.webContents.send(REQUEST_CHANNEL, request)
    },

    onResponse(cb): () => void {
      responseListeners.add(cb)
      return () => responseListeners.delete(cb)
    },

    onCrashed(cb): () => void {
      crashListeners.add(cb)
      return () => crashListeners.delete(cb)
    },

    report(): CanvasWorkerReport | null {
      return report
    },

    stop(): void {
      const going = win
      win = null
      ready = null
      report = null
      signalReady = null
      failReady = null
      if (going && !going.isDestroyed()) going.destroy()
    },
  }
}
