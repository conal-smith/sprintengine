import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.projectColour', async () => {
  // One colour per project, on the folder glyph (owner ruling 2026-09-09, hashed
  // hues 2026-09-11; backlog/unfiled/2026-09-09-one-colour-per-project-on-the-folder-glyph.md).
  //
  // Everything here is about the SIDEBAR's half of that item, and it mounts the
  // real component because every claim the ruling makes is about what the rail
  // renders: that the hue is on the glyph, hashed from the project's key and keyed
  // by REPOSITORY, that nothing is painted until that key is final, that "No
  // folder" is not a project and gets the dashed outline instead, that the header
  // menu changes it everywhere at once, and that a restart keeps an override. The
  // hash itself has its own unit suite (utils/projectColor.test.ts); this is the
  // surface's.
  //
  // The rail has exactly TWO carriers, reviewed and cut down to them on
  // 2026-09-09: the flat stream's project line and the folder header. The Starred
  // and Remote bands carry no folder glyph at all — a hue there would be a third
  // colour channel on a row that already wears the gold star or the machine
  // glyph, and can also be wearing the needs-input wash. The Remote band is
  // asserted here as a NEGATIVE for exactly that reason.

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

  // The hook's re-ask for a read that did not settle is a 10s timer. Rather than
  // wait it out, intercept exactly that delay and fire it on demand — React's own
  // scheduler uses shorter ones and is left alone.
  const realSetTimeout = globalThis.setTimeout
  const RETRY_DELAY_MS = 10_000
  let pendingRetries: Array<() => void> = []
  anyGlobal.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
    if (delay === RETRY_DELAY_MS && typeof handler === 'function') {
      pendingRetries.push(handler as () => void)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return (realSetTimeout as unknown as (...args: unknown[]) => ReturnType<typeof setTimeout>)(handler, delay, ...rest)
  }) as unknown as typeof setTimeout

  // The reader, under this suite's control: which folders answer, when, and
  // whether the answer SETTLED.
  type IdentityRead = { identity: { canonicalKey: string; remoteUrl: string; name: string } | null; settled: boolean }
  const SPRINTENGINE = {
    canonicalKey: 'github.com/acme/sprintengine',
    remoteUrl: 'git@github.com:acme/sprintengine.git',
    name: 'sprintengine',
  }
  const asks: string[] = []
  const unsettledFolders = new Set<string>()
  let releaseIdentities: () => void = () => {}
  let identityGate: Promise<void> = Promise.resolve()
  function holdIdentities(): void {
    identityGate = new Promise<void>((resolve) => {
      releaseIdentities = resolve
    })
  }

  // No logos anywhere: a project with a detected logo shows its logo instead of a
  // hue, which is a different case and belongs to the identity-icon suite.
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    // /projA is a clone of acme/sprintengine. /projB is a folder with no remote at
    // all — a real project, keyed by path, and the case a "was it answered?"
    // gate must not swallow. Anything in `unsettledFolders` answers "could not
    // ask", which is not an answer and must never be treated as one.
    getGitRepositoryIdentity: async (folderPath: string): Promise<IdentityRead> => {
      asks.push(folderPath)
      await identityGate
      if (unsettledFolders.has(folderPath)) return { identity: null, settled: false }
      return { identity: folderPath === '/projA' ? SPRINTENGINE : null, settled: true }
    },
  }

  /** The hue an svg wears, or null when it wears none. */
  function hueOf(node: Element | null | undefined): number | null {
    const hue = node?.getAttribute('data-project-hue')
    return hue === null || hue === undefined ? null : Number(hue)
  }

  // The menu's own spelling, said once: the swatch row is the kit's
  // (ui/ContextMenu), and this suite should not restate its label per assertion.
  const PICK_HUE_LABEL = 'Project color Violet'
  const AUTOMATIC_LABEL = 'Project color Automatic'

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })
    const { normalizeAppSettings } = await import('../../store/slices/settingsSlice')
    const { resetProjectLogos } = await import('../../utils/projectLogos')
    const { PROJECT_COLOR_PRESETS, projectHue } = await import('../../utils/projectColor')

    resetProjectLogos()

    const HUE_A = projectHue('repo:github.com/acme/sprintengine')
    const HUE_B = projectHue('folder:/projb')
    const PICKED_HUE = PROJECT_COLOR_PRESETS.find((preset) => preset.label === 'Violet')!.hue

    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    const workspace = (id: string, name: string, folderPath: string | null, extra?: Record<string, unknown>) =>
      ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown

    const localWorkspaces = [
      workspace('w1', 'Alpha', '/projA'),
      workspace('w2', 'Bravo', '/projA'),
      workspace('w3', 'Charlie', '/projB'),
    ] as SidebarProps['workspaces']

    const workspaces = [
      ...localWorkspaces,
      // No folder is not a project (decision 6).
      workspace('w4', 'Echo', null),
      // Born on a paired machine, in ITS clone of acme/sprintengine. It is a row of
      // projA like Alpha and Bravo (one-project-across-machines), wearing that
      // project's hue plus the green machine glyph.
      workspace('w5', 'Foxtrot', null, {
        remoteOrigin: {
          connectionId: 'c1',
          machineName: 'MacBook Air',
          workspaceId: 'rw1',
          workspaceName: 'sprintengine',
          workspaceRoot: '/Users/air/sprintengine',
          repository: SPRINTENGINE,
        },
        layoutModel: { layout: { type: 'row', children: [] } },
      }),
    ] as SidebarProps['workspaces']

    const noop = () => {}
    const propsFor = (rows: SidebarProps['workspaces']) =>
      ({
        workspaces: rows,
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
      }) as unknown as SidebarProps

    const settle = async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      act(() => {})
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await new Promise((resolve) => realSetTimeout(resolve, 0))
        })
      }
    }

    const mount = async (mountProps: SidebarProps) => {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, mountProps))
      })
      await settle()
      return { container, root }
    }

    const rowFor = (container: Element, name: string) => {
      const row = [...container.querySelectorAll('[role="treeitem"]')].find((candidate) =>
        candidate.textContent?.includes(name),
      )
      assert.ok(row, `row for ${name} rendered`)
      return row!
    }
    const headerFor = (container: Element, name: string) => {
      const header = [...container.querySelectorAll('button[aria-expanded]')].find((candidate) =>
        candidate.textContent?.includes(name),
      )
      assert.ok(header, `folder header for ${name} rendered`)
      return header!
    }
    const openFolderMenu = (container: Element, name: string) => {
      const button = [...container.querySelectorAll('button[aria-label^="Folder actions"]')].find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(name),
      )
      assert.ok(button, `${name}'s header offers its folder menu`)
      act(() => {
        button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    const closeFolderMenu = () => {
      act(() => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    }
    const swatchLabelled = (label: string) => dom.window.document.querySelector(`button[aria-label="${label}"]`)
    const hueSwatch = () => swatchLabelled(PICK_HUE_LABEL)
    const clickSwatch = async (label: string) => {
      const swatch = swatchLabelled(label)
      assert.ok(swatch, `the folder menu offers "${label}"`)
      act(() => {
        swatch!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
    }
    const projectColorsNow = () => useWorkspaceStore.getState().appSettings.projectColors

    // ── 1 · A hue is painted only once the repository question is ANSWERED ───
    //
    // The bug this guards: a folder keyed by its PATH while its identity read is
    // still in flight hashes to one hue, and a beat later the key becomes the
    // repository's and hashes to another — the glyph visibly changes colour a
    // moment after the window opened.
    holdIdentities()
    const pending = await mount(propsFor(localWorkspaces))
    assert.equal(
      hueOf(headerFor(pending.container, 'projA').querySelector('svg')),
      null,
      'the header glyph is the plain outline while the repository read is in flight, not a hue it would have to give back',
    )

    // The picker is gated on the same answer, and for a sharper reason: a hue
    // picked now would be written to `folder:/projA`, and a beat later the
    // project is keyed `repo:…` and the person's choice has silently vanished.
    openFolderMenu(pending.container, 'projA')
    assert.equal(hueSwatch(), null, 'the folder menu offers no project colour until the key is final')
    closeFolderMenu()

    releaseIdentities()
    await settle()
    assert.equal(
      hueOf(headerFor(pending.container, 'projA').querySelector('svg')),
      HUE_A,
      'once answered, the folder that is a repository wears the hue hashed from the REPOSITORY key',
    )
    assert.equal(
      hueOf(headerFor(pending.container, 'projB').querySelector('svg')),
      HUE_B,
      'and the folder whose read said "no remote" — the case a settled-only gate must not swallow — wears its folder hue',
    )
    assert.deepEqual(projectColorsNow(), {}, 'a hue is derived, never written: the map holds only what a person chose')

    openFolderMenu(pending.container, 'projA')
    assert.ok(hueSwatch(), 'and the picker appears once the key is final')
    closeFolderMenu()

    act(() => {
      pending.root.unmount()
    })

    // ── 2 · A read that could not be MADE is not an answer either ────────────
    //
    // Main answers `settled: false` for a 3s timeout or a git error — a folder on
    // a spun-down volume. Treating that as "no remote" would paint the folder's
    // hue now and the repository's the next time the volume was awake, so it
    // stays colourless and is asked again.
    unsettledFolders.add('/projC')
    const asleep = [...localWorkspaces, workspace('w6', 'Golf', '/projC')] as SidebarProps['workspaces']
    const spunDown = await mount(propsFor(asleep))
    assert.equal(
      hueOf(headerFor(spunDown.container, 'projC').querySelector('svg')),
      null,
      'a folder whose read could not be made stays plain rather than claiming a project colour',
    )
    openFolderMenu(spunDown.container, 'projC')
    assert.equal(hueSwatch(), null, 'nor can a colour be picked for a project whose identity is unknown')
    closeFolderMenu()

    // The volume wakes up. The hook re-asks on main's own retry window rather
    // than holding the folder unanswered for the life of the window.
    asks.length = 0
    unsettledFolders.delete('/projC')
    const retries = pendingRetries
    pendingRetries = []
    assert.ok(retries.length > 0, 'an unsettled read schedules a re-ask')
    act(() => {
      for (const retry of retries) retry()
    })
    await settle()
    assert.ok(asks.includes('/projC'), 'and the re-ask really asks main again')
    assert.equal(
      hueOf(headerFor(spunDown.container, 'projC').querySelector('svg')),
      projectHue('folder:/projc'),
      'once it answers, the project wears its hue like any other',
    )

    act(() => {
      spunDown.root.unmount()
    })

    // ── 3 · The two carriers, and the rows that deliberately have none ───────
    act(() => {
      useWorkspaceStore.getState().setChatListView('all')
    })
    const stream = await mount(propsFor(workspaces))

    // The project line is the row's first child in the stream, and its glyph is
    // the first svg in it: the ONE element the colour is allowed on.
    const glyphOf = (container: Element, name: string) =>
      rowFor(container, name).firstElementChild!.querySelector('svg')

    assert.equal(hueOf(glyphOf(stream.container, 'Alpha')), HUE_A, "the stream line wears its project's hue")
    assert.equal(
      hueOf(glyphOf(stream.container, 'Bravo')),
      HUE_A,
      'every chat of one project shows that project one hue',
    )
    assert.equal(hueOf(glyphOf(stream.container, 'Charlie')), HUE_B, 'and the other project shows the other')

    // The name beside the glyph is not tinted, and neither is the row: the hue
    // identifies, it never grades (design system, "Identity colour").
    assert.equal(
      hueOf(rowFor(stream.container, 'Alpha').firstElementChild!.querySelector('span')),
      null,
      'the project name stays in the row ink — the colour is on the glyph and nowhere else',
    )

    // No folder is not a project.
    const echoGlyph = glyphOf(stream.container, 'Echo')
    assert.equal(hueOf(echoGlyph), null, 'an unfiled chat is given no hue at all')
    assert.equal(
      echoGlyph!.querySelector('path')?.getAttribute('stroke-dasharray'),
      '2 1.6',
      'it wears the dashed outline instead, so unfiled reads as its own thing',
    )

    // A chat running on a paired machine (owner, 2026-09-11). It is a row of its
    // project, so it wears the project's hue on the same folder glyph every other
    // row of that project wears — a project is a repository, and one repository
    // is one colour wherever it runs. The machine's own mark trails the project's
    // name (owner ruling 2026-10-04) and is the only thing marking the row as remote.
    const foxtrot = rowFor(stream.container, 'Foxtrot')
    assert.equal(
      hueOf(glyphOf(stream.container, 'Foxtrot')),
      HUE_A,
      'the Air’s clone of acme/sprintengine is acme/sprintengine',
    )
    const marks = [...foxtrot.firstElementChild!.children]
    assert.equal(marks[0]?.tagName.toLowerCase(), 'svg', 'the folder glyph leads the project line')
    assert.equal(marks[1]?.textContent, 'projA', 'the project’s name follows it')
    assert.equal(
      marks[2]?.querySelector('[data-remote-row-glyph]')?.getAttribute('data-remote-row-glyph') ??
        marks[2]?.getAttribute('data-remote-row-glyph'),
      'MacBook Air',
      'and the machine’s mark trails the name, naming the device',
    )
    assert.ok(!(foxtrot.textContent ?? '').includes('MacBook Air'), 'never as row text')
    assert.equal(hueOf(foxtrot.querySelectorAll('svg')[1]), null, 'the machine’s colour is not a project hue')

    act(() => {
      stream.root.unmount()
    })

    // ── 4 · Changed by the person, everywhere at once, and changed back ──────
    act(() => {
      useWorkspaceStore.getState().setChatListView('projects')
    })
    const tree = await mount(propsFor(workspaces))
    openFolderMenu(tree.container, 'projA')
    assert.equal(
      swatchLabelled(AUTOMATIC_LABEL)?.getAttribute('aria-checked'),
      'true',
      'with no override, "Automatic" is the checked swatch',
    )
    await clickSwatch(PICK_HUE_LABEL)

    assert.equal(
      hueOf(headerFor(tree.container, 'projA').querySelector('svg')),
      PICKED_HUE,
      "the header's own glyph takes the colour the person picked",
    )
    assert.equal(
      hueOf(headerFor(tree.container, 'projB').querySelector('svg')),
      HUE_B,
      'the other project is untouched',
    )
    assert.deepEqual(
      projectColorsNow(),
      { 'repo:github.com/acme/sprintengine': PICKED_HUE },
      'and the choice is stored under the repository key, as the only entry',
    )

    // "Automatic" deletes the override rather than storing the hashed hue: stored,
    // it would stop following the name if the hash were ever retuned.
    openFolderMenu(tree.container, 'projA')
    await clickSwatch(AUTOMATIC_LABEL)
    assert.equal(
      hueOf(headerFor(tree.container, 'projA').querySelector('svg')),
      HUE_A,
      '"Automatic" returns the hashed hue',
    )
    assert.deepEqual(projectColorsNow(), {}, 'by deleting the override')

    openFolderMenu(tree.container, 'projA')
    await clickSwatch(PICK_HUE_LABEL)
    act(() => {
      tree.root.unmount()
    })

    // ── 5 · Restarting the app keeps an override, and hashes the rest ────────
    //
    // A real restart, not a re-mount over the same live store: the persisted map
    // is the ONLY thing carried across, through the same `normalizeAppSettings`
    // the store hydrates with.
    const persisted = { ...projectColorsNow() }
    act(() => {
      useWorkspaceStore.setState({ appSettings: normalizeAppSettings({ projectColors: persisted }, []) })
      useWorkspaceStore.getState().setChatListView('all')
    })
    assert.deepEqual(projectColorsNow(), persisted, 'the map survives the hydrate the next launch performs')

    const restarted = await mount(propsFor(workspaces))
    assert.equal(
      hueOf(glyphOf(restarted.container, 'Alpha')),
      PICKED_HUE,
      'a fresh store hydrated from the persisted map keeps the colour the person chose',
    )
    assert.equal(
      hueOf(glyphOf(restarted.container, 'Charlie')),
      HUE_B,
      'and a project with no override wears the same hashed hue it wore before',
    )
    assert.equal(hueOf(glyphOf(restarted.container, 'Echo')), null, 'the unfiled row is still no project')

    act(() => {
      restarted.root.unmount()
    })
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar project colour tests passed'))
    .catch((error) => {
      console.error(error)
      // Exit rather than fall off the end: a failure leaves a React root mounted,
      // and the row clocks it owns are intervals that would hold the process open
      // until the runner's own timeout instead of reporting the assertion.
      process.exit(1)
    })

  await suiteRun
})
