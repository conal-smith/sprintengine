import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.quietFolders', async () => {
  // Quiet folders (owner ruling, 2026-09-07). A project whose every chat has
  // settled is not drawn in the sidebar at all: its header was a line saying
  // nothing was happening, over a "Settled 1" fold and nothing to do. The same
  // is true of a project whose only live chat has moved to Starred — the row is
  // already on screen, and a header over nothing is that empty folder. It is
  // not archived — the folder is still open, and New chat is where you pick a
  // project to start a conversation in. The folder comes back the moment
  // anything in it is active, selected, or un-settled. The settle rule itself is
  // workspaceSettle.test.ts's; the shelf a half-quiet folder shows is
  // WorkspaceSidebar.settled.test.tsx's.

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

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const DAY = 24 * 60 * 60 * 1000
    const createdAt = Date.now()
    const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
      ({ id, name, mode: 'standard', folderPath: '/projA', createdAt, ...fields }) as unknown as Workspace

    // Relay is a live project: Alpha is its active chat, Bravo has come to rest
    // beside it. Attic is a project that has gone quiet altogether — both its
    // chats rest.
    const workspaces = [
      workspace('w1', 'Alpha'),
      workspace('w2', 'Bravo', { settledAt: createdAt - DAY, lastTerminalActivityAt: createdAt - 5 * DAY }),
      workspace('w3', 'Charlie', {
        folderPath: '/attic',
        settledAt: createdAt - DAY,
        lastTerminalActivityAt: createdAt - 5 * DAY,
      }),
      workspace('w4', 'Delta', {
        folderPath: '/attic',
        settledAt: createdAt - DAY,
        lastTerminalActivityAt: createdAt - 4 * DAY,
      }),
      // A project whose only live chat has moved to Starred is quiet in the
      // tree: the row is already on screen, and a header over nothing is the
      // same empty folder the ruling above removed.
      workspace('w5', 'Echo', { folderPath: '/pinned', highlight: { starred: true, color: null } }),
    ]

    const noop = () => {}
    const props = {
      workspaces,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      residentWorkspaceIds: new Set<string>(),
      activeWorkspaceId: 'w1',
      activityByWorkspaceId: { w1: 'idle', w2: 'idle', w3: 'idle', w4: 'idle' },
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

    const render = async (next: SidebarProps): Promise<void> => {
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, next))
      })
      await settle()
    }

    /** The folder headers the tree draws. */
    const folderNames = (): string[] =>
      [...container.querySelectorAll<HTMLElement>('button[aria-controls^="ws-folder-body-"]')].map(
        (button) => button.textContent?.trim() ?? '',
      )

    const rowNames = (): string[] =>
      [...container.querySelectorAll('[role="treeitem"]')]
        .map((row) => ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)

    const shelfButtons = (): HTMLButtonElement[] =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter((button) =>
        button.textContent?.startsWith('Settled'),
      )

    try {
      await render(props)
      assert.deepEqual(folderNames(), ['projA'], 'the all-settled project is not a folder in the tree')
      assert.deepEqual(
        rowNames(),
        ['Echo', 'Alpha'],
        'the starred chat is a Starred row, not a reason to keep its project header',
      )
      // Settled chats are off the rail (owner, 2026-09-28), so even the live
      // project grows no shelf for its own resting chat.
      assert.equal(shelfButtons().length, 0, 'no project shows a Settled shelf')
      assert.equal(
        dom.window.document.getElementById('ws-resting-body'),
        null,
        'the quiet project is gone, not folded into a band at the foot',
      )

      // Opening the quiet project's chat is what brings it back: the row you are
      // in is never shelved, so the folder has an active row again.
      await render({ ...props, activeWorkspaceId: 'w3' } as unknown as SidebarProps)
      assert.deepEqual(folderNames(), ['projA', 'attic'], 'the selected chat puts its project back in the tree')
      assert.deepEqual(rowNames(), ['Echo', 'Alpha', 'Charlie'], 'Delta stays off the rail')

      // Waking a chat by hand does the same.
      await render({
        ...props,
        workspaces: [workspaces[0], workspaces[1], { ...workspaces[2], settledAt: null }, workspaces[3], workspaces[4]],
      } as unknown as SidebarProps)
      assert.deepEqual(folderNames(), ['projA', 'attic'], 'un-settling a chat wakes its project too')
      assert.deepEqual(
        rowNames(),
        ['Echo', 'Alpha', 'Charlie'],
        'as an active row, with its quiet neighbour still off the rail',
      )

      // Every project quiet: the tree draws no folders at all.
      await render({
        ...props,
        activeWorkspaceId: null,
        workspaces: [{ ...workspaces[0], settledAt: createdAt - DAY }, workspaces[1], workspaces[2], workspaces[3]],
      } as unknown as SidebarProps)
      assert.deepEqual(folderNames(), [], 'no folder headers left in the tree')
      assert.deepEqual(rowNames(), [], 'and no rows either')
      assert.equal(shelfButtons().length, 0, 'no orphan Settled shelf left behind')
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar quiet folder tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
