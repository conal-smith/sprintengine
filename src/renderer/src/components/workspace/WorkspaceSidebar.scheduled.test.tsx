import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.scheduled', async () => {
  // Scheduled agents have a section of their own at the foot of the list
  // (owner ruling 2026-09-30). Filed among their project's chats, a schedule
  // whose run was working read as a second agent beside the run's chat. Now
  // the schedule is a row in the Scheduled section, naming its project, and
  // each run is an ordinary chat row with the schedule's clock beside its
  // title. The pure rules are utils/scheduledAgentRuns.test.ts's; this mounts
  // the real sidebar because where the rows land is what the ruling is about.

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

  const createdAt = Date.now()
  const scheduledAgent = (id: string, prompt: string, folderPath: string, lastRunWorkspaceId: string | null) => ({
    id,
    prompt,
    schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
    folderPath,
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: null,
    skills: [],
    mcpServers: [],
    worktree: null,
    ownerModuleId: null,
    createdAt,
    updatedAt: createdAt,
    lastRun: lastRunWorkspaceId ? { at: createdAt, ok: true, workspaceId: lastRunWorkspaceId } : null,
    lastFailureSeenAt: null,
    nextRunAt: createdAt + 60 * 60 * 1000,
  })
  let publishScheduledAgents: (agents: unknown) => void = () => {}
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [],
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
    terminalKill: async () => {},
    listScheduledAgents: async () => [
      scheduledAgent('sa-1', 'Triage new issues', '/projA', 'w2'),
      // A project with no chat open here: its schedule gives it no header.
      scheduledAgent('sa-2', 'Refresh the changelog', '/projB', null),
    ],
    onScheduledAgentsChanged: (listener: (agents: unknown) => void) => {
      publishScheduledAgents = listener
      return () => {}
    },
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    useWorkspaceStore.setState({ chatListView: 'projects' })
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
      ({ id, name, mode: 'standard', folderPath: '/projA', createdAt, ...fields }) as unknown as Workspace

    const workspaces = [
      workspace('w1', 'Alpha'),
      // The run sa-1 started, working now.
      workspace('w2', 'Nightly triage', { scheduledAgentId: 'sa-1' }),
    ]

    const opened: string[] = []
    const noop = () => {}
    const props = {
      workspaces,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      residentWorkspaceIds: new Set<string>(),
      activeWorkspaceId: 'w1',
      activityByWorkspaceId: { w1: 'idle', w2: 'working' },
      terminalRecencyByWorkspaceId: {},
      onSelectWorkspace: noop,
      onMoveWorkspaceToNewWindow: noop,
      onMoveWorkspaceToMainWindow: noop,
      onForgetFolder: noop,
      onNewChat: noop,
      onNewChatInFolder: noop,
      onRevealFolder: noop,
      onOpenScheduledAgent: (id: string) => opened.push(id),
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

    const tree = (): HTMLElement => container.querySelector<HTMLElement>('nav[role="tree"]')!
    const folderNames = (): string[] =>
      [...container.querySelectorAll<HTMLElement>('button[aria-controls^="ws-folder-body-"]')].map(
        (button) => button.textContent?.trim() ?? '',
      )
    const scheduledSection = (): HTMLElement | null =>
      container.querySelector<HTMLElement>('section[aria-label="Scheduled agents"]')
    const scheduledRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-scheduled-agent]')]
    const scheduledFold = (): HTMLButtonElement | null =>
      scheduledSection()?.querySelector<HTMLButtonElement>('button[aria-expanded]') ?? null
    const chatRow = (name: string): HTMLElement =>
      [...container.querySelectorAll<HTMLElement>('[data-row-key]')].find((row) => row.textContent?.includes(name))!

    try {
      await render(props)

      // The schedules are not rows of their projects, and a project with only
      // a schedule in it gets no header of its own.
      assert.deepEqual(folderNames(), ['projA'])
      const folderBody = container.querySelector<HTMLElement>('[id^="ws-folder-body-"]')!
      assert.equal(folderBody.querySelectorAll('[data-scheduled-agent]').length, 0, 'no schedule inside a project')

      // They are one section, after every chat.
      const section = scheduledSection()
      assert.ok(section, 'the Scheduled section is drawn')
      assert.equal(tree().lastElementChild, section, 'it is the last thing in the list')
      assert.equal(scheduledFold()?.getAttribute('aria-expanded'), 'true', 'open until the person folds it')
      assert.match(scheduledFold()?.textContent ?? '', /Scheduled\s*2/u)
      assert.deepEqual(
        scheduledRows().map((row) => row.dataset.scheduledAgent),
        ['sa-1', 'sa-2'],
      )

      // Each row names its project, since it no longer sits under it, and says
      // what is true of the schedule rather than claiming to be its run.
      const [triage, changelog] = scheduledRows()
      assert.match(triage!.textContent ?? '', /projA/u)
      assert.match(changelog!.textContent ?? '', /projB/u)
      assert.match(triage!.textContent ?? '', /Run in progress/u)
      assert.doesNotMatch(triage!.textContent ?? '', /Running now/u)
      assert.match(changelog!.textContent ?? '', /weekday/iu, 'an idle schedule says its cadence')

      // A row opens its schedule's editor.
      act(() => {
        triage!.click()
      })
      assert.deepEqual(opened, ['sa-1'])

      // The run's chat is an ordinary chat row with the schedule's clock; a
      // chat a person started carries none.
      const mark = chatRow('Nightly triage').querySelector<HTMLElement>('[data-scheduled-run]')
      assert.ok(mark, 'the run chat wears the clock')
      assert.equal(mark.dataset.scheduledRun, 'sa-1')
      assert.equal(mark.getAttribute('aria-label'), 'Started by a schedule')
      assert.equal(chatRow('Alpha').querySelector('[data-scheduled-run]'), null)

      // The fold closes and opens like the Snoozed shelves.
      act(() => {
        scheduledFold()!.click()
      })
      await settle()
      assert.equal(scheduledFold()?.getAttribute('aria-expanded'), 'false')
      assert.equal(scheduledRows().length, 0, 'a folded section draws no rows')
      act(() => {
        scheduledFold()!.click()
      })
      await settle()
      assert.equal(scheduledRows().length, 2)

      // All chats: the stream holds only chats, and the section follows it.
      act(() => {
        useWorkspaceStore.setState({ chatListView: 'all' })
      })
      await settle()
      const stream = container.querySelector<HTMLElement>('section[aria-label="All chats"]')!
      assert.equal(stream.querySelectorAll('[data-scheduled-agent]').length, 0, 'no schedule in the stream')
      assert.equal(tree().lastElementChild, scheduledSection(), 'the section still closes the list')
      assert.ok(
        [...stream.querySelectorAll<HTMLElement>('[data-scheduled-run]')].some(
          (element) => element.dataset.scheduledRun === 'sa-1',
        ),
        'the run chat wears the clock in the stream too',
      )

      // No schedules, no section.
      act(() => {
        publishScheduledAgents([])
      })
      await settle()
      assert.equal(scheduledSection(), null)
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  await main()
})
