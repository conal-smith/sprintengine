# Tabs

The view switcher inside a panel: a row of peers, exactly one active, the
active one marked by an accent hairline underline and an ink lift — never an
accent fill. Extracted from the shipped `Tabs` primitive
(`src/renderer/src/components/ui/Tabs.tsx`), whose underline treatment the
conformance tests lock: the only elements allowed to carry accent fill are
1px hairlines.

Use tabs when the choices are views of the same content region. Use a
segmented control when they are values of a setting, and the context rail
when they are destinations.

## Anatomy

| Part        | Class                 | Required                                                                                                                     |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Scroller    | `.ds-tabs-scroller`   | no — the overflow wrapper: scrolls sideways, never draws a scrollbar, fades each overflowing edge                            |
| Tab list    | `.ds-tabs`            | yes — `role="tablist"` with an `aria-label`, one bottom hairline                                                             |
| Tab         | `.ds-tab`             | yes — `role="tab"` buttons, `font.size.meta`                                                                                 |
| Icon        | `.ds-tab-icon`        | no — a leading glyph, `aria-hidden`                                                                                          |
| Count       | `.ds-tab-count`       | no — canonical count, tabular, `font.size.micro`                                                                             |
| Badge       | `.ds-tab-badge`       | no — the `badge` corner count: what is WAITING in this tab. Needs `.ds-tab--badged` on the tab for its room                  |
| Underline   | `.ds-tab-underline`   | yes — the 1px active marker, `aria-hidden`                                                                                   |
| Drop marker | `.ds-tab-drop-marker` | no — on a `--reorderable` strip mid-drag: a 2px accent bar, upright, at the slot the dragged tab will land in, `aria-hidden` |
| Panel       | `.ds-tab-panel`       | yes — `role="tabpanel"`, a focusable scroll region                                                                           |

Tabs sit `size.control.sm` (30px) tall at `space.lg` inline padding, spaced
by `space.3xs`. Each tab overlaps the row's hairline by 1px so the active
underline draws **on** the border, not above it — one line, two meanings.
The underline is inset `space.sm` from each end of its tab: it marks the
label, not the hit area.

## Variants

- **Default** — the row draws its own `border.subtle`-weight structure with a
  `border.default` hairline.
- **`--borderless`** — no hairline; a parent container owns the row's border.
  Needed when the tab row shares its band with trailing inline controls —
  one chrome band, one line. Its tabs also drop the 1px overlap: the line they
  would reach for is a band they are passengers in, and the band's overflow
  container clips the overhang — which is the pixel the active underline lives
  in, so the overlap costs a borderless strip its selection marker entirely.
- **`--badged`** — the tab reserves `space.3xl` of trailing room and docks a
  `badge` count in its top-right: how many things inside want the person. See
  "A count on a tab is not a badge on a tab" below. Never on `--icon-only`, and
  never on a closable tab — that tab's trailing padding is already spoken for by
  its close glyph, and two things docked in one corner is neither of them.
- **`--reorderable`** — the person's order, not the product's (the workspace
  pane's strip). A tab dragged sideways lands in the slot it is dropped in,
  and the focused tab moves one place with Alt+Shift+Left/Right. The strip is
  `--dragging` while a drag is in flight. See "A reorderable strip" below.
- **`--icon-only`** — each tab renders its glyph alone on a
  `size.control.sm` square, the glyph steps up to `icon.size.sm`, and the
  label becomes the tab's accessible name _and_ its tooltip. For a strip on a
  band that cannot spend width on words — a panel's own chrome row, shared
  with that panel's actions. Every item must carry an icon.

## States

| State                  | Treatment                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rest                   | `text.muted`, transparent underline                                                                                                                                                                       |
| Hover                  | Ink lifts to `text.primary`. No background — the underline idiom marks tabs, not a fill                                                                                                                   |
| Active                 | `text.primary` + the accent hairline underline. Never an accent fill or a pill                                                                                                                            |
| Focus-visible          | `focus.ring`                                                                                                                                                                                              |
| Disabled               | `opacity: 0.5`, `cursor: not-allowed`                                                                                                                                                                     |
| Dragging (reorderable) | The strip's cursor is `grabbing`; the carried tab fades to `opacity: 0.5` (`.ds-tab--dragged`); the drop marker stands at the target slot. No marker over the tab's own place, where a drop moves nothing |

## Usage

**The underline is the whole treatment.** An active tab is an ink lift plus a
1px accent line. A filled tab, a tinted pill, or a raised card is a second
accent idiom and a reject-on-sight.

**Selection follows focus.** Arrow keys move focus _and_ activate: Left/Right
step through enabled tabs with wraparound, Home/End jump to the ends. This is
the correct model when switching panels is cheap; if a panel is expensive to
mount, keep roving focus but activate on Enter/Space instead — pick one model
per product and hold to it.

**Roving tabindex.** Exactly one tab is in the tab order at any time — the
active one. Tab from the active tab lands in the panel, not on the next tab.

**Counts are canonical.** A count on a tab is the count of that view. Do not
repeat it inside the panel where the two could disagree.

**A count on a tab is not a badge on a tab** (2026-09-10). They are two
different questions and they get two different places:

- the **count** is _how many things are in here_. It rides beside the label, in
  the reading line, because it is part of what the tab says.
- the **badge** is _how many of them want you_ — updates waiting, work blocked
  on an answer. It sits above the words, top-right, because it is not part of
  them. It is the same pip the app rail's squares wear, so "there is news here"
  is one drawing wherever the product says it.

A tab can carry both, and a tab reading "SprintEngine Studio 10 ③" is saying
two true things. What it must not do is draw the badge at zero: a counter
reading "0" is a counter spent saying there is no news. Nor may a tab spend
the badge on a fact it cannot count — where a source is known to have moved on
but no per-item answer exists yet, that is a mark (a glyph), not a number, and
the two never show together on one tab.

**A badged tab names itself.** The counter is a named live region — it has to
be, the number moves while the reader is elsewhere — and a named child inside a
button joins that button's name-from-contents, so the tab announces as "Studio:
3 updates available Studio 10". Give a badged tab an explicit accessible name:
an explicit name wins over name-from-contents, the tab says its piece once, and
the counter goes on announcing its own changes.

**A badge on a tab is docked, not overhung.** The `badge` component's `--corner`
mode hangs the counter outside its trigger; outside a tab is the scroller's
clip, which is the same pixel-eating that costs a borderless strip its
underline. `--badged` reserves room and the badge sits inside it — same corner,
drawn where it survives, and with no keyline, since it covers the band rather
than a glyph.

**An icon-only tab keeps its name, it just stops drawing it.** The label
becomes `aria-label` and the tooltip, so the word is one hover or one focus
away and unchanged for assistive tech. Dropping the label without either is a
blank button, and it is the only thing this variant can get wrong. It draws no
count at all, and no badge either: a number pinned to a 30px glyph covers the
mark it is badging as soon as it reaches two digits, and five badged glyphs is a
row of alarms. Put the count in the tooltip beside the name ("Log · 3,057
commits").

**A strip that can outgrow its band scrolls, it does not squeeze.** Wrap it in
`.ds-tabs-scroller`: tabs stay `shrink-0`, the row scrolls sideways, and the
overflowing edges fade. Never a scrollbar — under a 36px band it is a second
horizontal line and a third of the row's height. The host routes a plain
vertical wheel to `scrollLeft`, because a horizontal row has no vertical axis
to spend that gesture on.

**A "new tab" control follows the last tab.** It sits directly after the
scroller, not at the far end of the band: the scroller takes only its tabs'
width (it shrinks, it never grows), and the band's free width goes to a spacer
after the control. Once the tabs overflow, the scroller is squeezed to what is
left and the control stays in view at its end, never scrolled away with the
tabs. The band's other actions (maximise, close) stay at the far end.

**A reorderable strip still clicks** (2026-10-10). A press becomes a drag
only once it has travelled 4px sideways; short of that it is the click it
always was. The release that ends a drag does not also select the tab it
started on — it ended a move, it did not choose a view. A drop counts a tab
as "after" once the pointer is past its middle, so a drag never has to reach
the far edge of a wide tab. Escape mid-drag puts the tab back. The marker is
the active underline's hairline stood on end, never a filled slot or a ghost
tab: one accent idiom. Reordering is a separate gesture from dragging a tab
out of its strip (to another workspace or window), which uses the platform's
drag and drop and is untouched by this one. Opening a tab adds it at the end
and leaves the order the person made alone.

**The panel is a tab stop.** It is usually a scroll container, so it takes
`tabindex="0"` — otherwise keyboard users cannot scroll it. Only the active
panel is rendered; inactive panels are unmounted, not hidden.

## Accessibility

- The tablist carries a required `aria-label` naming what the tabs switch
  ("Inbox views"). Tabs are `<button role="tab">` with `aria-selected` and
  `aria-controls` pointing at their panel's `id`.
- The panel carries `role="tabpanel"` and `aria-labelledby` pointing back at
  its tab, so its accessible name is the tab's label.
- The panel's focus indicator is the ring drawn **inward** (a negative
  `focus.ring-offset`): it sits at the edge of a scrolling region, where an
  outward ring is clipped. Without it a focusable panel falls back to the UA
  outline — the one treatment the system cannot theme.
- Icons on tabs are `aria-hidden`; the label carries the name. On the
  `--icon-only` variant the glyph stays `aria-hidden` and the label moves to
  the tab's `aria-label`, so the accessible name is identical in both
  variants — the tooltip is the sighted user's version of the same string,
  and it opens on focus as well as hover.
- An icon-only tab's count lives in its tooltip and its `aria-label`, not in a
  badge, so the number is announced once and read once.
- On a reorderable strip, Alt+Shift+Left/Right moves the focused tab one
  place, without wrapping (a tab moved past the end jumping to the front reads
  as lost), and focus stays on it so the chord can be pressed again. It does
  not change which tab is selected.
- Disabled tabs keep their label readable (`opacity`, not an ink swap to
  `text.disabled` alone) and are skipped by arrow navigation.

## Known drift

All in `src/renderer/src/components/ui/Tabs.tsx`:

- ~~Tabs render 32px tall (`h-8`); the control ramp has no 32px step. Canon is
  `size.control.sm` (30px) — the default for a labeled control.~~ **Resolved
  2026-09-02:** `h-control-sm`.
- ~~Tab icons render at 14px (`h-3.5`); the icon ramp has no 14px step. Canon
  is `icon.size.xs` (13px).~~ **Resolved 2026-09-02:** `size-icon-xs`.
- ~~Disabled tabs ship `opacity-45`; the system-wide disabled treatment
  (list-row, task-card) is 0.5.~~ **Resolved 2026-09-02:** `disabled:opacity-50`,
  the row-family value — a tab is a row in a strip, not a button.

## Shipped implementation

`src/renderer/src/components/ui/Tabs.tsx`, exporting `Tabs` (the strip, with
the `iconOnly` prop, the per-item `tooltip`, and `onReorder` for a
reorderable strip, whose slot arithmetic is in `ui/tabReorder.ts`), `TabPanel` (the panel bound to
it by `aria-controls` / `aria-labelledby`), and `TabsScroller` (the overflow
wrapper — it owns the wheel routing and measures which edges actually overflow
before it fades them).
