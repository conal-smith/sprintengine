// Shared UI tokens — TypeScript surface. CSS variables live in
// src/renderer/src/assets/index.css. This module exposes the semantic tone
// vocabulary that primitives accept so consumers do not pass raw colors.

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'error'

// Status vocabulary is one wider than the emphasis tones: `merged` is a status a
// dot can carry (a landed PR), never an emphasis a Select option or button asks
// for, so it lives here rather than widening `Tone`. Backed by --tone-merged
// (the GitHub-borrowed merged purple), a single base value with no per-theme
// override so "merged" stays recognisable across themes.
export type StatusTone = Tone | 'merged'

export const TONE_COLOR_VAR: Record<Tone, string> = {
  neutral: 'var(--tone-neutral)',
  accent: 'var(--tone-accent)',
  good: 'var(--tone-good)',
  warn: 'var(--tone-warn)',
  error: 'var(--tone-error)',
}

export const STATUS_TONE_COLOR_VAR: Record<StatusTone, string> = {
  ...TONE_COLOR_VAR,
  merged: 'var(--tone-merged)',
}

export const TONE_SOFT_VAR: Record<Tone, string> = {
  neutral: 'var(--tone-neutral-soft)',
  accent: 'var(--tone-accent-soft)',
  good: 'var(--tone-good-soft)',
  warn: 'var(--tone-warn-soft)',
  error: 'var(--tone-error-soft)',
}

// The product's one focus indicator: a 2px --border-focus outline at a 2px
// offset, declared once as the `focus-ring` utility in assets/index.css.
//
// It is drawn only while the keyboard moved focus last. Every variant below
// still matches on a click, but `--focus-ring` is switched off while the root
// says `data-focus-source="pointer"` (utils/focusSource.ts), so no constant
// here needs a pointer guard of its own.
//
// The utility name is the single source, not these constants: markup that
// writes `focus-visible:focus-ring` into a className string lands on the same
// rule, and moving the treatment means editing the utility, never a consumer.
// What no component may do is declare a treatment of its own — a
// `focus-visible:ring-*` or `focus-visible:outline-*` carrying its own width or
// colour, which is how the accent collision below survived nineteen themes.
// That is enforced in ui/accessibility-contracts.test.ts. Prefer these four
// constants in new code: they carry the trigger's rationale, and the
// non-obvious ones (peer, wrapper) are easy to get wrong from memory.
//
// The offset is load-bearing, not decoration: --border-focus and
// --accent-primary are the same value in 18 of the 19 themes, so a zero-offset
// ring on an accent-filled control (PrimaryButton, a checked Switch) had nothing
// to contrast with and focused rendered identically to unfocused. The
// transparent gap is what separates them, and unlike `ring-offset-color` it
// assumes nothing about the fill behind the control.
//
// No `outline-none` companion: the outline replaces the UA one, and pairing it
// with an equal-specificity `focus:outline-none` would make which wins a matter
// of stylesheet order.
// WRITTEN OUT IN FULL, NEVER ASSEMBLED FROM `'focus-ring'` + a variant prefix.
// Tailwind v4 generates a rule only for a class candidate it can SEE as literal
// text while scanning source, and it does not evaluate template literals: a
// constant built as `` `peer-focus-visible:${FOCUS_RING_UTILITY}` `` produces no
// CSS at all, so every consumer of it silently renders with no focus indicator.
// That is not hypothetical — it is how two of the four below shipped inert
// (T13 review, 2026-07-30). `focus-visible:focus-ring` and its `-inset` form
// survived only by accident: dozens of components also write them literally in
// their own className strings, which is what put them in the stylesheet. The
// two rarer variants — `peer-focus-visible:` and `has-[input:focus]:` — had no
// such literal anywhere, so they were absent from the built CSS entirely and
// their only consumers (TrackerWriteBackSettings' checkbox, InboxSearchInput's
// wrapper) rendered with no focus indicator at all.
//
// So: one literal per constant, and grep for the literal — not for the constant
// name — when checking whether a variant reaches the CSS.

/** Focus on the element itself. The default — use this unless one of the below applies. */
export const FOCUS_RING_CLASS = 'focus-visible:focus-ring'

/**
 * Inward, for an element that clips its own overflow or sits at the edge of a
 * scrolling region: a focusable scroll container, a joined split-button half.
 * An outward gap is cut off there.
 */
export const FOCUS_RING_INSET_CLASS = 'focus-visible:focus-ring-inset'

/**
 * For a ROW that is a `<label>` around a real checkbox — the check row's
 * `--described` variant (design-system/components/check-row). The input is the
 * tab stop, but the LABEL is the hit target, so ringing the 16px box inside a
 * 44px row would mark the smallest part of what the person is operating.
 * Inward, because the row is full-bleed against a list surface that clips an
 * outset ring.
 *
 * `:focus-visible` and not `:focus`, unlike the text-field wrappers below:
 * Chromium treats a text input as focus-visible on click, and a checkbox row
 * that rang on every tick would be drawing a keyboard indicator for something
 * that was not a keyboard stop.
 */
export const FOCUS_RING_WITHIN_CHECKBOX_CLASS = 'has-[input:focus-visible]:focus-ring-inset'

/**
 * For a decorative box drawn next to the real control — a styled checkbox whose
 * `<input class="peer">` is the tab stop and carries the semantics.
 */
export const FOCUS_RING_PEER_CLASS = 'peer-focus-visible:focus-ring'

/**
 * For a wrapper that owns the visible border box while an `<input>` inside it is
 * the tab stop (a search field with a glyph and a clear button). Keyed to the
 * input's own focus, never `focus-within`: the clear button is a descendant, and
 * a `focus-within` outline stays painted while that button draws its own,
 * putting two indicators on one stop. `:focus` not `:focus-visible` because
 * Chromium treats text inputs as focus-visible on click anyway.
 */
export const FOCUS_RING_WITHIN_INPUT_CLASS = 'has-[input:focus]:focus-ring'

/**
 * The same wrapper case for a MULTILINE field — a chat composer whose rounded
 * box also holds a footer control row. `has-[input:focus]` cannot cover it:
 * `input` is an element selector, and a `<textarea>` is not one, so the wrapper
 * would simply never light up. Split rather than widened to `:is(input,textarea)`
 * because each stays one literal Tailwind can see (see the note above), and the
 * two cases are asserted separately.
 *
 * Still keyed to the field's own focus, never `focus-within`: the send button and
 * the model chip in that footer are descendants, and a `focus-within` outline
 * stays painted while they draw their own.
 */
export const FOCUS_RING_WITHIN_TEXTAREA_CLASS = 'has-[textarea:focus]:focus-ring'

/**
 * The same wrapper case for the chat composer, whose field is an editor
 * (agentChat/ComposerField) rather than a `<textarea>`: its editable element is
 * `.cm-content`. Keyed to that element's focus for the reason above — the
 * footer's controls are descendants of the same box.
 */
export const FOCUS_RING_WITHIN_EDITOR_CLASS = 'has-[.cm-content:focus]:focus-ring'

/**
 * The terminal variant, and the only member of this family that is a hand-written
 * rule rather than the shared utility: `.terminal-focus-ring` in
 * assets/index.css. It exists here — beside the four above, not privately in the
 * two panels that use it — because a focus treatment declared inside a component
 * is how a second idiom starts.
 *
 * Two things about a terminal put it outside the four:
 *   - The tab stop is not the element that should light up. xterm owns a hidden
 *     `<textarea>` inside the canvas, so focus lands on a descendant and
 *     `:focus-visible` on the container never matches. The rule keys off
 *     `:focus-within`, which covers both that textarea and the container's own
 *     `tabIndex={0}`. `has-[input:focus]` cannot stand in: it is a textarea.
 *   - An outline at the panel edge is clipped. The canvas fills a FlexLayout tab
 *     whose rounded corners and top border cut it off, so the indicator is drawn
 *     as an inset `::after` overlay sitting inside the panel padding, clear of
 *     the terminal's first row.
 *
 * What it is NOT is a second treatment: the rule takes its border from
 * `var(--focus-ring)`, the same 2px in the theme's own `--border-focus` that the
 * utility applies, so moving the indicator still means editing one value.
 */
export const FOCUS_RING_TERMINAL_CLASS = 'terminal-focus-ring'

/**
 * The list CURSOR mark — a leading rule on the row a keyboard cursor rests on.
 *
 * A cursor is not focus. `foundations/principles.md` rules the offset ring the
 * product's only FOCUS indicator, so a cursor may not draw a second ring; but a
 * list whose cursor is a `bg-*` fill has no cursor at all on any row that is
 * already filled — a selected row, or any row under the pointer — which is the
 * state a cursor spends most of its life in. So the cursor gets a channel of its
 * own that composes with every fill instead of competing with one: an absolutely
 * positioned 2px rule in the row's leading gutter, `--text-strong` so it reads as
 * neutral structural ink rather than the accent (`--accent-primary` and
 * `--border-focus` resolve to the same value in 18 of the 19 themes, so an accent
 * cursor would read as focus).
 *
 * The row it sits in must be `relative`. Mark the span `aria-hidden` — the cursor
 * is already announced through `aria-activedescendant` or DOM focus.
 *
 * Shared so every list that carries a cursor — the backlog listbox
 * is the one that draws it today — cannot drift into two idioms.
 */
export const LIST_CURSOR_MARK_CLASS =
  'pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-[color:var(--text-strong)]'

/**
 * The floating chrome — the four values that make something read as an overlay
 * rather than as part of the page: `radius.overlay` (7px, on the 3/7/9 ramp),
 * the strong border, the raised ground, and the popover elevation, which is
 * defined per theme so a light-mode surface does not cast a shadow tuned for a
 * dark one.
 *
 * `Popover` draws it for every anchored surface; `ContextMenu` draws it for the
 * pointer-positioned one. Those were two hand-written copies that drifted apart
 * by a pixel of radius, a border token and a ground token — the same
 * material spelled twice is the mechanism by which a system grows two of
 * everything.
 *
 * Deliberately NO padding and no stacking tier: what sits on the surface owns
 * its own inset (a menu wants full-bleed rows, a dialog wants a gutter), and the
 * tier is the caller's — `--z-popover` for an anchored surface, `--z-menu` for a
 * pointer-summoned one that must clear it.
 *
 * `app-no-drag` because an overlay is portaled to `<body>` and often lands over
 * a window-drag region — the app rail, a pane's tab strip, the title bar.
 * Electron decides what drags the window from the regions alone, ignoring
 * stacking, so without it a press on the part of a menu over that strip moved
 * the window instead of choosing the item.
 *
 * Written out in full, per the literal rule above.
 */
export const OVERLAY_SURFACE_CLASS =
  'app-no-drag rounded-[7px] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] shadow-[var(--shadow-popover)]'

/**
 * The same chrome without its ground, for the one case where a shell paints
 * the ground itself: `Popover`'s opt-in `material="glass"`, where the ground is
 * the `surface-glass` utility (design-system/components/popover, "Material").
 * `background` and `background-color` on one element are resolved by
 * stylesheet order, so the raised ground cannot simply be layered under the
 * glass one — the glass surface takes this and adds its own ground, exactly as
 * `PointerPopover` already does.
 *
 * Written out in full, per the literal rule above.
 */
export const OVERLAY_CHROME_CLASS =
  'app-no-drag rounded-[7px] border border-[color:var(--border-strong)] shadow-[var(--shadow-popover)]'

/**
 * The chat composer's material (remote-sessions-ux /
 * composer-surface-premium), shared by the launch composer and the session
 * composer so the most-looked-at surface in the product is ONE surface:
 *
 * - `radius.composer` (22px) — the one named exception to the radius ceiling
 *   (owner ruling 2026-10-04). It was the shell radius, and before that the two
 *   composers had shipped `rounded-md` on `bg-app` and `rounded-lg` on
 *   `bg-surface`, two materials for one thing.
 * - `--composer-fill` — one step above the conversation's raised paper,
 *   settling a little toward it at the bottom: white on a light theme, the
 *   hover rung on a dark one (index.css, beside --agent-surface). It was a
 *   raised-to-surface wash, which stopped reading as a step once the
 *   conversation itself moved onto the raised paper.
 * - `shadow.control-raised` — its inset top highlight IS the dark-mode "lit
 *   edge"; deliberately the raw token, not `.control-raised`, whose disabled
 *   step belongs to buttons, not to a field. Since the control tiers (owner
 *   ruling 2026-10-04) the token is that faint highlight alone, with no drop
 *   under it.
 *
 * Border COLOR is the host's: both composers swap it to the accent while a
 * file drag is over them, and a color baked in here would fight that swap on
 * stylesheet order. No blur anywhere on this — terminals render beneath.
 */
export const COMPOSER_SURFACE_CLASS =
  'rounded-[var(--sem-radius-composer)] border bg-[image:var(--composer-fill)] shadow-[var(--shadow-control-raised)]'

/**
 * The composer's material without its corner: the wash, the hairline and the
 * lit edge of `COMPOSER_SURFACE_CLASS`, and no radius. For a box that is
 * written in like the composer but is not it — the Git pane's commit message
 * (owner ruling 2026-10-01) — which keeps the shell radius: `radius.composer`
 * is the composer's alone, and a square button in a 22px corner pokes out of
 * the curve.
 */
export const COMPOSER_MATERIAL_CLASS = 'border bg-[image:var(--composer-fill)] shadow-[var(--shadow-control-raised)]'

/* ------------------------------------------------------------------ *
 * Overlay geometry — one scale for every floating surface
 * ------------------------------------------------------------------ */

/**
 * The dialog width scale. Five steps, each a content measure with a job, and
 * no sixth: before this the product carried 420 / 440 / 460 / 480 / 500 / 520 /
 * 540 / 560 / 600 / 720 / 760 / 1000 / 1040 / 1100, which is not a scale but a
 * record of whatever each dialog's author typed. Opening two of them in a row
 * read as visiting two different apps.
 *
 * Widths stay a TypeScript constant rather than a `--sem-*` token on the design
 * system's own ruling (`design-system/components/modal/component.md`): a width
 * is a content measure — wide enough for the form it holds, narrow enough that
 * the eye crosses it — not a value other surfaces compose against. What the
 * system tokenises is the shape and the elevation, which is what
 * OVERLAY_SHELL_CLASS below spends.
 */
const OVERLAY_WIDTH_PX = {
  /** A question with two buttons. It should read in one line. */
  confirm: 460,
  /** The default: a short form, a list of options, a prompt. */
  standard: 560,
  /** The command palette — a query over a long result list, nothing else. */
  palette: 600,
  /** A form that needs two columns, or a list beside an editor. */
  wide: 720,
  /** A workbench: panes, a rail, a flow the person works inside. */
  workbench: 1040,
} as const

export type OverlayWidth = keyof typeof OVERLAY_WIDTH_PX

/**
 * Width plus the viewport cap, as one inline style. The cap is not optional:
 * a 1040px workbench on a 900px-wide window has to give way, and every shell
 * gives way the same amount.
 */
export function overlayWidthStyle(width: OverlayWidth): { width: number; maxWidth: string } {
  return { width: OVERLAY_WIDTH_PX[width], maxWidth: '95vw' }
}

/**
 * The chrome of a dialog-scale shell: `radius.shell` (9px), the subtle border,
 * the plain surface ground, and the modal elevation.
 *
 * Two shape steps exist and they split by surface class, exactly as the
 * elevation ramp does. OVERLAY_SURFACE_CLASS above spends `radius.overlay`
 * (7px) on the popover family — anchored menus, flyouts, floating cards. This
 * spends `radius.shell` on the surfaces that stop the page. That split is the
 * design system's, per `sem.radius.*` metadata and
 * `design-system/components/modal/component.css`; what the overlay-geometry sweep removed was the
 * `rounded-[8px]` / `rounded-lg` / `rounded-xl` / `rounded-[14px]` values
 * sitting between the two steps and landing on neither.
 *
 * Ground is `bg-surface`, not `bg-surface-raised`: the scrim and the shadow
 * already separate the shell from the page, and a tone step on top would be a
 * third signal for the same fact.
 *
 * Written out in full, per the literal rule above.
 */
export const OVERLAY_SHELL_CLASS =
  'rounded-[var(--radius-lg)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-modal)]'

/**
 * The shell's chrome without its ground — the dialog-scale twin of
 * OVERLAY_CHROME_CLASS, for the one shell that paints its own: the command
 * palette, which is glass (owner ruling 2026-09-10; the `surface-glass`
 * utility, see design-system/components/command-palette, "Material"). Same
 * reason the popover family has the split: `background` and `background-color`
 * on one element resolve by stylesheet order, so the plain ground cannot be
 * layered under the glass one. Radius, border and elevation are unchanged —
 * a glass shell is not a different kind of shell.
 *
 * Written out in full, per the literal rule above.
 */
export const OVERLAY_SHELL_CHROME_CLASS =
  'rounded-[var(--radius-lg)] border border-[color:var(--border-subtle)] shadow-[var(--shadow-modal)]'
