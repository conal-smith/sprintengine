import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

// A folded project header says how many of the chats it hides are waiting on
// the person, in words. Unfolded, the rows say it themselves.

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
    workspace('w3', 'Charlie'),
    workspace('w4', 'Delta'),
    // Resting and starred chats are not rows the fold hides, so they do not count.
    workspace('w5', 'Echo', { settledAt: createdAt - 1000 }),
    workspace('w6', 'Foxtrot', { highlight: { starred: true, color: null } }),
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
    activityByWorkspaceId: {
      w1: 'needs-input',
      w2: 'failed',
      w3: 'working',
      w4: 'idle',
      w5: 'needs-input',
      w6: 'needs-input',
      w7: 'idle',
    },
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
  const header = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-controls^="ws-folder-body-"]')].find((button) =>
      button.textContent?.startsWith(name),
    )!
  return {
    header,
    toggle: async (name: string) => {
      act(() => header(name).click())
      await settle()
    },
    unmount: () => act(() => root.unmount()),
  }
}

test('a folded project says how many of its hidden chats are waiting, and an open one says nothing', async () => {
  const sidebar = await mount()
  try {
    const waitingOf = (name: string) =>
      sidebar.header(name).querySelector('[data-project-waiting]')?.textContent ?? null
    assert.equal(waitingOf('acme'), null, 'open, the rows say it themselves')
    await sidebar.toggle('acme')
    assert.equal(sidebar.header('acme').getAttribute('aria-expanded'), 'false')
    assert.equal(waitingOf('acme'), '2 waiting', 'the blocked chat and the failed one, not the resting or starred')
    assert.match(sidebar.header('acme').textContent ?? '', /acme.*2 waiting/u, 'part of what the header says')
    await sidebar.toggle('other')
    assert.equal(waitingOf('other'), null, 'a folded project with nothing waiting says nothing')
    await sidebar.toggle('acme')
    assert.equal(waitingOf('acme'), null, 'unfolded again, the count goes')
  } finally {
    sidebar.unmount()
  }
})
