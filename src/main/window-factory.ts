import { BrowserWindow, screen, shell, type WebContents } from 'electron'
import { join } from 'path'
import { serverModeWindowArguments } from './server-mode'
import { sshPreviewWindowArguments } from './environments/ssh/ssh-preview'
import { guestPreloadPath } from './browser/browser-manager'
import { applyGuestWebPreferences, isAllowedMachinePartition, type GuestWebPreferences } from './browser/guest-policy'
import type { WindowMaterial } from '../shared/electron-api'
import { sendWindowHidden, sendWindowPlacement, sendWindowState } from './ipc/window-ipc'
import { getWindowCanvasColor, getWindowMaterial } from './window-material-store'
import { appDocumentUrl, guardPrivilegedWindow } from './privileged-window-navigation'
import { allowAppWindowPermissionCheck, allowAppWindowPermissionRequest } from './app-window-permissions'

/** The one document every window made here may show; see privileged-window-navigation.ts. */
function appDocument(): URL {
  return appDocumentUrl(process.env['ELECTRON_RENDERER_URL'], join(__dirname, '../renderer/index.html'))
}

type CreateMainWindowOptions = {
  diagnosticsEnabled: boolean
  windowId?: string
  bounds?: { x: number; y: number; width: number; height: number } | null
  isMaximized?: boolean
  // Hold this window hidden past `ready-to-show`; the caller reveals it with
  // `revealMainWindow`. Set ONLY for the cold-start primary while the splash
  // covers boot — otherwise the splash and the main window would both be on
  // screen at once. Detached workspace windows and the window macOS `activate`
  // re-creates never pass it, so they show themselves as they always did.
  deferShow?: boolean
}

const forceCloseWindowIds = new WeakSet<BrowserWindow>()
let appQuitInProgress = false
// Persisted detached workspace windows are restored exactly ONCE per process —
// on the genuine cold-start primary. Consumed by the first primary window
// created; every later primary (notably the one macOS `activate` re-creates
// after all windows were closed) is handed restoreDetached=0, so closing your
// windows can never be silently undone by an auto-respawn (which read as an
// un-closable window that respawned on every close).
let detachedRestorePending = true

// Workspace (main-shell) windows only — aux/diagnostics windows never frost.
// The material IPC re-applies the material live to every member on change.
const workspaceWindows = new Set<BrowserWindow>()
const workspaceWindowIds = new WeakMap<BrowserWindow, string>()
// Panes popped out of a workspace window (aux kind `pane`): the other host of
// the embedded browser, kept apart from the workspace windows because they are
// not one — they show no workspace and answer no workspace broadcast.
const panePopOutWindows = new Set<BrowserWindow>()

// The window-level half of a material: vibrancy and a transparent background
// for glass; no vibrancy and the theme's own opaque canvas colour for tinted
// and solid. Tinted's washes are painted by the renderer as static
// CSS over that opaque ground — the window itself is an ordinary opaque one,
// which is what keeps it free on platforms with no vibrancy. The colour
// matters for the frames before the renderer paints (creation, and a resize
// that outruns it): it is the theme's canvas, so a light theme never flashes
// a dark ground.
function materialWindowOptions(
  material: WindowMaterial,
  canvasColor: string,
): { vibrancy?: 'under-window'; backgroundColor: string } {
  return material === 'glass'
    ? { vibrancy: 'under-window', backgroundColor: '#00000000' }
    : { backgroundColor: canvasColor }
}

// macOS vibrancy for the glass window material. The OS composites the blur
// from the desktop BEHIND the window (never from our own content), so this is
// frame-budget-free even with streaming terminals — unlike in-app
// backdrop-filter, which stays banned (see .overlay-scrim in index.css).
// Which regions read as glass is the renderer's call via the
// data-window-material attribute; everything painted opaque stays opaque.
// The opaque materials re-apply on every platform: their background colour
// follows the theme, so a theme change re-pushes it.
export function applyWindowMaterialToWorkspaceWindows(material: WindowMaterial, canvasColor: string): void {
  const options = materialWindowOptions(material, canvasColor)
  for (const win of workspaceWindows) {
    if (win.isDestroyed()) continue
    if (process.platform === 'darwin') win.setVibrancy(options.vibrancy ?? null)
    win.setBackgroundColor(options.backgroundColor)
  }
}

// The workspace-window id a window was opened with (the registry's
// `workspaceWindows[].id`): how a chat link finds the window that holds its
// chat (chat-link-router.ts).
export function workspaceWindowIdOf(win: BrowserWindow): string {
  return workspaceWindowIds.get(win) ?? 'primary'
}

// Whether a WebContents is one of the workspace windows — the windows that
// show a workspace, own its pane, and answer its agents' reveal requests.
export function isWorkspaceWindowWebContents(contents: WebContents): boolean {
  for (const win of workspaceWindows) {
    if (!win.isDestroyed() && win.webContents === contents) return true
  }
  return false
}

// Whether a WebContents may host the embedded browser's guests
// (browser-manager.register): a workspace window, or a pane popped out of one,
// which mounts the same browser tabs. Nothing else is given `webviewTag`.
export function isBrowserHostWebContents(contents: WebContents): boolean {
  if (isWorkspaceWindowWebContents(contents)) return true
  for (const win of panePopOutWindows) {
    if (!win.isDestroyed() && win.webContents === contents) return true
  }
  return false
}

// Every guest a browser host attaches is the embedded browser and nothing else
// (guest-policy.ts has the rules and their tests). The one policy for both
// kinds of host, so a pane popped out of its window cannot attach a guest the
// window it came from would have refused.
function allowOnlyEmbeddedBrowserGuests(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (
      !applyGuestWebPreferences(
        webPreferences as GuestWebPreferences,
        params,
        guestPreloadPath(),
        isAllowedMachinePartition,
      )
    )
      event.preventDefault()
  })
}

// Show a window created with `deferShow`. Safe on a window that is already
// visible or already gone: the boot reveal races a renderer signal against a
// timeout, and the loser must be a no-op rather than a throw.
export function revealMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.show()
  win.focus()
}

export function markAppQuitInProgressForWindowClose(): void {
  appQuitInProgress = true
}

export function confirmWorkspaceWindowClose(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  forceCloseWindowIds.add(win)
  win.close()
}

export function createMainWindow({
  diagnosticsEnabled,
  windowId = 'primary',
  bounds = null,
  isMaximized = false,
  deferShow = false,
}: CreateMainWindowOptions): BrowserWindow {
  // Consume the one-shot: only the first primary window of the process is
  // eligible to restore detached windows. Detached windows (windowId !==
  // 'primary') never restore, so they leave the flag alone.
  const restoreDetached = windowId === 'primary' && detachedRestorePending
  if (windowId === 'primary') detachedRestorePending = false
  // Applied at creation (not post-boot) so a glass-persisted profile paints
  // frosted chrome from the first frame, and an opaque one its theme's canvas;
  // getWindowMaterial() never answers 'glass' off macOS. The renderer boot
  // script stamps the matching data-window-material attribute just as
  // synchronously.
  const materialOptions = materialWindowOptions(getWindowMaterial(), getWindowCanvasColor())
  const safeBounds = normalizeWindowBounds(bounds)
  const win = new BrowserWindow({
    width: safeBounds?.width ?? 1400,
    height: safeBounds?.height ?? 900,
    ...(safeBounds ? { x: safeBounds.x, y: safeBounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform !== 'darwin'
      ? {
          frame: false,
        }
      : {
          // Keep the native traffic lights but hide the OS title bar so the
          // renderer can draw its own draggable title strip (centered brand).
          titleBarStyle: 'hiddenInset' as const,
          // Vertically center the traffic lights in the 36 px title strip
          // (`AppTitleBar`) so they line up with the centered brand.
          trafficLightPosition: { x: 12, y: 11 },
        }),
    autoHideMenuBar: process.platform !== 'darwin',
    ...materialOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Which process owns the server's IPC channels this session (ipc-router.ts).
      additionalArguments: [...serverModeWindowArguments(), ...sshPreviewWindowArguments()],
      sandbox: false,
      // Background throttling stays ON (Electron's default), deliberately.
      //
      // It was switched off when sprint auto-run was moved into main, because
      // a locked screen occludes the window and Chromium then throttled what was
      // left in the renderer: the scheduler's leftover reconcile passes, and the
      // terminal views. The first of those is gone. The second is the one that
      // mattered: a terminal view drains incoming pty output on animation
      // frames, an occluded window gets none, so output piled up in the view's
      // queue until the queue's cap started discarding the oldest of it — and
      // the person unlocked their screen to a pane that had skipped part of what
      // the agent did.
      //
      // Switching throttling off fixed that by never letting the window rest,
      // which also switched off the Page Visibility API: `document.hidden` stayed
      // false on a minimized, covered or locked window, so every "pause while
      // hidden" guard in the renderer was dead and the ambient animations kept
      // compositing frames nobody could see.
      //
      // Terminal liveness is now kept a different way. When the window is hidden
      // (the page says so, or main does: `sendWindowHidden`) it reports its
      // terminals hidden to main (WorkspaceManager, via the same
      // `terminalSetVisible` a layer switch uses), and main stops forwarding their
      // output and keeps it in each session's retained stream. Main is not
      // throttled and a hidden pane is never waited on for acknowledgements, so
      // the agent keeps its full speed and nothing is lost; when the window is
      // visible again it reports them visible and main sends each pane only the
      // bytes it missed. The agents themselves never depended on the renderer:
      // their ptys, hooks, attention and scheduling all live in main.
      // The browser pane's <webview> guest is its own page with its own
      // throttling, and is unaffected either way.
      backgroundThrottling: true,
      // The workspace pane's browser tab is a <webview> guest (browser-pane
      // epic, decision 1). Only workspace windows host one; see
      // `will-attach-webview` below for what a guest may be.
      webviewTag: true,
      // A guest's fullscreen is passed on to the window hosting it, which would
      // otherwise go into the OS's full screen for a video in the browser pane.
      // With this off here and on the guest, the page fills this window's
      // content and the window stays as it is.
      disableHtmlFullscreenWindowResize: true,
    },
  })

  workspaceWindows.add(win)
  workspaceWindowIds.set(win, windowId)
  win.on('closed', () => {
    workspaceWindows.delete(win)
  })

  allowOnlyEmbeddedBrowserGuests(win)

  win.on('ready-to-show', () => {
    // Maximize regardless: it applies to a hidden window, so a deferred reveal
    // still comes up in the placement the profile saved.
    if (isMaximized) win.maximize()
    // ready-to-show fires before hydration and boot discovery settle — the exact
    // stretch the splash is covering. Showing here would put the app frame and
    // the plate on screen together.
    if (deferShow) return
    win.show()
    win.focus()
  })
  win.on('maximize', () => {
    sendWindowState(win)
    sendWindowPlacement(win)
  })
  win.on('unmaximize', () => {
    sendWindowState(win)
    sendWindowPlacement(win)
  })
  win.on('enter-full-screen', () => sendWindowState(win))
  win.on('leave-full-screen', () => sendWindowState(win))
  // Out of sight or back: what lets a hidden window stop feeding its
  // terminals where the page cannot tell it is hidden (sendWindowHidden).
  win.on('minimize', () => sendWindowHidden(win))
  win.on('restore', () => sendWindowHidden(win))
  win.on('hide', () => sendWindowHidden(win))
  win.on('show', () => sendWindowHidden(win))
  const schedulePlacementUpdate = createPlacementUpdateScheduler(win)
  win.on('move', schedulePlacementUpdate)
  win.on('resize', schedulePlacementUpdate)
  win.on('focus', () => sendWindowPlacement(win))
  win.on('close', (event) => {
    if (windowId === 'primary' || appQuitInProgress || forceCloseWindowIds.has(win)) return
    event.preventDefault()
    win.webContents.send('window:close-requested')
  })

  if (diagnosticsEnabled) {
    win.webContents.on('console-message', function (_event, detailsOrLevel) {
      const args = Array.from(arguments)
      const details =
        detailsOrLevel && typeof detailsOrLevel === 'object'
          ? (detailsOrLevel as { level?: string; message?: string; sourceId?: string; lineNumber?: number })
          : null
      const level = details?.level ?? String(detailsOrLevel)
      const message = details?.message ?? String(args[2] ?? '')
      console.info(`[Renderer:${level}] ${message}`, {
        sourceId: details?.sourceId ?? args[4],
        line: details?.lineNumber ?? args[3],
      })
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Renderer] render-process-gone', details)
    })
    win.webContents.on('unresponsive', () => {
      console.error('[Renderer] unresponsive')
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Renderer] did-fail-load', { errorCode, errorDescription, validatedURL })
    })
  }

  guardPrivilegedWindow(win.webContents, appDocument(), (url) => shell.openExternal(url))

  // Refuse the microphone, the camera and everything else; let a tab recording's
  // display capture through to its own handler, and Settings read the installed
  // font families. Without these handlers the
  // session would grant every request. See app-window-permissions.ts.
  const app = appDocument()
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(
      allowAppWindowPermissionRequest(
        permission,
        details as { mediaTypes?: string[]; requestingUrl?: string; isMainFrame?: boolean },
        app,
      ),
    )
  })
  // Checks (`navigator.permissions.query`, device labels) are refused but for
  // the font list, asked by the app's own page; a display capture does not
  // depend on one.
  win.webContents.session.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    allowAppWindowPermissionCheck(permission, details, app),
  )

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('windowId', windowId)
    url.searchParams.set('restoreDetached', restoreDetached ? '1' : '0')
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { windowId, restoreDetached: restoreDetached ? '1' : '0' },
    })
  }

  return win
}

// Singleton standalone diagnostics window. Loads the same renderer bundle with
// `?view=diagnostics` so the renderer mounts only the performance panel. It is
// deliberately not a workspace window: it does not participate in workspace
// sync, carries no `windowId`, and closes normally (no unsaved-work guard).
let diagnosticsWindow: BrowserWindow | null = null

export function createDiagnosticsWindow(): BrowserWindow {
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    if (diagnosticsWindow.isMinimized()) diagnosticsWindow.restore()
    diagnosticsWindow.focus()
    return diagnosticsWindow
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    show: false,
    title: 'SprintEngine Studio Diagnostics',
    backgroundColor: getWindowCanvasColor(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Which process owns the server's IPC channels this session (ipc-router.ts).
      additionalArguments: [...serverModeWindowArguments(), ...sshPreviewWindowArguments()],
      sandbox: false,
    },
  })
  diagnosticsWindow = win

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (diagnosticsWindow === win) diagnosticsWindow = null
  })

  guardPrivilegedWindow(win.webContents, appDocument(), (url) => shell.openExternal(url))

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('view', 'diagnostics')
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'diagnostics' },
    })
  }

  return win
}

// Lightweight auxiliary windows (diff viewer, external file editor). They share
// the main window's chrome treatment but mount a dedicated renderer root via the
// `aux=<kind>` query param — no workspace shell, no workspace-window sync. Keyed
// by `<kind>:<singletonKey>` so a repeat request reuses (retargets + focuses)
// the existing window rather than spawning a duplicate.
const auxWindows = new Map<string, BrowserWindow>()

type AuxWindowKind = 'diff' | 'file' | 'pane'

// The OS window's name. Set at construction so the window has one from the
// instant it exists — in the taskbar, in the window switcher, in Mission
// Control. The diff renderer narrows it to `Commit: <file>` as soon as it knows
// which file it is showing (the page owns the title once it sets one); a pane
// window names itself after its tab, or its workspace.
const AUX_WINDOW_TITLES: Record<AuxWindowKind, string> = {
  diff: 'Diff',
  file: 'Editor',
  pane: 'Pane',
}

// The renderer shell's own `<title>`. One index.html serves every window, so
// loading it announces this name to the OS and overwrites whatever the window
// was constructed with — which is how a diff window came to read "SprintEngine"
// until its React tree got around to naming itself. This is the one title an
// aux window refuses; every other one is the page naming itself.
const RENDERER_SHELL_TITLE = 'SprintEngine'

type CreateAuxWindowOptions = {
  kind: AuxWindowKind
  singletonKey: string
  params: Record<string, string>
  bounds?: { x: number; y: number; width: number; height: number } | null
  /**
   * Whether the window may take the keyboard. True (the default) for the
   * person's own clicks: they asked for the window, so it comes forward. False
   * for an agent's reveal, which must never take focus or raise a window: an
   * open window is retargeted where it stands (a minimized one stays
   * minimized), and a new one is shown inactive.
   */
  focus?: boolean
}

/** Is this window one this process opened as an aux window? The registry is
 *  already here and the answer is a Map scan of at most a handful of entries,
 *  so the dock-diff hand-off can ask before it broadcasts anything. */
export function isAuxWindow(win: BrowserWindow): boolean {
  for (const candidate of auxWindows.values()) if (candidate === win) return true
  return false
}

export function openAuxWindow({ kind, singletonKey, params, bounds = null, focus = true }: CreateAuxWindowOptions): {
  retargeted: boolean
} {
  const registryKey = `${kind}:${singletonKey}`
  const existing = auxWindows.get(registryKey)
  if (existing && !existing.isDestroyed()) {
    if (focus && existing.isMinimized()) existing.restore()
    existing.webContents.send('aux:retarget', { kind, params })
    if (focus) existing.focus()
    return { retargeted: true }
  }

  // A popped-out pane mounts the pane's own tabs, browser and terminal
  // included, so it is a browser host the way a workspace window is: the
  // `<webview>` tag, under the same guest policy. No other aux kind gets it.
  const hostsPane = kind === 'pane'
  const safeBounds = normalizeWindowBounds(bounds)
  const win = new BrowserWindow({
    title: AUX_WINDOW_TITLES[kind],
    width: safeBounds?.width ?? 1100,
    height: safeBounds?.height ?? 720,
    ...(safeBounds ? { x: safeBounds.x, y: safeBounds.y } : {}),
    minWidth: 700,
    minHeight: 480,
    show: false,
    ...(process.platform !== 'darwin'
      ? { frame: false }
      : {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 11 },
        }),
    autoHideMenuBar: process.platform !== 'darwin',
    // The theme's own canvas (the workspace window's last push), so a light
    // theme does not open, or resize, on a dark ground before the page paints.
    // An aux window takes no vibrancy, whatever the material: always opaque.
    backgroundColor: getWindowCanvasColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Which process owns the server's IPC channels this session (ipc-router.ts).
      additionalArguments: [...serverModeWindowArguments(), ...sshPreviewWindowArguments()],
      sandbox: false,
      // A diff or editor window hosts no terminal and no background work, so it
      // has no reason to keep painting while hidden. See the workspace window
      // above for why throttling is on there too — and for why a pane window,
      // which can host a terminal, is fine with it: it is told when it is out
      // of sight (below) and stops feeding its terminals the same way.
      backgroundThrottling: true,
      // A popped-out pane hosts browser guests, so it keeps their fullscreen
      // inside the window the way a workspace window does.
      ...(hostsPane ? { webviewTag: true, disableHtmlFullscreenWindowResize: true } : {}),
    },
  })
  auxWindows.set(registryKey, win)
  if (hostsPane) {
    panePopOutWindows.add(win)
    win.on('closed', () => panePopOutWindows.delete(win))
    allowOnlyEmbeddedBrowserGuests(win)
    // The window's chrome follows its state: the traffic-light inset drops
    // in full screen, and the win/linux caption buttons swap Maximise for
    // Restore. And a terminal tab stops being fed while the window is out of
    // sight, which the page cannot tell on its own (sendWindowHidden).
    win.on('enter-full-screen', () => sendWindowState(win))
    win.on('leave-full-screen', () => sendWindowState(win))
    win.on('maximize', () => sendWindowState(win))
    win.on('unmaximize', () => sendWindowState(win))
    win.on('minimize', () => sendWindowHidden(win))
    win.on('restore', () => sendWindowHidden(win))
    win.on('hide', () => sendWindowHidden(win))
    win.on('show', () => sendWindowHidden(win))
  }

  win.on('ready-to-show', () => {
    if (!focus) {
      win.showInactive()
      return
    }
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (auxWindows.get(registryKey) === win) auxWindows.delete(registryKey)
  })

  // Keep the constructed name against the shell's. `preventDefault` stops the
  // shell's title from reaching the window at all; a title the aux page sets
  // for itself (`Commit: <file>`) is not this string and still wins, so the
  // page keeps ownership the moment it takes it.
  win.webContents.on('page-title-updated', (event, title) => {
    if (title.trim() !== RENDERER_SHELL_TITLE) return
    event.preventDefault()
    if (!win.isDestroyed()) win.setTitle(AUX_WINDOW_TITLES[kind])
  })
  // The net under it, for a load that hands the window the shell's name
  // without an event we saw (a restored title, a reload): once the page is up,
  // if the window is still wearing the shell's name, take it back.
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return
    if (win.getTitle().trim() === RENDERER_SHELL_TITLE) win.setTitle(AUX_WINDOW_TITLES[kind])
  })

  const schedulePlacementUpdate = createPlacementUpdateScheduler(win)
  win.on('move', schedulePlacementUpdate)
  win.on('resize', schedulePlacementUpdate)

  guardPrivilegedWindow(win.webContents, appDocument(), (url) => shell.openExternal(url))

  const query: Record<string, string> = { aux: kind, ...params }
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('aux', kind)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  return { retargeted: false }
}

/**
 * Open the window a pane (or one of its tabs) pops out into, and hand it back:
 * the pop-out broker watches it close. One window per pop-out id — the id is
 * the singleton key, so a repeat ask raises the window instead of opening a
 * second.
 */
export function openPanePopOutWindow(input: {
  popOutId: string
  workspaceId: string
  bounds: { x: number; y: number; width: number; height: number } | null
}): BrowserWindow {
  openAuxWindow({
    kind: 'pane',
    singletonKey: input.popOutId,
    params: { popOutId: input.popOutId, workspaceId: input.workspaceId },
    bounds: input.bounds,
  })
  const win = auxWindows.get(`pane:${input.popOutId}`)
  if (!win) throw new Error('pane_window_not_opened')
  return win
}

function createPlacementUpdateScheduler(win: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      sendWindowPlacement(win)
    }, 250)
  }
}

function normalizeWindowBounds(
  bounds: { x: number; y: number; width: number; height: number } | null | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!bounds) return null
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(Number.isFinite)) return null
  const next = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(800, Math.round(width)),
    height: Math.max(600, Math.round(height)),
  }
  const display = screen.getDisplayMatching(next)
  const area = display.workArea
  return {
    ...next,
    x: Math.min(Math.max(next.x, area.x), area.x + Math.max(0, area.width - next.width)),
    y: Math.min(Math.max(next.y, area.y), area.y + Math.max(0, area.height - next.height)),
  }
}

// Push a main→renderer event to every workspace window (the embedded browser's
// open/viewport requests, which any window hosting the workspace may answer).
/** The live workspace windows — never an aux window, the splash or the canvas worker. */
export function listWorkspaceWindows(): BrowserWindow[] {
  return [...workspaceWindows].filter((win) => !win.isDestroyed())
}

export function broadcastToWorkspaceWindows(channel: string, payload: unknown): void {
  for (const win of workspaceWindows) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
