import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { StudioPullRequest } from '../../../../../packages/studio-protocol/src/public'
import type { ConversationEvent, ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import type { PullRequestsChanged, StudioPullRequests } from '../../../../server/pull-requests/pull-request-domain'
import { installRenderCounter } from '../../../../../tests/render-counter'
import { installStudioLoopback } from '../../../../../tests/studio-chat-loopback'

// How much of the sidebar renders for the things that happen all day in a
// window: a token streaming into one chat, a switch between chats, a store
// write the sidebar draws nothing from, a pull request poll answering, and an
// agent starting a turn. The list is the size of a working day's (sixty chats
// over six folders), its inputs are derived the way the workspace manager
// derives them, and each count is held at what the sidebar costs today so a
// change that makes every row render again fails here, not in a profile.

const ROWS = 60

// The relative clock's interval, driven by hand so a tick is one step here.
vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
const FOLDERS = 6

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
Object.assign(anyGlobal, {
  window: domWindow,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
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

const NOW = Date.now()
const workspaceId = (index: number) => `w${index}`
const agentId = (index: number) => `a${index}`

let sessions: ConversationSessionSummary[] = Array.from({ length: ROWS }, (_, index) => ({
  sessionId: `s${index}`,
  workspaceId: workspaceId(index),
  agentId: agentId(index),
  providerId: 'claude-code',
  modelId: 'model',
  status: 'ready',
  createdAt: NOW - 60_000 * (index + 10),
  updatedAt: NOW - 60_000 * (index + 1),
  capabilities: {} as ConversationSessionSummary['capabilities'],
  lastUserText: `Question ${index}`,
  lastAssistantText: `Answer ${index}`,
}))
const conversationListeners = new Set<(event: ConversationEvent) => void>()
domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [],
  onTerminalSessionsDelta: () => () => {},
  getWorkspaceChangeSummary: async () => null,
  conversationSessionsList: async () => ({ ok: true, sessions }),
  onConversationEvent: (listener: (event: ConversationEvent) => void) => {
    conversationListeners.add(listener)
    return () => conversationListeners.delete(listener)
  },
}

const pullRequestAnswers: Record<string, StudioPullRequest[]> = {}
const pullRequestListeners = new Set<(change: PullRequestsChanged) => void>()
const pullRequests: StudioPullRequests = {
  list: async (target) => ({
    workspaces: {},
    conversations: (target.conversations ?? []).flatMap((key) => {
      const found = pullRequestAnswers[`${key.workspaceId}\0${key.agentId}`]
      return found ? [{ ...key, pullRequests: found }] : []
    }),
  }),
  refresh: async () => ({ asked: true }),
  noteWork: async () => undefined,
  noteToolCall: async () => undefined,
  link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'not here' }),
  onChanged: (listener) => {
    pullRequestListeners.add(listener)
    return () => pullRequestListeners.delete(listener)
  },
}
installStudioLoopback(domWindow as { api?: Record<string, unknown> }, { pullRequests })

let seq = 0
function conversationEvent(index: number, type: ConversationEvent['type'], payload: Record<string, unknown> = {}) {
  seq += 1
  const event: ConversationEvent = {
    id: `e${seq}`,
    seq,
    sessionId: `s${index}`,
    workspaceId: workspaceId(index),
    agentId: agentId(index),
    providerId: 'claude-code',
    modelId: 'model',
    type,
    createdAt: Date.now(),
    payload,
  }
  for (const listener of conversationListeners) listener(event)
}

const counter = installRenderCounter()
const profiled = { ms: 0 }

async function mountSidebar() {
  const React = await import('react')
  const { act, useMemo, useRef, createElement } = React
  const { createRoot } = await import('react-dom/client')
  const { useShallow } = await import('zustand/react/shallow')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { selectWorkspaceManagerWorkspaces } = await import('./manager/workspaceSelector')
  const { useConversationSessions, groupConversationSessionsByWorkspace } =
    await import('../../hooks/conversationSessionsStore')
  const { useTerminalSessions } = await import('../../hooks/useTerminalSessions')
  const { getWorkspaceActivity } = await import('./workspaceManagerHelpers')
  const { combinedAgentActivity } = await import('./sidebar/conversationLines')
  const { residentAgentWorkspaceIds } = await import('../../utils/workspaceResidency')
  const { stableRecord, stableSet } = await import('./stableRowSlices')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  const workspaces = Array.from(
    { length: ROWS },
    (_, index) =>
      ({
        id: workspaceId(index),
        name: `Chat ${index}`,
        mode: 'standard',
        folderPath: `/Users/dev/project-${index % FOLDERS}`,
        createdAt: NOW - 3_600_000,
        lastUserMessageAt: NOW - 60_000 * (index + 1),
        agents: {
          [agentId(index)]: {
            id: agentId(index),
            name: `Chat ${index}`,
            runtimeKind: 'conversation',
            conversation: { providerId: 'claude-code', modelId: 'model' },
          },
        },
        layoutModel: {
          global: {},
          layout: {
            type: 'row',
            children: [
              {
                type: 'tabset',
                children: [{ type: 'tab', component: 'agent', config: { agentId: agentId(index) } }],
              },
            ],
          },
        },
      }) as unknown as Workspace,
  )
  useWorkspaceStore.setState({
    workspaces,
    activeWorkspaceId: workspaceId(0),
    workspaceWindows: [
      {
        id: 'win1',
        workspaceIds: workspaces.map((workspace) => workspace.id),
        activeWorkspaceId: workspaceId(0),
        lastFocusedAt: NOW,
      },
    ],
  } as never)

  const noop = () => {}
  const NO_SESSIONS: readonly never[] = []
  const callbacks = {
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onSetSidebarCollapsed: noop,
    onSetSidebarWidth: noop,
    onUnseenDoneChange: noop,
    onSnoozedWorkspacesChange: noop,
  }

  // The manager's derivations of the sidebar's props, as it makes them.
  function Host() {
    const storeWorkspaces = useWorkspaceStore(useShallow((s) => selectWorkspaceManagerWorkspaces(s.workspaces)))
    const activeId = useWorkspaceStore(
      (s) => s.workspaceWindows.find((windowState) => windowState.id === 'win1')?.activeWorkspaceId ?? null,
    )
    const conversationSessions = useConversationSessions()
    const terminalSessions = useTerminalSessions()
    const groupedRef = useRef<ReadonlyMap<string, readonly (typeof conversationSessions)[number][]> | null>(null)
    const grouped = useMemo(() => {
      const next = groupConversationSessionsByWorkspace(conversationSessions, groupedRef.current)
      groupedRef.current = next
      return next
    }, [conversationSessions])
    const activityRef = useRef<Record<string, ReturnType<typeof combinedAgentActivity>> | null>(null)
    const activityByWorkspaceId = useMemo(() => {
      const map: Record<string, ReturnType<typeof combinedAgentActivity>> = {}
      for (const workspace of storeWorkspaces) {
        map[workspace.id] = combinedAgentActivity(
          getWorkspaceActivity(workspace, terminalSessions),
          grouped.get(workspace.id) ?? NO_SESSIONS,
        )
      }
      const stable = stableRecord(map, activityRef.current)
      activityRef.current = stable
      return stable
    }, [storeWorkspaces, terminalSessions, grouped])
    const residentRef = useRef<ReadonlySet<string> | null>(null)
    const residentWorkspaceIds = useMemo(() => {
      const stable = stableSet(residentAgentWorkspaceIds(terminalSessions, conversationSessions), residentRef.current)
      residentRef.current = stable
      return stable
    }, [terminalSessions, conversationSessions])
    return createElement(WorkspaceSidebar, {
      ...callbacks,
      workspaces: storeWorkspaces,
      activeWorkspaceId: activeId,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      activityByWorkspaceId,
      residentWorkspaceIds,
      terminalRecencyByWorkspaceId: EMPTY_RECENCY,
      conversationSessions,
      sidebarWidth: 260,
    } as unknown as SidebarProps)
  }
  const EMPTY_RECENCY = {}

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (ms = 0): Promise<void> => {
    for (let round = 0; round < 6; round += 1) {
      await act(async () => {
        for (let i = 0; i < 12; i += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, round === 0 ? ms : 0))
      })
    }
  }
  await act(async () =>
    root.render(
      createElement(
        React.Profiler,
        { id: 'sidebar', onRender: (_id: string, _phase: string, actual: number) => void (profiled.ms += actual) },
        createElement(Host),
      ),
    ),
  )
  await settle(400)
  return { act, settle, useWorkspaceStore, container }
}

type Cost = { sidebar: number; rows: number; total: number }
function cost(): Cost {
  return {
    sidebar: counter.renders('WorkspaceSidebar'),
    rows: counter.renders('WorkspaceRow'),
    total: counter.totalRenders(),
  }
}

// What each event costs today. A change that lowers one lowers its line; one
// that raises it has to say why here.
const BUDGET: Record<string, Cost> = {
  'stream 50 tokens into one chat': { sidebar: 0, rows: 0, total: 0 },
  // The row left and the row opened.
  'switch chat': { sidebar: 1, rows: 2, total: 42 },
  // The git panel write is projected away. The file tree's expanded paths
  // are not (the manager's projection carries them), so that row renders.
  'store writes the sidebar draws nothing from': { sidebar: 1, rows: 1, total: 25 },
  'pull request poll answers for one chat': { sidebar: 1, rows: 1, total: 27 },
  'agent starts a turn': { sidebar: 1, rows: 1, total: 26 },
  // No row's label moved, so no row renders.
  'relative clock ticks': { sidebar: 1, rows: 0, total: 7 },
}

test('sidebar render budget', async () => {
  const sidebar = await mountSidebar()
  expect(sidebar.container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThanOrEqual(ROWS)
  const results: Record<string, Cost> = {}
  const measure = async (name: string, run: () => Promise<void>) => {
    await sidebar.settle(400)
    counter.reset()
    profiled.ms = 0
    await run()
    results[name] = cost()
    if (process.env.RENDER_BUDGET_REPORT) {
      process.stderr.write(`\n${name}: ${JSON.stringify(results[name])} profiled ${profiled.ms.toFixed(1)}ms\n`)
      process.stderr.write(
        counter
          .table()
          .map(([component, count]) => `    ${component}: ${count}`)
          .join('\n') + '\n',
      )
    }
  }

  await measure('stream 50 tokens into one chat', async () => {
    for (let index = 0; index < 50; index++) {
      await sidebar.act(async () => conversationEvent(3, 'content_delta', { turnId: 't', text: 'word ' }))
    }
    await sidebar.settle(400)
  })

  await measure('switch chat', async () => {
    await sidebar.act(async () => sidebar.useWorkspaceStore.getState().setActiveWorkspaceForWindow('win1', 'w5'))
    await sidebar.settle()
  })

  await measure('store writes the sidebar draws nothing from', async () => {
    await sidebar.act(async () =>
      sidebar.useWorkspaceStore.getState().setFileExplorerExpandedPaths(workspaceId(7), ['/Users/dev/project-1/src']),
    )
    await sidebar.act(async () =>
      sidebar.useWorkspaceStore.getState().setGitPanelState(workspaceId(8), { selectedPath: 'src/a.ts' } as never),
    )
    await sidebar.settle()
  })

  await measure('pull request poll answers for one chat', async () => {
    pullRequestAnswers[`${workspaceId(9)}\0${agentId(9)}`] = [
      {
        url: 'https://github.com/acme/app/pull/12',
        number: 12,
        title: 'Fix the cache',
        state: 'open',
        repository: 'acme/app',
      } as unknown as StudioPullRequest,
    ]
    await sidebar.act(async () => {
      for (const listener of pullRequestListeners) listener({ workspaceIds: [workspaceId(9)] } as never)
    })
    await sidebar.settle(400)
  })

  await measure('agent starts a turn', async () => {
    sessions = sessions.map((session, index) =>
      index === 11 ? { ...session, status: 'active' as const, updatedAt: Date.now() } : session,
    )
    await sidebar.act(async () => conversationEvent(11, 'turn_started', { turnId: 't2' }))
    await sidebar.settle(400)
  })

  await measure('relative clock ticks', async () => {
    await sidebar.act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    await sidebar.settle()
  })

  for (const [name, budget] of Object.entries(BUDGET)) {
    const spent = results[name]!
    expect(spent.sidebar, `${name}: sidebar renders`).toBeLessThanOrEqual(budget.sidebar)
    expect(spent.rows, `${name}: row renders`).toBeLessThanOrEqual(budget.rows)
    expect(spent.total, `${name}: component renders`).toBeLessThanOrEqual(budget.total)
  }
})
