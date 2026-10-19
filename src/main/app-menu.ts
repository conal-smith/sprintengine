import { BrowserWindow, Menu, type IpcMain } from 'electron'
import type { AppMenuAcceleratorUpdate, AppMenuAcceleratorUpdateResult } from '../shared/electron-api'
import { readStudioEnv } from '../shared/studio-env'

const MENU_ACCELERATOR_COMMAND_IDS = new Set([
  'app.settings.open',
  'pane.toggle',
  'panel.files.toggle',
  'panel.editor.toggle',
  'panel.git.toggle',
  'panel.knowledge-graph.toggle',
])

const menuAcceleratorOverrides = new Map<string, string | null>()

function sendMenuCommand(win: Electron.BaseWindow | null, command: string): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.send('app-menu:command', command)
}

// What a change to a window's zoom has to put back after it: Electron carries
// the window's zoom into the browser pane's pages, which keep their own.
let afterWindowZoom: ((contents: Electron.WebContents) => void) | null = null

/** Set once, by the browser pane: called with a window's contents after the menu zooms it. */
export function setAfterWindowZoom(listener: ((contents: Electron.WebContents) => void) | null): void {
  afterWindowZoom = listener
}

/**
 * The View menu's zoom, on the window rather than on whatever has focus in it
 * (a browser tab's page has its own zoom, in its own menu), in Electron's
 * roles' half-level steps.
 */
export function zoomWindowContents(contents: Electron.WebContents, step: 1 | -1 | 0): void {
  contents.setZoomLevel(step === 0 ? 0 : contents.getZoomLevel() + step * 0.5)
  afterWindowZoom?.(contents)
}

/**
 * Ctrl+wheel over a window's own page reaches it only as a request:
 * Electron leaves applying it to the app. It takes the menu's step, so the
 * browser pane's pages are put back at their own zoom after it. A wheel a
 * page uses for itself (a canvas, a diagram) never asks, and one over a
 * browser tab asks that tab, not the window.
 */
export function zoomWithWheel(contents: Electron.WebContents): void {
  contents.on('zoom-changed', (_event, direction) => {
    if (!contents.isDestroyed()) zoomWindowContents(contents, direction === 'in' ? 1 : -1)
  })
}

// The chat windows open now, set by the lifecycle once windows exist.
let listChatWindows: (() => readonly Electron.BaseWindow[]) | null = null

/**
 * Set once, by the lifecycle: the chat (workspace) windows open now. Ctrl+W
 * reaches the menu only when the app had nothing of its own to close (no
 * closable tab, or no chat open at all), and on Windows and Linux closing the
 * last window quits the app. So the chord closes a pop-out, or one of two chat
 * windows, but leaves the last chat window open.
 */
export function setChatWindowsForCloseChord(list: (() => readonly Electron.BaseWindow[]) | null): void {
  listChatWindows = list
}

function closeChordKeeps(win: Electron.BaseWindow): boolean {
  const chatWindows = listChatWindows?.().filter((candidate) => !candidate.isDestroyed()) ?? []
  return chatWindows.length === 1 && chatWindows[0].id === win.id
}

function closeWindowFromMenu(win: Electron.BaseWindow | null, triggeredByAccelerator: boolean): void {
  if (!win || win.isDestroyed()) return
  if (triggeredByAccelerator && closeChordKeeps(win)) return
  win.close()
}

function zoomFocusedWindow(win: Electron.BaseWindow | null, step: 1 | -1 | 0): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  zoomWindowContents(browserWindow.webContents, step)
}

// `fallback` is the command's default keybinding; omit it for commands that
// ship unbound (the menu item then only shows a user-bound shortcut).
function menuAccelerator(commandId: string, fallback?: string): string | undefined {
  if (menuAcceleratorOverrides.has(commandId)) {
    return menuAcceleratorOverrides.get(commandId) ?? undefined
  }
  return fallback
}

function sanitizeAcceleratorUpdate(input: unknown): AppMenuAcceleratorUpdate | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (typeof record.commandId !== 'string') return null
  if (!MENU_ACCELERATOR_COMMAND_IDS.has(record.commandId)) return null
  if (record.accelerator !== null && typeof record.accelerator !== 'string') return null
  if (typeof record.accelerator === 'string' && record.accelerator.length > 80) return null
  return {
    commandId: record.commandId,
    accelerator: record.accelerator,
  }
}

export function registerAppMenuIpc(ipcMain: IpcMain): void {
  ipcMain.handle('app-menu:update-accelerators', (_event, input: unknown): AppMenuAcceleratorUpdateResult => {
    if (!Array.isArray(input)) return { ok: true }
    for (const item of input) {
      const update = sanitizeAcceleratorUpdate(item)
      if (!update) continue
      menuAcceleratorOverrides.set(update.commandId, update.accelerator)
    }
    Menu.setApplicationMenu(createAppMenu())
    return { ok: true }
  })
}

export function createAppMenu(platform: NodeJS.Platform = process.platform): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: menuAccelerator('app.settings.open', 'CmdOrCtrl+,'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'app.settings.open'),
        },
        { type: 'separator' },
        // On macOS Cmd+W closing the window leaves the app running, as every
        // Mac app does, so the role stays. Elsewhere the item is the role's
        // own label and key, but the key alone leaves the last chat window
        // open; clicking the item still closes it.
        platform === 'darwin'
          ? { role: 'close' }
          : {
              label: 'Close Window',
              accelerator: 'Ctrl+W',
              click: (_, win, event) =>
                closeWindowFromMenu(win ?? BrowserWindow.getFocusedWindow(), event.triggeredByAccelerator === true),
            },
        // On macOS the first menu is the app menu, and Cmd+Q is only a key
        // because an item there carries it; without this item the chord did
        // nothing and quitting took the Dock or the tray. The quit it raises
        // goes through `before-quit`, so it is asked about like any other.
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle File Explorer',
          accelerator: menuAccelerator('panel.files.toggle', 'CmdOrCtrl+Shift+E'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.files.toggle'),
        },
        {
          label: 'Toggle Code Editor',
          accelerator: menuAccelerator('panel.editor.toggle', 'CmdOrCtrl+Shift+O'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.editor.toggle'),
        },
        {
          label: 'Toggle Git Panel',
          accelerator: menuAccelerator('panel.git.toggle', 'CmdOrCtrl+Shift+G'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.git.toggle'),
        },
        {
          label: 'Toggle Workspace Pane',
          accelerator: menuAccelerator('pane.toggle', 'CmdOrCtrl+Alt+B'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'pane.toggle'),
        },
        {
          label: 'Toggle Knowledge Graph',
          accelerator: menuAccelerator('panel.knowledge-graph.toggle'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.knowledge-graph.toggle'),
        },
        { type: 'separator' },
        // Performance diagnostics is an engineering tool; only surface it when
        // diagnostics are on (dev build or SPRINTENGINE_DIAGNOSTICS=1), matching
        // the diagnostics.open command's availability gate.
        ...(process.env.NODE_ENV === 'development' || readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'
          ? [
              {
                label: 'Performance Diagnostics',
                click: (_: unknown, win: Electron.BaseWindow | undefined) =>
                  sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'diagnostics.open'),
              } as Electron.MenuItemConstructorOptions,
              { type: 'separator' } as Electron.MenuItemConstructorOptions,
            ]
          : []),
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Not the roles: each keeps the label and key its role had, and also
        // puts the browser pane's pages back at their own zoom after it.
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: (_, win) => zoomFocusedWindow(win ?? BrowserWindow.getFocusedWindow(), 0),
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: (_, win) => zoomFocusedWindow(win ?? BrowserWindow.getFocusedWindow(), 1),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: (_, win) => zoomFocusedWindow(win ?? BrowserWindow.getFocusedWindow(), -1),
        },
        // The numeric keypad sends key codes of its own, which the number-row
        // keys above never match. Hidden, so the menu lists each command once.
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+num0',
          visible: false,
          click: (_, win) => zoomFocusedWindow(win ?? BrowserWindow.getFocusedWindow(), 0),
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+numadd',
          visible: false,
          click: (_, win) => zoomFocusedWindow(win ?? BrowserWindow.getFocusedWindow(), 1),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+numsub',
          visible: false,
          click: (_, win) => zoomFocusedWindow(win ?? BrowserWindow.getFocusedWindow(), -1),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check For Updates',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'app.updates.check'),
        },
        {
          label: 'About SprintEngine Studio',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'show-about'),
        },
      ],
    },
  ])
}
