import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

// Who is asking. An IPC handler that changes what runs on this machine —
// installing an extension, writing an MCP server into an agent CLI's config —
// should answer only the app's own window, not whatever else happens to hold
// a handle on the preload: a subframe (an embedded page, a module's iframe),
// a webview guest, or a window that has navigated somewhere it should not be.
//
// The app's windows load exactly one document, the renderer's index.html:
// from the dev server's origin under `electron-vite dev`, from a file: URL in
// a packaged build (window-factory.ts). Everything else — the canvas worker's
// own page, the browser pane's windows on the web — is not the app asking.

// The dev server the renderer is served from, when there is one.
function devRendererOrigin(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL']
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function isAppRendererUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const devOrigin = devRendererOrigin()
  if (devOrigin) {
    return parsed.origin === devOrigin && (parsed.pathname === '/' || parsed.pathname === '/index.html')
  }
  return parsed.protocol === 'file:' && parsed.pathname.endsWith('/renderer/index.html')
}

/**
 * The canvas worker's document (canvas-worker-window.ts): a hidden window main
 * opens to hold a drawing editor's DOM, loaded beside index.html.
 */
export function isCanvasWorkerUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const devOrigin = devRendererOrigin()
  if (devOrigin) return parsed.origin === devOrigin && parsed.pathname === '/canvas-worker.html'
  return parsed.protocol === 'file:' && parsed.pathname.endsWith('/renderer/canvas-worker.html')
}

// The shape this reads, so a test can hand it a plain object.
export type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>

// Every window main opens, and what it may say over ipcMain (app-ipc.ts
// applies this to every registration):
//
//   * The app's windows: the workspace window, a detached workspace window
//     (Move to new window), Diagnostics, and the aux windows (a diff, the
//     external file editor, a popped-out pane). All of them load index.html
//     with the app's preload (window-factory.ts), so all of them are 'app'
//     and may use any channel; a handler that answers only some of them
//     says so itself (a workspace window only, the owning window).
//   * The canvas worker: its own document, its two channels.
//   * The launch plate (splash-window.ts): a preload that only listens, so
//     no channel.
//   * The PDF export window (chat-export-pdf.ts) and the artifact thumbnail
//     window: no preload, and no script at all in the first, so no channel.
//   * The browser pane's guests and their popups, and a page opened in a
//     window of its own (browser-manager.ts): web pages, refused everywhere.
//     The element picker talks to the window hosting the guest, never main.
//   * The web client is a browser tab on a socket to the Studio server, and
//     the server's own process takes each window's requests on a port main
//     hands it (ipc-tunnel.ts): neither goes through ipcMain.
export type IpcSenderKind = 'app' | 'canvas-worker'

const CHANNELS_BY_KIND: Readonly<Record<Exclude<IpcSenderKind, 'app'>, ReadonlySet<string>>> = {
  'canvas-worker': new Set(['canvas-worker:ready', 'canvas-worker:response']),
}

/**
 * Which of Studio's documents is asking, or null for anything else: a webview
 * guest or any other contents that are not a window's own, a subframe, a frame
 * already gone, or a page that is not one of Studio's.
 */
export function ipcSenderKind(event: SenderEvent | null | undefined): IpcSenderKind | null {
  const frame = event?.senderFrame
  if (!frame) return null
  if (frame.parent !== null) return null
  const sender = event.sender
  if (!sender || typeof sender.getType !== 'function' || sender.getType() !== 'window') return null
  if (isAppRendererUrl(frame.url)) return 'app'
  if (isCanvasWorkerUrl(frame.url)) return 'canvas-worker'
  return null
}

export function senderMayUseChannel(kind: IpcSenderKind, channel: string): boolean {
  return kind === 'app' || CHANNELS_BY_KIND[kind].has(channel)
}

export function isAppSender(event: SenderEvent | null | undefined): boolean {
  const frame = event?.senderFrame
  // Null once the frame has navigated away or been destroyed: nobody to
  // answer, and certainly nobody to trust.
  if (!frame) return false
  // The top-level document only; a subframe is somebody else's page.
  if (frame.parent !== null) return false
  // A BrowserWindow's own contents; a webview guest has no window of its own.
  if (!event.sender || !BrowserWindow.fromWebContents(event.sender)) return false
  return isAppRendererUrl(frame.url)
}

class ForeignIpcSenderError extends Error {
  constructor() {
    super('This request did not come from a SprintEngine Studio window.')
  }
}

export function assertAppSender(event: SenderEvent | null | undefined): void {
  if (!isAppSender(event)) throw new ForeignIpcSenderError()
}
