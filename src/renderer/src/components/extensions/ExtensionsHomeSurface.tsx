import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { DesignSystemLibraryEntry } from '../../../../shared/design-system/library'
import type { HostedCard } from '../../../../shared/hosted-card-feed'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { CardButton } from '../ui/CardButton'
import { InboxSearchInput } from '../ui/InboxSearchInput'
import { Skeleton } from '../ui/Skeleton'
import { useExtensionsDrawerRows } from '../workspace/extensionsDrawerRows'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import { useSurfaceBackNav } from '../workspace/globalSurface/surfaceBackNav'
import { CardPoster } from '../workspace/globalSurface/extensions/home/CardPoster'
import type { CardLaunchChoice } from '../workspace/globalSurface/extensions/home/CardGoPicker'
import { getExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import { useSkillSources } from '../workspace/globalSurface/extensions/skills/useSkillSources'
import { skillsTotal } from '../workspace/globalSurface/extensions/skills/skillsSurfaceModel'
import type { SurfaceIconComponent } from '../../modules/renderer-host'
import {
  designLibraryCountLine,
  EXTENSIONS_HOME_TILE_SUMMARIES,
  mcpServerCountLine,
  skillsCountLine,
} from './extensionsHomeTiles'
import { homeCardCount, homeCardGrid, newHomeCardSlugs } from './homeCards'
import { openBuildExtension } from './buildExtensionHost'

// The Extensions home (the app rail's Extensions glyph, 2026-09-05): the page
// the glyph opens, in the card region, with the Extensions drawer standing
// beside it as the navigation.
//
// A DOOR, not a modal (Extensions drawer ruling, 2026-09-05, Stage 2). It was
// the `marketplace` modal for a few hours on the same day; the modal floated
// over the card region with a scrim, which put a dialog between the person and
// the drawer they had just used. Its id changed with its shape — `marketplace`
// named a browse that does not exist yet, `extensions-home` names the page.
//
// Core, like Settings: this is where the product's own parts are offered, so no
// module may gate it (renderer-host reserves the id; WorkspaceManager resolves
// it from the app itself).
//
// **The body is the card feed, and the tiles are the foot of the page**
// (2026-09-06, epic "Extensions opens on a home page", item 2468). The page's
// first body was the drawer said again as tiles, and that answered *what
// is the studio made of* — which is a question nobody arrives with. The cards
// answer *what could I do*, which is the one they do. So the cards are the
// reason to be here and the tiles are the way off: a search field on the chrome
// row, the grid, then the tiles under a quiet heading.
//
// The tiles themselves are untouched by that move. Same destinations, same
// order, same click — the tiles and the drawer rows are still resolved by ONE
// function (`extensionsDrawerRows.ts`), so a tile cannot open something its row
// does not, and each still carries the sentence saying what that part is for
// and the live count saying how much of it you have.
//
// Three states, and the quiet one is the important one. Loading is a skeleton
// grid. A feed that yields no card this build can draw — no network on a fresh
// profile, or a feed of cards whose artwork ships in a later release — falls
// back to **the tiles alone, with no apology and no notice**: the page is
// simply the page it was yesterday (epic rulings R5 and R6 — no version gating,
// and the page never reports on its own network). The heading over the tiles
// goes with the cards for the same reason, because a heading separates
// something from something else and with no cards there is nothing to separate
// them from.
//
// **The Community "coming soon" block is gone** (owner, 2026-09-06). It promised
// a browse of modules other people have published, with search and one-click
// install, "once the registry scan lands" — and nothing has scheduled that scan.
// A storefront that gives the last third of its page to an empty state
// describing a feature with no owner and no date is worse than one that is
// simply shorter.
//
// This overturns the ruling of 2026-09-05 that put the block here, and it is
// recorded as an overturning because that is what it is: item 2468 removed the
// block as a side effect and was reverted for exactly the reason that retiring
// it was not that item's call to make. It is this one's, and the owner made it.
//
// **Building the browse is not refused — it is unscheduled.** If the registry
// scan lands, the browse returns as its own work rather than as a promise kept
// late (backlog/2026-09-06-the-home-pages-bottom-half.md).
//
// What this page deliberately does NOT carry is the module list: module
// switches live in Settings → Modules, and having them here too put the same
// choice in two shapes on two surfaces (principles, Composition).

// The one glyph that is not a module's: a chevron saying the tile leads
// somewhere. Local because it is this page's own punctuation rather than a
// surface's identity, which is what surfaceGlyphs.tsx holds.
function TileChevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ExtensionsHomeTile({
  label,
  summary,
  count,
  Icon,
  onClick,
}: {
  label: string
  summary?: string
  count?: string | null
  Icon: SurfaceIconComponent
  onClick: () => void
}): JSX.Element {
  return (
    <CardButton
      variant="bordered"
      onClick={onClick}
      // One object, repeated: the kit's bordered tile, so the row of them reads
      // as one control repeated rather than a handful of cards that happen to be
      // adjacent. The hairline is present at rest and hover moves the ground —
      // nothing appears, so nothing in the grid reflows under the pointer
      // (principles, "Hairlines carry the structure").
      //
      // Full height with the count pushed to the foot, so the count lines sit on
      // one line however many lines each summary takes. A tile whose number
      // floated up under a one-line summary while its neighbour's sat lower
      // would read as separate objects.
      //
      // The name is the accessible name and it is real text, so the tile needs
      // no aria-label; the glyph and the chevron are decorative and say so.
      className="h-full px-3 pb-2.5 pt-3"
    >
      <span aria-hidden="true" className="mb-1.5 flex items-start justify-between">
        {/* Neutral ink, not the accent: a row of accented glyphs would be a
            category code in the strongest colour the system has
            (principles, "The accent budget"). */}
        <span className="flex text-[color:var(--text-muted)]">
          <Icon className="icon-md" />
        </span>
        <span className="flex text-[color:var(--text-subtle)]">
          <TileChevron className="icon-sm" />
        </span>
      </span>
      <span className="text-body font-semibold text-[color:var(--text-strong)]">{label}</span>
      {summary ? <span className="mt-0.5 text-meta text-[color:var(--text-muted)]">{summary}</span> : null}
      {/* A count that is not known yet is absent, never zero — the line simply
          is not there until the read lands. */}
      {count ? (
        <span className="mt-auto pt-2 text-micro tabular-nums text-[color:var(--text-subtle)]">{count}</span>
      ) : null}
    </CardButton>
  )
}

/**
 * The count line under each tile, from the stores and readers that already hold
 * the numbers — never a second source of truth, so a tile and the surface it
 * opens cannot state different totals.
 *
 * Every read here is a mount read or a store subscription; nothing polls and
 * nothing re-fetches on render. The MCP servers come free (they are in the
 * workspace store, populated before any door opens); the other two cost the
 * same reads their own surface makes, once, on the way in — which is the price
 * of the page saying something true rather than something decorative.
 */
function useExtensionsHomeCounts(): Readonly<Record<string, string | null>> {
  const mcpServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  // App-level sources, so no workspace: `null` skips the per-workspace
  // installed read this page has no use for.
  //
  // It costs a source list and one scan read per source, on every open of this
  // page — deliberately, and documented rather than cached: the alternative is
  // a door-level cache that this page and the Extensions door would both write
  // to, and the tile would then be showing whatever the door last read rather
  // than what is there. The reads are the main process's own cached scans, so
  // they are IPC round-trips, not repository walks.
  const skills = useSkillSources(null)
  const designLibrary = useDesignSystemLibraryCount()

  return useMemo(() => {
    const servers = Object.values(mcpServers ?? {})
    // The Skills total is the Skills surface's own derivation (skillsTotal),
    // not a second sum: the same fact derived twice is a pair of numbers that
    // eventually disagree.
    const skillTotals = skillsTotal(skills.sourcesLoad, skills.sources, skills.scans)
    return {
      design: designLibraryCountLine(designLibrary),
      // Enabled servers, which is the number the Plugins surface's Installed
      // row states ("N active MCP servers") — the same count in two places has
      // to be the same count.
      plugins: mcpServerCountLine(servers.filter((server) => server?.enabled).length),
      skills: skillsCountLine({
        ready: skillTotals.ready,
        sourceCount: skillTotals.sourceCount,
        skillCount: skillTotals.skillCount,
      }),
    }
  }, [designLibrary, mcpServers, skills.scans, skills.sources, skills.sourcesLoad])
}

/**
 * How many design systems the library holds. Read once, on mount: the library
 * is a registry file nothing in this window writes while the page is up, and
 * the Design door re-reads it for itself when it opens.
 */
function useDesignSystemLibraryCount(): { ready: boolean; count: number } {
  const [state, setState] = useState<{ ready: boolean; count: number }>({ ready: false, count: 0 })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (typeof window.api?.listDesignSystemLibrary !== 'function') return () => {}
    void window.api
      .listDesignSystemLibrary()
      .then((result: { entries: DesignSystemLibraryEntry[] }) => {
        if (!mounted.current) return
        setState({ ready: true, count: result.entries.length })
      })
      // A library that cannot be listed leaves the tile with no count line
      // rather than with a zero it did not measure.
      .catch(() => {})
    return () => {
      mounted.current = false
    }
  }, [])
  return state
}

/**
 * The count, as a word. English up to ten and digits past it, because the studio
 * is not going to have eleven parts and a sentence reading "the 6 things" is a
 * sentence nobody wrote on purpose.
 */
function tileCountWord(count: number): string {
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  return WORDS[count] ?? String(count)
}

/** The id the search field says it filters, and the grid it filters. */
const CARD_GRID_ID = 'extensions-home-cards'

/** The region under the cards, labelled by its own heading. */
const PARTS_HEADING_ID = 'extensions-home-parts-heading'

/**
 * The grid, in one shape for every state that has cards in it.
 *
 * Two columns, and the breakpoint is the CARD REGION rather than the window: a
 * container query, because this page sits in whatever the sidebar and the
 * window leave it and a viewport breakpoint would put two half-width cards side
 * by side in a narrow region on a wide screen. It is the same reasoning the
 * tile row's `auto-fit` already follows, expressed exactly rather than
 * approximately — `auto-fit` cannot be told to stop at two, and three even
 * columns is the layout Frame 3 rejected (variant B: nothing ranked).
 *
 * The hero takes both columns. It is a 2.7:1 plate and nothing else on the page
 * is, which is the whole of what "hero" means here.
 */
function CardGrid({
  children,
  status,
}: {
  children: React.ReactNode
  /** A sentence about the grid, INSIDE the region the field says it controls. */
  status?: React.ReactNode
}): JSX.Element {
  return (
    <div id={CARD_GRID_ID} className="@container">
      <div className="grid grid-cols-1 gap-5 @[736px]:grid-cols-2">{children}</div>
      {/* The live region is always here and usually empty, because that is what
          makes an insertion into it something assistive technology speaks. A
          sentence that mounted with `aria-live` already set on it is a new
          element, not a change to a region being watched, and is routinely
          missed — and this one was worse than missed: it stood OUTSIDE the
          element `aria-controls` names, so a reader following the search field's
          own pointer arrived at an empty grid and was told nothing. */}
      <div aria-live="polite">{status}</div>
    </div>
  )
}

/**
 * The loading state: the grid's own shape, drawn empty.
 *
 * A skeleton and not a spinner, because the page knows exactly what is coming —
 * a wide plate and a row of 16:9 ones — and a layout that appears at the size
 * it will be does not shift when the feed lands. Hidden from readers, like
 * every skeleton: there is nothing here to announce, and the cards will
 * announce themselves.
 *
 * Four followers rather than the feed's own count, because the count is the
 * thing not known yet. It is a placeholder for a grid, not a promise about how
 * many cards there are.
 *
 * The surface colour is passed in, as `Skeleton`'s own docstring requires and
 * as every other caller in the tree does: the shared `.skeleton-shimmer` class
 * carries the SWEEP and no ground, and the sweep itself only exists under
 * `prefers-reduced-motion: no-preference`. Without a background the loading
 * state was transparent rectangles on a wide screen and a blank page on a
 * machine that had asked for less motion. `--bg-surface-raised` is the plate's
 * own ground (`cardSplash.tsx`), so the placeholder is the colour the picture
 * will land on.
 */
function CardGridSkeleton(): JSX.Element {
  return (
    <CardGrid>
      <div className="@[736px]:col-span-2">
        <Skeleton className="aspect-[2.7/1] max-h-[330px] w-full rounded-lg bg-[color:var(--bg-surface-raised)]" />
      </div>
      {[0, 1, 2, 3].map((slot) => (
        <Skeleton key={slot} className="aspect-[16/9] w-full rounded-lg bg-[color:var(--bg-surface-raised)]" />
      ))}
    </CardGrid>
  )
}

export default function ExtensionsHomeSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  // No nav entries handed in: this page is not the sidebar, so the rows resolve
  // against the host's own enablement-filtered list. A row whose module is off
  // is absent here exactly as it is in the drawer.
  const rows = useExtensionsDrawerRows()
  // The rows that actually draw a tile — a row needs both a label and a glyph,
  // which is the same test the list below applies. Counted once so the sentence
  // over the row and the row itself cannot disagree.
  const tiles = useMemo(() => rows.filter((row) => row.label && row.Icon), [rows])
  const counts = useExtensionsHomeCounts()
  // The feed is read, never fetched, here. WorkspaceManager loads it once at
  // boot and subscribes to the main process's push, so a page that fetched on
  // mount would be a second reader of one file — and the one whose copy the
  // person sees would depend on which of them answered last.
  const cards = useWorkspaceStore((state) => state.cards)
  const cardFeedStatus = useWorkspaceStore((state) => state.cardFeedStatus)
  const [query, setQuery] = useState('')

  // What this build can draw at all, and what survives the search. The first is
  // what decides whether there is a card region; the second is what goes in it.
  const drawable = useMemo(() => homeCardCount(cards), [cards])
  // The field goes away with the cards, so the query has to go with the field.
  // React state outlives the element that edits it: a feed that emptied and came
  // back — the poller's next read, a profile that got its network — used to
  // return to a filter typed minutes ago against a page that no longer showed
  // the field holding it, so the cards came back and immediately said "no cards
  // match this search". Clearing on the way out is the option taken over keeping
  // the field permanently mounted, because the field's absence is a decision
  // this page made on purpose: a page that has fallen back to its tiles offers
  // no filter over cards it is not showing.
  useEffect(() => {
    if (drawable === 0) setQuery('')
  }, [drawable])
  const grid = useMemo(() => homeCardGrid(cards, query), [cards, query])
  const matched = (grid.hero ? 1 : 0) + grid.rest.length

  // The stamp this visit opened on, frozen on the first render and never read
  // from the store again.
  //
  // The Design door does exactly this with `visitSeenAt`
  // (`globalSurface/design/DesignGlobalSurface.tsx`) and the reasoning carries
  // over whole: the marks have to stay up for the whole visit that reveals
  // them, so the write below cannot be allowed to erase what the person is
  // currently looking at; and the next open has to be quiet, so the write
  // happens on the visit rather than on some dismissal the person has to
  // perform. A ref rather than state because reading it must not re-render, and
  // because it is deliberately NOT reactive.
  //
  // `undefined` is "not captured yet" and `null` is "captured, and there was no
  // stamp" — a fresh profile, where nothing is new (`newHomeCardSlugs`).
  const visitSeenAt = useRef<string | null | undefined>(undefined)
  if (visitSeenAt.current === undefined) {
    visitSeenAt.current = useNotificationStore.getState().sectionSeenAt.extensions ?? null
  }
  /** The cards this visit chips: published since the stamp above. */
  const newSlugs = useMemo(() => newHomeCardSlugs(cards, visitSeenAt.current), [cards])

  // The HOME is what stamps the section, because the home is what marks the
  // cards — the rail square's count and the chips on this page are one fact,
  // and a host that stamped on the section's first frame left the page unable
  // to tell which cards it had just cleared.
  //
  // Again on every feed change, not only on mount: a push that lands while the
  // person is reading this page has been seen, and badging it behind them is
  // the same defect one step later. The frozen ref above is what keeps this
  // visit's chips on screen through that write.
  useEffect(() => {
    useNotificationStore.getState().markSectionSeen('extensions', new Date().toISOString())
  }, [cards])
  // Only a page with nothing to draw is loading — the slice says the same thing
  // on its own side, and a re-read behind cards that are already up must never
  // replace them with a skeleton.
  const loading = cardFeedStatus === 'loading' && drawable === 0
  const hasCardRegion = loading || drawable > 0

  // What `Go` does (item 2469, owner ruling R4: "Go goes"; item 2473, ruling
  // R4b). Pressing it opens the model picker; CHOOSING A ROW is what arrives
  // here, and the choice rides the run — the cli, model, reasoning effort and
  // permission preset of the row that was clicked (`CardPoster.tsx` holds the
  // trigger, `CardGoPicker.tsx` the surface). The run itself is the shell's —
  // `onRunCard` installs what the card names in the workspace the person is in
  // and lands them in the chat with the prompt sent — because this page knows
  // nothing about workspaces, settings stores or spawning agents. What is this
  // page's is the button: one run at a time, and never two.
  //
  // The REF is what makes it non-re-entrant, and the state is only what draws
  // it. Two clicks in the same tick both read the same render's `runningSlug`,
  // so a state check alone would start two runs; the ref is written
  // synchronously, before anything is awaited, so the second press finds it set.
  // Every card's button is disabled while any run is in flight, because a Go
  // that looks pressable and does nothing is worse than one that says it cannot
  // be pressed yet.
  const runningRef = useRef<string | null>(null)
  const [runningSlug, setRunningSlug] = useState<string | null>(null)
  // Set to false on unmount: the run outlives this page on the happy path — the
  // chat that opens is what closes the door — so the settle handler must not
  // write state into a component that has gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const onLaunch = useCallback((card: HostedCard, choice: CardLaunchChoice) => {
    if (runningRef.current !== null) return
    // Null only when no WorkspaceManager is mounted (tests), and then this is a
    // press that does nothing rather than a throw.
    const host = getExtensionsSurfaceHost()
    if (!host) return
    runningRef.current = card.slug
    setRunningSlug(card.slug)
    void host.onRunCard(card, choice).finally(() => {
      runningRef.current = null
      if (mounted.current) setRunningSlug(null)
    })
  }, [])

  return (
    <GlobalSurfaceShell
      ariaLabel="Extensions"
      controlTabContext="extensions"
      // The door's name rides the app's one top strip, where the workspace name
      // would be — a surface owns its whole region including its top row.
      //
      // The search field rides it too, where every other door in this family
      // puts one (`catalogue/CatalogueSurface.tsx`), at the same width — a
      // field that changed size from door to door would read as a different
      // control. It is absent when there is nothing to search: a page that has
      // fallen back to its tiles offers no filter over cards it is not showing.
      bar={{
        title: 'Extensions',
        actions:
          drawable > 0 ? (
            <div className="w-[260px]">
              <InboxSearchInput
                value={query}
                onChange={setQuery}
                ariaLabel="Search the Extensions home"
                placeholder="Search"
                controlsId={CARD_GRID_ID}
              />
            </div>
          ) : undefined,
      }}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto px-5 py-4">
        {/* The way to build an extension of your own, above the cards and in
            every state of the feed, because it is the one thing on this page
            that does not depend on the network. Agents need no skill for it:
            Studio's `extension.create` and `extension.guide` tools teach them. */}
        <BuildExtensionPlate onOpen={() => void openBuildExtension()} />
        {loading ? <CardGridSkeleton /> : null}
        {!loading && drawable > 0 ? (
          <CardGrid
            status={
              /* A search that matches nothing gets an answer, and it is the one
                 state on this page that says anything at all. It is not the
                 notice R6 forbids — that rule is about the page apologising for
                 its own network, and this is the app answering a question the
                 person just asked. An empty grid under a field with text in it
                 would read as a page that had broken. It goes INSIDE the grid
                 region, which is what the search field's `aria-controls` points
                 at; as a sibling after it, it was a sentence no reader following
                 that pointer would ever be sent to. */
              matched === 0 ? (
                <p className="m-0 pt-1 text-meta text-[color:var(--text-muted)]">No cards match this search.</p>
              ) : null
            }
          >
            {grid.hero ? (
              <div className="@[736px]:col-span-2">
                <CardPoster
                  card={grid.hero}
                  shape="hero"
                  running={runningSlug === grid.hero.slug}
                  disabled={runningSlug !== null}
                  isNew={newSlugs.has(grid.hero.slug)}
                  onLaunch={(choice) => onLaunch(grid.hero as HostedCard, choice)}
                />
              </div>
            ) : null}
            {grid.rest.map((card) => (
              <CardPoster
                key={card.slug}
                card={card}
                running={runningSlug === card.slug}
                disabled={runningSlug !== null}
                isNew={newSlugs.has(card.slug)}
                onLaunch={(choice) => onLaunch(card, choice)}
              />
            ))}
          </CardGrid>
        ) : null}
        {/* The heading arrives with the cards and leaves with them. With cards
            above it, it is what turns the tiles from the page into the way off
            the page ("Or go straight to the parts", Frame 1); with no cards
            above it, the tiles ARE the page again and a heading would be the
            door's own name said twice (principles, Composition).

            A `<section>` either way, and one the heading names when there is a
            heading to name it: a reader that can jump to the tiles is the whole
            point of sectioning them. */}
        <section aria-labelledby={hasCardRegion ? PARTS_HEADING_ID : undefined} className="space-y-2.5">
          {hasCardRegion ? (
            <div className="flex items-baseline gap-2.5">
              {/* h2, one level under the door's own name and one ABOVE the h3
                  each card titles itself with: this labels a section, and a
                  heading list that ranked it level with the cards' own titles
                  would read the label as a sibling of their content. Drawn
                  quietly all the same — the level is the outline, not the
                  type. */}
              <h2 id={PARTS_HEADING_ID} className="m-0 text-meta font-semibold text-[color:var(--text-strong)]">
                Or go straight to the parts
              </h2>
              <p className="m-0 text-meta text-[color:var(--text-muted)]">
                {/* Counted, never typed. It said "five" from 2026-09-05 until
                    2026-09-06, and item 2470 made it six by splitting the run
                    doors — the sentence then sat directly above six tiles
                    miscounting them. A module being off makes it four or five
                    again, so the only number that can stay true is the one the
                    rows themselves give. */}
                The {tileCountWord(tiles.length)} things the studio is made of.
              </p>
            </div>
          ) : null}
          {/* Column counts that DIVIDE the row, named at container breakpoints —
            the same idiom `CardGrid` above uses, and for the same reason: the
            card region is whatever the sidebar and the window leave it, so the
            breakpoint is the region and never the viewport.

            `auto-fit` was here until 2026-09-06 and cannot be told to stop at a
            count. With five built-in tiles it happened to resolve to five; item
            2470 made it six, and five-across left Agent CLIs alone on a second
            row against four columns of whitespace. 1 / 2 / 3 / 6 all divide
            the built-in set, and installed module doors wrap at the same stable
            tile width instead of stretching every built-in when one arrives. */}
          {/* The container is the WRAPPER and the query variants are on the
            child, which is the one way round that works: `@container` makes an
            element a query context for its DESCENDANTS, so an `@[400px]:`
            utility written on the same element resolves against the nearest
            ancestor container instead — an ancestor this page does not have, and
            the grid silently stays at one column. `CardGrid` above is the
            precedent; this is the same two-element shape. */}
          <div className="@container">
            <ul className="grid list-none grid-cols-1 gap-2.5 @[400px]:grid-cols-2 @[620px]:grid-cols-3 @[1160px]:grid-cols-6">
              {tiles.map((row) =>
                row.label && row.Icon ? (
                  <li key={row.key} className="flex flex-col">
                    <ExtensionsHomeTile
                      label={row.label}
                      summary={EXTENSIONS_HOME_TILE_SUMMARIES[row.viewId ?? row.surfaceId]}
                      count={counts[row.viewId ?? row.surfaceId]}
                      Icon={row.Icon}
                      onClick={row.open}
                    />
                  </li>
                ) : null,
              )}
            </ul>
          </div>
        </section>
      </div>
    </GlobalSurfaceShell>
  )
}

/**
 * The plate that opens "Build your own extension": the New chat door in
 * extension mode. Always there, whatever the card feed says.
 */
function BuildExtensionPlate({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <CardButton variant="bordered" onClick={onOpen} className="px-4 py-3">
      <span className="text-body font-semibold text-[color:var(--text-strong)]">Build your own extension</span>
      <span className="mt-0.5 text-meta text-[color:var(--text-muted)]">
        Describe it, and an agent builds it with you in a chat, with the SDK and the skill that teaches it.
      </span>
    </CardButton>
  )
}
