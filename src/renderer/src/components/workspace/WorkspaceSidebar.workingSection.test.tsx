import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.workingSection', async () => {
  // The Working section, an opt-in: a chat whose agent works folds out of its
  // project into one section at the top, and goes back when the agent
  // finishes or needs the person. Starred chats and the one in front stay.

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
  const setSwitch = (on: boolean) =>
    useWorkspaceStore.setState(
      (state) => ({ appSettings: { ...state.appSettings, sidebarWorkingSection: on } }) as never,
    )

  const createdAt = Date.now() - 60 * 60_000
  const workspace = (id: string, name: string, fields: Record<string, unknown> = {}) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath: '/projA',
      createdAt,
      lastUserMessageAt: createdAt,
      ...fields,
    }) as unknown as Workspace
  const noop = () => {}
  const workspaces = [workspace('w1', 'Alpha'), workspace('w2', 'Bravo'), workspace('w3', 'Charlie')]
  const base = {
    workspaces,
    activeWorkspaceId: 'w1',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activityByWorkspaceId: { w1: 'idle', w2: 'working', w3: 'idle' },
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
  const render = async (props: SidebarProps): Promise<void> => {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
  }
  const section = () => container.querySelector<HTMLElement>('section[aria-label="Working"]')
  const namesIn = (scope: Element | null) =>
    [...(scope?.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]') ?? [])].map(
      (row) => row.dataset.workspaceId,
    )
  const outside = () =>
    namesIn(container.querySelector('[role="tree"]')).filter((id) => !namesIn(section()).includes(id))

  try {
    setSwitch(false)
    await render(base)
    assert.equal(section(), null, 'off by default: no section, and no row moves')
    assert.deepEqual(outside().sort(), ['w1', 'w2', 'w3'])

    setSwitch(true)
    await settle()
    assert.ok(section(), 'switched on, the section is there while an agent works')
    assert.deepEqual(namesIn(section()), ['w2'])
    assert.deepEqual(outside().sort(), ['w1', 'w3'], 'the working chat left its project')
    assert.match(section()!.textContent ?? '', /Working\s*1/u)

    // The agent stops on the person: the chat goes back to its seat.
    await render({ ...base, activityByWorkspaceId: { w1: 'idle', w2: 'needs-input', w3: 'idle' } } as never)
    assert.equal(section(), null)
    assert.deepEqual(outside().sort(), ['w1', 'w2', 'w3'])

    // The chat in front stays where it is, working or not.
    await render({ ...base, activityByWorkspaceId: { w1: 'working', w2: 'idle', w3: 'idle' } } as never)
    assert.equal(section(), null, 'the chat being read does not slide away')

    // A starred chat stays in Starred.
    const starred = [
      workspace('w1', 'Alpha'),
      workspace('w2', 'Bravo', { highlight: { starred: true } }),
      workspaces[2]!,
    ]
    useWorkspaceStore.setState({ workspaces: starred } as never)
    await render({ ...base, workspaces: starred } as never)
    assert.equal(section(), null, 'starred chats are exempt')

    // Folded shut, the count stays and the rows go.
    useWorkspaceStore.setState({ workspaces } as never)
    await render(base)
    const fold = section()!.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    assert.equal(fold.getAttribute('aria-expanded'), 'true', 'open unless the person closed it')
    act(() => fold.click())
    await settle()
    assert.deepEqual(namesIn(section()), [])
    assert.deepEqual(outside().sort(), ['w1', 'w3'], 'folded away, not put back')
  } finally {
    setSwitch(false)
    act(() => root.unmount())
  }
})
