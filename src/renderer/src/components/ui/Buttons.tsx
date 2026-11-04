import React from 'react'
import { FOCUS_RING_CLASS, FOCUS_RING_INSET_CLASS } from './tokens'

type ButtonBase = React.ButtonHTMLAttributes<HTMLButtonElement>

// `rounded-sm` rather than the `rounded-[5px]` literal this used to spell:
// `assets/index.css` rebinds `--radius-sm` to `sem.radius.control`, so the
// named step tracks the token and the literal did not — which is what left 64
// call sites to sweep when the ramp moved to 7px (2026-09-02).
//
// Radius is NOT here: it moved into the size map when `inline` arrived. Two
// `rounded-*` utilities on one element are resolved by stylesheet order rather
// than by the order they appear in a class string, so a size step that wants
// the chip radius cannot add one — it has to be the only one written.
// `justify-*` left for the same reason (see ALIGN below), and the cursor with
// it (see CURSOR).
const SHARED_LAYOUT = 'interactive inline-flex items-center gap-1.5 font-medium'
const SHARED = `${SHARED_LAYOUT} disabled:opacity-45 aria-disabled:opacity-45`

/**
 * The disabled treatment for a control that must STAY FOCUSABLE — the
 * unavailable state of a toggle whose tooltip says why it is off. `disabled`
 * takes the control out of the tab order, so the explanation is reachable only
 * with a pointer; `aria-disabled` announces the same fact and keeps the stop.
 * The look is identical, and it is spelled once here so a caller writing
 * `aria-disabled` does not also have to remember the opacity and the cursor.
 *
 * Callers pass `aria-disabled` through `{...rest}`; nothing else is needed.
 * The `.interactive` press scale already excludes `[aria-disabled="true"]`.
 */

/**
 * Cursor, as ONE declaration per variant rather than a default plus an
 * override. `busy` is the state of a control that is disabled BECAUSE it is
 * working — an "Open in browser" that has been pressed, a Save mid-flight —
 * and `cursor-wait` says "wait" where `cursor-not-allowed` says "no". Written
 * as two whole branches because `disabled:cursor-wait` and
 * `disabled:cursor-not-allowed` meet at equal specificity, and which of them
 * paints would be stylesheet order.
 */
function cursorClass(busy: boolean | undefined): string {
  return busy
    ? 'cursor-wait disabled:cursor-wait aria-disabled:cursor-wait'
    : 'disabled:cursor-not-allowed aria-disabled:cursor-not-allowed'
}

/**
 * Cross-axis placement of the label inside the control. A prop for the same
 * reason `tone` and `size` are: `justify-center` written into SHARED and a
 * caller's `justify-end` are two utilities of equal specificity, so a shortcut
 * recorder that wants its chord right-aligned under a settings column got
 * whichever one the build happened to emit last.
 *
 * `start` and `end` carry the matching `text-*` alignment, because a button
 * whose box is left-aligned and whose wrapped second line is centred is not a
 * left-aligned button.
 */
export type ButtonAlign = 'center' | 'start' | 'end'

const ALIGN: Record<ButtonAlign, string> = {
  center: 'justify-center',
  start: 'justify-start text-left',
  end: 'justify-end text-right',
}

// xs is the dense-chrome size for inline row actions and popover triggers;
// sm/md carry the form-control sizes, so every button's radius, focus ring, and
// hover match the primitive rather than drifting per surface. Heights and label
// sizes come from the ramp (sem.size.control.*, sem.font.size.*) so a control
// and the label beside it keep their rhythm when the ramp moves.
export type ButtonSize = 'inline' | 'xs' | 'sm' | 'md'

// `inline` is the ONE size that spends no height. It is not an escape hatch and
// it is not "unsized": it carries the kit's ink, hover, press and focus ring
// exactly as every other step does, and gives up only the ramp height, because
// the control sits INSIDE a line of running text or a 16-20px metadata line and
// a 26px box would set that line's height instead of riding it. A task id in a
// dot-separated sentence, a "More" disclosure under a clamped description, an
// epic pill on a card's meta row.
//
// It takes `radius.chip` rather than `radius.control`: at a line box's height
// the 7px control radius eats the corners of a two-word label.
//
// The hit-target floor (`size.hit-target-min`) is deliberately NOT padded out
// here, and that is the difference between this and the sub-ramp `IconButton`
// steps below. A control set in running text is a link: its target is the text,
// and growing its box to 24px would push the lines around it apart. The floor
// governs a standalone glyph, which has no line to belong to.
const SIZE: Record<ButtonSize, string> = {
  inline: 'rounded-xs px-1 text-meta',
  xs: 'rounded-sm h-control-xs px-2 text-meta',
  sm: 'rounded-sm h-control-sm px-2 text-body',
  md: 'rounded-sm h-control-md px-3 text-body',
}

type SizedButtonProps = ButtonBase & {
  size?: ButtonSize
  align?: ButtonAlign
  /** Disabled because the control is WORKING, not because it is unavailable.
   *  Swaps the cursor to `wait` and announces `aria-busy`. */
  busy?: boolean
}

/**
 * The two inks a borderless control can carry. `danger` is the ONLY way to get
 * a destructive ghost — recolouring one through `className` puts two
 * `text-[color:var(--…)]` utilities of equal specificity on the element, and
 * which of them paints is then a question of stylesheet order rather than of
 * what the caller wrote. The Git panel spelled that override at six call sites
 * before the button sweep; making it a prop is what stops the seventh.
 */
export type ButtonTone = 'neutral' | 'danger'

/**
 * The wider ink vocabulary a BORDERLESS control draws from. `ButtonTone` above
 * stays two-valued because it is the emphasis axis of a filled or bordered
 * button — neutral or destructive, and there is no third emphasis. A ghost has
 * no fill to carry emphasis, so what varies is where on the ink ramp it rests
 * and whether it takes a ground at all, and the product genuinely uses six
 * pairs. Every one of them was a `className` override before this, which is the
 * bug the tone prop exists to stop: two `text-[color:var(--…)]` utilities of
 * equal specificity are resolved by stylesheet order, and a tone's own
 * `hover:bg-…` outranks a caller's plain `bg-…` outright.
 *
 * - `neutral` — muted at rest, lifting to strong on `bg.hover`. The default,
 *   and what a toolbar or a dialog footer takes.
 * - `danger`  — the destructive ghost. Ink, never a fill.
 * - `quiet`   — `text.disabled` at rest, lifting to `text.default` on
 *   `bg.hover`. A row action that must be nearly invisible until its row is
 *   hovered. ICON-ONLY: disabled ink never carries a label
 *   (`principles.md` → Accessibility).
 * - `subtle`  — `text.subtle` at rest, lifting to `text.default`. One ink step
 *   above `quiet`: a chrome row that should read as quiet without disappearing.
 * - `strong`  — `text.primary` at rest AND on hover, with only the ground
 *   moving. For a control whose OPEN state is already the loud one: hovering
 *   an open panel's toggle must not read as dimming it.
 * - `accent`  — accent ink, deepening to `accent.hover`, and NO ground at any
 *   state. The affordance inside a sentence. Accent as ink is inside the
 *   budget; accent as a fill is not.
 * - `ink`     — `text.subtle` lifting to `text.default`, and no ground either.
 *   A bare glyph that lives inside something that already has a fill — the
 *   dismiss cross inside a chip, a hairline badge in a heading — where a
 *   second ground would draw a box inside a box.
 */
export type GhostTone = ButtonTone | 'quiet' | 'subtle' | 'strong' | 'accent' | 'ink'

const GHOST_TONE: Record<GhostTone, string> = {
  neutral:
    'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]',
  danger:
    'text-[color:var(--tone-error)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--tone-error)]',
  quiet:
    'text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-disabled)]',
  subtle:
    'text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-subtle)]',
  strong:
    'text-[color:var(--text-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-strong)]',
  accent:
    'text-[color:var(--accent-primary)] hover:bg-transparent hover:text-[color:var(--accent-primary-hover)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--accent-primary)]',
  ink:
    'text-[color:var(--text-subtle)] hover:bg-transparent hover:text-[color:var(--text-default)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-subtle)]',
}

// Every variant below pins its RESTING appearance back under `disabled:hover:`.
// That is not belt-and-braces: CSS `:hover` still matches a disabled button
// (unlike `pointer-events: none`, which would also swallow the tooltip that
// explains why the control is off), so without it each hover step fires under
// the pointer while the button refuses the click. The retired `ModalButton`
// primary carried this guard privately; folding every dialog footer onto these
// primitives is only faithful if the primitives carry it too.
//
// One declaration per utility, never a reset plus a repaint: a shared
// `disabled:hover:bg-transparent` followed by a per-variant recolour would put
// two rules for one property at equal specificity, and which of them paints
// would be a matter of stylesheet order. `:disabled:hover` outranks a plain
// `:hover` on its own, so the guard needs no help winning.
export const PrimaryButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(function PrimaryButton(
  { className, size = 'sm', align = 'center', busy, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        // The layout without the shared dimming: an unavailable primary is a
        // neutral well, like the composer's send (2026-11-04). At 45% the
        // accent read as a primary still loading, and a form with nothing
        // typed yet showed its loudest colour on the one thing it could not do.
        SHARED_LAYOUT,
        SIZE[size],
        ALIGN[align],
        cursorClass(busy),
        // Tier 1 (owner ruling 2026-10-04): the one faint lit top edge any
        // control carries, and nothing under it. A class, not a `shadow-[...]`
        // utility, so the disabled step drops it in the same place — see
        // `.control-raised` in assets/index.css. It presses by the shared
        // `.interactive` scale like everything else.
        'control-raised',
        'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]',
        'hover:bg-[color:var(--accent-primary-hover)]',
        FOCUS_RING_CLASS,
        'disabled:bg-[color:var(--bg-active)] disabled:text-[color:var(--text-subtle)]',
        'aria-disabled:bg-[color:var(--bg-active)] aria-disabled:text-[color:var(--text-subtle)]',
        'disabled:hover:bg-[color:var(--bg-active)]',
        className ?? '',
      ].join(' ')}
    />
  )
})

// The composer's send (owner ruling 2026-10-04): the primary, round. A small
// accent disc at the `sm` step when it carries only its arrow — the caller
// squares it — and a capsule of the same height when it carries a word
// ("Schedule", "Save"). Everything but the corner is the primary's own, and
// the corner is the size step's radius swapped out rather than a second
// `rounded-*` utility, which stylesheet order would decide. Not a variant of
// PrimaryButton: that one's props are the module SDK's contract, and this is
// the composer's alone.
const ROUND_SIZE: Record<ButtonSize, string> = {
  inline: 'rounded-[var(--sem-radius-pill)] px-1 text-meta',
  xs: 'rounded-[var(--sem-radius-pill)] h-control-xs px-2 text-meta',
  sm: 'rounded-[var(--sem-radius-pill)] h-control-sm px-2 text-body',
  md: 'rounded-[var(--sem-radius-pill)] h-control-md px-3 text-body',
}

export const SendButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(function SendButton(
  { className, size = 'sm', align = 'center', busy, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        // The layout without the shared dimming: with nothing to send it is a
        // neutral disc, not a faded accent one (2026-11-04). A 45% green on the
        // composer read as a primary that was loading, and it was the one
        // coloured thing in an empty box.
        SHARED_LAYOUT,
        ROUND_SIZE[size],
        ALIGN[align],
        cursorClass(busy),
        'control-raised',
        'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]',
        'hover:bg-[color:var(--accent-primary-hover)]',
        FOCUS_RING_CLASS,
        'disabled:bg-[color:var(--bg-active)] disabled:text-[color:var(--text-subtle)]',
        'aria-disabled:bg-[color:var(--bg-active)] aria-disabled:text-[color:var(--text-subtle)]',
        'disabled:hover:bg-[color:var(--bg-active)]',
        className ?? '',
      ].join(' ')}
    />
  )
})

// The destructive counterpart to PrimaryButton: one solid tone, spent on the
// action a person cannot undo. It exists here rather than inside `ui/Modal` —
// where the `ModalButton` danger variant used to spell it — because a dialog is
// not the only place a destructive confirm appears, and a variant declared
// inside one host is how the product grew five primaries.
export const DangerButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(function DangerButton(
  { className, size = 'sm', align = 'center', busy, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        SHARED,
        SIZE[size],
        ALIGN[align],
        cursorClass(busy),
        // No hover step: the system ships no `--tone-error-hover`, and a
        // hand-tuned one here would be the nineteen-theme drift this kit
        // exists to stop. Carrying the same rest state the retired
        // `ModalButton` danger variant had is a faithful move, not a
        // regression — a token is the fix, not a literal.
        // Tier 1 for the same reason primary is: it stands in for the view's
        // primary action, and a destructive confirm without the highlight
        // beside a primary that has one would read as the weaker of the two.
        'control-raised',
        'bg-[color:var(--tone-error)] text-[color:var(--tone-error-ink)]',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})

/**
 * The neutral SELECTION fill a borderless control takes while it is thrown, and
 * the one place a labelled ghost is allowed a ground of its own. Kept apart from
 * `GHOST_TONE` because a pressed control has to hold its fill under the pointer:
 * a tone's `hover:bg-…` outranks a plain `bg-…`, so a toggle painted by the tone
 * map un-painted itself the moment a pointer touched it.
 *
 * Two entries, not seven. `danger` keeps its own soft tint because a thrown
 * destructive toggle that went neutral would stop reading as destructive; every
 * other tone is an ink choice at rest and lands on the neutral fill when thrown,
 * because selection is neutral (`principles.md` → Restraint).
 */
const PRESSED_FILL: Record<ButtonTone, string> = {
  neutral:
    'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
    'hover:bg-[color:var(--bg-selected)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-[color:var(--bg-selected)] disabled:hover:text-[color:var(--text-strong)]',
  danger:
    'bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error)] ' +
    'hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)] ' +
    'disabled:hover:bg-[color:var(--tone-error-soft)] disabled:hover:text-[color:var(--tone-error)]',
}

function pressedFill(tone: GhostTone): string {
  return PRESSED_FILL[tone === 'danger' ? 'danger' : 'neutral']
}

/**
 * ARMED — a control that is not merely thrown but LISTENING: the shortcut
 * recorder while it is capturing a chord, and nothing else so far.
 *
 * It is the one borderless state that takes the accent, and it takes it as
 * `accent.primary-soft` — a tint, not the solid fill the view's primary action
 * owns — because "recording right now" is the live-process case the accent
 * budget explicitly reserves ink and hairlines for. It is a moment, not a
 * standing choice: a control that stayed armed would be spending the accent on
 * a selection, which is what `pressedFill` above is for.
 */
const ARMED_FILL =
  'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)] ' +
  'hover:bg-[color:var(--accent-primary-soft)] hover:text-[color:var(--accent-primary)] ' +
  'disabled:hover:bg-[color:var(--accent-primary-soft)] disabled:hover:text-[color:var(--accent-primary)]'

type GhostButtonProps = SizedButtonProps & {
  tone?: GhostTone
  /** Thrown toggle. Tri-state, exactly as `IconButton`'s — see that prop's
   *  docs. Supplies `aria-pressed` when the caller has not. */
  pressed?: boolean
  /** Capturing input right now (the shortcut recorder). Outranks `pressed`:
   *  a control cannot be both listening and merely chosen. */
  armed?: boolean
}

export const GhostButton = React.forwardRef<HTMLButtonElement, GhostButtonProps>(function GhostButton(
  { className, size = 'sm', align = 'center', tone = 'neutral', pressed, armed, busy, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        SHARED,
        SIZE[size],
        ALIGN[align],
        cursorClass(busy),
        // The ground arrives with the state, never as a default plus a
        // repaint: `bg-transparent` beside a state's own `bg-…` is two
        // declarations of one property at equal specificity.
        armed === true ? ARMED_FILL : pressed === true ? pressedFill(tone) : `bg-transparent ${GHOST_TONE[tone]}`,
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})

/**
 * The one button whose SURFACE is content: a pasted screenshot's thumbnail, a
 * preview frame that opens the thing it shows. It paints no ink and no ground —
 * the `<img>` fills it — so every ghost tone would be a colour on a picture, and
 * every size step a height the aspect frame has already decided.
 *
 * What it keeps is the hairline (`border.subtle`, lifting to `border.strong`),
 * `overflow-hidden` so the image takes the control's radius, the press scale and
 * the focus ring. `block`, not `inline-flex`: its child is one element that
 * fills it, and an inline-flex box adds a baseline gap under the image.
 *
 * Caller owns the frame — `className` carries the aspect box (`h-[34px] w-[46px]`,
 * an `aspect-*` utility, a grid cell) — because a media frame is a content
 * measure, not a control height.
 */
export const MediaButton = React.forwardRef<HTMLButtonElement, ButtonBase>(function MediaButton(
  { className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      {...rest}
      className={[
        'interactive block overflow-hidden rounded-sm border',
        'border-[color:var(--border-subtle)] hover:border-[color:var(--border-strong)]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'disabled:hover:border-[color:var(--border-subtle)]',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})

// Bordered neutral button — the "outline" variant. Retired the hand-rolled
// lookalike (a GhostButton re-styled with a border className, or a raw <button>
// with border/rounded/hover chrome) that had accreted across surfaces; each
// had subtly different radius, hover, and focus. This is the one canonical secondary-action button.
// Tier 2 of the control tiers (owner ruling 2026-10-04): a standalone
// secondary is flat on a `border.strong` hairline over a transparent ground —
// no highlight, no sheen, no drop. Inside a toolbar the same action is a ghost.
// Tone here is INK ONLY — the border and the ground stay neutral in both. A
// destructive secondary action is still a secondary action: `DangerButton`'s
// solid fill is the terminal confirm, and giving this one a red edge as well
// would spend the danger tone twice on the weaker of the two.
const OUTLINE_TONE: Record<ButtonTone, string> = {
  neutral:
    'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:text-[color:var(--text-default)]',
  danger:
    'text-[color:var(--text-default)] hover:text-[color:var(--tone-error)] ' +
    'disabled:hover:text-[color:var(--text-default)]',
}

export const OutlineButton = React.forwardRef<
  HTMLButtonElement,
  SizedButtonProps & {
    tone?: ButtonTone
    /** Thrown toggle — a bordered chip that stays on ("Mark read"). Keeps the
     *  border and takes the neutral selection fill; tri-state, as elsewhere. */
    pressed?: boolean
  }
>(function OutlineButton(
  { className, size = 'sm', align = 'center', tone = 'neutral', pressed, busy, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        SHARED,
        SIZE[size],
        ALIGN[align],
        cursorClass(busy),
        // The hairline is the whole edge, and it holds through every state:
        // only the ground and the ink move, so nothing appears under the
        // pointer and nothing reflows.
        'border border-[color:var(--border-strong)]',
        // The ground and the ink move together with `pressed`, in one
        // declaration each: a thrown chip takes the neutral selection fill and
        // holds it under the pointer, exactly as the icon toggle does. At rest
        // the ground steps transparent → `bg.hover` → `bg.active` under the
        // finger; `enabled:` keeps a disabled button from answering the press.
        pressed === true
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
            'hover:bg-[color:var(--bg-selected)] disabled:hover:bg-[color:var(--bg-selected)]'
          : 'bg-transparent ' +
            OUTLINE_TONE[tone] +
            ' hover:bg-[color:var(--bg-hover)] enabled:active:bg-[color:var(--bg-active)] ' +
            'disabled:hover:bg-transparent',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})

// The outline made SOLID, for a control that floats over scrolling content —
// the "Jump to latest" pill over a conversation or a scrolled-up terminal. The
// outline's transparent ground is right for a button standing in the flow, but
// over a transcript it let the text run straight through the label at rest and
// only went solid under the pointer, so the pill read as broken rather than as
// quiet. It wears the composer's material instead, because it rides the
// composer's top edge: the composer's ground (`--composer-surface`, one rung
// above the conversation's paper — white on a light theme, `bg.hover` on a dark
// one), the same `border.strong` hairline the outline holds through every
// state, and the composer's lit top edge as the raw token, as the composer
// takes it. Hover steps the ground one more rung away from the conversation
// (`--composer-surface-hover`) rather than to `bg.hover`, which on a dark theme
// IS the resting ground. Every other state — size, ink, press scale, cursor,
// focus ring — is the outline's own. Not a prop on OutlineButton: that one's
// props are the module SDK's contract, which is why the round send is its own
// primitive too.
export const FloatingButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(function FloatingButton(
  { className, size = 'sm', align = 'center', busy, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        SHARED,
        SIZE[size],
        ALIGN[align],
        cursorClass(busy),
        'border border-[color:var(--border-strong)] shadow-[var(--shadow-control-raised)]',
        'bg-[color:var(--composer-surface)] hover:bg-[color:var(--composer-surface-hover)] ' +
          'disabled:hover:bg-[color:var(--composer-surface)]',
        OUTLINE_TONE.neutral,
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})

/**
 * The icon square's steps. `sm`/`md`/`lg` are the control ramp — 26 / 30 / 40px
 * — and are what a toolbar, a panel header and the app rail's foot take.
 *
 * The four below them are NOT ramp steps and are not a licence to shrink a
 * toolbar: each is a glyph that sits inside something whose height is already
 * decided — a tab strip, a dense list row, a heading, a chip — where a 26px
 * square would set that container's height instead of riding it.
 *
 * - `xs`     24px, `size.hit-target-min`. The floor, exactly: a canvas header
 *            or browser-toolbar glyph, and the first step to reach for.
 * - `2xs`    22px, `icon.size.lg`. Inside a tab strip.
 * - `3xs`    16px, `icon.size.sm`. Inside a chip or a heading; pair with
 *            `tone="ink"`, which takes no ground — a 16px fill is a speck.
 * - `inline` the glyph plus a 2px inset, so the box comes from the mark. For a
 *            glyph set in a title row where even 16px would be a decision the
 *            row has not made.
 *
 * Everything under 24px pads out to `size.hit-target-min` with a TRANSPARENT
 * overlay (`HIT_PAD`) rather than shrinking its target, per `principles.md` →
 * Space and size. The drawn box stays small; the thing a finger or a mouse has
 * to find does not.
 *
 * They take `radius.chip` rather than `radius.control`: 7px on a 16px square is
 * most of the square.
 */
export type IconButtonSize = 'inline' | '3xs' | '2xs' | 'xs' | 'sm' | 'md' | 'lg'

/**
 * A centred, transparent `::before` sized to `size.hit-target-min`. Not padding:
 * padding would grow the drawn box, and the drawn box is the thing these steps
 * exist to keep small. `pointer-events` are the pseudo-element's by default, so
 * it really is the target.
 *
 * Written out in full, per the literal rule in ./tokens — Tailwind emits a rule
 * only for a candidate it can see as text.
 */
const HIT_PAD =
  'relative before:absolute before:left-1/2 before:top-1/2 before:size-[var(--hit-target-min)] ' +
  "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"

type IconButtonProps = ButtonBase & {
  /** Required: icon-only buttons must expose an accessible name. */
  'aria-label': string
  // `lg` is the app rail's step (size.control.lg): the account badge and the
  // Settings gear at the rail's foot, and nothing inside a panel or a row.
  size?: IconButtonSize
  /** Same contract as `GhostButton`'s: a destructive icon action is a prop. */
  tone?: GhostTone
  /**
   * `circle` turns the square into a hairline badge — a `radius.pill` ring in
   * `border.default` lifting to `border.strong`, with NO ground at any state.
   * It is the shape a count or a "?" takes when it sits beside a heading, where
   * a filled square would read as a control the heading does not have.
   *
   * The radius is picked here rather than in the size map because two
   * `rounded-*` utilities on one element are resolved by stylesheet order.
   */
  shape?: 'square' | 'circle'
  /** Disabled because the control is WORKING. See `SizedButtonProps.busy`. */
  busy?: boolean
  /**
   * The button is a toggle and is currently ON — a locked terminal, a pinned
   * row, a filter left engaged. It is a prop for the same reason `tone` is: a
   * caller spelling the pressed fill in `className` writes a plain `bg-…` and a
   * `text-…` that meet `GHOST_TONE`'s own utilities at equal specificity, so
   * which of them paints is stylesheet order rather than what the caller wrote
   * — and the tone's `hover:bg-…` outranks a plain `bg-…` outright, so the
   * pressed fill vanished the moment a pointer touched it. Also supplies
   * `aria-pressed` when the caller has not, since a pressed control that does
   * not say so is only pressed for people who can see it.
   *
   * Tri-state ON PURPOSE, so leave it undefined on a button that is not a
   * toggle. `undefined` emits no attribute (a Close or Delete glyph is an
   * action, and announcing it as an unpressed toggle is a lie); `false` emits
   * `aria-pressed="false"`, which is what a toggle that is currently OFF owes
   * a screen reader. A `= false` default collapsed those two cases and made
   * every toggle in the app announce as a plain button while off — the footer
   * modal triggers regressed exactly that way on 2026-09-02. It matches the
   * house idiom already used by TaskCard (`onSelect ? selected : undefined`).
   */
  pressed?: boolean
}

const ICON_BOX: Record<IconButtonSize, string> = {
  inline: `p-0.5 text-micro ${HIT_PAD}`,
  '3xs': `size-icon-sm text-micro ${HIT_PAD}`,
  '2xs': `size-icon-lg text-meta ${HIT_PAD}`,
  xs: 'size-[var(--hit-target-min)] text-meta',
  sm: 'size-control-xs text-body',
  md: 'size-control-sm text-heading',
  lg: 'size-control-lg text-heading',
}

const ICON_RADIUS: Record<IconButtonSize, string> = {
  inline: 'rounded-xs',
  '3xs': 'rounded-xs',
  '2xs': 'rounded-xs',
  xs: 'rounded-xs',
  sm: 'rounded-sm',
  md: 'rounded-sm',
  lg: 'rounded-sm',
}

// The hairline the circle shape draws, and the only chrome any icon step has.
// Border colour, never a ground: a badge that filled would be a control.
const CIRCLE_EDGE =
  'border border-[color:var(--border-default)] hover:border-[color:var(--border-strong)] ' +
  'disabled:hover:border-[color:var(--border-default)]'

// Pressed is the neutral selection fill, never the accent: an engaged toggle is
// a standing state, and the accent budget is spent on the view's one primary
// action ("The accent budget"). Hover is declared rather than inherited so the
// fill holds under the pointer — a toggle that un-paints itself on hover reads
// as having turned off.
// The pressed fill is `PRESSED_FILL` above, shared with the labelled ghost so
// an icon toggle and a chip toggle cannot disagree about what "thrown" looks
// like. It used to be a second map here under the name PRESSED_TONE.

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size = 'sm', tone = 'neutral', shape = 'square', pressed, busy, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      // Before the spread: an explicit `aria-pressed` from the caller still wins.
      // Passed through as-is so `false` reaches the DOM as "false" rather than
      // being folded into "no attribute" — see the prop's docs.
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      {...rest}
      className={[
        // Tier 3, ghost: no `control-raised`. A borderless square has no
        // edge to light, and a toolbar of lifted icon buttons reads as a row
        // of tiles rather than as chrome. It presses by the `.interactive`
        // scale, as every control does.
        'interactive inline-flex items-center justify-center',
        shape === 'circle' ? 'rounded-full' : ICON_RADIUS[size],
        shape === 'circle' ? CIRCLE_EDGE : '',
        ICON_BOX[size],
        pressed === true ? pressedFill(tone) : GHOST_TONE[tone],
        cursorClass(busy),
        'disabled:opacity-45 aria-disabled:opacity-45',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    >
      {children}
    </button>
  )
})

/**
 * The window's own caption buttons — minimise, maximise/restore, close — on
 * Windows and Linux, where the frame is ours to draw.
 *
 * It is a species rather than an `IconButton` size because every one of its
 * departures is the operating system's rather than the system's, and each would
 * be a defect anywhere else in the product:
 *
 * - **No height and no radius.** The control stretches to the title strip
 *   (`self-stretch`) and fills its corner square. A rounded caption button
 *   floating inside the strip is not what any desktop draws.
 * - **`w-control-lg` (40px) and no more.** The caption cluster's width is the
 *   platform's; it is the one place a control's width is not a content measure.
 * - **A `focus:` fill, not `focus-visible:`.** The OS-standard keyboard
 *   highlight on a caption button shows on plain focus. The RING is still the
 *   product's one focus indicator and is still `focus-visible`; this is a
 *   second, weaker ground underneath it, not a replacement.
 * - **The ring is INSET.** An outset ring at the window's top-right corner is
 *   clipped by the frame.
 *
 * `close` additionally paints the Windows-native hover red, which is a brand
 * colour of the platform's in exactly the sense a vendor mark is
 * (`principles.md` → Identity colour): tokenising it would replace a colour
 * every other window on the machine agrees on with one of ours.
 */
export type CaptionButtonTone = 'neutral' | 'close'

export const CaptionButton = React.forwardRef<
  HTMLButtonElement,
  ButtonBase & { 'aria-label': string; tone?: CaptionButtonTone }
>(function CaptionButton({ className, tone = 'neutral', type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      {...rest}
      className={[
        'inline-flex w-control-lg items-center justify-center self-stretch',
        'text-[color:var(--text-muted)] transition-colors',
        tone === 'close'
          ? // design-tokens-allow: Windows 11 OS-native close-button hover red; tokenising would replace the system-expected red with the product's tone palette
            'hover:bg-[#c42b1c] hover:text-white focus:bg-[#c42b1c] focus:text-white'
          : 'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
            'focus:bg-[color:var(--bg-hover)] focus:text-[color:var(--text-strong)]',
        FOCUS_RING_INSET_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})

// Canonical close affordance. Use everywhere a panel, aside, drawer, or
// inspector needs a top-right X. Borderless on purpose — bordered/raised
// variants compete with the surface they sit on and add a second radius
// to the view, breaking the ≤ 2 radii rule. A bordered, brand-coloured
// variant was retired here; do not reintroduce it.
export function CloseIconButton({ size = 'sm', ...rest }: Omit<IconButtonProps, 'children'>) {
  return (
    <IconButton {...rest} size={size}>
      <svg className="icon-sm" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </IconButton>
  )
}
