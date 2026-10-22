import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.newChatCover', async () => {
  // The window's chat under New chat is not on screen. A chat started with ⌘⏎
  // into a window that had none is the window's chat, under New chat, as is
  // the one New chat was opened over: neither is stamped as seen while the
  // person types the next task, and a turn that finishes earns the "finished
  // while you were away" mark. Uncovering it is looking at it.

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
  // The window has the keyboard: a chat in front of it would be stamped.
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

  // Alpha's agent is alive and hook-reported idle once its turn ends: the
  // "genuinely finished" shape that earns the mark when its clock stops.
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [
      {
        sessionId: 's1',
        workspaceId: 'w1',
        processAlive: true,
        kind: 'agent',
        cli: 'claude-code',
        activity: { kind: 'idle', since: 1 },
        agentState: { phase: 'idle', since: 1, source: 'hook' },
      },
    ],
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

  const visits: string[] = []
  useWorkspaceStore.setState({ recordWorkspaceVisit: (id: string) => void visits.push(id) } as never)

  const createdAt = Date.now() - 60 * 60_000
  const workspace = (id: string, name: string) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath: '/projA',
      createdAt,
      lastUserMessageAt: createdAt,
    }) as unknown as Workspace
  const recency = (workingSince: number | null) => ({
    hasRunning: workingSince !== null,
    idleSince: workingSince === null ? createdAt : null,
    lastInputAt: createdAt,
    workingSince,
  })
  const noop = () => {}
  const working = {
    workspaces: [workspace('w1', 'Alpha'), workspace('w2', 'Bravo')],
    activeWorkspaceId: 'w1',
    newChatOpen: true,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activityByWorkspaceId: { w1: 'working', w2: 'idle' },
    terminalRecencyByWorkspaceId: { w1: recency(createdAt), w2: recency(null) },
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
  const finished = {
    ...working,
    activityByWorkspaceId: { w1: 'idle', w2: 'idle' },
    terminalRecencyByWorkspaceId: { w1: recency(null), w2: recency(null) },
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
  const render = async (props: SidebarProps): Promise<void> => {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
  }
  const alphaMarked = (): boolean =>
    [...container.querySelectorAll('[role="treeitem"]')]
      .find((row) => row.textContent?.includes('Alpha'))
      ?.className.includes('tone-good-faint') === true

  try {
    await render(working)
    assert.deepEqual(visits, [], 'the chat under New chat is not stamped as seen')
    await render(finished)
    assert.deepEqual(visits, [], 'nor when its turn ends')
    assert.equal(alphaMarked(), true, 'its finish earns the mark, as a chat out of sight does')

    // Leaving New chat uncovers it: now it is looked at.
    await render({ ...finished, newChatOpen: false } as unknown as SidebarProps)
    assert.deepEqual(visits, ['w1'], 'uncovered, it is stamped')
    assert.equal(alphaMarked(), false, 'and its mark comes down')
  } finally {
    act(() => root.unmount())
  }
})
