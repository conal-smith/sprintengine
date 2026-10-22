import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.remoteLink', async () => {
  // What the sidebar shows of another machine once THIS one is off the tailnet
  // (owner, 2026-09-13: "when studio has disconnected from the tailnet, it
  // should no longer show the remote conversations in the side panel — I can
  // still see them even though I have disconnected").
  //
  // `unattachedConversations` already withheld the rows read from a browse. The
  // rows that stayed are the other half: real `Workspace`s here, stamped with
  // `remoteOrigin`, whose whole content is a pane onto a machine that can no
  // longer be reached. They are gated on the LINK — is Tailscale up on this
  // machine — rather than on the listener, which is the inbound half and says
  // nothing about whether the mesh can be reached.
  //
  // This mounts the real sidebar because the gate sits in the grouping, and the
  // two rows it has to tell apart (a local chat, a remote-born one) only exist
  // once the tree is built.

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

  /** This machine's Tailscale address, or null once it has disconnected. */
  let tailnetAddress: string | null = '100.64.0.5'

  const connection = {
    id: 'c1',
    machineName: 'mac-mini',
    endpoint: '100.64.0.9:8471',
    deviceId: 'tnd_1',
    deviceName: 'mini',
    scopes: ['workspace:read', 'conversation:read'],
    pairedAt: '2026-09-13T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }

  // The chat over there, as that machine lists it.
  const remoteChat = {
    workspaceId: 'rw1',
    agentId: 'agent-1',
    title: 'sprintengine',
    phase: 'running',
    updatedAt: 1_000,
    createdAt: 500,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 2,
    lastSeq: 8,
  }

  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    getGitRepositoryIdentity: async () => null,
    // The tailnet presence bridge, complete — without every one of these the
    // hook stays quiet and the link reads `unknown`, which is a different case.
    onTailnetEvent: () => () => {},
    onMeshEvent: () => () => {},
    tailnetGetStatus: async () => ({
      enabled: true,
      running: tailnetAddress !== null,
      endpoint: null,
      port: 8471,
      tailnetAddress,
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
        { id: 'rw1', name: 'sprintengine', mode: 'standard', folderPath: '/Users/mini/sprintengine', repository: null },
      ],
      gaps: [],
    }),
    meshConversationList: async () => ({
      ok: true,
      conversations: [remoteChat],
      access: 'read',
      modelSwitch: false,
    }),
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
    const workspaces = [
      { id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' },
      // A chat opened from the Mini, stored under the OLD naming rule: the
      // agent's name in front of the chat's. Its pane is closed, so nothing but
      // the browse can say what is standing in it.
      {
        id: 'w2',
        name: 'Tara Boyle · sprintengine',
        mode: 'standard',
        folderPath: null,
        // Starred, so the pass below also covers the Starred section: starring
        // moves the row there under a `starred-` key prefix, and a gate that
        // only reached the project tree would leave the chat standing up here
        // with no row at all.
        highlight: { starred: true },
        remoteOrigin: {
          connectionId: 'c1',
          machineName: 'mac-mini',
          workspaceId: 'rw1',
          workspaceName: 'sprintengine',
          workspaceRoot: '/Users/mini/sprintengine',
          sessionId: 'conversation:rw1:agent-1',
        },
        layoutModel: { layout: { type: 'row', children: [] } },
      },
    ] as unknown as SidebarProps['workspaces']

    const noop = () => {}
    const props = {
      workspaces,
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

    // A fresh tree per pass. The link is read once at mount through the presence
    // bridge, and this test changes what that bridge answers between passes —
    // mounting again is how the sidebar asks again, and it keeps each assertion
    // reading a tree built entirely under one answer.
    let container = dom.window.document.createElement('div')
    // Every root this test mounts, so the last act of the run can take them all
    // down: the sidebar arms interval timers (the remote band's slow fallback
    // read among them) and a root left mounted keeps the event loop — and the
    // test process — alive forever.
    const roots: Array<ReturnType<typeof createRoot>> = []
    const render = async (): Promise<void> => {
      // The previous tree goes first: presence is one store per window, kept
      // for as long as anything reads it, so a tree left mounted would keep
      // the last answer and the new one would never ask again.
      act(() => {
        for (const mounted of roots.splice(0)) mounted.unmount()
      })
      container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, props))
      })
      // The reads (status, connections, browse) resolve off the event loop and
      // their setState lands through the scheduler, so settling has to yield a
      // macrotask inside `act` for the rows to render on them.
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
    }

    const rowKeys = (): string[] =>
      [...container.querySelectorAll('[data-row-key]')].map((row) => row.getAttribute('data-row-key') ?? '')
    /** Every row drawn for a workspace, wherever it was drawn. */
    const rowsFor = (id: string): string[] => rowKeys().filter((key) => key === id || key.endsWith(`-${id}`))

    // Unconditional teardown. The sidebar arms interval timers, so a root left
    // mounted keeps the event loop alive: without this a FAILED assertion hangs
    // the run forever instead of printing what went wrong.
    try {
      // ── On the tailnet ─────────────────────────────────────────────────────
      await render()
      assert.deepEqual(
        rowsFor('w2').sort(),
        ['starred-w2'],
        'on the tailnet the chat opened from the Mini is a row, in Starred because it is starred',
      )

      // Titled with the CHAT, not with an agent standing in it — even though the
      // stored name still carries the agent from the old rule.
      const remoteRow = container.querySelector('[data-row-key="starred-w2"]')!
      assert.ok(
        !(remoteRow.textContent ?? '').includes('Tara Boyle'),
        `the agent's name is not the row's title: ${remoteRow.textContent}`,
      )
      assert.ok((remoteRow.textContent ?? '').includes('sprintengine'), 'the chat over there is what the row is called')

      // …and, with its pane closed, it still draws its agent's line — read from
      // the machine's conversation list, the way a local chat draws its terminal.
      const agentMarks = remoteRow.querySelectorAll('[aria-label*="Claude Code"]')
      assert.equal(agentMarks.length, 1, 'the chat’s agent gets a line')
      const markLabel = agentMarks[0]!.getAttribute('aria-label') ?? ''
      assert.ok(markLabel.startsWith('sprintengine ·'), `the line names the chat: ${markLabel}`)

      // ── Off the tailnet ────────────────────────────────────────────────────
      tailnetAddress = null
      await render()
      assert.ok(rowKeys().includes('w1'), 'a local chat is untouched by the tailnet going away')
      assert.deepEqual(
        rowsFor('w2'),
        [],
        `off the tailnet the remote chat is nowhere — not in its project, not in Starred: ${rowKeys().join(', ')}`,
      )
      // Nothing was closed or forgotten — the workspace is still in the props the
      // sidebar was handed, and comes back when the link does.
      assert.equal(workspaces.length, 2)

      tailnetAddress = '100.64.0.5'
      await render()
      assert.deepEqual(rowsFor('w2'), ['starred-w2'], 'and it returns, in Starred, with the link')
    } finally {
      act(() => {
        for (const mounted of roots) mounted.unmount()
      })
    }
  }

  const suiteRun = main()
    .then(() => console.log('sidebar remote link tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
