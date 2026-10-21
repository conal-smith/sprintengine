import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('CliModelPicker', async () => {
  // The runtime pickers are two controls now — a model popover with a provider
  // rail, and a reasoning selector carrying effort and context window — and
  // almost everything that matters about them is behaviour no markup snapshot can
  // reach: opening a surface, typing into search, a chord selecting the row it
  // advertises, a star surviving a restart. So this suite stands up a real DOM and
  // drives them the way a person does, and falls back to pure functions only for
  // the catalog reading underneath.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  ;(dom.window as unknown as Record<string, unknown>).ResizeObserver = NoopResizeObserver

  let failures = 0
  function run(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        console.log(`ok - ${name}`)
      })
      .catch((error) => {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      })
  }

  // claude-code's real manifest shape: a model shipped at two context windows
  // (`claude-opus-5` / `claude-opus-5[1m]`), a floating alias the catalog only
  // ships suffixed, a model with no window axis at all, and five effort levels
  // with NO declared default.
  const CLAUDE_MODELS = [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
    { id: 'opus[1m]', label: 'Opus (latest, 1M context)' },
    { id: 'claude-fable-5', label: 'Fable 5' },
  ]
  const CLAUDE_LEVELS = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
  ]
  // Codex: a declared default, a costlier top level, and no window axis anywhere.
  const CODEX_LEVELS = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'ultra', label: 'Ultra' },
  ]

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { CliModelPopoverSurface, CliModelPickerButton, buildModelRows } = await import('./CliModelPicker')
    const { ReasoningSelector, reasoningTriggerLabel, hasReasoningAxes } = await import('./ReasoningSelector')
    const { buildModelFamilies, familyForModel, meaningfulModelId, parseModelWindow } =
      await import('./cliRuntimeCatalog')
    const { __resetModelFavouritesForTest, modelFavouriteKey } = await import('./modelFavourites')

    type SurfaceProps = Parameters<typeof CliModelPopoverSurface>[0]

    const OPTIONS: SurfaceProps['options'] = [
      {
        value: 'claude-code' as SurfaceProps['currentCli'],
        label: 'Claude Code',
        modelSelection: { options: CLAUDE_MODELS, allowCustomId: true },
        reasoningSelection: { levels: CLAUDE_LEVELS },
      },
      {
        value: 'codex' as SurfaceProps['currentCli'],
        label: 'Codex',
        modelSelection: {
          options: [
            { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
            { id: 'gpt-5.5', label: 'GPT-5.5' },
          ],
          allowCustomId: true,
        },
        reasoningSelection: { levels: CODEX_LEVELS, default: 'medium' },
      },
    ]

    type Mounted = {
      container: HTMLElement
      rows: () => HTMLElement[]
      tabs: () => HTMLButtonElement[]
      search: () => HTMLInputElement
      menuItems: () => HTMLButtonElement[]
      slider: () => HTMLElement | undefined
      sliderValue: () => string | undefined
      click: (element: Element | undefined | null) => Promise<void>
      key: (element: Element | undefined | null, key: string, init?: KeyboardEventInit) => Promise<void>
      type: (value: string) => Promise<void>
      unmount: () => void
    }

    const mounted: Array<() => void> = []

    function mountElement(element: React.ReactElement): Mounted {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(element)
      })
      // Popover surfaces are portaled to <body>, so queries run from there.
      const query = <T extends Element>(selector: string): T[] =>
        [...dom.window.document.body.querySelectorAll(selector)] as unknown as T[]
      const view: Mounted = {
        container,
        rows: () => query<HTMLElement>('[data-model-row="true"]'),
        tabs: () => query<HTMLButtonElement>('[role="radio"]'),
        search: () => query<HTMLInputElement>('input[type="search"]')[0]!,
        menuItems: () => query<HTMLButtonElement>('[data-reasoning-option="true"]'),
        // The effort ramp is one control, not a row per level: it is read by its
        // value line and its aria-valuetext, and driven with the arrow keys.
        slider: () => query<HTMLElement>('[data-slider="true"]')[0],
        sliderValue: () => query<HTMLElement>('[data-reasoning-value="true"]')[0]?.textContent ?? undefined,
        click: async (element) => {
          assert.ok(element, 'element to click exists')
          await act(async () => {
            element!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
          })
        },
        key: async (element, key, init) => {
          assert.ok(element, 'element to key exists')
          await act(async () => {
            element!.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
            )
          })
        },
        type: async (value) => {
          const input = view.search()
          await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
            setter?.call(input, value)
            input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
          })
        },
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
      }
      mounted.push(view.unmount)
      return view
    }

    function mountSurface(overrides: Partial<SurfaceProps>): Mounted {
      __resetModelFavouritesForTest()
      const props = {
        ariaLabel: 'Agent runtime',
        options: OPTIONS,
        currentCli: 'claude-code',
        effectiveModelFor: () => 'claude-opus-5',
        onSelectCli: () => {},
        onSelectModel: () => {},
        ...overrides,
      } as unknown as SurfaceProps
      return mountElement(React.createElement(CliModelPopoverSurface, props))
    }

    // ---- Catalog reading -----------------------------------------------------

    await run('a bracketed suffix is the context window, not part of the model name', () => {
      assert.deepEqual(parseModelWindow('claude-opus-5[1m]'), { baseId: 'claude-opus-5', window: '1m' })
      assert.deepEqual(parseModelWindow('gpt-5.5'), { baseId: 'gpt-5.5' })
    })

    await run('window variants of one model collapse into one family, base first', () => {
      const families = buildModelFamilies(CLAUDE_MODELS)
      assert.deepEqual(
        families.map((family) => family.defaultId),
        ['claude-opus-5', 'opus[1m]', 'claude-fable-5'],
        'three rows, not four — the 1M sibling folded into Opus 5',
      )
      const opus = families[0]!
      assert.equal(opus.label, 'Opus 5', 'the family takes the un-suffixed entry’s name')
      assert.deepEqual(
        opus.variants.map((variant) => [variant.id, variant.label, variant.base]),
        [
          ['claude-opus-5', 'Standard', true],
          ['claude-opus-5[1m]', '1M', false],
        ],
        'both windows, the CLI’s own first',
      )
      assert.equal(families[1]!.variants.length, 1, 'a catalog ships `opus[1m]` alone — no window axis')
      assert.equal(families[1]!.label, 'Opus (latest, 1M context)', 'and it keeps its own name')
      assert.equal(families[2]!.variants.length, 1, 'Fable ships at one window')
    })

    await run('a model id resolves back to its family through any of its windows', () => {
      const families = buildModelFamilies(CLAUDE_MODELS)
      assert.equal(familyForModel(families, 'claude-opus-5[1m]')?.defaultId, 'claude-opus-5')
      assert.equal(familyForModel(families, 'gone-from-the-catalog'), undefined)
    })

    await run('the raw id shows only when the label does not already spell it', () => {
      assert.equal(meaningfulModelId('opus[1m]', 'Opus'), 'opus[1m]')
      assert.equal(meaningfulModelId('gpt-5.5', 'GPT-5.5'), undefined)
      assert.equal(meaningfulModelId('opus[1m]', undefined), undefined)
    })

    await run('every runtime is one row, the CLI’s own default leading its models', () => {
      const rows = buildModelRows(OPTIONS, 'claude-code' as SurfaceProps['currentCli'], () => 'claude-opus-5')
      assert.deepEqual(
        rows.filter((row) => row.cli === 'claude-code').map((row) => row.name),
        ['Claude Code', 'Opus 5', 'Opus (latest, 1M context)', 'Fable 5'],
      )
      assert.equal(rows[0]!.model, null, 'the CLI row passes no model flag')
    })

    await run('a persisted model the catalog dropped still gets its own row, marked', () => {
      const rows = buildModelRows(OPTIONS, 'claude-code' as SurfaceProps['currentCli'], () => 'claude-retired-9')
      const stale = rows.find((row) => row.name === 'claude-retired-9')
      assert.ok(stale, 'the active model is still listed')
      assert.equal(stale!.note, 'Not listed')
      assert.equal(stale!.mono, true, 'and reads as the raw id it is')
    })

    await run('"New" follows the merged row, and a window variant lends it to its family', () => {
      // The merge marks a row new from its per-machine `firstSeenAt`; the picker
      // only reads the mark. Here the 1M variant is the new one, so the Opus 5
      // row it folds into carries the chip, and nothing else does.
      const merged = [
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)', isNew: true },
        { id: 'sonnet', label: 'Sonnet' },
      ]
      const options: SurfaceProps['options'] = [
        {
          value: 'claude-code' as SurfaceProps['currentCli'],
          label: 'Claude Code',
          modelSelection: { options: merged, allowCustomId: true },
        },
      ]
      const rows = buildModelRows(options, 'claude-code' as SurfaceProps['currentCli'], () => undefined)
      assert.deepEqual(
        rows.map((row) => [row.name, row.isNew === true]),
        [
          ['Claude Code', false],
          ['Opus 5', true],
          ['Sonnet', false],
        ],
      )
    })

    // ---- The model popover ---------------------------------------------------

    await run('the rail carries one entry per installed CLI and filters the list', async () => {
      const view = mountSurface({})
      const tabs = view.tabs()
      assert.deepEqual(
        tabs.map((tab) => tab.getAttribute('aria-label')),
        ['Claude Code', 'Codex'],
        'no ★ entry until something is starred',
      )
      assert.equal(tabs[0]!.getAttribute('aria-checked'), 'true', 'the current CLI’s rail entry is selected')
      assert.equal(view.rows().length, 4, 'Claude Code’s own row plus its three models')
      await view.click(tabs[1])
      assert.equal(view.rows().length, 3, 'Codex’s own row plus its two models')
      view.unmount()
    })

    await run('permissions follow the highlighted model across providers, keyboard navigation and search', async () => {
      const view = mountSurface({
        effectiveModelFor: (cli) => (cli === 'claude-code' ? 'claude-opus-5[1m]' : undefined),
        permissions: (cli, model) =>
          React.createElement('span', { 'data-permission-target': true }, `${cli}:${model ?? 'default'}`),
      })
      const target = () => view.container.querySelector('[data-permission-target]')?.textContent
      assert.equal(target(), 'claude-code:claude-opus-5[1m]', 'the selected context-window variant is preserved')
      await view.click(view.tabs()[1])
      assert.equal(target(), 'codex:default', 'the new provider’s first row owns the control')
      await view.key(view.search(), 'ArrowDown')
      assert.equal(target(), 'codex:gpt-5.6-sol', 'keyboard highlight moves the permission target')
      await view.type('fable')
      assert.equal(target(), 'claude-code:claude-fable-5', 'search can move it back across providers')
      await view.type('no-such-model')
      assert.equal(target(), undefined, 'an empty result list exposes no stale model’s permissions')
      view.unmount()
    })

    await run('search reaches across providers, suspending the rail filter', async () => {
      const view = mountSurface({})
      await view.type('gpt')
      const names = view.rows().map((row) => row.textContent ?? '')
      assert.equal(names.length, 2, 'both Codex models matched from the Claude rail')
      assert.ok(names.every((name) => name.includes('GPT')))
      assert.ok(
        view.tabs().every((tab) => tab.getAttribute('aria-checked') === 'false'),
        'and no rail entry claims to be filtering while a query is live',
      )
      view.unmount()
    })

    await run('a row names its provider only when the list spans more than one', async () => {
      const view = mountSurface({})
      const opus = () => view.rows()[1]!.textContent ?? ''
      assert.equal(
        opus(),
        'Opus 5claude-opus-5Ctrl+2',
        'under a rail filter the rail already said the provider, so the row does not repeat it',
      )
      assert.equal(
        view.rows()[0]!.textContent,
        'Claude CodeCtrl+1',
        'and the CLI’s own row never restates its own name underneath itself',
      )
      await view.type('opus')
      assert.match(
        view.rows()[0]!.textContent ?? '',
        /Claude Code · /,
        'a search spanning providers earns the provider line back',
      )
      view.unmount()
    })

    await run('search that matches nothing says so rather than rendering an empty list', async () => {
      const view = mountSurface({})
      await view.type('zzzz')
      assert.equal(view.rows().length, 0)
      assert.match(view.container.textContent ?? '', /No models match/)
      view.unmount()
    })

    await run('⌘2 selects the second visible row of the current filter', async () => {
      const picked: Array<[string, string | null]> = []
      const view = mountSurface({ onSelectModel: (cli, model) => picked.push([cli, model]) })
      await view.key(view.search(), '2', { metaKey: true })
      assert.deepEqual(picked, [['claude-code', 'claude-opus-5']], 'row two is Opus 5, and the chord took it')

      // The chord follows the filter, not the catalog: row two after a search is
      // whatever row two now IS.
      picked.length = 0
      await view.type('gpt')
      await view.key(view.search(), '2', { metaKey: true })
      assert.deepEqual(picked, [['codex', 'gpt-5.5']])
      view.unmount()
    })

    // ---- The keyboard model -------------------------------
    //
    // This list used to move real DOM focus onto the row, so the first arrow took
    // focus off the search field and everything typed after it went nowhere. The
    // ruling is `aria-activedescendant`: the field is the combobox and keeps
    // focus, the highlight is named rather than focused.

    await run('arrows move the highlight and leave focus in the search field', async () => {
      const view = mountSurface({})
      const search = view.search()
      const rows = view.rows()
      assert.equal(search.getAttribute('role'), 'combobox', 'the field is the combobox, not the list')
      assert.equal(search.getAttribute('aria-expanded'), 'true', 'and its list is rendered for as long as it is')
      assert.deepEqual(
        rows.map((row) => row.getAttribute('tabindex')),
        [null, null, null, null],
        'no row is a tab stop any more — focus never leaves the field',
      )
      assert.equal(
        search.getAttribute('aria-activedescendant'),
        rows[1]!.id,
        'the highlight opens on the current runtime rather than at the top of the list',
      )
      await view.key(search, 'ArrowDown')
      assert.equal(search.getAttribute('aria-activedescendant'), rows[2]!.id, 'arrows move the highlight')
      assert.equal(dom.window.document.activeElement, search, 'and the field still holds focus')
      await view.key(search, 'ArrowUp')
      assert.equal(search.getAttribute('aria-activedescendant'), rows[1]!.id)

      const tabs = view.tabs()
      assert.deepEqual(
        tabs.map((tab) => tab.getAttribute('tabindex')),
        ['0', '-1'],
        'the rail is one tab stop, as a tablist is',
      )
      await view.key(tabs[0], 'ArrowDown')
      assert.equal(dom.window.document.activeElement, tabs[1], 'arrows rove inside the rail')
      view.unmount()
    })

    await run('a key the field consumes never reaches the host around it', async () => {
      // Two hosts of this surface are MENUS (a row's right-click picker and
      // its MenuFlyoutItem), and a menu answers ArrowUp/Down/Home/End by moving
      // real focus onto one of ITS OWN items. A bubbling arrow would take focus
      // off the field on the first press — the exact failure the ruling ends.
      const view = mountSurface({})
      const escaped: string[] = []
      // On `body`, not on the mount container: React attaches its own delegated
      // listener to the root container, and `stopPropagation` there does not stop
      // a sibling listener on that same node. The host that matters sits ABOVE it.
      const listener = (event: Event): void => {
        escaped.push((event as KeyboardEvent).key)
      }
      dom.window.document.body.addEventListener('keydown', listener)
      const search = view.search()
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) await view.key(search, key)
      assert.deepEqual(escaped, [], 'every key the combobox handled stopped at the field')
      await view.key(search, 'Escape')
      assert.deepEqual(escaped, ['Escape'], 'Escape still travels — the surface closes from anywhere inside it')
      dom.window.document.body.removeEventListener('keydown', listener)
      view.unmount()
    })

    await run('narrowing and walking happen in one motion, which is what the ruling buys', async () => {
      const picked: Array<[string, string | null]> = []
      const view = mountSurface({ onSelectModel: (cli, model) => picked.push([cli, model]) })
      const search = view.search()
      await view.type('gpt')
      await view.key(search, 'ArrowDown')
      assert.equal(
        search.getAttribute('aria-activedescendant'),
        view.rows()[1]!.id,
        'the arrow walked the results the query just produced',
      )
      assert.equal(dom.window.document.activeElement, search, 'without the query field losing focus')
      await view.key(search, 'Enter', { isComposing: true })
      assert.deepEqual(picked, [], 'the Enter that commits an input method’s word picks nothing')
      await view.key(search, 'Enter')
      assert.deepEqual(picked, [['codex', 'gpt-5.5']], 'and Enter took the highlighted row')
      view.unmount()
    })

    await run('Home and End belong to the caret while a query is live', async () => {
      const view = mountSurface({})
      const search = view.search()
      await view.key(search, 'End')
      assert.equal(
        search.getAttribute('aria-activedescendant'),
        view.rows()[3]!.id,
        'with nothing typed there is no caret to serve, so End jumps the list',
      )
      await view.type('opus')
      const highlighted = search.getAttribute('aria-activedescendant')
      await view.key(search, 'End')
      assert.equal(
        search.getAttribute('aria-activedescendant'),
        highlighted,
        'but with text in the field they move the caret — a filter you cannot reach the end of is worse',
      )
      view.unmount()
    })

    await run('ArrowRight reaches the star, so the hover-revealed mark has a keyboard path', async () => {
      const view = mountSurface({})
      const search = view.search()
      const row = view.rows()[1]!
      assert.equal(row.getAttribute('data-active'), 'true', 'the highlighted row is the one ArrowRight acts on')
      await view.key(search, 'ArrowRight')
      const star = row.querySelector<HTMLButtonElement>('[data-model-star="true"]')
      assert.equal(dom.window.document.activeElement, star, 'focus landed on the highlighted row’s star')
      await view.key(star, 'ArrowLeft')
      assert.equal(dom.window.document.activeElement, search, 'and ArrowLeft hands focus back to the field')
      view.unmount()
    })

    await run('choosing a row selects the CLI and the model in one action', async () => {
      const picked: Array<[string, string | null]> = []
      const view = mountSurface({ onSelectModel: (cli, model) => picked.push([cli, model]) })
      await view.click(view.tabs()[1])
      await view.click(view.rows()[1])
      assert.deepEqual(picked, [['codex', 'gpt-5.6-sol']], 'the row carried its own CLI with it')
      view.unmount()
    })

    await run('re-choosing the selected family keeps the context window already picked', async () => {
      const picked: Array<[string, string | null]> = []
      const view = mountSurface({
        effectiveModelFor: () => 'claude-opus-5[1m]',
        onSelectModel: (cli, model) => picked.push([cli, model]),
      })
      const opusRow = view.rows()[1]!
      assert.equal(opusRow.getAttribute('aria-selected'), 'true', 'the 1M window selects its family’s row')
      await view.click(opusRow)
      assert.deepEqual(picked, [['claude-code', 'claude-opus-5[1m]']], 'the window survived the re-pick')
      view.unmount()
    })

    await run('a starred model survives a restart and populates the ★ rail section', async () => {
      dom.window.localStorage.clear()
      const first = mountSurface({})
      assert.equal(first.tabs().length, 2, 'no ★ entry yet')
      const fableRow = first.rows()[3]!
      await first.click(fableRow.querySelector('[data-model-star="true"]'))
      assert.deepEqual(
        first.tabs().map((tab) => tab.getAttribute('aria-label')),
        ['Starred', 'Claude Code', 'Codex'],
        'the ★ section appeared as soon as something earned it',
      )
      first.unmount()

      // The restart: a fresh module cache reading the same localStorage.
      const stored = dom.window.localStorage.getItem('sprintengine.model-favourites')
      assert.equal(stored, JSON.stringify([modelFavouriteKey('claude-code', 'claude-fable-5')]))
      __resetModelFavouritesForTest()
      const second = mountElement(
        React.createElement(CliModelPopoverSurface, {
          ariaLabel: 'Agent runtime',
          options: OPTIONS,
          currentCli: 'claude-code',
          effectiveModelFor: () => 'claude-opus-5',
          onSelectCli: () => {},
          onSelectModel: () => {},
        } as unknown as SurfaceProps),
      )
      const starTab = second.tabs()[0]!
      assert.equal(starTab.getAttribute('aria-label'), 'Starred', 'the star outlived the mount')
      await second.click(starTab)
      assert.deepEqual(
        second.rows().map((row) => row.querySelector('[data-model-star="true"]')?.getAttribute('aria-pressed')),
        ['true'],
        'and the ★ filter shows exactly the starred row',
      )
      second.unmount()
      dom.window.localStorage.clear()
    })

    // ── Legacy stars ────────────────────────────────────────────────────────

    await run('a model+role star saved by an older build is never shown', async () => {
      dom.window.localStorage.setItem(
        'sprintengine.model-favourites',
        JSON.stringify([`${modelFavouriteKey('claude-code', 'claude-fable-5')}:role:architect`]),
      )
      __resetModelFavouritesForTest()
      const view = mountSurface({})
      assert.deepEqual(
        view.tabs().map((tab) => tab.getAttribute('aria-label')),
        ['Claude Code', 'Codex'],
        'the legacy composition does not surface a ★ entry',
      )
      view.unmount()
      dom.window.localStorage.clear()
      __resetModelFavouritesForTest()
    })

    await run('unstarring the last favourite from the ★ filter does not strand the list', async () => {
      dom.window.localStorage.clear()
      const view = mountSurface({})
      await view.click(view.rows()[3]!.querySelector('[data-model-star="true"]'))
      await view.click(view.tabs()[0])
      assert.equal(view.rows().length, 1, 'the ★ filter is showing the one starred row')

      await view.click(view.rows()[0]!.querySelector('[data-model-star="true"]'))
      assert.deepEqual(
        view.tabs().map((tab) => tab.getAttribute('aria-label')),
        ['Claude Code', 'Codex'],
        'the ★ entry retired with the last star',
      )
      assert.equal(view.tabs()[0]!.getAttribute('aria-checked'), 'true', 'and the rail fell back to the current CLI')
      assert.equal(view.rows().length, 4, 'rather than leaving an empty list under a rail selecting nothing')
      assert.ok(
        view.tabs().some((tab) => tab.getAttribute('tabindex') === '0'),
        'so the rail is still reachable by Tab',
      )
      view.unmount()
      dom.window.localStorage.clear()
    })

    // ---- The reasoning selector ---------------------------------------------

    await run('the trigger composes level and window', () => {
      const families = buildModelFamilies(CLAUDE_MODELS)
      const opus = familyForModel(families, 'claude-opus-5[1m]')
      assert.equal(
        reasoningTriggerLabel({
          reasoningSelection: { levels: CLAUDE_LEVELS },
          family: opus,
          reasoningEnabled: true,
          reasoning: 'high',
          model: 'claude-opus-5[1m]',
        }),
        'High · 1M',
      )
      assert.equal(
        reasoningTriggerLabel({
          reasoningSelection: { levels: CLAUDE_LEVELS },
          family: opus,
          reasoningEnabled: true,
          model: 'claude-opus-5',
        }),
        'Auto · Standard',
        'no stored level passes no flag, and the trigger says so rather than naming a level it did not pick',
      )
      assert.equal(
        reasoningTriggerLabel({
          reasoningSelection: { levels: CLAUDE_LEVELS },
          family: familyForModel(families, 'claude-fable-5'),
          reasoningEnabled: false,
          model: 'claude-fable-5',
        }),
        '',
        'a host that persists neither axis has nothing to compose',
      )
    })

    await run('a runtime with no axis at all renders no control', () => {
      assert.equal(hasReasoningAxes({ reasoningEnabled: false }), false)
      const view = mountElement(
        React.createElement(ReasoningSelector, {
          ariaLabel: 'Reasoning',
          onSelectModel: () => {},
        } as unknown as Parameters<typeof ReasoningSelector>[0]),
      )
      assert.equal(view.container.querySelector('[data-reasoning-trigger="true"]'), null)
      view.unmount()
    })

    await run('the Context window group renders only for a model that offers the axis', async () => {
      const families = buildModelFamilies(CLAUDE_MODELS)
      const openMenu = async (family: ReturnType<typeof familyForModel>, model: string) => {
        const view = mountElement(
          React.createElement(ReasoningSelector, {
            ariaLabel: 'Reasoning',
            reasoningSelection: { levels: CLAUDE_LEVELS },
            reasoning: 'high',
            onSelectReasoning: () => {},
            family,
            model,
            onSelectModel: () => {},
          } as unknown as Parameters<typeof ReasoningSelector>[0]),
        )
        await view.click(view.container.querySelector('[data-reasoning-trigger="true"]'))
        return view
      }

      const withWindows = await openMenu(familyForModel(families, 'claude-opus-5'), 'claude-opus-5')
      const groups = [...dom.window.document.body.querySelectorAll('[role="group"]')]
      assert.deepEqual(
        groups.map((group) => group.getAttribute('aria-label')),
        ['Reasoning', 'Context window'],
        'two groups, so the headings are earned',
      )
      // Effort is a ramp and rides the slider; the windows stay a list, because
      // two windows a model happens to ship at are not ordered by cost.
      assert.equal(
        withWindows.slider()?.getAttribute('aria-valuemax'),
        String(CLAUDE_LEVELS.length),
        'every declared level is a stop, with Auto leading the ramp',
      )
      assert.deepEqual(
        withWindows.menuItems().map((item) => item.textContent),
        ['StandardDefault', '1M'],
        'both windows are offered, the base one carrying the neutral Default chip',
      )
      withWindows.unmount()

      const noWindows = await openMenu(familyForModel(families, 'claude-fable-5'), 'claude-fable-5')
      assert.deepEqual(
        [...dom.window.document.body.querySelectorAll('[role="group"]')].map((group) =>
          group.getAttribute('aria-label'),
        ),
        [null],
        'one group is its own label — a heading must separate something from something else',
      )
      assert.ok(
        !noWindows.menuItems().some((item) => item.textContent === '1M'),
        'and no window options are offered for a model that ships at one window',
      )
      noWindows.unmount()
    })

    await run('the catalog’s declared default is chipped on the stop the ramp is resting on', async () => {
      const open = async (reasoning?: string) => {
        const view = mountElement(
          React.createElement(ReasoningSelector, {
            ariaLabel: 'Reasoning',
            reasoningSelection: { levels: CODEX_LEVELS, default: 'medium' },
            reasoning,
            onSelectReasoning: () => {},
            onSelectModel: () => {},
          } as unknown as Parameters<typeof ReasoningSelector>[0]),
        )
        await view.click(view.container.querySelector('[data-reasoning-trigger="true"]'))
        return view
      }
      // A slider names one stop at a time, so the chip travels with the value
      // line rather than sitting on a row of its own.
      const onDefault = await open('medium')
      assert.equal(onDefault.sliderValue(), 'MediumDefault')
      onDefault.unmount()

      const elsewhere = await open('high')
      assert.equal(elsewhere.sliderValue(), 'High', 'and no other stop wears it')
      elsewhere.unmount()

      const unset = await open()
      assert.equal(unset.sliderValue(), 'Auto', 'Auto is the runtime’s choice, not the catalog’s default')
      unset.unmount()
    })

    await run('the ramp walks the levels, and its leading stop clears back to the CLI’s own effort', async () => {
      const picked: Array<string | null> = []
      const open = async (reasoning?: string) => {
        const view = mountElement(
          React.createElement(ReasoningSelector, {
            ariaLabel: 'Reasoning',
            reasoningSelection: { levels: CODEX_LEVELS, default: 'medium' },
            reasoning,
            onSelectReasoning: (next: string | null) => picked.push(next),
            onSelectModel: () => {},
          } as unknown as Parameters<typeof ReasoningSelector>[0]),
        )
        await view.click(view.container.querySelector('[data-reasoning-trigger="true"]'))
        return view
      }

      // 'ultra' is the last of CODEX_LEVELS, so the ramp is at its far end and one
      // step down is the level before it.
      const view = await open('ultra')
      assert.equal(view.slider()?.getAttribute('aria-valuetext'), 'Ultra')
      await view.key(view.slider(), 'ArrowLeft')
      assert.deepEqual(picked, [CODEX_LEVELS[CODEX_LEVELS.length - 2]!.id])
      view.unmount()

      picked.length = 0
      const second = await open('high')
      await second.key(second.slider(), 'Home')
      assert.deepEqual(picked, [null], 'the leading stop is the explicit way back to blank')
      second.unmount()

      // A ramp has ends. Walking off the cheap end from Auto writes nothing, so a
      // held arrow key cannot roll round to the costliest level.
      picked.length = 0
      const third = await open()
      await third.key(third.slider(), 'ArrowLeft')
      assert.deepEqual(picked, [], 'neither end wraps')
      third.unmount()
    })

    await run('picking a context window selects that window’s catalog id', async () => {
      const families = buildModelFamilies(CLAUDE_MODELS)
      const picked: string[] = []
      const view = mountElement(
        React.createElement(ReasoningSelector, {
          ariaLabel: 'Reasoning',
          family: familyForModel(families, 'claude-opus-5'),
          model: 'claude-opus-5',
          onSelectModel: (next: string) => picked.push(next),
        } as unknown as Parameters<typeof ReasoningSelector>[0]),
      )
      await view.click(view.container.querySelector('[data-reasoning-trigger="true"]'))
      await view.click(view.menuItems().find((item) => item.textContent === '1M'))
      assert.deepEqual(picked, ['claude-opus-5[1m]'], 'the window axis writes a model id, not a level')
      view.unmount()
    })

    // ---- The one control as a host embeds it ---------------------------------

    await run('the model trigger shows the provider glyph and the model name', async () => {
      __resetModelFavouritesForTest()
      const view = mountElement(
        React.createElement(CliModelPickerButton, {
          ariaLabel: 'Agent runtime',
          options: OPTIONS,
          cli: 'claude-code',
          effectiveModelFor: () => 'claude-opus-5[1m]',
          effectiveReasoningFor: () => 'high',
          onSelectReasoning: () => {},
          onSelectCli: () => {},
          onSelectModel: () => {},
        } as unknown as Parameters<typeof CliModelPickerButton>[0]),
      )
      const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup]')!
      assert.equal(trigger.textContent, 'Opus 5', 'the name only — the glyph already says which provider')
      assert.ok(trigger.querySelector('svg'), 'and the brand glyph is drawn, not a monogram')
      assert.match(
        trigger.getAttribute('aria-label') ?? '',
        /Claude Code · Opus 5 · High · 1M/,
        'the accessible name still carries the whole runtime',
      )

      // A runtime is ONE control: the axes are inside the picker, not a second
      // pill beside it. The trigger's accessible name still carries them, which is
      // what keeps them findable without opening the surface.
      assert.equal(
        view.container.querySelector('[data-reasoning-trigger="true"]'),
        null,
        'no reasoning trigger sits beside the model trigger',
      )
      view.unmount()
    })

    await run('opening the model popover focuses search, and Escape restores the trigger', async () => {
      __resetModelFavouritesForTest()
      const view = mountElement(
        React.createElement(CliModelPickerButton, {
          ariaLabel: 'Agent runtime',
          options: OPTIONS,
          cli: 'claude-code',
          effectiveModelFor: () => 'claude-opus-5',
          onSelectCli: () => {},
          onSelectModel: () => {},
        } as unknown as Parameters<typeof CliModelPickerButton>[0]),
      )
      const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup]')!
      await view.click(trigger)
      assert.equal(dom.window.document.activeElement, view.search(), 'search takes focus on open')
      await act(async () => {
        // Through the focused element, as a real keypress travels — the popover's
        // Escape listener sits on document (so it beats window-level dialog
        // handlers), and an event dispatched directly on window never reaches it.
        ;(dom.window.document.activeElement ?? dom.window.document.body).dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      assert.equal(dom.window.document.body.querySelector('input[type="search"]'), null, 'Escape closed the surface')
      assert.equal(dom.window.document.activeElement, trigger, 'Escape hands focus back to the trigger')
      view.unmount()
    })

    for (const unmount of mounted) {
      try {
        unmount()
      } catch {
        // already unmounted by its own test
      }
    }

    if (failures > 0) {
      console.error(`CliModelPicker.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('CliModelPicker.test.tsx: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
