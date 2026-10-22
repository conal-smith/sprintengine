import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.rowEmphasis', async () => {
  // Row contrast (contrast-for-quiet-chats, 2026-09-07; residency replacing the
  // clock, 2026-09-09). A sidebar where every chat is drawn at full ink has no
  // foreground: weight goes to the chats with an agent alive in them, dim ink to
  // the ones that are only a record.
  // `workspaceRowEmphasis.test.ts` holds which tier a row is in; this holds how
  // the row draws it.

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
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const MINUTE = 60 * 1000
    const HOUR = 60 * MINUTE
    const now = Date.now()
    // Created just now, all of them: the rest sweep reads the record's clocks,
    // and a chat born minutes ago never settles. What separates these rows is
    // the terminal recency below — the same clock the row's idle label reads.
    const workspace = (id: string, name: string): Workspace =>
      ({ id, name, mode: 'standard', folderPath: '/projA', createdAt: now }) as unknown as Workspace

    const workspaces = [
      workspace('w1', 'Selected'),
      workspace('w2', 'Working'),
      workspace('w3', 'Waiting'),
      workspace('w4', 'Resident'),
      workspace('w5', 'Recent'),
      workspace('w6', 'Quiet'),
    ]

    const noop = () => {}
    const props = {
      workspaces,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      // Residency is what bolds a row now, so it is what separates these rows:
      // the working one and the idle-but-resident one have an agent in them, and
      // nothing else does.
      residentWorkspaceIds: new Set<string>(['w2', 'w4']),
      activeWorkspaceId: 'w1',
      activityByWorkspaceId: {
        w1: 'idle',
        w2: 'working',
        w3: 'needs-input',
        w4: 'idle',
        w5: 'idle',
        w6: 'idle',
      },
      terminalRecencyByWorkspaceId: {
        // The selected row has been sitting for a day with no agent left in it;
        // selection outranks residency, so it still leads.
        w1: { hasRunning: false, idleSince: now - 24 * HOUR, lastInputAt: now - 24 * HOUR, workingSince: null },
        w2: { hasRunning: true, idleSince: null, lastInputAt: now - 3 * HOUR, workingSince: now - MINUTE },
        w3: { hasRunning: false, idleSince: now - 5 * HOUR, lastInputAt: now - 5 * HOUR, workingSince: null },
        // An agent sitting in a chat nobody has typed into for three hours: the
        // row the 2026-09-09 ruling turned back on.
        w4: { hasRunning: false, idleSince: now - 3 * HOUR, lastInputAt: now - 3 * HOUR, workingSince: null },
        // Touched 22 minutes ago, agent gone: the row the hour clock used to
        // keep lit for no one.
        w5: { hasRunning: false, idleSince: now - 22 * MINUTE, lastInputAt: now - 22 * MINUTE, workingSince: null },
        w6: { hasRunning: false, idleSince: now - 2 * HOUR, lastInputAt: now - 2 * HOUR, workingSince: null },
      },
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

    // The row's title element: the LEAF node inside the row whose whole text is
    // the chat's name. Innermost matters — on a row carrying nothing but its
    // title, the cluster that wraps the title reads as the same string and comes
    // first in document order, and the weight lands on the leaf inside it.
    const titleOf = (name: string): HTMLElement => {
      const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
        el.textContent?.includes(name),
      )
      assert.ok(row, `row ${name} is rendered`)
      const title = [...row.querySelectorAll<HTMLElement>('span')]
        .filter((el) => el.textContent?.trim() === name)
        .at(-1)
      assert.ok(title, `row ${name} has a title element`)
      return title
    }

    const bold = (name: string): boolean => titleOf(name).className.includes('font-semibold')
    const dim = (name: string): boolean => titleOf(name).className.includes('--text-subtle')

    try {
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, props))
      })
      await settle()

      // One tier for every chat someone is using — no middle step.
      assert.equal(bold('Selected'), true, 'the selected row is bold')
      assert.equal(bold('Working'), true, 'a working agent bolds its row')
      assert.equal(bold('Waiting'), true, 'so does a row blocked on you')
      assert.equal(bold('Resident'), true, 'and one with an agent still alive in it, idle three hours')

      // And the background tier: no agent in the chat, whatever its clock says.
      assert.equal(bold('Recent'), false, 'touched 22 minutes ago but nobody home is not bold')
      assert.equal(bold('Quiet'), false, 'nor is two hours untouched')

      // Ink: only the background tier moves off the row's own ink. Selection's
      // lift lives on the row class, not here.
      assert.equal(dim('Quiet'), true, 'an agentless chat drops to the dim ink')
      assert.equal(dim('Recent'), true, 'and the clock does not lift it back')
      assert.equal(dim('Resident'), false, 'an agent in the room keeps full ink')
      assert.equal(dim('Waiting'), false, 'a waiting row never dims, however long it has been waiting')
      assert.equal(dim('Selected'), false, 'the row you are in never dims, agent or no agent')

      // A dim row lifts back on hover, so reaching for one is never reading dim
      // text.
      assert.ok(
        titleOf('Quiet').className.includes('group-hover:text-[color:var(--text-default)]'),
        'a background row lifts to normal ink on hover',
      )
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar row emphasis tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
