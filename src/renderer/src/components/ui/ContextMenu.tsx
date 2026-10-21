import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS } from './tokens'
import { MENU_DIVIDER_CLASS, MENU_GROUP_LABEL_CLASS, MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from './menuClasses'
import { HIGHLIGHT_COLORS, getHighlightSwatch } from '../../utils/highlight'
import {
  PROJECT_COLOR_PRESETS,
  PROJECT_SWATCH_CLASS,
  projectColorStyle,
  type ProjectColor,
  type ProjectColorSetting,
} from '../../utils/projectColor'
import type { HighlightColor } from '../../types/workspace'

// Pointer-positioned context menu. Unlike Popover (anchored to a trigger
// element), this surface opens at viewport coordinates — a right-click point
// or a kebab button corner — and clamps itself inside the viewport. The menu tier
// (`--z-menu`) keeps it above the popover/tooltip layer (`--z-popover`).
//
// PORTALLED to document.body. It used to render in place with `position:
// fixed`, on the assumption that fixed always resolves against the viewport.
// It does not: any ancestor with `transform`, `filter`, `perspective`,
// `contain`, `backdrop-filter`, or `will-change` on those becomes the
// containing block for fixed descendants, and its `overflow` then clips the
// menu. That is not hypothetical here — `.drawer-panel` and
// `.settings-overlay-panel` carry `transform: translate3d(…)` AND
// `will-change: transform` permanently, including at rest
// (assets/index.css:2140-2148, :2185-2194), so a menu opened inside one was
// clipped at the panel edge (a door rail's kebab showed `Ma… Rev… Del…`).
// Positioning is unchanged — `useClampedMenuPosition` already measures against
// the viewport, which is exactly what the portal now makes true.
//
// Only the ROOT surface portals. `MenuFlyoutItem`'s nested surface must stay
// inside this menu's DOM (see its comment) so the outside-pointerdown check
// below treats flyout clicks as inside clicks — and because the root has left
// the clipping ancestor, the flyout inside it is out too.
//
// React events still bubble to the React parent through a portal, so callers
// that relied on propagation (or on stopPropagation) are unaffected.
//
// Contract: role="menu" surface with an accessible name, Escape closes and
// restores focus to the previously focused element, outside pointerdown
// closes without stealing focus, ArrowUp/ArrowDown/Home/End rove focus
// across enabled items, and checkable items render role="menuitemcheckbox"
// with aria-checked.

// The surface comes from `menuClasses`, not from here. This component
// used to spell its own — 6px radius, `border-default`, `bg-surface`, 4px
// padding all round, `text-body` items — while every other menu in the app
// rendered inside `Popover` at 7px, `border-strong`, `bg-surface-raised` with
// 12px items. Right-clicking a row and pressing its kebab opened two visibly
// different menus onto the same actions. Converging the values was step one;
// this is step two, and it is what stops them diverging again.
//
// What actually distinguishes this component is that it positions at a POINTER
// rather than an anchor. That is positioning; it is not a reason to be made of
// different material — so it takes the standalone form of the shared surface
// (chrome plus list) instead of getting the chrome from `Popover`.
const MENU_Z_INDEX = 'var(--z-menu)'

type ClampOptions = {
  /**
   * When the menu would overflow the right viewport edge, re-anchor its right
   * edge to this x instead of sliding along the bottom — used by flyout
   * submenus to open leftward of their parent item rather than covering it.
   */
  flipXTo?: number
}

// Keeps a coordinate-positioned menu fully inside the viewport. If the menu
// would overflow the bottom, flip it above the anchor point so the user can
// read it.
export function useClampedMenuPosition(
  x: number,
  y: number,
  ref: React.RefObject<HTMLElement | null>,
  options?: ClampOptions,
) {
  const flipXTo = options?.flipXTo
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 6
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (x + rect.width + margin > vw) {
      left =
        typeof flipXTo === 'number'
          ? Math.max(margin, flipXTo - rect.width)
          : Math.max(margin, vw - rect.width - margin)
    }
    if (y + rect.height + margin > vh) {
      const flipped = y - rect.height
      top = flipped >= margin ? flipped : Math.max(margin, vh - rect.height - margin)
    }
    setPos({ left, top })
  }, [x, y, ref, flipXTo])
  return pos
}

// Enabled items belonging directly to `surface` — items inside an open nested
// flyout have a nearer role="menu" ancestor and are excluded, so each surface
// roves only its own level.
function menuItemsOf(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('[data-menu-item="true"]:not([disabled])')).filter(
    (el) => el.closest('[role="menu"]') === surface,
  )
}

// Exported so a menu hosted in a Popover (SplitButton) reuses this nav rather
// than growing a second copy. `surface` is the element carrying role="menu".
export function roveMenuFocus(event: React.KeyboardEvent, surface: HTMLElement | null): void {
  if (!surface) return
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
    return
  }
  const items = menuItemsOf(surface)
  if (items.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  const active = document.activeElement as HTMLElement | null
  const index = active ? items.indexOf(active) : -1
  let next: HTMLElement | undefined
  if (event.key === 'Home') next = items[0]
  else if (event.key === 'End') next = items[items.length - 1]
  else if (event.key === 'ArrowDown') next = index < 0 ? items[0] : items[(index + 1) % items.length]
  else if (event.key === 'ArrowUp')
    next = index < 0 ? items[items.length - 1] : items[(index - 1 + items.length) % items.length]
  next?.focus()
}

type ContextMenuProps = {
  /** Viewport x of the open point (e.g. `event.clientX` or a button corner). */
  x: number
  /** Viewport y of the open point. */
  y: number
  /** Required accessible name for the menu surface. */
  ariaLabel: string
  onClose: () => void
  children: React.ReactNode
  /** Extra surface classes — typically a `min-w-[…]` floor. */
  surfaceClassName?: string
}

export function ContextMenu({ x, y, ariaLabel, onClose, children, surfaceClassName }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const pos = useClampedMenuPosition(x, y, ref)

  const restoreFocus = useCallback(() => {
    previousFocusRef.current?.focus()
  }, [])

  // Capture the opener and move focus onto the surface so Escape and the
  // arrow keys work immediately. The layout cleanup runs before the node
  // leaves the DOM, so a close triggered while focus is inside the menu
  // (keyboard item activation) hands focus back instead of dropping it.
  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const surface = ref.current
    surface?.focus()
    return () => {
      if (surface?.contains(document.activeElement)) restoreFocus()
    }
  }, [restoreFocus])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        restoreFocus()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    // keydown on document, not window: it must run BEFORE a host Modal's
    // window listener so preventDefault() reaches the dialog's Escape guard
    // and only this topmost surface closes (same fix Popover carries).
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, restoreFocus])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(event) => roveMenuFocus(event, ref.current)}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: MENU_Z_INDEX }}
      // design-tokens-allow: tabIndex -1 surface focused only to seed roving focus; the menu item that takes focus carries the shared ring
      className={`${MENU_SURFACE_CLASS} focus:outline-none ${surfaceClassName ?? ''}`}
    >
      {children}
    </div>,
    document.body,
  )
}

type MenuItemProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'role' | 'aria-checked' | 'type' | 'children'
> & {
  children: React.ReactNode
  /**
   * Receives the event. Widened from `() => void` (drift sweep, 2026-09-08):
   * the Windows/Linux app menu positions the native popup from the clicked
   * row's rect, and a handler that could not see the event had to stay a raw
   * `<button>` wearing `MENU_ITEM_CLASS` for that one reason.
   */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** E.g. open a secondary picker at the pointer; the menu stays open. */
  onContextMenu?: (event: React.MouseEvent) => void
  /** Leading glyph; size and color stay with the caller's node. */
  icon?: React.ReactNode
  /** Visible keyboard shortcut hint (e.g. `F2`). Display only. */
  shortcut?: string
  /**
   * The same trailing slot, carrying a quiet ANNOTATION rather than an
   * accelerator — how long ago a row's subject happened, how many of something
   * it holds. One slot with two names because the two are different promises: a
   * shortcut says "this key works without opening this menu"
   * (design-system/components/menu → Keyboard hints), and this says nothing
   * about keys at all. A row states one or the other, never both.
   */
  hint?: React.ReactNode
  variant?: 'danger'
  disabled?: boolean
  /** When set, the item is checkable and exposes this checked state.
   *  The VISIBLE marker stays with the caller — pass it as `icon` (leading) or
   *  `trailing`, so a row whose leading slot already carries a target glyph can
   *  still show its check. */
  checked?: boolean
  /** How the checkable items in this menu relate to each other. `single` — the
   *  default — is a set of independent toggles. Pass `'one-of'` when the menu
   *  picks exactly one of a mutually exclusive set (a target, a mode): the row
   *  then announces as `menuitemradio`, so a screen reader says "1 of 3"
   *  instead of offering to uncheck a choice that cannot be unchecked. */
  selection?: 'single' | 'one-of'
  /** Trailing node, after the shortcut. For a check mark on a row whose leading
   *  slot is taken. */
  trailing?: React.ReactNode
  /** Attached to the button, so a host menu with its own roving-focus nav (e.g.
   *  SplitButton) can drive arrow keys through the items. ContextMenu omits it
   *  and keeps its own surface-level handling — same contract as
   *  MenuSwatchRow's `onItemKeyDown`. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  /** The row opens a sub-surface and states so. A drill-in row shows the value
   *  in force beside the chevron; put both in `trailing`. */
  expanded?: boolean
}

export function MenuItem({
  children,
  onClick,
  onContextMenu,
  icon,
  shortcut,
  hint,
  variant,
  disabled,
  checked,
  selection = 'single',
  trailing,
  onKeyDown,
  expanded,
  className,
  ...rest
}: MenuItemProps) {
  const checkableRole = selection === 'one-of' ? 'menuitemradio' : 'menuitemcheckbox'
  return (
    <button
      type="button"
      role={checked !== undefined ? checkableRole : 'menuitem'}
      aria-checked={checked}
      aria-expanded={expanded}
      data-menu-item="true"
      // Roving focus is the menu's, so the ROW is not a tab stop by default —
      // but a group whose current value must be the stop (a radiogroup inside a
      // popover) states its own, and `{...rest}` below is what lets it. Same for
      // the `data-*` hooks a host's own focus query and its panel tests select
      // on: a row that swallowed them is why nine of these stayed raw elements.
      tabIndex={-1}
      disabled={disabled}
      {...rest}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      // Shape, size, hover fill and focus ring are the shared item's, so this
      // row is identical to the one a kebab or a split button opens. Only the
      // ink is decided here: destructive is ink, never a fill
      // (design-system/components/menu). It carried its own
      // `rgba(255,120,124,0.08)` hover tint, which was both a raw colour and a
      // second signal saying what the ink already says.
      className={`${MENU_ITEM_CLASS} ${
        variant === 'danger'
          ? 'text-[color:var(--tone-error)]'
          : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]'
      } ${className ?? ''}`}
    >
      {icon ?? null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {(shortcut ?? hint) ? (
        <span className="text-micro text-[color:var(--text-disabled)] font-mono">{shortcut ?? hint}</span>
      ) : null}
      {trailing}
    </button>
  )
}

export function MenuDivider() {
  return <div role="separator" className={MENU_DIVIDER_CLASS} />
}

type MenuSwatchRowProps = {
  /** Optional section label rendered above the row (e.g. "Highlight color"). */
  label?: string
  /** Currently applied color; null means no color is applied. */
  value: HighlightColor | null
  onPick: (color: HighlightColor) => void
  onClear: () => void
  /** Optional keydown handler attached to each swatch button, so a host menu
   *  with its own roving-focus nav (e.g. OverflowMenu) can drive arrow keys
   *  through the swatches. ContextMenu omits it and keeps its own handling. */
  onItemKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

// One-tap color choice row: a clear control followed by the seven canonical
// highlight swatches. Swatches behave as a radio group within the menu —
// each is a menuitemradio carrying aria-checked for the applied color.
//
// Each swatch is a 20px circle inside a 24px button: `size.hit-target-min` is
// the floor for anything interactive, and a small glyph pads out to it with a
// transparent hit area rather than shrinking its target (principles.md → Space
// and size). `h-6` is that floor; the hover is the neutral fill.
const SWATCH_TARGET_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--bg-hover)]'

// The 20px disc inside that target, spelled once for all four swatches in this
// file — the highlight row's clear control and hue dots, and the project row's
// below. It is still off the icon ramp (20px sits between `icon-md` 18 and
// `icon-lg` 22) and still owed; it is now owed in one place instead of four,
// the same repair WorkspaceLayout's tab chip took on 2026-09-06.
const SWATCH_DOT_SIZE_CLASS = 'h-5 w-5'

export function MenuSwatchRow({ label, value, onPick, onClear, onItemKeyDown }: MenuSwatchRowProps) {
  return (
    <>
      {label ? <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`}>{label}</div> : null}
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <Tooltip content="Clear color">
          <button
            type="button"
            // The strip is a HORIZONTAL radio group of 20px circles. `menuitemradio` is what ARIA
            // requires of any child of a menu, and the shared row's full-bleed geometry would draw
            // seven stacked rows where the control is one line of dots.
            // design-tokens-allow: 2026-08-05 — a swatch, not a menu row.
            role="menuitemradio"
            aria-checked={value === null}
            data-menu-item="true"
            tabIndex={-1}
            onClick={onClear}
            onKeyDown={onItemKeyDown}
            aria-label="Clear color"
            // A 20px circle padded out to the 24px hit-target floor: the box is
            // the target, the inner ring is the mark. Hover is the background
            // change every control gets — no scale, no glow (principles.md →
            // Selection and focus).
            className={`${SWATCH_TARGET_CLASS} ${FOCUS_RING_CLASS} text-[color:var(--text-disabled)] hover:text-[color:var(--text-default)]`}
          >
            <span
              aria-hidden="true"
              className={`flex ${SWATCH_DOT_SIZE_CLASS} items-center justify-center rounded-full border border-[color:var(--border-default)] ${
                value === null ? 'ring-1 ring-[color:var(--text-default)]' : ''
              }`}
            >
              <svg viewBox="0 0 12 12" fill="none" className="icon-xs">
                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </span>
          </button>
        </Tooltip>
        {HIGHLIGHT_COLORS.map((color) => {
          const swatch = getHighlightSwatch(color)
          const selected = value === color
          return (
            <Tooltip key={color} content={swatch.label}>
              <button
                type="button"
                // design-tokens-allow: 2026-08-05 — a swatch, not a menu row; see the
                // clear control above. The colour IS the control here.
                role="menuitemradio"
                aria-checked={selected}
                data-menu-item="true"
                tabIndex={-1}
                onClick={() => onPick(color)}
                onKeyDown={onItemKeyDown}
                aria-label={`Highlight ${swatch.label}`}
                className={`${SWATCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
              >
                {/* The selected mark is the ring and only the ring — the glow
                    and the hover scale this used to carry are the two hover
                    treatments the principles rule out. */}
                <span
                  aria-hidden="true"
                  className={`block ${SWATCH_DOT_SIZE_CLASS} rounded-full ${
                    selected ? 'ring-2 ring-offset-1 ring-offset-[color:var(--bg-surface)]' : ''
                  }`}
                  style={{
                    backgroundColor: swatch.hex,
                    ['--tw-ring-color' as never]: swatch.hex,
                  }}
                />
              </button>
            </Tooltip>
          )
        })}
      </div>
    </>
  )
}

type ProjectColorSwatchRowProps = {
  /** Section label above the row. Defaults to "Project color", the spelling
   *  the sibling "Highlight color" row already uses in the same menu. */
  label?: string
  /** The override in force: a hue, `'none'` for a deliberate no-colour, or
   *  null when the project wears its hashed hue. */
  value: ProjectColorSetting | null
  /** The hashed hue this project wears with no override, drawn on the
   *  "Automatic" swatch so a person can see what they would return to. */
  automaticColor: ProjectColor
  /** Picking a hue, `'none'` from the trailing dashed swatch, or null from
   *  "Automatic" — which deletes the override. */
  onPick: (color: ProjectColorSetting | null) => void
  /** Same roving-focus escape hatch as MenuSwatchRow above. */
  onItemKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

const PROJECT_SWATCH_SELECTED_CLASS =
  'ring-2 ring-offset-1 ring-[color:var(--text-strong)] ring-offset-[color:var(--bg-surface)]'

// The "Project colour" row: "Automatic" (the project's hashed hue), the named
// presets, then a dashed "No colour" swatch (owner, 2026-09-09; hashed hues
// 2026-09-11).
//
// Deliberately its own component rather than a mode on MenuSwatchRow. The two
// rows answer different questions — a highlight is a tint a person puts ON a
// row, a project colour is what the project IS — and they differ in every part
// that matters: hex swatches against theme-tokened hues, and a leading "clear"
// against a leading "Automatic" that still shows a colour and a trailing "No
// colour" that is itself a stored choice. Folding them together would have made
// the highlight row carry a flag for each of those.
export function ProjectColorSwatchRow({
  label = 'Project color',
  value,
  automaticColor,
  onPick,
  onItemKeyDown,
}: ProjectColorSwatchRowProps) {
  const swatches: Array<{ key: string; label: string; hue: ProjectColor; pick: ProjectColorSetting | null }> = [
    { key: 'automatic', label: 'Automatic', hue: automaticColor, pick: null },
    ...PROJECT_COLOR_PRESETS.map((preset) => ({
      key: preset.label,
      label: preset.label,
      hue: preset.hue,
      pick: preset.hue,
    })),
  ]
  return (
    <>
      {label ? <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`}>{label}</div> : null}
      <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
        {swatches.map((swatch) => {
          const selected = value === swatch.pick
          return (
            <Tooltip key={swatch.key} content={swatch.label}>
              <button
                type="button"
                // A HORIZONTAL radio group of 20px circles, same as the
                // highlight row above: `menuitemradio` is what ARIA requires of
                // a menu's children, and the shared full-bleed row would draw
                // ten stacked lines where this control is one line of dots.
                // design-tokens-allow: 2026-09-09 — a swatch, not a menu row: the
                // colour IS the control, so it cannot wear MENU_ITEM_CLASS's row geometry.
                role="menuitemradio"
                aria-checked={selected}
                data-menu-item="true"
                tabIndex={-1}
                onClick={() => onPick(swatch.pick)}
                onKeyDown={onItemKeyDown}
                aria-label={`Project color ${swatch.label}`}
                className={`${SWATCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
              >
                {/* The hue rides the same class and custom property the glyph
                    wears, so a swatch reads on all eleven themes and is the
                    colour the glyph then takes. The selected mark is a NEUTRAL
                    ring: the swatches are already every colour, and one more to
                    say "this one" would be the only thing on the row that is
                    not a hue. */}
                <span
                  aria-hidden="true"
                  className={`block ${SWATCH_DOT_SIZE_CLASS} rounded-full ${PROJECT_SWATCH_CLASS} ${
                    selected ? PROJECT_SWATCH_SELECTED_CLASS : ''
                  }`}
                  style={projectColorStyle(swatch.hue)}
                />
              </button>
            </Tooltip>
          )
        })}
        <Tooltip content="No color">
          <button
            type="button"
            // design-tokens-allow: 2026-09-09 — the trailing swatch of the row
            // above, same shape and same carve-out from the shared menu row.
            role="menuitemradio"
            aria-checked={value === 'none'}
            data-menu-item="true"
            tabIndex={-1}
            onClick={() => onPick('none')}
            onKeyDown={onItemKeyDown}
            aria-label="No color"
            className={`${SWATCH_TARGET_CLASS} ${FOCUS_RING_CLASS} text-[color:var(--text-disabled)] hover:text-[color:var(--text-default)]`}
          >
            {/* Dashed and empty, the same "there is deliberately nothing here"
                mark the Backlog's epic dot uses for an epic with no colour —
                and the same dash the unfiled folder glyph wears, so the two
                readings of "no colour" look like each other. */}
            <span
              aria-hidden="true"
              className={`block ${SWATCH_DOT_SIZE_CLASS} rounded-full border border-dashed border-current ${
                value === 'none'
                  ? 'ring-2 ring-offset-1 ring-[color:var(--text-strong)] ring-offset-[color:var(--bg-surface)]'
                  : ''
              }`}
            />
          </button>
        </Tooltip>
      </div>
    </>
  )
}

type MenuFlyoutItemProps = {
  /** Visible item label. */
  label: React.ReactNode
  /** Required accessible name for the nested menu surface. */
  ariaLabel: string
  icon?: React.ReactNode
  disabled?: boolean
  /**
   * A quiet annotation in the trailing column, before the chevron: the same
   * slot and treatment as `MenuItem`'s `hint`. Its job here is saying why a
   * disabled flyout is off ("No messages yet"), as a disabled row does.
   */
  hint?: React.ReactNode
  /** Extra classes for the flyout surface — typically a `min-w-[…]` floor. */
  surfaceClassName?: string
  /** Optional keydown handler run before the trigger's own open logic, so a host
   *  menu with its own roving-focus nav (e.g. OverflowMenu) can drive
   *  Up/Down/Home/End through the flyout trigger. ContextMenu omits it and keeps
   *  its own handling; the trigger still owns ArrowRight/Enter/Space to open. */
  onItemKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  /** Open-state notifications, e.g. to lazily refresh flyout content. */
  onOpenChange?: (open: boolean) => void
  /** Flyout content: MenuItem / MenuDivider / MenuSwatchRow children. */
  children: React.ReactNode
}

// Close-intent grace period when the pointer crosses the gap between the
// item and its flyout surface.
const FLYOUT_CLOSE_DELAY_MS = 150
// Offset so the flyout's first item top-aligns with the parent item: the
// surface carries py-1 (4px) padding plus a 1px border above its first child.
const FLYOUT_SURFACE_INSET = 5
const FLYOUT_GAP = 2

function MenuFlyoutSurface({
  anchor,
  ariaLabel,
  surfaceClassName,
  onDismiss,
  children,
}: {
  anchor: DOMRect
  ariaLabel: string
  surfaceClassName?: string
  onDismiss: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Open at the item's right edge; when the viewport is tight, flip to open
  // leftward of the item instead of sliding over the parent menu.
  const pos = useClampedMenuPosition(anchor.right + FLYOUT_GAP, anchor.top - FLYOUT_SURFACE_INSET, ref, {
    flipXTo: anchor.left - FLYOUT_GAP,
  })

  useEffect(() => {
    const surface = ref.current
    const preferred = surface?.querySelector<HTMLElement>('[data-menu-autofocus="true"]')
    if (preferred) preferred.focus()
    else surface?.focus()
  }, [])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
          return
        }
        roveMenuFocus(event, ref.current)
      }}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: MENU_Z_INDEX }}
      // design-tokens-allow: tabIndex -1 flyout surface focused only to seed roving focus; the menu item that takes focus carries the shared ring
      className={`${MENU_SURFACE_CLASS} focus:outline-none ${surfaceClassName ?? ''}`}
    >
      {children}
    </div>
  )
}

// Flyout submenu: a menu item that opens a nested menu surface beside itself
// on hover, click, or ArrowRight. The nested surface stays inside the parent
// menu's DOM so the parent's outside-pointerdown close treats clicks in the
// flyout as inside clicks.
export function MenuFlyoutItem({
  label,
  ariaLabel,
  icon,
  disabled,
  hint,
  surfaceClassName,
  onItemKeyDown,
  onOpenChange,
  children,
}: MenuFlyoutItemProps) {
  const itemRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const open = anchor !== null

  // Notify on open-state transitions only. The callback rides in a ref so an
  // inline consumer lambda (fresh identity per render) can't re-fire the
  // notification on every parent re-render.
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })
  useEffect(() => {
    onOpenChangeRef.current?.(open)
  }, [open])

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const openFlyout = useCallback(() => {
    cancelScheduledClose()
    const rect = itemRef.current?.getBoundingClientRect()
    if (rect) setAnchor(rect)
  }, [cancelScheduledClose])

  const closeFlyout = useCallback(() => {
    cancelScheduledClose()
    setAnchor(null)
  }, [cancelScheduledClose])

  const scheduleClose = useCallback(() => {
    cancelScheduledClose()
    closeTimerRef.current = window.setTimeout(() => setAnchor(null), FLYOUT_CLOSE_DELAY_MS)
  }, [cancelScheduledClose])

  useEffect(() => cancelScheduledClose, [cancelScheduledClose])

  return (
    <div role="none" onMouseEnter={cancelScheduledClose} onMouseLeave={scheduleClose}>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-item="true"
        tabIndex={-1}
        disabled={disabled}
        onMouseEnter={() => {
          if (!disabled) openFlyout()
        }}
        onClick={() => {
          if (disabled) return
          if (open) closeFlyout()
          else openFlyout()
        }}
        onKeyDown={(event) => {
          if (disabled) return
          // Let a host menu drive its roving focus first (Up/Down/Home/End); the
          // trigger still owns ArrowRight/Enter/Space to open the flyout.
          onItemKeyDown?.(event)
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            openFlyout()
          }
        }}
        className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)] ${
          open ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : ''
        }`}
      >
        {icon ?? null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint ? <span className="text-micro text-[color:var(--text-disabled)] font-mono">{hint}</span> : null}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          className="icon-xs shrink-0 text-[color:var(--text-disabled)]"
          aria-hidden="true"
        >
          <path
            d="M6 4L10 8L6 12"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {anchor ? (
        <MenuFlyoutSurface
          anchor={anchor}
          ariaLabel={ariaLabel}
          surfaceClassName={surfaceClassName}
          onDismiss={() => {
            closeFlyout()
            itemRef.current?.focus()
          }}
        >
          {children}
        </MenuFlyoutSurface>
      ) : null}
    </div>
  )
}
