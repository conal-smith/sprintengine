import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.liveRows', async () => {
  // Owner ruling 2026-09-04 (the-diff-an-agent-made, decision 9): the sidebar
  // row's terminal lines — mark · name · branch · ±lines — exist only while
  // the row has an open terminal. Before this, every parked chat on one checkout
  // read the checkout's CURRENT numbers after a restart (ten rows on `sprintengine`
  // all `+37 −3`, most of them with no agent alive), because the git poll
  // asked about every row and line 2 rendered whenever a branch came back.
  //
  // This mounts the real sidebar with a stubbed terminal bridge: one live
  // session, one exited one, and one row with no session at all. It proves that
  // the live row is the only one with a second line, and that the poll never
  // asks about a checkout no live row sits on.

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

  const session = (sessionId: string, workspaceId: string, processAlive: boolean) => ({
    sessionId,
    workspaceId,
    processAlive,
    kind: 'agent',
    cli: 'claude-code',
    activity: processAlive ? { kind: 'idle', since: 1 } : { kind: 'exited', at: 1, exitCode: 0 },
  })

  const summaryRequests: string[] = []
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [
      // Alpha's agent is alive; Bravo's has exited (a parked chat after a
      // restart looks exactly like this); Charlie never had one.
      session('s1', 'w1', true),
      session('s2', 'w2', false),
    ],
    onTerminalSessionsDelta: () => () => {},
    // This suite settles more microtask rounds than its siblings (the terminal
    // list, then the membership effect, then the sweep), which is long enough
    // for a lazily mounted nav entry to open its own subscription.
    getWorkspaceChangeSummary: async (checkoutPath: string) => {
      summaryRequests.push(checkoutPath)
      return {
        branch: 'main',
        additions: 728,
        deletions: 3590,
        changedFiles: 40,
        files: { added: 12, updated: 25, removed: 3 },
        scope: 'branch',
      }
    },
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar, rowHasOpenTerminals, rowOpenTerminals } = await import('./WorkspaceSidebar')
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const workspace = (id: string, name: string, folderPath: string, extra?: Record<string, unknown>) =>
      ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown as Workspace

    // The pure rule, before the DOM: local live sessions and mounted mesh panes
    // are open terminals; nothing else is.
    const meshLayout = {
      layout: {
        type: 'tabset',
        children: [
          {
            type: 'tab',
            id: 'mesh-conversation:c1:rw9:agent-9',
            component: 'mesh-conversation',
            config: {
              connectionId: 'c1',
              machineName: 'Air',
              remoteWorkspaceId: 'rw9',
              remoteAgentId: 'agent-9',
              remoteSessionId: 'conversation:rw9:agent-9',
              title: 'Remote chat',
            },
          },
        ],
      },
    }
    // A remote terminal tab persisted by an older build is a stale tab: the
    // layout draws "Panel unavailable" for it, and the row does not count it.
    const staleLayout = {
      layout: {
        type: 'tabset',
        children: [
          {
            type: 'tab',
            id: 'mesh-terminal:c1:s9',
            component: 'mesh-terminal',
            config: { connectionId: 'c1', machineName: 'Air', remoteSessionId: 's9', cli: 'codex' },
          },
        ],
      },
    }
    const live = new Map([['w1', [{ sessionId: 's1', cli: 'claude-code' }]]])
    assert.equal(rowHasOpenTerminals(workspace('w1', 'a', '/p'), live), true)
    assert.equal(
      rowHasOpenTerminals(workspace('w2', 'b', '/p'), live),
      false,
      'an exited session was filtered before the map was built',
    )
    assert.equal(
      rowHasOpenTerminals(workspace('w3', 'c', '/p', { layoutModel: meshLayout }), live),
      true,
      'a mounted mesh pane is an open terminal',
    )
    assert.deepEqual(rowOpenTerminals(workspace('w3', 'c', '/p', { layoutModel: meshLayout }), live), [
      { sessionId: 'mesh-conversation:c1:rw9:agent-9', remote: true },
    ])
    assert.equal(
      rowHasOpenTerminals(workspace('w4', 'd', '/p', { layoutModel: staleLayout }), live),
      false,
      'a stale mesh-terminal tab is not an open terminal',
    )
    assert.deepEqual(rowOpenTerminals(workspace('w4', 'd', '/p', { layoutModel: staleLayout }), live), [])

    const workspaces = [
      workspace('w1', 'Alpha', '/projA'),
      workspace('w2', 'Bravo', '/projA'),
      workspace('w3', 'Charlie', '/projB'),
    ]
    const noop = () => {}
    const props = {
      workspaces,
      activeWorkspaceId: 'w1',
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      activityByWorkspaceId: {},
      residentWorkspaceIds: new Set<string>(['w1']),
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
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    try {
      // Let the terminal list resolve, the membership effect re-run on it, and
      // the first sweep land. Each round drains the microtask queue, yields one
      // macrotask (the sweep's own awaits chain across several), then flushes
      // whatever React queued from outside act.
      for (let round = 0; round < 8; round += 1) {
        for (let i = 0; i < 12; i += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        act(() => {})
      }

      // The line's mark names its terminal and runtime in an aria-label and the
      // branch is a span, so the row's markup — not its text — carries the line.
      const rowMarkup = (name: string): string => {
        const row = [...container.querySelectorAll('[role="treeitem"]')].find((el) => el.textContent?.includes(name))
        assert.ok(row, `a row for ${name}`)
        return row!.outerHTML
      }

      const alpha = rowMarkup('Alpha')
      assert.match(alpha, /aria-label="[^"]*Claude Code"/, 'the live row wears its terminal line')
      assert.match(alpha, />main</, 'and its branch')
      assert.match(alpha, /\+37/, 'and the ± files of the branch it is on — added and updated in one number')

      const bravo = rowMarkup('Bravo')
      assert.doesNotMatch(bravo, /aria-label="[^"]*Claude Code"/, 'an exited session is not a line')
      assert.doesNotMatch(bravo, />main</, 'a parked chat on the same checkout shows no branch')
      assert.doesNotMatch(bravo, /\+37/, 'and never wears the checkout’s current numbers')

      const charlie = rowMarkup('Charlie')
      assert.doesNotMatch(
        charlie,
        />main<|\+37|aria-label="[^"]*Claude Code"/,
        'a row that never had a terminal is a one-liner',
      )

      assert.deepEqual(
        [...new Set(summaryRequests)],
        ['/projA'],
        'the poll asks only about checkouts a live row sits on — /projB is never read',
      )
    } finally {
      // Unmount on every path: the git poll's interval and the store
      // subscriptions are what would otherwise hold the process open.
      act(() => {
        root.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar live rows tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
