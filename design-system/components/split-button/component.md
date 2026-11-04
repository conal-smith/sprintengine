# Split button

One control with a default action and a menu of alternatives, for a repeated
action whose target changes rarely: the primary half runs the last-used target,
the menu half lists the others and re-points the primary. Extracted from the
source product's open-in-editor control on the workspace bar.

Use it only when the alternatives are genuinely the *same action against a
different target*. Two unrelated actions welded together are two buttons.

## Anatomy

- `ds-split-button` — the group. It owns the border, the radius, the height,
  and the overflow clip; the halves own nothing structural. One object, not two
  buttons that touch. Tier 2 of
  [button → Control tiers](../button/component.md) (owner ruling 2026-10-04):
  a `border.strong` hairline on a transparent ground, exactly the outline
  button's edge, and no depth.
- `ds-split-button__primary` — the default-action half: optional target glyph,
  then the verb. Padding `sem.space.md`, label in `font.size.meta` at
  `font.weight.medium`.
- `ds-split-button__chevron` — the menu half, carrying the single internal
  hairline (`color.border.subtle`) on its left edge and a chevron at
  `icon.size.xs`. Narrower than the label half (`sem.space.2xs`).
- `ds-split-button__glyph` — the target mark leading the label: a two-letter
  mono mark or a small glyph, boxed at `icon.size.sm` on `color.bg.active` so
  every target reads at one weight whichever form it takes.
- The menu itself is a standard popover surface, **not** part of this
  component. It carries one checkable row per target, the current default
  checked, and any keyboard hint right-aligned.

## Variants

- Default (no modifier) — the neutral outlined group at
  `size.control.sm`: flat, on the `border.strong` hairline. This is the only
  tone the system offers. Until 2026-10-04 the shipped group stood on a
  `bg.surface-raised` ground with the retired `shadow.control-edge`.
- `ds-split-button--md` — the `size.control.md` step, with the label on
  `font.size.body`. For overlay footers and forms, where the surrounding
  controls sit on that row.
- `ds-split-button--quiet` — the same control with its chrome taken away: no
  outer border, and `size.hit-target-min` (24px) instead of
  the `size.control.sm` step. **For a split action on a row's meta line** — a
  card's head line, a list row's trailing slot — where the bordered 30px group
  out-weighs the line it sits on and reads as a form control dropped into a
  sentence. Its single internal hairline shows while the pair is in use —
  hovered, focused or open — and rests transparent (2026-11-04): in use, it is
  what says *one object, two halves* once the border is gone; at rest, a
  divider nobody is about to use only boxes the line. Everything that resolves which half is live is inherited
  unchanged — per-half hover fill, the held `[aria-expanded="true"]` chevron,
  the inset focus ring — because quiet is a chrome level, not a lower
  accessibility bar.
- **No accent-filled variant, deliberately.** A view gets one primary button
  (see `foundations/principles.md`); a control whose whole point is that its
  action is ambiguous until you read its glyph is not it.

## States

- Hover: the hovered half alone takes `bg.hover` and lifts to `text.primary`.
  The other half does not move — the halves are separately clickable and must
  say so.
- Open: while the menu is on screen the chevron half stays at `bg.hover` via
  `[aria-expanded="true"]`, tying the surface to the half that opened it.
- Focus-visible: the shared `focus.ring` outline, at a **negative**
  `focus.ring-offset` because the group clips its overflow — an outward gap
  would be cut off on the joined edge. Each half draws independently.
- Disabled: 45% opacity and `not-allowed` on both halves. Disable the whole
  group or neither: a live primary beside a dead menu reads as a bug.
- Pressed: the pressed half alone steps to `bg.active`. **No press-scale** —
  the one exception to the family's shared press, because the group would scale
  as one object while only one half was pressed, and a half that shrank inside
  the group's clip would pull away from its own border.

## Usage

- The primary half must announce what it will do without a caption — that is
  the glyph's job. If the target cannot be shown in the resting state, this is
  the wrong control. The half's content may be the MARK itself rather than a
  verb — a pull request's state glyph and its number — where the mark is what
  you would quote to a colleague and a verb over it would say less.
- Choosing from the menu runs that target immediately **and** becomes the new
  primary. A menu that only re-points the primary makes every switch two
  clicks.
- **Unless the primary is a rule rather than a memory.** Where the resting half
  is derived — "the most recent pull request still open", not "the target you
  last used" — choosing a row runs it and the primary does NOT move: it is the
  rule's answer, and a click cannot change what the rule says. Such a menu
  carries no check either, because no row is "the one you chose". Read the
  clause above as the default and this as its one exception; a menu that is
  neither is a menu that has not decided what its primary means.
- **Group the rows when they have states rather than being peers.** The
  grouping is the menu's own (`.ds-menu-group-label`, one heading per run of
  rows, empty groups omitted rather than shown as a heading over nothing), and
  a count belongs in the heading — "Open · 4" — not repeated down the rows.
- Offer only targets that resolve. A row for something that is not installed is
  a fake affordance — omit it, never disable it.
- **Two kinds of menu, and only one of them has a floor** (ruled 2026-09-10).
  The clause below was written for a menu of **targets** — the same action
  against a different thing — and it still binds every one of those. It does
  not bind a menu of **alternatives**: a different *route to the same outcome*,
  which is what a section header's overflow is. The Remote tab's "Pair a
  device" is the case that forced the distinction — its one menu row, "Paste a
  pairing link", is not another device to pair with, it is the other way to
  reach the same pairing. Promoted to a second visible button it would put two
  competing verbs on the section header for one job; dropped, the route
  disappears.

  A menu of alternatives keeps its caret at one row. The test is whether
  choosing a row could ever **re-point the primary**: for a target it can and
  does, so a list of one is a list with nothing to choose; for an alternative
  it cannot, so the count was never what made the menu worth opening. The
  shipped primitive takes this as `menuKind` — `targets` (the default, and the
  behaviour below) or `alternatives` — so the choice is made once at the call
  site and is readable there, rather than inferred from a length.

  Everything else is unchanged either way: the same group chrome, the same
  hairline, the same hover, the same `aria-haspopup="menu"` on a half that
  really does open a menu. And the rows of an `alternatives` menu carry no
  check, for the same reason a derived primary's rows do not — no row is "the
  one you chose".
- Keep the menu at two or more rows **of targets**. One alternative target is a plain button — and
  the component holds that rule itself: handed fewer than two targets it draws
  **the primary half alone**, in the group's own chrome, with no chevron and no
  menu. Not a different control and not a lookalike: the same half, the same
  height, the same hover fill and the same focus ring, because a surface whose
  target list grows from one to two must not change size or hit area under the
  reader. (The conversation peek's pull request mark is exactly that surface,
  and its lone arm was a text link until 2026-09-09: a ~15px target beside the
  split shape's 24px one.)
- Persist the primary where the choice belongs (per app, per project) and fall
  back to the first available target when the remembered one is gone.

## Accessibility

- A single-row `alternatives` menu is a real menu: the half keeps
  `aria-haspopup="menu"`, the surface keeps `role="menu"`, and the one row is a
  `menuitem`. Arrow keys and Escape behave exactly as they do at ten rows —
  a one-row menu is not a special keyboard case, and treating it as one is how
  a control ends up with a chevron that only responds to the mouse.
- Two real `<button>`s, so both halves are in the tab order and operable with
  Enter and Space. Never collapse them into one element with a click-position
  test. With a single target there is one real `<button>` and no menu half at
  all — nothing announces a menu that does not exist.
- The primary half carries an `aria-label` naming its resolved target ("Open in
  {editor}") when the visible label is only the verb.
- The menu half carries `aria-haspopup="menu"` and a live `aria-expanded`, and
  it owns the popover's `aria-controls`.
- The surface is `role="menu"`; each row is `role="menuitemcheckbox"` with
  `aria-checked` on the current default — the check is state, not decoration,
  so it must not be conveyed by the glyph alone.
- Arrow keys rove within the open menu, Escape closes it and returns focus to
  the chevron half.
- Contrast: label and glyph clear AA in both modes; the internal hairline is
  decorative and is never the only thing separating the halves — hover and
  focus both resolve which half is live.
