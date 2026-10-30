// The sidebar's own top chrome — the left half of the split top chrome. It runs
// to the very top of the window, so the
// window's leftmost controls live here rather than in a full-width title bar.
//
// ONE 36px row (owner, 2026-07-30: one chrome row per content region):
//
//   [traffic-light reserve | app-menu] ··· back forward search collapse
//
// The row is an `app-drag` region; every interactive control opts back out with
// `app-no-drag`. On macOS its leftmost slice is reserved for the native traffic
// lights inset by the hiddenInset frame (window-factory.ts); the reserve
// collapses in fullscreen where the lights are hidden. The right-side window
// controls (min/max/close) are NOT here on win/linux — they pin to the window's
// top-right corner over the content, since the aside can own that corner.
//
// No brand here (owner ruling 2026-10-30): the "sprintengine" wordmark and the
// Nightly chip beside it moved to the foot of the app rail as the icon's "se"
// (brand/RailBrandMark), so the row is only the window's own controls.
//
// This row is chrome, not rail content (item 1991): WorkspaceSidebar mounts it
// above both the workspaces rail and a door's context rail, and outside the
// tree's scroll container — so a drill-in that swaps the rail underneath leaves
// the row untouched, and the row never scrolls away. Collapsed, the whole
// sidebar is hidden and the expand control moves to WorkspaceHeader's launcher.

import React from 'react'
import { IconButton, MenuItem, Popover, Tooltip } from '../ui'
import { MENU_LIST_CLASS } from '../ui/menuClasses'
import { APP_RAIL_WIDTH, TRAFFIC_LIGHT_RESERVE } from './AppRail'

// The row's icon buttons are the kit's `IconButton` at its default `sm` step —
// `size.control.xs`, the system's icon-button step (principles.md, "Space and
// size").
//
// The ink is a TONE, never a className: `subtle` is this row's pair
// (`--text-subtle` at rest lifting to `--bg-hover` + `--text-default`), and
// `strong` is the open-panel one that holds its ink flat while only the ground
// moves. Both used to be local constants here, spelled with the focus-ring
// literal first so the conformance guard could see it; the kit carries all of
// that now, so the constants are gone.

type SidebarChromeProps<MenuItem extends string> = {
  isMac: boolean
  isFullScreen: boolean
  onToggleSidebar: () => void
  onNavigateBack: () => void
  onNavigateForward: () => void
  onOpenSearch: () => void
  // Win/linux only: the app menu, rendered as a single hamburger at all widths
  // (the inline File/Edit/… label bar is dropped here — the ~sidebar-width strip
  // has no room for it). macOS passes an empty list; those menus are the native
  // system menu bar.
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}

// Sidebar toggle: white (text-strong) while its
// panel — the sidebar — is open. This button only renders in the expanded chrome
// row, so it's always the open state here; the collapsed-state open button lives
// in WorkspaceHeader's launcher and stays muted. That is why it is the one glyph
// in the row brighter than its neighbours: the pair is a state contrast read
// across the two states, not decoration.
function CollapseButton({ onToggle }: { onToggle: () => void }) {
  return (
    <Tooltip content="Collapse sidebar" placement="bottom">
      {/* `aria-pressed` stays an explicit attribute rather than the `pressed`
          prop: the fact is true, but the neutral selection fill `pressed`
          paints is not what this control wears — the strong ink IS its open
          state. An attribute after the props still wins. */}
      <IconButton
        tone="strong"
        onClick={onToggle}
        aria-label="Collapse sidebar"
        aria-pressed={true}
        className="app-no-drag"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

// Opens the command palette's search. The rail's own filter field is a different
// control with a different reach — it narrows the list below it and stays down
// there in the list anatomy.
function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Search" placement="bottom">
      <IconButton tone="subtle" onClick={onOpen} aria-label="Search" className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

function NavHistoryButton({ direction, onClick }: { direction: 'back' | 'forward'; onClick: () => void }) {
  const label = direction === 'back' ? 'Back' : 'Forward'
  return (
    <Tooltip content={label} placement="bottom">
      <IconButton tone="subtle" onClick={onClick} aria-label={label} className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d={direction === 'back' ? 'M10 3.5L5.5 8L10 12.5' : 'M6 3.5L10.5 8L6 12.5'}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

// The win/linux app menu, always a single hamburger here (no inline label bar).
// Exported so the collapsed-sidebar launcher (WorkspaceHeader) can host the same
// menu when the sidebar is hidden and this strip is gone.
export function AppMenuButton<MenuItem extends string>({
  menuItems,
  onShowMenu,
}: {
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  return (
    <Popover
      open={menuOpen}
      onOpenChange={setMenuOpen}
      ariaLabel="Application menu"
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-44 ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="Menu" placement="bottom">
          {/* The kit's icon button at `md` (size.control.sm): the neutral ghost
              tone IS this control's ink pair (--text-muted, lifting to
              --bg-hover + --text-strong), and rounded-sm and rounded-md are the
              same 7px step today. It also arrives with the focus ring this
              hand-rolled trigger never drew — the one thing that made it
              unreachable to say where it was from the keyboard. */}
          <IconButton
            ref={ref}
            size="md"
            onClick={togglePopover}
            aria-label="Application menu"
            className="app-no-drag"
            {...triggerProps}
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path
                d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        </Tooltip>
      )}
    >
      {menuItems.map((label) => (
        // The kit's menu row. Its `onClick` now receives the event, which is the
        // one thing that kept this a raw button element: the win/linux app menu
        // positions the native popup from the clicked row's rect.
        <MenuItem
          key={label}
          onClick={(event) => {
            setMenuOpen(false)
            onShowMenu(event, label)
          }}
        >
          {label}
        </MenuItem>
      ))}
    </Popover>
  )
}

export function SidebarChrome<MenuItem extends string>({
  isMac,
  isFullScreen,
  onToggleSidebar,
  onNavigateBack,
  onNavigateForward,
  onOpenSearch,
  menuItems,
  onShowMenu,
}: SidebarChromeProps<MenuItem>) {
  // Only rendered while the sidebar is expanded (the whole sidebar is hidden when
  // collapsed — the collapsed launcher lives in WorkspaceHeader instead).
  //
  // The app rail stands between this column and the window's left edge
  // (app shell, 2026-09-05), and the native macOS traffic lights start
  // in its top reserve — but the rail is a glyph column now, narrower than the
  // lights' 78px span, so the remainder of that span is this row's leading
  // inset. In fullscreen the lights are hidden and the inset collapses.
  const trafficLightInset = isMac && !isFullScreen ? TRAFFIC_LIGHT_RESERVE - APP_RAIL_WIDTH : 0

  return (
    // ONE row (owner, 2026-07-30): one chrome row per content region. Height-
    // locked to WorkspaceHeader's 36px so the two halves of the split chrome meet
    // at the same line across the column seam, and no divider under it — the rail
    // below owns the single "the list starts here" rule (principles.md,
    // Composition).
    <div className="chrome-bar app-drag flex h-[36px] shrink-0 items-center">
      {trafficLightInset > 0 ? (
        <div aria-hidden="true" className="shrink-0" style={{ width: trafficLightInset }} />
      ) : null}
      {/* The app menu where the shell has one to show (none in a browser tab). */}
      {!isMac && menuItems.length > 0 ? (
        <div className="flex shrink-0 items-center pl-1">
          <AppMenuButton menuItems={menuItems} onShowMenu={onShowMenu} />
        </div>
      ) : null}
      {/* Every control at the `control-xs` step, the system's icon-button
          step, pinned to the row's trailing edge. */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-2">
        <NavHistoryButton direction="back" onClick={onNavigateBack} />
        <NavHistoryButton direction="forward" onClick={onNavigateForward} />
        <SearchButton onOpen={onOpenSearch} />
        <CollapseButton onToggle={onToggleSidebar} />
      </div>
    </div>
  )
}
