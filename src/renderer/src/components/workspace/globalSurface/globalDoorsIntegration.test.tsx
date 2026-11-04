import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Type-only: erased at runtime, so it cannot load a renderer module before the
// DOM below exists.
import type { ExtensionsSurfaceTarget } from './extensions/extensionsSurfaceTarget'
import { test } from 'vitest'

test('globalDoorsIntegration', async () => {
  // Epic 1760's integration review (item T10): the pieces T1–T9 built, exercised
  // TOGETHER rather than one surface at a time. The per-item suites each prove
  // their own contract; this one covers the seams between them, which is where an
  // epic assembled by six agents actually breaks:
  //
  //  1. The doors coexist on the REAL renderer kernel — each with a surface
  //     behind it, and each vanishing with its module.
  //  2. The Design door's empty first run and its populated rail, a contained
  //     door failure, the Extensions catalogues, and the absent / workspace-less
  //     door contract.
  //
  // (The Backlog door and its section here retired on 2026-09-05: the workspace
  // pane's Backlog tab is the one Backlog surface.)
  //
  // The Electron app is not drivable headlessly, so this stands up a real DOM,
  // stubs only the preload boundary, and mounts the actual surfaces against one
  // real store.

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
  anyGlobal.CustomEvent = dom.window.CustomEvent
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
  // JSDOM has no scrollIntoView; the Select's open effect scrolls its active
  // option into view, so give it a no-op.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

  const sprintengine = '/work/sprintengine'
  const multiauth = '/work/multiauth'
  const mobile = '/work/sprintengine-mobile'

  // The Design door's world (item 2002): an empty library first, then one real
  // bundle, so the door can be driven through both its first-run empty state and
  // its populated rail.
  let designLibrary: Array<{
    path: string
    name: string
    version: string
    summary: string
    releasedAt: string | null
  }> = []
  const designBundlePath = `${sprintengine}/design-system`
  const designLibraryOnlyPath = '/work/harbor/design-system'
  const designBundles: Record<string, unknown> = {
    ['/work/harbor/design-system']: {
      identity: {
        path: '/work/harbor/design-system',
        name: 'harbor',
        version: '1.2.0',
        summary: 'A cloned system.',
        accent: { light: null, dark: null },
      },
      manifest: {
        schemaVersion: 1,
        name: 'harbor',
        version: '1.2.0',
        summary: 'A cloned system.',
        modes: ['light', 'dark'],
        namingGrammar: {},
        contents: { foundations: ['tokens'], components: ['card'], patterns: [], glyphs: [], assets: [] },
        derived: {},
        provenance: {},
      },
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      specimen: {
        tokensCss: ':root{--sem-color-bg-app:#08080c}',
        ramp: [],
        fontFamilyUi: null,
        fontFamilyMono: null,
        problems: [],
      },
      groups: [
        { key: 'foundations', label: 'Foundations', entries: ['tokens'], count: 1 },
        { key: 'components', label: 'Components', entries: ['card'], count: 1 },
      ],
      components: [],
      patterns: [],
      glyphs: [],
      assetBudgetExhausted: false,
    },
    [designBundlePath]: {
      identity: {
        path: 'SPRINTENGINE_PLACEHOLDER/design-system',
        name: 'sprintengine',
        version: '2.4.0',
        summary: 'The in-house system.',
        // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
        accent: { light: '#2f6a4a', dark: '#4daf7d' },
      },
      manifest: {
        schemaVersion: 1,
        name: 'sprintengine',
        version: '2.4.0',
        summary: 'The in-house system.',
        modes: ['light', 'dark'],
        namingGrammar: {},
        contents: { foundations: ['tokens'], components: ['button', 'input'], patterns: [], glyphs: [], assets: [] },
        derived: {},
        provenance: {},
      },
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      specimen: {
        tokensCss: ':root{--sem-color-bg-app:#08080c}',
        ramp: [],
        fontFamilyUi: null,
        fontFamilyMono: null,
        problems: [],
      },
      groups: [
        { key: 'foundations', label: 'Foundations', entries: ['tokens'], count: 1 },
        { key: 'components', label: 'Components', entries: ['button', 'input'], count: 2 },
      ],
      components: [],
      patterns: [],
      glyphs: [],
      assetBudgetExhausted: false,
    },
  }

  const api: Record<string, unknown> = {
    platform: 'darwin',
    // The shared backlog scan watches each project's `backlog/`; the preload
    // contract hands back the watcher's disposer, so the stub must too.
    watchPath: async () => async () => {},
    // The Design door's library index and per-bundle reader. `designLibrary` is
    // switchable so the door can be driven through "nothing pointed at yet".
    listDesignSystemLibrary: async () => ({ entries: designLibrary, rejected: [] }),
    readDesignSystemBundle: async (bundleDir: string) =>
      designBundles[bundleDir]
        ? { ok: true, view: designBundles[bundleDir] }
        : { ok: false, reason: 'missing', path: bundleDir, message: `gone: ${bundleDir}` },
    readfile: async (path: string) => {
      if (path.startsWith(sprintengine)) return JSON.stringify({ key: 'MC' })
      if (path.startsWith(multiauth)) return JSON.stringify({ key: 'MA' })
      if (path.startsWith(mobile)) return JSON.stringify({ key: 'MM' })
      throw new Error('no config')
    },
  }

  domWindow.api = new Proxy(api, {
    get: (target, prop: string) =>
      prop in target
        ? target[prop]
        : prop.startsWith('on')
          ? () => () => {}
          : async () => ({ ok: false, message: 'not stubbed' }),
  })

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const { getRendererHost } = await import('../../../modules')
    const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
    const { __resetBacklogScanSubscriptionsForTests: resetScans } = await import('../../../hooks/useSharedBacklogScan')

    async function settle(times = 8): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        await act(async () => {
          await Promise.resolve()
        })
      }
    }

    // jsdom ships no types, so annotate the mount point: without it every query
    // off `container` degrades to `unknown` and nothing in this file is checked.
    const container: HTMLDivElement = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)

    // ═══ 1. The doors, and the one modal surface left, on the real kernel ══════
    // Registration is module-owned and eager, so this reads the SAME host the app
    // boots with — not a hand-built one. Extensions (user-facing "Plugins") and
    // Design spent 2026-09-01 to 2026-09-05 in the modal registry and are doors
    // again (Extensions drawer ruling: a destination the shell's own chrome
    // offers routes the card region, it does not float over it). The modal
    // registry is now EMPTY in a stock build — Reviews, its last member,
    // left for the installable Reviews module (2026-09-10), which registers its
    // own modal surface and pane-row launcher when installed. Design is owned by
    // its OWN bundled `design` module.
    {
      const host = getRendererHost()
      const doorOrder = host.getSidebarNavEntries().map((entry) => [entry.id, entry.order] as const)
      assert.deepEqual(doorOrder, [], 'no bundled module draws its own sidebar row in a stock build')
      // The door registry, with the user-facing labels the drawer and the rail
      // read: the `extensions` id keeps its name (it is a persisted surface id
      // and a deep-link target) while every string a person sees says Plugins.
      // Each door names itself here: the Extensions home builds its tiles from
      // this registry, and a shell that hard-coded a name and a glyph for one
      // module's surface would be naming it on the module's behalf.
      const doorSurfaces = host
        .getGlobalSurfaces()
        .map((surface) => [surface.id, surface.label ?? null, surface.railPlacement ?? 'sidebar'] as const)
      assert.deepEqual(
        doorSurfaces,
        [
          ['design', 'Design', 'inline'],
          ['extensions', 'Plugins', 'sidebar'],
        ],
        // Extensions reads `sidebar` — the default — and still leaves the drawer
        // alone: it declares NO rail since the source-tabs ruling (2026-09-05),
        // and GlobalSurfaceShell's contract for a surface that brings none is
        // that the host keeps its own column. `inline` is for a drawer door that
        // does bring one, which is Design.
        'every card-region destination is a door, and the one drawer door that brings a rail keeps it inline',
      )
      // A drawer row that took the sidebar column would delete the drawer that
      // opened it. There are two ways not to take it, and both are asserted:
      // Design brings a rail and declares `inline`; Extensions brings none at all
      // (its rail became the source tabs, 2026-09-05), which the shell already
      // reads as "leave the host's column alone".
      assert.equal(
        host.getGlobalSurface('design')?.railPlacement,
        'inline',
        'the design door renders its rail beside its canvas, so the drawer survives it',
      )
      assert.equal(
        host.getGlobalSurface('extensions')?.railPlacement,
        undefined,
        'the extensions door declares no rail, so there is nothing to take the drawer’s column',
      )
      for (const id of ['design', 'extensions']) {
        assert.ok(host.getGlobalSurface(id)?.Icon, `the ${id} door offers a glyph for its drawer row`)
      }
      // A stock build registers no modal surface at all, and no bundled module
      // contributes a pane-strip launcher row.
      assert.deepEqual(
        host.getModalSurfaces().map((surface) => [surface.id, surface.label] as const),
        [],
        'the modal registry is empty in a stock build; Settings is core and never registered',
      )
      assert.deepEqual(
        host.getModalSurfaceLaunchers(),
        [],
        'and no bundled module contributes a pane-strip launcher row',
      )
      // A door is only as present as its module: turning the module off must take
      // BOTH the row and the page, or the row routes to a page that cannot mount.
      // The Design row
      // and its page leave with the design module (registering a surface from a
      // module that does not own it throws, so this also pins WHICH module owns
      // Design).
      const withoutDesign = (moduleId: string): boolean => moduleId !== 'design'
      assert.ok(
        !host.getGlobalSurfaces(withoutDesign).some((surface) => surface.id === 'design'),
        'the Design row leaves with the design module',
      )
      console.log('ok - the doors, each backed by and gated on its module')
    }

    // The project world the sections below read: three projects open, the first
    // of them active.
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: 'w-mc',
          name: 'sprintengine',
          mode: 'standard',
          folderPath: sprintengine,
          agents: {},
          openFiles: [],
          createdAt: 1,
        },
        {
          id: 'w-ma',
          name: 'multiauth',
          mode: 'standard',
          folderPath: multiauth,
          agents: {},
          openFiles: [],
          createdAt: 2,
        },
        { id: 'w-mm', name: 'mobile', mode: 'standard', folderPath: mobile, agents: {}, openFiles: [], createdAt: 3 },
      ],
      activeWorkspaceId: 'w-mc',
      activeGlobalSurface: null,
    } as never)

    // ═══ 5b. The Design door: empty first-run, then two real groups ══════════
    // Two things only a real mount can prove. First, the double-mount trap: the door
    // must mount exactly ONE rail — Extensions grew a second nested SurfaceRail
    // after the context-rail move, and a door with two navigation columns is the
    // shape item 1993 forbids outright. Second, an empty library must offer the
    // create path rather than leaving a bare column.
    const { default: DesignGlobalSurface } = await import('./design/DesignGlobalSurface')
    useWorkspaceStore.setState({ activeGlobalSurface: 'design' } as never)
    // First run proper: nothing pointed at, and no project open — so there is no
    // attached system either. Anything less is not the empty state.
    const residentWorkspaces = useWorkspaceStore.getState().workspaces
    useWorkspaceStore.setState({ activeWorkspaceId: null } as never)
    designLibrary = []
    const designRoot = createRoot(container)
    await act(async () => {
      designRoot.render(React.createElement(ConfirmDialogProvider, null, React.createElement(DesignGlobalSurface)))
    })
    await settle()
    {
      const text = container.textContent ?? ''
      assert.match(text, /No design systems yet/, 'the empty library says so')
      assert.match(text, /Point at a folder/, 'and offers the create path')
      // The rail is DECLARED, so it is present even with nothing in it — and it
      // is present exactly once.
      const newRows = [...container.querySelectorAll('button')].filter((button) =>
        (button.textContent ?? '').includes('New design system'),
      )
      assert.equal(newRows.length, 1, 'one rail, so one New affordance — never a nested second rail')
      assert.equal(
        container.querySelectorAll('input[aria-label="Search your design systems"]').length,
        1,
        'and one search field',
      )
    }
    await act(async () => {
      designRoot.unmount()
    })
    console.log('ok - the Design door’s empty library offers the create path behind exactly one rail')

    // Now with a project open that carries an attached system AND a separate one
    // in the library: two groups, so the headings earn their place.
    const designProjectWorkspace = residentWorkspaces.find((workspace) => workspace.folderPath === sprintengine)
    assert.ok(designProjectWorkspace, 'the fixture keeps a workspace rooted at the sprintengine project')
    useWorkspaceStore.setState({
      activeWorkspaceId: designProjectWorkspace.id,
    } as never)
    designLibrary = [
      { path: designLibraryOnlyPath, name: 'harbor', version: '1.2.0', summary: 'A cloned system.', releasedAt: null },
    ]
    const designRoot2 = createRoot(container)
    await act(async () => {
      designRoot2.render(React.createElement(ConfirmDialogProvider, null, React.createElement(DesignGlobalSurface)))
    })
    await settle()
    {
      const text = container.textContent ?? ''
      assert.match(text, /sprintengine/, 'the attached system is listed by its own name')
      assert.match(text, /harbor/, 'beside the one that is only in the library')
      // Two groups with rows, so the headings separate something from something.
      assert.match(text, /In this project/)
      assert.match(text, /Library/)
      // Sentence case, never uppercase letter-spaced labels.
      assert.ok(!text.includes('IN THIS PROJECT'))
      // The canvas shows the groups the MANIFEST declares, with their counts, and
      // does not draw a group the manifest declares empty.
      assert.match(text, /Components/, 'a declared, non-empty group renders')
      assert.ok(!text.includes('Patterns'), 'a group the manifest declares empty is not drawn')
    }
    await act(async () => {
      designRoot2.unmount()
    })
    console.log('ok - the Design door groups the attached system and the library, headings and all')

    // ═══ 6. A door failure is contained to the door ═════════════════
    // A surface that throws during render must land in the boundary's fallback —
    // with both recoveries working — instead of white-screening the renderer.
    const { GlobalSurfaceErrorBoundary } = await import('./surfaceSubstrate')
    let closed = 0
    let bombArmed = true
    function BombSurface(): React.ReactElement {
      if (bombArmed) throw new Error('deliberate door failure')
      return React.createElement('div', null, 'door content restored')
    }
    const boundaryRoot = createRoot(container)
    await act(async () => {
      boundaryRoot.render(
        // `children` is a declared prop of the boundary, so it goes in the props
        // object: createElement's variadic children never satisfy a required one.
        React.createElement(GlobalSurfaceErrorBoundary, {
          surfaceId: 'design',
          surfaceLabel: 'Design',
          onClose: () => {
            closed += 1
          },
          children: React.createElement(BombSurface),
        }),
      )
    })
    assert.ok(
      container.textContent?.includes('Design hit a problem and stopped.'),
      'the fallback names the failed surface',
    )
    const fallbackButtons = Array.from(container.querySelectorAll('button'))
    const closeButton = fallbackButtons.find((b) => b.textContent === 'Close')
    const reloadButton = fallbackButtons.find((b) => b.textContent === 'Reload surface')
    assert.ok(closeButton && reloadButton, 'the fallback offers Close and Reload surface')
    await act(async () => {
      ;(closeButton as HTMLElement).click()
    })
    assert.equal(closed, 1, 'Close hands off to closeGlobalSurface')
    bombArmed = false
    await act(async () => {
      ;(reloadButton as HTMLElement).click()
    })
    assert.ok(
      container.textContent?.includes('door content restored'),
      'Reload surface remounts the children once the failure is gone',
    )
    await act(async () => {
      boundaryRoot.unmount()
    })
    console.log('ok - a door failure is contained: named fallback, Close and Reload both work')

    // ═══ 7. The Extensions door: three catalogues on source tabs ═══════════════
    // Source-tabs ruling (2026-09-05). Installed first, then one tab per source
    // with the app's own catalogue leading, a plus offering the two ways in, the
    // registry's categories as the groups inside the app's tab, one pager at the
    // foot, and the one-source-down degradation (a failed marketplace must never
    // read as an empty one).
    {
      const { default: ExtensionsGlobalSurface } = await import('./extensions/ExtensionsGlobalSurface')
      const { dispatchExtensionsSurfaceTarget, consumePendingExtensionsSurfaceTarget } =
        await import('./extensions/extensionsSurfaceTarget')

      // Latch semantics are load-bearing for every deep-link entry point:
      // the latest dispatch wins, and the latch drains exactly once.
      dispatchExtensionsSurfaceTarget({ view: 'plugins' })
      dispatchExtensionsSurfaceTarget({ view: 'skills', installed: true })
      assert.deepEqual(
        consumePendingExtensionsSurfaceTarget(),
        { view: 'skills', installed: true },
        'latest dispatch wins',
      )
      assert.equal(consumePendingExtensionsSurfaceTarget(), null, 'the latch drains once')

      api.readMarketplaceRegistry = async () => ({
        ok: true,
        registryUrl: null,
        marketplace: {
          plugins: [
            {
              id: 'stripe-mcp',
              name: 'Stripe',
              publisher: { name: 'Stripe', verified: true },
              summary: 'Payments, billing, customers',
              category: 'Payments',
              icon: 'stripe.svg',
              latest: 1,
              provides: ['mcp', 'skills'],
            },
            {
              id: 'roadmap-module',
              name: 'Roadmap',
              publisher: { name: 'SprintEngine', verified: true },
              summary: 'Plan quarterly arcs.',
              category: 'Planning',
              icon: 'roadmap.svg',
              latest: 1,
              provides: ['module'],
            },
            {
              id: 'cursor-cli',
              name: 'Cursor',
              publisher: { name: 'Cursor', verified: true },
              summary: 'Drive the Cursor agent.',
              category: 'Development',
              icon: 'cursor.svg',
              latest: 1,
              provides: ['cli'],
            },
          ],
        },
      })
      // Two sources: the app's own catalogue (always present, non-removable) and
      // one repository. A tab each, the app's leading.
      //
      // That catalogue used to be a `builtin`-kind source whose id was literally
      // `builtin` and whose record called itself "SprintEngine"; `catalogueTabLabel`
      // recognised that id and drew the product's name over it. The
      // studio-marketplace ruling (2026-09-06, commit 34f5f67ac) replaced it with
      // the repository we publish — a `github` source at
      // `sprintengine/studio-releases`, read by the same scanner as any other —
      // and this fixture kept the retired record. The label rule now keys on
      // STUDIO_SKILL_SOURCE_ID, so an id of `builtin` fell through to the
      // record's own name and the tab read "SprintEngine": the assertion below was
      // right and the fixture beneath it was two days stale. The constants are
      // imported rather than typed out so the next rename moves this fixture with
      // the product instead of leaving it behind again.
      const { STUDIO_SKILL_SOURCE_ID, STUDIO_SKILL_SOURCE_NAME, STUDIO_SKILL_SOURCE_REPO } =
        await import('../../../../../shared/skills')
      const acmeSource = {
        id: 'github:acme/skills',
        kind: 'github' as const,
        name: 'skills',
        repo: 'acme/skills',
        monogram: 'AS',
        blurb: '1 skill from acme/skills.',
        commitSha: 'abc1234',
        scannedAt: '2026-07-28T10:00:00.000Z',
      }
      const studioSource = {
        id: STUDIO_SKILL_SOURCE_ID,
        kind: 'github' as const,
        name: STUDIO_SKILL_SOURCE_NAME,
        repo: STUDIO_SKILL_SOURCE_REPO,
        monogram: 'SS',
        blurb: 'The plugin and the skills SprintEngine Studio ships.',
        commitSha: '',
        scannedAt: '',
      }
      api.skillsListSources = async () => ({
        ok: true,
        sources: [studioSource, acmeSource],
        transport: 'api' as const,
        gitInstalled: true,
      })
      const acmeScan = {
        skills: [
          {
            id: 'release-runbook',
            name: 'Release runbook',
            description: 'Cut, verify, and publish a release.',
            group: '',
            files: [{ path: 'SKILL.md', size: 120, blobSha: 'def5678', isEntry: true }],
            allowedTools: [],
            hasExecutables: false,
          },
        ],
        groups: [],
        groupingSignal: 'none' as const,
        fileCount: 1,
        commitSha: 'abc1234',
      }
      api.skillsGetScan = async ({ sourceId }: { sourceId: string }) =>
        sourceId === STUDIO_SKILL_SOURCE_ID
          ? {
              ok: true as const,
              source: studioSource,
              scan: { skills: [], groups: [], groupingSignal: 'none' as const, fileCount: 0, commitSha: '' },
            }
          : { ok: true as const, source: acmeSource, scan: acmeScan }
      api.workspaceSkillsList = async () => ({ ok: true, skills: [] })
      // The Installed canvas's inventory sources. Modules resolves the real
      // list shape; the proxy's not-stubbed {ok:false} answers exercise the
      // remaining sources' error notices.
      api.listThirdPartyModules = async () => ({ modules: [], rejected: [] })
      api.builtinSkillsList = async () => []

      const extRoot = createRoot(container)
      await act(async () => {
        extRoot.render(React.createElement(ExtensionsGlobalSurface))
      })
      await settle()

      // ── The tab row: Installed first, then the sources, then the plus ────────
      const tabLabels = (): string[] =>
        Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim() ?? '')
      assert.deepEqual(
        tabLabels().map((label) => label.replace(/\d+$/, '')),
        ['Installed', 'SprintEngine Studio', 'acme/skills'],
        'Installed leads, the app’s own catalogue is the first source, and it is named for the product',
      )
      const plus = container.querySelector('button[aria-label="Add source"]')
      assert.ok(plus, 'the plus sits beside the search field')

      // ── Inside the app’s tab: the registry’s categories as the groups ────────
      const bodyText = () => container.textContent ?? ''
      assert.ok(bodyText().includes('Plugins'), 'the registry’s plugin list is a group of its own')
      // The registry is the tab's only population since the third-party
      // retirement: the bundled MCP catalogue's rows browsed here too
      // until it was deleted.
      assert.ok(bodyText().includes('Stripe'), 'a registry plugin renders as a row')
      assert.ok(bodyText().includes('Payments'), 'and plugins keep the registry’s categories as headings')
      assert.ok(
        container.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]'),
        'the sources are a line of pills, one of them open (owner ruling 2026-11-03)',
      )
      assert.ok(!bodyText().includes('Featured'), 'the Featured facet is gone')
      assert.ok(!bodyText().includes('more'), 'and so is "Show N more"')

      // ── Honest counts: a source with none of this kind still gets a tab ──────
      const acmeTab = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) =>
        (tab.textContent ?? '').startsWith('acme/skills'),
      )
      assert.ok(acmeTab, 'a source that holds no plugins is still a tab — hiding is how a person loses a source')
      await act(async () => {
        ;(acmeTab as HTMLElement).click()
      })
      await settle()
      assert.ok(
        bodyText().includes('No plugins here') || bodyText().includes('Nothing'),
        'and it says what it holds rather than rendering as an empty page',
      )

      // ── The plus menu: two sources, and an extension from its repository ────
      await act(async () => {
        ;(plus as HTMLElement).click()
      })
      const menuItems = Array.from(document.querySelectorAll('[role="menu"] button')).map(
        (item) => item.textContent?.trim() ?? '',
      )
      assert.deepEqual(
        menuItems,
        ['Add from folder…', 'Add skill source from GitHub…', 'Install extension from GitHub…'],
        'the plus offers a folder, a repository of skills, and an extension installed from its own repository',
      )
      await act(async () => {
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })

      // ── A live deep-link lands on a VIEW, and on its Installed tab ──────────
      // "Manage skills" means the skills this workspace holds, which is a tab of
      // the Skills catalogue rather than a fourth destination.
      await act(async () => {
        dispatchExtensionsSurfaceTarget({ view: 'skills', installed: true })
      })
      await settle()
      assert.ok(
        container.querySelector('section[aria-label="Skills"]'),
        'a live deep-link moves the door to the view it names',
      )
      const selectedTab = container.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ''
      assert.ok(selectedTab.startsWith('Installed'), 'and lands on the Installed tab it asked for')

      await act(async () => {
        extRoot.unmount()
      })

      // The registry down: the app's tab discloses the failure rather than
      // reading as an empty catalogue, and the repository sources — which are
      // read by a different path — still list. Until the third-party retirement
      // the bundled MCP catalogue was the second population that stayed
      // up here; the registry is the only one now, so what this proves is that a
      // failed read is stated rather than drawn as a zero.
      api.readMarketplaceRegistry = async () => ({ ok: false, message: 'registry down.' })
      const degradedRoot = createRoot(container)
      await act(async () => {
        degradedRoot.render(React.createElement(ExtensionsGlobalSurface))
      })
      await settle()
      const degradedText = container.textContent ?? ''
      assert.ok(
        degradedText.includes('The marketplace is unavailable.'),
        'the failure is stated where the rows would be',
      )
      assert.ok(!/SprintEngine Studio\s*0/.test(degradedText), 'a half-down catalogue never renders as a zero count')
      await act(async () => {
        degradedRoot.unmount()
      })

      console.log('ok - the Extensions door: source tabs, the plus, groups and a pager, deep-links, degradation')
    }

    // ═══ 9. The absent door and the workspace-less door ═════════════
    // Two halves of the published global-surface contract. First: a persisted
    // `activeGlobalSurface` naming a surface that never registered resolves to
    // the explicit not-installed door — named, one sentence, one CTA into
    // Plugins — and the persisted id survives the visit untouched, so
    // reinstalling the module lands the user back where they were. Second: a
    // module that registers ONLY a nav entry + a global surface (no workspace
    // type, no panel) gets a door that mounts, renders, and still resolves
    // after a simulated reload — nothing in the mount path may assume a door
    // has an owning workspace.
    {
      const { resolveActiveDoorSurface } = await import('./absentDoorSurface')
      const host = getRendererHost()
      const getSurface = (id: string): ReturnType<typeof host.getGlobalSurface> => host.getGlobalSurface(id)

      // — The absent door —
      useWorkspaceStore.setState({ activeGlobalSurface: 'atlas' } as never)
      const extensionsOpens: ExtensionsSurfaceTarget[] = []
      const absent = resolveActiveDoorSurface(
        useWorkspaceStore.getState().activeGlobalSurface as string,
        getSurface,
        () => true,
        (view) => extensionsOpens.push(view),
      )
      const absentHost = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(absentHost)
      const absentRoot = createRoot(absentHost)
      await act(async () => {
        absentRoot.render(React.createElement(absent.Component))
      })
      assert.match(absentHost.textContent ?? '', /Atlas/, 'the door is named')
      assert.match(
        absentHost.textContent ?? '',
        /The Atlas module isn’t installed\./,
        'and says its module is not installed',
      )
      const cta = [...absentHost.querySelectorAll('button')].find(
        (button) => button.textContent === 'Find it in Plugins',
      )
      assert.ok(cta, 'one CTA into Plugins')
      await act(async () => {
        cta.click()
      })
      assert.deepEqual(
        extensionsOpens,
        [{ view: 'plugins', installed: false }],
        'an uninstalled module deep-links to the Plugins catalogue, not to what is already installed',
      )
      assert.equal(
        useWorkspaceStore.getState().activeGlobalSurface,
        'atlas',
        'rendering the absent door never clears the persisted id',
      )
      await act(async () => {
        absentRoot.unmount()
      })
      absentHost.remove()

      // — The workspace-less door —
      host.hostFor('tide-tables').registerGlobalSurface({
        id: 'tide-tables',
        Component: () => React.createElement('div', null, 'Tide tables'),
      })
      useWorkspaceStore.setState({ activeGlobalSurface: 'tide-tables' } as never)
      for (const visit of ['first open', 'after reload']) {
        const resolved = resolveActiveDoorSurface(
          useWorkspaceStore.getState().activeGlobalSurface as string,
          getSurface,
          () => true,
          () => {},
        )
        assert.equal(resolved.moduleId, 'tide-tables', `the door resolves to its module (${visit})`)
        const doorHost = dom.window.document.createElement('div')
        dom.window.document.body.appendChild(doorHost)
        const doorRoot = createRoot(doorHost)
        await act(async () => {
          doorRoot.render(React.createElement(resolved.Component))
        })
        assert.match(doorHost.textContent ?? '', /Tide tables/, `the workspace-less door renders (${visit})`)
        await act(async () => {
          doorRoot.unmount()
        })
        doorHost.remove()
      }

      // — Disabled, not uninstalled — the copy stays honest and the CTA lands
      // on Installed, where the module's toggle lives.
      const disabledOpens: ExtensionsSurfaceTarget[] = []
      const disabled = resolveActiveDoorSurface(
        'tide-tables',
        getSurface,
        () => false,
        (view) => disabledOpens.push(view),
      )
      const disabledHost = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(disabledHost)
      const disabledRoot = createRoot(disabledHost)
      await act(async () => {
        disabledRoot.render(React.createElement(disabled.Component))
      })
      assert.match(disabledHost.textContent ?? '', /The Tide-tables module is turned off\./)
      const disabledCta = [...disabledHost.querySelectorAll('button')].find(
        (button) => button.textContent === 'Find it in Plugins',
      )
      assert.ok(disabledCta)
      await act(async () => {
        disabledCta.click()
      })
      assert.deepEqual(
        disabledOpens,
        [{ view: 'plugins', installed: true }],
        'a disabled module deep-links to the Plugins view’s Installed tab, where what this machine has is listed',
      )
      await act(async () => {
        disabledRoot.unmount()
      })
      disabledHost.remove()

      console.log('ok - the absent door says so and keeps the id; a workspace-less door mounts and survives reload')
    }

    // Drop the shared scans (and their watchers) so this process can exit.
    resetScans()
    console.log('all global-door integration checks passed')
  }

  const suiteRun = main().catch((error) => {
    console.error('not ok - global doors integration')
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
