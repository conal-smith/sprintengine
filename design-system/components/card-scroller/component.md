# Card scroller

A heading over a row of tiles that scrolls sideways: more choices than a column
holds, each at its full size, rather than shrunk to fit or stacked until the page
scrolls. Extracted from the shipped `CardScroller` primitive
(`src/renderer/src/components/ui/CardScroller.tsx`). New chat's starting points are
the first use.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Heading | `.ds-card-scroller-head` | yes — what the tiles are, with an optional leading glyph |
| Scroll buttons | `.ds-card-scroller-head .ds-icon-button` | only while the row overflows |
| Row | `.ds-card-scroller-row` | yes — one line of [card buttons](../card-button/component.md) |

## Variants

None. A row is three tiles wide in a column of 520px or more, and most of one
tile wide below that. Either way the next tile's edge shows in the fade, so the
last whole tile is never faded and the row says it goes on.

## States

- **Fits**: no buttons, no fade. Nothing says it scrolls, because it does not.
- **Overflowing**: each edge with tiles past it fades to transparent, and the two
  buttons appear. A button with nothing past it in its direction is disabled.
- **Reduced motion**: a press jumps a page rather than gliding one.

## Usage

The scrollbar stays out of it, as a [tab strip's](../tabs/component.md) does: the
fade and the buttons are what say there is more. A plain vertical wheel over the
row scrolls it, because that is the gesture people make.

Use it for a handful of optional things to try, where seeing them all at once does
not matter. A choice someone has to compare side by side belongs in a grid. Tiles
in a row keep `card-button`'s rule: hover changes the ground and nothing else.

## Accessibility

The row is a `section` named by its heading. The tiles stay in reading order and
take focus normally, so tabbing through them brings each one into view; a person
on a keyboard never needs the buttons. The buttons are named "Scroll back" and
"Scroll on", and a disabled one says there is nothing more that way.
