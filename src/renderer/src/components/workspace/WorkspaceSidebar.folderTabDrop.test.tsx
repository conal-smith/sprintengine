import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.folderTabDrop', async () => {
  // Dropping a dragged tab on a PROJECT header extracts it into a new workspace
  // filed under that project. Before this, the folder header was the one sidebar
  // drop target that ignored tab drags outright — its handlers bail unless a
  // folder-reorder drag is in flight — so extracting a terminal into a different
  // project meant dropping it on the generic "New chat" target (which inherits the
  // SOURCE workspace's folder) and then moving the result. These assertions pin
  // the destination folder, the missing-folder refusal, and the folder-reorder
  // drag that shares the same handlers.

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
  // `detectProjectLogo` is the project-logo bridge the row's identity slot
  // asks for on mount; a repo with no logo answers null and the row
  // keeps its workspace-type glyph.
  domWindow.api = { platform: 'darwin', detectProjectLogo: async () => null }

  // A drag payload's DataTransfer, in the two shapes the handlers read it: `types`
  // during dragover (getData is blocked mid-drag by the real API, which is why
  // dataTransferHasTabDrag reads types) and getData at drop.
  function tabDataTransfer(serialized: string, mime: string): DataTransfer {
    return {
      types: [mime],
      dropEffect: 'none',
      effectAllowed: 'move',
      getData: (type: string) => (type === mime ? serialized : ''),
      setData: () => {},
    } as unknown as DataTransfer
  }

  function fireDrag(target: HTMLElement, type: 'dragover' | 'drop' | 'dragleave', dataTransfer: DataTransfer): void {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(event)
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })
    const { TAB_DRAG_MIME, serializeTabDragPayload } = await import('../../utils/tabDragPayload')

    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]

    const workspace = (id: string, name: string, folderPath: string, extra?: Record<string, unknown>) =>
      ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown

    // The source tab lives in /projA; /projB is the drop destination, so an
    // inherited-folder regression (the old "New chat" behaviour) is visible as a
    // workspace landing back in /projA. /projGone stands in for a folder the user
    // has moved or deleted.
    const workspaces = [
      workspace('w1', 'Alpha', '/projA'),
      workspace('w2', 'Bravo', '/projB'),
      workspace('w3', 'Charlie', '/projGone', { folderMissing: true }),
    ] as SidebarProps['workspaces']

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

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })

    const folderHeader = (displayName: string): HTMLElement => {
      const headers = [...container.querySelectorAll('header')] as HTMLElement[]
      const match = headers.find((el) => el.textContent?.includes(displayName))
      assert.ok(match, `the sidebar renders a folder header for ${displayName}`)
      return match!
    }

    const payload = serializeTabDragPayload({
      sourceWorkspaceId: 'w1',
      tabId: 'tab-terminal-1',
      component: 'terminal',
      name: 'Bran Shea',
      config: null,
      className: null,
    })

    const storeWorkspaces = () => useWorkspaceStore.getState().workspaces
    const baseline = storeWorkspaces().length

    // AC: dragging a tab over a project header offers a move — the header claims
    // the drag rather than letting it fall through unhandled.
    const projB = folderHeader('projB')
    const overTransfer = tabDataTransfer(payload, TAB_DRAG_MIME)
    act(() => {
      fireDrag(projB, 'dragover', overTransfer)
    })
    assert.equal(
      (overTransfer as unknown as { dropEffect: string }).dropEffect,
      'move',
      'a tab dragged over a project header is offered as a move',
    )

    // AC: dropping creates a NEW workspace filed under the header's project, not
    // under the source workspace's project.
    act(() => {
      fireDrag(projB, 'drop', tabDataTransfer(payload, TAB_DRAG_MIME))
    })
    const afterDrop = storeWorkspaces()
    assert.equal(afterDrop.length, baseline + 1, 'dropping a tab on a project header creates one workspace')
    const created = afterDrop[afterDrop.length - 1]
    assert.equal(created.folderPath, '/projB', 'the new workspace is filed under the header it was dropped on')
    assert.notEqual(created.folderPath, '/projA', 'the destination is the drop target, not the source workspace folder')
    assert.equal(created.name, 'Bran Shea', 'the new workspace takes the dragged tab name')

    // A missing folder cannot host a new workspace — the folder context menu hides
    // "New workspace" for the same reason, so the drop is refused outright rather
    // than creating a workspace pointed at a path that is gone.
    const gone = folderHeader('projGone')
    const goneTransfer = tabDataTransfer(payload, TAB_DRAG_MIME)
    act(() => {
      fireDrag(gone, 'dragover', goneTransfer)
    })
    assert.equal(
      (goneTransfer as unknown as { dropEffect: string }).dropEffect,
      'none',
      'a missing folder does not offer a drop',
    )
    act(() => {
      fireDrag(gone, 'drop', tabDataTransfer(payload, TAB_DRAG_MIME))
    })
    assert.equal(storeWorkspaces().length, baseline + 1, 'dropping on a missing folder creates nothing')

    // Regression: the folder header still carries the folder-reorder drag, which
    // shares these handlers. A non-tab drag must never reach the extract path.
    const reorderTransfer = {
      types: ['application/x-sprintengine-folder'],
      dropEffect: 'none',
      effectAllowed: 'move',
      getData: () => '',
      setData: () => {},
    } as unknown as DataTransfer
    act(() => {
      fireDrag(projB, 'dragover', reorderTransfer)
      fireDrag(projB, 'drop', reorderTransfer)
    })
    assert.equal(storeWorkspaces().length, baseline + 1, 'a folder-reorder drag creates no workspace')

    // An agent keeps its id when it moves. Two chats made before agent ids were
    // minted both have an `agent-1`: dropping one's onto the other is refused
    // before anything changes, rather than writing over the destination's own.
    const agentRecord = (name: string) => ({ id: 'agent-1', name }) as never
    const bravoLayout = { global: {}, borders: [], layout: { type: 'row', children: [] } }
    useWorkspaceStore.setState((state) => ({
      workspaces: [
        ...state.workspaces,
        { ...(workspace('w1', 'Alpha', '/projA') as object), agents: { 'agent-1': agentRecord('Source') } },
        {
          ...(workspace('w2', 'Bravo', '/projB') as object),
          agents: { 'agent-1': agentRecord('Destination') },
          layoutModel: bravoLayout,
        },
      ] as never,
    }))
    const agentPayload = serializeTabDragPayload({
      sourceWorkspaceId: 'w1',
      tabId: 'tab-agent-1',
      component: 'agent',
      name: 'Source',
      config: { agentId: 'agent-1' },
      className: null,
    })
    const agentsOf = (id: string) => storeWorkspaces().find((entry) => entry.id === id)?.agents ?? {}
    const bravoRow = container.querySelector('[data-workspace-id="w2"]') as HTMLElement
    assert.ok(bravoRow, 'the sidebar renders a row for Bravo')
    const beforeRefusal = storeWorkspaces().length
    act(() => {
      fireDrag(bravoRow, 'drop', tabDataTransfer(agentPayload, TAB_DRAG_MIME))
    })
    assert.equal(agentsOf('w2')['agent-1']?.name, 'Destination', 'the destination keeps its own agent')
    assert.equal(agentsOf('w1')['agent-1']?.name, 'Source', 'the dragged agent stays where it was')
    assert.deepEqual(
      storeWorkspaces().find((entry) => entry.id === 'w2')?.layoutModel,
      bravoLayout,
      'and no tab for it is added to the destination',
    )
    assert.equal(storeWorkspaces().length, beforeRefusal)

    // Extracted into a chat of its own, it arrives under its own id, and the new
    // chat's tab names that id: the chat does not mint a stranger for the tab.
    act(() => {
      fireDrag(projB, 'drop', tabDataTransfer(agentPayload, TAB_DRAG_MIME))
    })
    const extracted = storeWorkspaces().find((entry) => entry.name === 'Source')
    assert.ok(extracted, 'dropping the agent on a project header makes a chat for it')
    assert.deepEqual(Object.keys(extracted!.agents), ['agent-1'])
    assert.equal(extracted!.agents['agent-1']?.name, 'Source')
    assert.match(JSON.stringify(extracted!.layoutModel), /"agentId":"agent-1"/)
    assert.equal(agentsOf('w1')['agent-1'], undefined, 'it left the chat it came from')

    act(() => {
      root.unmount()
    })
    console.log('workspace sidebar folder tab-drop tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
