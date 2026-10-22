// Split button — one bordered group carrying a default action and a menu of
// alternatives (design-system/components/split-button). The primary half runs
// the last-used target; the chevron half lists every target and re-points the
// primary.
//
// TWO KINDS OF MENU (ruled 2026-09-10, design-system/components/split-button
// → Usage). The floor below was written for a menu of TARGETS — the same action
// against a different thing — and still binds every one of those. It does not
// bind a menu of ALTERNATIVES: a different route to the SAME outcome, which is
// what a section header's overflow is. The Remote tab's "Pair a device" is the
// case that forced the distinction: its one row, "Paste a pairing link", is not
// another device to pair with, it is the other way to reach the same pairing.
// Promoted to a second visible button it would put two competing verbs on the
// header for one job; dropped, the route disappears. The test is whether
// choosing a row could ever RE-POINT the primary — for a target it can, so a
// list of one has nothing to choose; for an alternative it cannot, so the count
// was never what made the menu worth opening. `menuKind` says which at the call
// site rather than leaving it to be inferred from a length.
//
// Handed FEWER THAN TWO targets it draws the primary half alone, with the
// group's own chrome and no chevron. That is the spec's rule ("keep the menu at
// two or more rows; one alternative is a plain button") made true by the
// component instead of asked of every caller — a chevron whose menu holds one
// row is a control that opens to say nothing. It matters that this is the same
// code rather than a lookalike: the peek's pull request mark is one or several
// depending on what the conversation did, and when its solo arm was a text link
// of its own it lost the 24px hit floor and the hover fill the group gives its
// half, so the SAME mark was a 15px target with one pull request and a 24px one
// with two.
//
// The group owns the border, the radius, and the height; the halves are
// borderless and separated by one internal hairline. That is what keeps it a
// single object rather than two buttons that happen to touch. Because the group
// clips its overflow (so each half's hover fill follows the rounded corners),
// the focus ring is drawn INSET — an outer ring would be cut off.
//
// The menu is the shared `Popover` on `role="menu"`, with `MenuItem` rows and
// `roveMenuFocus` for arrow-key nav, so this adds no menu idiom of its own.

import React from 'react'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import { MenuItem, roveMenuFocus } from './ContextMenu'
import { MENU_GROUP_LABEL_CLASS, MENU_LIST_CLASS } from './menuClasses'
import { FOCUS_RING_INSET_CLASS } from './tokens'

export type SplitButtonItem = {
  id: string
  label: React.ReactNode
  /**
   * The row's spoken name, when the label's own nodes do not read as a sentence
   * — a row whose visible text is `#409` and a title says "Pull request 409,
   * open: …" out loud.
   */
  ariaLabel?: string
  /**
   * The heading this row sits under. Rows carrying the same group in sequence
   * are one section, and the heading is drawn once above them
   * (design-system/components/menu → Divider: a group label is the ALTERNATIVE
   * to a separator, never an addition to it). Undefined on every row means an
   * ungrouped menu, which is what a target list is.
   */
  group?: string
  /** Leading mark, normally the same glyph the primary half shows for it. */
  icon?: React.ReactNode
  /** Right-aligned keyboard hint. Display only — bind the key elsewhere. */
  shortcut?: string
  /** A quiet trailing annotation in the same slot — an age, a count. */
  hint?: string
  /**
   * True on the row the primary half currently runs; renders the check and
   * announces the row as one of a mutually exclusive set.
   *
   * Left undefined the rows are plain `menuitem`s with no checked state, which
   * is what a menu whose primary is a RULE rather than a memory needs: the
   * conversation peek's primary is "the most recent pull request still open",
   * so no row is "the one you chose" and a check would claim otherwise.
   */
  checked?: boolean
  onSelect: () => void
}

export type SplitButtonProps = {
  /**
   * The primary half's content: a verb ("Open"), or a mark that IS the target
   * (the conversation peek's `#418` in its state's tone). A node rather than a
   * string because a caller whose primary is a mark has to set its own type and
   * ink, and doing that from `className` would put two font-size utilities on
   * one element for stylesheet order to resolve. Its own element inside the
   * half has no such contest.
   */
  label: React.ReactNode
  /** Accessible name for the primary half, naming its resolved target. */
  primaryAriaLabel: string
  /** Accessible name for the menu half and its surface, e.g. "Open in…". */
  menuAriaLabel: string
  /** Leading mark on the primary half: what says which target will run. */
  glyph?: React.ReactNode
  items: SplitButtonItem[]
  /**
   * What the rows ARE, which is what decides whether one row earns a caret.
   *
   * `targets` (the default) — the same action against a different thing, where
   * choosing a row runs it AND re-points the primary. One target is a list with
   * nothing to choose, so the group draws the primary half alone.
   *
   * `alternatives` — different routes to the same outcome, where no row can
   * ever become the primary. One row still earns the caret, because the count
   * was never what made the menu worth opening. Such a menu carries no check,
   * for the same reason a derived primary's rows do not: no row is "the one you
   * chose".
   */
  menuKind?: 'targets' | 'alternatives'
  onPrimary: () => void
  /** Menu open/close, e.g. to re-probe which targets still resolve. */
  onMenuOpenChange?: (open: boolean) => void
  /** Forwarded to the primary half — for anchoring feedback to the control. */
  primaryRef?: React.Ref<HTMLButtonElement>
  /**
   * The `ds-split-button--quiet` variant: no outer border, no raised ground,
   * and the hit-target floor (24px) instead of the sm control step, for a split
   * action sitting on a row's META LINE — a card's head line, a row's trailing
   * slot — where the bordered 30px group out-weighs the line and reads as a
   * form control dropped into a sentence.
   *
   * It keeps the single internal hairline, which is the point: without it this
   * would be two bare buttons that happen to be adjacent, and the halves would
   * stop reading as one control. Hover, the held-open chevron and the inset
   * focus ring are unchanged — quiet is a chrome level, not a lower bar.
   */
  quiet?: boolean
  /**
   * Which layer the MENU sits on. `menu` for a split button hosted inside an
   * already-open popover-tier surface — a card, a peek — where the default
   * popover tier would paint the menu under the surface that opened it.
   */
  layer?: 'popover' | 'menu'
  /**
   * A `data-*` marker for the PRIMARY half — how the surface that hosts this
   * control finds its own control in the DOM (the pull request mark's
   * `data-pull-request-mark`, which its sidebar twin carries too).
   *
   * One named attribute rather than a props spread: the half's click, its label
   * and its type are this component's, and a caller able to spread props onto
   * it could quietly re-bind any of them.
   */
  primaryData?: { name: `data-${string}`; value: string }
  /**
   * What the primary half does, in a sentence, on hover and focus: for a
   * primary whose verb alone does not say what it costs or keeps (Handoff
   * beside Compact). The chevron half's own name is its menu's.
   */
  primaryTooltip?: React.ReactNode
  disabled?: boolean
  className?: string
}

// No `.interactive`: its press scale would shrink one half inside the group's
// clip, pulling it off its own border while the other half stood still. It is
// the one control the shared press does not fit (the split-button spec, under
// States). The pressed half takes one more step of ground instead; `enabled:`
// so a disabled half does not answer the press.
const HALF =
  'inline-flex items-center bg-transparent text-[color:var(--text-default)] ' +
  'text-meta font-medium transition-colors hover:bg-[color:var(--bg-hover)] ' +
  'enabled:active:bg-[color:var(--bg-active)] ' +
  'hover:text-[color:var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-45 ' +
  // Inset: the group clips its overflow, so an outward gap would be cut off
  // on the joined edge between the halves.
  FOCUS_RING_INSET_CLASS

// Trailing check on the row the primary half runs. Trailing, not leading: the
// leading slot carries the target's own glyph, which is what makes the row
// identifiable at a glance.
function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-icon-xs shrink-0">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-icon-xs">
      <path
        d="M4.5 6.5L8 10L11.5 6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SplitButton({
  label,
  primaryAriaLabel,
  menuAriaLabel,
  glyph,
  items,
  menuKind = 'targets',
  onPrimary,
  onMenuOpenChange,
  primaryRef,
  primaryData,
  primaryTooltip,
  quiet = false,
  layer = 'popover',
  disabled = false,
  className,
}: SplitButtonProps) {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLElement | null>(null)

  const setOpenState = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      onMenuOpenChange?.(next)
    },
    [onMenuOpenChange],
  )

  // Focus the first row on the next frame, not in this one: Popover keeps its
  // surface `visibility: hidden` until it has measured itself, and a
  // visibility-hidden element cannot take focus — focusing synchronously here
  // silently leaves focus on the trigger, which makes the arrow keys inert
  // (verified in the built app, item 1990).
  const focusFirstItem = React.useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    requestAnimationFrame(() => {
      surface.querySelector<HTMLButtonElement>('[data-menu-item="true"]:not([disabled])')?.focus()
    })
  }, [])

  // ArrowDown/ArrowUp on the menu half open it and land on a row, the standard
  // menu-button contract. Once a row holds focus its own handler roves.
  const onChevronKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      if (!open) {
        setOpenState(true)
        return
      }
      roveMenuFocus(event, surfaceRef.current)
    },
    [open, setOpenState],
  )

  // The group's chrome and the primary half, spelled once and worn by both
  // shapes: with a chevron beside it, and — under two targets — on its own.
  const groupClass = [
    'inline-flex items-stretch overflow-hidden',
    // Quiet: the chrome comes off and the group comes down to the hit-target
    // floor, for a meta line the bordered group would out-weigh. The overflow
    // clip stays — it is what keeps each half's hover fill inside the corners —
    // and so does the halves' internal hairline, which is what still says one
    // object with two halves.
    // Tier 2 (owner ruling 2026-10-04): the outline button's `border.strong`
    // hairline on a transparent ground, and no depth. Until then the group
    // stood on a raised ground and sank as one piece under either half.
    quiet
      ? 'h-[var(--hit-target-min)] rounded-xs'
      : 'h-control-sm rounded-sm border border-[color:var(--border-strong)] bg-transparent',
  ].join(' ')

  const primaryButton = (
    <button
      ref={primaryRef}
      type="button"
      onClick={onPrimary}
      disabled={disabled}
      aria-label={primaryAriaLabel}
      {...(primaryData ? { [primaryData.name]: primaryData.value } : {})}
      className={`${HALF} gap-1.5 ${quiet ? 'px-1.5' : 'px-2.5'}`}
    >
      {glyph}
      {label}
    </button>
  )
  const primaryHalf = primaryTooltip ? (
    <Tooltip content={primaryTooltip} multiline placement="top" layer={layer} wrapperClassName="flex">
      {primaryButton}
    </Tooltip>
  ) : (
    primaryButton
  )

  // One TARGET: the group is its primary half and nothing else. No `Popover` is
  // mounted at all — a menu that can never be opened is still a listener, a
  // portal and an id. An `alternatives` menu is exempt (see the header note):
  // its single row is a route, not a target, and dropping it drops the route.
  // An EMPTY menu has no exemption either way — a chevron over nothing is a
  // control that opens to say nothing, which is the defect the floor exists for.
  if (items.length === 0 || (items.length < 2 && menuKind === 'targets')) {
    return <span className={[groupClass, className ?? ''].join(' ')}>{primaryHalf}</span>
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpenState}
      ariaLabel={menuAriaLabel}
      popupRole="menu"
      placement="bottom-end"
      layer={layer}
      // The shared list layer. This surface carried `p-1` — horizontal padding,
      // which insets the rows and is exactly what makes a full-bleed `MenuItem`
      // look like a card inside a card. Vertical only, like every other menu.
      surfaceClassName={`min-w-[200px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusFirstItem}
      className={className}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <span className={groupClass}>
          {primaryHalf}
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            onKeyDown={onChevronKeyDown}
            disabled={disabled}
            aria-label={menuAriaLabel}
            aria-haspopup="menu"
            aria-expanded={triggerProps['aria-expanded']}
            aria-controls={triggerProps['aria-controls']}
            className={[
              HALF,
              'border-l border-[color:var(--border-subtle)] text-[color:var(--text-muted)]',
              quiet ? 'px-0.5' : 'px-1',
              open ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : '',
            ].join(' ')}
          >
            <ChevronGlyph />
          </button>
        </span>
      )}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {/* The heading, once per run of rows that share it. Nothing is drawn
              for an ungrouped menu, and a group that repeats after another one
              starts a second section rather than silently merging with the
              first — the order the caller hands over is the order shown. */}
          {item.group && item.group !== items[index - 1]?.group ? (
            <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`}>{item.group}</div>
          ) : null}
          <MenuItem
            icon={item.icon}
            shortcut={item.shortcut}
            hint={item.hint}
            aria-label={item.ariaLabel}
            checked={item.checked}
            // Exactly one target is the primary, and choosing another moves the
            // check rather than adding one — a one-of set, not a row of toggles.
            // Only where there IS a check: a menu that passes no `checked` is a
            // list of actions and its rows stay plain menu items.
            selection="one-of"
            trailing={
              item.checked ? (
                <span className="text-[color:var(--accent-primary)]">
                  <CheckGlyph />
                </span>
              ) : null
            }
            onClick={() => {
              item.onSelect()
              setOpenState(false)
            }}
            onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}
          >
            {item.label}
          </MenuItem>
        </React.Fragment>
      ))}
    </Popover>
  )
}
