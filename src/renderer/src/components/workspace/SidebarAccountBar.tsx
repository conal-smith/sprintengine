import React from 'react'
import {
  Badge,
  IconButton,
  MenuItem,
  OutlineButton,
  Popover,
  TONE_COLOR_VAR,
  TONE_SOFT_VAR,
  Tooltip,
  TruncatedText,
} from '../ui'
import type { SprintEngineAuthState } from '../../../../shared/electron-api'
import { AccountAvatar, AccountUserGlyph } from './AccountAvatar'
import type { RailBadge } from './AppRail'

// The account + Settings cluster lives at the sidebar bottom, relocated from
// WorkspaceTopBar. The account menu, its trigger, and
// the Settings gear keep their original handlers — only the mount point moved.
//
// Four controls, and no more: the app update, Usage, the account and
// Settings. For four days it also hosted a trigger glyph per registered modal
// surface (doors→modals, 2026-09-01): Plugins, Automations and Design left the top-nav door band and
// opened as modals from beside the gear. The Extensions drawer ruling
// (2026-09-05) sent all three back to being doors — a destination the shell's
// own chrome offers routes the card region — so nothing renders a module's
// modal trigger here. Settings stays because it belongs to the WINDOW rather
// than to whichever section the sidebar is showing, and the usage dashboard
// joined it above the account (owner ruling 2026-10-10) for the same reason:
// what every agent on this machine has spent is nobody's section. The app
// update's glyph joined them on top (owner ruling 2026-10-30): a newer build of
// the app is the window's news, not any section's.

// Three bars of different heights, the column chart with no axes (lucide
// "chart-no-axes-column" geometry): a chart, read at icon size, with nothing
// in it that could be mistaken for a value.
function UsageGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

// The account disc's ring and fill. One colour for every account: signing in
// unlocks nothing (the app is open source, owner ruling 2026-09-27), so the
// disc says who is signed in and nothing about what they may do.
const ACCOUNT_DISC_STYLE = {
  borderColor: TONE_COLOR_VAR.good,
  backgroundColor: TONE_SOFT_VAR.good,
  color: TONE_COLOR_VAR.good,
}

// Symmetric 8-lobe cog (lucide "settings" geometry), centered in the viewBox so
// it reads balanced at small sizes. Replaces an earlier hand-rolled gear whose
// teeth were unevenly spaced.
function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

// The footer cluster is `IconButton`, not a local lookalike. The helper that
// used to live here painted a `control-md` (34px) box with `rounded-md` — the
// OVERLAY radius, on a control — and carried its open state as a border plus
// `bg-hover`, where the kit's pressed state is the neutral `bg-selected` fill.
// Three divergences from the primitive it was imitating, on the most-used
// glyphs in the app. Retired 2026-09-02; the cluster now sits on the kit's
// icon ramp (30px) and speaks the kit's one pressed language.
//
// Deliberately ghost. The cluster is a row of controls inside the rail's
// surface, tier 3 of the control tiers (owner ruling 2026-10-04): the only
// highlight a control carries belongs to the view's one primary action, and a
// row of lifted glyphs would read as a row of tiles.

// The modal-surface trigger glyphs that used to sit here beside the gear
// (doors→modals, 2026-09-01) are rows of the sidebar's Extensions section now
// (ExtensionsRail, app shell 2026-09-05): one home for every surface a
// person can open, whether it mounts as a door or as a modal.

function AccountMenuItem({ onSelect, children }: { onSelect: () => void; children: React.ReactNode }) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const surface = event.currentTarget.closest('[data-account-menu="true"]')
    if (!surface) return
    const items = Array.from(surface.querySelectorAll<HTMLButtonElement>('[data-account-item="true"]'))
    if (items.length === 0) return
    const idx = items.indexOf(event.currentTarget)
    const next =
      event.key === 'Home'
        ? items[0]
        : event.key === 'End'
          ? items[items.length - 1]
          : items[(idx + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }
  return (
    // The kit's menu row. It passes `data-*` through now — this surface's own
    // roving-focus query selects on `data-account-item` — which is the one
    // thing that kept this a raw button element wearing `MENU_ITEM_CLASS`.
    <MenuItem data-account-item="true" onClick={onSelect} onKeyDown={onKeyDown}>
      {children}
    </MenuItem>
  )
}

function AccountPopover({
  authState,
  message,
  onRetry,
  onLogout,
}: {
  authState: SprintEngineAuthState
  message: string | null
  onRetry: () => void
  onLogout: () => void
}) {
  const metaLine = authState.selectedOrganization?.name ?? null
  const primaryLine = authState.user?.displayName ?? authState.user?.email ?? 'Your account'
  const email = authState.user?.displayName ? authState.user?.email : null

  return (
    <div data-account-menu="true" className="w-64 overflow-hidden">
      {/* The header carries the same identity disc as the footer badge, one
          step larger, so the photo (or initials) sits beside the full name. */}
      <div className="flex items-center gap-2.5 px-2.5 pb-2.5 pt-3">
        <AccountAvatar
          user={authState.user}
          className="size-control-sm text-body"
          style={ACCOUNT_DISC_STYLE}
          glyphClassName="icon-md"
        />
        <div className="min-w-0 flex-1">
          <TruncatedText
            as="div"
            text={primaryLine}
            className="text-heading font-medium text-[color:var(--text-strong)]"
          />
          {email ? (
            <TruncatedText as="div" text={email} className="mt-0.5 text-body text-[color:var(--text-muted)]" />
          ) : null}
          {metaLine ? (
            <TruncatedText as="div" text={metaLine} className="mt-1 text-meta text-[color:var(--text-subtle)]" />
          ) : null}
        </div>
      </div>

      {message ? (
        <>
          <div className="border-t border-[color:var(--border-subtle)] px-2.5 py-2 text-body leading-5 text-[color:var(--tone-warn)]">
            {message}
          </div>
          <div className="border-t border-[color:var(--border-subtle)] py-1">
            <AccountMenuItem onSelect={onRetry}>Try again</AccountMenuItem>
          </div>
        </>
      ) : null}
      <div className="border-t border-[color:var(--border-subtle)] py-1">
        <AccountMenuItem onSelect={onLogout}>Sign out</AccountMenuItem>
      </div>
    </div>
  )
}

export type SidebarAccountBarProps = {
  collapsed: boolean
  authState: SprintEngineAuthState
  authMessage: string | null
  accountOpen: boolean
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean>>
  startLogin: () => void | Promise<void>
  refreshAuthState: () => void | Promise<void>
  logout: () => void | Promise<void>
  openSettings: (checkForUpdates?: boolean, targetTab?: string | null) => void
  settingsOpen: boolean
  /**
   * The updates waiting in Settings — an agent CLI or the app itself (owner
   * ruling 2026-09-25) — worn on the gear as the rail's own corner count.
   */
  settingsBadge?: RailBadge | null
  /**
   * The app update's glyph (AppUpdateRailButton), at the top of the cluster:
   * it lights up when a release is waiting, and pressing it downloads and
   * then restarts into it (owner ruling 2026-10-30).
   */
  updateButton?: React.ReactNode
  /** The usage dashboard's open state, and the toggle the chart glyph calls. */
  usageOpen?: boolean
  openUsage?: () => void
}

// Sidebar-bottom account + Settings row. Expanded: the account avatar opens the
// account menu, and the Settings gear sits to its right.
// Collapsed: the avatar and gear stack as centred icons in the rail.
export default function SidebarAccountBar({
  collapsed,
  authState,
  authMessage,
  accountOpen,
  setAccountOpen,
  startLogin,
  refreshAuthState,
  logout,
  openSettings,
  settingsOpen,
  settingsBadge,
  updateButton,
  usageOpen = false,
  openUsage,
}: SidebarAccountBarProps) {
  const accountName = authState.user?.displayName ?? authState.user?.email ?? 'Your account'

  // The ring stays around the photo, and the photo replaces only the initials
  // inside it.
  // On the rail (collapsed) the disc steps up with the square it sits in —
  // control-sm inside the rail's control-lg, the same glyph-to-square ratio the
  // section squares keep — so the foot is not a small cluster under big glyphs.
  const avatar = (
    <AccountAvatar
      user={authState.user}
      className={collapsed ? 'size-control-sm text-body' : 'size-control-xs text-meta'}
      style={ACCOUNT_DISC_STYLE}
      glyphClassName="icon-sm"
    />
  )

  const accountMenu = (
    <AccountPopover
      authState={authState}
      message={authMessage}
      onRetry={() => void refreshAuthState()}
      onLogout={() => void logout()}
    />
  )

  // The gear wears the updates waiting inside Settings the way the rail's
  // squares wear their news: the kit's corner count, ringed in the rail's own
  // canvas (AppRail's RailGlyph). Named — "2 updates available" — so the number
  // is never the whole message, and never drawn at zero.
  const shownSettingsBadge = settingsBadge && settingsBadge.count > 0 ? settingsBadge : null
  // On the rail the account button sits right above the gear, so a tooltip on
  // top would cover it; it opens beside the rail instead, as the rail's own
  // squares' tooltips do.
  const settingsButton = (
    <Tooltip content="Settings" placement={collapsed ? 'right' : 'top'}>
      <IconButton
        size={collapsed ? 'lg' : 'md'}
        pressed={settingsOpen}
        onClick={() => openSettings(false)}
        aria-label="Settings"
        className={shownSettingsBadge ? 'relative' : undefined}
      >
        <GearIcon className={collapsed ? 'size-icon-lg' : 'size-icon-md'} />
        {shownSettingsBadge ? (
          <Badge
            corner
            tone={shownSettingsBadge.tone}
            count={shownSettingsBadge.count}
            max={99}
            ariaLabel={shownSettingsBadge.label}
            className="border-[color:var(--bg-canvas)]"
          />
        ) : null}
      </IconButton>
    </Tooltip>
  )

  const usageButton = openUsage ? (
    <Tooltip content="Usage" placement={collapsed ? 'right' : 'top'}>
      <IconButton size={collapsed ? 'lg' : 'md'} pressed={usageOpen} onClick={openUsage} aria-label="Usage">
        <UsageGlyph className={collapsed ? 'size-icon-lg' : 'size-icon-md'} />
      </IconButton>
    </Tooltip>
  ) : null

  // Icon-only in BOTH sidebar states (owner, 2026-09-01): the footer spends no
  // width on the account name — the badge (provider photo when the session
  // carries one, initials otherwise) is the whole control, the hover tooltip
  // carries the name, and the click popover keeps the full detail.
  const accountControl = authState.authenticated ? (
    <Popover
      open={accountOpen}
      onOpenChange={setAccountOpen}
      ariaLabel="Account"
      popupRole="menu"
      placement="top-start"
      onOpenAutoFocus={(surface) => {
        surface.querySelector<HTMLButtonElement>('[data-account-item="true"]')?.focus()
      }}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content={accountName} placement={collapsed ? 'right' : 'top'}>
          <IconButton
            ref={ref}
            size={collapsed ? 'lg' : 'md'}
            pressed={accountOpen}
            onClick={togglePopover}
            aria-label={`Account · ${accountName}`}
            {...triggerProps}
          >
            {avatar}
          </IconButton>
        </Tooltip>
      )}
    >
      {accountMenu}
    </Popover>
  ) : (
    // Was a hand-rolled copy of OutlineButton — border, surface-raised fill,
    // both hover steps and the whole disabled:hover guard, restated inline.
    // It has to BE the primitive: the outline variant's look has moved twice
    // (a resting elevation on 2026-09-02, flat on a `border.strong` hairline
    // since 2026-10-04), and a lookalike is the one button in the footer that
    // would be left behind each time.
    <OutlineButton
      onClick={() => void startLogin()}
      disabled={authState.status === 'checking'}
      // On the rail the icon-only sign-in fills the same control-lg square as
      // the glyphs above it. `min-h` rather than a fourth labelled size: the
      // outline variant's own `h-control-sm` is the height a LABELLED button
      // takes, and the button spec keeps lg for icon-only chrome.
      className={collapsed ? 'size-control-lg min-h-control-lg p-0' : 'min-w-0 flex-1'}
      aria-busy={authState.status === 'checking'}
      aria-label="Sign in"
    >
      {collapsed ? <AccountUserGlyph className="icon-md" /> : 'Sign in'}
    </OutlineButton>
  )

  return (
    // `app-no-drag` on the cluster, not on each button: the cluster mounts at the
    // foot of the app rail (app shell, 2026-09-05), and the rail is an
    // `app-drag` region the way the title strip is. A drag region swallows the
    // pointer before React sees it, so from the day the cluster moved there the
    // account badge and the gear painted but did not click. Every control in
    // this footer opts out here in one place, the popover trigger included.
    //
    // No rule above the cluster (owner, 2026-09-07): the rail is one column of
    // squares from its first glyph to its foot, and a hairline cutting the
    // account off from the sections above it boxed a strip that the space
    // already separates (principles, "Hairlines carry the structure").
    <div
      className={`app-no-drag shrink-0 ${
        collapsed ? 'flex flex-col items-center gap-1.5 px-2 py-2' : 'flex items-center gap-1.5 px-2 py-1.5'
      }`}
    >
      {/* On the rail, the update glyph and Usage stand above the account; in
          a row they sit with the gear at the right edge, the account holding
          the left. */}
      {collapsed ? updateButton : null}
      {collapsed ? usageButton : null}
      {accountControl}
      {collapsed ? (
        settingsButton
      ) : (
        // With the account control now icon-only, the settings gear pins to
        // the row's right edge; the account badge holds the left.
        <div className="ml-auto flex items-center gap-1.5">
          {updateButton}
          {usageButton}
          {settingsButton}
        </div>
      )}
    </div>
  )
}
