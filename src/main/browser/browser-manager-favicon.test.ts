import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'

// A tab in another partition than the pane's own fetches its icon on its own
// session: the session that holds the page's cookies and proxy.

const fetched: string[] = []
const sessionNamed = (name: string) =>
  Object.assign(new EventEmitter(), {
    getUserAgent: () => 'Mozilla/5.0 Chrome/140.0',
    setUserAgent: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    fetch: async () => {
      fetched.push(name)
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    },
  })
const paneSession = sessionNamed('pane')
const tabSession = sessionNamed('tab')
const host = { id: 1, isDestroyed: () => false, send: () => {} }
const guest = Object.assign(new EventEmitter(), {
  id: 7,
  session: tabSession,
  hostWebContents: host,
  getType: () => 'webview',
  isDestroyed: () => false,
  isLoading: () => false,
  isDevToolsOpened: () => false,
  getURL: () => 'http://localhost:5173/',
  getTitle: () => 'App',
  navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  setWindowOpenHandler: () => {},
  setZoomFactor: () => {},
})

vi.mock('electron', () => ({
  session: { fromPartition: () => paneSession },
  webContents: { fromId: (id: number) => (id === guest.id ? guest : undefined) },
}))

const { createBrowserManager } = await import('./browser-manager')

test("a tab's icon is fetched on the tab's own session", async () => {
  const manager = createBrowserManager({
    listTerminalRoots: () => [],
    isHostWindow: () => true,
    broadcast: () => {},
    resolveWorkspaceRoot: () => null,
  })
  expect(manager.register({ tabId: 't1', workspaceId: 'w1', webContentsId: guest.id }, host as never).ok).toBe(true)
  guest.emit('page-favicon-updated', {}, ['http://localhost:5173/favicon.png'])
  await vi.waitFor(() => expect(fetched).toEqual(['tab']))
  manager.unregister('t1')
})
