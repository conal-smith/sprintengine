# List row

The pick-an-item worklist row: rails, source lists, inboxes, categories,
search results. The most repeated surface in the product, and the default
answer for any list of things a person chooses between.

Use `task-card` instead when the item is a card on a board. Use this when the
item is a row in a list.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-list-row` | yes — renders as `<button>` when interactive |
| Leading mark | `.ds-list-row-leading` | no — a status glyph, type icon, or monogram |
| Text block | `.ds-list-row-text` | yes |
| Title | `.ds-list-row-title` | yes — the row's one priority, claims the width |
| Supporting line | `.ds-list-row-supporting` | no — one line, truncated |
| Identifier | `.ds-list-row-id` | no — mono, tabular, inside the supporting line |
| Trailing meta | `.ds-list-row-trailing` | no — display only, never interactive |
| Action host | `.ds-list-row-host` | only when the row has revealed actions |
| Action count | `data-actions` on the host | yes when there are actions — `"1"` or `"2"`, the value the trailing padding is reserved from |
| Actions | `.ds-list-row-actions` | no — at most two |
| Action | `.ds-list-row-action` | — |
| Flash | `.ds-list-row-flash` | only as a row enters an attention state — a one-shot overlay, `aria-hidden` |

At most **four visual elements at rest**. A fifth means the row is carrying
work that belongs in the detail pane.

## Variants

- **Default** — no modifier. The resting, unselected row.
- **`--selected`** — the selected row of the pane that currently has focus.
  Neutral `bg.selected` fill, a 2px inset `accent.primary` edge, title lifts
  to `text.primary`.
- **`--resting`** — the selected row of a pane that does not have focus.
  Quieter `bg.selected-resting` fill, **no edge**, title stays at
  `text.default`.

A surface has **exactly one `--selected` row on screen**. In a rail → list →
detail layout the other two panes use `--resting`, so the person can always see
which list their keyboard is driving. The edge is what makes that legible: one
edge on screen, on the pane with focus.

The edge is a **neutral hairline** in `border.subtle`, 2px inset, and never an
accent (2026-11-04). It was the accent from 2026-09-05, when a neutral fill on
its own lost to rows wearing a status tint; as a green outline it then became
the loudest mark on every list, round whatever the person was reading. The
hairline keeps the selected row's shape against a tinted neighbour without
competing with the primary button, which is the accent's job. Selection never
carries an accent fill, a left bar or a glow. See `patterns/selection`.

### Attention

Two states a row can say on its own, each taking the **whole row** — a tinted
fill and the title in the tone's ink:

- **`--needs-input`** — an agent on this row is waiting for the person.
  `status.warn-soft` fill, `status.warn` ink. The loudest thing a row can say.
- **`--finished`** — a turn on this row finished while the person was looking
  elsewhere, and they have not opened it since. `status.good-faint` fill,
  `status.good` ink. One notch under needs-input by construction: it asks for
  a look, not an answer.

**Status is the fill; selection is the edge.** Neither attention state draws a
ring (owner ruling 2026-09-05, removing the one they used to carry). A green
ring around a finished row is the same mark as the selection edge on the row
being driven, and it was the louder of the two — so "I finished while you were
out" was read as "this is the one you are in". Two questions, two channels: a
row can wear a status wash and the selection edge at once, and neither is
mistaken for the other.

When a row is both attention states, needs-input wins. Both hold until the
person opens the row and clear the moment it becomes the selected one.

Both are colour **plus words**: the trailing slot or a visually-hidden clause
says "needs input" / "finished" in text. Never a status mark or a chip beside
an otherwise quiet row — that was ruled out twice (2026-09-04): the one state that
wants the person to look must not be the quietest thing on the row.

A row **entering** either state plays `.ds-list-row-flash` once: the "just
changed" mark from [liveness](../liveness/component.md), in the tone the row
is already wearing. It never loops — what keeps a waiting row loud is ink,
not motion.

## States

| State | Treatment |
|---|---|
| Rest | Transparent background, `text.muted` |
| Hover | `bg.hover`, ink lifts to `text.default`. Background only — no shadow, scale, glow, or border that shifts geometry |
| Focus-visible | `focus.ring`, `outline: none`. Never on `:focus` — a mouse click must not draw a ring |
| Selected (focused pane) | `bg.selected` fill + 2px inset `accent.primary` edge + `text.primary` |
| Selected (resting pane) | `bg.selected-resting` fill, no edge, + `text.default` |
| Cursored | `.ds-list-row-cursor` — a 2px `text.primary` mark in the leading gutter. Only for a list that is one tab stop and walks with `aria-activedescendant` |
| Needs input | `--needs-input`: `status.warn-soft` fill, `status.warn` ink, no ring. Keeps the selection edge underneath when also selected. One-shot flash on entry |
| Finished, unseen | `--finished`: `status.good-faint` fill, `status.good` ink, no ring. Keeps the selection edge underneath when also selected. One-shot flash on entry. Clears on open |
| Disabled | `opacity: 0.5`, `cursor: not-allowed`. Stays in layout and stays readable |

**The cursor is a third channel, not a third selection.** A list that walks
with `aria-activedescendant` keeps DOM focus on one element, so it has a row
the keyboard is *on* that is neither the row a person picked nor the element
they are typing in. It cannot borrow either treatment: it must stay visible on
a row that is already selected and stay distinct from one that is merely
hovered. A gutter mark composes over both fills, which neither fill can do over
the other.

It takes `text.primary`, not the accent: `border.focus` and `accent.primary`
are the same value in all but one theme, so an accent bar in the gutter reads
as a focus ring that has slipped. And a list that *does* move real DOM focus
with its cursor renders no mark at all — there the focus ring is already the
answer, and one idiom beats two.

Added 2026-09-02, after a conformance sweep replaced two lists' private cursor
outlines with `bg.hover` and made the cursor invisible on every row a person
had already picked.

## Usage

**Actions are withheld until reached for.** Per-row actions — remove, reveal in
folder, roll back, close — live in `.ds-list-row-actions` and are invisible at
rest. They appear on hover and on keyboard focus. Ceiling: two. A third action
belongs in an overflow menu or the detail pane.

The row itself is the `<button>`, so an action cannot be nested inside it —
that is invalid HTML and breaks Safari and JAWS. Wrap the row and its actions
in `.ds-list-row-host` instead, which positions the actions over the row's
trailing padding. Declare `data-actions="1"` or `"2"` on that host: the actions
are positioned absolutely and reserve no width themselves, so the count is what
the row reserves its trailing padding from. Without it the text runs under the
icons. With it the space is held at rest, so revealing never reflows.

Do not put anything interactive in `.ds-list-row-trailing`. It is for a count,
a timestamp, or a status word.

Titles truncate to one line. If the full value matters, attach the system's
`tooltip` component, and only when the text actually overflows — never a native
`title` attribute on a control.

## Accessibility

- Interactive rows render as `<button type="button">`. A row that only displays
  information renders as a `<div>` and takes no focus.
- The selected row carries `aria-current="true"`. A single-select list may
  instead use `role="listbox"` with `role="option"` and `aria-selected`; pick
  one model and hold to it for the whole list.
- Every action button has an `aria-label` naming both the verb and the item
  ("Remove Engineering"), because the label is read out of the row's context.
- Leading glyphs are `aria-hidden="true"` when the title already carries the
  meaning.
- **Revealed actions must be keyboard-reachable.** They are in the tab order
  and become visible on `:focus-within` — an action that only exists on hover
  is unreachable for keyboard and touch users.
- Status shown by a leading glyph reads by shape, not colour alone, and carries
  an accessible name when no adjacent text states it.
- Disabled rows use the `disabled` attribute (or `aria-disabled="true"` when
  they must stay focusable to explain why).
- Reduced motion removes the reveal fade but never the reveal itself, and
  drops the attention flash — the fill, ring and ink already carry the state.
- An attention state is never carried by colour alone: the trailing slot, or a
  visually-hidden clause inside the title, says "needs input" or "finished".

## Known drift

Verified against `src/renderer/src/components/ui/InboxRow.tsx` (2026-08-04),
the shipped counterpart of this row:

- **Padding.** The reference CSS uses `space.xs` / `space.md` (6/10px);
  shipped rows use `px-3 py-2` (12/8px). **Re-pointed 2026-09-02:** this is not
  code drifting from a spec, it is two specs disagreeing.
  [inbox-row](../inbox-row/component.md) prescribes `space.sm` block and
  `space.lg` inline, which is exactly the 8/12 the code draws. The outlier is
  this entry's own reference CSS, and one row family cannot have two insets.
- ~~**Title size.** This spec sets titles at `font.size.body`; shipped titles
  sit at `font.size.meta`, one step smaller.~~ **Resolved** — the drift ruling ruled for
  the spec and moved the code: `InboxRow` draws its title at `font.size.body`
  over supporting text at `font.size.meta`.
- **`--resting` mechanics.** Shipped rows reach the resting tier via cascade
  (`data-selection-pane` rules in `assets/index.css`) rather than this spec's
  class modifier — same behaviour, different structure — and the
  `data-actions` reserved-padding action host is not implemented (InboxRow's
  trailing slot is display-only). The cascade half is a ruled difference, not
  debt; the reserved padding is still owed.
