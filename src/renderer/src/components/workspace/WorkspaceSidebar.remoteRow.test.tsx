import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.remoteRow', async () => {
  // A chat on a paired machine that no window here has open is drawn as a
  // local chat is (owner, 2026-10-08: "they should appear exactly like the
  // others and the only difference should be that there is a little glyph").
  // So it settles from its seat with the same tick, says what its agent last
  // replied on its line rather than wearing a lone provider mark, and keeps
  // its clock where a local row keeps one. Settle asks the machine, which
  // owns the chat's rest.
  //
  // This mounts the real sidebar because the row is drawn there, out of the
  // machine's conversation list, and nothing below the component draws it.

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
  // Two chats over there, as that machine lists them: one idle with a reply
  // to preview, finished three hours ago; one waiting on a question.
  const listed = [
    {
      workspaceId: 'rw1',
      agentId: 'agent-1',
      title: 'Agent one',
      chatTitle: 'How is this project?',
      phase: 'completed',
      updatedAt: Date.now() - 2 * hour,
      createdAt: Date.now() - 5 * hour,
      lastTurnEndedAt: Date.now() - 3 * hour,
      providerId: 'claude-agent',
      modelId: 'opus',
      turnCount: 2,
      lastSeq: 8,
      lastAssistantText: '**Healthy.** The build is green and the backlog is short.',
      branch: 'agent/project-review',
      // A schedule over there started it, and nobody has opened it since: its
      // visit clock is still the moment the run was made.
      scheduledAgentId: 'sa-1',
      lastVisitedAt: Date.now() - 5 * hour,
    },
    {
      workspaceId: 'rw2',
      agentId: 'agent-1',
      title: 'Agent two',
      chatTitle: 'Say hi',
      phase: 'waiting_for_input',
      updatedAt: Date.now() - hour,
      createdAt: Date.now() - 4 * hour,
      providerId: 'claude-agent',
      modelId: 'opus',
      turnCount: 1,
      lastSeq: 3,
    },
  ]
  const settles: unknown[] = []

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
      workspaces: [
        { id: 'rw1', name: 'home-compute', mode: 'standard', folderPath: '/Users/dev/home-compute', repository: null },
        { id: 'rw2', name: 'multicode', mode: 'standard', folderPath: '/Users/dev/multicode', repository: null },
      ],
      gaps: [],
    }),
    meshConversationList: async () => ({
      ok: true,
      conversations: listed,
      access: 'operate',
      modelSwitch: false,
      lifecycle: true,
    }),
    meshSettleConversation: async (input: unknown) => {
      settles.push(input)
      return { ok: true }
    },
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // The flat stream first, the rail's default shape and the one where the
    // row's clock and actions ride the project line instead of the agent's.
    useWorkspaceStore.setState({ chatListView: 'all' })

    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    const noop = () => {}
    const props = {
      workspaces: [{ id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' }],
      activeWorkspaceId: 'w1',
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      activityByWorkspaceId: {},
      residentWorkspaceIds: new Set<string>(),
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
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
    }
    // Unconditional teardown: the sidebar arms interval timers, and a root
    // left mounted after a failed assertion would hang the run.
    try {
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, props))
      })
      await settle()

      const flatRow = [...container.querySelectorAll('[data-remote-conversation]')].find((row) =>
        (row.textContent ?? '').includes('How is this project?'),
      )
      assert.ok(flatRow, 'the flat stream draws the chat on the Mini')
      assert.ok((flatRow.textContent ?? '').includes('home-compute'), 'under its project line')
      assert.ok(
        (flatRow.textContent ?? '').includes('3h'),
        `with the clock a local row wears there: ${flatRow.textContent}`,
      )
      assert.ok(
        (flatRow.textContent ?? '').includes('Healthy. The build is green'),
        'and the line still says what the agent replied',
      )
      assert.ok(flatRow.querySelector('button[aria-label="Settle How is this project?"]'), 'and the tick')

      act(() => {
        useWorkspaceStore.setState({ chatListView: 'projects' })
      })
      await settle()

      const rowOf = (title: string) =>
        [...container.querySelectorAll('[data-remote-conversation]')].find((row) =>
          (row.textContent ?? '').includes(title),
        )
      const idle = rowOf('How is this project?')
      const asking = rowOf('Say hi')
      assert.ok(idle && asking, 'both chats on the Mini are rows here')

      // The one mark that says where it runs.
      assert.equal(idle.querySelector('[data-remote-row-glyph]')?.getAttribute('data-remote-row-glyph'), 'mac-mini')
      // …and the schedule's clock its own machine's row wears, on a chat a
      // schedule started there; none on one a person started.
      const clock = idle.querySelector<HTMLElement>('[data-scheduled-run]')
      assert.ok(clock, 'the run wears the schedule’s clock here too')
      assert.equal(clock.getAttribute('data-scheduled-run'), 'sa-1')
      assert.equal(clock.getAttribute('aria-label'), 'Started by a schedule')
      assert.equal(asking.querySelector('[data-scheduled-run]'), null)
      assert.ok(idle.className.includes('tone-good-faint'), 'and finished while nobody looked: the green row')

      // Its line says what the agent last replied, as a local chat's does —
      // not a provider mark standing alone.
      assert.ok(
        (idle.textContent ?? '').includes('Healthy. The build is green and the backlog is short.'),
        `the line previews the reply: ${idle.textContent}`,
      )
      assert.ok((asking.textContent ?? '').includes('Asked a question'), 'a waiting chat says what it waits on')
      // …and the branch its machine names for it, where a local line draws one.
      assert.ok((idle.textContent ?? '').includes('agent/project-review'), `the branch: ${idle.textContent}`)

      // …and its clock: idle since the agent finished, three hours ago.
      assert.ok((idle.textContent ?? '').includes('3h'), `the idle clock: ${idle.textContent}`)

      // The seat's Settle tick, beside More actions, as on a local row.
      const tick = idle.querySelector('button[aria-label="Settle How is this project?"]') as HTMLButtonElement | null
      assert.ok(tick, 'a chat its machine may settle offers the tick')
      assert.ok(idle.querySelector('button[aria-label="Chat actions"]'), 'and More actions beside it')

      await act(async () => {
        tick.click()
      })
      await settle()
      assert.deepEqual(settles, [{ connectionId: 'c1', workspaceId: 'rw1' }], 'the machine is asked to settle it')
      assert.equal(rowOf('How is this project?'), undefined, 'and the row goes at once, as a local Settle moves one')
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  // Awaited as it is, so a failed assertion fails the test rather than only
  // being printed.
  await main()
})
