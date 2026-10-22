import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

// A middle press on a chat row settles the chat, as the row's tick does: it was
// Close until Settle became the one way a row is put away. Chromium on Linux
// pastes the primary selection into the focused field on a middle release
// nobody cancelled, and the press keeps focus in the composer, so putting a
// chat away this way typed the last highlighted text into the next one.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [],
  onTerminalSessionsDelta: () => () => {},
  getWorkspaceChangeSummary: async () => null,
  terminalKill: async () => {},
}

async function mount() {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  // The record's half of a Settle is the store's; heard here rather than
  // written, so the rows stay the props'.
  const settled: string[] = []
  useWorkspaceStore.setState({
    chatListView: 'projects',
    setWorkspaceSettled: (id: string, value: boolean) => {
      if (value) settled.push(id)
    },
  })
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  const createdAt = Date.now()
  const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
    ({ id, name, mode: 'standard', folderPath: '/Users/dev/acme', createdAt, ...fields }) as unknown as Workspace
  const workspaces = [
    workspace('w1', 'Alpha'),
    workspace('w2', 'Bravo'),
    workspace('w7', 'Golf', { folderPath: '/Users/dev/other' }),
  ]
  const noop = () => {}
  const props = {
    workspaces,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activeWorkspaceId: 'w7',
    activityByWorkspaceId: { w1: 'idle', w2: 'working', w7: 'idle' },
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onSetSidebarCollapsed: noop,
    sidebarWidth: 260,
    onSetSidebarWidth: noop,
    authState: { authenticated: false },
    authMessage: null,
    accountOpen: false,
    setAccountOpen: noop,
    startLogin: noop,
    refreshAuthState: noop,
    logout: noop,
    openSettings: noop,
    settingsOpen: false,
  } as unknown as SidebarProps

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      act(() => {})
    }
  }
  act(() => {
    root.render(React.createElement(WorkspaceSidebar, props))
  })
  await settle()
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-workspace-id="${id}"]`)
  const mouse = (target: Element, type: string, button: number): MouseEvent => {
    const event = new dom.window.MouseEvent(type, { button, bubbles: true, cancelable: true })
    act(() => {
      target.dispatchEvent(event)
    })
    return event
  }
  return { settled, row, mouse, settle, unmount: () => act(() => root.unmount()) }
}

test('the middle release after a middle press settles a chat is cancelled, wherever it lands', async () => {
  const sidebar = await mount()
  try {
    sidebar.mouse(sidebar.row('w1')!, 'mousedown', 1)
    assert.deepEqual(sidebar.settled, ['w1'])
    await sidebar.settle()
    // The row may be gone by now; the release lands on whatever is under the pointer.
    const release = sidebar.mouse(sidebar.row('w2')!, 'mouseup', 1)
    assert.equal(release.defaultPrevented, true)
  } finally {
    sidebar.unmount()
  }
})

test('a left press on a chat row leaves its release alone', async () => {
  const sidebar = await mount()
  try {
    sidebar.mouse(sidebar.row('w1')!, 'mousedown', 0)
    assert.equal(sidebar.mouse(sidebar.row('w1')!, 'mouseup', 0).defaultPrevented, false)
    assert.deepEqual(sidebar.settled, [])
  } finally {
    sidebar.unmount()
  }
})

test('a middle press on a chat whose agent is working settles nothing, as its tick does', async () => {
  const sidebar = await mount()
  try {
    const press = sidebar.mouse(sidebar.row('w2')!, 'mousedown', 1)
    assert.equal(press.defaultPrevented, true, 'the press is still taken, so nothing pastes')
    assert.deepEqual(sidebar.settled, [])
  } finally {
    sidebar.unmount()
  }
})
