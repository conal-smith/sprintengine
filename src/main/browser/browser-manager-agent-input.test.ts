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
// The guest's debugger, for the control layer: its page answers after any
// input already sent to it has been handled.
const guestDebugger = Object.assign(new EventEmitter(), {
  attached: false,
  methods: [] as string[],
  isAttached() {
    return this.attached
  },
  attach() {
    this.attached = true
  },
  detach() {
    this.attached = false
  },
  async sendCommand(method: string, params?: { expression?: string }) {
    this.methods.push(method)
    await new Promise((resolve) => setImmediate(resolve))
    return method === 'Runtime.evaluate'
      ? { result: { value: Boolean(params?.expression?.includes('activeElement')) } }
      : {}
  },
})
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
  debugger: guestDebugger,
  // The person is in the app, not the page.
  focusedFrame: null,
  insertText: async () => {},
  // Electron's direct input: the page sees the key a moment later, through
  // `before-input-event` as a key from the keyboard would be.
  sendInputEvent: (event: { type: string; keyCode: string; modifiers?: string[] }) => {
    if (event.type === 'char') return
    const has = (name: string) => event.modifiers?.includes(name) ?? false
    const input = {
      type: event.type === 'keyUp' ? 'keyUp' : 'keyDown',
      key: event.keyCode,
      meta: has('meta'),
      control: has('control'),
      alt: has('alt'),
      shift: has('shift'),
    }
    setImmediate(() => guest.emit('before-input-event', { preventDefault: () => {} }, input))
  },
})

vi.mock('electron', () => ({
  session: { fromPartition: () => browserSession },
  webContents: { fromId: (id: number) => (id === guest.id ? guest : undefined) },
}))

const { createBrowserManager } = await import('./browser-manager')
const { createBrowserControl } = await import('./browser-control')

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

test("a chord the agent presses on a page without focus is still the agent's, not the person taking over", async () => {
  const manager = createBrowserManager({
    listTerminalRoots: () => [],
    isHostWindow: () => true,
    broadcast: () => {},
    resolveWorkspaceRoot: () => null,
  })
  expect(manager.register({ tabId: 't1', workspaceId: 'w1', webContentsId: guest.id }, host as never).ok).toBe(true)
  const control = createBrowserControl(manager)
  const tookOver: string[] = []
  manager.onHumanInput((tabId) => tookOver.push(tabId))
  sent.length = 0
  ignoreMenuShortcuts.length = 0

  const chord = process.platform === 'darwin' ? 'Meta+w' : 'Ctrl+w'
  const pressed = await control.press('t1', chord)
  expect(pressed.ok).toBe(true)
  // The keys went to the page itself, not through the debugger to the app's focus.
  expect(guestDebugger.methods).not.toContain('Input.dispatchKeyEvent')
  expect(keysToHost()).toEqual([])
  expect(tookOver).toEqual([])
  expect(ignoreMenuShortcuts).toEqual([true, false, true, false])
  control.forget('t1')
  manager.unregister('t1')
})
