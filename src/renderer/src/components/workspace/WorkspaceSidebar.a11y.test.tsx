import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.a11y', async () => {
  // T21: the workspace tree promised a roving-tabindex it never delivered — rows
  // were <div role="treeitem" onClick> with no tabIndex/key handlers and folder
  // headers were plain <div>s. This suite stands up the real DOM and asserts the
  // keyboard contract on the rendered surface (the Electron app cannot be driven
  // headlessly): one tab stop at a time, Arrow/Enter navigation, folder headers as
  // aria-expanded buttons, and hover-only controls that stay keyboard-reachable.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  // The jsdom window also carries the preload bridge (`window.api`); assignments go
  // through this typed alias so they stay checked instead of landing on `unknown`.
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
  // TruncatedText observes its box; a no-op observer is enough for a static mount.
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver
  // Handlers touch window.api only on interaction we do not exercise here; a stub
  // keeps any incidental reads from throwing at mount.
  // `detectProjectLogo` is the project-logo bridge the row's identity slot
  // asks for on mount; a repo with no logo answers null and the row
  // keeps its workspace-type glyph.
  domWindow.api = { platform: 'darwin', detectProjectLogo: async () => null }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })

    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]

    const workspace = (id: string, name: string, folderPath: string, extra?: Record<string, unknown>) =>
      ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown

    // projA holds the active row plus a sibling; projB holds a live row and a
    // starred row that lives only in the Starred section — enough to exercise
    // both sections without listing Charlie twice.
    const workspaces = [
      workspace('w1', 'Alpha', '/projA'),
      workspace('w2', 'Bravo', '/projA'),
      workspace('w3', 'Charlie', '/projB', { highlight: { color: 'blue', starred: true } }),
      workspace('w4', 'Delta', '/projB'),
    ] as SidebarProps['workspaces']

    const selected: string[] = []
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
      onSelectWorkspace: (id: string) => selected.push(id),
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

    const tree = container.querySelector('nav[role="tree"]')
    assert.ok(tree, 'the sidebar renders a role=tree container')

    // Selection tiers (assets/index.css): the aside is the shell's LEADING list,
    // so `primary`, not `auto`. The difference is the whole of "which chat am I
    // in?" — the pane beside this one is a terminal, which is a canvas and not a
    // selection pane, so under `auto` (rests on anything not :focus-within) the
    // current chat's row sat at the resting tier for the app's entire ordinary
    // life: fill down a rung and `--text-strong` rebound to `--text-default`.
    const aside = container.querySelector('aside[aria-label="Workspaces"]')
    assert.ok(aside, 'the sidebar renders its labelled aside')
    assert.equal(
      aside!.getAttribute('data-selection-pane'),
      'primary',
      'the workspaces aside holds the focused selection tier while focus sits outside every pane',
    )

    const rows = () => [...tree!.querySelectorAll('[role="treeitem"]')] as HTMLElement[]

    // Every workspace row is a treeitem, once: Alpha, Bravo, Delta, and Charlie
    // in Starred. Starring moves Charlie out of projB rather than copying it.
    assert.equal(rows().length, 4, 'each visible workspace row is a treeitem')

    // AC1: roving tabindex — exactly one row is the tab stop, and it is the active
    // one; every other row is removed from the tab order.
    const tabbable = rows().filter((el) => el.getAttribute('tabindex') === '0')
    assert.equal(tabbable.length, 1, 'exactly one treeitem holds the tab stop')
    assert.equal(tabbable[0].getAttribute('aria-current'), 'true', 'the active row owns the tab stop')
    assert.ok(
      rows().every((el) => el.getAttribute('tabindex') === '0' || el.getAttribute('tabindex') === '-1'),
      'non-tab-stop rows are tabindex=-1, not absent',
    )

    // AC1: ArrowDown moves the roving tab stop to the next row in DOM order.
    const first = tabbable[0]
    first.focus()
    const before = rows()
    const startIndex = before.indexOf(first)
    act(() => {
      first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const afterRows = rows()
    const expectedNext = afterRows[startIndex + 1]
    assert.equal(dom.window.document.activeElement, expectedNext, 'ArrowDown focuses the next row')
    assert.equal(expectedNext.getAttribute('tabindex'), '0', 'the newly focused row becomes the tab stop')
    assert.equal(first.getAttribute('tabindex'), '-1', 'the previous row leaves the tab order')

    // AC1: Enter on a focused row selects that workspace.
    const enterTarget = rows()[0]
    enterTarget.focus()
    const selectedBefore = selected.length
    act(() => {
      enterTarget.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    assert.equal(selected.length, selectedBefore + 1, 'Enter on a row selects a workspace')

    // AC1: folder headers are real buttons with aria-expanded (not click-divs).
    const disclosures = [...tree!.querySelectorAll('button[aria-expanded]')] as HTMLElement[]
    // Two folder headers (projA, projB) + the Starred header.
    assert.equal(disclosures.length, 3, 'folder + starred headers are aria-expanded buttons')
    assert.ok(
      disclosures.every((el) => el.tagName === 'BUTTON'),
      'each disclosure is a real <button> element',
    )
    assert.ok(
      disclosures.every((el) => el.getAttribute('aria-expanded') === 'true'),
      'headers start expanded and advertise aria-expanded',
    )
    assert.ok(
      disclosures.every((el) => {
        const controlled = el.getAttribute('aria-controls')
        return controlled && dom.window.document.getElementById(controlled)
      }),
      'each disclosure controls a real body element via aria-controls',
    )

    // Collapsing a folder removes its rows from the tree yet keeps the body node
    // mounted, so the disclosure's aria-controls never dangles.
    const projADisclosure = disclosures.find((el) => el.textContent?.includes('projA'))
    assert.ok(projADisclosure, 'the projA folder header is present')
    const rowsBeforeCollapse = rows().length
    act(() => {
      projADisclosure!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(projADisclosure!.getAttribute('aria-expanded'), 'false', 'collapsing flips aria-expanded')
    assert.ok(rows().length < rowsBeforeCollapse, 'collapsing removes the folder rows from the tree')
    const controlled = projADisclosure!.getAttribute('aria-controls')
    assert.ok(
      controlled && dom.window.document.getElementById(controlled),
      'aria-controls still resolves while collapsed',
    )
    // Re-expand so later assertions see the full tree.
    act(() => {
      projADisclosure!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(rows().length, rowsBeforeCollapse, 're-expanding restores the folder rows')

    // AC2: the hover-only "Folder actions" control is a keyboard-reachable button
    // that reveals itself on focus (focus-visible:opacity-100) rather than trapping
    // focus on an invisible control.
    const folderActions = [...tree!.querySelectorAll('button[aria-label^="Folder actions"]')] as HTMLElement[]
    assert.equal(folderActions.length, 2, 'each folder exposes a Folder actions button')
    assert.ok(
      folderActions.every((el) => !(el as HTMLButtonElement).disabled),
      'Folder actions buttons are enabled (Tab-reachable)',
    )
    assert.ok(
      folderActions.every((el) => (el.getAttribute('class') ?? '').includes('focus-visible:opacity-100')),
      'Folder actions reveal on keyboard focus',
    )

    // AC3: decorative svgs inside the tree carry aria-hidden so they are skipped by
    // assistive tech. The only meaningful svg would be the folder-missing warning,
    // which is absent in this fixture.
    const svgs = [...tree!.querySelectorAll('svg')] as Element[]
    assert.ok(svgs.length > 0, 'the tree renders decorative svgs')
    assert.ok(
      svgs.every((el) => el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('aria-label')),
      'every decorative svg is aria-hidden (or carries a label)',
    )

    act(() => {
      root.unmount()
    })
    console.log('workspace sidebar a11y (roving tree + disclosures) tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
