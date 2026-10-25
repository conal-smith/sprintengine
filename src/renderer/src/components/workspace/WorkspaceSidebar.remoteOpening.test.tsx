import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import { meshConversationSessionId } from '../../../../shared/tailnet-mesh'

test('WorkspaceSidebar.remoteOpening', async () => {
  // A chat followed from a paired machine has the "New" divider a chat here
  // has. Its visit clock is that machine's: the opening is said with the
  // clock as the machine's list reads it, before this opening's first visit
  // stamp moves it there, and let go as the person leaves the chat.

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
  const hour = 60 * 60_000
  const visitedThere = Date.now() - 2 * hour

  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    getGitRepositoryIdentity: async () => null,
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
      workspaces: [{ id: 'rw4', name: 'parser', mode: 'standard', folderPath: '/Users/dev/parser', repository: null }],
      gaps: [],
    }),
    meshConversationList: async () => ({
      ok: true,
      conversations: [
        {
          workspaceId: 'rw4',
          agentId: 'agent-1',
          title: 'Agent one',
          chatTitle: 'Another chat',
          phase: 'completed',
          updatedAt: Date.now() - hour,
          createdAt: Date.now() - 5 * hour,
          providerId: 'claude-agent',
          modelId: 'opus',
          turnCount: 2,
          lastSeq: 8,
          lastTurnEndedAt: Date.now() - hour,
          lastVisitedAt: visitedThere,
        },
      ],
      access: 'operate',
      modelSwitch: false,
      lifecycle: true,
      rowMenu: true,
      markUnread: true,
    }),
    meshVisitConversation: async () => {
      return { ok: true, workspaceId: 'rw4', lastVisitedAt: Date.now() }
    },
  }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useChatOpening } = await import('../panels/agentChat/unreadDivider')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  useWorkspaceStore.setState({ chatListView: 'projects' })

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const noop = () => {}
  const followed = {
    id: 'w-followed',
    name: 'Another chat',
    mode: 'standard',
    folderPath: null,
    agents: {},
    createdAt: Date.now() - hour,
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: 'rw4',
      workspaceName: 'parser',
      workspaceRoot: '/Users/dev/parser',
      sessionId: meshConversationSessionId('rw4', 'agent-1'),
    },
  }
  const props = (activeWorkspaceId: string) =>
    ({
      workspaces: [{ id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' }, followed],
      activeWorkspaceId,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      activityByWorkspaceId: {},
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
      authState: { authenticated: false },
      authMessage: null,
      accountOpen: false,
      setAccountOpen: noop,
      startLogin: noop,
      refreshAuthState: noop,
      logout: noop,
      openSettings: noop,
      settingsOpen: false,
    }) as unknown as SidebarProps

  // What the chat view reads: the opening of the followed chat, if any.
  const seen: Array<ReturnType<typeof useChatOpening>> = []
  function Probe() {
    seen.push(useChatOpening('w-followed'))
    return null
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
  }
  const render = (activeWorkspaceId: string) =>
    act(() => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(WorkspaceSidebar, props(activeWorkspaceId)),
          React.createElement(Probe),
        ),
      )
    })
  try {
    render('w1')
    await settle()
    assert.equal(seen.at(-1), null, 'a chat not in front has no opening')

    render('w-followed')
    await settle()
    const opening = seen.at(-1)
    assert.ok(opening, 'the followed chat in front has an opening')
    assert.deepEqual(opening.since, { kind: 'visit', at: visitedThere }, "read off the machine's visit clock")

    render('w1')
    await settle()
    assert.equal(seen.at(-1), null, 'leaving the chat lets the opening go')
  } finally {
    act(() => {
      root.unmount()
    })
  }
})
