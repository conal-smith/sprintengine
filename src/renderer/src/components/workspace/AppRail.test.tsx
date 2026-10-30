import assert from 'node:assert/strict'

// The app rail (Extensions drawer ruling, 2026-09-05): THREE named glyphs —
// Home, Automations, Extensions — and a divider that starts below the title
// strip. The contract is the WIRING and the geometry: a section glyph selects
// its section, the one promoted surface glyph opens its surface and reads
// pressed while it floats, no glyph spells its name as row text, and the
// right-hand hairline clears the macOS traffic lights' band.
import { JSDOM } from 'jsdom'

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RegisteredGlobalSurface } from '../../modules/renderer-host'
import {
  APP_RAIL_WIDTH,
  AppRail,
  RAIL_SURFACE_IDS,
  TRAFFIC_LIGHT_RESERVE,
  railSurfacesOf,
  type RailBadges,
  type RailSurface,
} from './AppRail'
import { TITLE_BAR_HEIGHT, TITLE_BAR_HEIGHT_PX } from './AppTitleBar'
import { test } from 'vitest'

test('AppRail', async () => {
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
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  domWindow.api = {}

  const surface = (id: string, label: string): RegisteredGlobalSurface => ({
    id,
    moduleId: 'design',
    label,
    Icon: ({ className }: { className?: string }) => React.createElement('svg', { className }),
    Component: () => null,
  })

  // ── The pure picks ────────────────────────────────────────────────────────────
  // Plugins left the rail (Extensions drawer ruling): it is one of the rows
  // UNDER Extensions, not a thing standing beside it.
  // Automations stood on the rail until scheduled agents replaced it
  // (2026-09-30); nothing is promoted today, so the host's registered doors
  // contribute no square, whatever is registered.
  assert.deepEqual([...RAIL_SURFACE_IDS], [], 'no surface is promoted to the rail today')
  assert.deepEqual(
    railSurfacesOf([surface('design', 'Design'), surface('extensions', 'Plugins')]),
    [],
    'nothing registered takes a rail square unless the list promotes it',
  )
  assert.ok(
    APP_RAIL_WIDTH < TRAFFIC_LIGHT_RESERVE,
    'the rail is narrower than the traffic lights, so the sidebar chrome insets for the rest',
  )

  // ── The rendered rail ─────────────────────────────────────────────────────────
  const selected: string[] = []
  const opened: string[] = []
  function render(
    section: 'home' | 'extensions',
    activeGlobalSurface: string | null,
    // The component draws whatever surfaces the host hands it; a probe stands
    // in for a promoted one.
    surfaces: RailSurface[] = [surface('tides', 'Tides') as RailSurface],
    badges?: RailBadges,
  ) {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host as unknown as Element)
    act(() => {
      root.render(
        React.createElement(AppRail, {
          section,
          onSelectSection: (next) => selected.push(next),
          surfaces,
          activeGlobalSurface,
          onOpenSurface: (s) => opened.push(s.id),
          badges,
        }),
      )
    })
    return host
  }
  const nav = () => dom.window.document.querySelector('nav[aria-label="App rail"]') as HTMLElement
  const allButtons = () =>
    [...dom.window.document.querySelectorAll('nav[aria-label="App rail"] button')] as HTMLElement[]
  // The section and surface glyphs; the brand mark at the foot is checked on its own.
  const buttons = () => allButtons().filter((b) => !b.hasAttribute('data-build'))

  render('home', null)
  const brand = allButtons().at(-1)
  assert.equal(
    brand?.getAttribute('aria-label'),
    'Open the GitHub repository',
    'the brand mark is the last thing in the rail, where it sits below the account cluster',
  )
  assert.equal(brand?.textContent, 'se', 'the brand is the icon’s "se", never the full wordmark')
  assert.ok((brand?.getAttribute('class') ?? '').includes('size-control-lg'), 'the mark sits on a rail square')
  assert.deepEqual(
    buttons().map((b) => b.getAttribute('aria-label')),
    ['Home', 'Tides', 'Extensions'],
    'three named glyphs: Home, the promoted surface, Extensions',
  )
  assert.ok(
    buttons().every((b) => (b.textContent ?? '').trim() === ''),
    'a glyph spells no caption: its name is the tooltip and the accessible name',
  )
  assert.ok(
    buttons().every((b) => (b.getAttribute('class') ?? '').includes('size-control-lg')),
    'every square is the rail’s own control-lg step (owner, 2026-09-07: large control step, found rather than read)',
  )
  assert.equal(APP_RAIL_WIDTH, 56, 'one control-lg square plus a space.sm gutter each side')
  assert.ok(
    buttons().every((b) => (b.getAttribute('class') ?? '').includes('focus-visible:focus-ring')),
    'every glyph carries the shared focus ring — the rail is reachable by keyboard',
  )
  assert.equal(buttons()[0]?.getAttribute('aria-current'), 'page', 'the showing section reads current')
  assert.equal(buttons()[2]?.getAttribute('aria-current'), null)
  assert.equal(
    buttons()[1]?.getAttribute('aria-pressed'),
    'false',
    'a surface glyph reads unpressed while its surface is closed',
  )

  act(() => {
    buttons()[2]?.click()
  })
  assert.deepEqual(
    selected,
    ['extensions'],
    'the Extensions glyph selects its section (the host opens the Extensions home with it)',
  )
  act(() => {
    buttons()[1]?.click()
  })
  assert.deepEqual(opened, ['tides'], 'a surface glyph opens its surface')

  // ── The badges ───────────────────────────────────────────────────────────────
  // The rail's unread activity badge: a count docked on the square, in the tone of
  // the loudest thing it counts, named for a screen reader. Never a zero.
  dom.window.document.body.innerHTML = ''
  render('home', null, undefined, {
    home: { count: 3, tone: 'warn', label: '3 chats want you' },
    tides: { count: 120, tone: 'error', label: '120 tide tables to look at' },
    extensions: null,
  })
  {
    const badgeIn = (b: HTMLElement | undefined) => b?.querySelector('[role="status"]') as HTMLElement | null
    assert.equal(badgeIn(buttons()[0])?.textContent, '3', 'Home wears the count of chats wanting you')
    assert.equal(
      badgeIn(buttons()[0])?.getAttribute('aria-label'),
      '3 chats want you',
      'and the badge is named, not a bare number',
    )
    assert.ok(
      (buttons()[0]?.getAttribute('class') ?? '').includes('relative'),
      'the square is the badge’s positioning context',
    )
    assert.equal(badgeIn(buttons()[1])?.textContent, '99+', 'a surface square wears its own count, capped')
    assert.equal(badgeIn(buttons()[2]), null, 'a null badge draws nothing')
    assert.equal(buttons()[0]?.getAttribute('aria-label'), 'Home', 'the glyph’s own name is unchanged by its badge')
  }
  dom.window.document.body.innerHTML = ''
  render('home', null, undefined, { home: { count: 0, tone: 'good', label: 'nothing' } })
  assert.equal(buttons()[0]?.querySelector('[role="status"]'), null, 'a zero is never drawn')

  // ── The rail's trailing edge draws nothing ───────────────────────────────────
  // It used to draw a positioned hairline starting at the title reserve — offset
  // so it did not cut through the green traffic light, which a full-height
  // `border-r` did. Both are gone (owner, 2026-09-09): the column beside the rail
  // is a rounded card standing on the same frost the rail is made of, so a rule
  // here would separate frost from frost. The card's own edge is the boundary.
  assert.ok(!(nav().getAttribute('class') ?? '').includes('border-r'), 'the rail draws no full-height right border')
  {
    const strips = [...nav().querySelectorAll(':scope > div[aria-hidden="true"]')] as HTMLElement[]
    const divider = strips.find((strip) => (strip.getAttribute('class') ?? '').includes('w-px'))
    assert.equal(divider, undefined, 'and no positioned hairline on that edge either')
    // Read the reserve out of the CLASS the title strip actually renders, not out
    // of the constant this file also passes to the rail: comparing the constant
    // with itself proved only that one number equals itself, and would have gone
    // on passing if the class and the number ever drifted apart.
    const reserveFromClass = Number(/^h-\[(\d+)px\]$/.exec(TITLE_BAR_HEIGHT)?.[1])
    assert.equal(reserveFromClass, TITLE_BAR_HEIGHT_PX, 'the title strip’s class and its px constant are one height')
  }

  dom.window.document.body.innerHTML = ''
  render('extensions', 'tides')
  assert.equal(buttons()[2]?.getAttribute('aria-current'), 'page')
  assert.equal(
    buttons()[1]?.getAttribute('aria-pressed'),
    'true',
    'a surface glyph reads pressed while its door holds the card region',
  )

  // ── A disabled module takes its glyph with it ─────────────────────────────────
  dom.window.document.body.innerHTML = ''
  render('home', null, [])
  assert.deepEqual(
    buttons().map((b) => b.getAttribute('aria-label')),
    ['Home', 'Extensions'],
    'with no promoted surface the rail is Home and Extensions, and the gap closes',
  )

  console.log('AppRail.test.tsx: ok')
})
