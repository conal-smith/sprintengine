import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.identityIcon', async () => {
  // Owner, 2026-09-02: the identity slot belongs to the FOLDER header — the
  // project's own logo when its repo has one, the folder glyph when it does not —
  // and the chat rows beneath it carry no icon at all (they briefly carried the
  // logo, once per chat, under a ruling since reversed). This suite mounts the real
  // sidebar and asserts what each level renders, because that split is the thing
  // the ruling decided and nothing below the component can prove it.

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

  // Only `/projA` has a logo, so one mount renders both halves of the ruling:
  // a logo header and a glyph header adjacent, which is the case it was about.
  const LOGO_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
  // A deliberately minimal bridge, the same shape the sibling sidebar suites
  // use: unrelated nav entries touch methods that are not here, throw inside
  // their own effects, and are contained there — which is exactly why this suite
  // does NOT await `act` (an async act flushes those effects into the test).
  const detected: string[] = []
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async (folderPath: string) => {
      detected.push(folderPath)
      return folderPath === '/projA' ? { path: '/projA/logo.svg', mtimeMs: 1, dataUrl: LOGO_DATA_URL } : null
    },
  }

  // Each mark's distinctive path, so "the glyph rendered" is pinned to the real
  // mark rather than to "some svg is present". The standard glyph is the terminal
  // mark the chat rows used to wear; it must not come back.
  const STANDARD_GLYPH_PATH = 'M7.25 10L10 12.5L7.25 15'
  const FOLDER_GLYPH_PATH =
    'M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z'

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })
    const { resetProjectLogos } = await import('../../utils/projectLogos')

    resetProjectLogos()

    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    const workspace = (id: string, name: string, folderPath: string) =>
      ({ id, name, mode: 'standard', folderPath }) as unknown

    const workspaces = [
      workspace('w1', 'Alpha', '/projA'),
      workspace('w2', 'Bravo', '/projB'),
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
    // Detection is asynchronous, so drain the microtasks it settles over outside
    // `act`, then re-enter to commit the resulting store update.
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
    act(() => {})

    const rows = [...container.querySelectorAll('[role="treeitem"]')]
    assert.ok(rows.length >= 2, 'both project rows rendered')

    const rowFor = (name: string) => {
      const row = rows.find((candidate) => candidate.textContent?.includes(name))
      assert.ok(row, `row for ${name} rendered`)
      return row!
    }

    // The chat rows: no icon slot, on either half. Not the folder's logo repeated
    // per row, and not the terminal glyph the logo-less rows used to fall back to.
    for (const name of ['Alpha', 'Bravo']) {
      const row = rowFor(name)
      assert.equal(row.querySelector('img'), null, `${name}'s row carries no logo`)
      assert.ok(!row.innerHTML.includes(STANDARD_GLYPH_PATH), `${name}'s row carries no terminal glyph`)
      // The row opens on its title, not on an icon slot. (The trailing action
      // cluster still holds glyphs — close, activity — so this pins the LEADING
      // edge rather than asserting the row is svg-free.)
      assert.ok(
        row.firstElementChild?.textContent?.includes(name),
        `${name}'s row opens on its title, not an icon slot`,
      )
    }

    // The folder headers: the slot, both halves of it.
    const headerFor = (name: string) => {
      const header = [...container.querySelectorAll('button[aria-expanded]')].find((candidate) =>
        candidate.textContent?.includes(name),
      )
      assert.ok(header, `folder header for ${name} rendered`)
      return header!
    }

    const projA = headerFor('projA')
    const projAImage = projA.querySelector('img')
    assert.ok(projAImage, 'a folder whose repo has a logo renders it in the slot')
    assert.equal(projAImage!.getAttribute('src'), LOGO_DATA_URL, 'the slot shows that project own logo')
    assert.equal(projAImage!.getAttribute('aria-hidden'), 'true', 'the logo is decorative, like the glyph')
    assert.ok(!projA.innerHTML.includes(FOLDER_GLYPH_PATH), 'the folder glyph steps aside for the logo')

    const projB = headerFor('projB')
    assert.equal(projB.querySelector('img'), null, 'a folder with no logo renders no image')
    assert.ok(projB.innerHTML.includes(FOLDER_GLYPH_PATH), 'a folder with no logo keeps the folder glyph')

    assert.ok(detected.includes('/projA') && detected.includes('/projB'), 'each project folder is scanned once')

    act(() => {
      root.unmount()
    })
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar identity icon tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
