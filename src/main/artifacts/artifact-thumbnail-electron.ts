import { BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'

import type { ArtifactThumbnailer } from './artifacts-service'

// A picture of a page about to be published, for its card in the gallery:
// the page is opened in a hidden window of the app's own Chromium, from the
// folder it was laid out in for publishing (so it is seen as it will be
// served), and its first screen is captured once it has loaded and its fonts
// are in.
//
// The page is an agent's, so the window gives it nothing: sandboxed, no Node,
// a session of its own kept in memory, no pop-ups, no navigating away, and it
// is closed after the capture or after a few seconds, whichever is first.

const LOAD_TIMEOUT_MS = 15_000
const SETTLE_MS = 400
const THUMBNAIL_WIDTH = 640

export function createElectronThumbnailer(): ArtifactThumbnailer {
  return async ({ file, width, height }) => {
    const window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        javascript: true,
        partition: 'artifact-thumbnail',
        backgroundThrottling: false,
      },
    })
    const timer = setTimeout(() => {
      if (!window.isDestroyed()) window.destroy()
    }, LOAD_TIMEOUT_MS + 5_000)
    try {
      const contents = window.webContents
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const pageUrl = pathToFileURL(file).toString()
      contents.on('will-navigate', (event, url) => {
        if (url !== pageUrl) event.preventDefault()
      })
      contents.setAudioMuted(true)
      await Promise.race([
        window.loadURL(pageUrl),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), LOAD_TIMEOUT_MS)),
      ])
      await contents
        .executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true)
        .catch(() => true)
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      if (window.isDestroyed()) return null
      const image = await contents.capturePage({ x: 0, y: 0, width, height })
      if (image.isEmpty()) return null
      return image.resize({ width: THUMBNAIL_WIDTH, quality: 'best' }).toPNG()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
