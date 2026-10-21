import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import { meshConversationSessionId } from '../../../../shared/tailnet-mesh'

test('WorkspaceSidebar.remoteMenu', async () => {
  // A chat on a paired machine that no window here has open offers the menu
  // a local chat does (owner report 2026-10-21: "There should effectively be
  // no difference"), each item asking the machine that keeps the chat: Star,
  // Highlight color, Snooze and Auto-settle over its `chat-row-menu`, Mark
  // unread over `chat-mark-unread`, Settle over `conversation-lifecycle`.
  // Only what is about a workspace here, which the row does not have until it
  // is opened, is left out: Rename, New chat in project, Reveal folder (the
  // folder is on the other machine), and Close workspace.
  //
  // This mounts the real sidebar because the row and its menu are drawn there,
  // out of the machine's conversation list.

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
  // Chats over there: one finished and read, one asleep, one starred.
  let listed = [
    chat({
      workspaceId: 'rw1',
      chatTitle: 'Review the parser',
      lastTurnEndedAt: Date.now() - 3 * hour,
      lastVisitedAt: Date.now() - 2 * hour,
    }),
    chat({ workspaceId: 'rw2', chatTitle: 'Sleepy chat', snoozedUntil: Date.now() + 5 * hour }),
    chat({ workspaceId: 'rw3', chatTitle: 'Starred chat', highlight: { starred: true, color: 'green' } }),
    // …and one awake, which keeps the project's header up.
    chat({ workspaceId: 'rw4', chatTitle: 'Another chat' }),
  ]
  const changes: unknown[] = []
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
      workspaces: ['rw1', 'rw2', 'rw3', 'rw4'].map((id) => ({
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
    }),
    meshSettleConversation: async (input: unknown) => {
      settles.push(input)
      return { ok: true }
    },
    meshChangeConversation: async (input: { change: { kind: string; starred?: boolean } }) => {
      changes.push(input)
      // The machine writes it, and its next list says so.
      if (input.change.kind === 'highlight' && input.change.starred)
        listed = listed.map((entry) =>
          entry.workspaceId === 'rw1' ? { ...entry, highlight: { starred: true } } : entry,
        )
      return { ok: true, workspaceId: 'rw1' }
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
    const noop = () => {}
    const opened: unknown[] = []
    const props = {
      workspaces: [
        { id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' },
        // The fourth chat, opened here: a row of this desktop's following it.
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
      onOpenRemoteSession: (spec: unknown, place: unknown) => opened.push({ spec, place }),
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
    const rowOf = (title: string) =>
      [...container.querySelectorAll<HTMLElement>('[data-remote-conversation]')].find((row) =>
        (row.textContent ?? '').includes(title),
      )
    const menu = () => dom.window.document.querySelector<HTMLElement>('[role="menu"]')
    const itemsOf = (surface: HTMLElement) =>
      [...surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
        .filter((item) => item.closest('[role="menu"]') === surface)
        .map((item) => (item.textContent ?? '').trim())
    const openMenuOf = async (title: string) => {
      const row = rowOf(title)
      assert.ok(row, `${title} is a row here`)
      await act(async () => {
        row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
      })
      const surface = menu()
      assert.ok(surface, `${title} opens a menu`)
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
    try {
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, props))
      })
      await settle()

      const surface = await openMenuOf('Review the parser')
      const items = itemsOf(surface)
      for (const label of ['Open', 'Mark unread', 'Move to New Window', 'Star', 'Settle', 'Snooze', 'Auto-settle'])
        assert.ok(
          items.some((item) => item.startsWith(label)),
          `the menu offers ${label}: ${items.join(', ')}`,
        )
      assert.ok((surface.textContent ?? '').includes('Highlight color'), 'and the highlight swatches')
      for (const label of ['Rename', 'Close workspace', 'New chat in project'])
        assert.ok(!items.some((item) => item.startsWith(label)), `and not ${label}, a workspace here's`)
      // Reveal folder is there, off, saying why: the folder is on the Mini.
      const reveal = [...surface.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
        (item.textContent ?? '').startsWith('Reveal folder'),
      )
      assert.ok(reveal?.disabled, 'Reveal folder is shown off')
      assert.ok((reveal.textContent ?? '').includes('On mac-mini'), `with its reason: ${reveal.textContent}`)

      // Star asks the machine, and the row moves to Starred at once.
      await click(surface, 'Star')
      assert.deepEqual(changes, [
        { connectionId: 'c1', workspaceId: 'rw1', change: { kind: 'highlight', starred: true } },
      ])
      assert.ok(menu(), 'Star leaves the menu open to show the change, as on a local row')
      assert.ok(
        itemsOf(menu()!).some((item) => item.startsWith('Unstar')),
        'and it says Unstar now',
      )
      const starred = container.querySelector('[aria-label="Starred workspaces"]')
      assert.ok(starred, 'the Starred section is drawn')
      assert.ok((starred.textContent ?? '').includes('Review the parser'), 'with the chat just starred in it')
      assert.ok((starred.textContent ?? '').includes('Starred chat'), 'and the one its machine had starred')
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await settle()
      assert.ok(
        (container.querySelector('[aria-label="Starred workspaces"]')?.textContent ?? '').includes('Review the parser'),
        'still starred once the machine’s list says so',
      )

      // A chat asleep on its machine is in its project's Snoozed shelf, not the list.
      const shelf = [...container.querySelectorAll<HTMLElement>('button')].find((button) =>
        (button.textContent ?? '').startsWith('Snoozed'),
      )
      assert.ok(shelf, 'the project draws a Snoozed shelf')
      assert.ok((shelf.textContent ?? '').includes('1'), `counting the sleeping chat: ${shelf.textContent}`)
      assert.equal(rowOf('Sleepy chat'), undefined, 'folded away')
      await act(async () => {
        shelf.click()
      })
      await settle()
      const sleepy = rowOf('Sleepy chat')
      assert.ok(sleepy, 'unfolded, the sleeping chat is there')
      const wakeMenu = await openMenuOf('Sleepy chat')
      await click(wakeMenu, 'Wake now')
      assert.deepEqual(changes.at(-1), {
        connectionId: 'c1',
        workspaceId: 'rw2',
        change: { kind: 'snooze', until: null },
      })

      // Move to New Window opens it in a window of its own.
      const moveMenu = await openMenuOf('Review the parser')
      await click(moveMenu, 'Move to New Window')
      assert.equal((opened.at(-1) as { place: unknown }).place, 'new-window')
      assert.equal(
        (opened.at(-1) as { spec: { conversation: { workspaceId: string } } }).spec.conversation.workspaceId,
        'rw1',
      )

      // The row opened here from that machine's chat: its menu's marks are
      // the chat's there too, and asked of that machine.
      const followed = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        (row) => !row.hasAttribute('data-remote-conversation') && (row.textContent ?? '').includes('Another chat'),
      )
      assert.ok(followed, 'the opened chat is a row of this desktop')
      await act(async () => {
        followed.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
      })
      const followedMenu = menu()
      assert.ok(followedMenu)
      const followedItems = itemsOf(followedMenu)
      for (const label of ['Star', 'Snooze', 'Auto-settle', 'Settle'])
        assert.ok(
          followedItems.some((item) => item.startsWith(label)),
          `the opened row offers ${label}: ${followedItems.join(', ')}`,
        )
      await click(followedMenu, 'Auto-settle')
      assert.deepEqual(changes.at(-1), {
        connectionId: 'c1',
        workspaceId: 'rw4',
        change: { kind: 'auto-settle', enabled: true },
      })
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })

      // A machine from before the row menu's tools takes none of them: its
      // chat's menu offers what that machine can still be asked for.
      const { RemoteConversationContextMenu } = await import('./sidebar/contextMenus')
      const olderHost = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(olderHost)
      const olderRoot = createRoot(olderHost)
      act(() => {
        olderRoot.render(
          React.createElement(RemoteConversationContextMenu, {
            x: 0,
            y: 0,
            title: 'Older chat',
            machineName: 'build-box',
            canSettle: true,
            marks: false,
            canMarkUnread: false,
            isDetachedWindow: true,
            workspaceId: 'rw9',
            starred: false,
            color: null,
            snoozedUntil: null,
            autoSettle: false,
            now: Date.now(),
            working: false,
            onClose: noop,
            onSelect: noop,
            onPickColor: noop,
          }),
        )
      })
      const olderMenu = olderHost.ownerDocument.querySelector<HTMLElement>(
        '[aria-label="Chat actions: Older chat on build-box"]',
      )
      assert.ok(olderMenu, 'the older machine’s chat opens a menu')
      const olderItems = itemsOf(olderMenu)
      assert.ok(olderItems.includes('Move to Main Window'), `from a window of its own: ${olderItems.join(', ')}`)
      assert.ok(olderItems.includes('Settle'))
      for (const label of ['Star', 'Snooze', 'Auto-settle', 'Mark unread'])
        assert.ok(!olderItems.some((item) => item.startsWith(label)), `and no ${label}`)
      assert.ok(!(olderMenu.textContent ?? '').includes('Highlight color'))
      act(() => {
        olderRoot.unmount()
      })
    } finally {
      act(() => {
        root.unmount()
      })
    }
  }

  await main()
})
