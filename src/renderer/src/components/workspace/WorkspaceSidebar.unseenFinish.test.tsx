import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import type { StudioPullRequest } from '../../../../../packages/studio-protocol/src/public'
import type { StudioPullRequests } from '../../../../server/pull-requests/pull-request-domain'
import { installStudioLoopback } from '../../../../../tests/studio-chat-loopback'

test('WorkspaceSidebar.unseenFinish', async () => {
  // "Finished while you were away" (the green row) is read off the visit
  // clock, which is durable and every device shares, not only off a finish
  // this window watched happen. Two scheduled runs that finished overnight,
  // with nobody looking, were green on the MacBook Air following them and
  // plain on the Mac mini that ran them, which had been reloaded since. This
  // mounts the sidebar fresh, with no transition to have watched.

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

  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => [],
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
  }
  const HOUR = 60 * 60_000
  const now = Date.now()
  // A chat whose agent asked Studio to watch its pull request: it is waiting
  // to be woken, not done, so it is not marked finished.
  const watched: StudioPullRequest = {
    url: 'https://github.com/acme/app/pull/12',
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number: 12,
    title: 'Retry the upload',
    state: 'open',
    isDraft: false,
    openedAt: now - 3 * HOUR,
    stateAt: now - 3 * HOUR,
    watch: { since: now - 3 * HOUR, waitingOn: 'checks' },
  }
  const pullRequests: StudioPullRequests = {
    list: async (target) => {
      const workspaces: Record<string, StudioPullRequest[]> = {}
      if ((target.workspaceIds ?? []).includes('watched')) workspaces.watched = [watched]
      return { workspaces, conversations: [] }
    },
    refresh: async () => ({ asked: true }),
    noteWork: async () => undefined,
    noteToolCall: async () => undefined,
    link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'not here' }),
    onChanged: () => () => undefined,
  }
  installStudioLoopback(domWindow as { api?: Record<string, unknown> }, { pullRequests })

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  useWorkspaceStore.setState({ chatListView: 'projects', recordWorkspaceVisit: () => undefined } as never)

  // Made overnight at t0, the moment their visit clock was set; finished at t1.
  const t0 = now - 10 * HOUR
  const t1 = now - 8 * HOUR
  const run = (id: string, name: string, fields: Record<string, unknown> = {}) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath: '/projA',
      createdAt: t0,
      lastVisitedAt: t0,
      lastTurnEndedAt: t1,
      scheduledAgentId: 'sa-1',
      ...fields,
    }) as unknown as Workspace
  const workspaces = [
    run('front', 'Alpha', { scheduledAgentId: null }),
    run('overnight-1', 'Nightly triage'),
    run('overnight-2', 'Nightly changelog'),
    run('seen', 'Opened this morning', { lastVisitedAt: now - HOUR }),
    run('asleep', 'Sleeper', { snoozedUntil: now + 24 * HOUR }),
    run('watched', 'Watcher', { scheduledAgentId: null }),
    run('never-visited', 'Before visits were kept', { lastVisitedAt: null, scheduledAgentId: null }),
  ]
  const noop = () => {}
  let reported: ReadonlySet<string> = new Set()
  const base = {
    workspaces,
    activeWorkspaceId: 'front',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activityByWorkspaceId: Object.fromEntries(workspaces.map((workspace) => [workspace.id, 'idle'])),
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onCloseWorkspace: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onSetSidebarCollapsed: noop,
    sidebarWidth: 260,
    onSetSidebarWidth: noop,
    onUnseenDoneChange: (ids: ReadonlySet<string>) => {
      reported = ids
    },
  } as unknown as SidebarProps
  useWorkspaceStore.setState({ workspaces } as never)

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
  const green = (name: string): boolean => {
    const row = rowOf(name)
    assert.ok(row, `row ${name} is rendered`)
    return row.className.includes('tone-good-faint')
  }
  const foldRow = (label: string): HTMLButtonElement | null =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
      button.textContent?.startsWith(label),
    ) ?? null

  try {
    await render(base)

    assert.equal(green('Nightly triage'), true, 'a run nobody opened finished unseen, on a fresh mount')
    assert.equal(green('Nightly changelog'), true, 'and the other one')
    assert.match(rowOf('Nightly triage')?.textContent ?? '', /finished while you were away/u)
    assert.equal(green('Opened this morning'), false, 'one visited since it finished is seen')
    assert.equal(green('Alpha'), false, 'the chat on screen is being looked at')
    assert.equal(green('Before visits were kept'), false, 'a chat with no visit recorded reads as seen')
    assert.equal(green('Watcher'), false, 'a chat waiting on its watched pull request is not done')
    assert.ok(reported.has('overnight-1') && reported.has('overnight-2'), 'reported up, for the rail’s badge')

    // A sleeping chat is not news until it wakes.
    const shelf = foldRow('Snoozed')
    assert.ok(shelf, 'the sleeping chat is on its folder’s Snoozed shelf')
    act(() => shelf.click())
    await settle()
    assert.equal(green('Sleeper'), false, 'a snoozed row never wears the green')

    // A visit at t2, on any device, after the finish: seen.
    const visited = workspaces.map((workspace) =>
      workspace.id === 'overnight-1' ? ({ ...workspace, lastVisitedAt: now - 30 * 60_000 } as Workspace) : workspace,
    )
    useWorkspaceStore.setState({ workspaces: visited } as never)
    await render({ ...base, workspaces: visited } as SidebarProps)
    assert.equal(green('Nightly triage'), false, 'visited after it finished')
    assert.equal(green('Nightly changelog'), true, 'the other still waits for a look')

    // Working again is not finished.
    await render({
      ...base,
      workspaces: visited,
      activityByWorkspaceId: { ...base.activityByWorkspaceId, 'overnight-2': 'working' },
    } as SidebarProps)
    assert.equal(green('Nightly changelog'), false, 'a chat at work is not finished')
  } finally {
    act(() => {
      root.unmount()
    })
  }
})
