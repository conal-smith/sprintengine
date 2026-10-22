# Context ring

How much of a model's context window a conversation has spent, as a 14px
circle filled clockwise from twelve. Extracted from the shipped `ContextRing`
primitive (`src/renderer/src/components/ui/ContextRing.tsx`).

The shape is borrowed, not invented: Claude Code, Cursor and ChatGPT all draw
this ring for this fact, so it arrives already legible. That is the reason it
is a ring rather than a bar or a percentage — a number has to be read, and
this sits beside a title at 14px, in a place with no room to read one. The
number is still there for anyone who wants it, in the tooltip and in the
accessible name.

It is a **display of one proportion**. The mark is not a control (one surface
puts it inside one; see "As a button" below), and it is not a progress
indicator: nothing is loading, and the value can fall as well as rise
(a compaction gives context back). Do not reach for it to show a percentage of
anything that completes — that is a different component, and this one's whole
meaning is "how full is the thing you are about to add to".

## Anatomy

| Part | Class | Required |
|---|---|---|
| Hit target | `.ds-context-ring-anchor` | yes — a 24px focusable box around the mark |
| Ring | `.ds-context-ring` | yes — a 16-unit `viewBox`, drawn at 14px |
| Track | `.ds-context-ring-track` | yes — the unspent remainder, `border.strong` |
| Fill | `.ds-context-ring-fill` | yes — the spent sweep, `accent.primary` |

The anchor is a real part, not padding. A 14px mark is below the minimum hit
target, so the ring is wrapped in a `size.hit-target-min` box that takes the
hover and the focus; the box pulls its own overhang back with a negative block
margin so a 24px target never grows the line it sits in.

The sweep is set with `stroke-dasharray` on the fill circle: the dash is the
spent arc length, the gap is the whole circumference. At `r=6` the
circumference is `37.70`, so 38% used is `stroke-dasharray="14.33 37.70"`.
`stroke-linecap: butt` — a rounded cap at 2px overhangs by about a degree,
which draws a visible dot at 0%.

## Variants

- **Default** — `accent.primary` fill. Accent as INK, which is inside the
  accent budget; the ring never takes an accent *fill* on its ground.
- **`--high`** — `status.warn` fill, past the warn threshold (80% in the
  product that ships it). A compaction is close, which is worth a glance
  before it happens rather than after. This is the only other tone the ring
  ever takes: there is no danger tier, because a full window is not a failure.

There is no size variant. 14px is the idiom.

**With token counts.** Where the surface holds the counts behind the share (a
conversation's composer strip does), the tooltip says them and nothing else —
"76,000 / 200,000 tokens" — and the accessible name says the share and the
counts both: "Context 38% used, 76,000 / 200,000 tokens". The sweep already
shows the share; the counts are what a glance cannot read off it.

**As a button.** On a conversation's composer strip the ring opens what fills
the window: a dialog popover with one stacked bar of the window (each content
row in the categorical chart slots, in the order the agent lists them; free
space as the track; the compaction buffer in `border.strong`), the rows in
words, the heaviest MCP server, skill or memory file the person loaded, and
those groups heaviest first. There the mark is drawn `decorative` inside an
`IconButton` at `xs`, the 24px hit target, and the button takes the
anchor's place: the same tooltip, and the accessible name with "— show what
fills it" after it. An agent that reports a total and nothing under it still
opens the dialog, on the total alone and saying so, so the ring behaves the
same on every chat.

## States

| State | Treatment |
|---|---|
| Rest | Track plus fill; the tooltip closed |
| Hover / focus-visible | The tooltip opens, naming the exact percentage — or the token counts, where the surface gives them |
| Focus-visible | The anchor wears the product focus ring |
| Value change | The sweep animates over `motion.duration.deliberate` |

**Not drawn at all** when there is no reading. A ring at 0% and a ring for a
runtime that reports nothing are the same picture, and one of them is a lie —
so a surface with no value omits the component rather than drawing an empty
one.

The sweep transition is deliberate-tempo because the value moves in visible
steps as a turn ends, and a step that snapped would read as a glitch on a
surface nobody is looking at. `prefers-reduced-motion: reduce` removes it; the
value is unaffected.

## Usage

**Beside the thing whose context it is** — a conversation's title, a session
row, the strip under the conversation's own composer — and never in a toolbar
or a status bar of its own. The ring says
"this one", and it can only do that from next to its subject.

**One per surface.** Two rings on one card is two proportions the reader has
to tell apart by position.

**Never as the only statement of a warning.** The `--high` tone is a nudge,
not an alert; anything that must be acted on gets words.

## Accessibility

- The anchor carries `role="img"` and an `aria-label` naming the value in
  words — "Context 38% used". Never the colour, and never "ring".
- The anchor is focusable (`tabindex="0"`) so the tooltip is reachable without
  a pointer, which is the rule for every tooltip in the system: a hover-only
  reveal is not a reveal.
- The SVG itself is `aria-hidden="true"`. The label lives on the anchor, so the
  mark is announced once.
- The tooltip repeats the same sentence as the accessible name (or, with
  token counts, the counts part of it). It is a
  `describedby` and never the name itself, because a tooltip that IS the name
  leaves an unnamed control for anyone who never opens it.
- Colour is never the whole message: the sweep's LENGTH carries the value, and
  the `--high` tone only sharpens something already visible.
