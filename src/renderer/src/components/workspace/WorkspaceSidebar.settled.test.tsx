import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.settled', async () => {
  // Settled chats (2026-09-07; off the rail 2026-09-28). A folder's resting
  // rows leave the sidebar altogether — Settings ▸ Settled chats holds them —
  // except the one you are in. The row menu offers Settle on an active row and
  // Un-settle on a resting one. This holds the rail's side; the rule that
  // decides what rests is held by workspaceSettle.test.ts and the store by
  // workspacesSlice.test.ts.

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

  // Alpha holds a live agent pty; the settled rows hold nothing, which is what
  // a chat that came to rest looks like after the kill lands.
  const killed: string[] = []
  // What main says Alpha's pty is doing when it is asked again at kill time.
  let alphaActivityAtKill: 'idle' | 'working' = 'idle'
  // A chat agent has no pty: main owns its process, and Settle ends it through
  // the conversation runtime. Echo's live chat and a chat already stopped.
  const chatsSuspended: string[] = []
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [
      {
        sessionId: 'alpha-pty',
        workspaceId: 'w1',
        processAlive: true,
        kind: 'agent',
        cli: 'claude-code',
        activity: { kind: alphaActivityAtKill, since: 1 },
      },
      // Hotel holds nothing but a shell, printing as a shell does: a plain
      // terminal reads as working for a few seconds after any output.
      {
        sessionId: 'terminal-hotel-shell',
        workspaceId: 'w8',
        processAlive: true,
        kind: 'terminal',
        activity: { kind: 'working', since: 1 },
      },
    ],
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
    terminalKill: async (sessionId: string) => {
      killed.push(sessionId)
    },
    conversationSessionsList: async () => ({
      ok: true,
      sessions: [
        { sessionId: 'echo-chat', workspaceId: 'w5', agentId: 'agent-1', status: 'ready' },
        { sessionId: 'echo-old', workspaceId: 'w5', agentId: 'agent-1', status: 'stopped' },
      ],
    }),
    conversationSessionSuspend: async ({ sessionId }: { sessionId: string }) => {
      chatsSuspended.push(sessionId)
      return { ok: true }
    },
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const DAY = 24 * 60 * 60 * 1000
    const createdAt = Date.now()
    const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
      ({ id, name, mode: 'standard', folderPath: '/projA', createdAt, ...fields }) as unknown as Workspace

    // Alpha is active; Bravo and Charlie have come to rest, Charlie worked a
    // day more recently than Bravo — outside the sort's 30-minute "just now"
    // tie window, so recency and not stored order decides the shelf's order.
    const workspaces = [
      workspace('w1', 'Alpha', {
        agents: {
          'agent-1': {
            id: 'agent-1',
            name: 'Clod',
            cliSessionId: 'alpha-pty',
            status: 'idle',
            execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
            messages: [],
            streamBuffer: '',
          },
        },
      }),
      workspace('w2', 'Bravo', {
        createdAt: createdAt - 10 * DAY,
        settledAt: createdAt - DAY,
        lastTerminalActivityAt: createdAt - 5 * DAY,
      }),
      workspace('w3', 'Charlie', {
        createdAt: createdAt - 10 * DAY,
        settledAt: createdAt - DAY,
        lastTerminalActivityAt: createdAt - 4 * DAY,
      }),
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

    const rowNames = (): string[] =>
      [...container.querySelectorAll('[role="treeitem"]')]
        .map((row) => ['Alpha', 'Bravo', 'Charlie'].find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)

    const actionLabel = (label: string): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

    const shelfButton = (): HTMLButtonElement | null =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
        button.textContent?.startsWith('Settled'),
      ) ?? null

    const openMenuOn = async (name: string): Promise<string[]> => {
      const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
        el.textContent?.includes(name),
      )
      assert.ok(row, `row ${name} is rendered`)
      act(() => {
        row.dispatchEvent(
          new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        )
      })
      await settle()
      const items = [...dom.window.document.querySelectorAll('[role="menu"] [data-menu-item="true"]')].map(
        (el) => el.textContent?.trim() ?? '',
      )
      act(() => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await settle()
      return items
    }

    try {
      await render(props)
      assert.deepEqual(rowNames(), ['Alpha'], 'only the active row is in the list at rest')
      // Settled chats are off the rail (owner, 2026-09-28): no shelf row to
      // read past, and the resting rows are not drawn anywhere in the sidebar.
      // Settings ▸ Settled chats is where they are found.
      assert.equal(shelfButton(), null, 'the folder grows no Settled shelf')
      assert.equal(container.textContent?.includes('Bravo'), false, 'a resting chat is not drawn')
      assert.equal(container.textContent?.includes('Charlie'), false, 'nor is any other')

      const activeMenu = await openMenuOn('Alpha')
      assert.ok(activeMenu.includes('Settle'), `an active row's menu offers Settle (got ${activeMenu.join(' | ')})`)
      assert.equal(activeMenu.includes('Un-settle'), false)
      assert.ok(
        activeMenu.some((item) => item.startsWith('Auto-settle')),
        `and its Auto-settle choice (got ${activeMenu.join(' | ')})`,
      )

      // The one-click seat is rest, not removal, and Settle is the one way a
      // row is put away (2026-10-21): the ✕ that terminated the row's
      // terminals and removed the chat is gone from the seat and the menu.
      assert.ok(actionLabel('Settle Alpha'), 'an active row offers Settle in its hover seat')
      assert.equal(actionLabel('Close Alpha'), null, 'and no Close there')
      assert.equal(activeMenu.includes('Close workspace'), false, 'nor in the row menu')

      // Rest means rest (owner ruling 2026-09-07): a chat that has come to rest
      // holds no terminals, so settling takes its ptys with it. Nothing is
      // killed until then — the sweep leaves the selected row and the already
      // resting rows alone, so an idle sidebar kills nothing.
      assert.deepEqual(killed, [], 'no settle, no kill')
      const settleAlpha = actionLabel('Settle Alpha')
      assert.ok(settleAlpha, 'Alpha has a Settle button to click')
      act(() => {
        settleAlpha.click()
      })
      await settle()
      assert.deepEqual(killed, ['alpha-pty'], 'settling a chat kills the terminals it held')
      // Echo's chat runs as `agent-1` too: every workspace's first agent has
      // that id, so it says nothing about which workspace a chat is in.
      assert.deepEqual(chatsSuspended, [], "and leaves another workspace's chat agents alone")

      // A turn that started after the window last heard (a message from the
      // phone) is not interrupted by a Settle decided before it: main is asked
      // again just before the kill, and a chat working by then keeps running.
      const killedBefore = killed.length
      alphaActivityAtKill = 'working'
      act(() => {
        actionLabel('Settle Alpha')!.click()
      })
      await settle()
      assert.deepEqual(killed.slice(killedBefore), [], 'a chat working by the time of the kill is left running')
      alphaActivityAtKill = 'idle'

      // The row you are in stays put when it settles, so the seat has to say
      // it did: the tick becomes the ringed settled mark, which un-settles,
      // and the row is pinned open while the flourish plays. The record is
      // the store's; here it arrives the way it does in the app, as props.
      const settledAlpha = [{ ...workspaces[0], settledAt: Date.now() } as Workspace, ...workspaces.slice(1)]
      await render({ ...props, workspaces: settledAlpha } as unknown as SidebarProps)
      assert.equal(actionLabel('Settle Alpha') === null, true, 'a settled row no longer offers Settle')
      const unsettleAlpha = actionLabel('Un-settle Alpha')
      assert.ok(unsettleAlpha, 'its seat offers Un-settle instead')
      assert.ok(unsettleAlpha.querySelector('.settle-mark-flourish'), 'and plays the settle flourish')
      const alphaRow = unsettleAlpha.closest('[role="treeitem"]')
      assert.equal(alphaRow?.hasAttribute('data-settle-flourish'), true, 'with the seat pinned open while it plays')
      await render(props)
      assert.ok(actionLabel('Settle Alpha'), 'un-settled, the row offers Settle again')
      assert.equal(alphaRow?.hasAttribute('data-settle-flourish'), false, 'and the flourish ends with it')

      // The row you are in always has a row: selecting a settled chat (from
      // Settings or search) keeps it in the active list, still settled, while
      // the other resting chat stays off the rail.
      await render({ ...props, activeWorkspaceId: 'w2' } as unknown as SidebarProps)
      assert.deepEqual(rowNames(), ['Alpha', 'Bravo'], 'the selected settled row sits in the active list')
      const unsettleBravo = actionLabel('Un-settle Bravo')
      assert.ok(unsettleBravo, 'its seat wears the settled mark')
      assert.equal(
        unsettleBravo.querySelector('.settle-mark-flourish') === null,
        true,
        'but a row that was already resting when it drew does not play the flourish',
      )
      assert.equal(shelfButton(), null, 'and still no shelf for the one left resting')

      const settledMenu = await openMenuOn('Bravo')
      assert.ok(
        settledMenu.includes('Un-settle'),
        `a resting row's menu offers Un-settle (got ${settledMenu.join(' | ')})`,
      )
      assert.equal(settledMenu.includes('Settle'), false)

      // A row born on a paired machine whose machine keeps no rest settles
      // here alone (`settleOpenedRemote`), so it wears the tick like any other
      // row rather than the ✕ it kept before Close went.
      await render({
        ...props,
        workspaces: [
          workspace('w1', 'Alpha'),
          workspace('w4', 'Delta', {
            folderPath: null,
            remoteOrigin: {
              connectionId: 'c1',
              machineName: 'MacBook Air',
              workspaceId: 'rw1',
              workspaceName: 'relay',
              workspaceRoot: '/Users/me/relay',
            },
          }),
        ],
        activityByWorkspaceId: { w1: 'idle', w4: 'idle' },
      } as unknown as SidebarProps)
      assert.ok(actionLabel('Settle Delta'), 'a remote-band row offers Settle in its seat')
      assert.equal(actionLabel('Close Delta'), null, 'and no Close')
      const remoteMenu = await openMenuOn('Delta')
      assert.ok(remoteMenu.includes('Settle'), `and in its menu (got ${remoteMenu.join(' | ')})`)
      assert.equal(remoteMenu.includes('Close workspace'), false)

      // A chat-agent row has no pty, and settling it still ends its agent's
      // process: the live chat is suspended, the stopped one left alone, and
      // no terminal is killed on its account.
      await render({
        ...props,
        workspaces: [workspace('w1', 'Alpha'), workspace('w5', 'Echo')],
        activityByWorkspaceId: { w1: 'idle', w5: 'idle' },
        conversationSessions: [{ sessionId: 'echo-chat', workspaceId: 'w5', agentId: 'agent-1', status: 'ready' }],
      } as unknown as SidebarProps)
      const settleEcho = actionLabel('Settle Echo')
      assert.ok(settleEcho, 'Echo has a Settle button to click')
      act(() => {
        settleEcho.click()
      })
      await settle()
      assert.deepEqual(chatsSuspended, ['echo-chat'], "settling a chat ends its chat agent's process")
      assert.deepEqual(killed, ['alpha-pty'], 'and kills no terminal for it')

      // A chat holding only a terminal settles like any other, and its shell
      // goes with it. A shell's working is output, not an agent's work, so it
      // holds neither the tick nor the kill: before, the tick refused it while
      // the shell had printed in the last few seconds, and Close was the only
      // way to put the row away.
      await render({
        ...props,
        workspaces: [
          workspace('w1', 'Alpha'),
          workspace('w8', 'Hotel', {
            paneState: {
              open: true,
              activeTabId: 'tab-1',
              tabs: [{ id: 'tab-1', kind: 'terminal', terminalId: 'hotel-shell' }],
            },
          }),
        ],
        // What the window reads for a row whose shell has just printed.
        activityByWorkspaceId: { w1: 'idle', w8: 'working' },
      } as unknown as SidebarProps)
      const settleHotel = actionLabel('Settle Hotel')
      assert.ok(settleHotel, 'a terminal-only row offers Settle in its seat')
      assert.equal(settleHotel.getAttribute('aria-disabled'), null, 'and it is not held by the shell printing')
      const hotelMenu = await openMenuOn('Hotel')
      assert.ok(hotelMenu.includes('Settle'), `its menu offers Settle (got ${hotelMenu.join(' | ')})`)
      assert.equal(hotelMenu.includes('Close workspace'), false, 'and no Close')
      act(() => {
        settleHotel.click()
      })
      await settle()
      assert.deepEqual(killed, ['alpha-pty', 'terminal-hotel-shell'], "settling it ends the row's shell")

      // Settling ends a chat's agents and their work with them, so a chat with
      // an agent still working cannot be settled: not while a turn runs, and
      // not while an agent it launched in the background works on after it.
      for (const [why, fields] of [
        ['a turn running', { activityByWorkspaceId: { w1: 'idle', w6: 'working' }, conversationSessions: [] }],
        [
          'a background agent working under a waiting prompt',
          {
            activityByWorkspaceId: { w1: 'idle', w6: 'needs-input' },
            conversationSessions: [
              {
                sessionId: 'fox-chat',
                workspaceId: 'w6',
                agentId: 'agent-1',
                status: 'awaiting_approval',
                phase: 'waiting_for_input',
                backgroundAgents: 1,
              },
            ],
          },
        ],
        [
          'a background agent working after its parent failed',
          {
            activityByWorkspaceId: { w1: 'idle', w6: 'failed' },
            conversationSessions: [
              {
                sessionId: 'fox-chat',
                workspaceId: 'w6',
                agentId: 'agent-1',
                status: 'failed',
                phase: 'failed',
                backgroundAgents: 1,
              },
            ],
          },
        ],
      ] as const) {
        await render({
          ...props,
          workspaces: [workspace('w1', 'Alpha'), workspace('w6', 'Foxtrot')],
          ...fields,
        } as unknown as SidebarProps)
        const settleFoxtrot = actionLabel('Settle Foxtrot')
        assert.ok(settleFoxtrot, `Foxtrot still shows Settle with ${why}`)
        // Announced unavailable but still focusable and hoverable, so the
        // tooltip saying why can open.
        assert.equal(settleFoxtrot.getAttribute('aria-disabled'), 'true', `but it is unavailable with ${why}`)
        assert.equal(settleFoxtrot.disabled, false, `and keeps its tab stop with ${why}`)
        act(() => {
          settleFoxtrot.click()
        })
        await settle()
        assert.deepEqual(chatsSuspended, ['echo-chat'], `and settles nothing with ${why}`)
      }

      // Settling the chat you are in moves you on: the next chat down the rail
      // opens, or the one above it when there is none below. Settling a chat
      // you are not in leaves the selection where it is.
      const selected: string[] = []
      const threeOpen = {
        ...props,
        workspaces: [workspace('w1', 'Alpha'), workspace('w6', 'Foxtrot'), workspace('w7', 'Golf')],
        activityByWorkspaceId: { w1: 'idle', w6: 'idle', w7: 'idle' },
        onSelectWorkspace: (id: string) => selected.push(id),
      }
      const drawnIds = (): string[] =>
        [...container.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]')].map(
          (row) => row.dataset.workspaceId!,
        )
      const nameOf: Record<string, string> = { w1: 'Alpha', w6: 'Foxtrot', w7: 'Golf' }
      await render({ ...threeOpen, activeWorkspaceId: 'w1' } as unknown as SidebarProps)
      const order = drawnIds()
      assert.equal(order.length, 3, `all three chats are drawn (got ${order.join(', ')})`)

      await render({ ...threeOpen, activeWorkspaceId: order[0] } as unknown as SidebarProps)
      act(() => actionLabel(`Settle ${nameOf[order[0]!]}`)!.click())
      await settle()
      assert.deepEqual(selected, [order[1]], 'settling the open chat opens the one below it')

      selected.length = 0
      await render({ ...threeOpen, activeWorkspaceId: order[2] } as unknown as SidebarProps)
      act(() => actionLabel(`Settle ${nameOf[order[2]!]}`)!.click())
      await settle()
      assert.deepEqual(selected, [order[1]], 'the last chat in the rail hands off to the one above')

      selected.length = 0
      await render({ ...threeOpen, activeWorkspaceId: order[0] } as unknown as SidebarProps)
      act(() => actionLabel(`Settle ${nameOf[order[2]!]}`)!.click())
      await settle()
      assert.deepEqual(selected, [], 'settling a chat you are not in opens nothing')

      // New chat up over the chat: the person has left it, and settling it from
      // its row keeps them in New chat.
      await render({ ...threeOpen, activeWorkspaceId: order[0], newChatOpen: true } as unknown as SidebarProps)
      act(() => actionLabel(`Settle ${nameOf[order[0]!]}`)!.click())
      await settle()
      assert.deepEqual(selected, [], 'settling the chat under New chat opens nothing')

      // The last chat still going has nowhere to hand off to: New chat opens,
      // and the settled row leaves the rail rather than staying open, checked
      // off (owner, 2026-10-03).
      // Its own array: the assertion above narrowed `selected` to an empty one.
      const picked: string[] = []
      let newChats = 0
      const lastOne = {
        ...props,
        workspaces: [workspace('w1', 'Alpha')],
        activityByWorkspaceId: { w1: 'idle' },
        activeWorkspaceId: 'w1',
        onSelectWorkspace: (id: string) => picked.push(id),
        onNewChat: () => {
          newChats += 1
        },
      }
      await render(lastOne as unknown as SidebarProps)
      act(() => actionLabel('Settle Alpha')!.click())
      await settle()
      assert.deepEqual(picked, [], 'there is no other chat to open')
      assert.equal(newChats, 1, 'settling the last chat you are in opens New chat')

      const onlySettled = [workspace('w1', 'Alpha', { settledAt: createdAt })]
      await render({ ...lastOne, workspaces: onlySettled } as unknown as SidebarProps)
      assert.ok(drawnIds().includes('w1'), 'a settled chat you are in keeps its row')
      await render({ ...lastOne, workspaces: onlySettled, newChatOpen: true } as unknown as SidebarProps)
      assert.ok(!drawnIds().includes('w1'), 'and leaves the rail once New chat is up over it')
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar settled tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
