import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.bulkSelect', async () => {
  // Several chats at once: Shift-click takes the range from the chat in
  // front, Cmd-click adds or drops one, and a right-click on the selection
  // opens one menu for all of them. A plain click is what it always was.

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

  const marked: string[] = []
  const opened: string[] = []
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [],
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
    workspaceMarkUnread: async (workspaceId: string) => {
      marked.push(workspaceId)
      return { ok: true, workspaceId, lastVisitedAt: 0 }
    },
  }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  const highlights: Array<[string, unknown]> = []
  useWorkspaceStore.setState({
    recordWorkspaceVisit: () => undefined,
    setWorkspaceHighlight: (id: string, patch: unknown) => {
      highlights.push([id, patch])
    },
  } as never)

  const createdAt = Date.now() - 60 * 60_000
  const workspace = (id: string, name: string) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath: '/projA',
      createdAt,
      lastUserMessageAt: createdAt,
      lastTurnEndedAt: 5_000,
      lastVisitedAt: 9_000,
    }) as unknown as Workspace
  const noop = () => {}
  const workspaces = [
    workspace('w1', 'Alpha'),
    workspace('w2', 'Bravo'),
    workspace('w3', 'Charlie'),
    workspace('w4', 'Delta'),
  ]
  const props = {
    workspaces,
    activeWorkspaceId: 'w1',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activityByWorkspaceId: { w1: 'idle', w2: 'idle', w3: 'idle', w4: 'idle' },
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: (id: string) => opened.push(id),
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
  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]')]
  const rowOf = (name: string) => rows().find((row) => row.textContent?.includes(name))!
  const click = async (name: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
    act(() => {
      rowOf(name).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }))
    })
    await settle()
  }
  const selected = () =>
    rows()
      .filter((row) => row.getAttribute('aria-selected') === 'true')
      .map((row) => row.dataset.workspaceId)
  const menuItems = async (name: string): Promise<HTMLElement[]> => {
    act(() => {
      rowOf(name).dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
    })
    await settle()
    return [...dom.window.document.querySelectorAll<HTMLElement>('[role="menu"] [data-menu-item="true"]')]
  }

  try {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
    const order = rows().map((row) => row.dataset.workspaceId)
    assert.deepEqual(order, ['w1', 'w2', 'w3', 'w4'])
    assert.equal(container.querySelector('[role="tree"]')?.getAttribute('aria-multiselectable'), 'true')
    assert.deepEqual(selected(), [], 'no row claims a selected state until there is a selection')
    assert.equal(rows()[0]!.hasAttribute('aria-selected'), false)

    // Shift-click: the range from the chat in front, without opening anything.
    await click('Charlie', { shiftKey: true })
    assert.deepEqual(selected(), ['w1', 'w2', 'w3'])
    assert.deepEqual(opened, [], 'a selection change opens no chat')
    assert.equal(rows().filter((row) => row.tabIndex === 0).length, 1, 'one tab stop still')

    // Cmd-click drops one and adds another.
    await click('Bravo', { metaKey: true })
    await click('Delta', { metaKey: true })
    assert.deepEqual(selected(), ['w1', 'w3', 'w4'])

    // One menu for the selection, saying what reaches how many.
    const items = await menuItems('Delta')
    const labels = items.map((item) => item.textContent?.trim())
    assert.ok(labels.includes('Star'), labels.join(', '))
    assert.ok(labels.some((label) => label?.startsWith('Settle')))
    assert.ok(labels.some((label) => label?.startsWith('Snooze')))
    assert.ok(labels.some((label) => label?.startsWith('Mark unread')))
    assert.ok(!labels.some((label) => label?.startsWith('Rename')), 'what is about one chat stays on its own menu')
    act(() => items.find((item) => item.textContent?.trim() === 'Star')!.click())
    await settle()
    assert.deepEqual(
      highlights.map(([id]) => id),
      ['w1', 'w3', 'w4'],
    )
    assert.deepEqual(highlights[0]![1], { starred: true })

    // Mark unread reaches the selected chats with a finish; the one in front
    // waits until the person leaves it, as its own menu's does.
    act(() => {
      rowOf('Delta').dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
    })
    await settle()
    const unread = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menu"] [data-menu-item="true"]')].find(
      (item) => item.textContent?.trim().startsWith('Mark unread'),
    )!
    act(() => unread.click())
    await settle()
    assert.deepEqual(marked.sort(), ['w3', 'w4'])

    // Escape lets go of the selection.
    act(() => {
      rowOf('Delta').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    assert.deepEqual(selected(), [])

    // A right-click outside a selection is that row's own menu.
    await click('Bravo', { metaKey: true })
    await click('Charlie', { metaKey: true })
    assert.deepEqual(selected(), ['w1', 'w2', 'w3'])
    const own = (await menuItems('Delta')).map((item) => item.textContent?.trim())
    assert.ok(
      own.some((label) => label?.startsWith('Rename')),
      'the unselected row opens its own menu',
    )
    assert.deepEqual(selected(), [], 'and the selection ends')
    act(() => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()

    // A plain click opens the chat and ends a selection.
    await click('Bravo', { shiftKey: true })
    assert.deepEqual(selected(), ['w1', 'w2'])
    await click('Delta')
    assert.deepEqual(opened, ['w4'])
    assert.deepEqual(selected(), [])
  } finally {
    act(() => root.unmount())
  }
})
