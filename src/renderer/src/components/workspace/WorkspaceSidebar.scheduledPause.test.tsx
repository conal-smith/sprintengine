import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, test } from 'vitest'

// Pausing scheduled agents from the sidebar, on the real sidebar: a paused
// schedule's row is quiet and says "Paused", its hover button pauses and
// resumes it, the Scheduled section pauses them all and says so while it
// does, and a chat a schedule started offers to pause that schedule from its
// menu — no other chat does. The rules behind each are main's
// (scheduled-agents-pause.test.ts); this is what the person sees and presses.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>

beforeAll(() => {
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
})

const createdAt = Date.now()
const scheduledAgent = (id: string, prompt: string, fields: Record<string, unknown> = {}) => ({
  id,
  prompt,
  schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
  folderPath: '/projA',
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
  lastRun: null,
  lastFailureSeenAt: null,
  nextRunAt: createdAt + 60 * 60 * 1000,
  ...fields,
})

type Calls = { paused: string[]; resumed: string[]; pausedAll: Array<number | null>; resumedAll: number }

let unmount: (() => void) | null = null
afterEach(async () => {
  unmount?.()
  unmount = null
  const { resetScheduledAgentsStoreForTests } = await import('../../store/scheduledAgentsStore')
  resetScheduledAgentsStoreForTests()
  dom.window.document.body.innerHTML = ''
})

async function mount(agents: unknown[]) {
  const calls: Calls = { paused: [], resumed: [], pausedAll: [], resumedAll: 0 }
  let publishAgents: (agents: unknown) => void = () => {}
  let publishPause: (pause: unknown) => void = () => {}
  const viewOf = (id: string) => agents.find((agent) => (agent as { id: string }).id === id)
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [],
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
    terminalKill: async () => {},
    listScheduledAgents: async () => agents,
    onScheduledAgentsChanged: (listener: (agents: unknown) => void) => {
      publishAgents = listener
      return () => {}
    },
    getScheduledAgentsPause: async () => null,
    onScheduledAgentsPauseChanged: (listener: (pause: unknown) => void) => {
      publishPause = listener
      return () => {}
    },
    pauseScheduledAgent: async (id: string) => {
      calls.paused.push(id)
      return { ok: true, agent: { ...(viewOf(id) as object), pausedAt: createdAt, nextRunAt: null } }
    },
    resumeScheduledAgent: async (id: string) => {
      calls.resumed.push(id)
      return { ok: true, agent: viewOf(id) }
    },
    pauseAllScheduledAgents: async (until: number | null) => {
      calls.pausedAll.push(until)
      return { ok: true, pause: { since: createdAt, until } }
    },
    resumeAllScheduledAgents: async () => {
      calls.resumedAll += 1
      return { ok: true }
    },
  }

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
  const noop = () => {}
  const props = {
    workspaces: [workspace('w1', 'Alpha'), workspace('w2', 'Fix open issues', { scheduledAgentId: 'sa-1' })],
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activeWorkspaceId: 'w1',
    activityByWorkspaceId: { w1: 'idle', w2: 'idle' },
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onCloseWorkspace: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onOpenScheduledAgent: noop,
    onNewScheduledAgent: noop,
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
  act(() => {
    root.render(React.createElement(WorkspaceSidebar, props))
  })
  await settle()
  unmount = () => act(() => root.unmount())

  const body = dom.window.document.body
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-scheduled-agent="${id}"]`)!
  const chatRow = (name: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>('[data-row-key]')].find((candidate) =>
      candidate.textContent?.includes(name),
    )!
  const menuItems = () => [...body.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
  const menuItem = (text: string) => menuItems().find((item) => item.textContent?.includes(text)) ?? null
  const click = async (element: HTMLElement) => {
    act(() => {
      element.click()
    })
    await settle()
  }
  const rightClick = async (element: HTMLElement) => {
    act(() => {
      element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    await settle()
  }
  const closeMenus = async () => {
    act(() => {
      body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
  }
  return {
    calls,
    container,
    body,
    row,
    chatRow,
    menuItem,
    click,
    rightClick,
    closeMenus,
    settle,
    publishAgents: async (next: unknown[]) => {
      act(() => publishAgents(next))
      await settle()
    },
    publishPause: async (pause: unknown) => {
      act(() => publishPause(pause))
      await settle()
    },
  }
}

test('a paused schedule is quiet and says Paused, since when; a running one says neither', async () => {
  const pausedAt = createdAt - 5 * 60 * 1000
  const view = await mount([
    scheduledAgent('sa-1', 'Fix open GitHub issues'),
    scheduledAgent('sa-2', 'Apply bug fixes to Studio', { pausedAt, nextRunAt: null }),
  ])
  const running = view.row('sa-1')
  const paused = view.row('sa-2')
  assert.equal(running.dataset.paused, undefined)
  assert.doesNotMatch(running.textContent ?? '', /Paused/u)
  assert.equal(paused.dataset.paused, 'true')
  assert.ok(paused.querySelector('[role="img"][aria-label="Paused"]'), 'the Paused badge is in the seat')
  assert.match(paused.textContent ?? '', /Paused since/u)
  assert.match(paused.getAttribute('aria-label') ?? '', /Paused since/u)
})

test("a schedule's pause button pauses it, and resumes it once it is paused", async () => {
  const view = await mount([scheduledAgent('sa-1', 'Fix open GitHub issues')])
  const pauseButton = view.row('sa-1').querySelector<HTMLElement>('[data-scheduled-agent-pause]')!
  assert.equal(pauseButton.dataset.scheduledAgentPause, 'pause')
  assert.equal(pauseButton.getAttribute('aria-label'), 'Pause schedule: Fix open GitHub issues')
  await view.click(pauseButton)
  assert.deepEqual(view.calls.paused, ['sa-1'])

  // Main says it is paused: the row turns, and its button resumes it.
  await view.publishAgents([scheduledAgent('sa-1', 'Fix open GitHub issues', { pausedAt: createdAt, nextRunAt: null })])
  const resumeButton = view.row('sa-1').querySelector<HTMLElement>('[data-scheduled-agent-pause]')!
  assert.equal(view.row('sa-1').dataset.paused, 'true')
  assert.equal(resumeButton.dataset.scheduledAgentPause, 'resume')
  await view.click(resumeButton)
  assert.deepEqual(view.calls.resumed, ['sa-1'])
})

test("a schedule's own menu runs it now and pauses it", async () => {
  const view = await mount([scheduledAgent('sa-1', 'Fix open GitHub issues')])
  await view.rightClick(view.row('sa-1'))
  assert.ok(view.menuItem('Run now'), 'Run now is offered, paused or not')
  assert.ok(view.menuItem('Close schedule'))
  await view.click(view.menuItem('Pause schedule')!)
  assert.deepEqual(view.calls.paused, ['sa-1'])
})

test('the Scheduled section pauses them all for a while, says so, and resumes them', async () => {
  const view = await mount([
    scheduledAgent('sa-1', 'Fix open GitHub issues'),
    scheduledAgent('sa-2', 'Apply bug fixes to Studio', { pausedAt: createdAt, nextRunAt: null }),
  ])
  const section = () => view.container.querySelector<HTMLElement>('section[aria-label="Scheduled agents"]')!
  assert.equal(section().querySelector('[data-scheduled-paused-notice]'), null, 'no notice while they run')
  const trigger = section().querySelector<HTMLElement>('button[aria-label="Pause all scheduled agents"]')!
  await view.click(trigger)
  const hour = view.menuItem('For 1 hour')
  assert.ok(hour, 'an hour')
  assert.ok(view.menuItem('Until tomorrow morning'))
  assert.ok(view.menuItem('Until I resume them'))
  const before = Date.now()
  await view.click(hour)
  assert.equal(view.calls.pausedAll.length, 1)
  const until = view.calls.pausedAll[0]!
  assert.ok(until >= before + 60 * 60 * 1000 - 1000 && until <= Date.now() + 60 * 60 * 1000, 'an hour from now')

  // Main says they are paused: the line over the section, every row quiet.
  await view.publishPause({ since: createdAt, until })
  const notice = section().querySelector<HTMLElement>('[data-scheduled-paused-notice]')
  assert.ok(notice)
  assert.match(notice.textContent ?? '', /^Scheduled agents paused until /u)
  assert.equal(view.row('sa-1').dataset.paused, 'true')
  assert.match(view.row('sa-1').getAttribute('aria-label') ?? '', /Paused with every scheduled agent/u)

  // Resume, from the line or beside the fold; each schedule's own pause is main's to keep.
  const resume = [...section().querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent === 'Resume',
  )!
  await view.click(resume)
  await view.click(section().querySelector<HTMLElement>('button[aria-label="Resume scheduled agents"]')!)
  assert.equal(view.calls.resumedAll, 2)
  await view.publishPause(null)
  assert.equal(section().querySelector('[data-scheduled-paused-notice]'), null)
  assert.equal(view.row('sa-1').dataset.paused, undefined)
  assert.equal(view.row('sa-2').dataset.paused, 'true', 'its own pause is still drawn')
})

test('only a chat a schedule started offers to pause that schedule from its menu', async () => {
  const view = await mount([scheduledAgent('sa-1', 'Fix open GitHub issues')])
  await view.rightClick(view.chatRow('Alpha'))
  assert.ok(view.menuItem('Rename'), 'the chat menu is open')
  assert.equal(view.menuItem('Pause this schedule'), null)
  assert.equal(view.menuItem('Resume this schedule'), null)
  await view.closeMenus()

  await view.rightClick(view.chatRow('Fix open issues'))
  await view.click(view.menuItem('Pause this schedule')!)
  assert.deepEqual(view.calls.paused, ['sa-1'])

  await view.publishAgents([scheduledAgent('sa-1', 'Fix open GitHub issues', { pausedAt: createdAt, nextRunAt: null })])
  await view.rightClick(view.chatRow('Fix open issues'))
  await view.click(view.menuItem('Resume this schedule')!)
  assert.deepEqual(view.calls.resumed, ['sa-1'])
})
