import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.markUnread', async () => {
  // Mark unread is main's (`conversation.mark_unread`, a phone's too): the row
  // menu asks for it, and the mark goes up when the rewound visit clock
  // arrives, from this window or any other device, and after a restart. The
  // chat in front is marked as the person leaves it, since looking at it is
  // what reads it.

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
  const { useChatOpening } = await import('../panels/agentChat/unreadDivider')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  useWorkspaceStore.setState({ recordWorkspaceVisit: () => undefined } as never)

  const createdAt = Date.now() - 60 * 60_000
  const workspace = (id: string, name: string, fields: Record<string, unknown> = {}) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath: '/projA',
      createdAt,
      lastUserMessageAt: createdAt,
      lastTurnEndedAt: 5_000,
      lastVisitedAt: 9_000,
      ...fields,
    }) as unknown as Workspace
  const noop = () => {}
  const base = {
    workspaces: [workspace('w1', 'Alpha'), workspace('w2', 'Bravo'), workspace('w3', 'Charlie')],
    activeWorkspaceId: 'w1',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activityByWorkspaceId: { w1: 'idle', w2: 'idle', w3: 'idle' },
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
  useWorkspaceStore.setState({ workspaces: base.workspaces } as never)

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
  const rowOf = (name: string) =>
    [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((row) => row.textContent?.includes(name))
  const marks = (name: string): boolean => rowOf(name)?.className.includes('tone-good-faint') === true
  const menuOn = async (name: string): Promise<HTMLElement[]> => {
    const row = rowOf(name)
    assert.ok(row, `row ${name} is rendered`)
    act(() => {
      row.dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
    })
    await settle()
    return [...dom.window.document.querySelectorAll<HTMLElement>('[role="menu"] [data-menu-item="true"]')]
  }
  const choose = async (name: string, item: string): Promise<void> => {
    const entry = (await menuOn(name)).find((element) => element.textContent?.trim() === item)
    assert.ok(entry, `${name}'s menu offers ${item}`)
    act(() => entry.click())
    await settle()
  }

  try {
    await render(base)
    await choose('Bravo', 'Mark unread')
    assert.deepEqual(marked, ['w2'], 'asked of main, which owns the visit clock')
    assert.equal(marks('Bravo'), false, 'the mark waits for the clock to come back')

    // Main's answer arrives as the record's rewound clock: just before the
    // latest finish, stamped as a Mark unread. The same arrives when a phone
    // marked it, and is what a restart reads.
    useWorkspaceStore.setState({
      workspaces: [
        base.workspaces[0]!,
        workspace('w2', 'Bravo', { lastVisitedAt: 4_999, visitRewoundAt: 10_000 }),
        base.workspaces[2]!,
      ],
    } as never)
    await settle()
    assert.equal(marks('Bravo'), true, 'its finished mark is back')
    const bravoMenu = (await menuOn('Bravo')).map((element) => element.textContent?.trim())
    assert.equal(bravoMenu.includes('Mark unread'), false, 'a marked row is not offered it again')
    act(() => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()

    // The chat in front: marked as the person leaves it, not before.
    await choose('Alpha', 'Mark unread')
    assert.deepEqual(marked, ['w2'], 'not while it is being looked at')
    await render({ ...base, activeWorkspaceId: 'w3' } as unknown as SidebarProps)
    assert.deepEqual(marked, ['w2', 'w1'], 'leaving it is when it takes effect')

    // A look at New chat is not leaving the chat in front: its opening (where
    // its "New" divider stands) holds, and a Mark unread asked of it waits.
    const probeHost = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(probeHost)
    const probeRoot = createRoot(probeHost)
    function OpeningOf({ id }: { id: string }) {
      const opening = useChatOpening(id)
      return React.createElement('span', null, opening ? String(opening.openedAt) : 'none')
    }
    act(() => probeRoot.render(React.createElement(OpeningOf, { id: 'w3' })))
    const opened = probeHost.textContent
    assert.notEqual(opened, 'none', 'the chat in front has its opening')
    await choose('Charlie', 'Mark unread')
    await render({ ...base, activeWorkspaceId: 'w3', newChatOpen: true } as unknown as SidebarProps)
    assert.deepEqual(marked, ['w2', 'w1'], 'New chat over it is not leaving it')
    assert.equal(probeHost.textContent, opened, 'and its opening holds under New chat')
    await render({ ...base, activeWorkspaceId: 'w3' } as unknown as SidebarProps)
    assert.equal(probeHost.textContent, opened, 'back from New chat, it is the same opening')
    assert.deepEqual(marked, ['w2', 'w1'])
    await render({ ...base, activeWorkspaceId: 'w1' } as unknown as SidebarProps)
    assert.deepEqual(marked, ['w2', 'w1', 'w3'], 'moving on to another chat is leaving it')
    assert.equal(probeHost.textContent, 'none')
    act(() => probeRoot.unmount())
  } finally {
    act(() => root.unmount())
  }
})
