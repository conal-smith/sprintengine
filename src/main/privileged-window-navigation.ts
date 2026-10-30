import { pathToFileURL } from 'node:url'
import { isSealedVisualUrl } from '../shared/sealed-visual'

// The app's own windows load the renderer with the preload's bridge to the
// machine attached — terminals, files, git. That bridge is exposed to whatever
// document the window is showing, so the window must only ever show the app.
// Two ways out existed: a `window.open` (or `target="_blank"` link) whose URL
// was handed to the OS whatever its scheme, and a navigation of the window
// itself, which nothing stopped. Both are closed here, for every such window.
//
// A third is a frame inside the window that runs an agent's script: a chat's
// sealed visual (`shared/sealed-visual.ts`). Its sandbox keeps it off the
// window and its policy keeps it off the network, but neither stops it from
// navigating itself to a page on the web, so that is refused here.

/** The subset of `WebContents` the guard touches, so it can be tested without Electron. */
export type GuardedContents = {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown
  on(event: 'will-frame-navigate', listener: (details: FrameNavigation) => void): unknown
}

/** The part of a frame navigation the sealed-visual rule reads. */
export type FrameNavigation = {
  preventDefault(): void
  isMainFrame: boolean
  isSameDocument: boolean
  frame: { url: string } | null
}

/**
 * Whether a frame's navigation is refused: any that leaves a sealed visual's
 * document, wherever it is headed, its own address included. A visual is
 * replaced by a new frame, never by navigating the old one. A move within the
 * same document (a `#section` link) loads nothing and stays.
 */
export function refusesFrameNavigation(details: Omit<FrameNavigation, 'preventDefault'>): boolean {
  if (details.isMainFrame || details.isSameDocument) return false
  let current: string | undefined
  try {
    current = details.frame?.url
  } catch {
    // A frame already gone has nowhere to go.
    return false
  }
  return isSealedVisualUrl(current)
}

// mailto stays: a markdown message's mail link opens through `window.open`, and
// the mail app is not a place a link can do harm.
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** The link a `window.open` may hand to the OS, or null to drop it. */
export function externalLinkForWindowOpen(url: string): string | null {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol) ? url : null
  } catch {
    return null
  }
}

/**
 * The document the app's windows load: the dev server in development, the
 * bundled `index.html` otherwise. Query strings and fragments are the app's own
 * (a window id, a view) and do not change which document it is.
 */
export function appDocumentUrl(rendererDevUrl: string | undefined, indexHtmlPath: string): URL {
  return rendererDevUrl ? new URL(rendererDevUrl) : pathToFileURL(indexHtmlPath)
}

/** Whether a navigation stays on the app's own document. */
export function isAppDocument(target: string, app: URL): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return url.protocol === 'file:' && url.pathname === app.pathname
  return url.origin === app.origin
}

export function guardPrivilegedWindow(
  contents: GuardedContents,
  app: URL,
  openExternal: (url: string) => Promise<void> | void,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalLinkForWindowOpen(url)
    if (external) void openExternal(external)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isAppDocument(url, app)) event.preventDefault()
  })
  contents.on('will-frame-navigate', (details) => {
    if (refusesFrameNavigation(details)) details.preventDefault()
  })
}
