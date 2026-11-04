import React, { useId, type JSX } from 'react'

import { FOCUS_RING_PEER_CLASS } from './tokens'

// The kit's checkbox. Five surfaces had each styled the same
// `<input type="checkbox">` independently — 3px and 3.5px boxes, one on the
// browser's `accent-color`, one with a hand-rolled ring whose `ring-offset-color`
// was pinned to `--bg-surface-raised` and therefore wrong on any other surface,
// and one with no focus treatment at all. The most complete of them — the
// styled-peer box in the tracker write-back settings, which is what motivated
// `FOCUS_RING_PEER_CLASS` — is what this promotes. (That surface has since been
// retired with the native tracker layer; the primitive it produced outlived it.)
//
// The native input stays: it carries the semantics, the keyboard path, the
// indeterminate state and form participation. The visible box is decorative and
// hidden from assistive tech, and takes the shared focus treatment through the
// input's `:focus-visible` via `peer`. Nothing here re-implements a checkbox —
// it dresses one.

export type CheckboxProps = {
  checked: boolean
  /** Required unless `readOnly` — a checkbox nobody can change does not take a
   *  handler, and one that can must have somewhere to send the change. */
  onChange?: (next: boolean) => void
  /** Visible label beside the box. Omit only when `ariaLabel` names the control. */
  label?: React.ReactNode
  /** Accessible name when there is no visible `label`. */
  ariaLabel?: string
  ariaDescribedBy?: string
  /** Mixed state — some but not all of the things this checkbox governs are on.
   *  Renders a dash and sets `indeterminate` on the input, which is a DOM
   *  property rather than an attribute and so cannot be expressed in JSX. */
  indeterminate?: boolean
  disabled?: boolean
  /** Stable id, so a `Field` or a sibling label can target the input. */
  id?: string
  /** Type step for the label. `meta` (12px) by default; `body` for form rows
   *  that sit among other 13px controls. */
  size?: 'meta' | 'body'
  /**
   * MARKER MODE — the box is a rendered FACT, not a control: a GFM task-list
   * marker inside rendered markdown, where the checked state comes from the
   * document and toggling it here would change nothing.
   *
   * Three things follow, and each is why this could not be `disabled`:
   *
   * - **No `<label>` wrapper.** The marker sits inside an `<li>` whose text is
   *   already the item; wrapping that text in a label would make the whole
   *   paragraph a click target for a control that does not accept clicks, and
   *   would nest a label inside prose the markdown renderer owns.
   * - **No `onChange`.** React needs `readOnly` on a controlled input with no
   *   handler; without it every rendered task list logs a warning per box.
   * - **Not `disabled`.** A disabled input is skipped by some assistive tech
   *   and reads as "unavailable"; this box is neither. `aria-readonly` says the
   *   true thing: the state is real, and it is not yours to change here.
   *
   * The drawn box is the kit's, unchanged — a task list that invented its own
   * tick is how five surfaces came to draw five checkboxes.
   */
  readOnly?: boolean
  className?: string
}

export function Checkbox({
  checked,
  onChange,
  label,
  ariaLabel,
  ariaDescribedBy,
  indeterminate = false,
  disabled = false,
  id,
  size = 'meta',
  readOnly = false,
  className,
}: CheckboxProps): JSX.Element {
  const generated = useId()
  const inputId = id ?? generated
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  // `indeterminate` has no HTML attribute — it is settable only on the element.
  React.useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  // Marker mode drops the label wrapper — see `readOnly`. The box and the input
  // inside it are identical either way; only the element around them changes, so
  // there is one drawing rather than two.
  const Wrapper = readOnly ? 'span' : 'label'

  return (
    <Wrapper
      htmlFor={readOnly ? undefined : inputId}
      className={[
        readOnly ? 'inline-flex align-middle' : 'flex',
        'select-none items-center gap-2',
        size === 'body' ? 'text-body' : 'text-meta',
        disabled
          ? 'cursor-not-allowed text-[color:var(--text-disabled)]'
          : 'cursor-pointer text-[color:var(--text-default)]',
        className ?? '',
      ].join(' ')}
    >
      <span className="relative inline-flex size-icon-sm shrink-0 items-center justify-center">
        <input
          ref={inputRef}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          readOnly={readOnly}
          aria-readonly={readOnly || undefined}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          onChange={readOnly ? undefined : (event) => onChange?.(event.target.checked)}
          // Transparent, but present and full-size: it is the tab stop, the hit
          // target and the semantics. Hiding it with `display:none` would take
          // the keyboard with it.
          className="peer absolute inset-0 h-full w-full cursor-[inherit] opacity-0 disabled:cursor-not-allowed"
        />
        <CheckboxBox checked={checked} indeterminate={indeterminate} disabled={disabled} peerFocus />
      </span>
      {label}
    </Wrapper>
  )
}

/**
 * THE DRAWN BOX, ALONE — the tick, the dash, the accent fill and the empty
 * square, with no input under it.
 *
 * Extracted 2026-09-09 for `CheckRow`, which cannot use the whole control. A
 * check row lives in a list that is ONE tab stop and walks with
 * `aria-activedescendant`; a real `<input>` per row would be the four
 * hundredth tab stop, and the state a screen reader announces there belongs on
 * the row (`aria-checked` on the `option` / `treeitem`), not on a second
 * control inside it. So the row needs the picture without the control.
 *
 * It is exported rather than copied for the reason the checkbox entry gives
 * for existing at all: five surfaces once drew five checkboxes. There is one
 * drawing, and both callers render it.
 *
 * Always `aria-hidden`. Whatever announces the state — this component's own
 * `<input>`, or the row's `aria-checked` — the box is the picture of it and
 * must never be met twice.
 */
export function CheckboxBox({
  checked,
  indeterminate = false,
  disabled = false,
  peerFocus = false,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  /** True when a sibling `<input class="peer">` is the tab stop this box shows
   *  the focus of. False for a decorative box with no input beside it. */
  peerFocus?: boolean
}): JSX.Element {
  // Checked and indeterminate are both "this box is carrying a value", and both
  // take the accent fill; only the mark inside differs.
  const marked = checked || indeterminate
  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex size-icon-sm items-center justify-center rounded-xs border transition-colors',
        // The input is the tab stop; this box is what a person sees, so the
        // shared treatment lands here on the input's focus. An outline's gap
        // needs no `ring-offset-color`, so it is right on every surface.
        peerFocus ? FOCUS_RING_PEER_CLASS : '',
        disabled ? 'opacity-45' : '',
        marked
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
          : 'border-[color:var(--border-default)] bg-[color:var(--bg-app)]',
      ].join(' ')}
    >
      {indeterminate ? (
        <svg viewBox="0 0 16 16" className="size-icon-xs" fill="none" stroke="currentColor" strokeWidth={2.2}>
          <path d="M4 8h8" strokeLinecap="round" />
        </svg>
      ) : checked ? (
        <svg viewBox="0 0 16 16" className="size-icon-xs" fill="none" stroke="currentColor" strokeWidth={2.2}>
          <path d="M3.5 8.5 L6.5 11.5 L12.5 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  )
}

/**
 * THE RADIO MARK — `CheckboxBox`'s single-answer twin: the same size, border,
 * ground and accent fill, round, with a disc in place of the tick. Added
 * 2026-10-08 for a question's choose-one rows, which had drawn their own.
 *
 * Like the box it is only the picture: always `aria-hidden`, the state carried
 * by whatever owns it (a row's `aria-checked` on `role="radio"`). There is no
 * radio control in the kit — a choose-one list of rows is a `radiogroup` of
 * rows, and a value picked from a closed list is a `Select` or a
 * `SegmentedControl`.
 */
export function RadioMark({ checked, disabled = false }: { checked: boolean; disabled?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-radio-mark=""
      className={[
        'inline-flex size-icon-sm shrink-0 items-center justify-center rounded-[var(--sem-radius-pill)] border transition-colors',
        disabled ? 'opacity-45' : '',
        checked
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
          : 'border-[color:var(--border-default)] bg-[color:var(--bg-app)]',
      ].join(' ')}
    >
      {checked ? (
        <svg viewBox="0 0 16 16" className="size-icon-xs" fill="currentColor">
          <circle cx="8" cy="8" r="3.5" />
        </svg>
      ) : null}
    </span>
  )
}
