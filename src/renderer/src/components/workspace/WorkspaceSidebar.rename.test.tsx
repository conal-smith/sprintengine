import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

// A rename holds the sidebar's clicks only while its field is on screen. A
// field that went away with its row (a folded project, a list that moved)
// can never blur, so a guard that outlived it left every chat unclickable.

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
  useWorkspaceStore.setState({ chatListView: 'projects' })
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
  const selected: string[] = []
  const props = {
    workspaces,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activeWorkspaceId: 'w7',
    activityByWorkspaceId: { w1: 'idle', w2: 'idle', w7: 'idle' },
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: (id: string) => selected.push(id),
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onCloseWorkspace: noop,
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
  const header = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-controls^="ws-folder-body-"]')].find((button) =>
      button.textContent?.startsWith(name),
    )!
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-workspace-id="${id}"]`)
  return {
    selected,
    row,
    renameField: () => container.querySelector<HTMLInputElement>('input'),
    doubleClick: async (element: HTMLElement) => {
      act(() => {
        element.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
      })
      await settle()
    },
    click: async (element: HTMLElement) => {
      act(() => element.click())
      await settle()
    },
    header,
    toggle: async (name: string) => {
      act(() => header(name).click())
      await settle()
    },
    unmount: () => act(() => root.unmount()),
  }
}

test('a rename whose row went away no longer swallows a click on another chat', async () => {
  const sidebar = await mount()
  try {
    await sidebar.doubleClick(sidebar.row('w1')!)
    assert.equal(sidebar.renameField()?.value, 'Alpha', 'a double-click opens the rename field')
    // Folding the project takes the row, and the field, off screen unblurred.
    await sidebar.toggle('acme')
    assert.equal(sidebar.renameField(), null)
    await sidebar.click(sidebar.row('w7')!)
    assert.deepEqual(sidebar.selected.slice(-1), ['w7'], 'the click opens the chat')
    // And the rename is over: unfolded, Alpha is a row again, not a field.
    await sidebar.toggle('acme')
    assert.equal(sidebar.renameField(), null)
    await sidebar.click(sidebar.row('w2')!)
    assert.deepEqual(sidebar.selected.slice(-1), ['w2'])
  } finally {
    sidebar.unmount()
  }
})

test('a rename on screen still keeps a click inside its own row', async () => {
  const sidebar = await mount()
  try {
    await sidebar.doubleClick(sidebar.row('w1')!)
    const before = sidebar.selected.length
    await sidebar.click(sidebar.row('w1')!)
    assert.equal(sidebar.selected.length, before, 'clicking the row being renamed does not navigate')
    assert.equal(sidebar.renameField()?.value, 'Alpha', 'and the field stays open')
  } finally {
    sidebar.unmount()
  }
})
