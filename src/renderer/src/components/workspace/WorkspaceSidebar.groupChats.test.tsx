import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { beforeAll, beforeEach, test } from 'vitest'

// How the rail groups its chats: by project, by status, or all together. The
// default is a setting; the menu beside New chat changes it for one window.
// By status lists what waits on the person and folds every working chat into
// a closed Working shelf at the foot of the list.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

type Harness = Awaited<ReturnType<typeof makeHarness>>
let harness: Harness

async function makeHarness() {
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
  dom.window.document.hasFocus = () => true
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
  }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  useWorkspaceStore.setState({ recordWorkspaceVisit: () => undefined } as never)

  const now = Date.now()
  const workspace = (id: string, name: string, folderPath: string, minutesAgo: number) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath,
      createdAt: now - 120 * 60_000,
      lastUserMessageAt: now - minutesAgo * 60_000,
    }) as unknown as Workspace
  const noop = () => {}
  const workspaces = [
    workspace('w1', 'Alpha', '/projA', 1),
    workspace('w2', 'Bravo', '/projA', 2),
    workspace('w3', 'Charlie', '/projB', 3),
    workspace('w4', 'Delta', '/projB', 4),
  ]
  const base = {
    workspaces,
    activeWorkspaceId: 'w1',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activityByWorkspaceId: { w1: 'idle', w2: 'working', w3: 'needs-input', w4: 'working' },
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
  } as unknown as SidebarProps
  useWorkspaceStore.setState({ workspaces } as never)

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
  const render = async (props: SidebarProps = base): Promise<void> => {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
  }
  const idsIn = (scope: Element | null) =>
    [...(scope?.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]') ?? [])].map(
      (row) => row.dataset.workspaceId,
    )
  const tree = () => container.querySelector('[role="tree"]')
  const byStatus = () => container.querySelector<HTMLElement>('section[aria-label="Chats by status"]')
  const workingShelf = () =>
    byStatus()?.querySelector<HTMLElement>('[role="group"][aria-label="Chats working"]') ?? null
  const workingFold = () =>
    byStatus()?.querySelector<HTMLButtonElement>(`button[aria-controls="${workingShelf()?.id ?? ''}"]`) ?? null
  const trigger = () =>
    container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"][aria-label^="Group chats"]')
  const option = (label: string) =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === label,
    ) ?? null
  const reset = () =>
    useWorkspaceStore.setState({
      chatListView: 'all',
      chatListViewOverride: null,
      workspaces,
    } as never)

  return {
    act,
    useWorkspaceStore,
    render,
    settle,
    tree,
    idsIn,
    byStatus,
    workingShelf,
    workingFold,
    trigger,
    option,
    reset,
  }
}

beforeAll(async () => {
  harness = await makeHarness()
})

beforeEach(() => {
  harness.reset()
})

test('by status leads with what waits on the person and folds working chats away, closed', async () => {
  const { act, useWorkspaceStore, render, settle, tree, idsIn, byStatus, workingShelf, workingFold } = harness
  useWorkspaceStore.setState({ chatListView: 'status' } as never)
  await render()

  assert.ok(byStatus(), 'the stream is drawn as the by-status list')
  assert.deepEqual(
    idsIn(tree()),
    ['w3', 'w1'],
    'the chat waiting on the person leads, ahead of a newer idle one, and the working chats are not in the list while their shelf is shut',
  )
  const fold = workingFold()
  assert.ok(fold, 'a Working shelf sits in the list')
  assert.equal(fold.getAttribute('aria-expanded'), 'false', 'closed until the person opens it')
  assert.match(fold.textContent ?? '', /Working\s*2/u, 'its count says how much is going on')

  act(() => fold.click())
  await settle()
  assert.deepEqual(idsIn(workingShelf()), ['w2', 'w4'], 'opened, newest message first')
  const ids = idsIn(tree())
  assert.ok(ids.indexOf('w3') < ids.indexOf('w2'), 'the shelf sits at the foot of the waiting chats')
})

test('by status does not need the Working section switch, and the switch puts nothing at the top', async () => {
  const { useWorkspaceStore, render, tree } = harness
  useWorkspaceStore.setState(
    (state) =>
      ({ chatListView: 'status', appSettings: { ...state.appSettings, sidebarWorkingSection: true } }) as never,
  )
  try {
    await render()
    assert.equal(tree()!.querySelector('section[aria-label="Working"]'), null, 'one Working place, not two')
  } finally {
    useWorkspaceStore.setState(
      (state) => ({ appSettings: { ...state.appSettings, sidebarWorkingSection: false } }) as never,
    )
  }
})

test('the menu beside New chat regroups this window and leaves the default alone', async () => {
  const { act, useWorkspaceStore, render, settle, tree, byStatus, trigger, option } = harness
  await render()
  assert.ok(tree()!.querySelector('section[aria-label="All chats"]'), 'opens on the default')
  assert.equal(trigger()!.getAttribute('aria-label'), 'Group chats', 'on the default, the glyph does not say active')

  act(() => trigger()!.click())
  await settle()
  for (const label of ['By project', 'By status', 'All chats']) assert.ok(option(label), `${label} is offered`)
  assert.equal(option('All chats')!.getAttribute('aria-checked'), 'true', 'the shape in force is checked')

  act(() => option('By status')!.click())
  await settle()
  assert.ok(byStatus(), 'the list regroups at once')
  assert.equal(useWorkspaceStore.getState().chatListView, 'all', 'the default is untouched')
  assert.equal(useWorkspaceStore.getState().chatListViewOverride, 'status')
  assert.match(trigger()!.getAttribute('aria-label') ?? '', /active/u, 'off the default, the glyph says so')

  act(() => option('By project')!.click())
  await settle()
  assert.equal(byStatus(), null)
  assert.ok(tree()!.querySelector('section header'), 'folders, one header per project')

  act(() => option('All chats')!.click())
  await settle()
  assert.equal(useWorkspaceStore.getState().chatListViewOverride, null, 'picking the default follows it again')
})

test('setting the default in Settings shows it in the window too', () => {
  const { useWorkspaceStore } = harness
  const store = useWorkspaceStore.getState()
  store.setChatListViewOverride('projects')
  assert.equal(useWorkspaceStore.getState().chatListViewOverride, 'projects')
  store.setChatListView('status')
  assert.equal(useWorkspaceStore.getState().chatListView, 'status')
  assert.equal(useWorkspaceStore.getState().chatListViewOverride, null)
})
