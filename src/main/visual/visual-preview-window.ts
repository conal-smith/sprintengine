import { BrowserWindow, session as electronSession, type Session } from 'electron'

import { refusesFrameNavigation } from '../privileged-window-navigation'
import { VISUAL_VARIABLES, visualThemeFrom } from '../../shared/visual-document'
import type { VisualConsoleLine, VisualPreviewDeps, VisualPreviewSurface } from './visual-preview'

// The hidden window an agent's visual is previewed in. The visual runs in a
// frame with the chat's own sandbox and policy (`visual-preview.ts` builds
// it), and the window around it adds the seals the app's windows add and a
// few more, since nothing in it is the person's:
//
//   * sandboxed, no Node, no preload: nothing reaches main but the console;
//   * a session of its own, in memory, that refuses every request but the two
//     documents' own (carried in their addresses) and
//     every permission asked, so a load the policy missed still goes nowhere;
//   * no pop-ups, no navigation of the page, and none out of the sealed frame
//     (`refusesFrameNavigation`, as in an app window);
//   * offscreen and never shown, and destroyed after the capture or the
//     preview's time limit, whichever is first.

const PARTITION = 'visual-preview'
const BACKGROUND_TOKEN = '--sem-color-bg-surface'

let sealedSession: Session | null = null

function previewSession(): Session {
  if (sealedSession) return sealedSession
  const session = electronSession.fromPartition(PARTITION, { cache: false })
  // The blank host page and the sealed document are the only loads; both
  // are carried in their address. Everything else is refused.
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !/^(?:data|about):/iu.test(details.url) }),
  )
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  sealedSession = session
  return session
}

const LEVELS: ReadonlySet<VisualConsoleLine['level']> = new Set(['debug', 'info', 'warning', 'error'])

async function openSurface(width: number, height: number): Promise<VisualPreviewSurface> {
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      session: previewSession(),
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  const contents = window.webContents
  const lines: VisualConsoleLine[] = []
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (details) => {
    if (refusesFrameNavigation(details)) details.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setAudioMuted(true)
  contents.on('console-message', (event) => {
    // Bounded here as well as in the result: a visual can print in a loop.
    if (lines.length >= 200) return
    // Electron's own notice about the blank host page, in development builds only.
    if (String(event.message).includes('Electron Security Warning')) return
    const level = LEVELS.has(event.level as VisualConsoleLine['level'])
      ? (event.level as VisualConsoleLine['level'])
      : 'info'
    lines.push({
      level,
      message: String(event.message).slice(0, 2000),
      ...(event.lineNumber > 0 ? { line: event.lineNumber } : {}),
    })
  })
  try {
    await window.loadURL('about:blank')
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  return {
    run: (script) => contents.executeJavaScript(script, false),
    consoleLines: () => [...lines],
    resize: (nextWidth, nextHeight) => {
      if (!window.isDestroyed()) window.setContentSize(nextWidth, Math.max(1, nextHeight))
    },
    capture: async () => {
      if (window.isDestroyed()) return null
      const image = await contents.capturePage()
      if (image.isEmpty()) return null
      const size = image.getSize()
      return {
        width: size.width,
        height: size.height,
        png: () => image.toPNG(),
        jpeg: (quality) => image.toJPEG(quality),
      }
    },
    close: () => {
      if (!window.isDestroyed()) window.destroy()
    },
  }
}

// Read-only, and our own text: the window's computed tokens, nothing the
// agent wrote.
const THEME_SCRIPT = `(function () {
  var style = getComputedStyle(document.documentElement), out = {};
  ${JSON.stringify([...Object.values(VISUAL_VARIABLES), 'color-scheme', BACKGROUND_TOKEN])}.forEach(function (name) {
    out[name] = style.getPropertyValue(name);
  });
  return out;
})()`

// With no window to read, light: the visual's own text falls back to black.
const NO_WINDOW_THEME = { theme: { variables: {}, colorScheme: 'light' }, background: '#ffffff' }

/** The appearance the person's window has now, so the preview is drawn as the chat would draw it. */
async function appTheme(listWindows: () => BrowserWindow[]): ReturnType<VisualPreviewDeps['theme']> {
  const windows = listWindows().filter((window) => !window.isDestroyed())
  const window = windows.find((candidate) => candidate.isFocused()) ?? windows[0]
  if (!window) return NO_WINDOW_THEME
  try {
    const values = (await window.webContents.executeJavaScript(THEME_SCRIPT, false)) as unknown
    const record = typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {}
    const read = (name: string) => (typeof record[name] === 'string' ? (record[name] as string) : '')
    const background = read(BACKGROUND_TOKEN).trim()
    return { theme: visualThemeFrom(read), background: background || null }
  } catch {
    return NO_WINDOW_THEME
  }
}

/** The preview's window, with the theme read from one of `listWindows` (the person's workspace windows). */
export function createElectronVisualPreview(listWindows: () => BrowserWindow[]): VisualPreviewDeps {
  return { open: openSurface, theme: () => appTheme(listWindows) }
}
