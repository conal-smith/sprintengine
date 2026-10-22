import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.messageOrder', async () => {
  // Every list in the sidebar orders by when the person last sent a message into
  // each chat, newest first, and by nothing else (owner ruling 2026-09-09:
  // "they keep moving up and down in my side panel... they should just stay put
  // where they are based on when I send them a message last").
  //
  // The rows used to band by what wanted you — blocked, then finished-while-you-
  // were-away, then running, then at rest — so an agent finishing lifted its row
  // over chats the person had spoken in more recently. That lift was the jump the
  // owner saw. The tints stayed and the banding went, which also retired the
  // "held seat" that froze a selected row's band: with nothing reordering on
  // status there is nothing to freeze, and the row that keeps its seat on a click
  // (`workspace-row-move-on-click`, id 88) now does so for free.

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

  // Bravo's agent is alive and hook-reported idle: the "genuinely finished, not
  // killed" shape that earns the green mark when its working clock stops. The
  // mark is what used to move the row; here it must only recolour it.
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [
      {
        sessionId: 's2',
        workspaceId: 'w2',
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

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const MINUTE = 60 * 1000
    const createdAt = Date.now() - 60 * MINUTE
    // Distinct message stamps, so the order the assertions read is the message
    // order and nothing else. Alpha was spoken in most recently, Delta least.
    const workspace = (id: string, name: string, minutesAgo: number, starred = false) =>
      ({
        id,
        name,
        mode: 'standard',
        folderPath: '/projA',
        createdAt,
        lastUserMessageAt: Date.now() - minutesAgo * MINUTE,
        ...(starred ? { highlight: { starred: true } } : {}),
      }) as unknown as Workspace

    // Declared deliberately out of message order, so an assertion below can only
    // pass if something actually sorted: stored order alone would read
    // Delta, Bravo, Alpha, Charlie.
    const workspaces = [
      workspace('w4', 'Delta', 4, true),
      workspace('w2', 'Bravo', 2, true),
      workspace('w1', 'Alpha', 1),
      workspace('w3', 'Charlie', 3),
    ]

    const recency = (workingSince: number | null) => ({
      hasRunning: workingSince !== null,
      idleSince: workingSince === null ? createdAt : null,
      lastInputAt: createdAt,
      workingSince,
    })

    const noop = () => {}
    const baseProps = {
      workspaces,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      residentWorkspaceIds: new Set<string>(),
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
    }

    // Alpha runs, Bravo runs, Charlie is blocked on a prompt, Delta rests.
    const whileBravoWorks = {
      ...baseProps,
      activeWorkspaceId: 'w4',
      activityByWorkspaceId: { w1: 'working', w2: 'working', w3: 'needs-input', w4: 'idle' },
      terminalRecencyByWorkspaceId: { w1: recency(createdAt), w2: recency(createdAt), w4: recency(null) },
    } as unknown as SidebarProps

    // Bravo's working clock stops against a hook-settled session: it earns the
    // green mark. The mark is the whole point — the row must not move with it.
    const afterBravoFinishes = {
      ...whileBravoWorks,
      activityByWorkspaceId: { w1: 'working', w2: 'idle', w3: 'needs-input', w4: 'idle' },
      terminalRecencyByWorkspaceId: { w1: recency(createdAt), w2: recency(null), w4: recency(null) },
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

    const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta']
    const namesIn = (scope: Element | null): string[] =>
      scope === null
        ? []
        : [...scope.querySelectorAll('[role="treeitem"]')]
            .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
            .filter((name): name is string => name !== undefined)

    // The folder's own rows, read top to bottom the way someone scanning the
    // sidebar does. Starred chats have moved out of the folder, so they are
    // scoped out here and asserted on separately.
    const rowOrder = (): string[] => {
      const starredBody = container.querySelector('#ws-starred-body')
      const starred = new Set(starredBody ? [...starredBody.querySelectorAll('[role="treeitem"]')] : [])
      return [...container.querySelectorAll('[role="treeitem"]')]
        .filter((row) => !starred.has(row))
        .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)
    }

    const starredOrder = (): string[] => namesIn(container.querySelector('#ws-starred-body'))

    // The row element for one chat, for reading the classes its state paints on
    // it. A starred chat has one row, in Starred; an unstarred chat has one row
    // in its folder.
    const rowFor = (name: string): Element | undefined =>
      [...container.querySelectorAll('[role="treeitem"]')].find((row) => row.textContent?.includes(name))

    try {
      await render(whileBravoWorks)
      assert.deepEqual(
        rowOrder(),
        ['Alpha', 'Charlie'],
        'message order, newest first — Bravo and Delta have moved to Starred, and a running agent sits where the person left it',
      )
      assert.deepEqual(starredOrder(), ['Bravo', 'Delta'], 'starred chats live only in Starred, same clock')

      await render(afterBravoFinishes)
      assert.deepEqual(rowOrder(), ['Alpha', 'Charlie'], 'the folder does not reflow when a starred row finishes')
      assert.deepEqual(
        starredOrder(),
        ['Bravo', 'Delta'],
        'the row that just finished goes green in place: same row above it, same row below',
      )
      // "In place" is only half of it — the other half is that the row goes
      // green at all. Losing the tint with the banding would satisfy every
      // order assertion in this file, so check the mark is really on the row.
      assert.ok(
        rowFor('Bravo')?.className.includes('tone-good-faint'),
        'the finished row wears the unseen-done tint (doneRowClass)',
      )

      // Selecting Bravo clears its green mark. Nothing moved when the mark
      // arrived, so nothing may move when it goes.
      await render({ ...afterBravoFinishes, activeWorkspaceId: 'w2' } as unknown as SidebarProps)
      assert.deepEqual(
        rowOrder(),
        ['Alpha', 'Charlie'],
        'the folder does not reflow under the cursor that just clicked',
      )
      assert.deepEqual(starredOrder(), ['Bravo', 'Delta'], 'and Starred does not reflow either')

      // Charlie is the blocked row throughout, and stays second in the folder
      // throughout: gold tints a row, it never lifts one.
      await render({ ...afterBravoFinishes, activeWorkspaceId: 'w4' } as unknown as SidebarProps)
      assert.deepEqual(rowOrder(), ['Alpha', 'Charlie'], 'a row waiting on you keeps its seat too')

      assert.deepEqual(starredOrder(), ['Bravo', 'Delta'], 'the Starred band reads the same clock as the folders')

      // The one event that moves a row: the person sends a message in Delta,
      // which lifts it to the top of the Starred band. The folder is unchanged
      // because Delta lives there now, not under the project.
      const afterDeltaMessage = {
        ...afterBravoFinishes,
        workspaces: workspaces.map((ws) =>
          ws.id === 'w4' ? ({ ...ws, lastUserMessageAt: Date.now() } as unknown as Workspace) : ws,
        ),
      } as unknown as SidebarProps
      await render(afterDeltaMessage)
      assert.deepEqual(rowOrder(), ['Alpha', 'Charlie'], 'a starred chat leaving its seat does not reorder the folder')
      assert.deepEqual(starredOrder(), ['Delta', 'Bravo'], 'sending a message moves it to the top of Starred')

      // The same clock still orders the folder, once the person speaks in an
      // unstarred chat.
      const afterCharlieMessage = {
        ...afterDeltaMessage,
        workspaces: afterDeltaMessage.workspaces.map((ws) =>
          ws.id === 'w3' ? ({ ...ws, lastUserMessageAt: Date.now() } as unknown as Workspace) : ws,
        ),
      } as unknown as SidebarProps
      await render(afterCharlieMessage)
      assert.deepEqual(
        rowOrder(),
        ['Charlie', 'Alpha'],
        'sending a message is the only thing that moves a folder row, and it moves it to the top',
      )
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar message order tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
