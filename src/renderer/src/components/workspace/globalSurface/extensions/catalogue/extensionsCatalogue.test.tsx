// The catalogues, rendered: Plugins and Skills are the SAME
// page (source-tabs ruling, 2026-09-05), so what this asserts is the sameness —
// each view's title on the chrome row, Installed first in the tab row, one tab
// per source after it, the plus with its two items, and one pager at the foot.
//
// Against a real DOM rather than static markup: these read the workspace store
// and open a menu, and both are behaviour a markup snapshot cannot see.

import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// React and react-dom are imported INSIDE main, after the globals above are
// set: a static import is hoisted above them, and react-dom decides at load
// whether the `input` event exists (`canUseDOM`). Loaded first, it takes its
// no-DOM polyfill path and never hears the search box (CliModelPicker.test.tsx
// keeps the same order for the same reason).
import type ReactModule from 'react'
import type { Root } from 'react-dom/client'

import {
  STUDIO_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_NAME,
  type ScanResult,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { test } from 'vitest'

test('extensionsCatalogue', async () => {
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
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.Event = dom.window.Event
  anyGlobal.InputEvent = dom.window.InputEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia

  let React: typeof ReactModule
  let act: typeof ReactModule.act

  // ── The main process this surface reads through ─────────────────────────────
  // Only what the three catalogues actually call. Anything unstubbed answers
  // `{ ok: false }`, which is the shape every read here degrades through, so a
  // missing stub shows up as an honest error state rather than a crash.

  const APP_SOURCE: SkillSource = {
    id: STUDIO_SKILL_SOURCE_ID,
    kind: 'github',
    name: STUDIO_SKILL_SOURCE_NAME,
    repo: 'sprintengine/studio-releases',
    monogram: 'SS',
    blurb: 'The plugin and the skills SprintEngine Studio ships.',
    // Already read once, so the surface lists it from the store rather than
    // waiting for a tab — which is the state a machine that has opened the door
    // before is in.
    commitSha: 'seed0001',
    scannedAt: '2026-09-06T09:00:00.000Z',
  }
  const ACME_SOURCE: SkillSource = {
    id: 'github:acme/skills',
    kind: 'github',
    name: 'skills',
    repo: 'acme/skills',
    monogram: 'AS',
    blurb: 'Skills from acme.',
    commitSha: '',
    // Never scanned: reading it is a tree call plus a file read per plugin, so
    // it must wait for the tab that shows it (the lazy-scan rule below).
    scannedAt: '',
  }

  /**
   * A marketplace whose plugins live in OTHER repositories, most of them unread.
   * Its head line is the one that has to admit a partial scan and offer the token
   * that fixes it (linked-plugins ruling, 2026-09-06).
   */
  const HUB_SOURCE: SkillSource = {
    id: 'github:acme/hub',
    kind: 'github',
    name: 'hub',
    repo: 'acme/hub',
    monogram: 'AH',
    blurb: 'A marketplace from acme.',
    commitSha: 'def5678',
    scannedAt: '',
  }

  /** Every source `skillsGetScan` was asked for, in order. */
  const scanCalls: string[] = []

  /** Every plugin the surface asked main to go and read. */
  const linkedReads: string[] = []

  /** 30 skills in three folders, so the source needs three pages of twelve. */
  const ACME_SCAN: ScanResult = {
    skills: Array.from({ length: 30 }, (_, index) => ({
      id: `skills/${['engineering', 'writing', 'ops'][index % 3]}/skill-${index}`,
      name: `skill-${index}`,
      description: `does thing ${index}`,
      group: ['engineering', 'writing', 'ops'][index % 3],
      files: [{ path: 'SKILL.md', size: 100, blobSha: '', isEntry: true }],
      allowedTools: [],
      hasExecutables: false,
    })),
    groups: ['engineering', 'writing', 'ops'],
    groupingSignal: 'folders',
    fileCount: 30,
    commitSha: 'abc1234',
  }

  /** Three linked plugins: one read, one waiting on budget, one that cannot be read. */
  /**
   * What a scan of our own marketplace holds: the plugin the app installs itself,
   * and the workflow skills beside it (studio-marketplace ruling, 2026-09-06).
   * The first of the two must NOT be drawn as an installable row — it is the
   * built-in row, and what we publish is a template whose `.mcp.json` carries
   * tokens only the app can fill in.
   */
  const STUDIO_SCAN: ScanResult = {
    skills: [],
    groups: [],
    groupingSignal: 'none',
    fileCount: 0,
    commitSha: 'seed0001',
    shape: 'claude-marketplace',
    marketplaceName: 'sprintengine-studio',
    pluginRenames: {},
    mcpServers: [
      {
        id: 'sprintengine-studio',
        name: 'sprintengine-studio',
        description: '',
        transport: 'stdio',
        command: '__SPRINTENGINE_NODE__',
        args: [],
        url: '',
        env: {},
        envVarNames: [],
        headers: {},
        declaredIn: 'sprintengine-studio/.mcp.json',
        declaredBy: 'sprintengine-studio',
      },
    ],
    plugins: [
      {
        id: 'sprintengine-studio',
        name: 'SprintEngine Studio',
        description: 'Drive SprintEngine Studio from an agent.',
        version: '1.0.0',
        category: '',
        author: 'SprintEngine Studio',
        homepage: '',
        strict: true,
        tags: [],
        keywords: [],
        origin: { kind: 'in-tree', path: 'sprintengine-studio' },
        componentsKnown: true,
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          missingSkills: [],
        },
      },
      {
        id: 'studio-skills',
        name: 'Studio skills',
        description: 'The workflow skills the studio ships.',
        version: '1.0.0',
        category: '',
        author: 'SprintEngine Studio',
        homepage: '',
        strict: true,
        tags: [],
        keywords: [],
        origin: { kind: 'in-tree', path: 'studio-skills' },
        componentsKnown: true,
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          missingSkills: [],
        },
      },
    ],
  }

  const HUB_SCAN: ScanResult = {
    skills: [],
    groups: [],
    groupingSignal: 'none',
    fileCount: 0,
    commitSha: 'def5678',
    shape: 'claude-marketplace',
    marketplaceName: 'acme-hub',
    mcpServers: [],
    pluginRenames: {},
    plugins: [
      {
        id: 'read-one',
        name: 'Read one',
        description: 'Its repository was read.',
        version: '1.0.0',
        category: '',
        author: 'acme',
        homepage: '',
        strict: true,
        tags: [],
        keywords: [],
        origin: {
          kind: 'linked',
          repo: 'acme/one',
          ref: '',
          sha: 'a'.repeat(40),
          path: '',
          url: 'https://github.com/acme/one',
        },
        componentsKnown: true,
        readState: { status: 'read' },
        readCommit: 'a'.repeat(40),
        components: {
          skills: [],
          commands: ['go'],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          missingSkills: [],
        },
      },
      {
        id: 'waiting',
        name: 'Waiting',
        description: 'The budget ran out before it.',
        version: '',
        category: '',
        author: 'acme',
        homepage: '',
        strict: true,
        tags: [],
        keywords: [],
        origin: {
          kind: 'linked',
          repo: 'acme/two',
          ref: '',
          sha: 'b'.repeat(40),
          path: '',
          url: 'https://github.com/acme/two',
        },
        componentsKnown: false,
        readState: { status: 'pending', reason: 'budget' },
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          missingSkills: [],
        },
      },
      {
        id: 'listed-only',
        name: 'Listed only',
        description: 'Its components came from the tree; its skills have no descriptions yet.',
        version: '2.0.0',
        category: '',
        author: 'acme',
        homepage: '',
        strict: true,
        tags: [],
        keywords: [],
        origin: {
          kind: 'linked',
          repo: 'acme/four',
          ref: '',
          sha: 'd'.repeat(40),
          path: '',
          url: 'https://github.com/acme/four',
        },
        componentsKnown: true,
        readState: { status: 'listed' },
        readCommit: 'd'.repeat(40),
        components: {
          skills: [
            {
              id: 'skills/one',
              name: 'one',
              description: '',
              group: '',
              files: [],
              allowedTools: [],
              hasExecutables: false,
            },
          ],
          commands: [],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          missingSkills: [],
        },
      },
      {
        id: 'elsewhere',
        name: 'Elsewhere',
        description: 'Hosted somewhere this app does not read.',
        version: '',
        category: '',
        author: 'acme',
        homepage: '',
        strict: true,
        tags: [],
        keywords: [],
        origin: { kind: 'linked', repo: '', ref: '', sha: '', path: '', url: 'https://gitlab.com/acme/three' },
        componentsKnown: false,
        readState: { status: 'unreadable', message: "Hosted on gitlab.com, which is not on this app's allowlist." },
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          missingSkills: [],
        },
      },
    ],
  }

  const api: Record<string, unknown> = {
    platform: 'darwin',
    readMarketplaceRegistry: async () => ({
      ok: true,
      registryUrl: null,
      marketplace: {
        plugins: [
          {
            id: 'stripe-plugin',
            name: 'Stripe',
            publisher: { name: 'Stripe', verified: true },
            summary: 'Payments, billing, customers',
            category: 'Payments',
            icon: 'stripe.svg',
            latest: 1,
            provides: ['mcp', 'skills'],
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
            cli: { pluginId: 'cursor' },
          },
          // Two bundled plugins called "Claude Code": the terminal CLI, and the
          // Claude Agent SDK conversation provider. The seed lists both as
          // inline CLI entries; only the first is an agent CLI.
          {
            id: 'claude-code',
            name: 'Claude Code',
            publisher: { name: 'Anthropic', verified: true },
            summary: "Anthropic's Claude Code coding agent, driven in a terminal.",
            category: 'Development',
            icon: 'claude-code.svg',
            latest: 1,
            provides: ['cli'],
            cli: { pluginId: 'claude-code' },
          },
          {
            id: 'claude-agent',
            name: 'Claude Code',
            publisher: { name: 'Anthropic', verified: true },
            summary: 'Claude conversation agents in the app, run through the Claude Agent SDK.',
            category: 'Agent Runtime',
            icon: 'claude-agent.svg',
            latest: 1,
            provides: ['cli'],
            cli: { pluginId: 'claude-agent' },
          },
        ],
      },
    }),
    // The API fallback, which is what makes the head line's shortfall clause the
    // one that names a token at all (git-transport ruling, owner 2026-09-08).
    skillsListSources: async () => ({
      ok: true,
      sources: [APP_SOURCE, ACME_SOURCE, HUB_SOURCE],
      transport: 'api' as const,
      gitInstalled: true,
    }),
    // No token on this machine, which is what makes the head line's shortfall
    // clause the one that offers to add one.
    getGitHubTokenStatus: async () => ({ configured: false, source: 'none', encryptionAvailable: true }),
    skillsScanLinkedPlugin: async ({ pluginId }: { pluginId: string }) => (
      linkedReads.push(pluginId),
      { ok: false, message: 'not reachable in this test' }
    ),
    skillsGetScan: async ({ sourceId }: { sourceId: string }) => (
      scanCalls.push(sourceId),
      sourceId === STUDIO_SKILL_SOURCE_ID
        ? { ok: true, source: APP_SOURCE, scan: STUDIO_SCAN }
        : sourceId === HUB_SOURCE.id
          ? { ok: true, source: HUB_SOURCE, scan: HUB_SCAN }
          : { ok: true, source: ACME_SOURCE, scan: ACME_SCAN }
    ),
    // The plugin the app installs into every workspace it opens, as the built-in
    // row reads it (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).
    studioPluginStatus: async () => ({
      ok: true,
      bundledVersion: '1.0.0',
      installedVersion: '1.0.0',
      skillDirNames: ['studio-backlog', 'studio-scheduled-agents', 'studio-workspaces'],
    }),
    workspaceSkillsList: async () => ({ ok: true, skills: [] }),
    skillsListInstalledPlugins: async () => ({ ok: true, plugins: [] }),
    listThirdPartyModules: async () => ({ modules: [], rejected: [] }),
    // The CLI runtime catalogue: kind `cli` manifests only, so the SDK provider
    // that shares Claude Code's name is not in it.
    pluginsList: async () => ({
      ok: true,
      plugins: [
        { id: 'cursor', displayName: 'Cursor', source: 'bundled', version: 1, binary: 'cursor-agent' },
        { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
      ],
    }),
    // A check that could not run: never silence that reads as "up to date".
    readMarketplacePluginUpdateStates: async () => ({ ok: false, message: 'not checked here' }),
    // A subscription, not a read: the proxy's async default would hand React a
    // Promise where an unsubscribe belongs.
    onSkillSourcesUpdated: () => () => {},
    openDir: async () => null,
    openExternal: async () => undefined,
  }
  domWindow.api = new Proxy(api, {
    get: (target, property: string) =>
      property in target ? target[property] : async () => ({ ok: false, message: 'not stubbed' }),
  })

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  let root: Root

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  const text = (): string => container.textContent ?? ''
  const searchInput = (): HTMLInputElement => container.querySelector('input[type="search"]') as HTMLInputElement
  /** Type into the search box the way a person does: a value, and an input event React hears. */
  const typeSearch = async (value: string): Promise<void> => {
    const input = searchInput()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await settle()
  }
  const dialog = (): Element | null => dom.window.document.querySelector('[role="dialog"]')
  const closeDialog = async (): Promise<void> => {
    await act(async () => {
      ;(dom.window.document.querySelector('[role="dialog"] button[aria-label="Close"]') as HTMLElement | null)?.click()
    })
    await settle()
  }
  const tabs = (): HTMLElement[] => [...container.querySelectorAll('[role="tab"]')] as HTMLElement[]
  const tabNames = (): string[] => tabs().map((tab) => (tab.textContent ?? '').replace(/\d+$/, '').trim())
  const tabNamed = (name: string): HTMLElement | undefined =>
    tabs().find((tab) => (tab.textContent ?? '').startsWith(name))
  const title = (): string => container.querySelector('h2')?.textContent ?? ''

  async function run(name: string, body: () => void | Promise<void>): Promise<void> {
    try {
      await body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  async function main(): Promise<void> {
    React = (await import('react')).default
    act = (await import('react')).act
    const { createRoot } = await import('react-dom/client')
    root = createRoot(container as unknown as Element)
    const { useWorkspaceStore } = await import('../../../../../store/workspaceStore')
    const { default: ExtensionsGlobalSurface } = await import('../ExtensionsGlobalSurface')
    const { dispatchExtensionsSurfaceTarget, consumePendingExtensionsSurfaceTarget } =
      await import('../extensionsSurfaceTarget')

    const openView = async (view: 'plugins' | 'skills'): Promise<void> => {
      consumePendingExtensionsSurfaceTarget()
      await act(async () => {
        dispatchExtensionsSurfaceTarget({ view })
      })
      await settle()
    }

    await act(async () => {
      root.render(React.createElement(ExtensionsGlobalSurface))
    })
    await settle()

    // ── The three views are one page ────────────────────────────────────────────

    await run('Plugins names itself on the chrome row and its search reads every source', () => {
      assert.equal(title(), 'Plugins')
      const search = container.querySelector('input[type="search"]')
      assert.ok(search, 'the search field is in the bar, beside the name')
      assert.equal(
        search?.getAttribute('aria-label'),
        'Search plugins across all sources',
        'and it says the search is not scoped to the tab',
      )
    })

    await run('Installed leads the tab row, then one tab per source, the app’s catalogue first', () => {
      assert.deepEqual(tabNames(), ['Installed', 'SprintEngine Studio', 'acme/skills', 'acme/hub'])
      assert.equal(
        container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith('SprintEngine Studio'),
        true,
        'a cold open lands on a source, not on what is already installed',
      )
    })

    await run('the plus sits beside the search field and opens a menu', async () => {
      const plus = container.querySelector('button[aria-label="Add source"]') as HTMLElement | null
      assert.ok(plus, 'the plus is named for what it does')
      assert.equal(plus?.getAttribute('aria-haspopup'), 'menu')
      assert.equal(
        plus?.closest('button:not([aria-label="Add source"])'),
        null,
        'and is one button, not one in another',
      )
      let band: HTMLElement | null = plus
      while (band && !band.querySelector('input')) band = band.parentElement
      assert.ok(
        band?.querySelector('input')?.getAttribute('aria-label')?.startsWith('Search'),
        'it shares the search field’s row, where the looking is done (owner ruling 2026-11-03)',
      )
    })

    // The bundled MCP catalogue was a second population in this tab until the
    // third-party retirement (2026-09-08). Its rows are gone; what is
    // left is the registry's plugins, still grouped by the registry's own
    // categories and still walked by one pager.
    await run('the app’s tab keeps the registry’s categories as its groups, a gallery of them', () => {
      assert.ok(text().includes('Stripe'), 'a registry plugin is a row')
      assert.ok(text().includes('Payments'), 'and plugins keep the registry’s own categories as headings')
      assert.equal(
        /Showing \d+–\d+ of \d+/.test(text()),
        false,
        'several groups are a gallery, each shown whole while it fits, with no pager over the tab',
      )
      assert.equal(text().includes('Payments, billing, customers'), false, 'and a row carries no summary on its face')
      assert.equal(text().includes('Featured'), false, 'the Featured facet is gone')
      assert.equal(/Show \d+ more/.test(text()), false, 'and so is "Show N more"')
    })

    await run('the app’s tab reads our marketplace too, our plugin once and only as the built-in row', () => {
      // The studio-marketplace ruling (2026-09-06): this tab used to be the
      // signed registry alone under Plugins and a folder scan under Skills. It
      // now reads the repository we publish as well — so `studio-skills` is a
      // row here — while our own plugin stays the built-in row it already was.
      const body = text()
      assert.ok(body.includes('Built in'), 'the built-in row leads the tab')
      assert.ok(body.includes('Studio skills'), 'the marketplace’s other plugin is an ordinary row')
      // Once, not twice: a second row for it would carry an Open/Install, and
      // what we publish is a template whose `.mcp.json` still holds
      // `__SPRINTENGINE_*`. The built-in row has no such control at all, so its
      // absence is exactly what says the marketplace's copy is not drawn.
      assert.ok(
        container.querySelector('[aria-label="Details for Studio skills"]'),
        'the other plugin does open, which is how Install and Remove are reached',
      )
      assert.equal(
        container.querySelector('[aria-label="Details for SprintEngine Studio"]'),
        null,
        'our plugin is not listed a second time under Plugins',
      )
      assert.equal(
        body.includes('__SPRINTENGINE_NODE__'),
        false,
        'and the server it declares is never offered as one to add',
      )
      // The head line names what is actually drawn. Our plugin counts — it IS
      // the built-in row — and the server inside it does not, because it has no
      // row of its own; a head claiming "1 MCP server" over a tab with none was
      // the count and the rows disagreeing.
      assert.ok(body.includes('sprintengine/studio-releases'), 'the head names where the tab is read from')
      assert.equal(body.includes('1 MCP server'), false, 'the plugin’s own server is not a second row')
      assert.equal(body.includes('signed entrys'), false, 'nothing is ever called a "signed entrys"')
      assert.equal(body.includes('signed entrys'), false)
    })

    await run('a repository nobody has scanned is not read until its tab is opened', () => {
      // Opening the Extensions door used to fire a full scan of every source in
      // the list — for the official marketplace that is a tree call and hundreds
      // of file reads against an anonymous GitHub budget, spent for someone who
      // came to look at Skills. The sources the app can answer from disk are
      // still read on mount.
      assert.ok(scanCalls.includes(STUDIO_SKILL_SOURCE_ID), 'a source already scanned is answered from the store, now')
      assert.equal(scanCalls.includes(ACME_SOURCE.id), false, 'an unscanned repository waits for the tab that shows it')
    })

    // ── A query reads every source, and reads none it does not already hold ────

    await run('a query searches every source the door holds a scan for, grouped by source', async () => {
      assert.equal(searchInput().placeholder, 'Search all sources', 'the box says what it reads')
      await typeSearch('studio')
      const body = text()
      assert.ok(body.includes('All sources'), 'the head says the scope changed')
      assert.ok(body.includes('Searched 1 of 3 sources for “studio”'), 'and how much of the door the answer covers')
      assert.ok(body.includes('Studio skills'), 'a hit from the one scanned source is listed')
      assert.ok(
        body.includes('2 sources not yet read: acme/skills, acme/hub.'),
        'the sources it did not cover are named, not silently left out',
      )
      assert.equal(
        scanCalls.includes(ACME_SOURCE.id) || scanCalls.includes(HUB_SOURCE.id),
        false,
        'and a keystroke never spends a network read on a source nobody has opened',
      )
      assert.ok(
        container.querySelector('nav[aria-label="Plugins across all sources"]'),
        'the pager pages the door, not the tab',
      )
    })

    await run('clearing the box from its own cross returns the tab', async () => {
      await act(async () => {
        ;(container.querySelector('button[aria-label="Clear search"]') as HTMLElement).click()
      })
      await settle()
      assert.equal(searchInput().value, '')
      assert.equal(text().includes('All sources'), false)
      assert.ok(text().includes('sprintengine/studio-releases'), 'the tab’s own head is back')
    })

    // ── A source's head line on Plugins names both populations ──────────────────

    await act(async () => {
      tabNamed('acme/skills')?.click()
    })
    await settle()

    await run('and it is read as soon as that tab is the one being looked at', () => {
      assert.equal(scanCalls.filter((id) => id === ACME_SOURCE.id).length, 1, 'once, not once per render')
    })

    await run('the Plugins head names the source and where it comes from, and nothing else', () => {
      // The head used to carry the shape, the counts, a link to the skills and
      // any caveat the scan had, in one four-line sentence nobody could find
      // the name in (extensions review, 2026-09-08). The tab and the section
      // heading carry the counts; the head carries the repository.
      assert.equal(text().includes('listings'), false, 'nothing is called a listing any more')
      assert.ok(text().includes('acme/skills'), 'the repository is the line under the name')
      assert.equal(text().includes('30 skills'), false, 'what it holds is not restated in the head')
    })

    await openView('plugins')

    await act(async () => {
      tabNamed('acme/hub')?.click()
    })
    await settle()

    // ── A partial scan says so, and the fix is one click ─────────────────────────

    await run('a marketplace whose linked plugins are not all read says how many are not', () => {
      assert.equal(
        container.querySelectorAll('[aria-label^="Show details for "]').length,
        4,
        'every linked plugin is listed, read or not',
      )
      assert.ok(
        text().includes('1 of 4 linked plugins not yet read'),
        'and a notice states the shortfall rather than the tab reading as a complete listing',
      )
      assert.ok(
        text().includes('1 of 4 linked plugin could not be read in full'),
        'a plugin nothing can read is counted apart from one a later scan will read',
      )
    })

    await run('and the words that name the fix are the button that opens it', async () => {
      const fix = [...container.querySelectorAll('button')].find((button) =>
        (button.textContent ?? '').toLowerCase().includes('add a github token'),
      ) as HTMLElement | undefined
      assert.ok(fix, 'Settings is one click away, not a sentence telling somebody to go and find it')
      await act(async () => {
        fix.click()
      })
      await settle()
      const state = useWorkspaceStore.getState()
      assert.equal(state.activeModalSurface, 'settings')
      assert.equal(state.settingsOverlay.initialTab, 'github')
      await act(async () => {
        useWorkspaceStore.getState().closeSettingsOverlay()
      })
      await settle()
    })

    await run('an unread linked plugin is marked as such on its own row', () => {
      // Not in the summary line: a row shows the description when there is one,
      // and every linked entry the official marketplace lists has one, so the
      // state has to be a chip or it is invisible.
      assert.ok(text().includes('Could not be read'), 'the plugin nothing can read wears it')
      assert.ok(text().includes('Not read yet'), 'and so does the one a later scan will read')
      assert.equal(
        text().includes('Read when opened'),
        false,
        'which is what all three said before the scan followed any of them',
      )
    })

    await run('a token status that cannot be read fails CLOSED, keeping the remedy on screen', async () => {
      // Reading it as "configured" hid the only remedy from the person whose scan
      // really was short of a token, which is the one who needed it
      // (linked-plugins review, 2026-09-06).
      api.getGitHubTokenStatus = async () => {
        throw new Error('preload is older than this call')
      }
      await openView('skills')
      await openView('plugins')
      await act(async () => {
        tabNamed('acme/hub')?.click()
      })
      await settle()
      assert.ok(text().includes('add a GitHub token'), 'the clause and its button survive a status call that threw')
      api.getGitHubTokenStatus = async () => ({ configured: false, source: 'none', encryptionAvailable: true })
    })

    await run('opening a plugin the scan only LISTED reads it again, for the descriptions', async () => {
      // The follow proves a plugin's components from its repository's tree and
      // fetches no skill's entry document, so a listed plugin's skills carry
      // directory names and blank descriptions until it is opened. Keying the
      // re-read on "components unknown" meant it never was (linked-plugins
      // review, 2026-09-06).
      linkedReads.length = 0
      await act(async () => {
        ;(container.querySelector('button[aria-label="Details for Listed only"]') as HTMLElement).click()
      })
      await settle()
      assert.deepEqual(linkedReads, ['listed-only'], 'it went and read the one whose skills have no descriptions')

      linkedReads.length = 0
      await act(async () => {
        ;(container.querySelector('button[aria-label="Details for Read one"]') as HTMLElement).click()
      })
      await settle()
      assert.deepEqual(linkedReads, [], 'and left alone the one that was already read whole')
    })

    await act(async () => {
      tabNamed('acme/skills')?.click()
    })
    await settle()

    await openView('plugins')

    // ── The plus menu ───────────────────────────────────────────────────────────

    await act(async () => {
      ;(container.querySelector('button[aria-label="Add source"]') as HTMLElement).click()
    })
    await settle()

    await run('the plus menu names what each repository is: a skill source, or an extension', () => {
      const items = [...dom.window.document.querySelectorAll('[role="menu"] button')].map(
        (item) => item.textContent?.trim() ?? '',
      )
      assert.deepEqual(items, ['Add from folder…', 'Add skill source from GitHub…', 'Install extension from GitHub…'])
    })

    await run('Escape closes the menu', async () => {
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      assert.equal(dom.window.document.querySelector('[role="menu"]'), null)
    })

    await run('"Install extension from GitHub…" opens the install dialog, not the skill-source one', async () => {
      await act(async () => {
        ;(container.querySelector('button[aria-label="Add source"]') as HTMLElement).click()
      })
      await settle()
      const item = [...dom.window.document.querySelectorAll('[role="menu"] button')].find(
        (candidate) => candidate.textContent?.trim() === 'Install extension from GitHub…',
      ) as HTMLElement | undefined
      await act(async () => {
        item?.click()
      })
      await settle()
      const dialog = dom.window.document.querySelector('[role="dialog"]')
      assert.ok(dialog?.textContent?.includes('Install extension from GitHub'))
      assert.ok(dialog?.querySelector('input[aria-label="Repository URL"]'))
      await act(async () => {
        ;(dialog?.querySelector('button[aria-label="Close"]') as HTMLElement | null)?.click()
      })
      await settle()
    })

    // ── Skills: the repository's folders are the groups ──────────────────────────

    await openView('skills')

    await run('Skills is the same page, and its tab row is the same tab row', () => {
      assert.equal(title(), 'Skills')
      assert.deepEqual(tabNames(), ['Installed', 'SprintEngine Studio', 'acme/skills', 'acme/hub'])
      assert.ok(container.querySelector('button[aria-label="Add source"]'), 'the plus is here too')
    })

    await act(async () => {
      tabNamed('acme/skills')?.click()
    })
    await settle()

    await run('a repository lists under the folders it keeps its skills in, the first few of each', () => {
      assert.ok(text().includes('Engineering'), 'the folder names are the headings, cased for reading')
      assert.equal(
        container.querySelectorAll('ul[aria-label="Engineering"] > li').length,
        6,
        'a folder shows its first six in the gallery',
      )
      assert.ok(
        container.querySelector('button[aria-label="View all 10 in Engineering"]'),
        'and a View all for the rest',
      )
      assert.equal(text().includes('type="checkbox"'), false)
    })

    await run('the head names the source and carries its actions', () => {
      assert.ok(text().includes('acme/skills'), 'the repository is the line under the name')
      assert.ok(container.querySelector('button[aria-label^="More actions for"]'), 'Remove and Open are one overflow')
    })

    await run('View all opens one folder as a page of its own, with the way back beside its name', async () => {
      await act(async () => {
        ;(container.querySelector('button[aria-label="View all 10 in Engineering"]') as HTMLElement).click()
      })
      await settle()
      assert.equal(container.querySelector('h3')?.textContent, 'Engineering', 'the folder is the page’s name')
      assert.equal(container.querySelectorAll('ul[aria-label="Engineering"] > li').length, 10, 'with all of it')
      assert.ok(text().includes('Showing 1–10 of 10'), 'and a pager over that folder alone')
      assert.equal(text().includes('Writing'), false, 'the other folders wait behind it')
      await act(async () => {
        ;(container.querySelector('button[aria-label="Back to acme/skills"]') as HTMLElement).click()
      })
      await settle()
      assert.ok(text().includes('Writing'), 'Back lands on the gallery again')
      assert.ok(container.querySelector('button[aria-label="View all 10 in Engineering"]'))
    })

    await run('the search field is bound to the tab it filters', () => {
      // What the search DOES to a tab — the filter itself, and landing back on
      // page 1 — is the model's, and is asserted there (cataloguePaging.test.ts,
      // skillsSurfaceModel.test.ts). What the DOM owes is the binding: a filter
      // and its results are two separate stops for a screen reader, and without
      // the link the field is a text box that happens to sit above something.
      const search = container.querySelector('input[type="search"]')
      const panel = container.querySelector('[role="tabpanel"]')
      assert.ok(panel?.id)
      assert.equal(search?.getAttribute('aria-controls'), panel?.id)
    })

    // ── Agent CLIs left the door ────────────────────────────────────────────────

    await run('a link that still names the retired Agent CLIs view does not move the door', async () => {
      // Settings ▸ Agents lists the CLIs now (owner ruling 2026-09-25). A stale
      // target is ignored rather than landing on a view that is not there.
      const before = title()
      consumePendingExtensionsSurfaceTarget()
      await act(async () => {
        dispatchExtensionsSurfaceTarget({ view: 'agent-clis' } as unknown as Parameters<
          typeof dispatchExtensionsSurfaceTarget
        >[0])
      })
      await settle()
      consumePendingExtensionsSurfaceTarget()
      assert.equal(title(), before, 'the door stays on the view it was showing')
      assert.equal(text().includes('Agent CLIs'), false, 'and nothing on it offers agent CLIs')
    })

    // ── The Installed tab ───────────────────────────────────────────────────────

    await act(async () => {
      tabNamed('Installed')?.click()
    })
    await settle()

    await run('Installed with no workspace says so rather than reading as nothing installed', () => {
      assert.equal(useWorkspaceStore.getState().activeWorkspaceId, null, 'the door is open with no workspace')
      assert.ok(
        text().includes('Open a workspace') || text().includes('Nothing installed yet'),
        `the Installed tab states its condition (saw: ${text().slice(0, 200)})`,
      )
    })

    // ── With every source read: results by source, and a query that survives ───

    await openView('plugins')

    await run('with every source read, the results come grouped under each source’s name', async () => {
      await typeSearch('read one')
      const body = text()
      assert.ok(body.includes('Searched all 3 sources for “read one”'))
      assert.ok(body.includes('acme/hub'), 'the source the hit came from heads its section')
      assert.ok(body.includes('Read one'))
      assert.equal(body.includes('Waiting'), false, 'a plugin that does not match is not listed under it')
      // The section head wears the source's mark before its name (SourceAvatar).
      const heading = [...container.querySelectorAll('section')].find((section) =>
        (section.textContent ?? '').startsWith('acme/hub'),
      )
      assert.ok(heading?.querySelector('img, span[aria-hidden]'), 'the source’s avatar or monogram leads its heading')
    })

    await run('a plugin row’s button says what it does: Details, not Install', () => {
      // It read "Install" and opened the pane while a skill row's "Install"
      // installs — the same word, two behaviours. The pane stays the one way
      // in (hook acknowledgement, what installs where), and the row says so.
      const button = container.querySelector('button[aria-label="Details for Read one"]')
      assert.equal(button?.textContent, 'Details')
      assert.equal(
        [...container.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Install'),
        false,
        'no plugin row promises an install it does not perform',
      )
    })

    await run('Details on a row under a search opens the pane from the row’s source, not the open tab’s', async () => {
      assert.notEqual(
        tabNamed('acme/hub')?.getAttribute('aria-selected'),
        'true',
        'the open tab is not the hit’s source',
      )
      await act(async () => {
        ;(container.querySelector('button[aria-label="Details for Read one"]') as HTMLElement).click()
      })
      await settle()
      assert.equal(dialog()?.querySelector('#plugin-detail-title')?.textContent, 'Read one', 'acme/hub’s plugin opened')
      assert.notEqual(tabNamed('acme/hub')?.getAttribute('aria-selected'), 'true', 'without moving the tab under it')
      await closeDialog()
      assert.equal(dialog(), null)
    })

    await run('the query survives a tab change', async () => {
      await act(async () => {
        tabNamed('acme/skills')?.click()
      })
      await settle()
      assert.equal(searchInput().value, 'read one', 'the words are still in the box')
      assert.ok(text().includes('Read one'), 'and the results are still the door’s, not the tab’s')
      assert.equal(tabNamed('acme/skills')?.getAttribute('aria-selected'), 'true', 'the tab did change underneath')
    })

    await run('and a switch between Plugins and Skills', async () => {
      await openView('skills')
      assert.equal(title(), 'Skills')
      assert.equal(searchInput().value, 'read one')
      assert.ok(text().includes('Nothing matches “read one”'), 'the Skills view searched every source for it')
      assert.ok(text().includes('Searched all 3 sources'))
    })

    await run('Install on a row under a search installs from the row’s source, not the open tab’s', async () => {
      // A workspace to install into: without one every Install is disabled.
      // The shape the store persists (agents, openFiles), so the persist step
      // that runs on every setState has something to walk.
      useWorkspaceStore.setState({
        workspaces: [
          {
            id: 'w-door',
            name: 'door',
            mode: 'standard',
            folderPath: '/tmp/door',
            agents: {},
            openFiles: [],
            createdAt: 1,
          } as unknown as ReturnType<typeof useWorkspaceStore.getState>['workspaces'][number],
        ],
        activeWorkspaceId: 'w-door',
      })
      const installs: { sourceId: string; skillId: string }[] = []
      api.skillsInstall = async ({ sourceId, skillId }: { sourceId: string; skillId: string }) => (
        installs.push({ sourceId, skillId }),
        { ok: true }
      )
      await settle()
      // Stand on our tab and ask for a skill only acme/skills lists.
      await act(async () => {
        tabNamed('SprintEngine Studio')?.click()
      })
      await settle()
      await typeSearch('skill-29')
      assert.equal(tabNamed('SprintEngine Studio')?.getAttribute('aria-selected'), 'true')
      const button = container.querySelector('button[aria-label="Install skill-29"]') as HTMLElement | null
      assert.ok(button, 'the other source’s row offers Install')
      await act(async () => {
        button?.click()
      })
      await settle()
      assert.deepEqual(
        installs,
        [{ sourceId: ACME_SOURCE.id, skillId: 'skills/ops/skill-29' }],
        'the install names the source the row came from, not the tab that was open',
      )
      assert.ok(text().includes('Installed 1 skill.'), `the outcome is stated (saw: ${text().slice(0, 200)})`)
      delete api.skillsInstall
      useWorkspaceStore.setState({ activeWorkspaceId: null })
      await settle()
    })

    await run('Escape in the box clears it', async () => {
      await act(async () => {
        searchInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await settle()
      assert.equal(searchInput().value, '')
      assert.equal(text().includes('All sources'), false)
    })

    // ── Deep links land on one plugin or one skill ──────────────────────────────

    await run('a link naming a source and a plugin selects the tab and opens the plugin', async () => {
      await typeSearch('leftover')
      await act(async () => {
        dispatchExtensionsSurfaceTarget({ view: 'plugins', sourceId: HUB_SOURCE.id, pluginId: 'read-one' })
      })
      await settle()
      assert.equal(title(), 'Plugins')
      assert.equal(tabNamed('acme/hub')?.getAttribute('aria-selected'), 'true')
      assert.equal(searchInput().value, '', 'a link that names a place clears the search standing in front of it')
      assert.equal(dialog()?.querySelector('#plugin-detail-title')?.textContent, 'Read one')
      await closeDialog()
      assert.equal(dialog(), null)
    })

    await run('a plugin the source no longer lists falls back to the source’s tab with a notice', async () => {
      await act(async () => {
        dispatchExtensionsSurfaceTarget({ view: 'plugins', sourceId: HUB_SOURCE.id, pluginId: 'nope' })
      })
      await settle()
      assert.equal(dialog(), null, 'nothing opens')
      assert.equal(
        tabNamed('acme/hub')?.getAttribute('aria-selected'),
        'true',
        'the tab is the nearest thing that exists',
      )
      assert.ok(
        text().includes('acme/hub no longer lists a plugin called nope'),
        `the notice says why (saw: ${text().slice(0, 300)})`,
      )
      await act(async () => {
        ;[...container.querySelectorAll('button')].find((button) => button.textContent === 'Dismiss')?.click()
      })
      await settle()
      assert.equal(text().includes('no longer lists'), false, 'and it can be dismissed')
    })

    await run('a source no longer in the list falls back to the view with a notice', async () => {
      await act(async () => {
        dispatchExtensionsSurfaceTarget({ view: 'skills', sourceId: 'github:gone/gone', skillId: 'skills/x' })
      })
      await settle()
      assert.equal(title(), 'Skills')
      assert.equal(dialog(), null)
      assert.ok(text().includes('is not in your list any more'))
      assert.ok(
        container.querySelector('[role="tab"][aria-selected="true"]'),
        'the view stands on a tab that exists rather than on nothing',
      )
    })

    await run('a link naming a source and a skill opens the skill’s page', async () => {
      await act(async () => {
        dispatchExtensionsSurfaceTarget({
          view: 'skills',
          sourceId: ACME_SOURCE.id,
          skillId: 'skills/engineering/skill-0',
        })
      })
      await settle()
      assert.equal(tabNamed('acme/skills')?.getAttribute('aria-selected'), 'true')
      assert.equal(dialog()?.querySelector('#skill-detail-title')?.textContent, 'skill-0')
      assert.equal(
        text().includes('is not in your list any more'),
        false,
        'a link that landed retires the notice the missed one before it left',
      )
      await closeDialog()
    })

    await act(async () => {
      root.unmount()
    })

    // ── A link into a source not yet read waits for the read, then opens ────────

    const LATE_SOURCE: SkillSource = {
      id: 'github:late/plugins',
      kind: 'github',
      name: 'plugins',
      repo: 'late/plugins',
      monogram: 'LP',
      blurb: '',
      commitSha: '',
      scannedAt: '',
    }
    const LATE_SCAN: ScanResult = {
      ...HUB_SCAN,
      marketplaceName: 'late',
      plugins: [
        {
          ...HUB_SCAN.plugins![0],
          id: 'late-one',
          name: 'Late one',
          origin: { kind: 'in-tree', path: 'plugins/late-one' },
        },
      ],
    }
    let releaseLateScan: (() => void) | null = null
    api.skillsListSources = async () => ({
      ok: true,
      sources: [APP_SOURCE, LATE_SOURCE],
      transport: 'api' as const,
      gitInstalled: true,
    })
    api.skillsGetScan = async ({ sourceId }: { sourceId: string }) => {
      scanCalls.push(sourceId)
      if (sourceId === LATE_SOURCE.id) {
        await new Promise<void>((resolve) => {
          releaseLateScan = resolve
        })
        return { ok: true, source: LATE_SOURCE, scan: LATE_SCAN }
      }
      return { ok: true, source: APP_SOURCE, scan: STUDIO_SCAN }
    }

    const lateContainer = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(lateContainer)
    const lateRoot = createRoot(lateContainer as unknown as Element)
    const lateText = (): string => lateContainer.textContent ?? ''

    await run('a link dispatched before the door mounts, into a source not yet read, waits for that read', async () => {
      scanCalls.length = 0
      // Dispatched before the surface exists: the latch seeds the first render.
      dispatchExtensionsSurfaceTarget({ view: 'plugins', sourceId: LATE_SOURCE.id, pluginId: 'late-one' })
      await act(async () => {
        lateRoot.render(React.createElement(ExtensionsGlobalSurface))
      })
      await settle()
      assert.ok(scanCalls.includes(LATE_SOURCE.id), 'selecting the tab is what starts the read')
      assert.ok(lateText().includes('Reading late/plugins…'), 'the tab says it is reading')
      assert.equal(dialog(), null, 'nothing has opened yet')
      assert.equal(lateText().includes('could not be opened'), false, 'and nothing has been declared missing')
    })

    await run('and opens the plugin the moment the scan lands', async () => {
      assert.ok(releaseLateScan, 'the scan was asked for')
      await act(async () => {
        releaseLateScan?.()
      })
      await settle()
      assert.equal(dialog()?.querySelector('#plugin-detail-title')?.textContent, 'Late one')
      await closeDialog()
    })

    await act(async () => {
      lateRoot.unmount()
    })

    console.log('extensions catalogue: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
