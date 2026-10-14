import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'

// The pane's session and two guests, reduced to what registering a tab and
// setting its zoom touch.
const browserSession = Object.assign(new EventEmitter(), {
  getUserAgent: () => 'Mozilla/5.0 Chrome/140.0',
  setUserAgent: () => {},
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
})
const hostOf = (id: number) => ({ id, isDestroyed: () => false, send: () => {} })
const mainWindow = hostOf(1)
const poppedOut = hostOf(2)
function guestOf(id: number, host: object) {
  return Object.assign(new EventEmitter(), {
    id,
    zoom: 1,
    session: browserSession,
    hostWebContents: host,
    getType: () => 'webview',
    isDestroyed: () => false,
    isLoading: () => false,
    isDevToolsOpened: () => false,
    getURL: () => 'http://localhost:5173/',
    getTitle: () => 'App',
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: () => {},
    setZoomFactor(factor: number) {
      this.zoom = factor
    },
    getZoomFactor() {
      return this.zoom
    },
  })
}
const guests = [guestOf(7, mainWindow), guestOf(8, mainWindow), guestOf(9, poppedOut)]

vi.mock('electron', () => ({
  session: { fromPartition: () => browserSession },
  webContents: { fromId: (id: number) => guests.find((guest) => guest.id === id) },
}))

const { createBrowserManager } = await import('./browser-manager')

test("a change to a window's zoom leaves each of its browser tabs at the tab's own zoom", () => {
  const manager = createBrowserManager({
    listTerminalRoots: () => [],
    isHostWindow: () => true,
    broadcast: () => {},
    resolveWorkspaceRoot: () => null,
  })
  const [first, second, elsewhere] = guests
  manager.register({ tabId: 'a', workspaceId: 'w', webContentsId: first!.id }, mainWindow as never)
  manager.register({ tabId: 'b', workspaceId: 'w', webContentsId: second!.id }, mainWindow as never)
  manager.register({ tabId: 'c', workspaceId: 'w', webContentsId: elsewhere!.id }, poppedOut as never)
  manager.setZoom('a', 1.25)
  manager.zoomStep('b', -1)
  const own = second!.zoom
  // What Electron does to the guests as the main window zooms.
  first!.zoom = 1.5
  second!.zoom = 1.5
  elsewhere!.zoom = 1.75

  manager.reapplyGuestZoom(mainWindow as never)
  expect(first!.zoom).toBe(1.25)
  expect(second!.zoom).toBe(own)
  expect(manager.state('a')?.zoomFactor).toBe(1.25)
  // Another window's tabs are not that window's to touch.
  expect(elsewhere!.zoom).toBe(1.75)
})
