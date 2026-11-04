import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('designSystemConformance', async () => {
  // Seam test for the design-system conformance epic (T15).
  //
  // The twelve fix tasks each emptied their own baseline in isolation. The guard
  // proves no rule fires anywhere; it cannot prove the fixes still hold when the
  // two primitives that carry most of the product are composed. This suite mounts
  // a selected `InboxRow` inside a `Tabs` strip — one tree, one render — and
  // asserts the four contracts those tasks landed:
  //
  //   T4   selection is a neutral `--bg-selected` fill plus a 2px inset
  //        `--selection-edge` ring, the title sits at `--text-strong`, and
  //        neither an accent fill nor a left bar survives anywhere in the row.
  //   T18  the ink lift is a real step: an unselected title sits at
  //        `--text-default`. The resting tier itself is a cascade behaviour
  //        (`data-selection-pane` + `:focus-within`) and is measured in the built
  //        app, not here — jsdom loads no stylesheet, so it can only read class
  //        names.
  //   T5   every tab carries the shared `:focus-visible` indicator;
  //        `focus:outline-none` is never left undischarged, and a bare `:focus`
  //        ring does not count. T18 made that indicator an offset outline behind
  //        one `focus-ring` utility, so the class a tab must carry is the utility
  //        reference, not a width and a colour spelled out per control.
  //   T11  the active tab is marked by an accent hairline underline plus an ink
  //        lift — never by an accent fill on the control itself.
  //   T10  row padding resolves to steps on the `sem.space` 2px grid.
  //
  // Assertions read the mounted elements, not the source files: a contract that
  // only holds in the file that declares it is not a contract the composed tree
  // keeps.
  //
  // Two later items extend the suite on the same terms:
  //
  //   2003/2005  the Design door's canvas and create screen (mounted, below).
  //   focus trap   the modal focus trap, mounted; and the one z ladder, which is
  //              the suite's single source-read rule — the overlay shells it
  //              polices are whole app screens that cannot be mounted here, and
  //              the rule is about the literal a developer types.

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
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

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

  /* ------------------------------------------------------------------ *
   * Class-list helpers
   * ------------------------------------------------------------------ */

  function classesOf(element: Element | null | undefined): string[] {
    assert.ok(element, 'expected the element to exist before reading its classes')
    return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  }

  function hasClassMatching(element: Element | null | undefined, pattern: RegExp): boolean {
    return classesOf(element).some((token) => pattern.test(token))
  }

  // Every element in the subtree, the root included.
  function subtree(root: Element): Element[] {
    return [root, ...(Array.from(root.querySelectorAll('*')) as Element[])]
  }

  // `sem.space.*` — the 2px grid the system declares. `lint-design-system-conformance.mjs`
  // only rejects odd arbitrary pixel values; this list is the tighter statement of
  // the same clause, and it is what the row is held to.
  const SPACE_SCALE_PX = new Set([0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32])

  const PADDING_UTILITY = /^-?(p|px|py|pt|pr|pb|pl)-(.+)$/

  // Resolve a Tailwind spacing token to pixels: the numeric scale is 4px per
  // step (`3` → 12px, `0.5` → 2px), and the arbitrary form carries its own unit.
  function spacingPx(value: string): number | null {
    const arbitrary = value.match(/^\[(-?\d+(?:\.\d+)?)px\]$/)
    if (arbitrary) return Math.abs(Number(arbitrary[1]))
    const arbitraryRem = value.match(/^\[(-?\d+(?:\.\d+)?)rem\]$/)
    if (arbitraryRem) return Math.abs(Number(arbitraryRem[1]) * 16)
    // `px` is deliberately not a spacing step. It is the hairline unit — the same
    // 1px the system spends on borders and the active-tab underline — and the tab
    // strip legitimately uses `-mb-px` to pull itself over the container's border
    // so the two hairlines meet. Resolving it here would fail correct code.
    if (!/^\d+(?:\.\d+)?$/.test(value)) return null
    return Number(value) * 4
  }

  function paddingSteps(element: Element): { token: string; px: number }[] {
    const steps: { token: string; px: number }[] = []
    for (const token of classesOf(element)) {
      const match = token.match(PADDING_UTILITY)
      if (!match) continue
      const px = spacingPx(match[2])
      assert.ok(
        px !== null,
        `padding utility \`${token}\` on the row does not resolve to a pixel value, ` +
          'so it cannot be checked against the 2px grid',
      )
      steps.push({ token, px: px as number })
    }
    return steps
  }

  /* ------------------------------------------------------------------ *
   * Suite
   * ------------------------------------------------------------------ */

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { InboxRow } = await import('./InboxRow')
    const { Tabs, TabPanel } = await import('./Tabs')

    const TABS = [
      { id: 'inbox', label: 'Inbox', count: 2 },
      { id: 'archive', label: 'Archive' },
    ]

    // One tree: the tab strip above, a selected row and an unselected sibling
    // below it. The unselected row and tab are load-bearing — a contract asserted
    // only on the selected element cannot tell "neutral selection" apart from
    // "every row looks the same".
    function Surface(): React.ReactElement {
      return React.createElement(
        'div',
        null,
        React.createElement(Tabs, {
          ariaLabel: 'Worklist',
          items: TABS,
          value: 'inbox',
          onChange: () => {},
          idPrefix: 'seam',
        }),
        React.createElement(TabPanel, {
          idPrefix: 'seam',
          tabId: 'inbox',
          active: true,
          children: [
            React.createElement(InboxRow, {
              key: 'selected',
              id: 'row-selected',
              title: 'Selected item',
              supporting: 'The row a person is looking at',
              trailing: '2m',
              selected: true,
              onSelect: () => {},
            }),
            React.createElement(InboxRow, {
              key: 'plain',
              id: 'row-plain',
              title: 'Unselected item',
              supporting: 'The row beside it',
              trailing: '9m',
              onSelect: () => {},
            }),
          ],
        }),
      )
    }

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(React.createElement(Surface))
    })

    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as Element[]
    const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
    const idleTab = tabs.find((tab) => tab.getAttribute('aria-selected') !== 'true')
    const selectedRow = container.querySelector('#row-selected')
    const plainRow = container.querySelector('#row-plain')

    await run('the tree composes: a tab strip above a selected row and its sibling', () => {
      assert.equal(tabs.length, 2, 'both tabs mounted')
      assert.ok(activeTab, 'one tab is aria-selected')
      assert.ok(idleTab, 'the other tab is not')
      assert.ok(selectedRow, 'the selected row mounted')
      assert.ok(plainRow, 'its unselected sibling mounted')
      assert.equal(selectedRow?.tagName, 'BUTTON', 'an interactive row renders as a button')
    })

    // --- T4: neutral two-tier selection ------------------------------------

    await run('T4 selection is the neutral --bg-selected fill, and only the selected row carries it', () => {
      assert.ok(
        hasClassMatching(selectedRow, /^bg-\[color:var\(--bg-selected\)\]$/),
        'the selected row is filled with --bg-selected',
      )
      assert.ok(
        !hasClassMatching(plainRow, /^bg-\[color:var\(--bg-selected\)\]$/),
        'the unselected row is not — selection has to be visible as a difference',
      )
      assert.equal(
        selectedRow?.getAttribute('aria-current'),
        'true',
        'the neutral fill is carried to assistive tech by aria-current',
      )
    })

    // The fill's second channel, added 2026-09-05. One step of neutral grey is
    // the quietest mark on a surface, and it lost outright to any row wearing a
    // status wash — the person could not find the row their keyboard was driving.
    // The edge answers that; it reads `--selection-edge` rather than the accent
    // directly so the resting tier can drop it to transparent with the fill.
    await run('T4 the selected row carries the 2px accent edge, through --selection-edge', () => {
      assert.ok(
        hasClassMatching(selectedRow, /^ring-2$/) && hasClassMatching(selectedRow, /^ring-inset$/),
        'the edge is a 2px inset ring, so it never shifts the row',
      )
      assert.ok(
        hasClassMatching(selectedRow, /^ring-\[color:var\(--selection-edge\)\]$/),
        'and it is drawn in --selection-edge, which the resting tier rebinds',
      )
      assert.ok(
        !hasClassMatching(plainRow, /^ring-inset$/),
        'an unselected row carries no edge — exactly one is on screen',
      )
    })

    await run('T4 the selected row title sits at --text-strong', () => {
      const title = selectedRow?.querySelector('.truncate')
      assert.ok(title, 'the row has a title line')
      assert.equal(title?.textContent, 'Selected item', 'and it is the title, not the supporting line')
      assert.ok(
        hasClassMatching(title, /^text-\[color:var\(--text-strong\)\]$/),
        'the title is the second tier of the selection: ink lifted to --text-strong',
      )
    })

    // The lift is only a signal if the row it lifts from sits lower. Before T18
    // an unselected title was already `--text-strong`, so "selection lifts its
    // title" changed nothing and the fill carried the state alone.
    await run('T18 an unselected row title sits at --text-default, so the lift is a real step', () => {
      const title = plainRow?.querySelector('.truncate')
      assert.ok(title, 'the unselected row has a title line')
      assert.equal(title?.textContent, 'Unselected item', 'and it is the title, not the supporting line')
      assert.ok(
        hasClassMatching(title, /^text-\[color:var\(--text-default\)\]$/),
        'the unselected title is one rung below the selected one',
      )
    })

    // The accent reaches selection as an EDGE and only as an edge. An accent
    // FILL would be the original failure this rule was written for: the accent's
    // other job is "this is the action worth clicking", and a filled row outranks
    // the button beside it. `--selection-edge` is the one sanctioned spelling —
    // naming `--accent-primary` on a row opts it out of the resting tier.
    await run('T4 the accent reaches the selected row as an edge only — no fill, no left bar', () => {
      for (const element of subtree(selectedRow as Element)) {
        for (const token of classesOf(element)) {
          assert.ok(
            !/--accent-primary/.test(token),
            'selection reaches the accent only as an edge, and only through ' +
              `--selection-edge so the resting tier can drop it, found \`${token}\``,
          )
          assert.ok(!/^-?border-l(-|$)/.test(token), `selection must not draw a left bar, found \`${token}\``)
        }
      }
    })

    // --- T5: the focus ring is present and on :focus-visible ---------------

    await run('T5 every tab carries a :focus-visible ring', () => {
      for (const tab of tabs) {
        const classes = classesOf(tab)
        assert.ok(
          classes.some((token) => /^focus-visible:(focus-ring|ring|outline|shadow|border)/.test(token)),
          `tab "${tab.textContent}" declares a focus-visible indicator`,
        )
        assert.ok(
          classes.includes('focus-visible:focus-ring'),
          `tab "${tab.textContent}" reaches for the shared focus-ring utility rather than spelling out a width and a colour`,
        )
      }
    })

    await run('T5 focus:outline-none is never left undischarged, and a bare :focus ring does not count', () => {
      for (const element of [...tabs, selectedRow as Element, plainRow as Element]) {
        const classes = classesOf(element)
        assert.ok(
          !classes.some((token) => /^focus:(ring|outline-\[|shadow)/.test(token)),
          'a ring on :focus draws for a mouse click, which the clause rules out',
        )
        if (!classes.includes('focus:outline-none')) continue
        assert.ok(
          classes.some((token) => /^focus-visible:(focus-ring|ring|outline|shadow|border)/.test(token)),
          'focus:outline-none is only allowed alongside a focus-visible replacement',
        )
      }
    })

    // The retired second idiom. A focus-scoped border recolour is not an
    // indicator — it moves no pixels, and on a field whose resting border already
    // sits near the focus hue it is invisible. It had spread to whole form
    // families, so the tree-wide sweep is enforced by the `focus-border-swap` rule
    // in scripts/lint-design-system-conformance.mjs, which reads every renderer
    // source; what belongs HERE is the composed tree keeping the same clause.
    await run('no control in the tree swaps a border on focus instead of wearing the ring', () => {
      for (const element of subtree(container.firstElementChild as Element)) {
        for (const token of classesOf(element)) {
          assert.ok(
            !/^(?:group-|peer-)?focus(?:-within|-visible)?:border-/.test(token),
            `focus is the shared ring, never a border swap — found \`${token}\``,
          )
        }
      }
    })

    await run('T5 the focused tab is reachable and keeps its ring once focus lands on it', () => {
      ;(activeTab as unknown as HTMLElement).focus()
      assert.equal(
        dom.window.document.activeElement,
        activeTab,
        'the active tab takes focus — a ring on an unreachable control is not a keyboard path',
      )
      assert.equal(activeTab?.getAttribute('tabindex'), '0', 'and it is the tab in the tab order')
      assert.equal(idleTab?.getAttribute('tabindex'), '-1', 'roving focus keeps the other one out of it')
      assert.ok(
        hasClassMatching(activeTab, /^focus-visible:focus-ring$/),
        'the indicator is still declared on the element that now holds focus',
      )
    })

    // --- T11: active is an underline plus an ink lift, never a fill ---------

    await run('T11 the active tab is marked by an accent hairline underline', () => {
      const underline = activeTab?.querySelector('[aria-hidden="true"].absolute')
      assert.ok(underline, 'the active tab carries a decorative underline element')
      const classes = classesOf(underline)
      assert.ok(classes.includes('h-px'), 'the underline is a hairline, not a bar')
      assert.ok(
        classes.includes('bg-[color:var(--accent-primary)]'),
        'the accent is spent on the hairline — the one shape the accent budget allows',
      )
      const idleUnderline = idleTab?.querySelector('[aria-hidden="true"].absolute')
      assert.ok(idleUnderline, 'the idle tab reserves the same space so the strip does not shift')
      assert.ok(
        !hasClassMatching(idleUnderline, /--accent-primary/),
        'but draws nothing — otherwise the underline would not mark anything',
      )
    })

    await run('T11 active also lifts the ink, and idle does not', () => {
      assert.ok(
        hasClassMatching(activeTab, /^text-\[color:var\(--text-strong\)\]$/),
        'the active tab label is lifted to --text-strong',
      )
      assert.ok(
        hasClassMatching(idleTab, /^text-\[color:var\(--text-muted\)\]$/),
        'the idle tab label stays at --text-muted, so the lift reads as state',
      )
    })

    await run('T11 no accent fill marks the active tab', () => {
      for (const tab of tabs) {
        for (const token of classesOf(tab)) {
          assert.ok(
            !token.startsWith('bg-[color:var(--accent-primary'),
            `the accent is never a fill on the control itself, found \`${token}\``,
          )
        }
        // The hairline is the only element permitted to spend the accent, and only
        // because it is a hairline. Anything taller filling with the accent is the
        // violation this contract exists to catch.
        for (const element of subtree(tab)) {
          const classes = classesOf(element)
          if (!classes.some((token) => token.startsWith('bg-[color:var(--accent-primary'))) continue
          assert.ok(
            classes.includes('h-px') || classes.includes('w-px'),
            `only a hairline may carry the accent fill, found it on \`${classes.join(' ')}\``,
          )
        }
      }
    })

    // --- T10: row padding is on the 2px grid -------------------------------

    await run('T10 row padding resolves to steps on the sem.space 2px grid', () => {
      for (const row of [selectedRow as Element, plainRow as Element]) {
        const steps = paddingSteps(row)
        assert.ok(steps.length > 0, 'the row declares padding — a row with none is not a row')
        for (const step of steps) {
          assert.ok(
            SPACE_SCALE_PX.has(step.px),
            `padding \`${step.token}\` is ${step.px}px, which is not a sem.space step ` +
              `(${[...SPACE_SCALE_PX].join(', ')})`,
          )
        }
      }
    })

    await run('T10 every spacing utility in the composed tree lands on the 2px grid', () => {
      const SPACING_UTILITY = /^-?(?:px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y)-(.+)$/
      for (const element of subtree(container.firstElementChild as Element)) {
        for (const token of classesOf(element)) {
          const match = token.match(SPACING_UTILITY)
          if (!match) continue
          const px = spacingPx(match[1])
          // `gap-0.5` style fractions resolve; anything else (`auto`, `full`) is
          // not a grid value at all and is left alone.
          if (px === null) continue
          assert.ok(px % 2 === 0, `\`${token}\` resolves to ${px}px, off the 2px grid`)
        }
      }
    })

    // --- the conversation peek card, and the ring it introduced --------------
    // A hover surface is the easiest place in the app to hand-roll a control:
    // nothing about it is reachable by the ordinary keyboard sweep, so a raw
    // `<button>`, a missing name or a colour spelled by hand survives review by
    // being invisible. The card is mounted here for the same reason the rows and
    // tabs above are — a contract that holds only in the file that declares it is
    // not a contract the composed tree keeps.
    //
    // `ContextRing` is the primitive this card brought
    // (design-system/components/context-ring). The card now wears it as the
    // context line's glyph, beside the words, so the rules asserted here are the
    // decorative mode's: drawn, and neither announced nor focused a second time.

    const { ConversationPeekCard } = await import('../workspace/ConversationPeekCard')
    const peekContainer = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(peekContainer)
    const peekRoot = createRoot(peekContainer)
    const peekNow = 1_800_000_000_000
    act(() => {
      peekRoot.render(
        React.createElement(ConversationPeekCard, {
          identity: {
            name: 'Improve Git Diff Viewing',
            place: { machine: { label: 'studio-mini', kind: 'remote' }, branch: 'git-diff' },
            status: { kind: 'working', label: 'Working' },
            agent: {
              sessionId: '309703f3-0000-1756',
              cli: 'claude-code',
              model: 'claude-fable-5-1',
              // Two, so the head's pull request mark renders its SPLIT shape —
              // the one with a menu behind it — under the same rules as the rest
              // of the card (epic pull-request-marks).
              pullRequests: [
                {
                  url: 'https://github.com/acme/sprintengine/pull/418',
                  repoKey: 'github.com/acme/sprintengine',
                  repoName: 'sprintengine',
                  number: 418,
                  title: 'Extensions icon carries its unread count',
                  state: 'open' as const,
                  isDraft: false,
                  openedAt: peekNow - 720_000,
                  stateAt: peekNow,
                },
                {
                  url: 'https://github.com/acme/sprintengine/pull/411',
                  repoKey: 'github.com/acme/sprintengine',
                  repoName: 'sprintengine',
                  number: 411,
                  title: 'Split the review provider',
                  state: 'merged' as const,
                  isDraft: false,
                  openedAt: peekNow - 86_400_000,
                  stateAt: peekNow,
                },
              ],
              activeSubagents: 2,
              contextUsage: { usedPercentage: 38, at: peekNow, contextWindowSize: 200_000 },
            },
          },
          now: peekNow,
        }),
      )
    })

    await run('the peek card composes: a corner and one line per fact', () => {
      assert.ok(peekContainer.querySelector('.working-mark'), 'the corner drew the sidebar’s mark')
      assert.equal(peekContainer.querySelectorAll('li').length, 4, 'machine, branch, model and context')
      assert.ok(peekContainer.querySelector('[aria-label="Context: 76k / 200k tokens · 38%"]'), 'the context line drew')
    })

    await run('every control on the peek card has an accessible name', () => {
      const unnamed = Array.from(peekContainer.querySelectorAll('button')).filter((control) => {
        const label = control.getAttribute('aria-label') ?? ''
        return !label.trim() && !(control.textContent ?? '').trim()
      })
      assert.deepEqual(
        unnamed.map((control) => control.outerHTML.slice(0, 80)),
        [],
        'a hover surface is not reachable by an ordinary sweep, so an unnamed control here is never found',
      )
    })

    await run('the corner is the sidebar’s working mark, never a status dot', () => {
      // The whole point of the 2026-09-09 revision: the row says "working" with
      // the working mark, so a pulsing disc six pixels away on the card would
      // be two vocabularies for one fact.
      for (const element of subtree(peekContainer)) {
        for (const token of classesOf(element)) {
          assert.ok(
            !/^animate-pulse$/.test(token),
            `the card wears the working mark, never a second liveness idiom — found \`${token}\``,
          )
        }
      }
      const mark = peekContainer.querySelector('.working-mark')
      assert.equal(mark?.getAttribute('role'), 'img', 'the mark carries the state')
      assert.equal(
        mark?.getAttribute('aria-label'),
        '2 running',
        'in words, and the visible word beside it is decorative so nothing is announced twice',
      )
    })

    await run('the context ring on the card is decorative — the line beside it carries the words', () => {
      const line = peekContainer.querySelector('[aria-label^="Context:"]') as Element
      const ring = line.querySelector('svg') as Element
      assert.ok(ring, 'the ring drew as the line’s glyph')
      assert.ok(ring.closest('[aria-hidden="true"]'), 'and is hidden, so the reading is announced once')
      assert.equal(line.querySelector('[tabindex]'), null, 'with no focus stop that would only repeat its neighbour')
    })

    await run('the peek card spells no colour of its own — every one is a token', () => {
      // Any bracketed value on a colour utility has to resolve through a
      // variable. `text-[length:…]` is a size that happens to share the `text-`
      // prefix and is not a colour at all.
      const COLOUR_UTILITY = /^(?:bg|text|border|stroke|fill)-\[(.+)\]$/
      for (const element of subtree(peekContainer)) {
        for (const token of classesOf(element)) {
          assert.ok(
            !/#[0-9a-fA-F]{3,8}\b/.test(token),
            `\`${token}\` spells a raw colour; the card takes every one from the token layer`,
          )
          const arbitrary = token.match(COLOUR_UTILITY)?.[1]
          if (!arbitrary || arbitrary.startsWith('length:')) continue
          assert.ok(
            arbitrary.includes('var(--'),
            `\`${token}\` is an arbitrary colour value rather than a var() reference`,
          )
        }
      }
    })

    act(() => {
      peekRoot.unmount()
    })
    peekContainer.remove()

    // --- item 2003: the Design door's canvas ---------------------------------
    // The canvas renders THIRD-PARTY design systems, so it is the surface most
    // likely to drift into borrowing the previewed system's idioms. Mounted with a
    // fixture view and read as markup, like everything else here.

    const { DesignCanvas } = await import('../workspace/globalSurface/design/DesignCanvas')
    const designContainer = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(designContainer)
    const designRoot = createRoot(designContainer)
    const designView = {
      identity: {
        path: '/work/brand/design-system',
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
        contents: { components: ['button'], glyphs: ['check'] },
        derived: {},
        provenance: {},
      },
      specimen: {
        // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
        tokensCss: ':root{--sem-color-bg-app:#08080c}',
        // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
        ramp: [{ path: 'ref.color.green.600', light: '#2f6a4a', dark: '#4daf7d' }],
        fontFamilyUi: 'Inter, system-ui',
        fontFamilyMono: null,
        tokens: {
          fontSize: [{ path: 'sem.font.size.body', light: '13px', dark: '13px' }],
          fontWeight: [{ path: 'sem.font.weight.emphasis', light: '600', dark: '600' }],
          fontLine: [],
          fontTracking: [],
          space: [{ path: 'sem.space.md', light: '10px', dark: '10px' }],
          size: [{ path: 'sem.size.control.sm', light: '30px', dark: '30px' }],
          radius: [{ path: 'sem.radius.control', light: '7px', dark: '7px' }],
          shadow: [],
        },
        problems: [],
      },
      groups: [
        { key: 'components', label: 'Components', entries: ['button'], count: 1 },
        { key: 'glyphs', label: 'Glyphs', entries: ['check'], count: 1 },
      ],
      components: [
        {
          name: 'button',
          css: '.ds-button{border-radius:5px}',
          inlineStyles: [],
          stages: [{ mode: 'light', html: '<button class="ds-button">Continue</button>' }],
          variantCount: 3,
          stateCount: 4,
          doc: {
            anatomy: 'Label.',
            variants: '- primary\n- secondary\n- ghost',
            states: '- rest\n- hover\n- focus-visible\n- disabled',
            usage: 'One primary per view.',
            accessibility: 'Native button.',
          },
          unresolvedRefs: [],
        },
      ],
      patterns: [],
      glyphs: [{ name: 'check', svg: '<svg viewBox="0 0 16 16"></svg>' }],
      assetBudgetExhausted: false,
    }
    act(() => {
      designRoot.render(
        React.createElement(DesignCanvas, {
          view: designView as never,
          mode: 'dark',
          // No `onReload` / `reloading`: Reveal and Reload moved to the door bar
          // when the canvas gave up its second chrome band (audit 2026-09-02),
          // and the canvas no longer takes them.
          //
          // No `openComponent` / `onOpenComponent` / `onCloseComponent` either:
          // the canvas stopped being a grid you click into on 2026-09-08
          // (c375c687a) and became six tabs of live demos. Its view state is now
          // the tab and the per-tab page, both held by the door — which is what
          // this fixture hands it. (Repaired 2026-09-09: the rewrite left this
          // suite mounting the canvas with the old props, so `pages[active]`
          // threw and every assertion below it went unrun.)
          tab: null,
          onTabChange: () => {},
          pages: {},
          onPageChange: () => {},
        }),
      )
    })

    // Re-pointed 2026-09-09 at the canvas the Design-door rewrite left (c375c687a,
    // "six tabs, live demos, nothing to click into"). The rule is unchanged —
    // spacing does the grouping, a specimen draws no box — but the thing it reads
    // is no longer a clickable tile: a specimen is now a `Section` holding one
    // live demo, so that is what gets read.
    await run('2003 no component specimen carries a border — spacing does the grouping', () => {
      const specimens = Array.from(designContainer.querySelectorAll('section')) as Element[]
      assert.ok(specimens.length > 0, 'the fixture renders a component specimen')
      for (const specimen of specimens) {
        for (const element of [specimen, ...subtree(specimen)]) {
          for (const token of classesOf(element)) {
            // `border-0`/`border-none` REMOVE a border (the iframe's UA default),
            // which is the rule, not a violation of it.
            if (token === 'border-0' || token === 'border-none') continue
            assert.ok(
              !/^border(-[trbl])?(-\d+)?$/.test(token) && !token.startsWith('border-['),
              `a specimen must not draw a border, found \`${token}\``,
            )
          }
        }
      }
    })

    await run('2003 the canvas is six tabs, and a specimen is a name and a live demo', () => {
      const tabs = Array.from(designContainer.querySelectorAll('[role="tab"]')) as Element[]
      // The fixture declares components and glyphs and carries three token
      // families, so five of the six tabs have something in them; a tab for a
      // group the manifest declares empty is not drawn (the rule since 2003).
      const labels = tabs.map((tab) => (tab.textContent ?? '').replace(/\d+$/, ''))
      assert.deepEqual(labels, ['Colour', 'Type', 'Spacing', 'Components', 'Glyphs'])
      assert.equal(
        tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length,
        1,
        'exactly one tab is selected',
      )
      assert.equal(
        designContainer.querySelectorAll('[role="tabpanel"]').length,
        1,
        'and exactly one panel is mounted — five panels of live documents is the cost this avoids',
      )
      // The specimen: the heading, and the demo in its own frame. No counts line
      // ("3 variants · 4 states" is in the fixture and must not be drawn), no
      // spec disclosure, and nothing to click into.
      const text = designContainer.textContent ?? ''
      assert.match(text, /button/, 'the component is named')
      assert.ok(!/variants?\b/i.test(text), 'no counts line under a live specimen')
      assert.ok(!/states?\b/i.test(text), 'and no state count either')
      assert.equal(designContainer.querySelectorAll('details').length, 0, 'no spec disclosure')
      assert.ok(!text.includes('Anatomy'), 'and none of its headings')
      const frames = Array.from(designContainer.querySelectorAll('iframe')) as Element[]
      assert.equal(frames.length, 1, 'one live document per specimen on the page')
      assert.ok((frames[0].getAttribute('srcdoc') ?? '').includes('ds-button'), 'and it is the component, composed')
    })

    await run('2003 the door sets one face — no monospace anywhere in its chrome', () => {
      for (const element of [
        designContainer.firstElementChild as Element,
        ...subtree(designContainer.firstElementChild as Element),
      ]) {
        for (const token of classesOf(element)) {
          assert.ok(token !== 'font-mono', 'the door states exactly one font-family, the UI face')
        }
      }
    })

    await run('2003 hover is a background change — never a scale, shadow, or border', () => {
      for (const element of subtree(designContainer.firstElementChild as Element)) {
        for (const token of classesOf(element)) {
          if (!token.startsWith('hover:')) continue
          assert.ok(
            token.startsWith('hover:bg-') || token.startsWith('hover:text-'),
            `hover may only change background or ink, found \`${token}\``,
          )
        }
      }
    })

    await run('2003 the canvas spends two radii, and no marketing radius', () => {
      const radii = new Set<string>()
      for (const element of [
        designContainer.firstElementChild as Element,
        ...subtree(designContainer.firstElementChild as Element),
      ]) {
        for (const token of classesOf(element)) {
          if (token.startsWith('rounded')) radii.add(token)
        }
      }
      for (const token of radii) {
        assert.ok(!/^rounded-(2xl|3xl|full)$/.test(token), `marketing radii are reject-on-sight, found \`${token}\``)
      }
      assert.ok(radii.size <= 2, `two radii per view; found ${[...radii].join(', ')}`)
    })

    await run('2003 headings are sentence case, never uppercase letter-spaced', () => {
      for (const element of subtree(designContainer.firstElementChild as Element)) {
        for (const token of classesOf(element)) {
          assert.ok(token !== 'uppercase', 'uppercase is not a hierarchy device')
          assert.ok(!/^tracking-(wide|wider|widest)$/.test(token), `found \`${token}\``)
        }
      }
      const headings = Array.from(designContainer.querySelectorAll('h2, h3')) as Element[]
      for (const heading of headings) {
        const text = heading.textContent ?? ''
        assert.ok(text !== text.toUpperCase() || text.length < 2, `shouting heading: ${text}`)
      }
    })

    await run('2003 no Release, version history, lint or regenerate affordance exists', () => {
      const text = (designContainer.textContent ?? '').toLowerCase()
      for (const forbidden of ['release', 'lint', 'regenerate', 'version history', 'pull']) {
        assert.ok(!text.includes(forbidden), `the canvas must not offer "${forbidden}"`)
      }
      // The two actions that DO belong are both about the folder — and since the
      // 2026-09-02 audit they ride the door bar (`DesignGlobalSurface`'s
      // `bar.actions`), not a second chrome band inside the canvas.
      assert.ok(!text.includes('reveal') && !text.includes('reload'), 'the canvas draws no chrome band of its own')
      const surfaceSource = readFileSync(
        join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/design/DesignGlobalSurface.tsx'),
        'utf8',
      )
      const actions = surfaceSource.slice(surfaceSource.indexOf('actions:'))
      assert.ok(/>\s*Reveal\s*</.test(actions), 'Reveal is offered, in the door bar')
      assert.ok(/'Reload'/.test(actions), 'Reload is offered, in the door bar')
    })

    // Also re-pointed 2026-09-09. The old canvas carried an identity block — the
    // system's name over a ramp — and the rule was "shown once, and in no box of
    // its own". The rewrite deleted that block: the door bar names the system, and
    // the canvas is only its contents. So the rule tightens rather than relaxes —
    // the name is shown ZERO times in the canvas's own copy — and the one thing
    // the band still says about the bundle, its folder, is said once.
    await run('2003 the canvas names no system in its own copy, and its folder once', () => {
      const copy = designContainer.textContent ?? ''
      assert.equal(
        copy.split('sprintengine').length - 1,
        0,
        'the door bar names the system; the canvas repeating it is the second name',
      )
      assert.equal(
        copy.split('/work/brand/design-system').length - 1,
        1,
        'the folder is said once, in the band, and nowhere else',
      )
      // Still no surface of its own around the contents: the panel is padding.
      const panel = designContainer.querySelector('[role="tabpanel"]')
      assert.ok(panel, 'the contents live in a labelled tab panel')
      for (const token of classesOf(panel)) {
        // `border` on its own is a container too — a 1px rule on all four sides.
        // The hyphen was added while re-pointing this at the rewritten canvas and
        // it opened exactly the hole the rule exists to close, so the prefix is
        // back to `border`.
        assert.ok(!token.startsWith('border'), 'the panel draws no container')
        assert.ok(!token.startsWith('bg-'), 'and no surface of its own')
      }
    })

    act(() => {
      designRoot.unmount()
    })

    // --- item 2005: the create screen ----------------------------------------
    // The screen most at risk of growing affordances the epic explicitly cut:
    // clone-from-GitHub, a DTCG token-file import, a marketplace shelf. Each was
    // rejected for its own reason, and each would be easy to re-add by accident.

    const { NewDesignSystemScreen } = await import('../workspace/globalSurface/design/NewDesignSystemScreen')
    const newRoot = createRoot(designContainer)
    act(() => {
      newRoot.render(
        React.createElement(NewDesignSystemScreen, {
          sources: [
            { path: '/work/brand/design-system', name: 'sprintengine', view: designView as never },
            { path: null, name: 'Empty system', view: null },
          ],
          mode: 'dark',
          busy: null,
          error: null,
          onPointAtFolder: () => {},
          onSeedFrom: () => {},
        }),
      )
    })

    await run('2005 Point at a folder is the ONE accent-filled action on the screen', () => {
      const primaries = (Array.from(designContainer.querySelectorAll('button')) as Element[]).filter((button) =>
        classesOf(button).some((token) => token.startsWith('bg-[color:var(--accent-primary')),
      )
      // The one accent-filled control rides the door bar (`DesignGlobalSurface`'s
      // `bar.actions`, audit 2026-09-02); the screen itself paints none.
      assert.equal(primaries.length, 0, 'the create screen paints no accent-filled control of its own')
      const surfaceSource = readFileSync(
        join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/design/DesignGlobalSurface.tsx'),
        'utf8',
      )
      const actions = surfaceSource.slice(surfaceSource.indexOf('actions:'), surfaceSource.indexOf(': undefined,'))
      assert.equal((actions.match(/<PrimaryButton\b/g) ?? []).length, 1, 'exactly one accent-filled control in the bar')
      assert.match(actions, /Point at a folder/)
    })

    await run('2005 no heading sits above the grid', () => {
      // With the rejected "bring one in" row cut there is one group on screen, and
      // a heading must separate something from something else.
      assert.equal(
        designContainer.querySelectorAll('h1, h2, h3').length,
        0,
        'a heading here would label the only thing present',
      )
    })

    await run('2005 a card names its system once, in the specimen — never again beneath', () => {
      // The specimen lives inside a sandboxed iframe (srcdoc), so the app-side
      // markup must carry the name only as the accessible label of the card.
      const cards = (Array.from(designContainer.querySelectorAll('button')) as Element[]).filter((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Start from'),
      )
      assert.equal(cards.length, 2, 'one per source, plus Empty')
      const seeded = cards[0]
      assert.equal(seeded.getAttribute('aria-label'), 'Start from sprintengine')
      assert.ok(
        !(seeded.textContent ?? '').includes('sprintengine'),
        'no caption repeating the name the specimen already carries',
      )
      // Boxless: no border on the card itself.
      for (const token of classesOf(seeded)) {
        assert.ok(!/^border(-[trbl])?(-\d+)?$/.test(token), `a card must not be boxed: ${token}`)
      }
    })

    await run('2005 nothing clones, imports a token file, or names a marketplace', () => {
      const text = (designContainer.textContent ?? '').toLowerCase()
      for (const forbidden of ['github', 'clone', 'pull', 'fetch', 'marketplace', 'import', 'browse', 'url']) {
        assert.ok(!text.includes(forbidden), `the create screen must not offer "${forbidden}"`)
      }
    })

    act(() => {
      newRoot.unmount()
    })
    designContainer.remove()

    act(() => {
      root.unmount()
    })

    // --- the modal focus trap ---------------------------------------
    // Mounted, not read: the trap is behaviour. jsdom moves no focus on Tab, so
    // what is asserted here is the mechanism the browser's Tab lands on — the
    // sentinel that sits immediately before and after the dialog in the tab
    // order, and where it sends focus when it fires. DOM order does the rest:
    // there is no tabbable node between a sentinel and the dialog it guards.

    const { Modal } = await import('./Modal')
    const { FocusTrap } = await import('./FocusTrap')

    const trapContainer = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(trapContainer)
    const trapRoot = createRoot(trapContainer)
    act(() => {
      trapRoot.render(
        // JSX for the same TS2769 reason as the Field block below.
        <Modal open onClose={() => {}}>
          <button id="first" key="a">
            First
          </button>
          <button id="last" key="b">
            Last
          </button>
        </Modal>,
      )
    })

    const sentinels = Array.from(trapContainer.querySelectorAll('[data-focus-sentinel="true"]')) as HTMLElement[]

    await run('a Modal mounts one sentinel each side of the dialog it declares modal', () => {
      assert.equal(sentinels.length, 2, 'the dialog is guarded on both edges')
      const dialog = trapContainer.querySelector('[role="dialog"]')
      assert.ok(dialog, 'the dialog mounted')
      assert.equal(
        sentinels[0].nextElementSibling,
        dialog,
        'nothing tabbable sits between the opening sentinel and the dialog',
      )
      assert.equal(sentinels[1].previousElementSibling, dialog, 'nor between the dialog and the closing one')
      for (const sentinel of sentinels) {
        assert.equal(
          sentinel.getAttribute('tabindex'),
          '0',
          'a sentinel has to be in the tab order to catch the Tab that would leave',
        )
      }
    })

    // The same mount, read for geometry. The source rules further down
    // police what a developer may TYPE; this is what a dialog actually renders,
    // which is the claim that matters: the primitive shipped shadowless, so the
    // surface every other dialog is supposed to converge on was the one that
    // looked wrong.
    await run('the default Modal renders the shell chrome and a step of the width scale', () => {
      const dialog = trapContainer.querySelector('[role="dialog"]') as HTMLElement | null
      assert.ok(dialog, 'the dialog mounted')
      const classes = classesOf(dialog)
      assert.ok(
        classes.includes('shadow-[var(--shadow-modal)]'),
        'the shell casts the modal elevation — it used to cast none at all',
      )
      assert.ok(
        classes.includes('rounded-[var(--radius-lg)]'),
        'and rounds at radius.shell, not at a value between the ramp steps',
      )
      assert.ok(
        classes.includes('border-[color:var(--border-subtle)]'),
        'with the shell border, so a dialog and the palette draw one edge',
      )
      // A step, not a pixel count a caller typed. `standard` is the default.
      assert.equal(dialog.style.width, '560px', 'width comes from the scale')
      assert.equal(dialog.style.maxWidth, '95vw', 'and every step gives way to the viewport the same amount')
    })

    await run('Tab off the end of the dialog returns to its first control', () => {
      act(() => {
        sentinels[1].focus()
      })
      assert.equal(
        dom.window.document.activeElement?.id,
        'first',
        'the cycle wraps forward instead of walking out into the page behind the scrim',
      )
    })

    await run('Shift+Tab off the front of the dialog returns to its last control', () => {
      act(() => {
        sentinels[0].focus()
      })
      assert.equal(dom.window.document.activeElement?.id, 'last', 'and backward too')
    })

    act(() => {
      trapRoot.unmount()
    })

    // A dialog that stacks a second capture as a SIBLING of the dialog it traps.
    // A trap that read its parent element would fold the two into one cycle;
    // this fixture is that shape, reduced.
    const siblingRoot = createRoot(trapContainer)
    act(() => {
      siblingRoot.render(
        // JSX for the same TS2769 reason as the Field block below.
        <div>
          <FocusTrap key="trap">
            <div role="dialog" aria-modal="true" tabIndex={-1}>
              <button id="inside">Inside</button>
            </div>
          </FocusTrap>
          <button key="sibling" id="sibling">
            Sibling
          </button>
        </div>,
      )
    })

    await run('the trapped region is what the trap wraps, never a sibling beside it', () => {
      const edges = Array.from(trapContainer.querySelectorAll('[data-focus-sentinel="true"]')) as HTMLElement[]
      assert.equal(edges.length, 2, 'the trap mounted its sentinels')
      act(() => {
        edges[1].focus()
      })
      assert.equal(
        dom.window.document.activeElement?.id,
        'inside',
        'a control outside the trap is not part of its cycle',
      )
    })

    act(() => {
      siblingRoot.unmount()
    })
    trapContainer.remove()

    // --- one z ladder, and overlays read it by name -----------------
    // Read from source, not from the tree: the overlay shells this rule polices
    // are whole app screens (the command palette, the diagnostics overlay) that
    // cannot be mounted here, and the rule is about the
    // literal a developer types. The renderer used to run a private ladder
    // (10/20/30/35/40/50) beside the design system's `--sem-z-*`, and the two
    // disagreed about the top of the stack — a `z-50` modal sat BELOW the z-60
    // menus. Now every overlay layer derives from the tokens, aliased into the
    // app as `--z-*`.
    //
    // Scope is overlay shells: a class string that positions itself `fixed` or
    // paints the `.overlay-scrim`. In-flow depth inside a pane (`z-10` on a HUD,
    // `z-20` on a docked pane, `z-30` on a panel-internal popover) describes
    // depth within one surface, not a layer in the app's stack, and is left alone.
    await run('no overlay shell carries a raw z literal — layering comes from --z-* tokens', () => {
      const rendererRoot = join(process.cwd(), 'src/renderer/src')
      const sources: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full)
        }
      }
      walk(rendererRoot)

      // A whole class token, so `z-[var(--z-modal)]` and `zoom-50` never match.
      const RAW_Z = /(?:^|\s)(-?z-(?:\d+|\[\d+\]))(?=\s|$)/
      const OVERLAY_SHELL = /(?:^|\s)(?:fixed|overlay-scrim)(?=\s|$)/
      const STRINGS = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g

      const offenders: string[] = []
      for (const path of sources) {
        // Comments first: `Modal.tsx` documents the retired ladder in prose, and
        // prose is not a class string.
        const code = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        for (const match of code.matchAll(STRINGS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          const z = text.match(RAW_Z)
          if (!z || !OVERLAY_SHELL.test(text)) continue
          offenders.push(`${relative(process.cwd(), path)}: ${z[1]}`)
        }
      }
      assert.deepEqual(offenders, [], 'overlay z literals must name a tier: z-[var(--z-modal)] and friends')
    })

    // --- selection never borrows the hover fill ---------------------
    // Read from source for the same reason as the z rule above: the surfaces this
    // polices are whole app screens (the file tree, the git graph, the Backlog
    // list) that cannot be mounted here, and the rule is about the
    // literal a developer types.
    //
    // Selection answers "what did I pick?" and hover answers "what is the pointer
    // over?" (design-system/patterns/selection.html). Six surfaces painted the
    // first with the second's token, so a selected row was pixel-identical to a
    // hovered one and the surface stopped answering "what am I acting on?".
    //
    // Scope is a class token in selection company: a whole `bg-[color:var(--bg-hover)]`
    // or `bg-[color:var(--bg-active)]` — never the `hover:`/`group-hover:` variants
    // of the same token, which ARE the hover state — written within a few lines of
    // a selection state's name. `active` is not one of those names on purpose: in
    // a menu or a listbox it names the keyboard cursor, whose canon IS the hover
    // fill (ui/menuClasses, ui/Select), and one idea deserves one token.
    await run('no selected-state class paints the hover or active fill', () => {
      const rendererRoot = join(process.cwd(), 'src/renderer/src')
      const sources: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full)
        }
      }
      walk(rendererRoot)

      const BORROWED = new Set(['bg-[color:var(--bg-hover)]', 'bg-[color:var(--bg-active)]'])
      // Matched against CODE with its string literals blanked out, so the token
      // name `--bg-selected` inside a class string can never pose as the state:
      // a toolbar button whose open state borders itself in `--bg-selected` is
      // not a selected row, and this rule has nothing to say about it.
      // Unanchored on purpose: the state travels under many names — `selected`,
      // `isSelected`, `selectedKey`, `aria-selected` — and blanking the strings is
      // what makes an unanchored match safe.
      const SELECTION_STATE = /selected|aria-current|\bisCurrent\b/i
      const QUOTED = /"[^"\n]*"|'[^'\n]*'/g
      // How far a fill can sit from the state it paints and still be the same
      // decision: the ternary's own branches, or the line that returns them.
      const NEARBY_LINES = 3

      // A file with its class strings blanked but its code intact, so a state name
      // is read from the code that names it. Quoted strings go first; a template
      // literal keeps its `${...}` holes, because that is where the ternary — and
      // so the state — lives, and loses only its literal text.
      const codeWithoutClassStrings = (source: string): string => {
        const chars = source.replace(QUOTED, (literal) => literal.replace(/[^\n]/g, ' ')).split('')
        let index = 0
        while (index < chars.length) {
          if (chars[index] !== '`') {
            index += 1
            continue
          }
          index += 1
          let depth = 0
          while (index < chars.length) {
            const char = chars[index]
            if (depth === 0 && char === '`') {
              index += 1
              break
            }
            if (depth === 0 && char === '$' && chars[index + 1] === '{') {
              depth = 1
              index += 2
              continue
            }
            if (depth > 0) {
              if (char === '{') depth += 1
              else if (char === '}') depth -= 1
              index += 1
              continue
            }
            if (char !== '\n') chars[index] = ' '
            index += 1
          }
        }
        return chars.join('')
      }

      const offenders: string[] = []
      for (const path of sources) {
        // Comments first: this file's own prose names both tokens, and so does
        // the note above `backlogRowPaintClass`. Prose is not a class string.
        const code = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        const lines = code.split('\n')
        const codeOnly = codeWithoutClassStrings(code).split('\n')
        lines.forEach((line, index) => {
          // Class names are whole tokens wherever they are written — a quoted
          // branch, a template's text, an array entry — so the line is read as
          // tokens rather than as string literals.
          const borrowed = new Set<string>()
          for (const token of line.split(/[\s'"`]+/)) {
            if (BORROWED.has(token)) borrowed.add(token)
          }
          if (borrowed.size === 0) return
          const window = codeOnly.slice(Math.max(0, index - NEARBY_LINES), index + NEARBY_LINES + 1).join('\n')
          if (!SELECTION_STATE.test(window)) return
          // The keyboard cursor's own branch, which the scope note above already
          // exempts in principle: `active` names the cursor, and the hover fill IS
          // its canon. What the window cannot see is a picker carrying BOTH marks —
          // `CliModelPicker` highlights with `--bg-hover` and keeps `--bg-selected`
          // for the runtime in force — where the two branches are
          // necessarily one ternary, and so inside each other's window no matter
          // how the file is written. Narrow on purpose: the fill's OWN branch must
          // be the one `active` governs, on its line or the one above it, and the
          // press token is never exempt.
          const governing = `${codeOnly[index - 1] ?? ''}\n${codeOnly[index] ?? ''}`
          const cursorBranch = /\bactive\s*$/m.test(governing)
          if (cursorBranch && !borrowed.has('bg-[color:var(--bg-active)]')) return
          offenders.push(`${relative(process.cwd(), path)}:${index + 1}: ${[...borrowed].join(' ')}`)
        })
      }
      assert.deepEqual(
        offenders,
        [],
        'a selected row takes --bg-selected (and --bg-selected-resting when its pane rests), never the hover fill',
      )
    })

    // --- one geometry scale for every floating surface --------------
    // Source-read for the same reason the z rule is: the shells are whole app
    // screens, and the rule is about the literal a developer types.
    const rendererSources = (): string[] => {
      const rendererRoot = join(process.cwd(), 'src/renderer/src')
      const found: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full)
        }
      }
      walk(rendererRoot)
      return found
    }

    const STRING_LITERALS = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g
    const withoutComments = (path: string): string =>
      readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

    // Scope for the radius rule: a class string that CARRIES AN OVERLAY ELEVATION
    // — `--shadow-popover`, `--shadow-modal` or `--shadow-drawer`. That is the
    // honest definition of a floating surface here: nothing in the document flow
    // takes a shadow in this system (a card or a row takes a hairline), so a
    // string spending one is a surface floating above the page, whatever file it
    // lives in. In-flow chrome is left alone, and so are the ~460 radius
    // off-ramps the `designSystemAxes` ratchet is draining — this is not that
    // sweep.
    await run('a floating surface takes its radius from the shape ramp', () => {
      // The ramp is 4 / 6 / 8 / 12 — chip, control, overlay, shell — reachable as
      // `--radius-xs/sm/md/lg`, as the NAMED Tailwind step (`rounded-sm` resolves
      // through the rebound `--radius-sm`, which is the kit's spelling), or as
      // the px value each carries. The ramp moved onto 4/6/8/12/16 on 2026-11-04. What this rejects
      // is the band BETWEEN the steps, which is where every overlay in the product
      // had landed: `rounded-[8px]` (Modal, the new-workspace hub), `rounded-xl`
      // (the palette, the diagnostics overlay), `rounded-[14px]` (the canvas
      // conversation card). `rounded-full` is absent on purpose: a pill is its
      // own idiom.
      const OVERLAY_ELEVATION = /shadow-\[var\(--shadow-(?:popover|modal|drawer)\)\]/
      const RADIUS = /(?:^|\s)(-?rounded(?:-(?:[tblr]|[tb][lr]))?(?:-\S+)?)(?=\s|$)/g
      const ON_RAMP =
        /^-?rounded(?:-(?:[tblr]|[tb][lr]))?(?:-(?:full|xs|sm|md|lg|\[var\(--radius-(?:xs|sm|md|lg)\)\]|\[(?:4|6|8|12)px\]))?$/

      const offenders: string[] = []
      for (const path of rendererSources()) {
        for (const match of withoutComments(path).matchAll(STRING_LITERALS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          if (!OVERLAY_ELEVATION.test(text)) continue
          for (const radius of text.matchAll(RADIUS)) {
            if (ON_RAMP.test(radius[1])) continue
            offenders.push(`${relative(process.cwd(), path)}: ${radius[1]}`)
          }
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a surface that casts an overlay shadow is a floating surface: its radius is --radius-md (8px, the ' +
          'popover family) or --radius-lg (12px, a dialog-scale shell), never a value between the two',
      )
    })

    await run('no overlay spells its own shadow', () => {
      // A shadow with a TUNED colour in it rather than a token. The five that
      // shipped were all the same string — `0 8px 24px -12px rgba(0,0,0,0.6)`,
      // which is literally what `--sem-shadow-drawer` resolves to in DARK mode —
      // so every light-theme popover cast a shadow tuned for a dark one, and
      // `--sem-shadow-popover` went unconsumed entirely. The last holdout was the
      // agent composer's nested engine flyout at `0 18px 50px rgba(0,0,0,0.55)`,
      // behind an allow-comment claiming parity with a shadow it did not match.
      //
      // Scope: the kit, plus any class string that positions itself as an overlay
      // — the same `fixed` / `.overlay-scrim` shape the z rule polices. An inset
      // hairline on in-flow chrome is not elevation and is not this.
      const KIT = join(process.cwd(), 'src/renderer/src/components/ui')
      const TUNED_SHADOW = /shadow-\[[^\]]*(?:rgba?\(|#[0-9a-fA-F]{3,8})[^\]]*\]/g
      const OVERLAY_SHELL_STRING = /(?:^|\s)(?:fixed|overlay-scrim)(?=\s|$)/

      const offenders: string[] = []
      for (const path of rendererSources()) {
        const inKit = path.startsWith(KIT)
        for (const match of withoutComments(path).matchAll(STRING_LITERALS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          if (!inKit && !OVERLAY_SHELL_STRING.test(text)) continue
          for (const shadow of text.matchAll(TUNED_SHADOW)) {
            offenders.push(`${relative(process.cwd(), path)}: ${shadow[0]}`)
          }
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'overlay elevation comes from --shadow-popover / --shadow-modal / --shadow-drawer, which are defined ' +
          'per theme; a literal freezes one theme’s tuning into all nineteen',
      )
    })

    await run('every dialog shell draws the same chrome, off the same width scale', () => {
      // The shells the item names, each asserted to consume the canon rather than
      // a copy of it. Named files, because the point is that these specifically
      // had five widths, four radii and three shadow decisions between them; a
      // rule phrased over "every file" would pass the day one grew a sixth.
      const shells: Record<string, RegExp> = {
        'components/ui/Modal.tsx': /OVERLAY_SHELL_CLASS/,
        // The palette is glass (2026-09-10), so it takes the shell's chrome
        // without its ground and paints `surface-glass` itself — the same split
        // Popover makes with OVERLAY_CHROME_CLASS. Radius, border and elevation
        // are still the shell's.
        'components/ui/CommandPalette.tsx': /OVERLAY_SHELL_CHROME_CLASS\b[\s\S]*surface-glass/,
        // Migrated onto Modal outright — no shell of its own left to check.
        'components/diagnostics/DiagnosticsOverlay.tsx': /<Modal\b/,
        // The modal-surface host: Settings and Reviews mount through this one
        // Modal. Plugins, Automations and Design were modals here from
        // 2026-09-01 until the Extensions drawer ruling (2026-09-05) made them
        // card-region surfaces again; the Diff popout was here too until the
        // diff got its own OS window (git-commit-window T3, 2026-09-09).
        'components/workspace/WorkspaceManager.tsx': /<Modal\b/,
      }
      for (const [file, pattern] of Object.entries(shells)) {
        const source = readFileSync(join(process.cwd(), 'src/renderer/src', file), 'utf8')
        assert.match(source, pattern, `${file} draws the shared shell chrome rather than a copy of it`)
      }

      // The palette's glass was ruled affordable (2026-09-10) on one condition:
      // it holds the terminal repaint pause while it is up, so the blur beneath
      // it is computed once rather than on every PTY chunk. A palette that kept
      // the glass and dropped the hold would be the ~10fps scrim measurement
      // again, on a smaller area — so the two travel together, or neither.
      const palette = readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/CommandPalette.tsx'), 'utf8')
      assert.ok(
        !/surface-glass/.test(palette) || /acquireTerminalRepaintPause\(/.test(palette),
        'a glass palette holds the terminal repaint pause for its lifetime',
      )

      // And nobody re-opens the width scale with a private measure. `Modal` takes
      // a `size` step, not a pixel count: a `width` prop is a TypeScript error
      // today, and a silent off-scale dialog the moment someone adds it back for
      // one caller.
      const modal = readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/Modal.tsx'), 'utf8')
      assert.ok(!/\bwidth\?:/.test(modal), 'Modal takes a step on the width scale (`size`), never a raw width')
    })

    // --- one primary, one control ramp ------------------------------
    // Source-read, for the same reason the three rules above are: the surfaces
    // are whole app screens — the Git panel, the chat composer, the creation hub,
    // the guided brief — and each rule is about the literal a developer types.
    //
    // The product carried FIVE rival primary idioms. Two of them (the Git commit
    // button, the conflict resolver's save) filled with `--text-strong` — the INK
    // token used as a background — and hovered toward a per-theme hex the design
    // system never published. Two more painted their on-accent label `--bg-app`,
    // which is the same colour as `--text-on-accent` on the dark default and a
    // different one on every theme whose canvas is not the on-accent ink; those
    // labels went unreadable there. And the Git panels ran a private 24/28/32px
    // ramp at 6px radius beside the kit's 26/30/34 at 5px, so buttons that should
    // have been siblings differed by a pixel or two everywhere.

    await run('no button fills itself with the ink token', () => {
      // `--text-strong` is a TEXT tier. Spending it as a background is how the
      // inverted high-contrast button was built, and it needs a hover partner no
      // token ships — which is exactly why the retired `--bg-inverted-hover`
      // existed as five hand-tuned per-theme hexes.
      //
      // Scope is a LABELLED control: the same class string also spends horizontal
      // padding or a control height. That is what separates a button from the
      // indicators legitimately painted in the ink tier — a Switch knob, a wizard
      // step dot, a checked radio — which take the fill and nothing else.
      const INK_FILL = /bg-\[(?:color:)?var\(--text-strong\)\]/
      const LABELLED_CONTROL = /(?:^|\s)(?:px-\S+|h-control-(?:xs|sm|md))(?=\s|$)/

      const offenders: string[] = []
      for (const path of rendererSources()) {
        for (const match of withoutComments(path).matchAll(STRING_LITERALS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          if (!INK_FILL.test(text) || !LABELLED_CONTROL.test(text)) continue
          offenders.push(`${relative(process.cwd(), path)}: ${text.trim().slice(0, 80)}`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'the one solid fill a view spends on an action is --accent-primary, through ui/PrimaryButton',
      )
    })

    await run('on-accent ink is --text-on-accent, never the app canvas', () => {
      // The two coincide on the dark default, so this reads as correct until the
      // first theme where they do not — and there are nineteen. Rejected outright
      // rather than only in accent company: `--bg-app` is a SURFACE token, and
      // there is no control whose label is legitimately painted with the colour
      // of the window behind it.
      const CANVAS_AS_INK = /text-\[(?:color:)?var\(--bg-app\)\]/

      const offenders: string[] = []
      for (const path of rendererSources()) {
        for (const match of withoutComments(path).matchAll(STRING_LITERALS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          if (!CANVAS_AS_INK.test(text)) continue
          offenders.push(`${relative(process.cwd(), path)}: ${text.trim().slice(0, 80)}`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a label on an accent fill takes --text-on-accent, the token that tracks the accent per theme',
      )
    })

    await run('every labelled button in the Git surfaces sits on the control ramp', () => {
      // Named files, not "every file": the ramp split was THIS panel family's, and
      // a rule phrased over the whole tree would be a repo-wide height sweep that
      // the button sweep did not do and this suite would then be asserting falsely. The
      // rest of the tree drains through the `designSystemAxes` ratchet.
      //
      // Scope inside them is an INTERACTIVE control: a class string that spends a
      // height AND a hover fill. The hover fill is what makes it a control rather
      // than a box — it is the one thing a resting container never declares — and
      // it is why the commit message's `h-16` textarea is not caught here. A
      // multi-line field is not a step on a ramp whose steps are 26/30/34, and
      // widening this to every height would make the rule a repo-wide field sweep
      // wearing a button rule's name.
      //
      // `components/panels/git/**` joined the family on 2026-09-09. T5 and T6
      // moved the Changes view out of `GitPanel.tsx` into six files in that
      // directory, and the rule they were written under stopped covering them the
      // moment they were extracted — a named-file rule that a refactor can walk
      // out of polices the past. A DIRECTORY, not three more file names, so the
      // next file added there is policed on the day it lands.
      const GIT_SURFACE_DIR = 'components/panels/git/'
      const GIT_SURFACES = [
        'components/panels/GitPanel.tsx',
        'components/panels/GitConflictResolverPanel.tsx',
        'components/panels/GitGraphView.tsx',
        ...rendererSources()
          .map((path) => relative(join(process.cwd(), 'src/renderer/src'), path))
          .filter((file) => file.startsWith(GIT_SURFACE_DIR))
          .sort(),
      ]
      assert.ok(
        GIT_SURFACES.some((file) => file.startsWith(GIT_SURFACE_DIR)),
        'the Changes view still lives in components/panels/git — if it moved, move this rule with it',
      )
      const OFF_RAMP_HEIGHT = /(?:^|\s)h-(?:\d+(?:\.\d+)?|\[\d+(?:\.\d+)?px\])(?=\s|$)/
      const HOVER_FILL = /(?:^|\s)hover:bg-\S+(?=\s|$)/

      const offenders: string[] = []
      for (const file of GIT_SURFACES) {
        const path = join(process.cwd(), 'src/renderer/src', file)
        for (const match of withoutComments(path).matchAll(STRING_LITERALS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          if (!OFF_RAMP_HEIGHT.test(text) || !HOVER_FILL.test(text)) continue
          offenders.push(`${file}: ${text.trim().slice(0, 80)}`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'heights come from h-control-xs/sm/md (26/30/34) — reach for ui/Buttons rather than typing one',
      )
    })

    await run('the dialog footer button IS the kit primitive, not a fourth one', () => {
      // `ModalButton` is a name for the footer's three roles, nothing more. It
      // shipped as its own control — padding-sized rather than ramp-heighted, at a
      // 6px radius against the kit's 5px — which made it the third rival primary
      // and put every dialog a pixel or two off every panel. Asserted on the
      // source because what matters is that the variants RESOLVE to the
      // primitives; a copy of their classes would render identically today and
      // drift on the first edit to either.
      // Comments stripped: the file's own prose names the retired class string as
      // the thing it retired, and prose is not a class string.
      const modal = withoutComments(join(process.cwd(), 'src/renderer/src/components/ui/Modal.tsx'))
      for (const primitive of ['PrimaryButton', 'GhostButton', 'DangerButton']) {
        assert.match(modal, new RegExp(`\\b${primitive}\\b`), `the ${primitive} variant is the kit primitive`)
      }
      assert.ok(
        !/rounded-md px-3\.5 py-2/.test(modal),
        'no padding-sized footer button survives: the footer takes a step on the control ramp',
      )
    })

    // --- 2112: one header anatomy, one height ---------------------------------
    // Source-read for the same reason the z and selection rules are: the surfaces
    // are whole app screens that cannot be mounted here, and the rule is about the
    // literal a developer types.
    //
    // `ui/PanelHeader` is the identity row — `px-3 py-2`, title at
    // `text-body font-semibold`, at most one `primaryAction` — and adoption was
    // roughly half. The other half each picked its own inset and type size
    // (`h-11 px-4`, `px-5 py-4`, `px-6 py-3`, `min-h-10`, `px-3 pb-2 pt-4`), so
    // the one row a person scans FIRST to know where they are was the least
    // consistent row in the product: two sibling panels started their content at
    // different heights.
    //
    // Scope is a header BAND: a class string that draws a bottom hairline and
    // pads itself vertically, in the swept directories. What it rejects is a
    // vertical inset that is not the primitive's `py-2` — that is what a
    // difference in height IS. A band with no title in it (a search row, a filter
    // strip, a status band) is not a header and is left alone, which is why the
    // rule reads the element's own tag and text rather than the class string
    // alone.
    await run('2112 no panel hand-rolls a header band at its own height', () => {
      // The directories this rule covers. A rule phrased over the whole renderer
      // would fire on chrome that is legitimately not a panel identity row (the
      // window frame, the tab strips), and a rule phrased over one file would
      // pass the day someone adds a twelfth dialect next door.
      //
      // The list GROWS as surfaces converge, and that is the point: a directory
      // scope plus an unscoped acceptance claim ("the sweep is complete") is how
      // four bands survived three sweeps — each was outside the four directories
      // below and so read as done without being done. The four added
      // here are that item's: the kit's own `FilePreviewPane` and the
      // `WorkspacePanel` shell, the knowledge-graph preview drawer, and the HTML
      // artifact frame's bands, which drew their rule in a SURFACE token.
      const SWEPT = [
        'components/panels',
        'components/memory',
        'components/ui',
        'components/htmlArtifact',
        'components/workspace/agentComposer',
        'components/workspace/topbar',
      ]
      // `<header>` is the tag every one of the eleven dialects reached for, and it
      // is the honest marker of intent: an element declaring itself the header of
      // its section. `PanelHeader` renders the only one that should exist.
      const HEADER_TAG = /<header\b[^>]*className=\{?["'`]([^"'`]*)["'`]/g
      // The primitive's own inset. Anything else is a different height.
      const OWN_VERTICAL_INSET = /(?:^|\s)(?:-?(?:py|pt|pb)-(?!2(?:\s|$))\S+|h-\d+|h-\[\d+px\]|min-h-\d+)(?=\s|$)/

      const offenders: string[] = []
      for (const path of rendererSources()) {
        const relative_ = relative(join(process.cwd(), 'src/renderer/src'), path)
        if (path.endsWith('components/ui/PanelHeader.tsx')) continue
        if (!SWEPT.some((dir) => relative_.startsWith(dir))) continue
        for (const match of withoutComments(path).matchAll(HEADER_TAG)) {
          const classes = match[1]
          if (!/border-b/.test(classes)) continue
          const inset = classes.match(OWN_VERTICAL_INSET)
          if (!inset) continue
          offenders.push(`${relative(process.cwd(), path)}: <header ...${inset[0].trim()}>`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a panel names itself through `ui/PanelHeader`, which is what makes every panel start at the same ' +
          'height; a <header> that draws its own rule and sets its own vertical inset is a twelfth dialect',
      )
    })

    await run('2112 no PanelHeader consumer stacks two controls in primaryAction', () => {
      // `primaryAction` is ONE action; extras belong in `overflow`. Two sites had
      // stuffed a fragment of two IconButtons into it, which is how a header grows
      // an action cluster that differs per panel. A fragment is the only way to
      // pass two nodes through one slot, so a fragment opening the prop IS the
      // violation — and it is exactly what the two offenders wrote.
      const FRAGMENT_IN_PRIMARY = /primaryAction=\{\s*<>/
      const offenders: string[] = []
      for (const path of rendererSources()) {
        if (FRAGMENT_IN_PRIMARY.test(withoutComments(path))) {
          offenders.push(relative(process.cwd(), path))
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'PanelHeader takes one `primaryAction`; a fragment in that slot is two controls wearing one slot, and ' +
          'the second belongs in `overflow`',
      )
    })

    await run('2112 the header primitive draws the one anatomy every panel adopts', () => {
      // The consumers above are only converged if the thing they converged ON
      // still measures what it did. This is the anatomy the whole item is phrased
      // against, asserted on the primitive's own source so a change to it has to
      // be deliberate rather than a silent re-scatter of every panel.
      const header = readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/PanelHeader.tsx'), 'utf8')
      assert.match(header, /px-3 py-2/, 'the identity row is `px-3 py-2` — that inset IS the shared height')
      assert.match(
        header,
        /text-body font-semibold/,
        'and its title is `text-body font-semibold`, not a per-panel type step',
      )
      assert.match(
        header,
        /border-b border-\[color:var\(--border-default\)\]/,
        'and the rule it draws is the default border, not the subtle one',
      )
    })

    // --- the menu row canon, outside the kit that declares it --------
    // Source-read for the reason the header-band rule above is: the surfaces are
    // whole app screens, and the rule is about the literal a developer types.
    //
    // The menu sweep put the menu's material in `ui/menuClasses` and converged the five
    // kit hosts onto it. What survived was every menu row the kit does not own:
    // both in-app menubar fallbacks, the account menu, the reasoning
    // selector. Each was the same hand-roll — `rounded px-2`
    // or `px-3`, its own type step, no disabled state, an OUTSET focus ring — and
    // each was internally consistent, so nothing read as wrong until two of them
    // were opened side by side. The menubar pair is the clearest case: the same
    // menu, drawn at `text-body` in one file and `text-heading` in the other.
    //
    // Scope is the same growing prefix list the band rule keeps, for the same
    // reason: a rule over the whole renderer would assert a convergence that has
    // not happened (the composer still hand-rolls rows). Four entries name a
    // FILE rather than a directory, and that
    // is a statement about their neighbourhood, not a dodge — `components/
    // workspace` and `.../agentComposer` still hold unconverged rows, so the ones
    // that converged are named until their neighbours follow and the entry
    // becomes the directory. Every converged surface is in here: a row that moved
    // onto the canon and then sat outside the guard is the exact shape this item
    // was called in to end.
    const MENU_SWEPT = [
      'components/backlog',
      'components/ui',
      'components/workspace/AppTitleBar.tsx',
      'components/workspace/SidebarAccountBar.tsx',
      'components/workspace/SidebarChrome.tsx',
      'components/workspace/topbar',
    ]

    // A JSX opening tag, sliced exactly: from its `<` to the `>` that closes it,
    // skipping `{…}` nesting and quoted text so an arrow function in a prop
    // (`onClick={() => …}`) cannot cut the tag in half — which is what a
    // `[^<>]*` reach does, and it fails OPEN, reading a hand-rolled row as
    // converged because it never saw the row's className at all.
    const openingTagAt = (source: string, index: number): { tag: string; name: string } | null => {
      const start = source.lastIndexOf('<', index)
      if (start < 0) return null
      const name = /^<([A-Za-z][\w.]*)/.exec(source.slice(start, index))?.[1]
      if (!name) return null
      let cursor = start + 1
      let depth = 0
      while (cursor < source.length) {
        const char = source[cursor]
        if (char === '"' || char === "'" || char === '`') {
          const quote = char
          cursor += 1
          while (cursor < source.length && source[cursor] !== quote) cursor += 1
        } else if (char === '{') depth += 1
        else if (char === '}') depth -= 1
        else if (depth === 0 && char === '>') return { tag: source.slice(start, cursor + 1), name }
        cursor += 1
      }
      return null
    }

    // The role that makes an element a menu row, in all three of its forms.
    const MENU_ROW_ROLE = /\brole="(menuitem(?:checkbox|radio)?)"/g
    // The same per-line exemption the lint scripts honour: a marker on the role's
    // own line or one of the two above it, WITH a reason. Read off the raw source,
    // because the scan the rule runs has already stripped comments.
    const ALLOW_MARKER = /design-tokens-allow:\s*\S/

    // The canon reaches a row either by name or through a local alias the file
    // declares from it — an `itemClass` const shared by several rows. A rule that
    // only accepted the bare identifier would push files into re-typing it per
    // row, which is the failure it exists to prevent.
    const canonAliases = (source: string): RegExp => {
      const names = ['MENU_ITEM_CLASS', 'MENU_ITEM_STACKED_CLASS', 'MENU_ROW_CLASS']
      for (const declaration of source.matchAll(
        /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*([^\n]*(?:\n[^\n]*){0,4})/g,
      )) {
        if (!new RegExp(`\\b(?:${names.join('|')})\\b`).test(declaration[2])) continue
        names.push(declaration[1])
      }
      return new RegExp(`\\b(?:${names.join('|')})\\b`)
    }

    // Comments blanked in place rather than removed, so a line number computed
    // from this string still addresses the same line of the file — which is what
    // the marker scan below reads.
    const withoutCommentsKeepingLines = (path: string): string =>
      readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

    const menuRows = (
      path: string,
    ): Array<{ line: number; tag: string; name: string; allowed: boolean; canon: boolean }> => {
      const raw = readFileSync(path, 'utf8').split('\n')
      const source = withoutCommentsKeepingLines(path)
      const canon = canonAliases(source)
      const found: Array<{ line: number; tag: string; name: string; allowed: boolean; canon: boolean }> = []
      for (const match of source.matchAll(MENU_ROW_ROLE)) {
        const sliced = openingTagAt(source, match.index as number)
        const line = source.slice(0, match.index).split('\n').length
        if (!sliced) {
          // Fail LOUD, never open: a role the slicer cannot resolve to a tag is a
          // row this rule did not read, and a guard that silently skips what it
          // cannot parse is the shape of a green suite over an unswept file.
          found.push({ line, tag: '', name: 'unresolved', allowed: false, canon: false })
          continue
        }
        const allowed = raw.slice(Math.max(0, line - 3), line).some((text) => ALLOW_MARKER.test(text))
        found.push({ line, tag: sliced.tag, name: sliced.name, allowed, canon: canon.test(sliced.tag) })
      }
      return found
    }

    await run('every swept menu row is the shared row, not a copy of it', () => {
      const offenders: string[] = []
      for (const path of rendererSources()) {
        const relative_ = relative(join(process.cwd(), 'src/renderer/src'), path)
        if (!MENU_SWEPT.some((dir) => relative_.startsWith(dir))) continue
        for (const row of menuRows(path)) {
          if (row.allowed || row.canon) continue
          offenders.push(`${relative(process.cwd(), path)}:${row.line}: <${row.name} role="menuitem…">`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a menu row is `MENU_ITEM_CLASS` from ui/menuClasses (or `MENU_ITEM_STACKED_CLASS`, the one ruled ' +
          'second shape); a row that is deliberately neither takes a dated `design-tokens-allow:` marker ' +
          'naming why, on its own line or one of the two above it',
      )
    })

    await run('no swept menu surface pads itself horizontally', () => {
      // `MENU_LIST_CLASS` is vertical padding ONLY: horizontal surface padding is
      // what forces the inset rounded fill the menu spec rules out, and it is the
      // shape every one of these surfaces had (`p-1`, and `w-44 p-1` twice over).
      // Scope is a surface a host declares a MENU — the same file spelling
      // `popupRole="menu"` — so a listbox or a dialog popover is left alone.
      const SURFACE_CLASS = /surfaceClassName=(?:\{`([^`]*)`\}|"([^"\n]*)"|\{"([^"\n]*)"\})/g
      const HORIZONTAL_INSET = /(?:^|\s)(-?p[xlr]?-\S+)(?=\s|$)/

      const offenders: string[] = []
      for (const path of rendererSources()) {
        const relative_ = relative(join(process.cwd(), 'src/renderer/src'), path)
        if (!MENU_SWEPT.some((dir) => relative_.startsWith(dir))) continue
        const source = withoutCommentsKeepingLines(path)
        if (!/popupRole="menu"/.test(source)) continue
        for (const match of source.matchAll(SURFACE_CLASS)) {
          const text = match[1] ?? match[2] ?? match[3] ?? ''
          const inset = text.match(HORIZONTAL_INSET)
          if (!inset) continue
          const line = source.slice(0, match.index).split('\n').length
          offenders.push(`${relative(process.cwd(), path)}:${line}: ${inset[0].trim()}`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a menu surface takes `MENU_LIST_CLASS` and a width; the inset belongs to the row, which fills to ' +
          'both edges',
      )
    })

    await run('a menu row is a control, never a div wearing the role', () => {
      // Renderer-wide, unlike the two above: this is not a convergence claim but
      // an accessibility one, and it holds everywhere already. `role="menuitem"`
      // announces something a person can activate. The notifications popover put
      // it on the `<div>` wrapping each report — a block that carries its own Copy
      // and Open logs buttons INSIDE it, so it was never one activatable thing.
      // A screen-reader user heard a menu of rows that do nothing.
      const CONTROL = new Set(['button', 'a'])
      const offenders: string[] = []
      for (const path of rendererSources()) {
        for (const row of menuRows(path)) {
          // A capitalised tag is a component, which forwards the role to whatever
          // control it renders; that is the composition, not the defect.
          if (row.name[0] === row.name[0].toUpperCase()) continue
          if (CONTROL.has(row.name)) continue
          offenders.push(`${relative(process.cwd(), path)}:${row.line}: <${row.name} role="menuitem…">`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a menu row is a <button> (or an <a> that navigates): the role promises an activation, and a div ' +
          'has none to give',
      )
    })

    // --- one input vocabulary, one Field, one control ramp -----------
    // The product carried EIGHT hand-rolled field vocabularies plus a ninth found
    // during the sweep, and two different components both exported as `Field`
    // through the same barrel — one of them with no `htmlFor` and no ARIA at all,
    // which is the one several panel dialogs happened to import. Heights landed on
    // 32 / 34 / h-7 / h-8 / h-9 / h-10 / h-11, mostly off the 26/30/34 ramp.
    //
    // Three of the four rules below are source-read, for the reason the z and
    // geometry rules above are: the surfaces are whole app screens that cannot be
    // mounted here, and each rule is about the literal a developer types. The
    // fourth is mounted, because label association is behaviour, not markup.

    // The files this item swept. Named rather than phrased over the renderer for
    // the reason the Git-surfaces rule names its three: the vocabularies were
    // THESE files', and a tree-wide rule would be a repo-wide field sweep wearing
    // this item's name — asserting a convergence that did not happen.
    const SWEPT_FIELD_SURFACES = [
      'components/panels/BacklogCreateDialog.tsx',
      'components/panels/ConnectorsPanel/CustomMcpServerForm.tsx',
      'components/panels/FileExplorer.tsx',
      'components/settings/ProjectKnowledgeList.tsx',
      'components/settings/ProviderSettingsTab.tsx',
      'components/settings/SettingsPanel.tsx',
    ]

    /**
     * Rulings, not debt: a swept field that stays off the kit WITH its reason on
     * the record. Keep this list short — an entry that is really "we did not get
     * to it" belongs in the sweep, not here.
     */
    const FIELD_RULINGS: Record<string, string> = {
      'components/panels/FileExplorer.tsx':
        'the tree rename field is `h-5` (20px), below the ramp on purpose: it replaces the name ' +
        'INSIDE a 22px file-tree row, and a ramp-height field would push every sibling row down ' +
        'while one is being renamed. Annotated at the call site.',
    }

    // A JSX field tag and everything it declares, up to its self-closing bracket.
    // `/>` is the terminator rather than `>` because an arrow function in a prop
    // (`onChange={(e) => …}`) contains `>` and would cut the tag in half.
    const FIELD_TAG = /<(input|textarea)\b[\s\S]*?\/>/g
    // A FIELD BOX: a border and a ground, both from the token layer. That pairing
    // is the honest definition of "this element draws its own field" — and it is
    // what all nine vocabularies had. It deliberately does NOT catch a transparent
    // in-place editor (`border-transparent bg-transparent`, the run-name and
    // automation-name idiom), which draws no box at rest and is the kit's
    // `INLINE_TITLE_EDIT_CLASS`.
    // Boundaries are quote-or-space, not `\s` alone: a class string that OPENS
    // with the token (`className="h-8 w-full …"`) has a quote in front of it, and
    // a whitespace-only boundary would read that as no match at all — which is
    // exactly the shape a freshly hand-rolled field takes.
    const OWN_BORDER = /(?:^|["'`\s])border-\[(?:color:)?var\(--border-[a-z]+\)\]/
    const OWN_GROUND = /(?:^|["'`\s])bg-\[(?:color:)?var\(--bg-[a-z-]+\)\]/

    await run('no swept surface hand-rolls a field box — the box is ui/Input', () => {
      const offenders: string[] = []
      for (const file of SWEPT_FIELD_SURFACES) {
        if (FIELD_RULINGS[file]) continue
        const source = withoutComments(join(process.cwd(), 'src/renderer/src', file))
        for (const tag of source.matchAll(FIELD_TAG)) {
          if (!OWN_BORDER.test(tag[0]) || !OWN_GROUND.test(tag[0])) continue
          offenders.push(`${file}: <${tag[1]} …> draws its own border and ground`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a text field is `ui/Input` (or `ui/Textarea`): the eight vocabularies this item retired were each ' +
          'one file deciding its own radius, ground, inset and focus treatment, and two of them were literal ' +
          'copies of each other kept in sync by hand',
      )
    })

    await run('every swept field sits on the 26/30/34 control ramp', () => {
      // A height spelled as a Tailwind step or a pixel count is by definition not
      // a step on the ramp — the ramp is reachable only as `h-control-xs/sm/md`,
      // which is what makes moving it a one-line edit. `min-h-`/`max-h-` are left
      // alone: a textarea's floor and cap are a content measure, not a ramp step,
      // which is why `ui/Textarea` takes no height of its own.
      const OFF_RAMP_HEIGHT = /(?:^|["'`\s])h-(?:\d+(?:\.\d+)?|\[\d+(?:\.\d+)?(?:px|rem)\])(?=["'`\s]|$)/
      const offenders: string[] = []
      for (const file of SWEPT_FIELD_SURFACES) {
        if (FIELD_RULINGS[file]) continue
        const source = withoutComments(join(process.cwd(), 'src/renderer/src', file))
        for (const tag of source.matchAll(FIELD_TAG)) {
          const height = tag[0].match(OFF_RAMP_HEIGHT)
          if (!height) continue
          offenders.push(`${file}: <${tag[1]} … ${height[0].trim()}>`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'heights come from h-control-xs/sm/md (26/30/34) — pass `size` to ui/Input rather than typing one; ' +
          'a deliberate exception takes a ruling in FIELD_RULINGS, not a silent arbitrary',
      )
    })

    await run('exactly one Field is exported from the kit, and nobody imports a second', () => {
      const barrel = readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/index.ts'), 'utf8')
      const exportsField = barrel
        .split('\n')
        .filter((line) => /^export\b/.test(line) && /(?:^|[{,\s])Field(?=[},\s])/.test(line))
      assert.equal(
        exportsField.length,
        1,
        `the barrel exports Field exactly once; found: ${exportsField.join(' | ') || 'none'}`,
      )
      assert.match(exportsField[0], /from '\.\/Field'/, 'and it is ui/Field, the one with the ARIA wiring')

      // `ui/Modal` exported the second one. A re-export from anywhere else is the
      // same failure wearing a different address, so the rule reads every kit file
      // rather than just that one.
      const kitDir = join(process.cwd(), 'src/renderer/src/components/ui')
      const declaresField: string[] = []
      for (const name of readdirSync(kitDir)) {
        if (!/\.tsx?$/.test(name) || /\.test\./.test(name)) continue
        if (name === 'Field.tsx' || name === 'index.ts') continue
        const source = withoutComments(join(kitDir, name))
        if (/export\s+(?:function|const)\s+Field\b/.test(source)) declaresField.push(name)
      }
      assert.deepEqual(
        declaresField,
        [],
        'a second component named Field means whoever imports "the" Field gets a coin flip — and the one ' +
          'that shipped without htmlFor or ARIA is the one four dialogs happened to draw',
      )

      // And no consumer still reaches for it by its old address.
      const importers = rendererSources()
        .filter((path) => /import\s*\{[^}]*\bField\b[^}]*\}\s*from\s*'[^']*ui\/Modal'/.test(withoutComments(path)))
        .map((path) => relative(process.cwd(), path))
      assert.deepEqual(importers, [], 'Field comes from `../ui`, never from `../ui/Modal`')
    })

    await run('a Field that names a control wraps a control, not a wrapper div', () => {
      // `Field` clones its `htmlFor` onto its child. Given a layout wrapper the id
      // lands on a `<div>` — which cannot be labelled, so the `<label for>`
      // addresses nothing — and where the composite ALSO held a real field
      // carrying that same id (the webhook secret), the document had the id twice
      // and the label resolved to the div. Three rows shipped that way. The fix is
      // to omit `htmlFor` on a composite: the label renders as a span and the
      // caller names the group or the control inside it.
      //
      // Read from source because the shape is a JSX authoring mistake, and it
      // renders as a perfectly ordinary-looking row.
      const FIELD_WITH_FOR = /<Field\b[^>]*\bhtmlFor=[^>]*>\s*(?:\{[^\n]*)?\s*<([A-Za-z][\w.]*)/g
      // The tags a `<label for>` can legitimately address. A capitalised tag is a
      // component — `Input`, `Textarea`, `Select`, `Combobox` — and those forward
      // the cloned id to a real control, which is the whole contract.
      const LABELLABLE = new Set(['input', 'textarea', 'select'])

      const offenders: string[] = []
      for (const path of rendererSources()) {
        const source = withoutComments(path)
        for (const match of source.matchAll(FIELD_WITH_FOR)) {
          const tag = match[1]
          if (tag[0] === tag[0].toUpperCase() || LABELLABLE.has(tag)) continue
          const line = source.slice(0, match.index).split('\n').length
          offenders.push(`${relative(process.cwd(), path)}:${line}: <Field htmlFor …><${tag}>`)
        }
      }
      assert.deepEqual(
        offenders,
        [],
        'a Field with `htmlFor` must wrap the control it names; a composite row omits `htmlFor` and names ' +
          'itself (`role="group" aria-label`, or `aria-label` on the control inside)',
      )
    })

    // Mounted, not read: a label that points at nothing renders identically to one
    // that works. Before this item a `Field` wrapping a `Select` produced exactly
    // that — the Select took no `id`, so the `<label htmlFor>` addressed an element
    // that did not exist and the visible label named nothing.
    const fieldContainer = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(fieldContainer)
    const fieldRoot = createRoot(fieldContainer)
    const { Field } = await import('./Field')
    const { Input, Textarea } = await import('./Input')
    const { Select } = await import('./Select')
    act(() => {
      fieldRoot.render(
        // JSX, not createElement: Field's REQUIRED `children` prop breaks
        // createElement's overload resolution (TS2769) — JSX children inference
        // handles it.
        <div>
          <Field key="text" label="Server id" htmlFor="seam-field-input" help="Lowercase.">
            <Input value="" onChange={() => {}} />
          </Field>
          <Field key="multiline" label="Description" htmlFor="seam-field-textarea">
            <Textarea value="" onChange={() => {}} rows={3} />
          </Field>
          <Field key="choice" label="Transport" htmlFor="seam-field-select">
            <Select
              ariaLabel="Transport"
              items={[{ value: 'stdio', label: 'stdio' }]}
              value="stdio"
              onChange={() => {}}
            />
          </Field>
          {/* The composite form: no `htmlFor`, so nothing is cloned and the
            group names itself. */}
          <Field key="composite" label="Event types">
            <div role="group" aria-label="Event types" id="seam-field-group">
              <button type="button">created</button>
            </div>
          </Field>
        </div>,
      )
    })

    await run('a Field labels a real control — an input, a textarea, and a Select alike', () => {
      for (const id of ['seam-field-input', 'seam-field-textarea', 'seam-field-select']) {
        const label = fieldContainer.querySelector(`label[for="${id}"]`)
        assert.ok(label, `the Field renders a <label for="${id}">`)
        const control = fieldContainer.querySelector(`#${id}`)
        assert.ok(control, `and an element actually carries that id — a label pointing at nothing is not a name`)
      }
      // The Select's tab stop IS the labelled element, not a wrapper beside it.
      const selectControl = fieldContainer.querySelector('#seam-field-select')
      assert.equal(selectControl?.getAttribute('role'), 'combobox', 'the id lands on the Select trigger')
      // Help text is wired, not merely rendered.
      const input = fieldContainer.querySelector('#seam-field-input')
      assert.equal(
        input?.getAttribute('aria-describedby'),
        'seam-field-input-help',
        'help text is referenced by the control it supports',
      )
    })

    await run('a Field with no htmlFor labels nothing and clones nothing', () => {
      // The composite form has to be honest in both directions: no `<label for>`
      // pointing at an element that cannot be labelled, and no id smuggled onto
      // the caller's wrapper — which is what silently replaced the group's own id
      // before, and would have collided with any real field inside it.
      const group = fieldContainer.querySelector('[role="group"]')
      assert.ok(group, 'the composite row mounted')
      assert.equal(group?.id, 'seam-field-group', 'the caller keeps its own id — the Field clones nothing')
      const labels = Array.from(fieldContainer.querySelectorAll('label')) as Element[]
      for (const label of labels) {
        const target = label.getAttribute('for')
        assert.ok(target, 'a <label> here always carries a `for`')
        assert.ok(
          fieldContainer.querySelector(`#${target}`),
          `the <label for="${target}"> addresses an element that exists`,
        )
      }
      assert.ok(
        !labels.some((label) => label.textContent?.startsWith('Event types')),
        'the composite label renders as a span, not a <label> that names nothing',
      )
    })

    await run('the kit field draws one ramp height and one focus treatment', () => {
      const input = fieldContainer.querySelector('#seam-field-input') as Element
      const classes = classesOf(input)
      assert.ok(
        classes.includes('h-control-sm'),
        'the default step is `sm` (30px) — a ramp token, not a typed pixel count',
      )
      assert.ok(
        classes.includes('focus-visible:focus-ring'),
        'and focus is the shared ring utility, written as one literal Tailwind can see',
      )
      for (const element of [input, fieldContainer.querySelector('#seam-field-textarea') as Element]) {
        for (const token of classesOf(element)) {
          assert.ok(
            !/^(?:group-|peer-)?focus(?:-within|-visible)?:border-/.test(token),
            `a field wears the ring, never a border swap — found \`${token}\``,
          )
        }
      }
    })

    act(() => {
      fieldRoot.unmount()
    })
    fieldContainer.remove()

    if (failures > 0) {
      console.error(`designSystemConformance.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('designSystemConformance.test.tsx: ok')
  }

  const suiteRun = main()

  await suiteRun
})
