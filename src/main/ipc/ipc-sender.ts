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

// The shape this reads, so a test can hand it a plain object.
type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>

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

// Every document the app loads in a window of its own with one of its
// preloads attached: the workspace and aux windows' renderer, the launch
// plate, and the canvas worker's page.
const APP_DOCUMENTS = new Set(['index.html', 'splash.html', 'canvas-worker.html'])

/** Whether `url` is one of the app's own documents (`APP_DOCUMENTS`), wherever this build serves them from. */
export function isAppDocumentUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const devOrigin = devRendererOrigin()
  if (devOrigin) {
    if (parsed.origin !== devOrigin) return false
    return parsed.pathname === '/' || APP_DOCUMENTS.has(parsed.pathname.slice(1))
  }
  if (parsed.protocol !== 'file:') return false
  const match = /\/renderer\/([^/]+)$/.exec(parsed.pathname)
  return match !== null && APP_DOCUMENTS.has(match[1]!)
}

/**
 * Whether any of the app's own windows is asking: the floor every IPC handler
 * stands on (`ipc-sender-guard.ts`). The same tests as `isAppSender`, but for
 * the document, which may be any of the app's own; a handler that changes
 * what runs on this machine still asks `assertAppSender` for the renderer
 * itself.
 */
export function isAppWindowSender(event: SenderEvent | null | undefined): boolean {
  const frame = event?.senderFrame
  if (!frame) return false
  if (frame.parent !== null) return false
  if (!event.sender || !BrowserWindow.fromWebContents(event.sender)) return false
  return isAppDocumentUrl(frame.url)
}

export class ForeignIpcSenderError extends Error {
  constructor() {
    super('This request did not come from a SprintEngine Studio window.')
  }
}

export function assertAppSender(event: SenderEvent | null | undefined): void {
  if (!isAppSender(event)) throw new ForeignIpcSenderError()
}
