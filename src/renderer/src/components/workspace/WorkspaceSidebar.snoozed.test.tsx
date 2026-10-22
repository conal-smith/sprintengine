import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.snoozed', async () => {
  // Snoozed chats (2026-09-10). A sleeping row leaves the active list for its
  // folder's Snoozed shelf — one fold row carrying the count, closed by default,
  // over compact rows wearing the countdown to their wake. The row menu offers
  // Snooze on an active row and Wake now on a sleeping one, and a row that came
  // back wears a Woke mark until it is opened.
  //
  // This holds the SHELF's shape and the menu's. The rules that decide what
  // sleeps, when it wakes and what the countdown reads live in
  // workspaceSnooze.test.ts; the store's writes live in workspacesSlice.test.ts.

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

  // Snoozing SUSPENDS a chat's terminals and never kills them (owner ruling,
  // 2026-09-10): a snoozed chat must stop costing an agent process, but it is
  // coming back on a clock, so its session stays resumable and the person's own
  // keystroke relaunches it. Both lists are asserted at the end — the kill list
  // empty, the suspend list holding Alpha's pty.
  const killed: string[] = []
  const suspended: string[] = []
  const resumed: string[] = []
  // Alpha also holds a chat agent, whose process main owns: snoozing ends it
  // too, keeping the session so the next message resumes it.
  const chatsSuspended: string[] = []
  // Alpha holds a live agent pty, so there is something for the snooze to pause.
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
        activity: { kind: 'idle', since: 1 },
      },
    ],
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
    terminalKill: async (sessionId: string) => {
      killed.push(sessionId)
    },
    terminalSuspend: async (sessionId: string) => {
      suspended.push(sessionId)
    },
    terminalResume: async (sessionId: string) => {
      resumed.push(sessionId)
    },
    conversationSessionsList: async () => ({
      ok: true,
      sessions: [{ sessionId: 'alpha-chat', workspaceId: 'w1', agentId: 'agent-chat', status: 'ready' }],
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
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const HOUR = 60 * 60 * 1000
    const DAY = 24 * HOUR
    const createdAt = Date.now()
    const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
      ({ id, name, mode: 'standard', folderPath: '/projA', createdAt, ...fields }) as unknown as Workspace

    // Alpha is the active row. Bravo sleeps for another two hours; Charlie sleeps
    // for another day, so the shelf can be checked for soonest-first order.
    // Delta's wake time has passed and nobody has opened it: it is back in the
    // active list wearing Woke.
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
      workspace('w2', 'Bravo', { snoozedUntil: createdAt + 2 * HOUR }),
      workspace('w3', 'Charlie', { snoozedUntil: createdAt + DAY }),
      workspace('w4', 'Delta', { snoozedUntil: createdAt - HOUR }),
    ]

    const noop = () => {}
    // What the rail's Home badge is told to skip. The badge counts what the
    // sidebar SHOWS, so a chat taken off screen has to be named here or its
    // count outlives the gesture that hid it.
    let reportedSnoozed: ReadonlySet<string> = new Set()
    const baseProps = {
      onSnoozedWorkspacesChange: (ids: ReadonlySet<string>) => {
        reportedSnoozed = ids
      },
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

    // Every fixture name any case in this file renders. A name missing here reads
    // as "no such row" rather than failing, so an assertion about an empty list
    // would pass for the wrong reason.
    const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Sleeper', 'Dozer']
    const rowNames = (): string[] =>
      [...container.querySelectorAll('[role="treeitem"]')]
        .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)

    const rowFor = (name: string): HTMLElement | undefined =>
      [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => el.textContent?.includes(name))

    const foldRow = (label: string): HTMLButtonElement | null =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
        button.textContent?.startsWith(label),
      ) ?? null

    const openMenuOn = async (name: string): Promise<string[]> => {
      const row = rowFor(name)
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
      await render(baseProps)

      // --- the shelf -------------------------------------------------------
      assert.deepEqual(rowNames(), ['Alpha', 'Delta'], 'sleeping rows leave the active list; a woken one is back in it')
      const shelf = foldRow('Snoozed')
      assert.ok(shelf, 'the folder shows its Snoozed shelf row')
      assert.equal(shelf.getAttribute('aria-expanded'), 'false', 'the shelf is closed by default')
      assert.match(shelf.textContent ?? '', /Snoozed\s*2/, 'the shelf row carries the count')
      const shelfBody = dom.window.document.getElementById(shelf.getAttribute('aria-controls') ?? '')
      assert.ok(shelfBody, 'the shelf row controls a real node')
      assert.equal(shelfBody.hidden, true, 'and that node is hidden while closed')
      assert.equal(foldRow('Settled'), null, 'a folder with nothing at rest grows no Settled shelf')
      // The shelf sits in the background (owner, 2026-09-28): its word is a
      // quiet row's `text.subtle`, never the kit row's `text.default`, and its
      // count a step under that — lifting to readable ink when reached for.
      const [shelfLabel, shelfCount] = [...shelf.querySelectorAll('span')]
      assert.match(shelfLabel.className, /(^|\s)text-\[color:var\(--text-subtle\)\]/, 'the word rests at text.subtle')
      assert.match(
        shelfLabel.className,
        /group-hover\/shelf:text-\[color:var\(--text-default\)\]/,
        'and lifts on hover',
      )
      assert.match(
        shelfLabel.className,
        /group-focus-visible\/shelf:text-\[color:var\(--text-default\)\]/,
        'and on keyboard focus',
      )
      assert.match(shelfCount.className, /(^|\s)text-\[color:var\(--text-disabled\)\]/, 'the count a step further down')

      act(() => {
        shelf.click()
      })
      await settle()
      assert.equal(foldRow('Snoozed')?.getAttribute('aria-expanded'), 'true', 'opening the shelf is a disclosure')
      assert.deepEqual(
        rowNames(),
        ['Alpha', 'Delta', 'Bravo', 'Charlie'],
        'open, the shelf lists its rows by wake time, soonest first',
      )

      // --- what a sleeping row says ---------------------------------------
      const bravo = rowFor('Bravo')
      assert.ok(bravo?.textContent?.includes('(snoozed)'), 'a sleeping row says so in words')
      assert.match(bravo!.textContent ?? '', /\b2h\b/, 'and wears the countdown to its wake')
      assert.ok(container.querySelector('button[aria-label="Wake Bravo"]'), 'its one-click seat is Wake, not Settle')
      assert.equal(
        container.querySelector('button[aria-label="Settle Bravo"]'),
        null,
        'Settle does not take the seat on a row that is only waiting on a clock',
      )

      assert.deepEqual(
        [...reportedSnoozed].sort(),
        ['w2', 'w3'],
        'the sleeping rows are reported up so the rail badge skips them',
      )

      // --- what a woken row says -------------------------------------------
      const delta = rowFor('Delta')
      assert.ok(delta?.textContent?.includes('Woke'), 'a row whose wake time passed comes back wearing Woke')
      assert.equal(rowFor('Alpha')?.textContent?.includes('Woke'), false, 'a row that never slept does not')

      // --- the menu ---------------------------------------------------------
      const activeMenu = await openMenuOn('Alpha')
      assert.ok(activeMenu.includes('Snooze'), `an active row's menu offers Snooze (got ${activeMenu.join(' | ')})`)
      assert.equal(activeMenu.includes('Wake now'), false, 'and not Wake')

      const sleepingMenu = await openMenuOn('Bravo')
      assert.ok(
        sleepingMenu.includes('Wake now'),
        `a sleeping row's menu offers Wake now (got ${sleepingMenu.join(' | ')})`,
      )
      assert.equal(sleepingMenu.includes('Snooze'), false, 'and not a second Snooze')

      // The presets are a flyout under Snooze, and every one of them names both
      // the choice and the time it lands on.
      const alphaRow = rowFor('Alpha')
      act(() => {
        alphaRow!.dispatchEvent(
          new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        )
      })
      await settle()
      const snoozeItem = [
        ...dom.window.document.querySelectorAll<HTMLElement>('[role="menu"] [data-menu-item="true"]'),
      ].find((el) => el.textContent?.trim() === 'Snooze')
      assert.ok(snoozeItem, 'Snooze is a menu item')
      assert.equal(snoozeItem.getAttribute('aria-haspopup'), 'menu', 'and it opens a submenu of wake times')
      // Opened by click; hover opens it too, but a raw non-bubbling `mouseenter`
      // is not what React synthesises onMouseEnter from.
      act(() => {
        snoozeItem.click()
      })
      await settle()
      const presetLabels = [
        ...dom.window.document.querySelectorAll('[role="menu"][aria-label="Snooze chat"] [data-menu-item="true"]'),
      ].map((el) => el.textContent?.trim() ?? '')
      assert.ok(presetLabels.length >= 3, `the flyout offers wake times (got ${presetLabels.join(' | ')})`)
      assert.ok(
        presetLabels.some((label) => label.startsWith('In 1 hour')),
        `the nearest choice is first (got ${presetLabels.join(' | ')})`,
      )
      assert.ok(
        presetLabels.some((label) => label.startsWith('Tomorrow')),
        `and the calendar choices follow (got ${presetLabels.join(' | ')})`,
      )
      // Choosing one SUSPENDS the chat's terminals (owner ruling, 2026-09-10).
      // This is the behaviour the first cut got wrong: a snoozed chat that kept
      // its ptys running was the most expensive row in the tree, and the point of
      // the gesture is that the chat stops running until you come back to it.
      assert.deepEqual(suspended, [], 'nothing is suspended before the choice is made')
      const anHour = [
        ...dom.window.document.querySelectorAll<HTMLElement>(
          '[role="menu"][aria-label="Snooze chat"] [data-menu-item="true"]',
        ),
      ].find((el) => el.textContent?.trim().startsWith('In 1 hour'))
      assert.ok(anHour, 'the 1-hour preset is clickable')
      act(() => {
        anHour.click()
      })
      await settle()
      assert.deepEqual(suspended, ['alpha-pty'], "snoozing pauses the chat's agent pty")
      assert.deepEqual(killed, [], 'and never kills it — the session has to survive to be resumed')
      assert.deepEqual(resumed, [], 'nothing is resumed by the snooze itself')
      assert.deepEqual(chatsSuspended, ['alpha-chat'], "snoozing ends the chat agent's process as well")

      // --- a raised hand outranks the snooze --------------------------------
      // Bravo's agent starts asking. Nothing happens to the row: the clock is the
      // only thing that wakes a sleeper (owner, 2026-09-10). The question is not
      // lost — it waits in the suspended CLI session and is re-asked when the
      // person resumes the terminal themselves.
      await render({
        ...baseProps,
        activityByWorkspaceId: { w1: 'idle', w2: 'needs-input', w3: 'idle', w4: 'idle' },
      } as unknown as SidebarProps)
      // Asserted against the shelf CONTAINER, not the row list: this folder's
      // shelf was opened earlier in the file, so a row inside it is on screen —
      // what matters is which side of the fold it is on.
      const openShelf = dom.window.document.getElementById(foldRow('Snoozed')?.getAttribute('aria-controls') ?? '')
      assert.ok(openShelf, 'the shelf is there to look inside')
      assert.ok(openShelf.textContent?.includes('Bravo'), 'a sleeping row whose agent is asking stays in the shelf')
      assert.match(foldRow('Snoozed')?.textContent ?? '', /Snoozed\s*2/, 'and the shelf count does not move')
      assert.deepEqual([...reportedSnoozed].sort(), ['w2', 'w3'], 'the badge still skips it')

      // And a row that is asking may itself be snoozed — "you should be able to
      // snooze whatever you want". This used to be blocked, and had to be: while
      // a question outranked the snooze, snoozing an asking row would have
      // un-snoozed it on the next tick.
      await render({
        ...baseProps,
        activityByWorkspaceId: { w1: 'needs-input', w2: 'idle', w3: 'idle', w4: 'idle' },
      } as unknown as SidebarProps)
      act(() => {
        rowFor('Alpha')!.dispatchEvent(
          new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        )
      })
      await settle()
      const askingSnooze = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menu"] [data-menu-item="true"]'),
      ].find((el) => el.textContent?.trim() === 'Snooze')
      assert.ok(askingSnooze, 'Snooze is listed on a row whose agent is asking')
      assert.equal(askingSnooze.disabled, false, 'and it can be chosen')
      act(() => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await settle()

      // But not a row whose agent is working. Pausing ends the agent processes,
      // and an agent working in the background ends with them and does not
      // come back on the wake.
      await render({
        ...baseProps,
        activityByWorkspaceId: { w1: 'working', w2: 'idle', w3: 'idle', w4: 'idle' },
      } as unknown as SidebarProps)
      act(() => {
        rowFor('Alpha')!.dispatchEvent(
          new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        )
      })
      await settle()
      const workingSnooze = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menu"] [data-menu-item="true"]'),
      ].find((el) => el.textContent?.trim() === 'Snooze')
      assert.ok(workingSnooze, 'Snooze is still listed on a row whose agent is working')
      assert.equal(workingSnooze.disabled, true, 'but it cannot be chosen until the agent finishes')
      act(() => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await settle()

      // Suspend, never kill, and never an automatic resume: a woken row returns
      // to the sidebar with its terminals still paused, and the person's own
      // keystroke is what starts an agent again.
      assert.deepEqual(killed, [], 'no snooze ever killed a terminal')
      assert.deepEqual(resumed, [], 'and waking resumed nothing on its own')

      // --- a folder of nothing but sleepers steps out ------------------------
      // A project with nothing going on leaves the sidebar (2026-09-07), and a
      // folder of sleepers counts (owner, 2026-09-10): it would be a project line
      // over a fold with nothing to do. It is not stranded and not a decision the
      // person has to undo — the wake needs no event, so the folder returns on the
      // tick the stamp expires.
      const sleepers = [
        workspace('s1', 'Sleeper', { snoozedUntil: createdAt + 2 * HOUR }),
        workspace('s2', 'Dozer', { snoozedUntil: createdAt + 3 * HOUR }),
      ]
      const sleeperProps = {
        ...baseProps,
        workspaces: sleepers,
        activeWorkspaceId: null,
        activityByWorkspaceId: { s1: 'idle', s2: 'idle' },
      } as unknown as SidebarProps
      await render(sleeperProps)
      assert.deepEqual(rowNames(), [], 'no chat is in the active list')
      assert.equal(foldRow('Snoozed'), null, 'and the folder steps out rather than heading an empty fold')

      // It comes back with the chat, on the stamp alone — no gesture, no event.
      await render({
        ...sleeperProps,
        workspaces: [workspace('s1', 'Sleeper', { snoozedUntil: createdAt - HOUR }), sleepers[1]!],
      } as unknown as SidebarProps)
      assert.ok(rowFor('Sleeper'), 'the woken chat brings its project back with it')
      // Counted off the fold row, not off the row list: this folder's shelf was
      // left open earlier in the file, so the sleeper still in it is on screen too.
      assert.match(foldRow('Snoozed')?.textContent ?? '', /Snoozed\s*1/, 'and the one still asleep is counted again')
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar snoozed shelf tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
