# Group header

The collapsible band above a run of rows, with a tri-state checkbox that
governs the whole group.

The Git panel's changelists are what it was drawn for — "Changes · 26 files",
a chevron that folds them away, a box that stages all of them at once and
shows a dash when only some are staged, and a chip on the one list new changes
land in — but the shape is general: any list that groups its rows and lets a
person collapse a group or act on all of it at once.

**Why `section` could not be it.** [section](../section/component.md) is
structure with no states: no hover, no collapse, no focus, a ceiling of one
trailing control, and no checkbox anywhere. Nothing else in the system
collapses. Use `section` when a heading groups content a person only reads;
use this when the group is something they operate.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Band | `.ds-group-header` | yes |
| Chevron | `.ds-group-header-twisty` | yes — a real `<button>` with `aria-expanded` and `aria-controls` |
| Check | `.ds-group-header-check` | no — the kit `checkbox`, whole, tri-state |
| Title | `.ds-group-header-title` | yes — `font.size.meta` at `font.weight.emphasis`, `text.primary` |
| Count | `.ds-group-header-count` | no — `tabular-nums`, **regular** weight, `text.muted` |
| Chip | `.ds-group-header-chip` | no — one [micro-chip](../micro-chip/component.md) |
| Spacer | `.ds-group-header-spacer` | yes when there is a trailing slot |
| Actions | `.ds-group-header-actions` | no — **one** control, revealed on hover and focus |
| Action | `.ds-group-header-action` | — |

## The height is 26px, and that is a decision

`size.control.xs`, not the 24px hit-target floor the rows beneath it use.

This band carries the only genuinely **focusable** checkbox in the list, and
the shared focus ring is 2px of outline at a 2px offset. On a 24px band with a
16px box centred there are exactly 4px above and below it — so the ring lands
on the band's own edge and is clipped by the row above. The 24px floor belongs
to the row that repeats four hundred times, where every pixel is paid for four
hundred times; a header appears once per group and can afford the two pixels
its focus indicator needs.

The two pixels come out of the band's padding, never out of the type: the
title stays at `font.size.meta` with the rows.

## The count is not bold

The title is the group's name and is the only thing on the band at emphasis
weight. The count is a *fact about* it, so it stays at regular weight in muted
ink. A bolded count reads as a second name, and a band with two names has no
title.

## The chevron is the whole disclosure control

`aria-expanded` and `aria-controls` sit on the button that performs the
collapse, so a pointer user and a screen-reader user operate the same one
element. The title is **not** a second trigger: two controls for one action is
two things to explain and two places for the state to disagree.

The chevron pads out to the 24px hit-target floor with a transparent target
rather than growing the mark (the glyph rule) — which is what lets a 13px
chevron sit in a 26px band and still be comfortably clickable.

## The box is tri-state by construction

`indeterminate` is the group's **normal resting state** — some of its files
staged, some not — not an edge case. A header box that could only be on or off
would have to lie about every partly-staged group, and "lies about the common
case" is not a state model.

Unlike [check-row](../check-row/component.md)'s box, this one is the kit
checkbox **whole**, input and all: there is one per group rather than one per
file, so it costs a handful of tab stops and buys the keyboard a real control.

## The band is outside the listbox — ruled 2026-09-09

The rows a band governs are almost always [check rows](../check-row/component.md)
in a `role="listbox"`. The band is **not** in it.

A listbox may own `option`s and nothing else, and this band is three controls: a
chevron `<button>`, the kit checkbox whole, and a trailing overflow control. Put
between the runs of rows inside one listbox, they are invalid children of it —
and the reason they are *allowed* to be real controls in the first place (one
per group, not one per row) is the reason they must not pretend to be options.

So a grouped list is one keyboard owner (`role="group"`, `tabindex="0"`, the
`aria-activedescendant` walk) holding **one listbox per group**, with the bands
standing between them. The full shape, and why the walk is not split into a tab
stop per group, is drawn in
[check-row → Where the group bands sit](../check-row/component.md).

`aria-controls` still points at the region the chevron folds — which is the
element *around* the listbox, so anything in the fold that is not a row (a cap
notice, an empty line) has somewhere legal to live.

## Variants

There is one group header. What changes is how much of it is there: the check,
the count, the chip and the trailing slot are each optional, and the band
closes up around whichever are absent.

## States

| State | Treatment |
|---|---|
| Rest | Transparent ground; trailing slot invisible but holding its width |
| Hover | `bg.hover`. The trailing control appears |
| Focus-visible (chevron / check / action) | `focus.ring` on the control itself |
| Focus-within (band) | The trailing control appears, exactly as on hover |
| Expanded | `aria-expanded="true"`; the chevron rotates 90° |
| Collapsed | `aria-expanded="false"`; the chevron points right — **and the count stays**, which is the whole reason a collapsed group is still useful |
| Checked / mixed / unchecked | The checkbox's own three states |

**The band never takes the selection fill or the selection edge.** It is a header,
not a row a person picks. A group header that looked selected would be a third
answer to "where am I" in a list that already has two.

## Usage

- **One trailing control, and make it an overflow menu.** A band that revealed
  three glyphs would be a second toolbar under the first one. The slot reserves
  its width at rest so revealing never reflows the band.
- **The revealed control appears on focus as well as hover.** A control that
  only exists under a pointer is unreachable by keyboard and by touch.
- **A collapsed group keeps its count.** Folding a group away must not also
  hide how much was folded — that is the difference between collapsing and
  hiding.
- **One chip, and only for a fact that was true before the person arrived**
  ("active"). Not a status, not a tone — `micro-chip`'s own argument.
- The title truncates; the count, the chip and the trailing slot do not. What
  is cut is the part with the most redundancy in it.

## Accessibility

- The chevron is a `<button>` carrying `aria-expanded` and `aria-controls`
  pointing at the `id` of the region it folds. The region is not removed from
  the DOM by a collapse if `aria-controls` is to resolve; hide it instead.
- The chevron needs an accessible name that says what collapses
  ("Collapse Changes"), because it is read out of the band's context.
- The checkbox is the kit's: a real `<input type="checkbox">` with the
  `indeterminate` DOM property set for the mixed state, and an `aria-label`
  naming what it governs ("Stage every file in Changes") — the visible title is
  the group's name, not the box's.
- The trailing control carries an `aria-label` naming both the verb and the
  group, and is in the tab order. Being the overflow MENU this slot is shaped
  for, it also carries `aria-haspopup="menu"` and `aria-expanded` — the first
  so a person is told they are about to be moved into a menu rather than have
  something done to the group, the second because a popup announced with no
  open state is a control that never says what it did.
- The band itself takes no role and no tab stop: three controls sit in it, and
  a fourth wrapping them would be a composite widget nobody asked for. It is
  also outside the listbox those controls govern — see the ruling above.
- Reduced motion removes the chevron's rotation *transition* and the reveal
  fade, never the rotation or the reveal.

## Shipped implementation

`src/renderer/src/components/ui/GroupHeader.tsx`, exporting `GroupHeader`.
