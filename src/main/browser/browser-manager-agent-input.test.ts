import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'

// The pane's session and its guest, reduced to what registering a tab and
// reading its keystrokes touch.
const browserSession = Object.assign(new EventEmitter(), {
  getUserAgent: () => 'Mozilla/5.0 Chrome/140.0',
  setUserAgent: () => {},
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
})
const sent: Array<{ channel: string; payload: unknown }> = []
const host = {
  id: 1,
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
}
const ignoreMenuShortcuts: boolean[] = []
let reloads = 0
const guest = Object.assign(new EventEmitter(), {
  id: 7,
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
  setZoomFactor: () => {},
  setIgnoreMenuShortcuts: (ignore: boolean) => ignoreMenuShortcuts.push(ignore),
  reload: () => {
    reloads += 1
  },
  reloadIgnoringCache: () => {
    reloads += 1
  },
})

vi.mock('electron', () => ({
  session: { fromPartition: () => browserSession },
  webContents: { fromId: (id: number) => (id === guest.id ? guest : undefined) },
}))

const { createBrowserManager } = await import('./browser-manager')

// What the guest's keys sent the app window; the tab's state updates aside.
const keysToHost = () => sent.filter((message) => message.channel !== 'browser:state').map((message) => message.channel)

function press(key: string): boolean {
  let prevented = false
  const primary = process.platform === 'darwin'
  guest.emit(
    'before-input-event',
    { preventDefault: () => (prevented = true) },
    { type: 'keyDown', key, meta: primary, control: !primary, alt: false, shift: false },
  )
  return prevented
}

test("a chord the agent presses is the page's: no app shortcut, no menu accelerator, no human take-over", () => {
  const manager = createBrowserManager({
    listTerminalRoots: () => [],
    isHostWindow: () => true,
    broadcast: () => {},
    resolveWorkspaceRoot: () => null,
  })
  expect(manager.register({ tabId: 't1', workspaceId: 'w1', webContentsId: guest.id }, host as never).ok).toBe(true)
  const tookOver: string[] = []
  manager.onHumanInput((tabId) => tookOver.push(tabId))

  manager.noteAgentInput('t1', 1)
  expect(press('w')).toBe(false)
  expect(press('r')).toBe(false)
  expect(press('l')).toBe(false)
  manager.noteAgentInput('t1', -1)
  expect(keysToHost()).toEqual([])
  expect(reloads).toBe(0)
  expect(tookOver).toEqual([])
  // Menu accelerators are off while the agent types, and back after.
  expect(ignoreMenuShortcuts).toEqual([true, false])

  // The person's own Cmd+W still closes the app's tab, and Cmd+R reloads.
  expect(press('w')).toBe(true)
  expect(keysToHost()).toEqual(['browser:host-key'])
  expect(press('r')).toBe(true)
  expect(reloads).toBe(1)
  expect(tookOver).toEqual(['t1', 't1'])
  manager.unregister('t1')
})
