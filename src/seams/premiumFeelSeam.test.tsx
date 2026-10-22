import type { JSX } from 'react'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'
import { test, vi } from 'vitest'

// The IPC wire between the real preload and the real main handlers.
vi.mock('electron', () => import('../../tests/stubs/electron'))

test('premiumFeelSeam', async () => {
  // ── Seam: the premium-feel pass, where its members meet (epic 1999) ──────────
  //
  // Every member of this epic was reviewed on its own, and each has its own suite.
  // None of them can show that the hops MEET, and each of the four seams below has
  // a failure mode that every existing suite would sit through happily:
  //
  //  1. **Token → primitive geometry.** `tokens.tokens.json` → `tokens.css` →
  //     `index.css` aliases → the `@theme` block → a Tailwind utility → the
  //     component. Six hops. Every suite in the repo asserts one end or the other:
  //     `design-system-build-tokens` proves the generator, `ProviderRow.test`
  //     proves the markup carries `text-body`. A `@theme` entry retargeted at a
  //     name nothing defines makes `font-size: var(--text-body)` resolve to
  //     nothing, the row silently inherits, and both suites stay green.
  //  2. **T4's probe → T5's rows.** The main-process probe answers a five-state
  //     union; the settings rows must render each state as its own row and must
  //     never render a provider the probe did not answer for.
  //  3. **T9's probe → T10's menu.** Probe-hide, not probe-disable: a target the
  //     launcher does not resolve has to be ABSENT, not disabled. `folder-open-ipc.test`
  //     drives the handler with its own deps, and `openInEditorTargets.test` calls
  //     the pure functions with hand-written availability lists — so nothing today
  //     would notice the handler and the control disagreeing about the shape.
  //  4. **Drill-in replaces the rail.** `globalDoorsIntegration` proves every door
  //     DECLARES a rail; nothing proves the host then takes the projects rail down
  //     and puts it back, which is the half the operator sees.
  //
  // WHAT IS REAL HERE: the shipped `tokens.css` and `index.css`, the real Tailwind
  // v4 compiler over the real `@theme` block, the real components, the real main
  // IPC handlers reached through the real preload passthrough (via the `electron`
  // stub, which is the wire and not a mock of either side), the real renderer
  // hosts, and the real store.
  //
  // WHAT IS STOOD IN FOR, stated so nothing here reads as more than it is:
  //
  //  * The two binaries. `probeBinaryVersion('git')` and `gh auth status` spawn
  //    real processes whose answers are this laptop's, so the probe's own two
  //    dependency functions are supplied per scenario. Everything from the handler
  //    inward is the product's.
  //  * The filesystem the launcher probe reads. `resolveFolderOpenLauncher` is the
  //    real function; its `exists`/`platform`/`env` port is a fixture, because the
  //    seam under test is "what the probe answered reaches the menu", not which
  //    editors this machine happens to have.
  //  * `WorkspaceManager`'s JSX. The rail seam mounts the real `WorkspaceSidebar`,
  //    the real `ContextRailColumn` and a real door, but the ~15 lines of the
  //    manager that wire them are modelled here (`contextRailActive = a door is
  //    open && the door reported a rail`) rather than mounted — the manager pulls
  //    in FlexLayout, xterm and the terminal runtime. That derivation is asserted
  //    against the manager's source below so the model cannot drift from it
  //    silently.
  //  * Reduced motion. jsdom applies no stylesheet and runs no animation, so the
  //    reduced-motion legs read the SHIPPED rule set through the CSSOM (what
  //    `@media (prefers-reduced-motion: reduce)` actually neutralises) and the
  //    components' own `motion-reduce:` markup. Named as what it is: a stylesheet
  //    assertion, not an observed frame.
  //
  // Labelled SEAM: per the run-A convention.

  const dom = installJsdomEnvironment()
  // The module registry lazy-loads the workspace store, and the store imports the
  // registry back. Vitest's module runner hands a lazy import of a module that is
  // still evaluating back half-initialised, where a browser would wait for it; so
  // the registry loads first, and the store it pulls in evaluates on its own.
  await import('../renderer/src/modules')
  const domWindow = dom.window as unknown as Record<string, unknown>
  // Popover measures its surface before it can take focus, and it does that on the
  // next frame. `pretendToBeVisual` gives the jsdom window a real rAF; only the
  // bare globals the bundled renderer reaches for are missing.
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)

  const require_ = createRequire(join(process.cwd(), 'noop.js'))
  const REPO = process.cwd()
  const INDEX_CSS = join(REPO, 'src/renderer/src/assets/index.css')
  const TOKENS_CSS = join(REPO, 'design-system/foundations/tokens.css')
  const TOKENS_JSON = join(REPO, 'design-system/foundations/tokens.tokens.json')

  // ── The CSS side of the geometry chain ──────────────────────────────────────

  /** The body of the first `@theme { … }` block in `css`, braces balanced. */
  function extractBlock(css: string, opener: string): string {
    const start = css.indexOf(opener)
    assert.notEqual(start, -1, `${opener} must exist in the stylesheet`)
    let depth = 0
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i)
      }
    }
    assert.fail(`unbalanced braces after ${opener}`)
  }

  /**
   * Every `--name: value` declaration in a stylesheet, keyed by name, carrying
   * EVERY distinct value found for it. Distinctness is the point: nineteen theme
   * blocks redefine the colour tokens, so a resolver that silently took the first
   * one would be guessing. `resolveLength` refuses any name with more than one,
   * which turns "someone gave this size a per-theme value" into a failure here
   * rather than a mystery on screen.
   */
  function collectDeclarations(css: string, into: Map<string, Set<string>>): Map<string, Set<string>> {
    // Comments first: several carry `--foo: 12px` as prose about a value.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
      const name = match[1]
      const value = match[2].trim()
      const seen = into.get(name) ?? new Set<string>()
      seen.add(value)
      into.set(name, seen)
    }
    return into
  }

  /** `12px` / `0.25rem` / `calc(0.25rem * 8)` → a number of CSS pixels. */
  function evaluateLength(expression: string, what: string): number {
    const numeric = expression
      .replace(/calc\(/g, '(')
      .replace(/(-?[\d.]+)rem\b/g, (_, n: string) => String(Number(n) * 16))
      .replace(/(-?[\d.]+)px\b/g, '$1')
      .trim()
    assert.match(numeric, /^[-+*/(). \d]+$/, `${what} must resolve to arithmetic over lengths, got ${expression}`)
    // The string is asserted to be arithmetic above.
    const value = Number(new Function(`return (${numeric})`)())
    assert.ok(Number.isFinite(value), `${what} did not evaluate to a number: ${expression}`)
    return value
  }

  type Chain = { pixels: number; hops: string[] }

  /**
   * Resolve a CSS length through the whole alias chain, recording each hop.
   *
   * The hops are what make this an alias-chain assertion rather than a value
   * assertion: `--text-body` resolving to 13px because someone typed `13px` into
   * the `@theme` block passes a pixel check and fails this one.
   */
  function resolveChain(
    expression: string,
    declarations: Map<string, Set<string>>,
    what: string,
    hops: string[] = [],
  ): Chain {
    // A self- or mutually-referential alias would recurse until the stack blew,
    // which reads as a crashed suite rather than as the broken chain it is. No
    // real chain here is more than four hops deep.
    assert.ok(hops.length < 12, `${what}: the alias chain does not terminate — ${hops.join(' → ')}`)
    const reference = /var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/.exec(expression)
    if (!reference) return { pixels: evaluateLength(expression, what), hops }
    const [, name, fallback] = reference
    const values = declarations.get(name)
    if (!values) {
      assert.ok(fallback, `${what}: ${name} is referenced but never defined — the alias chain is broken`)
      return resolveChain(expression.replace(reference[0], fallback as string), declarations, what, [
        ...hops,
        `${name}(fallback)`,
      ])
    }
    assert.equal(
      values.size,
      1,
      `${what}: ${name} has ${values.size} distinct values (${[...values].join(' | ')}) — a size token must not vary`,
    )
    const value = [...values][0]
    return resolveChain(expression.replace(reference[0], value), declarations, what, [...hops, name])
  }

  // A rejection raised inside a mounted effect lands outside every `check`, and
  // node exits on it — which would truncate the run and read as "the suite stopped
  // early" rather than as a failure. Recorded as the failure it is instead.
  process.on('unhandledRejection', (reason) => {
    console.error('not ok - unhandled rejection outside a check')
    console.error(reason)
    process.exitCode = 1
  })

  async function main(): Promise<void> {
    let failures = 0
    const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    }

    const React = (await import('react')).default
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { renderToStaticMarkup } = await import('react-dom/server')

    const indexCss = readFileSync(INDEX_CSS, 'utf8')
    const tokensCss = readFileSync(TOKENS_CSS, 'utf8')
    // ONE `@theme` block is the seam invariant the plan states for this file. A
    // second one would silently win for whichever names it repeats, so the
    // resolver below would be reading a block the browser overrides.
    assert.equal((indexCss.match(/@theme\s*\{/g) ?? []).length, 1, 'index.css must carry exactly one @theme block')
    const themeBlock = extractBlock(indexCss, '@theme')

    // The renderer's whole custom-property universe, in cascade order: the bundle
    // the app imports, then the app's own aliases on top.
    const declarations = collectDeclarations(indexCss, collectDeclarations(tokensCss, new Map()))

    // ── Tailwind, for real ─────────────────────────────────────────────────────
    //
    // The utilities under test are GENERATED from the `@theme` block — there is no
    // static stylesheet to read them out of. So the app's own `@theme` goes
    // through the same compiler the app's build uses, and every assertion below
    // reads the CSS that compiler emitted for the class names the components
    // actually rendered.
    const { compile } = require_('tailwindcss') as {
      compile: (css: string, options: Record<string, unknown>) => Promise<{ build: (candidates: string[]) => string }>
    }
    const compiler = await compile(`@import "tailwindcss";\n@theme {${themeBlock}}`, {
      base: REPO,
      loadStylesheet: async (id: string) => {
        const path = id.startsWith('tailwindcss')
          ? require_.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id)
          : id
        return { path, base: path.slice(0, path.lastIndexOf('/')), content: readFileSync(path, 'utf8') }
      },
    })

    /** class name → the declarations Tailwind generated for it, unconditional only. */
    function compileUtilities(candidates: string[]): Map<string, Map<string, string>> {
      const css = compiler.build([...new Set(candidates)])
      // Tailwind's own theme layer ships in the app bundle too, and it is where
      // `--spacing` (the unit behind `w-8`, `size-1.5`) is defined. Merged in so
      // the resolver reads the same variable universe the browser does.
      collectDeclarations(css, declarations)
      const byClass = new Map<string, Map<string, string>>()
      // Only plain `.class { … }` rules: a variant (`hover:`, `motion-reduce:`)
      // compiles to a nested or wrapped rule and is deliberately not resting
      // geometry.
      for (const match of css.matchAll(/(^|\n)\s*\.((?:[^{}\s,\\]|\\.)+)\s*\{([^{}]*)\}/g)) {
        const className = match[2].replace(/\\/g, '')
        const declarationList = new Map<string, string>()
        for (const declaration of match[3].split(';')) {
          const index = declaration.indexOf(':')
          if (index === -1) continue
          declarationList.set(declaration.slice(0, index).trim(), declaration.slice(index + 1).trim())
        }
        if (declarationList.size > 0) byClass.set(className, declarationList)
      }
      return byClass
    }

    /**
     * The resting geometry of one rendered element: its class list run through the
     * real compiler, the winning declaration for `property` taken, then resolved
     * through the alias chain to pixels.
     *
     * This is the whole point of the suite's first section — the number asserted
     * is the number the element renders at, arrived at the way the browser
     * arrives at it, so a break anywhere in the six hops lands here.
     */
    function geometry(element: Element, property: string, utilities: Map<string, Map<string, string>>): Chain {
      const classes = new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
      let expression: string | undefined
      let source = ''
      // Walked in STYLESHEET order, not class-attribute order: two utilities that
      // set the same property have equal specificity, so the later RULE wins and
      // the order they were written on the element is irrelevant. `utilities` is
      // built in emission order, which is what makes this the browser's rule.
      for (const [className, declared] of utilities) {
        if (!classes.has(className)) continue
        const value = declared.get(property)
        if (value === undefined) continue
        expression = value
        source = className
      }
      assert.ok(
        expression,
        `no compiled utility on [${[...classes].join(' ')}] sets ${property} — the element draws no ${property} of its own`,
      )
      return resolveChain(expression, declarations, `${source} → ${property}`)
    }

    // ═══ 1. Token → primitive geometry ═══════════════════════════════════════
    //
    // The step-up is a set of NUMBERS the epic ruled on, and the only honest way
    // to hold them is at the far end of the chain that produces them.

    const { Switch } = await import('../renderer/src/components/ui/Switch')
    const { ProviderRow } = await import('../renderer/src/components/ui/ProviderRow')

    const parse = (markup: string): Element => {
      const host = dom.window.document.createElement('div')
      host.innerHTML = markup
      return host
    }

    const renderProviderRow = (props: Record<string, unknown> = {}): Element =>
      parse(
        renderToStaticMarkup(
          <ProviderRow
            icon={<span data-mark="" />}
            health="good"
            name="Claude Code"
            version="2.0.14"
            stateLine="Ready — /usr/local/bin/claude"
            enabled
            onEnabledChange={() => {}}
            expanded={false}
            onExpandedChange={() => {}}
            {...props}
          >
            <span>detail</span>
          </ProviderRow>,
        ),
      )

    await check('Switch renders the 32×18 track and 12px thumb the ruling pinned', () => {
      const off = parse(renderToStaticMarkup(<Switch checked={false} onChange={() => {}} ariaLabel="Telemetry" />))
      const track = off.querySelector('[role="switch"]')
      const thumb = off.querySelector('.switch-thumb')
      assert.ok(track && thumb, 'the switch renders a track and a thumb')

      const utilities = compileUtilities([
        ...(track.getAttribute('class') ?? '').split(/\s+/),
        ...(thumb.getAttribute('class') ?? '').split(/\s+/),
      ])
      assert.equal(geometry(track, 'width', utilities).pixels, 32)
      assert.equal(geometry(track, 'height', utilities).pixels, 18)
      assert.equal(geometry(thumb, 'width', utilities).pixels, 12)
      assert.equal(geometry(thumb, 'height', utilities).pixels, 12)

      // The 2px inset at both ends is what the travel encodes, and it is only true
      // if the track's content box really is the full 32px — which is why the
      // hairline is an inset shadow rather than a border. Read off the shipped
      // rule, since the travel lives in index.css rather than on a utility.
      const rest = /\.switch-thumb\s*\{[^}]*translate:\s*(-?[\d.]+)px/.exec(indexCss)
      const end = /\.switch-track\[aria-checked="true"\]\s+\.switch-thumb\s*\{[^}]*translate:\s*(-?[\d.]+)px/.exec(
        indexCss,
      )
      assert.ok(rest && end, 'the thumb declares a resting and an end position')
      assert.equal(Number(rest[1]), 2, 'the thumb rests 2px in')
      assert.equal(Number(end[1]), 32 - 12 - 2, 'and travels to width − thumb − inset, so both ends inset equally')
      assert.doesNotMatch(
        /\.switch-track\s*\{[^}]*\}/.exec(indexCss)?.[0] ?? '',
        /border-width|border:/,
        'a layout border would eat the inset the travel assumes',
      )
    })

    await check('ProviderRow renders every slot on the stepped-up ramp', () => {
      const row = renderProviderRow()
      const mark = row.querySelector('span.relative')
      const dot = row.querySelector('[aria-hidden="true"].absolute')
      const name = row.querySelector('.truncate.text-body') ?? row.querySelector('.text-body')
      const version = row.querySelector('[title="2.0.14"]')
      const stateLine = row.querySelector('.text-meta')
      const chevronButton = row.querySelector('button[aria-label="Claude Code details"]')
      const chevronGlyph = chevronButton?.querySelector('svg')
      assert.ok(mark && dot && name && version && stateLine && chevronButton && chevronGlyph)

      const utilities = compileUtilities(
        [...row.querySelectorAll('*')].flatMap((node) =>
          (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
        ),
      )

      // The numbers the epic ruled on, at the end of the chain that produces them.
      assert.equal(geometry(name, 'font-size', utilities).pixels, 13, 'the row name is body')
      assert.equal(geometry(version, 'font-size', utilities).pixels, 11, 'the version is micro')
      assert.equal(geometry(stateLine, 'font-size', utilities).pixels, 12, 'the state line is meta')
      assert.equal(geometry(mark, 'width', utilities).pixels, 22, 'the brand mark box is icon-lg')
      assert.equal(geometry(mark, 'height', utilities).pixels, 22)
      assert.equal(geometry(dot, 'width', utilities).pixels, 10, 'the health mark is a 10px glyph, not a 6px dot')
      assert.equal(geometry(chevronGlyph, 'width', utilities).pixels, 13, 'the chevron glyph is icon-xs')
      assert.equal(
        geometry(chevronButton, 'width', utilities).pixels,
        24,
        'and its target pads out to the hit-target floor rather than shrinking to the glyph',
      )
      assert.ok(
        geometry(chevronButton, 'width', utilities).pixels > geometry(chevronGlyph, 'width', utilities).pixels,
        'drawn size and target size are different numbers, per foundations/principles.md',
      )
    })

    await check('every ramp utility reaches a design-system token, hop by hop', () => {
      const row = renderProviderRow()
      const utilities = compileUtilities(
        [...row.querySelectorAll('*')].flatMap((node) =>
          (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
        ),
      )
      const name = row.querySelector('.text-body') as Element
      const mark = row.querySelector('span.relative') as Element

      // Six hops, named. A `@theme` entry that restated a pixel value would still
      // paint 13px and would have no `--sem-` hop, which is exactly the silent
      // break this asserts against.
      const type = geometry(name, 'font-size', utilities)
      assert.deepEqual(type.hops, ['--text-body', '--text-size-sm', '--sem-font-size-body'])
      const icon = geometry(mark, 'width', utilities)
      assert.deepEqual(icon.hops, ['--spacing-icon-lg', '--icon-lg', '--sem-icon-size-lg'])

      // And the last hop is a real entry in the source of truth, not a hand-added
      // line in the generated file.
      const tokens = JSON.parse(readFileSync(TOKENS_JSON, 'utf8')) as Record<string, unknown>
      const lookup = (path: string[]): unknown =>
        path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tokens)
      assert.equal(lookup(['sem', 'font', 'size', 'body', '$value']), '13px')
      assert.equal(lookup(['sem', 'icon', 'size', 'lg', '$value']), '22px')
    })

    await check('a Switch inside a ProviderRow keeps the primitive geometry', () => {
      const row = renderProviderRow()
      const track = row.querySelector('[role="switch"]')
      assert.ok(track, 'a row with enablement state renders the switch')
      const utilities = compileUtilities((track.getAttribute('class') ?? '').split(/\s+/))
      assert.equal(geometry(track, 'width', utilities).pixels, 32)
      assert.equal(geometry(track, 'height', utilities).pixels, 18)
      assert.equal(track.getAttribute('aria-label'), 'Claude Code enabled')
    })

    await check('a host with no enablement state renders no switch at all', () => {
      const row = renderProviderRow({ enabled: undefined, onEnabledChange: undefined })
      assert.equal(row.querySelector('[role="switch"]'), null, 'not a disabled one — none')
      assert.equal(row.querySelector('[disabled]'), null)
    })

    // ═══ 2. T4's probe → T5's version-control rows ═══════════════════════════
    //
    // Real main handler → real preload → real settings sections. The only
    // stand-ins are the functions that shell out to `--version` and to the
    // forge CLIs' auth, because their answers would otherwise be this laptop's.

    const { ipcMain } = await import('electron')
    const { registerVersionControlIpc } = await import('../main/ipc/version-control-ipc')
    const { VERSION_CONTROL_PROVIDER_IDS } = await import('../shared/version-control')
    const { filesystemApi } = await import('../preload/api/filesystem')
    const { VersionControlSections } = await import('../renderer/src/components/settings/SettingsPanel')

    type BinaryVersionProbe = import('../main/cli-runtime-install').BinaryVersionProbe
    type VersionControlProviderId = import('../shared/version-control').VersionControlProviderId

    /** What the two binaries answer for one scenario. */
    let binaryProbe: (binary: VersionControlProviderId) => BinaryVersionProbe = () =>
      ({
        outcome: 'not_installed',
      }) as BinaryVersionProbe
    let ghLogin: string | null = null

    registerVersionControlIpc(ipcMain, {
      probeVersion: async (binary) => binaryProbe(binary),
      readGhLogin: async () => ghLogin,
      readForgeLogin: async () => null,
    })

    domWindow.api = withInertPreloadFallback({
      ...filesystemApi,
      platform: 'darwin',
      isDevelopment: false,
      isDiagnosticsEnabled: false,
      // The tailnet/mesh presence bridge is ABSENT here, deliberately, rather
      // than stubbed.
      // `hasTailnetPresenceBridge` (topbar/useTailnetPresence.ts) needs all six to
      // be functions and otherwise leaves the sidebar's Remote band empty. Without
      // this, the inert fallback answered `meshListConnections()` with its
      // `{ ok: false, … }` refusal, `buildRemoteBand` called `.map` on that object
      // and WorkspaceSidebar threw "connections.map is not a function" at mount,
      // taking the rail-swap check below with it. (The band landed 2026-09-05,
      // after this seam, and was never seen because verify:app halts earlier.)
      // Naming them undefined keeps `prop in target` true, so the Proxy hands back
      // undefined and the guard reads the bridge as missing — which it is. This
      // seam says nothing about the Remote band; stubbing a mesh here would be
      // inventing a shape no assertion reads.
      onTailnetEvent: undefined,
      onMeshEvent: undefined,
      tailnetGetStatus: undefined,
      tailnetGetLiveState: undefined,
      meshListConnections: undefined,
      meshGetLiveState: undefined,
    })

    /**
     * Mount the real settings sections and let their own mount probe run all the
     * way to the handler above. Returns the rendered rows, addressed the way a
     * person reads them: by the provider's name.
     */
    async function renderVersionControlRows(): Promise<{
      text: string
      rowFor: (name: string) => Element | null
      unmount: () => Promise<void>
    }> {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<VersionControlSections githubToken={<span>token field</span>} />)
      })
      // The probe is a full IPC round-trip; settle on the answer rather than on a
      // guessed number of ticks.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!(container.textContent ?? '').includes('Checking…')) break
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
      }
      return {
        text: container.textContent ?? '',
        rowFor: (name: string) => {
          const heading = [...container.querySelectorAll('span')].find(
            (node) => node.textContent === name && node.className.includes('text-body'),
          )
          return heading?.closest('.group') ?? null
        },
        unmount: async () => {
          await act(async () => {
            root.unmount()
          })
          container.remove()
        },
      }
    }

    await check('a resolved git and an unauthenticated gh reach the rows as different states', async () => {
      binaryProbe = (binary) =>
        ({
          outcome: 'resolved',
          version: binary === 'git' ? 'git version 2.45.1' : `${binary} version 2.62.0`,
        }) as BinaryVersionProbe
      ghLogin = null

      const rendered = await renderVersionControlRows()
      try {
        assert.match(rendered.text, /Available/, 'git resolved with no auth of its own reads Available')
        assert.match(
          rendered.text,
          /Not authenticated — gh auth login/,
          'gh resolved with no login is its own state, never "Available" and never "Not installed"',
        )
        // Versions are the binaries' own output, carried whole rather than parsed
        // into a semver the row then pretends is one.
        assert.match(rendered.text, /git version 2\.45\.1/)
        assert.match(rendered.text, /gh version 2\.62\.0/)
        assert.doesNotMatch(rendered.text, /Checking…/, 'the round-trip settled')
        assert.doesNotMatch(rendered.text, /unknown/i, 'no placeholder where a fact is missing')

        // Only the providers the probe answers for, and no forge the product does
        // not integrate: absence, not a disabled row.
        for (const absent of ['Bitbucket', 'Azure']) {
          assert.doesNotMatch(rendered.text, new RegExp(absent))
        }
        assert.ok(rendered.rowFor('Git'), 'the git row rendered')
        assert.ok(rendered.rowFor('GitHub'), 'the gh row rendered')
      } finally {
        await rendered.unmount()
      }
    })

    await check('gh with a login renders the login, and only git keeps no disclosure', async () => {
      binaryProbe = () => ({ outcome: 'resolved', version: 'x version 1' }) as BinaryVersionProbe
      ghLogin = 'octocat'

      const rendered = await renderVersionControlRows()
      try {
        assert.match(rendered.text, /Authenticated as octocat/)
        // Only GitHub has per-instance configuration behind it, so only its row
        // draws a chevron — an empty disclosure is a control that opens on nothing.
        assert.ok(
          rendered.rowFor('GitHub')?.querySelector('button[aria-label="GitHub details"]'),
          'the gh row discloses its token field',
        )
        assert.equal(
          rendered.rowFor('Git')?.querySelector('button[aria-label="Git details"]') ?? null,
          null,
          'the git row has nothing behind it and draws no chevron',
        )
        // Neither row carries enablement, so neither renders a switch.
        assert.equal(rendered.rowFor('Git')?.querySelector('[role="switch"]') ?? null, null)
        assert.equal(rendered.rowFor('GitHub')?.querySelector('[role="switch"]') ?? null, null)
      } finally {
        await rendered.unmount()
      }
    })

    await check('"not installed" and "we could not ask" render as different rows', async () => {
      binaryProbe = (binary) => ({ outcome: binary === 'git' ? 'not_installed' : 'probe_failed' }) as BinaryVersionProbe
      ghLogin = null

      const rendered = await renderVersionControlRows()
      try {
        // A definitive verdict pairs with the install path for THIS platform…
        assert.match(rendered.text, /Not installed — brew install git/)
        // …and a non-answer never borrows it. Collapsing these two would send an
        // operator to install something that is already there.
        assert.match(rendered.text, /Availability unknown — the check did not complete/)
        assert.doesNotMatch(
          rendered.text,
          /Not installed — brew install gh/,
          'a probe that never answered must not be reported as missing',
        )
      } finally {
        await rendered.unmount()
      }
    })

    await check('a provider the round-trip skipped reads unknown, not installed', async () => {
      // The handler answers for every id, so this failure can only be modelled by
      // breaking the round-trip itself — which is the same non-answer.
      const skipped: VersionControlProviderId[] = [...VERSION_CONTROL_PROVIDER_IDS]
      assert.deepEqual(skipped, ['git', 'gh', 'glab', 'tea'], 'the row universe is the probe id list')
      binaryProbe = () => {
        throw new Error('probe exploded')
      }
      const rendered = await renderVersionControlRows()
      try {
        assert.match(rendered.text, /Version control could not be checked\./, 'the failure is stated once')
        assert.match(rendered.text, /probe exploded/, 'with the real reason behind it')
        // Every row with no answer reads unknown — never "not installed", and
        // never a silently empty list.
        assert.equal((rendered.text.match(/Availability unknown — the check did not complete/g) ?? []).length, 4)
      } finally {
        await rendered.unmount()
      }
    })

    // ═══ 3. T9's probe → T10's split-button menu ═════════════════════════════
    //
    // Real launcher resolution → real main handler → real preload → the real
    // workspace-bar control. The fixture is the machine (which editors exist),
    // never the contract between the halves.

    const { registerFolderOpenIpc, resolveFolderOpenLauncher } = await import('../main/ipc/folder-open-ipc')
    const { FOLDER_OPEN_TARGET_IDS } = await import('../shared/folder-open-targets')
    // 2026-09-04 (bc02a70db) split this control in two: `useFolderOpenTargets`
    // owns the probe, the launch and the remembered primary, and the button is a
    // renderer over one hook instance — so the folded overflow menu and the
    // inline SplitButton cannot each register `Primary+O`. This seam mounted the
    // pre-split `<OpenWorkspaceFolderButton workspaceId openPath />`, which after
    // the split resolved to `undefined` and threw "Element type is invalid" on
    // every render, taking both checks below down with it. Rewired 2026-09-06 to
    // the shipped pair, called exactly the way `WorkspaceIdentity` calls it —
    // one hook instance, handed to the button — so the seam still runs the real
    // probe into the real menu rather than a copy of either.
    const { OpenWorkspaceFolderButton, useFolderOpenTargets } =
      await import('../renderer/src/components/workspace/WorkspaceIdentity')
    const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')

    /** Which launchers this fixture machine resolves. */
    let installedPaths = new Set<string>()
    const launched: Array<{ command: string; args: string[] }> = []
    const revealed: string[] = []
    let launchOutcome: { ok: true } | { ok: false; message: string } = { ok: true }
    let pathReachable = true

    registerFolderOpenIpc(ipcMain, {
      showItemInFolder: async (targetPath) => {
        revealed.push(targetPath)
      },
      // The REAL resolver, over a fixture filesystem: what the menu offers and
      // what a click can launch stay one answer, which is the rule under test.
      resolveLauncher: (target) =>
        resolveFolderOpenLauncher(target, {
          platform: 'darwin',
          env: { PATH: '/usr/local/bin', HOME: '/Users/fixture' },
          exists: (candidate) => installedPaths.has(candidate),
        }),
      runLauncher: async (command, args) => {
        launched.push({ command, args })
        return launchOutcome
      },
      assertPathReachable: async () => {
        if (!pathReachable) throw new Error('ENOENT: no such directory')
      },
    })

    const OPEN_PATH = '/Users/fixture/projects/app'

    /**
     * `WorkspaceIdentity`'s own wiring: one hook instance, handed to the button,
     * with `failureNode` rendered beside it. Both halves are needed — since
     * bc02a70db the failure popover belongs to the HOOK, not the button (the
     * folded overflow menu has to raise the same one), so a host that renders
     * only the button swallows every launch failure and the "a launch that
     * failed is surfaced" check below fails against working product code.
     */
    const OpenButtonHost = () => {
      const targets = useFolderOpenTargets('w1', OPEN_PATH)
      return (
        <>
          <OpenWorkspaceFolderButton targets={targets} />
          {targets.failureNode}
        </>
      )
    }

    async function mountOpenButton(): Promise<{
      container: HTMLElement
      unmount: () => Promise<void>
    }> {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<OpenButtonHost />)
      })
      // The control renders nothing until its probe answers.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (container.querySelector('button')) break
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
      }
      return {
        container: container as unknown as HTMLElement,
        unmount: async () => {
          await act(async () => {
            root.unmount()
          })
          container.remove()
        },
      }
    }

    const openMenu = async (container: HTMLElement): Promise<HTMLElement[]> => {
      const chevron = container.querySelector<HTMLButtonElement>('button[aria-label="Open workspace folder in…"]')
      assert.ok(chevron, 'the split button renders a menu half')
      await act(async () => {
        chevron.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      return [...dom.window.document.querySelectorAll('[data-menu-item="true"]')] as HTMLElement[]
    }

    await check('an editor the probe cannot resolve is absent from the menu, not disabled', async () => {
      // One editor on PATH, the other nowhere: one editor installed, one not.
      installedPaths = new Set(['/usr/local/bin/code'])
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: { ...state.appSettings, lastFolderOpenTarget: null },
          }) as never,
      )

      const mounted = await mountOpenButton()
      try {
        const rows = await openMenu(mounted.container)
        const labels = rows.map((row) => row.textContent ?? '')
        assert.ok(
          labels.some((label) => label.includes('VS Code')),
          'the resolved editor is offered',
        )
        assert.ok(
          labels.some((label) => label.includes('Finder')),
          'the file manager always resolves',
        )
        assert.equal(
          labels.filter((label) => label.includes('IntelliJ')).length,
          0,
          'the unresolved editor is ABSENT — a disabled row for a missing editor is a fake affordance',
        )
        assert.equal(
          rows.filter((row) => row.hasAttribute('disabled')).length,
          0,
          'and nothing in the menu is disabled at all',
        )
        // The primary half runs the first target that resolves, and says which.
        assert.ok(
          mounted.container.querySelector('button[aria-label="Open workspace folder in VS Code"]'),
          'the primary half names its resolved target',
        )
      } finally {
        await mounted.unmount()
      }
    })

    await check('with only the file manager resolving there is no menu at all', async () => {
      installedPaths = new Set()
      const mounted = await mountOpenButton()
      try {
        assert.equal(
          mounted.container.querySelector('button[aria-label="Open workspace folder in…"]'),
          null,
          'a chevron whose menu holds one row — already the primary — opens to say nothing',
        )
        const primary = mounted.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Open workspace folder in Finder"]',
        )
        assert.ok(primary, 'the plain button remains, naming the one target that resolves')

        // And it reaches the real reveal path through the real channel.
        revealed.length = 0
        await act(async () => {
          primary.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
        assert.deepEqual(revealed, [OPEN_PATH], 'the click revealed the checkout it was given')
      } finally {
        await mounted.unmount()
      }
    })

    await check('a remembered target that no longer resolves falls back rather than arming a failure', async () => {
      // The remembered editor has since been uninstalled.
      installedPaths = new Set(['/usr/local/bin/code'])
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: { ...state.appSettings, lastFolderOpenTarget: 'intellij' },
          }) as never,
      )
      const mounted = await mountOpenButton()
      try {
        assert.ok(
          mounted.container.querySelector('button[aria-label="Open workspace folder in VS Code"]'),
          'the primary falls back to the first target that resolves',
        )
        assert.equal(
          mounted.container.querySelector('button[aria-label="Open workspace folder in IntelliJ IDEA"]'),
          null,
        )
      } finally {
        await mounted.unmount()
        useWorkspaceStore.setState(
          (state) =>
            ({
              appSettings: { ...state.appSettings, lastFolderOpenTarget: null },
            }) as never,
        )
      }
    })

    await check('choosing a menu row launches that target through the real channel', async () => {
      installedPaths = new Set(['/usr/local/bin/code'])
      launched.length = 0
      launchOutcome = { ok: true }
      const mounted = await mountOpenButton()
      try {
        const rows = await openMenu(mounted.container)
        const vscode = rows.find((row) => (row.textContent ?? '').includes('VS Code'))
        assert.ok(vscode)
        await act(async () => {
          vscode.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
        assert.deepEqual(
          launched,
          [{ command: '/usr/local/bin/code', args: [OPEN_PATH] }],
          'the folder is the final argv element, never shell text',
        )
        assert.equal(
          useWorkspaceStore.getState().appSettings.lastFolderOpenTarget,
          'vscode',
          'a launch that happened re-points the primary',
        )
      } finally {
        await mounted.unmount()
      }
    })

    await check('a launch that failed is surfaced and does not re-point the primary', async () => {
      installedPaths = new Set(['/usr/local/bin/code'])
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: { ...state.appSettings, lastFolderOpenTarget: 'finder' },
          }) as never,
      )
      launchOutcome = { ok: false, message: 'code exited with code 1.' }
      const mounted = await mountOpenButton()
      try {
        const rows = await openMenu(mounted.container)
        const vscode = rows.find((row) => (row.textContent ?? '').includes('VS Code'))
        assert.ok(vscode)
        await act(async () => {
          vscode.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        // Polled rather than a fixed wait: the failure crosses the launch
        // promise and a store update before it renders, and a slow CI runner
        // takes longer than a laptop to get there.
        const failure = /Could not open VS Code: code exited with code 1\./
        for (let waited = 0; waited < 2000 && !failure.test(dom.window.document.body.textContent ?? ''); waited += 5) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
          })
        }
        assert.match(
          dom.window.document.body.textContent ?? '',
          failure,
          'the typed failure reaches the operator rather than being swallowed',
        )
        assert.equal(
          useWorkspaceStore.getState().appSettings.lastFolderOpenTarget,
          'finder',
          'and re-pointing the primary at an editor that just failed would repeat it',
        )
      } finally {
        await mounted.unmount()
        launchOutcome = { ok: true }
        useWorkspaceStore.setState(
          (state) =>
            ({
              appSettings: { ...state.appSettings, lastFolderOpenTarget: null },
            }) as never,
        )
      }
    })

    await check('the menu and the launch resolve the same targets, id for id', async () => {
      // The two channels share `resolveLauncher`, so this is the invariant that
      // makes probe-hide safe: nothing can be offered that a click cannot start.
      installedPaths = new Set(['/usr/local/bin/code'])
      const api = domWindow.api as {
        listFolderOpenTargets: () => Promise<Array<{ id: string; available: boolean }>>
        openFolderInTarget: (request: { target: string; path: string }) => Promise<{ ok: boolean; reason?: string }>
      }
      const availability = await api.listFolderOpenTargets()
      assert.deepEqual(
        availability.map((entry) => entry.id),
        [...FOLDER_OPEN_TARGET_IDS],
        'the probe answers for every known target, always',
      )
      for (const entry of availability) {
        const result = await api.openFolderInTarget({ target: entry.id, path: OPEN_PATH })
        assert.equal(result.ok, entry.available, `${entry.id}: availability and launchability must be one answer`)
        if (!result.ok) assert.equal(result.reason, 'target_unavailable')
      }
      // And an unreachable folder is refused before anything is spawned.
      pathReachable = false
      launched.length = 0
      const refused = await api.openFolderInTarget({ target: 'vscode', path: OPEN_PATH })
      pathReachable = true
      assert.equal(refused.ok, false)
      assert.equal(refused.reason, 'path_unavailable')
      assert.deepEqual(launched, [], 'nothing was spawned for a folder that is not there')
    })

    // ═══ 4. Keyboard and reduced motion on the new overlays ══════════════════

    await check('the split-button menu opens on ArrowDown and lands on a row', async () => {
      installedPaths = new Set(['/usr/local/bin/code'])
      const mounted = await mountOpenButton()
      try {
        const chevron = mounted.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Open workspace folder in…"]',
        )
        assert.ok(chevron)
        assert.equal(chevron.getAttribute('aria-haspopup'), 'menu')
        assert.equal(chevron.getAttribute('aria-expanded'), 'false')

        chevron.focus()
        await act(async () => {
          chevron.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        })
        // Popover measures itself before it can take focus, so the first row is
        // focused on the next frame rather than in this one.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
        assert.equal(chevron.getAttribute('aria-expanded'), 'true', 'ArrowDown opens the menu')
        const rows = [...dom.window.document.querySelectorAll('[data-menu-item="true"]')] as HTMLElement[]
        assert.ok(rows.length > 1)
        assert.equal(
          dom.window.document.activeElement,
          rows[0],
          'and the keyboard lands on the first row rather than being left on the trigger',
        )
        // Exactly one row is checked: the target the primary half runs.
        const checked = rows.filter((row) => row.getAttribute('aria-checked') === 'true')
        assert.equal(checked.length, 1, 'a one-of set, not a row of toggles')

        await act(async () => {
          rows[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        })
        assert.equal(dom.window.document.activeElement, rows[1], 'ArrowDown roves to the next row')

        await act(async () => {
          rows[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
        assert.equal(chevron.getAttribute('aria-expanded'), 'false', 'Escape closes the menu')
      } finally {
        await mounted.unmount()
      }
    })

    await check('both new popovers open on the keyboard and ride the ONE shared enter', async () => {
      // The two controls T6 added. Their own suite
      // (`test:renderer:cli-model-picker`) drives search, chords and favourites;
      // what is asserted here is the part that belongs to this epic — that the
      // trigger contract holds and that both surfaces animate through the single
      // `.popover-enter` the Motion ruling names, rather than a local transition.
      const { CliModelPickerButton } = await import('../renderer/src/components/ui/CliModelPicker')
      // Imported for its side of the pairing below; the picker button mounts it.
      await import('../renderer/src/components/ui/ReasoningSelector')
      type PickerProps = Parameters<typeof CliModelPickerButton>[0]
      const options = [
        {
          value: 'claude-code',
          label: 'Claude Code',
          modelSelection: {
            options: [
              { id: 'claude-opus-5', label: 'Opus 5' },
              { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
            ],
            allowCustomId: true,
          },
          reasoningSelection: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High' },
            ],
          },
        },
      ] as unknown as PickerProps['options']

      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      try {
        await act(async () => {
          // One mount, both controls: the picker button renders the reasoning
          // selector beside its own trigger exactly as the product pairs them, so
          // this is the real composition rather than two isolated renders.
          root.render(
            <CliModelPickerButton
              ariaLabel="Agent runtime"
              options={options}
              cli={'claude-code' as PickerProps['cli']}
              effectiveModelFor={() => 'claude-opus-5'}
              effectiveReasoningFor={() => 'low'}
              onSelectReasoning={() => {}}
              onSelectCli={() => {}}
              onSelectModel={() => {}}
            />,
          )
        })

        // At rest there is ONE trigger: the model button. Reasoning is not a second
        // control beside it any more — it moved inside the model popover, under a
        // divider below the model list, because context window and effort are
        // decisions about the model chosen just above them. So the pairing this
        // seam cares about is trigger → surface → surface, not two peers.
        const modelTrigger = container.querySelector('button[aria-expanded]') as HTMLElement | null
        assert.ok(modelTrigger, 'the model popover trigger rendered')
        assert.equal(
          container.querySelectorAll('button[aria-expanded]').length,
          1,
          'reasoning is inside the model popover, not a second trigger beside it',
        )
        assert.equal(
          modelTrigger.getAttribute('aria-expanded'),
          'false',
          'an overlay trigger states its own expanded state before it is opened',
        )
        assert.ok(modelTrigger.hasAttribute('aria-haspopup'))

        const openAndAssert = async (trigger: HTMLElement, name: string): Promise<void> => {
          trigger.focus()
          await act(async () => {
            trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
          })
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
          })
          assert.equal(trigger.getAttribute('aria-expanded'), 'true', `${name}: the surface opened`)
          assert.ok(
            dom.window.document.querySelector('.popover-enter'),
            `${name}: rides the shared enter transition rather than a local one`,
          )
          // The keyboard is inside the surface, not left behind on the trigger —
          // the failure that makes arrow keys inert (verified in the built app).
          const active = dom.window.document.activeElement as HTMLElement | null
          assert.notEqual(active, trigger, `${name}: focus moved into the surface`)
        }

        await openAndAssert(modelTrigger, 'Agent runtime')

        // The reasoning selector now lives in the opened surface. Same contract:
        // its own trigger, its own expanded state, the same one enter transition.
        const reasoningTrigger = [...dom.window.document.querySelectorAll('button[aria-expanded]')].find(
          (node) => node !== modelTrigger,
        ) as HTMLElement | undefined
        assert.ok(reasoningTrigger, 'the reasoning selector rendered inside the open model popover')
        assert.ok(reasoningTrigger.hasAttribute('aria-haspopup'))
        await openAndAssert(reasoningTrigger, 'Reasoning')

        // On document, not window: the popover primitive listens there on purpose
        // (see Popover.tsx — document bubble listeners run before a hosting
        // dialog's window listener, so the popover consumes Escape first). A
        // window-targeted event never reaches it.
        await act(async () => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
        assert.equal(
          reasoningTrigger.getAttribute('aria-expanded'),
          'false',
          'Reasoning: Escape closes the innermost surface first',
        )
        assert.equal(
          modelTrigger.getAttribute('aria-expanded'),
          'true',
          'and leaves the model popover it opened from standing',
        )
      } finally {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    })

    await check('reduced motion neutralises every motion this epic added', () => {
      // STATED PLAINLY: jsdom applies no stylesheet and runs no animation, so this
      // reads the SHIPPED rule set through the CSSOM rather than observing a frame.
      // It is the strongest available check here, and it is not a rendered one.
      const style = dom.window.document.createElement('style')
      style.textContent = indexCss.replace(/@import[^;]+;/g, '')
      dom.window.document.head.appendChild(style)
      try {
        const sheet = style.sheet
        assert.ok(sheet, 'jsdom parsed the shipped stylesheet')
        const neutralised = new Map<string, Set<string>>()
        for (const rule of [...sheet.cssRules]) {
          const media = rule as CSSMediaRule
          if (!media.media || !media.conditionText?.includes('prefers-reduced-motion: reduce')) continue
          for (const inner of [...media.cssRules]) {
            const styleRule = inner as CSSStyleRule
            if (!styleRule.selectorText) continue
            for (const selector of styleRule.selectorText.split(',')) {
              const key = selector.trim()
              const properties = neutralised.get(key) ?? new Set<string>()
              for (const property of ['animation', 'transition', 'transform']) {
                if (styleRule.style.getPropertyValue(property) === 'none') properties.add(property)
              }
              neutralised.set(key, properties)
            }
          }
        }
        // The three eased motions principles.md names as the complete set, plus
        // the rail swap this epic added.
        assert.ok(neutralised.get('.switch-thumb')?.has('transition'), 'the switch thumb stops travelling')
        assert.ok(neutralised.get('.interactive')?.has('transition'), 'the hover crossfade stops')
        assert.ok(neutralised.get('.popover-enter')?.has('animation'), 'the popover enter stops')
        // The rail swap is declared only under `no-preference`, so under reduce
        // there is nothing to switch off — assert that shape rather than a guard
        // that would never fire.
        assert.match(
          indexCss,
          /@media \(prefers-reduced-motion: no-preference\) \{\s*\.context-rail-swap \{/,
          'the rail swap only exists under no-preference',
        )
      } finally {
        style.remove()
      }
      // And the two surfaces that carry their own guard say so in their markup,
      // because `.interactive` deliberately does not reach a full-width row.
      const row = renderProviderRow()
      assert.match(
        row.querySelector('.group')?.getAttribute('class') ?? '',
        /motion-reduce:transition-none/,
        'the row names its own guard for the crossfade `.interactive` does not cover',
      )
      assert.match(
        row.querySelector('button[aria-label="Claude Code details"] svg')?.getAttribute('class') ?? '',
        /motion-reduce:transition-none/,
        'and so does the chevron rotation',
      )
    })

    // ═══ 5. Drill-in replaces the rail, and gives it back ════════════════════

    await check('opening a door replaces the projects rail, and its bar carries the way back', async () => {
      const { default: WorkspaceSidebar } = await import('../renderer/src/components/workspace/WorkspaceSidebar')
      const { ContextRailColumn, ContextRailSlotContext } =
        await import('../renderer/src/components/workspace/globalSurface/contextRail')
      const { GlobalSurfaceShell } =
        await import('../renderer/src/components/workspace/globalSurface/GlobalSurfaceShell')

      // The manager's own derivation, modelled here because the manager itself
      // pulls in FlexLayout and the terminal runtime. Asserted against its source
      // below so this model cannot drift from it unnoticed.
      const manager = readFileSync(join(REPO, 'src/renderer/src/components/workspace/WorkspaceManager.tsx'), 'utf8')
      assert.match(
        manager,
        /const contextRailActive = activeGlobalSurfaceEntry !== null && surfaceHasRail/,
        'the host still derives rail takeover from "a door is open AND it reported a rail"',
      )
      assert.match(
        manager,
        // The slot is memoized on the door's id (see WorkspaceManager's
        // sidebar props), and handed to the sidebar as `contextRail`.
        /const contextRailSurfaceKey = activeGlobalSurfaceEntry\?\.id \?\? null[\s\S]{0,800}?contextRailSurfaceKey !== null \? \(\s*<ContextRailColumn[\s\S]*contextRail=\{sidebarContextRail\}/,
        'and still renders the column into the sidebar, not beside it',
      )

      function Host({ doorOpen, onBack }: { doorOpen: boolean; onBack: () => void }): JSX.Element {
        const [railEl, setRailEl] = React.useState<HTMLDivElement | null>(null)
        const [hasRail, setHasRail] = React.useState(false)
        const slot = React.useMemo(() => ({ el: railEl, onRailPresence: setHasRail }), [railEl])
        const active = doorOpen && hasRail
        return (
          <div>
            <WorkspaceSidebar
              {...({
                workspaces: [{ id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' }],
                activeWorkspaceId: 'w1',
                workspaceWindowId: 'win1',
                isDetachedWindow: false,
                sidebarCollapsed: false,
                chromeSlot: null,
                contextRail: doorOpen ? (
                  <ContextRailColumn
                    surfaceKey="backlog"
                    ariaLabel="Backlog rail"
                    active={active}
                    // The column takes a plain callback ref, not a state setter:
                    // a Dispatch<SetStateAction<T>> also accepts an updater fn,
                    // which is a wider contract than the column will ever call.
                    railRef={(element) => setRailEl(element)}
                  />
                ) : undefined,
                contextRailActive: active,
                activityByWorkspaceId: {},
                residentWorkspaceIds: new Set<string>(),
                terminalRecencyByWorkspaceId: {},
                onSelectWorkspace: () => {},
                onMoveWorkspaceToNewWindow: () => {},
                onMoveWorkspaceToMainWindow: () => {},
                onForgetFolder: () => {},
                onNewChat: () => {},
                onNewChatInFolder: () => {},
                onRevealFolder: () => {},
                onSetSidebarCollapsed: () => {},
                sidebarWidth: 260,
                onSetSidebarWidth: () => {},
                authState: { authenticated: false },
                authMessage: null,
                accountOpen: false,
                setAccountOpen: () => {},
                startLogin: () => {},
                refreshAuthState: () => {},
                logout: () => {},
                openSettings: () => {},
                settingsOpen: false,
              } as unknown as Parameters<typeof WorkspaceSidebar>[0])}
            />
            {doorOpen ? (
              <ContextRailSlotContext.Provider value={slot}>
                <GlobalSurfaceShell
                  ariaLabel="Backlog"
                  bar={{ title: 'Backlog' }}
                  rail={
                    <button type="button" data-door-rail-row="">
                      An item
                    </button>
                  }
                  onBack={onBack}
                  canGoBack
                >
                  <div>canvas</div>
                </GlobalSurfaceShell>
              </ContextRailSlotContext.Provider>
            ) : null}
          </div>
        )
      }

      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      /** Every navigation column on screen: the projects tree and any rail. */
      const navigationColumns = (): string[] => {
        const columns: string[] = []
        const tree = container.querySelector('nav[role="tree"]')
        if (tree && tree.closest('.hidden') === null) columns.push('projects')
        const rail = container.querySelector('[data-context-rail][data-context-rail-active="true"]')
        if (rail) columns.push('door-rail')
        const inlineAside = container.querySelector('aside[aria-label="Backlog list"]')
        if (inlineAside) columns.push('door-inline-aside')
        return columns
      }

      try {
        let doorOpen = false
        const render = async (): Promise<void> => {
          await act(async () => {
            root.render(<Host doorOpen={doorOpen} onBack={() => {}} />)
          })
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
          })
        }

        await render()
        assert.deepEqual(navigationColumns(), ['projects'], 'closed: the projects rail is the one column')

        doorOpen = true
        await render()
        assert.deepEqual(
          navigationColumns(),
          ['door-rail'],
          'open: the door rail REPLACED the projects rail — never two columns, and never a second aside',
        )
        assert.ok(
          container.querySelector('[data-context-rail] [data-door-rail-row]'),
          "the door's own rail really is inside the host's column",
        )
        // Back moved out of the rail and onto the door's bar (see contextRail.tsx):
        // the exit belongs beside the name of the thing it exits, not below a
        // scrolling column where reaching it means travelling past every row the
        // door brought. Still ONE way out — it just changed ends.
        const railBack = [...container.querySelectorAll('[data-context-rail] button')].find(
          (node) => (node.textContent ?? '').trim() === 'Back',
        )
        assert.equal(railBack, undefined, 'the rail no longer pins a Back row at its bottom')
        assert.ok(
          container.querySelector('button[aria-label="Back"]'),
          "the door's bar carries the one back affordance instead",
        )

        doorOpen = false
        await render()
        assert.deepEqual(navigationColumns(), ['projects'], 'and leaving restores the projects rail in the same column')
        assert.equal(
          container.querySelector('[data-context-rail]'),
          null,
          'with the door column gone rather than left mounted and empty',
        )
      } finally {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    })

    // `process.exitCode` covers the handler above: a rejection outside every
    // `check` leaves `failures` at 0, and printing "ok" beside a non-zero exit is
    // exactly the kind of half-green report this suite exists to prevent.
    if (failures > 0 || process.exitCode) {
      console.error(
        `premiumFeelSeam: ${failures} failing check(s)${process.exitCode ? ' + an unhandled rejection' : ''}`,
      )
      process.exitCode = 1
      return
    }
    console.log('premiumFeelSeam: ok')
  }

  const suiteRun = main()

  await suiteRun
})
