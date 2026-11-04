import assert from 'node:assert/strict'

// The Extensions home's tile contract (Extensions drawer ruling, 2026-09-05,
// Stage 3): five tiles, in the drawer's order, opening exactly what the drawer
// rows open, and absent for a module that is switched off.
//
// Mounted against the REAL module registry, like the drawer's own test, because
// the contract is the WIRING. The ruling's words are "tiles ... that open the
// same surfaces the drawer rows do", and the only way to prove "the same" is to
// click both and compare the state each leaves behind — a tile asserted against
// a hand-written expectation would keep passing on the day a view's deep-link
// latch changed under it and only the drawer was updated.
import { JSDOM } from 'jsdom'

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { HostedCard } from '../../../../shared/hosted-card-feed'
import ExtensionsHomeSurface from './ExtensionsHomeSurface'
import { EXTENSIONS_HOME_TILE_SUMMARIES } from './extensionsHomeTiles'
import { ExtensionsRail } from '../workspace/ExtensionsRail'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  consumePendingExtensionsSurfaceTarget,
  type ExtensionsSurfaceTarget,
} from '../workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { setExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import { cardRunsAModel, type CardLaunchChoice } from '../workspace/globalSurface/extensions/home/CardGoPicker'
import { __resetCliPermissionPresetsForTest, setCliPermissionPreset } from '../ui/cliPermissionPresets'
import { test } from 'vitest'

test('ExtensionsHomeSurface', async () => {
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
  // React's change-event POLYFILL, given the two IE methods it reaches for.
  //
  // THIS IS A PROPERTY OF THIS TEST ENVIRONMENT, not of anything the page does.
  // ES imports are hoisted, so the CJS bundle evaluates react-dom before the
  // statements above have put jsdom's globals on `globalThis`: React decides at
  // load that there is no DOM at all and never detects the browser `input` event,
  // and the polyfill it falls back to instead watches ONE focused field at a time
  // and attaches to it through `attachEvent`/`detachEvent`, which jsdom does not
  // have. Without these two no-ops every real focus threw inside React's own
  // dispatch — noise in the log, and worse than noise: the throw came BEFORE the
  // polyfill could let go of the field it was watching, so once the model
  // picker's search box had taken focus the page's own search box could never be
  // tracked again and typing into it silently did nothing. The other way out is a
  // module of its own imported ahead of react-dom, which is a change to how every
  // renderer test in this repo is bootstrapped and not this file's to make.
  const asAny = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  asAny.attachEvent = () => {}
  asAny.detachEvent = () => {}
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  // The page's five readers, stubbed at the preload boundary. The two that are
  // absent here (`skillsListSources`, `listDesignSystemLibrary`) are absent on
  // purpose: every reader is guarded, and a missing one must leave its tile
  // standing with no count line rather than taking the tile down with it.
  domWindow.api = {}

  /** A model id this machine "has", added the way Settings adds one. */
  const MODEL = 'claude-opus-5'

  const RULED_ORDER = ['Design', 'Plugins', 'Skills']

  function mount(element: React.ReactElement): { host: HTMLElement; unmount: () => void } {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host as unknown as Element)
    act(() => {
      root.render(element)
    })
    return {
      host,
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
  }

  const tilesIn = (host: HTMLElement) => [...host.querySelectorAll('ul button')] as HTMLElement[]
  // The name is the tile's first span that is not decorative — the glyph and the
  // chevron wrappers are `aria-hidden`, which is both correct markup and what
  // makes the name findable without depending on child order.
  const nameOf = (tile: HTMLElement) =>
    tile.querySelector(':scope > span:not([aria-hidden])')?.textContent?.trim() ?? ''

  // ── The tiles, in the drawer's order ─────────────────────────────────────────
  const home = mount(React.createElement(ExtensionsHomeSurface))
  assert.deepEqual(
    tilesIn(home.host).map(nameOf),
    RULED_ORDER,
    'the home is the ruling’s three parts in the ruling’s order — the same list the drawer holds, resolved by the same function',
  )

  // Each tile is a real button carrying its own name as text, so it is in the tab
  // order, has an accessible name without an aria-label, and is operable from the
  // keyboard by being a button at all.
  for (const tile of tilesIn(home.host)) {
    assert.equal(tile.tagName, 'BUTTON', 'a tile is a button, not a div with a click handler')
    assert.equal(tile.getAttribute('type'), 'button')
    const name = nameOf(tile)
    assert.ok(name.length > 0, 'a tile names itself in text')
    // The glyph and the chevron say nothing a reader needs — the name is already
    // there — so neither may be announced.
    for (const svg of [...tile.querySelectorAll('svg')]) {
      assert.equal(svg.getAttribute('aria-hidden'), 'true', `${name}: a decorative glyph is hidden from readers`)
    }
  }

  // Each tile carries the summary its id was given, on the tile it belongs to —
  // a copy table keyed by the wrong id would swap two sentences silently.
  const summaryFor: Record<string, string> = {
    Design: EXTENSIONS_HOME_TILE_SUMMARIES.design,
    Plugins: EXTENSIONS_HOME_TILE_SUMMARIES.plugins,
    Skills: EXTENSIONS_HOME_TILE_SUMMARIES.skills,
  }
  for (const tile of tilesIn(home.host)) {
    const name = nameOf(tile)
    assert.ok(tile.textContent?.includes(summaryFor[name]), `${name}: the tile carries its own one-line summary`)
  }

  // ── A feed with nothing in it is the page it was yesterday ───────────────────
  // The store starts with no cards, which is a fresh profile with no network and
  // also an old build meeting a feed of cards whose artwork ships later. Both
  // fall back to the tiles ALONE, and the page says nothing about either: no
  // apology, no notice, no version line (epic rulings R5 and R6).
  assert.equal(home.host.querySelectorAll('article').length, 0, 'no cards, so no card region')
  assert.equal(
    home.host.querySelectorAll('input[type="search"]').length,
    0,
    'and no filter over cards the page is not showing',
  )
  assert.ok(
    !home.host.textContent?.includes('Or go straight to the parts'),
    'the heading arrives with the cards and leaves with them — with nothing above them the tiles ARE the page again',
  )
  for (const apology of [
    'offline',
    'Offline',
    'could not',
    'Could not',
    'unavailable',
    'Unavailable',
    'Retry',
    'try again',
  ]) {
    assert.ok(
      !home.host.textContent?.includes(apology),
      `the page never reports on its own network (R6), and it does not say “${apology}”`,
    )
  }
  // The Community "coming soon" block is GONE (owner, 2026-09-06), and this
  // assertion is inverted rather than deleted so the page cannot quietly grow the
  // promise back.
  //
  // It pinned the block's copy word for word, on the reading that retiring it was
  // an owner call no item had made. The owner made it: the block promised a browse
  // of what other people have published "once the registry scan lands", and
  // nothing has scheduled that scan. Building the browse is not refused, it is
  // unscheduled — so if it returns it returns as a rendered browse, never as this
  // empty state.
  assert.ok(!home.host.textContent?.includes('Coming soon'), 'the page promises nothing that has no owner and no date')
  assert.equal(
    home.host.querySelector('section[aria-labelledby="extensions-community-heading"]'),
    null,
    'and the region it lived in is gone with it, not left empty',
  )
  assert.equal(
    [...home.host.querySelectorAll('input[type="checkbox"], [role="switch"]')].length,
    0,
    'no module switches here: those live in Settings → Modules, and one choice in two shapes on two surfaces is the thing Stage 2 removed',
  )

  // ── A tile opens EXACTLY what the drawer row opens ───────────────────────────
  // Every row the drawer draws is the shell's own, resolved from the real
  // registry by the function both surfaces call — so the two lists are the same
  // list in the same order.
  const drawer = mount(React.createElement(ExtensionsRail, { collapsed: false }))
  const drawerRows = () => [...drawer.host.querySelectorAll('[role="listitem"] button')] as HTMLElement[]
  assert.deepEqual(
    drawerRows().map((row) => row.textContent?.trim()),
    RULED_ORDER,
    'the drawer and the home are the same rows in the same order — they are resolved by one function',
  )
  assert.equal(
    drawer.host.querySelectorAll('[role="listitem"]').length,
    RULED_ORDER.length,
    'and there is one slot per row, no more',
  )

  /**
   * What clicking left behind: the surface it opened — a door in the card
   * region, or the Extensions modal over it (owner ruling 2026-11-03) — and the
   * view it was latched to.
   */
  function landing(click: () => void): { surface: string | null; view: ExtensionsSurfaceTarget | null } {
    act(() => {
      useWorkspaceStore.getState().closeGlobalSurface()
      useWorkspaceStore.getState().closeModalSurface()
    })
    consumePendingExtensionsSurfaceTarget()
    act(click)
    const state = useWorkspaceStore.getState()
    return {
      surface: state.activeGlobalSurface ?? state.activeModalSurface,
      view: consumePendingExtensionsSurfaceTarget(),
    }
  }

  for (const label of RULED_ORDER) {
    const row = drawerRows().find((candidate) => candidate.textContent?.trim() === label)
    const tile = tilesIn(home.host).find((candidate) => nameOf(candidate) === label)
    assert.ok(row && tile, `${label}: both the drawer row and the tile exist`)
    const fromRow = landing(() => row.click())
    const fromTile = landing(() => tile.click())
    assert.deepEqual(
      fromTile,
      fromRow,
      `${label}: the tile lands where the row lands — same surface, same latched view`,
    )
    assert.ok(fromTile.surface, `${label}: and clicking it actually opens something`)
  }

  // A door already open does not change what the next tile does: the view
  // latches before the shell opens, exactly as a drawer row does, so an
  // already-open surface and a cold one both land on the tile that was clicked.
  act(() => {
    useWorkspaceStore.getState().openGlobalSurface('design')
  })
  consumePendingExtensionsSurfaceTarget()
  act(() => {
    tilesIn(home.host)
      .find((tile) => nameOf(tile) === 'Skills')
      ?.click()
  })
  assert.equal(useWorkspaceStore.getState().activeModalSurface, 'extensions', 'the tile opens the Extensions modal')
  assert.equal(useWorkspaceStore.getState().activeGlobalSurface, 'design', 'over the door that was open')
  assert.deepEqual(
    consumePendingExtensionsSurfaceTarget(),
    { view: 'skills' },
    'a tile clicked over an open door latches its view first, like the row does',
  )
  act(() => {
    useWorkspaceStore.getState().closeModalSurface()
    useWorkspaceStore.getState().closeGlobalSurface()
  })

  // ── A disabled module takes its tile with it, as it takes its row ────────────
  act(() => {
    useWorkspaceStore.setState((state) => ({
      appSettings: { ...state.appSettings, modules: { ...state.appSettings.modules, design: false } },
    }))
  })
  assert.deepEqual(
    tilesIn(home.host).map(nameOf),
    ['Plugins', 'Skills'],
    'a tile for a module that is off is absent rather than dead, and the rest keep their order',
  )
  assert.deepEqual(
    drawerRows().map((row) => row.textContent?.trim()),
    tilesIn(home.host).map(nameOf),
    'and the drawer says the same thing at the same moment',
  )

  // ── The cards are the body of the page, and the tiles are the foot ───────────
  // Driven through the store, which is where the page reads the feed from: the
  // main process owns the fetch and WorkspaceManager owns the subscription, so a
  // page that fetched for itself would be a second reader of one file.
  //
  // Every card here SPAWNS — its `go` ends in an `open.chat` — and that is load
  // bearing rather than incidental. `Go` opens the model picker only on a card
  // that runs a model (item
  // `2026-09-06-go-asks-which-model-only-when-a-model-runs`), so a fixture of
  // empty `go` lists would be asserting the picker's whole contract against three
  // cards that are not entitled to one. The other shape — a card that spawns
  // nothing, and the poster with no button at all — gets its own feed further
  // down, which is also the only honest way to hold both against each other.
  const CHAT = { verb: 'open.chat' as const, prompt: 'Do the thing this card is about.', send: true }
  const FEED: HostedCard[] = [
    {
      slug: 'big-task',
      kind: 'showcase',
      title: 'Big task? No problem.',
      dek: 'Hand it something too big for one sitting and let it run.',
      credit: 'Studio',
      art: 'split',
      publishedAt: '2026-09-01T00:00:00.000Z',
      hero: true,
      go: [CHAT],
    },
    {
      slug: 'browser',
      kind: 'mcp',
      title: 'Let an agent drive your browser',
      dek: 'Describe the journey in words. It opens your app and clicks through it.',
      credit: 'Playwright',
      art: 'browser',
      publishedAt: '2026-09-05T00:00:00.000Z',
      go: [CHAT],
    },
    {
      slug: 'street',
      kind: 'showcase',
      title: 'Build a 3D apocalypse of your own street',
      dek: 'Photorealistic tiles of your actual postcode, streamed into Unreal.',
      credit: 'Unreal Engine',
      art: 'city',
      publishedAt: '2026-09-03T00:00:00.000Z',
      go: [CHAT],
    },
    {
      slug: 'from-a-later-release',
      kind: 'skill',
      title: 'A card this build cannot draw',
      dek: 'It names artwork that ships in a release this one has never seen.',
      art: 'artwork-from-a-later-release',
      publishedAt: '2026-09-06T00:00:00.000Z',
      go: [CHAT],
    },
  ]

  act(() => {
    useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
  })

  const cardsIn = (host: HTMLElement) => [...host.querySelectorAll('article')] as HTMLElement[]
  const titleOf = (poster: HTMLElement) => poster.querySelector('h3')?.textContent?.trim() ?? ''

  assert.deepEqual(
    cardsIn(home.host).map(titleOf),
    ['Big task? No problem.', 'Let an agent drive your browser', 'Build a 3D apocalypse of your own street'],
    'the hero leads however old it is, then newest first — and the card naming artwork this build does not hold is not there at all (2467’s ruling)',
  )
  assert.ok(
    !home.host.textContent?.includes('A card this build cannot draw'),
    'a card from a later release is absent, and the page does not mention it (R5, R6)',
  )

  // Layout C (ruling R3): the title sits ON the picture, inside the plate, not in
  // a caption under it. The plate is the element carrying the aspect ratio.
  for (const poster of cardsIn(home.host)) {
    const heading = poster.querySelector('h3')
    assert.ok(heading, `${titleOf(poster)}: the card names itself in a heading`)
    assert.ok(
      heading?.closest('[class*="aspect-"]'),
      `${titleOf(poster)}: the title is over the picture, in the scrim — not under it (layout C)`,
    )
  }
  assert.ok(
    cardsIn(home.host)[0]?.querySelector('[class*="aspect-[2.7/1]"]'),
    'the hero is the wide crop, and nothing else on the page is',
  )
  assert.equal(
    cardsIn(home.host).filter((poster) => poster.querySelector('[class*="aspect-[16/9]"]')).length,
    2,
    'the two columns are 16:9',
  )

  // The hero's plate keeps a floor under it, and its dek keeps a ceiling over it
  // (item `2026-09-06-the-hero-keeps-its-words-on-its-plate`).
  //
  // The arithmetic joining those two numbers lives in `cardSplash.test.tsx`,
  // which is where it belongs; what this asserts is that the composition the page
  // actually mounts still carries both. The failure it stands against is a hero
  // whose plate shrank with the card region while its stack of words did not —
  // first the title over open artwork, then the title clipped — and the dek is
  // the one part of that stack with no clamp of its own to bound it, so a floor
  // derived from a stack the dek can outgrow is not a floor at all.
  const heroPlate = cardsIn(home.host)[0]?.querySelector('[class*="aspect-[2.7/1]"]')
  assert.ok(
    heroPlate?.className.includes('min-h-'),
    'the hero plate has a floor, so its words always have plate to sit on',
  )
  const heroDek = [...(cardsIn(home.host)[0]?.querySelectorAll('p') ?? [])].find((paragraph) =>
    paragraph.textContent?.includes('Hand it something too big for one sitting'),
  )
  assert.ok(
    heroDek?.className.includes('line-clamp-2'),
    'and the hero dek is clamped, which is what gives that floor a height to be derived from',
  )

  // The stamp, the sentences and the credit — Frame 2’s anatomy, in the DOM.
  for (const [title, stamp, credit] of [
    ['Big task? No problem.', 'Showcase', 'Studio'],
    ['Let an agent drive your browser', 'MCP server', 'Playwright'],
    ['Build a 3D apocalypse of your own street', 'Showcase', 'Unreal Engine'],
  ]) {
    const poster = cardsIn(home.host).find((candidate) => titleOf(candidate) === title)
    assert.ok(poster, `${title}: the card is on the page`)
    assert.ok(poster?.textContent?.includes(stamp), `${title}: the stamp says what it is`)
    assert.ok(poster?.textContent?.includes(credit), `${title}: the credit line names the thing`)
  }
  assert.equal(
    [...home.host.querySelectorAll('article ol, article ul')].length,
    0,
    'a card is an advert, never a list of steps (ruling R2)',
  )

  // ── One control per card, named for what it does, and all of them accented ───
  //
  // Both halves of this changed on 2026-09-06 and neither was a bug being fixed:
  //
  //   The LABEL is no longer "Go" on every card. R4's "Go goes" is a ruling about
  //   ceremony — no consent screen, no plan, no progress modal — and it had been
  //   read as the button's name, so twelve different offers wore one word. The
  //   button is now derived (`cardActionLabel`): the card's actions first, its
  //   kind second. The hero here only opens a door, so it says so.
  //
  //   The ACCENT is no longer spent once. This block asserted the opposite, on a
  //   correct reading of the budget and a wrong reading of the page: the budget is
  //   a rule about a WORKING surface, and a grid of posters each with one identical
  //   action is not one. `principles.md` now carries the storefront exception, with
  //   its two conditions — the same action repeated, and neutral chrome around it,
  //   which is why the tiles below still take neutral ink.
  const cardButtons = () =>
    cardsIn(home.host).flatMap((poster) => [...poster.querySelectorAll('button')]) as HTMLElement[]
  assert.equal(cardButtons().length, 3, 'one control per card, and nothing else to press on it')
  for (const button of cardButtons()) {
    assert.equal(button.getAttribute('type'), 'button')
    const label = button.textContent?.trim() ?? ''
    const name = button.getAttribute('aria-label') ?? ''
    assert.ok(label.length > 0, 'the control carries a visible word')
    assert.notEqual(label, 'Go', 'and the word is what the card offers, not "Go" on everything')
    assert.ok(
      name.startsWith(`${label} — `),
      'the accessible name leads with the visible label and then says which card it belongs to',
    )
  }
  // This hero is a `showcase` card that opens a chat, so its kind names the offer.
  // The other direction — a card whose actions only navigate, which must say so
  // whatever its stamp claims — is the pure function's own business and is
  // asserted in homeCards.test.ts, where it needs no DOM.
  const heroButton = cardButtons().find((button) =>
    (button.getAttribute('aria-label') ?? '').endsWith('Big task? No problem.'),
  )
  assert.equal(heroButton?.textContent?.trim(), 'See it', 'the word is the offer the card makes')
  const accented = cardButtons().filter((button) =>
    (button.getAttribute('class') ?? '').includes('var(--accent-primary)'),
  )
  assert.equal(accented.length, 3, 'every card\u2019s action carries the accent, not the hero\u2019s alone')

  // The task-card family contract: hover is a background change, never a lift.
  for (const poster of cardsIn(home.host)) {
    const classes = poster.getAttribute('class') ?? ''
    assert.ok(classes.includes('hover:bg-'), `${titleOf(poster)}: hover changes the ground`)
    assert.ok(
      !/shadow|scale-|-translate|translate-y/.test(classes),
      `${titleOf(poster)}: and does nothing else — no lift, no shadow, no scale`,
    )
  }

  // ── The whole card is reachable, and `Go` is the one way in ──────────────────
  // The card is a target for a pointer and a target for a keyboard, and the two
  // have to be the same target. The article itself is inert — no tab stop, no
  // role, because a card CONTAINS a button and a button inside `role="button"` is
  // markup nothing is required to make sense of — so `Go` is the single control
  // and a stretched overlay is what makes the rest of the card press it.
  for (const poster of cardsIn(home.host)) {
    assert.equal(poster.getAttribute('tabindex'), null, `${titleOf(poster)}: the card is not a second tab stop`)
    assert.equal(
      poster.getAttribute('role'),
      null,
      `${titleOf(poster)}: and it claims no role a button could not sit inside`,
    )
    assert.equal(
      [...poster.querySelectorAll('button, a[href], input, [tabindex]')].length,
      1,
      `${titleOf(poster)}: exactly one thing to reach, and it is the Go`,
    )
    assert.ok(
      (poster.getAttribute('class') ?? '').includes('has-[button:focus-visible]:focus-ring'),
      `${titleOf(poster)}: the ring is drawn on the CARD when its button takes focus — the card is what Enter acts on`,
    )
    // The overlay: the ordinary card owns it as `Go`'s own pseudo-element, the
    // hero as a direct child of the article, because the hero's button sits
    // inside an absolutely positioned row and a pseudo-element resolves against
    // that row rather than against the card.
    const go = [...poster.querySelectorAll('button')][0] as HTMLElement
    const stretched =
      (go.getAttribute('class') ?? '').includes('after:absolute after:inset-0') ||
      [...poster.children].some((child) => (child.getAttribute('class') ?? '').includes('absolute inset-0'))
    assert.ok(stretched, `${titleOf(poster)}: something stretches over the card, so the card is the target`)
  }

  // The rest of this file runs inside `main()` for one reason: the assertions
  // below need to flush a settled promise before they read the DOM again, and a
  // cjs bundle has no top-level await to do it on. `WorkspaceSidebar.liveRows
  // .test.tsx` is written the same way, and so is this item’s own
  // `run-card.test.ts` — the shape is the repo’s, not a special case.
  async function main(): Promise<void> {
    // ── `Go` opens the picker, and CHOOSING a row is what runs the card ─────────
    // Owner ruling R4b (2026-09-06, item 2473): pressing Go shows the model
    // picker's popover; nothing installs and nothing runs until a row is chosen.
    // This is the assertion that catches a Go that went back to running on its
    // own — and the one that catches a picker built beside the shipped one, since
    // the rows it reads are `CliModelPopoverSurface`'s own `data-model-row`.
    //
    // The run itself belongs to the shell: this page asks the Extensions host to
    // do it, because a page that installed things would be a second
    // implementation of every installer. So what is asserted here is the half that
    // IS this page's — one press, one popover, one run — plus the states around it.

    /** The card's picker, portaled to <body> rather than into the card. */
    const picker = () => dom.window.document.querySelector('[role="dialog"][aria-label^="Run "]') as HTMLElement | null
    const pickerRows = () => [...(picker()?.querySelectorAll('[data-model-row="true"]') ?? [])] as HTMLElement[]
    const rowNamed = (needle: string) => pickerRows().find((row) => row.textContent?.includes(needle))
    /** The card's glass — the pointer surface a mouse actually lands on. */
    const glassOf = (index: number) =>
      cardsIn(home.host)[index]?.querySelector(':scope > span[aria-hidden="true"]') as HTMLElement | undefined
    /**
     * Press a card the way a person does: on the glass, mouse DOWN and then the
     * click.
     *
     * Both halves matter. The popover dismisses itself on a mousedown outside its
     * surface and its trigger, so a press on the card is a dismissal followed by a
     * click — and a glass that decided what to do at click time would reopen what
     * the person had just closed, forever. Clicking the `Go` element directly (as
     * this suite used to) can never see that: the glass is what a pointer hits.
     */
    const pressCard = (index: number) => {
      const glass = glassOf(index)
      act(() => {
        glass?.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
        glass?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    /** Shut whatever is open, the way a second press on the card does. */
    const closePicker = () => {
      for (const [index, card] of cardsIn(home.host).entries()) {
        if (card.querySelector('button[aria-expanded="true"]')) pressCard(index)
      }
    }

    // A model the picker can name, so the row a click lands on is one this test
    // can identify — and a preset stored for that row's CLI, to prove the preset
    // rides the CLI rather than the app.
    act(() => {
      useWorkspaceStore.setState((state) => ({
        appSettings: {
          ...state.appSettings,
          lastSelectedCli: 'claude-code',
          cliRuntimes: { 'claude-code': { command: 'claude', models: [MODEL] } },
          lastAgentSpawnPermissionPreset: 'none' as const,
        },
      }))
    })
    __resetCliPermissionPresetsForTest()
    setCliPermissionPreset('claude-code', 'bypass')

    // With no host registered (no WorkspaceManager mounted), opening the picker
    // and choosing from it is a no-op that must not throw: the same guard every
    // reader on this page already has.
    act(() => {
      cardButtons()[0]?.click()
    })
    assert.ok(picker(), 'Go opens the picker rather than running the card')
    act(() => {
      rowNamed(MODEL)?.click()
    })
    closePicker()

    {
      // TypeScript cannot see the assignment made inside the promise executor, so
      // the resolver is parked in a list rather than in a narrowed `let`.
      const settlers: Array<() => void> = []
      const ran: Array<{ slug: string; launch: CardLaunchChoice }> = []
      setExtensionsSurfaceHost({
        onLaunchConnector: () => {},
        onUseSkillInNewAgent: () => {},
        onRunCard: (card, launch) => {
          ran.push({ slug: card.slug, launch })
          return new Promise<void>((resolve) => {
            settlers.push(resolve)
          })
        },
      })

      // Pressing Go — twice, and on two different cards — starts NOTHING. The one
      // moment the card stops and waits is this popover, and it is not a consent
      // screen: it is the control every other agent in this product is spawned
      // from (the ruling of 2026-08-04, "the model picker is the spawner").
      act(() => {
        cardButtons()[0]?.click()
        cardButtons()[1]?.click()
      })
      assert.equal(ran.length, 0, 'pressing Go installs nothing and runs nothing on its own (R4b)')
      assert.equal(
        cardButtons()[0]?.getAttribute('aria-expanded'),
        'true',
        'the button says it opened something, because it is now a popover trigger',
      )
      closePicker()

      // A MOUSE can open it and a mouse can close it, on the card itself: press
      // once and the picker is there, press again and it is gone. The second
      // press is the one that used to be impossible — the card's glass reopened
      // on every click, so the only way out was a click off the card entirely.
      pressCard(0)
      assert.ok(picker(), 'a press on the card opens the picker')
      pressCard(0)
      assert.equal(picker(), null, 'and a second press on the card closes it again')
      assert.equal(ran.length, 0, 'opening and closing runs nothing')

      // Choosing a row IS the press that runs it, and the row's own axes ride
      // with it: the cli, the model, the effort the CLI declares, and the
      // permission preset remembered for the row's CLI.
      act(() => {
        cardButtons()[0]?.click()
      })
      const row = rowNamed(MODEL)
      assert.ok(row, 'the picker lists the model this machine has, on the shipped surface’s own rows')
      act(() => {
        row?.click()
        // A second click on a row that has already started the run must not start
        // a second: the page's ref is what makes that true, not its state.
        row?.click()
      })
      assert.equal(ran.length, 1, 'choosing a row runs the card exactly once')
      assert.deepEqual(
        ran[0]?.launch,
        { cli: 'claude-code', model: MODEL, reasoning: null, permissionPreset: 'bypass' },
        'and it runs on THAT row — its cli, its model, and the preset stored for its CLI rather than the app-wide default',
      )
      assert.equal(ran[0]?.slug, 'big-task', 'on the card whose Go was pressed')
      assert.equal(picker(), null, 'the popover closes on the choice; there is nothing to confirm afterwards')

      // Every Go is disabled while a run is in flight, because a button that looks
      // pressable and does nothing is worse than one that says it cannot be
      // pressed — and a disabled trigger opens no popover, which is what keeps the
      // non-re-entrancy guard true for the picker as well as for the run.
      for (const go of cardButtons()) {
        assert.equal(
          (go as HTMLButtonElement).disabled,
          true,
          'every card\u2019s control is disabled while a run is in flight',
        )
      }
      act(() => {
        cardButtons()[1]?.click()
        cardsIn(home.host)[1]?.click()
      })
      assert.equal(picker(), null, 'a card cannot open its picker while a run is in flight — nor through its glass')
      assert.equal(ran.length, 1, 'and nothing else started')
      assert.equal(
        cardButtons()[0]?.getAttribute('aria-busy'),
        'true',
        'and the card that is actually working says so, without a spinner on a poster',
      )
      // Settled, then flushed, then asserted. This is the only cover the page's
      // `finally` and its `mounted` ref have: without it a run that ended would
      // leave every Go on the page disabled for good, and the page would look
      // exactly like one still working. The flush is the shape the repo already
      // uses for this (`WorkspaceSidebar.liveRows.test.tsx`).
      settlers.pop()?.()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      for (const go of cardButtons()) {
        assert.equal((go as HTMLButtonElement).disabled, false, 'and every one is pressable again once the run settles')
      }
      assert.equal(cardButtons()[0]?.getAttribute('aria-busy'), null, 'and no card is left claiming to be busy')

      // The preset belongs to the CLI, not the model: the CLI's own default-model
      // row launches on the same Bypass. A CLI nobody has set falls back to the
      // APP-WIDE default in Settings, not to something invented here, so with
      // the store emptied that row launches on `lastAgentSpawnPermissionPreset`.
      act(() => {
        cardButtons()[0]?.click()
      })
      act(() => {
        rowNamed('Claude Code')?.click()
      })
      assert.equal(ran.length, 2)
      assert.deepEqual(
        ran[1]?.launch,
        { cli: 'claude-code', model: null, reasoning: null, permissionPreset: 'bypass' },
        'every model of the CLI launches on the preset stored for it',
      )
      settlers.pop()?.()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      __resetCliPermissionPresetsForTest()
      act(() => {
        cardButtons()[0]?.click()
      })
      const defaultRow = rowNamed('Claude Code')
      assert.ok(defaultRow, 'the runtime’s own default-model row is there too')
      act(() => {
        defaultRow?.click()
      })
      assert.equal(ran.length, 3)
      assert.deepEqual(
        ran[2]?.launch,
        { cli: 'claude-code', model: null, reasoning: null, permissionPreset: 'none' },
        'a CLI nobody has touched launches on the app-wide default preset, and on the CLI’s own model',
      )
      // Put the stored choice back: the checks below still launch Claude Code on it.
      setCliPermissionPreset('claude-code', 'bypass')
      settlers.pop()?.()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      setExtensionsSurfaceHost(null)
    }

    // ── Which row it opens on, and which rows it offers ────────────────────────
    // A card declaring `require.cli` PRESELECTS that runtime and says so in the
    // quiet line Frame 4 draws on its group heading. What it does NOT do is
    // shorten the list: Frame 4 draws a Codex group under the Claude Code group,
    // and the code agrees with the drawing, because a card's skills are copied
    // into every skills-capable harness on the machine rather than into the one
    // `require.cli` names.
    act(() => {
      useWorkspaceStore.setState(() => ({
        cards: [
          {
            slug: 'asks-for-claude-code',
            kind: 'skill' as const,
            title: 'A card that asks for a runtime',
            dek: 'It names the harness its skill is copied into.',
            art: 'tokens',
            publishedAt: '2026-09-06T00:00:00.000Z',
            go: [{ verb: 'require.cli' as const, cli: 'claude-code' }, CHAT],
          },
          {
            slug: 'asks-for-a-runtime-you-do-not-have',
            kind: 'skill' as const,
            title: 'A card that asks for one you do not have',
            dek: 'It names a harness this machine has never installed.',
            art: 'browser',
            publishedAt: '2026-09-05T00:00:00.000Z',
            go: [{ verb: 'require.cli' as const, cli: 'a-cli-nobody-installed' }, CHAT],
          },
        ] satisfies HostedCard[],
        cardFeedStatus: 'ready' as const,
      }))
    })

    // While the plugin catalogue is still LOADING, the catalogue is the legacy
    // fallback — three runtimes plus whatever is persisted — and `resources/plugins/`
    // ships a dozen. So "that runtime is not installed" is a sentence this page
    // has not earned yet, and it must not say it: a cold press on a card that
    // requires one of the other nine would otherwise be told a lie it acts on.
    act(() => {
      cardButtons()[1]?.click()
    })
    assert.ok(picker(), 'a card whose runtime the catalogue has not answered for yet still opens a picker')
    assert.ok(
      !picker()?.textContent?.includes('is not installed'),
      'and it does not say a runtime is missing while it is still asking which are here',
    )
    closePicker()

    // The catalogue answers: two runtimes, one of them with an effort axis and a
    // model this test can name.
    act(() => {
      useWorkspaceStore.setState(() => ({
        pluginCatalogEntries: [
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            source: 'bundled',
            version: 1,
            binary: 'claude',
            modelSelection: { options: [{ id: MODEL }], allowCustomId: true },
            reasoningSelection: { levels: [{ id: 'low' }, { id: 'high' }] },
          },
          {
            id: 'codex',
            displayName: 'Codex',
            source: 'bundled',
            version: 1,
            binary: 'codex',
            modelSelection: { options: [{ id: 'gpt-6-astra' }], allowCustomId: true },
          },
        ] as never,
        pluginCatalogStatus: 'ready' as never,
      }))
    })

    {
      const ran: Array<{ slug: string; launch: CardLaunchChoice }> = []
      // The remembered New-chat engine, as it stood before anything on a card was
      // touched. Nothing below may move it.
      const rememberedCli = useWorkspaceStore.getState().appSettings.lastSelectedCli
      const rememberedModel = useWorkspaceStore.getState().appSettings.lastSelectedAgentModel
      setExtensionsSurfaceHost({
        onLaunchConnector: () => {},
        onUseSkillInNewAgent: () => {},
        onRunCard: (card, launch) => {
          ran.push({ slug: card.slug, launch })
          return Promise.resolve()
        },
      })

      act(() => {
        cardButtons()[0]?.click()
      })
      const note = [...(picker()?.querySelectorAll('p') ?? [])].find((element) =>
        element.textContent?.includes('the card asks for this one'),
      )
      assert.ok(note, 'the picker says the card asked for this runtime, in the mockup’s own words')
      assert.ok(
        note?.textContent?.includes('Claude Code'),
        'and names the runtime it is about, because the line is that group’s heading',
      )
      assert.equal(
        note?.nextElementSibling?.getAttribute('role'),
        'listbox',
        'the line is a heading over the rows it describes — not a chip in the trailing row of controls',
      )
      assert.ok(
        pickerRows().some((row) => row.textContent?.includes(MODEL)),
        'and it opens on that runtime’s rows',
      )

      // The other runtimes are still there. The surface groups by provider on its
      // rail, so "the whole catalogue" is asserted where the catalogue lives.
      const railFor = (label: string) =>
        picker()?.querySelector(`[role="radio"][aria-label="${label}"]`) as HTMLElement | null
      assert.ok(
        railFor('Codex'),
        'the runtime the card did not name is offered too — `require.cli` leads the list, it does not shorten it',
      )
      act(() => {
        railFor('Codex')?.click()
      })
      assert.ok(
        pickerRows().some((row) => row.textContent?.includes('gpt-6-astra')),
        'and its rows can be reached and pressed',
      )
      closePicker()

      // The EFFORT the person set here rides the launch — and, like the row
      // itself, it is never written to the engine the next New chat opens on.
      act(() => {
        cardButtons()[0]?.click()
      })
      const effortTrigger = picker()?.querySelector('[data-reasoning-trigger="true"]') as HTMLElement | null
      assert.ok(effortTrigger, 'the CLI declares an effort axis, so the picker offers it')
      act(() => {
        effortTrigger?.click()
      })
      // Effort is a ramp on a slider: the levels the manifest declares are its
      // stops, and one is reached by walking to it from the leading stop.
      const ramp = () => dom.window.document.querySelector('[data-slider="true"]') as HTMLElement | null
      assert.ok(ramp(), 'and the levels the manifest declares are the levels offered')
      const step = (key: string) =>
        act(() => {
          ramp()?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        })
      step('Home')
      for (let walked = 0; walked <= 12 && ramp()?.getAttribute('aria-valuetext') !== 'high'; walked += 1) {
        step('ArrowRight')
      }
      assert.equal(ramp()?.getAttribute('aria-valuetext'), 'high', 'the ramp reached the declared level')
      assert.deepEqual(
        useWorkspaceStore.getState().appSettings.lastSelectedAgentModel,
        rememberedModel,
        'touching effort on a card writes NOTHING to the engine the person’s next New chat opens on',
      )
      act(() => {
        rowNamed(MODEL)?.click()
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      assert.deepEqual(
        ran.at(-1)?.launch,
        { cli: 'claude-code', model: MODEL, reasoning: 'high', permissionPreset: 'bypass' },
        'the level chosen here is the level the run launches at, on the row that was clicked',
      )
      // The whole point of holding the choice locally: a card is how to run ONE
      // card, not a new default for everything after it.
      assert.equal(
        useWorkspaceStore.getState().appSettings.lastSelectedCli,
        rememberedCli,
        'and choosing a row leaves the remembered New-chat engine exactly where it was',
      )
      assert.deepEqual(
        useWorkspaceStore.getState().appSettings.lastSelectedAgentModel,
        rememberedModel,
        'model included',
      )
      setExtensionsSurfaceHost(null)
    }

    // A card naming a CLI this machine does not have says which one, with the way
    // to install it — now that the catalogue has actually answered.
    act(() => {
      cardButtons()[1]?.click()
    })
    assert.ok(
      picker()?.textContent?.includes('a-cli-nobody-installed'),
      'a card naming a CLI this machine does not have says which one',
    )
    assert.ok(
      picker()?.textContent?.includes('Install an agent CLI'),
      'and offers the one route that ends with having it — never an empty list',
    )
    assert.equal(pickerRows().length, 0, 'there is no model row to press, because there is no runtime to press it on')
    closePicker()
    act(() => {
      useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
    })

    // ── The predicate, on its own ─────────────────────────────────────────────
    // `cardRunsAModel` is a question about a card and needs no DOM to answer, so
    // it is answered here without one. It lives in this file rather than in
    // `renderableCards.test.ts` beside it only because that suite is bundled with
    // no browser globals at all and this predicate's module reaches the store.
    //
    // The case worth writing down is the LAST one: `kind` is the word on the
    // stamp, and the schema lets a showcase card open a chat exactly as it lets a
    // plugin card open a surface. A gate keyed on `kind` would pass every
    // assertion above and put a plain button in front of an agent launch.
    const asCard = (kind: HostedCard['kind'], go: HostedCard['go']): HostedCard => ({
      slug: 'probe',
      kind,
      title: 'Probe',
      dek: 'Probe.',
      art: 'split',
      publishedAt: '2026-09-06T00:00:00.000Z',
      go,
    })
    assert.equal(cardRunsAModel(asCard('showcase', [])), false, 'no actions at all runs no model')
    assert.equal(
      cardRunsAModel(asCard('showcase', [{ verb: 'open.surface', view: 'agent-clis' }])),
      false,
      'opening a door runs no model — this is the shipped hero',
    )
    assert.equal(
      cardRunsAModel(asCard('mcp', [{ verb: 'install.mcp', id: 'playwright' }])),
      false,
      'and installing a server runs no model either',
    )
    assert.equal(
      cardRunsAModel(asCard('showcase', [{ verb: 'require.cli', cli: 'claude-code' }, CHAT])),
      true,
      'a card that ends in a chat runs one',
    )
    assert.equal(
      cardRunsAModel(asCard('showcase', [CHAT])),
      true,
      'including a SHOWCASE card that ends in a chat — the gate reads the actions, never the stamp',
    )

    // ── A card that runs no model is not asked which one ──────────────────────
    // Item `2026-09-06-go-asks-which-model-only-when-a-model-runs`. The picker
    // asks HOW TO RUN, which is a question only a card that SPAWNS has an answer
    // to. The shipped hero's whole `go` is one `open.surface`, and pressing it
    // used to present a model search field, six models, a reasoning selector and
    // a permission chip reading Bypass before opening a tab — four axes chosen
    // and four axes discarded. Worse on a fresh install: `noAgentCliInstalled` is
    // the picker's first branch, so a card that installs nothing and launches
    // nothing could not be pressed at all.
    //
    // Both shapes are put on one page here, deliberately. Asserting the direct
    // card alone would pass just as well against a build that had lost the picker
    // altogether, and the two cards differ in exactly one thing: their actions.
    act(() => {
      useWorkspaceStore.setState(() => ({
        cards: [
          {
            slug: 'opens-a-door',
            kind: 'showcase' as const,
            title: 'Big task? No problem.',
            dek: 'Its whole go is one open.surface, exactly as the shipped hero’s is.',
            art: 'split',
            publishedAt: '2026-09-01T00:00:00.000Z',
            hero: true,
            go: [{ verb: 'open.surface' as const, view: 'agent-clis' as const }],
          },
          {
            slug: 'spawns-an-agent',
            kind: 'skill' as const,
            title: 'A card that starts an agent',
            dek: 'The same page, the same button, and a model to choose.',
            art: 'tokens',
            publishedAt: '2026-09-05T00:00:00.000Z',
            go: [CHAT],
          },
        ] satisfies HostedCard[],
        cardFeedStatus: 'ready' as const,
      }))
    })

    {
      const ran: Array<{ slug: string; launch: CardLaunchChoice }> = []
      setExtensionsSurfaceHost({
        onLaunchConnector: () => {},
        onUseSkillInNewAgent: () => {},
        onRunCard: (card, launch) => {
          ran.push({ slug: card.slug, launch })
          return Promise.resolve()
        },
      })

      // The button says which it is before anybody presses it. A popover trigger
      // announces the thing it controls; a plain button has nothing to announce,
      // and a reader is entitled to know whether Enter opens a menu or does the
      // work.
      const [direct, spawner] = cardButtons()
      assert.equal(direct?.getAttribute('aria-haspopup'), null, 'a card that runs no model has a plain control')
      assert.equal(
        direct?.getAttribute('aria-expanded'),
        null,
        'and it controls nothing, because there is nothing to control',
      )
      assert.equal(
        spawner?.getAttribute('aria-haspopup'),
        'dialog',
        'and the card beside it that DOES spawn is unchanged',
      )
      // This card's whole `go` is one `open.surface`, so its label names the door
      // rather than its kind — the two hosts still draw ONE button, they just no
      // longer draw one WORD (2026-09-06: the label is derived per card, and "Go"
      // on everything was a misreading of R4's ceremony ruling).
      assert.equal(
        direct?.getAttribute('aria-label'),
        'Open Agents settings — Big task? No problem.',
        'both hosts draw the same button: same label, same name, same card in it',
      )
      assert.equal(
        spawner?.textContent?.trim(),
        'Install',
        'and the card that spawns names its own offer, from its kind',
      )

      // One press runs it. No popover appears at any point — not before the run
      // and not after it.
      act(() => {
        direct?.click()
      })
      assert.equal(picker(), null, 'pressing it opens nothing to choose from')
      assert.equal(ran.length, 1, 'it just runs')
      assert.equal(ran[0]?.slug, 'opens-a-door')
      assert.deepEqual(
        ran[0]?.launch,
        { cli: 'claude-code', model: null, reasoning: null, permissionPreset: 'bypass' },
        'on the app’s own defaults and the preset stored for that CLI — the wire shape is unchanged, so nothing downstream learns a second kind of press',
      )

      // "One run at a time, and never two" is the page's REF, not the disabled
      // attribute: two clicks in one tick both read the same render. The direct
      // path goes through the same `onLaunch`, so it inherits the same guard —
      // and this is the assertion that catches a direct press wired around it.
      act(() => {
        cardButtons()[0]?.click()
        cardButtons()[1]?.click()
      })
      assert.equal(ran.length, 1, 'a second press in the same tick starts nothing, on either card')

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      // The glass still does exactly what the button does — which is now two
      // different things. `openAtPress` belongs to the popover half; a card with
      // no popover has no state to reopen, and its whole area has to run it or
      // the poster is inert everywhere but on a 30px pill.
      pressCard(0)
      assert.equal(picker(), null, 'the card’s own area opens nothing either')
      assert.equal(ran.length, 2, 'and pressing the card runs it, exactly as pressing the button does')
      assert.equal(ran[1]?.slug, 'opens-a-door')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      // On a machine with NO agent CLI at all — the fresh install this page was
      // built for. The picker's first branch answers "No agent CLI is installed"
      // and offers a route to Settings, which is right for a card that spawns and
      // was a locked door on one that does not.
      act(() => {
        useWorkspaceStore.setState((state) => ({
          pluginCatalogEntries: [] as never,
          pluginCatalogStatus: 'ready' as never,
          appSettings: { ...state.appSettings, cliRuntimes: {} },
        }))
      })
      act(() => {
        cardButtons()[1]?.click()
      })
      assert.ok(
        picker()?.textContent?.includes('No agent CLI is installed'),
        'the card that spawns says so, and offers the way to fix it',
      )
      closePicker()
      act(() => {
        cardButtons()[0]?.click()
      })
      assert.equal(ran.length, 3, 'and the card that launches no agent runs anyway, because it needs none')
      assert.equal(ran[2]?.slug, 'opens-a-door')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      setExtensionsSurfaceHost(null)
    }

    // ── A card with nothing to run does not offer to run it ───────────────────
    // Item `2026-09-06-a-card-with-nothing-to-run-has-no-go`. An empty `go` is
    // legal — `hosted-card-feed.ts` blesses it in as many words, "a showcase card
    // can be pure marketing" — and nothing downstream used to agree: the card drew
    // a `Go`, the executor looped over nothing and returned `ok`, and the press
    // produced no toast, no navigation and no error. A button that does nothing at
    // all is the one state the executor's own header says it exists to prevent.
    //
    // The answer taken is option 1: the card draws no button and is a poster. The
    // assertion is at the SURFACE rather than in the parser because the parser is
    // not where the sentence was broken — the row is still a card, and still
    // renders.
    act(() => {
      useWorkspaceStore.setState(() => ({
        cards: [
          {
            slug: 'pure-marketing',
            kind: 'showcase' as const,
            title: 'Look what somebody built',
            dek: 'It is a picture and a claim, and there is nothing here to install.',
            credit: 'Unreal Engine',
            art: 'city',
            publishedAt: '2026-09-06T00:00:00.000Z',
            hero: true,
            go: [],
          },
          {
            slug: 'has-something-to-do',
            kind: 'skill' as const,
            title: 'A card with something to run',
            dek: 'The same page, so the difference is the actions and nothing else.',
            art: 'tokens',
            publishedAt: '2026-09-05T00:00:00.000Z',
            go: [CHAT],
          },
        ] satisfies HostedCard[],
        cardFeedStatus: 'ready' as const,
      }))
    })

    {
      const ran: string[] = []
      setExtensionsSurfaceHost({
        onLaunchConnector: () => {},
        onUseSkillInNewAgent: () => {},
        onRunCard: (card) => {
          ran.push(card.slug)
          return Promise.resolve()
        },
      })

      const poster = cardsIn(home.host).find((candidate) => titleOf(candidate) === 'Look what somebody built')
      assert.ok(poster, 'the card is still rendered — an empty `go` is not a reason to drop the row')
      assert.equal(
        cardButtons().length,
        1,
        'and the only control on the page belongs to the card that has something to run',
      )
      assert.equal(
        poster?.querySelectorAll('button, a[href], input, [tabindex]').length,
        0,
        'a card that cannot act offers nothing to press',
      )
      // Deliberate, and the review focus asked for it in these words: `Go` is the
      // card's only tab stop and the card's ring is keyed to it, so a poster has
      // neither. There is nothing for Enter to do here, and a tab stop that
      // answers no key is worse than no tab stop at all.
      const posterClasses = poster?.getAttribute('class') ?? ''
      assert.ok(
        !posterClasses.includes('has-[button:focus-visible]'),
        'so it wears no ring keyed to a button it does not have',
      )
      assert.ok(
        !posterClasses.includes('cursor-pointer'),
        'and no pointer cursor, because there is nothing to point at',
      )
      assert.ok(
        !posterClasses.includes('hover:bg-'),
        'and no hover tint, because hover is how this card family says “target”',
      )
      assert.equal(
        [...(poster?.children ?? [])].filter((child) =>
          (child.getAttribute('class') ?? '').includes('absolute inset-0'),
        ).length,
        0,
        'and no glass over it: an overlay that swallows the pointer and answers nothing is the dead button again',
      )
      // It is still a card and still readable — the picture, the heading, the
      // stamp and the credit are all there. "No button" is not "no content".
      assert.ok(poster?.querySelector('h3'), 'the poster still names itself in a heading')
      assert.ok(poster?.textContent?.includes('Showcase'), 'and keeps its stamp')
      assert.ok(poster?.textContent?.includes('Unreal Engine'), 'and its credit')

      // Nothing can start a run from it, by pointer or otherwise, so the no-op
      // press is not merely hidden.
      act(() => {
        poster?.click()
      })
      assert.deepEqual(ran, [], 'and pressing the card itself starts nothing, because there is nothing to start')

      // The card beside it is untouched, which is what makes the assertions above
      // about THIS card rather than about a page that had lost its buttons.
      act(() => {
        cardButtons()[0]?.click()
      })
      assert.ok(picker(), 'the card with actions still opens its picker')
      closePicker()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      setExtensionsSurfaceHost(null)
    }

    // Put the machine and the feed back the way the rest of this file found them.
    act(() => {
      useWorkspaceStore.setState((state) => ({
        pluginCatalogEntries: [] as never,
        pluginCatalogStatus: 'idle' as never,
        appSettings: {
          ...state.appSettings,
          cliRuntimes: { 'claude-code': { command: 'claude', models: [MODEL] } },
        },
        cards: FEED,
        cardFeedStatus: 'ready' as const,
      }))
    })

    // ── The tiles are still there, and they are underneath ───────────────────────
    assert.ok(tilesIn(home.host).length > 0, 'the tiles keep their place on the page')
    const regions = [...home.host.querySelectorAll('article, ul')]
    assert.equal(
      regions[regions.length - 1]?.tagName,
      'UL',
      'the cards are the reason to be here and the tiles are the way off, so the tiles come last',
    )
    assert.ok(
      home.host.textContent?.includes('Or go straight to the parts'),
      'and the quiet heading that turns them into the way off arrives with the cards',
    )

    // ── The search filters on title, dek and credit ──────────────────────────────
    const searchField = () => home.host.querySelector('input[type="search"]') as HTMLInputElement | null
    assert.ok(searchField(), 'a feed with cards in it gets a field to search them')

    // React DOM is imported above the jsdom globals in this bundle (esbuild hoists
    // it), so it decided at load that no DOM exists and runs its change-event
    // polyfill: a focused element is watched and a value change is noticed on
    // keyup. Typing here is that sequence — focus, set, keyup — the same one
    // `topbar/RemotePopover.test.tsx` and `ToastHost.test.tsx` already use.
    function search(value: string): void {
      const input = searchField()
      assert.ok(input, 'the search field is on the chrome row')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      act(() => {
        input?.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
        setter?.call(input, value)
        input?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        input?.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
      })
    }

    search('postcode')
    assert.deepEqual(
      cardsIn(home.host).map(titleOf),
      ['Build a 3D apocalypse of your own street'],
      'the dek is searched',
    )
    search('playwright')
    assert.deepEqual(
      cardsIn(home.host).map(titleOf),
      ['Let an agent drive your browser'],
      'so is the credit, case and all',
    )
    search('big task')
    assert.deepEqual(cardsIn(home.host).map(titleOf), ['Big task? No problem.'], 'and so is the title')
    assert.equal(
      [...home.host.querySelectorAll('button')].filter((button) =>
        (button.getAttribute('class') ?? '').includes('var(--accent-primary)'),
      ).length,
      1,
      'the hero keeps the accent while it is the only card showing',
    )
    search('nothing on any of these cards')
    assert.equal(cardsIn(home.host).length, 0)
    const noMatch = [...home.host.querySelectorAll('p')].find((line) =>
      line.textContent?.includes('No cards match this search'),
    )
    assert.ok(
      noMatch,
      'a search that matches nothing gets an answer — that is the person’s own question, not the page apologising for its network',
    )
    // And it is answered where the field said to look. `aria-controls` on the input
    // names the grid region, so a sentence sitting outside that region is a sentence
    // a reader following the pointer is never sent to; the live region inside it is
    // what makes the answer arrive rather than merely exist.
    assert.ok(
      noMatch?.closest(`#${searchField()?.getAttribute('aria-controls')}`),
      'the answer lives inside the region the search field says it controls',
    )
    assert.ok(noMatch?.closest('[aria-live="polite"]'), 'and inside a region that is watched, so it is spoken')
    assert.ok(tilesIn(home.host).length > 0, 'and the tiles are still there to leave by')
    search('')

    // ── A query does not outlive the field that typed it ─────────────────────────
    // The field is absent when there are no cards, so the query has to go with it:
    // state outlives the element that edits it, and a feed that emptied and came
    // back would otherwise return to a filter typed against a page that no longer
    // showed the box holding it — cards back, and an instant "no cards match".
    search('playwright')
    act(() => {
      useWorkspaceStore.setState(() => ({ cards: [], cardFeedStatus: 'ready' as const }))
    })
    assert.equal(searchField(), null, 'the field goes with the cards')
    act(() => {
      useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
    })
    assert.equal(searchField()?.value, '', 'and the query went with the field')
    assert.equal(
      cardsIn(home.host).length,
      3,
      'so a feed that emptied and refilled comes back whole, not behind a filter nobody can see',
    )

    // ── Loading is a skeleton grid ───────────────────────────────────────────────
    act(() => {
      useWorkspaceStore.setState(() => ({ cards: [], cardFeedStatus: 'loading' as const }))
    })
    const shimmers = [...home.host.querySelectorAll('.skeleton-shimmer')]
    assert.ok(shimmers.length > 0, 'a page with nothing to draw yet draws the shape of what is coming')
    // And the shape is PAINTED. `.skeleton-shimmer` carries the sweep and no ground,
    // and the sweep itself only runs under `prefers-reduced-motion: no-preference` —
    // so a caller that passes no background draws transparent rectangles, and draws
    // nothing whatsoever on a machine that asked for less motion.
    for (const shimmer of shimmers) {
      assert.ok(
        /bg-\[color:var\(--[a-z-]+\)\]/.test(shimmer.getAttribute('class') ?? ''),
        'every skeleton carries the surface colour its own docstring says the caller owns',
      )
    }
    assert.equal(cardsIn(home.host).length, 0, 'and no cards while it waits')
    assert.ok(tilesIn(home.host).length > 0, 'the tiles do not wait on the network')

    // A read that fails behind cards that are already up keeps them: the feed going
    // away must never empty the page (R6).
    act(() => {
      useWorkspaceStore.setState(() => ({
        cards: FEED,
        cardFeedStatus: 'error' as const,
        cardFeedError: 'GitHub was slow',
      }))
    })
    assert.equal(cardsIn(home.host).length, 3, 'a failed re-read leaves the cards alone')
    assert.ok(
      !home.host.textContent?.includes('GitHub was slow'),
      'and the page does not repeat what its own network said',
    )

    home.unmount()
    drawer.unmount()

    // ── The cards that arrived since the last visit wear the New chip ───────────
    //
    // The rail square counts the hosted cards published since the home was last
    // open; until now the section was stamped seen on its first frame, so the page
    // the badge sent the person to could not say WHICH cards it had just cleared.
    // The home stamps itself instead, and marks what the stamp revealed
    // (`newHomeCardSlugs`, `design-system/components/badge/component.md`, "The New
    // mark").
    //
    // Mounted fresh rather than reusing the page above, because the freeze happens
    // once per visit: a page that has already stamped itself has, correctly,
    // nothing left to mark.
    act(() => {
      useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
    })
    const STAMP = '2026-09-02T00:00:00.000Z'
    act(() => {
      useNotificationStore.setState({ sectionSeenAt: { extensions: STAMP } })
    })

    const visit = mount(React.createElement(ExtensionsHomeSurface))
    const posterFor = (title: string): HTMLElement => {
      const poster = cardsIn(visit.host).find((candidate) => titleOf(candidate) === title)
      assert.ok(poster, `${title}: the card is on the page`)
      return poster as HTMLElement
    }
    const chipped = (title: string): boolean => Boolean(posterFor(title).textContent?.includes('New'))

    // The hero was published before the stamp and the other two after it. The hero
    // is the case worth naming: it leads the grid because the FEED promoted it, and
    // leading is not being new.
    assert.equal(chipped('Big task? No problem.'), false, 'a card that was here last time is not marked')
    assert.equal(chipped('Let an agent drive your browser'), true, 'a card published since the stamp is')
    assert.equal(chipped('Build a 3D apocalypse of your own street'), true, 'and so is the other one')

    // The kit's chip, not a span drawn here: accent ink on the soft accent, no
    // hairline, and readable — nothing on a poster writes an accessible name for
    // the CARD (the one hand-written name is `Go`'s, and it names the button), so
    // hiding the chip would delete the word for anyone not looking at the picture.
    const chip = [...posterFor('Let an agent drive your browser').querySelectorAll('span')].find(
      (span) => span.textContent === 'New',
    )
    assert.ok(chip, 'the mark is an element of its own, not a word inside the title')
    assert.ok(
      chip?.className.includes('accent-primary-soft'),
      'and it is the kit’s New mark — accent ink on the soft accent',
    )
    assert.doesNotMatch(chip?.className ?? '', /border/, 'no hairline: a border would make it read as a state chip')
    assert.equal(chip?.getAttribute('aria-hidden'), null, 'and it is spoken, because nothing else on the card says it')

    // Never a hoist and never a sort key: the grid is exactly the order it was
    // before anything was marked, so a muscle-memory pick still lands.
    assert.deepEqual(
      cardsIn(visit.host).map(titleOf),
      ['Big task? No problem.', 'Let an agent drive your browser', 'Build a 3D apocalypse of your own street'],
      'the chip is the only difference — it moves nothing',
    )

    // The visit stamps itself, which is what makes the rail square quiet on the way
    // out — and the chips survive that write, because the stamp the page marks
    // against was frozen on mount.
    const stampedAt = useNotificationStore.getState().sectionSeenAt.extensions
    assert.ok(stampedAt && Date.parse(stampedAt) > Date.parse(STAMP), 'the home advances the section stamp on mount')
    assert.equal(
      chipped('Let an agent drive your browser'),
      true,
      'and the marks stay up for the visit that revealed them',
    )

    // A card pushed while the person is reading the page is SEEN, not badged
    // behind them: the feed changing stamps again, and the new card is marked
    // against this visit's frozen stamp like every other.
    act(() => {
      useWorkspaceStore.setState(() => ({
        cards: [
          ...FEED,
          {
            slug: 'mid-visit',
            kind: 'skill' as const,
            title: 'It landed while you were reading',
            dek: 'A push that arrives mid-visit, which the rail must not save up for later.',
            art: 'browser' as const,
            publishedAt: '2026-09-08T00:00:00.000Z',
            go: [CHAT],
          },
        ],
        cardFeedStatus: 'ready' as const,
      }))
    })
    assert.equal(chipped('It landed while you were reading'), true, 'the card that arrived mid-visit is marked')
    const restamped = useNotificationStore.getState().sectionSeenAt.extensions
    assert.ok(
      restamped && Date.parse(restamped) >= Date.parse(stampedAt ?? ''),
      'and the section was stamped again, so the square does not count it after the person has seen it',
    )
    visit.unmount()

    // The mark expires on its own: the next open is clean, because the visit above
    // stamped itself.
    const second = mount(React.createElement(ExtensionsHomeSurface))
    assert.equal(
      cardsIn(second.host).filter((poster) => poster.textContent?.includes('New')).length,
      0,
      'a mark that never clears is decoration — the visit that revealed it is what clears it',
    )
    second.unmount()

    console.log('ExtensionsHomeSurface.test.tsx: ok')
  }

  const suiteRun = main()

  await suiteRun
})
