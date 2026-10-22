import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.remoteGroup', async () => {
  // Where a chat born on a paired machine files (owner, 2026-09-11, REVERSING
  // the 2026-09-05 band ruling): under its PROJECT, like every other chat.
  //
  // The Remote band is gone. A remote row whose repository has a clone open here
  // joins that clone's header — the cross-machine filing, restored — and one with no
  // twin founds a header named after its folder over there, never "No folder"
  // and never "machine · project". What is remote about it is said in one mark:
  // the green machine glyph on the row, naming the device on hover.
  //
  // This mounts the real sidebar because the grouping is what the ruling is
  // about, and nothing below the component does it.

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

  const detected: string[] = []
  const identityReads: string[] = []
  domWindow.api = {
    platform: 'darwin',
    // A module's nav entry may subscribe to its own index on mount; a silent
    // subscription keeps the sidebar's later renders (the identity reads
    // resolving) from throwing inside a passive effect.
    detectProjectLogo: async (folderPath: string) => {
      detected.push(folderPath)
      return null
    },
    // one-project-across-machines: /projA is a clone of acme/sprintengine; the
    // remote row Foxtrot below is that repository on the Air.
    getGitRepositoryIdentity: async (folderPath: string) => {
      identityReads.push(folderPath)
      return folderPath === '/projA'
        ? {
            canonicalKey: 'github.com/acme/sprintengine',
            remoteUrl: 'git@github.com:acme/sprintengine.git',
            name: 'sprintengine',
          }
        : null
    },
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
    const workspace = (id: string, name: string, folderPath: string | null, extra?: Record<string, unknown>) =>
      ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown

    const meshLayout = {
      layout: {
        type: 'tabset',
        children: [
          {
            type: 'tab',
            id: 'mesh-conversation:c1:rw1:agent-1',
            component: 'mesh-conversation',
            config: {
              connectionId: 'c1',
              machineName: 'MacBook Air',
              remoteWorkspaceId: 'rw1',
              remoteAgentId: 'agent-1',
              remoteSessionId: 'conversation:rw1:agent-1',
              title: 'Charlie',
            },
          },
        ],
      },
    }
    const remoteOrigin = {
      connectionId: 'c1',
      machineName: 'MacBook Air',
      workspaceId: 'rw1',
      workspaceName: 'relay',
      workspaceRoot: '/Users/me/relay',
    }
    const workspaces = [
      // The remote clone of acme/sprintengine comes FIRST in the list: the group
      // it joins must still be headed by the local folder, not by "No folder".
      workspace('w0', 'Zulu', null, {
        remoteOrigin: {
          connectionId: 'c1',
          machineName: 'MacBook Air',
          workspaceId: 'rw3',
          workspaceName: 'sprintengine',
          workspaceRoot: '/Users/air/sprintengine',
          repository: {
            canonicalKey: 'github.com/acme/sprintengine',
            remoteUrl: 'git@github.com:acme/sprintengine.git',
            name: 'sprintengine',
          },
        },
        layoutModel: { layout: { type: 'row', children: [] } },
      }),
      workspace('w1', 'Alpha', '/projA'),
      workspace('w2', 'Bravo', '/projA'),
      // Born on the Air; its pane is open — on a worktree the create minted
      // there (checkout-and-branch-on-remote-create), so its branch is known.
      workspace('w3', 'Charlie', null, {
        remoteOrigin: {
          ...remoteOrigin,
          checkout: { mode: 'worktree', branch: 'agent/fix', worktreePath: '/Users/me/wt/fix' },
        },
        layoutModel: meshLayout,
      }),
      // Born on the Air; its pane has since closed — the mark must survive.
      workspace('w4', 'Delta', null, { remoteOrigin, layoutModel: { layout: { type: 'row', children: [] } } }),
      // A genuinely folderless local row keeps its old home.
      workspace('w5', 'Echo', null),
      // Born on the Air in ITS clone of acme/sprintengine — the same repository
      // as /projA (one-project-across-machines): files under projA's header.
      workspace('w6', 'Foxtrot', null, {
        remoteOrigin: {
          ...remoteOrigin,
          workspaceId: 'rw2',
          workspaceName: 'sprintengine',
          workspaceRoot: '/Users/air/sprintengine',
          repository: {
            canonicalKey: 'github.com/acme/sprintengine',
            remoteUrl: 'git@github.com:acme/sprintengine.git',
            name: 'sprintengine',
          },
        },
        layoutModel: { layout: { type: 'row', children: [] } },
      }),
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
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
    act(() => {})
    // The identity reads resolve off the event loop and their setState lands
    // through the scheduler, so the wait has to yield a macrotask inside act
    // for the grouping to re-render on them.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }

    const headers = [...container.querySelectorAll('button[aria-expanded]')]
    const headerText = headers.map((header) => header.textContent?.trim() ?? '')
    assert.deepEqual(
      headerText,
      ['projA', 'relay', 'No folder'],
      'no Remote band: the projects, one of them living only on the Air, named after its folder there',
    )
    assert.ok(
      !headerText.some((text) => text.includes('MacBook Air')),
      'and no header names a machine — the project is what a header names',
    )

    const sectionOf = (name: string) => headers[headerText.indexOf(name)]!.closest('section')!
    const rowsOf = (name: string) => [...sectionOf(name).querySelectorAll('[role="treeitem"]')]
    const textOf = (name: string) => rowsOf(name).map((row) => row.textContent ?? '')

    // projA is a clone of acme/sprintengine, and so are Zulu and Foxtrot on the Air
    // (one-project-across-machines): four rows, one project, one header.
    const localRows = textOf('projA')
    assert.equal(localRows.length, 4, 'the two local chats and the Air’s two chats in the same repository')
    for (const name of ['Alpha', 'Bravo', 'Zulu', 'Foxtrot']) {
      assert.ok(
        localRows.some((text) => text.includes(name)),
        `${name} is a row of projA`,
      )
    }

    // The remote rows under that header wear the machine glyph; the local ones
    // do not, which is the whole of what tells them apart.
    const glyphOf = (row: Element) =>
      row.querySelector('[data-remote-row-glyph]')?.getAttribute('data-remote-row-glyph') ?? null
    const byName = (name: string) => rowsOf('projA').find((row) => (row.textContent ?? '').includes(name))!
    assert.equal(glyphOf(byName('Zulu')), 'MacBook Air', 'a remote row names its device on its glyph')
    assert.equal(glyphOf(byName('Foxtrot')), 'MacBook Air')
    assert.equal(glyphOf(byName('Alpha')), null, 'a local row wears none')
    assert.ok(!(byName('Zulu').textContent ?? '').includes('MacBook Air'), 'and the device name is never row text')

    // The project with no clone here is headed by its folder on the Air.
    const relayRows = textOf('relay')
    assert.equal(relayRows.length, 2, 'both chats born in /Users/me/relay')
    assert.ok(relayRows.some((text) => text.includes('Charlie')) && relayRows.some((text) => text.includes('Delta')))
    assert.ok(
      relayRows.find((text) => text.includes('Charlie'))!.includes('agent/fix'),
      'the live remote row names the branch its create landed on',
    )
    assert.ok(
      !relayRows.find((text) => text.includes('Delta'))!.includes('agent/fix'),
      'a parked remote row carries no branch',
    )

    assert.ok(!detected.includes('/Users/me/relay'), 'the remote root is never looked up on the local disk')
    assert.ok(identityReads.includes('/projA'), 'the local folder is still asked which repository it is')
    assert.ok(!identityReads.includes('/Users/air/sprintengine'), 'a remote root is never asked on this disk')

    const noFolderRows = textOf('No folder')
    assert.equal(noFolderRows.length, 1, 'only the genuinely folderless local row is under No folder')
    assert.ok(noFolderRows[0]!.includes('Echo'))

    act(() => {
      root.unmount()
    })
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar remote group tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
