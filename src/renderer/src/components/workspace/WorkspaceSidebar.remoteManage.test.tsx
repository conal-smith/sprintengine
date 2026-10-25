import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import { meshConversationSessionId } from '../../../../shared/tailnet-mesh'

test('WorkspaceSidebar.remoteManage', async () => {
  // A paired machine's chat is managed from here as a local one is, where its
  // machine takes each part (`MeshConversationManage`), open here or not:
  // Rename renames it there, so every device lists it by the new name; Auto
  // compact is switched there, by the machine that compacts it.

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
  const chat = (fields: { workspaceId: string } & Record<string, unknown>) => ({
    agentId: 'agent-1',
    title: 'Agent one',
    phase: 'completed',
    updatedAt: Date.now() - 2 * hour,
    createdAt: Date.now() - 5 * hour,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 2,
    lastSeq: 8,
    ...fields,
  })
  let listed = [
    chat({
      workspaceId: 'rw1',
      chatTitle: 'Review the parser',
      lastTurnEndedAt: Date.now() - 3 * hour,
      autoCompact: false,
    }),
    chat({ workspaceId: 'rw4', chatTitle: 'Another chat', autoCompact: true }),
  ]
  const changes: Array<{ connectionId: string; workspaceId: string; change: Record<string, unknown> }> = []

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
      workspaces: ['rw1', 'rw4'].map((id) => ({
        id,
        name: 'parser',
        mode: 'standard',
        folderPath: '/Users/dev/parser',
        repository: null,
      })),
      gaps: [],
    }),
    meshConversationList: async () => ({
      ok: true,
      conversations: listed,
      access: 'operate',
      modelSwitch: false,
      lifecycle: true,
      rowMenu: true,
      markUnread: true,
      manage: { rename: true, autoCompact: true },
    }),
    meshChangeConversation: async (input: (typeof changes)[number]) => {
      changes.push(input)
      // The machine writes it, and its next list says so.
      if (input.change.kind === 'rename')
        listed = listed.map((entry) =>
          entry.workspaceId === input.workspaceId ? { ...entry, chatTitle: input.change.name as string } : entry,
        )
      return { ok: true, workspaceId: input.workspaceId }
    },
  }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  useWorkspaceStore.setState({ chatListView: 'projects' })

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const noop = () => {}
  const renamed: Array<{ id: string; name: string }> = []
  useWorkspaceStore.setState({
    renameWorkspace: (id: string, name: string) => renamed.push({ id, name }),
  } as never)
  const props = {
    workspaces: [
      { id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' },
      // The second chat, opened here: a row of this desktop's following it.
      {
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
      },
    ],
    activeWorkspaceId: 'w1',
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
  const remoteRowOf = (title: string) =>
    [...container.querySelectorAll<HTMLElement>('[data-remote-conversation]')].find((row) =>
      (row.textContent ?? '').includes(title),
    )
  const followedRow = () =>
    [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (row) => !row.hasAttribute('data-remote-conversation') && (row.textContent ?? '').includes('Another chat'),
    )
  const menu = () => dom.window.document.querySelector<HTMLElement>('[role="menu"]')
  const itemsOf = (surface: HTMLElement) =>
    [...surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
      .filter((item) => item.closest('[role="menu"]') === surface)
      .map((item) => (item.textContent ?? '').trim())
  const openMenuOn = async (row: HTMLElement | undefined) => {
    assert.ok(row, 'the row is drawn')
    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    const surface = menu()
    assert.ok(surface, 'a menu opens')
    return surface
  }
  const click = async (surface: HTMLElement, label: string) => {
    const item = [...surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((candidate) =>
      (candidate.textContent ?? '').trim().startsWith(label),
    )
    assert.ok(item, `the menu offers ${label}: ${itemsOf(surface).join(', ')}`)
    await act(async () => {
      item.click()
    })
  }
  const typeInto = async (field: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field, value)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () => {
      field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }
  try {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()

    // ── Rename ──
    // A chat no window here holds is renamed in its row, and asked of its machine.
    const surface = await openMenuOn(remoteRowOf('Review the parser'))
    await click(surface, 'Rename')
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Rename Review the parser"]')
    assert.ok(field, 'the row turns into a field')
    assert.equal(field.value, 'Review the parser')
    await typeInto(field, 'Parser, reviewed')
    await settle()
    assert.deepEqual(changes.at(-1), {
      connectionId: 'c1',
      workspaceId: 'rw1',
      change: { kind: 'rename', name: 'Parser, reviewed' },
    })
    assert.ok(remoteRowOf('Parser, reviewed'), 'the row reads the new name')

    // A row opened here is renamed there too, and takes the name here once taken.
    const followedMenu = await openMenuOn(followedRow())
    await click(followedMenu, 'Rename')
    const followedField = container.querySelector<HTMLInputElement>('[role="treeitem"] input')
    assert.ok(followedField, 'the opened row turns into a field')
    await typeInto(followedField, 'Another chat, renamed')
    await settle()
    assert.deepEqual(changes.at(-1), {
      connectionId: 'c1',
      workspaceId: 'rw4',
      change: { kind: 'rename', name: 'Another chat, renamed' },
    })
    assert.deepEqual(renamed, [{ id: 'w-followed', name: 'Another chat, renamed' }])
    assert.ok(
      [...container.querySelectorAll('[role="treeitem"]')].some((row) =>
        (row.textContent ?? '').includes('Another chat, renamed'),
      ),
      'the opened row reads the name its machine lists',
    )

    // ── Auto compact ──
    const escape = async () =>
      act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    await escape()
    const compactMenu = await openMenuOn(remoteRowOf('Parser, reviewed'))
    await click(compactMenu, 'Auto compact')
    assert.deepEqual(changes.at(-1), {
      connectionId: 'c1',
      workspaceId: 'rw1',
      change: { kind: 'auto-compact', enabled: true },
    })
    assert.ok(menu(), 'the switch leaves the menu open to show it flip, as on a local row')
    await escape()
    const followedCompact = await openMenuOn(followedRow())
    await click(followedCompact, 'Auto compact')
    assert.deepEqual(changes.at(-1), {
      connectionId: 'c1',
      workspaceId: 'rw4',
      change: { kind: 'auto-compact', enabled: false },
    })
    await escape()
  } finally {
    act(() => {
      root.unmount()
    })
  }
})
