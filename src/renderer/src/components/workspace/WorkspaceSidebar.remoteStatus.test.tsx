import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import { meshConversationSessionId } from '../../../../shared/tailnet-mesh'

test('a chat opened here from a paired machine wears the marks its machine lists', async () => {
  // Its turns run over there, so this desktop's own sessions know nothing of
  // them: the row reads its machine's list for the working mark, the gold of
  // a wait on the person and the green of a finish nobody has seen, and By
  // status orders it by them as it does a chat here.

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

  const connection = {
    id: 'c1',
    machineName: 'mac-mini',
    endpoint: '100.64.0.9:8471',
    deviceId: 'tnd_1',
    deviceName: 'mini',
    scopes: ['workspace:read', 'conversation:read', 'conversation:operate'],
    pairedAt: '2026-10-08T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  const minute = 60_000
  const now = Date.now()
  const listed = (workspaceId: string, chatTitle: string, phase: string, minutesAgo: number, extra = {}) => ({
    workspaceId,
    agentId: 'agent-1',
    title: 'Agent one',
    chatTitle,
    phase,
    updatedAt: now - minutesAgo * minute,
    createdAt: now - 300 * minute,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 2,
    lastSeq: 8,
    lastUserMessageAt: now - minutesAgo * minute,
    recencyAt: now - minutesAgo * minute,
    ...extra,
  })

  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    getGitRepositoryIdentity: async () => null,
    getWorkspaceChangeSummary: async () => null,
    terminalList: async () => [],
    onTerminalSessionsDelta: () => () => {},
    onTailnetEvent: () => () => {},
    onMeshEvent: () => () => {},
    tailnetGetStatus: async () => ({
      enabled: true,
      running: true,
      endpoint: null,
      port: 8471,
      tailnetAddress: '100.64.0.5',
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
    }),
    tailnetGetLiveState: async () => ({ revision: 1, devices: [] }),
    meshListConnections: async () => [connection],
    meshGetLiveState: async () => ({ revision: 1, requests: [], reachability: [] }),
    meshBrowse: async () => ({
      connectionId: 'c1',
      reachable: true,
      unreachableReason: null,
      unauthorized: false,
      scopes: connection.scopes,
      workspaces: ['rw1', 'rw2', 'rw3'].map((id) => ({
        id,
        name: id,
        mode: 'standard',
        folderPath: `/Users/dev/${id}`,
        repository: null,
      })),
      gaps: [],
    }),
    meshConversationList: async () => ({
      ok: true,
      conversations: [
        listed('rw1', 'Asks approval', 'waiting_for_approval', 30),
        listed('rw2', 'Builds away', 'running', 2, { workingSince: now - minute }),
        listed('rw3', 'Finished unseen', 'completed', 20, {
          lastTurnEndedAt: now - 10 * minute,
          lastVisitedAt: now - 15 * minute,
        }),
      ],
      access: 'operate',
      modelSwitch: false,
      lifecycle: true,
      rowMenu: true,
      markUnread: true,
    }),
    meshVisitConversation: async () => ({ ok: true, workspaceId: 'rw1', lastVisitedAt: Date.now() }),
  }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  useWorkspaceStore.setState({ chatListView: 'projects', recordWorkspaceVisit: () => undefined } as never)

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const noop = () => {}
  // Opened here: a workspace of this desktop following the chat over there.
  const opened = (id: string, name: string, remoteWorkspaceId: string) => ({
    id,
    name,
    mode: 'standard',
    folderPath: null,
    agents: {},
    createdAt: now - 300 * minute,
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: remoteWorkspaceId,
      workspaceName: remoteWorkspaceId,
      workspaceRoot: `/Users/dev/${remoteWorkspaceId}`,
      sessionId: meshConversationSessionId(remoteWorkspaceId, 'agent-1'),
    },
  })
  const workspaces = [
    { id: 'w1', name: 'Local idle', mode: 'standard', folderPath: '/projA', lastUserMessageAt: now - minute },
    opened('w-approval', 'Asks approval', 'rw1'),
    opened('w-working', 'Builds away', 'rw2'),
    opened('w-done', 'Finished unseen', 'rw3'),
  ]
  const props = {
    workspaces,
    activeWorkspaceId: 'w1',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    // What this desktop's own sessions say: nothing runs here for any of them.
    activityByWorkspaceId: { w1: 'idle', 'w-approval': 'idle', 'w-working': 'idle', 'w-done': 'idle' },
    residentWorkspaceIds: new Set<string>(),
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onOpenRemoteSession: noop,
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
  } as unknown as SidebarProps
  useWorkspaceStore.setState({ workspaces } as never)

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
  }
  const render = async (): Promise<void> => {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
  }
  const rowOf = (id: string) =>
    container.querySelector<HTMLElement>(`[role="treeitem"][data-workspace-id="${id}"]`) ?? undefined
  const idsIn = (scope: Element | null) =>
    [...(scope?.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]') ?? [])].map(
      (row) => row.dataset.workspaceId,
    )

  try {
    await render()
    assert.ok(rowOf('w-approval')?.className.includes('tone-warn-soft'), 'a wait for approval over there is gold here')
    assert.ok(
      rowOf('w-working')?.querySelector('.working-mark'),
      'a turn running over there wears the working mark here',
    )
    assert.ok(rowOf('w-done')?.className.includes('tone-good-faint'), 'a finish nobody saw over there is green here')
    assert.ok(!rowOf('w1')?.className.includes('tone-'), 'the idle chat here wears neither')

    act(() => {
      useWorkspaceStore.setState({ chatListView: 'status' } as never)
    })
    await settle()
    const list = container.querySelector('section[aria-label="Chats by status"]')
    assert.ok(list, 'the by-status list is drawn')
    assert.deepEqual(
      idsIn(list).filter((id) => id !== 'w-working'),
      ['w-approval', 'w-done', 'w1'],
      'waiting first, then the unseen finish, then the newer idle chat',
    )
    const fold = [...list.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
      button.textContent?.startsWith('Working'),
    )
    assert.match(fold?.textContent ?? '', /Working\s*1/u, 'the chat working over there folds into the Working shelf')
  } finally {
    act(() => {
      root.unmount()
    })
    useWorkspaceStore.setState({ chatListView: 'projects' } as never)
  }
})
