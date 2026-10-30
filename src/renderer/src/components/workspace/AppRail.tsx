import React from 'react'

import { ExtensionsGlyph } from '../AppIcons'
import { RailBrandMark } from '../brand/RailBrandMark'
import type { RegisteredGlobalSurface, SurfaceIconComponent } from '../../modules/renderer-host'
import type { SidebarSection } from '../../store/slices/settingsSlice'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/Buttons'
import { type Tone } from '../ui/tokens'
import { Tooltip } from '../ui/Tooltip'
import { TITLE_BAR_HEIGHT } from './AppTitleBar'

// The app rail (app shell, 2026-09-05): the narrow column of glyphs at
// the window's far left that decides what the sidebar column beside it shows,
// and holds the product's standing tools. The rail sits outside the sidebar — the rail names AREAS of the
// product, the sidebar lists the THINGS inside the chosen area, and the two
// never share a column.
//
// Glyphs only (owner ruling, 2026-09-05, revising the captioned first cut): a
// house and a tile grid do not need the words "Home" and "Extensions" under
// them, and the caption was what made the rail 76px wide. One glyph column
// keeps the name on hover and in the accessible name — the same idiom the
// sidebar's collapsed rows already use.
//
// THREE glyphs, top to bottom (Extensions drawer ruling, 2026-09-05, revising
// the four-glyph cut of the same day):
//   Home        — the sidebar shows New chat and the workspaces tree.
//   Automations — the Automations surface takes the card region, with its own
//                 list of automations in the sidebar column beside it.
//   Extensions  — the sidebar becomes the Extensions drawer (Design, Plugins,
//                 Skills) and the Extensions home takes the card region.
// Plugins left the rail: it is one of the things UNDER Extensions, and a
// glyph of its own said it stood beside them. Automations stays because it is
// what the product does rather than something added to it — and it is still
// the automations module's own registered surface, glyph and label taken from
// the registry and gated on the module's enablement, so a disabled module's
// glyph is simply not there.
//
// This is window chrome, not a rail in the context-rail sense
// (`design-system/patterns/context-rail.html`, "one rail, ever"). That ruling is
// about NAVIGATION columns — a list a person walks — and it still holds for the
// sidebar column: a door's rail replaces the sidebar's content, never sits
// beside it. The app rail holds no list. It is a fixed set of glyphs, the way
// the title strip is a fixed set of window controls, and it stays put while
// everything to its right swaps.
//
// Geometry. The rail is a layout measure like SIDEBAR_DEFAULT_WIDTH, not a
// token: a `size.control.lg` square plus a `space.sm` gutter each side, which
// is also the width the account cluster at its foot sits in. The rail's
// squares are a step above the product's largest in-panel control (owner ruling
// 2026-09-07, revising the 46px control-md cut): the point of the column is to
// be found from across the window, and 34px squares carrying 18px glyphs were
// read rather than seen. Its top reserves the title strip's height on every
// platform so the first glyph sits below the chrome row beside it. On macOS the
// native traffic lights, which the hiddenInset frame pins at x:12
// (window-factory.ts), start in that reserve and run past the rail's edge — the
// sidebar's chrome row insets for the remainder (SidebarChrome,
// TRAFFIC_LIGHT_RESERVE − APP_RAIL_WIDTH).
export const APP_RAIL_WIDTH = 56
// Where the three lights end, as AppTitleBar's own reserve measures it.
export const TRAFFIC_LIGHT_RESERVE = 78

// The registered surfaces that stand on the rail, in rail order. Ids, not
// modules. None today: Automations stood here until scheduled agents replaced
// it (2026-09-30). The mechanism stays a LIST because what the rail holds is a
// ruling rather than a constant of the code — a standing tool would join it
// here rather than be hand-placed in the JSX.
export const RAIL_SURFACE_IDS: readonly string[] = []

// A rail square needs a name and a glyph, and a door declares both optionally
// (a door may name itself through its own nav-entry row instead). Narrowing here
// rather than at the call site keeps the rail from ever having to render a
// nameless square.
export type RailSurface = RegisteredGlobalSurface & { label: string; Icon: SurfaceIconComponent }

/** The rail's surfaces, picked from the host's enablement-filtered list and put in rail order. */
export function railSurfacesOf(surfaces: readonly RegisteredGlobalSurface[]): RailSurface[] {
  return RAIL_SURFACE_IDS.flatMap((id) => {
    const surface = surfaces.find((candidate) => candidate.id === id)
    return surface?.label && surface.Icon ? [surface as RailSurface] : []
  })
}

// A house: the workspaces tree, where every chat lives.
function HomeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 7.6 8 3l5.5 4.6V13a.5.5 0 0 1-.5.5H9.6V10H6.4v3.5H3a.5.5 0 0 1-.5-.5V7.6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// What a rail square wears at its corner when its area has news: the count of
// things there that the person has not seen or that are waiting on them, in the
// tone of the loudest one. Null (or absent) is no badge at all — a zero is
// never drawn (badge spec: "a number that really is nothing is words").
export type RailBadge = {
  /** What is counted, without the place ("2 waiting on you, 1 new") — for a row that already names the place. */
  detail?: string
  count: number
  tone: Tone
  /** The accessible name — a bare "3" tells a screen reader nothing. */
  label: string
}

// Keyed by what the square opens: `home`, `extensions`, or a rail surface's id.
// Derived by the host (useRailBadges); the rail only wears them.
export type RailBadges = Readonly<Partial<Record<string, RailBadge | null>>>

type AppRailProps = {
  section: SidebarSection
  onSelectSection: (section: SidebarSection) => void
  badges?: RailBadges
  // The module surfaces promoted onto the rail (railSurfacesOf), already
  // enablement-filtered by the host.
  surfaces: readonly RailSurface[]
  activeGlobalSurface: string | null
  onOpenSurface: (surface: RailSurface) => void
  // The account + Settings cluster stays at the rail's foot across sections,
  // with only the brand mark below it. Owned by the host; the rail only places
  // it.
  accountSlot?: React.ReactNode
}

// One rail glyph on a control-lg square, named by its tooltip and accessible
// name. Selection is the neutral `bg-selected` fill — never the accent, never a
// bar on the window's edge (principles, "Selection is neutral"). A section
// glyph is `aria-current` while its section shows; a surface glyph is
// `aria-pressed` while its surface holds the card region — the two can light
// together, and they say different things: which column, and what is in the
// region beside it.
//
// The badge (owner, 2026-09-07) is the kit's corner counter docked on the
// square to count unread activity: a number in a circle, never a glass
// toast — a toast for every chat that finished would be over the top, and the
// count is what says "come back here" without interrupting what the person is
// doing. It sits ON the square, so its separating ring is the rail's own
// canvas rather than the app ground the primitive assumes.
function RailGlyph({
  label,
  active,
  current,
  badge,
  onClick,
  children,
}: {
  label: string
  active: boolean
  current: 'section' | 'surface'
  badge?: RailBadge | null
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    // No material paint of its own: under the tinted window material the
    // square is exactly the solid one, standing on the rail's ambient wash
    // (assets/index.css). A glow worn per square read as a tile behind every
    // button, so the material never decorates a single control.
    <Tooltip content={label} placement="right" wrapperClassName="flex">
      {/* The kit's icon button at its one `lg` step — the rail's own square,
          which is what `size.control.lg` exists for. `pressed` carries the
          neutral selection fill for BOTH rail states; the explicit
          `aria-pressed` after it keeps a section glyph out of the toggle
          vocabulary (it says `aria-current="page"` instead), which is exactly
          the tri-state contract the prop documents. */}
      <IconButton
        size="lg"
        pressed={active}
        onClick={onClick}
        aria-label={label}
        aria-current={current === 'section' && active ? 'page' : undefined}
        aria-pressed={current === 'surface' ? active : undefined}
        className="app-no-drag relative"
      >
        {children}
        {badge && badge.count > 0 ? (
          <Badge
            corner
            tone={badge.tone}
            count={badge.count}
            max={99}
            ariaLabel={badge.label}
            className="border-[color:var(--bg-canvas)]"
          />
        ) : null}
      </IconButton>
    </Tooltip>
  )
}

export function AppRail({
  section,
  onSelectSection,
  badges,
  surfaces,
  activeGlobalSurface,
  onOpenSurface,
  accountSlot,
}: AppRailProps) {
  return (
    <nav
      aria-label="App rail"
      style={{ width: APP_RAIL_WIDTH }}
      // The whole column is a drag region — it is window chrome — and each
      // control opts back out, exactly as the title strip does.
      // `window-chrome` travels with the canvas fill: under the glass window
      // material this column IS the OS frost, so the squares' hover and their
      // neutral selection fill tint it instead of covering it (assets/index.css,
      // the glass block). Nothing on an opaque window.
      className="window-chrome app-drag relative flex shrink-0 flex-col items-stretch bg-[color:var(--bg-canvas)]"
    >
      {/* The title strip's height, reserved: the first glyph sits below the
          chrome row beside it, and on macOS the native traffic lights start here.
          `chrome-bar` enrols it in the window's top band: it paints nothing on a
          solid window (it keeps inheriting the nav's canvas), and under glass it
          takes --bg-chrome-bar so this square carries the same material as the
          three strips to its right instead of becoming a seam in the band. */}
      <div aria-hidden="true" className={`chrome-bar ${TITLE_BAR_HEIGHT} shrink-0`} />
      {/* No divider on this edge any more (owner, 2026-09-09). It used to be an
          absolutely-positioned hairline starting at TITLE_BAR_HEIGHT_PX — the
          offset was there so the rule did not draw through the green traffic
          light — but the column beside the rail is now a rounded card standing
          on the same frost the rail is made of. The card's own edge is the
          boundary, and a rule in the gap between them separates frost from
          frost. Removing it is also what makes the window read as ONE piece of
          glass with cards floating on it rather than a set of ruled columns. */}
      <div className="flex flex-col items-center gap-1.5 px-2 pt-1">
        <RailGlyph
          label="Home"
          current="section"
          active={section === 'home'}
          badge={badges?.home}
          onClick={() => onSelectSection('home')}
        >
          <HomeGlyph className="icon-lg" />
        </RailGlyph>
        {surfaces.map((surface) => (
          <RailGlyph
            key={surface.id}
            label={surface.label}
            current="surface"
            active={activeGlobalSurface === surface.id}
            badge={badges?.[surface.id]}
            onClick={() => onOpenSurface(surface)}
          >
            <surface.Icon className="icon-lg" />
          </RailGlyph>
        ))}
        <RailGlyph
          label="Extensions"
          current="section"
          active={section === 'extensions'}
          badge={badges?.extensions}
          onClick={() => onSelectSection('extensions')}
        >
          <ExtensionsGlyph className="icon-lg" />
        </RailGlyph>
      </div>
      <div className="flex-1" />
      {accountSlot}
      {/* The brand, last in the column and below Settings (owner ruling
          2026-10-30): the icon's "se", opening the project's repository. It
          moved here from the top of the sidebar's chrome row, so the window
          still shows the brand exactly once. */}
      <RailBrandMark />
    </nav>
  )
}
