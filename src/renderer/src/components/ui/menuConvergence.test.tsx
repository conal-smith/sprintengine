import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('menuConvergence', async () => {
  // The five menus, rendered and compared against each other.
  //
  // The acceptance this file encodes is a cross-component equality: right-click a
  // row and press its kebab, and the two menus onto the same actions must be
  // indistinguishable. That claim cannot be checked one component at a time, and
  // it cannot be checked from source text either — a host can import the canon and
  // still override it through `surfaceClassName`, or Tailwind can fail to emit a
  // class that only ever appears inside a template literal (see tokens.ts, where
  // two focus-ring constants shipped inert exactly that way).
  //
  // So these assertions read the classes off the MOUNTED surfaces and compare the
  // hosts to one another. `designSystemAxes.test.ts` polices the canon's values;
  // this polices that what reaches the DOM is that canon and nothing else.

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
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.PointerEvent = dom.window.MouseEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0)
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  domWindow.api = { platform: 'darwin' }
  // jsdom implements no layout, so it ships neither of these. Select scrolls its
  // active option into view on open; the surfaces measure themselves to clamp
  // inside the viewport and read 0 for everything, which is fine — this file asks
  // what classes they carry, not where they landed.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView(): void {}
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  domWindow.ResizeObserver = NoopResizeObserver

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // The properties the audit measured as divergent, each expressed as the class
  // that carries it. A menu "agrees" when every host answers all six the same way.
  const SURFACE_AXES = [
    'rounded-md',
    'border-[color:var(--border-strong)]',
    'bg-[color:var(--bg-surface-raised)]',
    'py-1',
  ] as const
  const ITEM_AXES = [
    'text-meta',
    'px-2.5',
    'py-1.5',
    'hover:bg-[color:var(--bg-hover)]',
    // A row that cannot be activated must not paint the "about to be activated"
    // highlight. `:hover` matches a disabled button, so this is a class the row
    // has to carry, not a state CSS gives it for free.
    'disabled:hover:bg-transparent',
    'focus-visible:focus-ring-inset',
  ] as const

  function classesOf(el: Element | null): string[] {
    assert.ok(el, 'element is in the DOM')
    return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  }

  /** The axes a surface or row actually answers, in canonical order. */
  function answered(el: Element | null, axes: readonly string[]): string[] {
    const classes = new Set(classesOf(el))
    return axes.filter((axis) => classes.has(axis))
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { ContextMenu, MenuDivider, MenuItem } = await import('./ContextMenu')
    const { OverflowMenu } = await import('./OverflowMenu')
    const { FilterMenu } = await import('./FilterMenu')
    const { SplitButton } = await import('./SplitButton')
    const { Select } = await import('./Select')

    const document = dom.window.document

    function mount(node: React.ReactNode): { unmount: () => void } {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(node)
      })
      return {
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
      }
    }

    // Every surface portals to <body>, so queries run off the document. A query
    // scoped to the mount point matches nothing and passes vacuously — which is
    // how TerminalLinkMenu's suite sat green-then-red without anyone noticing.
    const surface = () => document.querySelector('[role="menu"], [role="listbox"]')
    const firstRow = () =>
      document.querySelector(
        '[data-menu-item="true"], [data-overflow-item="true"], [data-filter-option="true"], [role="option"]',
      )

    /** Open a Popover-hosted menu by clicking its trigger. */
    function openTrigger(): void {
      const trigger = document.querySelector('button[aria-haspopup="menu"], button[aria-haspopup="listbox"]')
      assert.ok(trigger, 'the host renders a trigger')
      act(() => {
        trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    type Host = { name: string; open: () => { unmount: () => void } }

    const HOSTS: Host[] = [
      {
        name: 'ContextMenu',
        open: () =>
          mount(
            <ContextMenu x={10} y={10} ariaLabel="Row actions" onClose={() => {}}>
              <MenuItem onClick={() => {}}>Rename</MenuItem>
              <MenuDivider />
              <MenuItem onClick={() => {}} variant="danger">
                Delete
              </MenuItem>
            </ContextMenu>,
          ),
      },
      {
        name: 'OverflowMenu',
        open: () => {
          const view = mount(
            <OverflowMenu
              ariaLabel="Row overflow"
              items={[
                { id: 'rename', label: 'Rename', onSelect: () => {} },
                { kind: 'separator', id: 'sep' },
                { id: 'delete', label: 'Delete', onSelect: () => {}, destructive: true },
              ]}
            />,
          )
          openTrigger()
          return view
        },
      },
      {
        name: 'FilterMenu',
        open: () => {
          const view = mount(
            <FilterMenu
              ariaLabel="Filter rows"
              groups={[
                {
                  label: 'Status',
                  items: [
                    { value: 'all', label: 'All' },
                    { value: 'open', label: 'Open' },
                  ],
                  value: 'all',
                  defaultValue: 'all',
                  onChange: () => {},
                },
              ]}
            />,
          )
          openTrigger()
          return view
        },
      },
      {
        name: 'SplitButton',
        open: () => {
          const view = mount(
            <SplitButton
              label="Open"
              primaryAriaLabel="Open in the last-used target"
              menuAriaLabel="Open in…"
              // Two targets, because one is not a split button: handed fewer
              // than two the component draws its primary half alone and opens no
              // menu at all (design-system/components/split-button → Usage).
              items={[
                { id: 'vscode', label: 'VS Code', onSelect: () => {}, checked: true },
                { id: 'zed', label: 'Zed', onSelect: () => {} },
              ]}
              onPrimary={() => {}}
            />,
          )
          openTrigger()
          return view
        },
      },
    ]

    // ── the surface ───────────────────────────────────────────────────────────

    run('every menu draws the same surface', () => {
      const answers = new Map<string, string[]>()
      for (const host of HOSTS) {
        const view = host.open()
        answers.set(host.name, answered(surface(), SURFACE_AXES))
        view.unmount()
      }
      for (const [name, axes] of answers) {
        assert.deepEqual(
          axes,
          [...SURFACE_AXES],
          `${name}'s surface answers ${axes.length}/${SURFACE_AXES.length} of the shared axes — ` +
            'radius, border, ground and vertical-only padding are the four that differed',
        )
      }
    })

    run('every menu row is the same row', () => {
      for (const host of HOSTS) {
        const view = host.open()
        const axes = answered(firstRow(), ITEM_AXES)
        view.unmount()
        assert.deepEqual(
          axes,
          [...ITEM_AXES],
          `${host.name}'s first row answers ${axes.length}/${ITEM_AXES.length} of the shared axes — ` +
            'type size, inset, hover fill and the inset focus ring are what the hosts each decided alone',
        )
      }
    })

    run('no row carries a radius of its own', () => {
      for (const host of HOSTS) {
        const view = host.open()
        const radii = classesOf(firstRow()).filter((cls) => cls.startsWith('rounded'))
        view.unmount()
        assert.deepEqual(
          radii,
          [],
          `${host.name}'s row is inset-rounded; a rounded fill inside a surface reads as a card in a card`,
        )
      }
    })

    run('the divider is one token everywhere it appears', () => {
      for (const name of ['ContextMenu', 'OverflowMenu']) {
        const host = HOSTS.find((candidate) => candidate.name === name)
        assert.ok(host, `${name} is under test`)
        const view = host.open()
        // jsdom ships no types, so annotate: without it every element off this
        // query degrades to `unknown` and nothing below is checked.
        const dividers: Element[] = Array.from(document.querySelectorAll('[role="separator"]'))
        const tokens = dividers.map((divider) => classesOf(divider).filter((cls) => cls.includes('--border')))
        view.unmount()
        assert.ok(dividers.length > 0, `${name} renders its separator`)
        for (const token of tokens) {
          assert.deepEqual(
            token,
            ['bg-[color:var(--border-subtle)]'],
            `${name} draws its divider off the shared token — at border-default it competes with the surface edge`,
          )
        }
      }
    })

    // ── the listbox that is the same object at another role ───────────────────

    run("Select's popup is the same surface, and its rows the same geometry", () => {
      const view = mount(
        <Select
          ariaLabel="Target"
          items={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ]}
          value="a"
          onChange={() => {}}
        />,
      )
      openTrigger()
      const surfaceAxes = answered(surface(), SURFACE_AXES)
      const row = firstRow()
      const rowClasses = new Set(classesOf(row))
      view.unmount()
      assert.deepEqual(
        surfaceAxes,
        [...SURFACE_AXES],
        "Select's popup is an overlay surface like every other menu (design-system/components/select)",
      )
      for (const shared of ['px-2.5', 'py-1.5', 'hover:bg-[color:var(--bg-hover)]']) {
        assert.ok(rowClasses.has(shared), `a Select option shares the menu row's ${shared}`)
      }
      // The one ruled difference, asserted so it stays a decision rather than
      // becoming drift again: the popup echoes strings the trigger is already
      // showing at `body`, and picking a value must not resize it.
      assert.ok(rowClasses.has('text-body'), 'a Select option matches its own trigger, not the menu')
      assert.ok(!rowClasses.has('text-meta'), 'and it does not also carry the menu size')
    })

    if (failures > 0) {
      console.error(`\nmenuConvergence.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('menu convergence: all checks passed')
  }

  const suiteRun = main()

  await suiteRun
})
