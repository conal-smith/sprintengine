# Link button

An action set **inside a sentence**. "Reconnect" at the end of a `·`-separated
state line, "More" under a clamped description, "Search GitHub" beside a field, a
repository path in rendered prose that opens a file rather than a URL.

It is the smallest member of the button family and the only one with **no box at
all**: no height, no inset, no ground, no press scale.

**Why it is not an `<a>`.** None of these navigates. They call something. A link
that is not a link is a lie to the keyboard and to assistive technology, and the
address bar it implies never appears.

**Why it is not a ghost [button](../button/component.md).** The ghost is the
quietest sized member and still brings a `size.control.xs` height, an
`space.sm` inset, `font.weight.medium` and a hover fill. Put that inside a 20px
metadata line and the line grows, the words either side stop sitting level with
it, and the "link" reads as a control someone forgot to finish. In the consuming
product every one of these had stayed a raw `<button>` with `border: 0;
background: transparent; padding: 0` written out by hand — four declarations
cancelling the browser, rather than a shape the system had named.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Link | `.ds-link-button` | yes — a `<button>` |
| Ink | `--quiet`, `--name`, `--quote` | no — the default is accent ink |
| Type | `--inherit` | no — the default is `font.size.meta` |

`display: inline`, so the link wraps with the sentence rather than sitting in it
as a box. The radius exists only so the focus ring has corners to draw round;
nothing is painted inside it.

## Variants

- **Default (accent)** — accent ink, deepening to `accent.hover`, underlined on
  hover. Accent as **ink** is inside the budget; what the budget forbids is the
  accent as a fill, which this never takes.
- **`--quiet`** — `text.muted` lifting to `text.primary`, with a **permanent**
  underline in `border.strong` at a 2px offset. The disclosure case: "More",
  "Show details". The underline is standing rather than a hover reveal because a
  quiet link with no colour and no box is indistinguishable from the sentence
  around it until the pointer happens to cross it.
- **`--name`** — `text.primary`, underlined on hover. The name of the thing a
  list row is about, when the name is what opens that thing's details: the
  extensions list in Settings, where a row's name opens its details popover. At
  rest it has to read as the row's title, not as an action — and the accent
  would turn every title in the list into a second accent. The hover underline
  is what says it can be pressed; the row around it may also open the same
  details on a click, but the name is the keyboard's way in.
- **`--quote`** — `quote.ink`, underlined on hover. A quote's chip in the
  composer and in a sent message ([quote chip](../quote-chip/component.md)): it
  reads as words in the sentence, in the gold its passage is marked with in the
  reply, so the chip and the marked passage are seen to be one thing. Gold, not
  the accent, because the chip names a passage rather than an action.
- **`--row`** — a full-width flex row with its parts baseline-aligned, for a
  LIST of links rather than one set inside a sentence: a column of changed files
  where the name, the folder and the counts have to line up down the list. It is
  a variant rather than a caller's own `display`, because `display` is the one
  property the base rule spends on being inline — a competing declaration at
  equal specificity is resolved by stylesheet order, and a row that quietly fell
  back to `inline` would lose its columns entirely. Everything else about the
  link is unchanged: still no box, no height and no ground.

- **`--inherit`** — takes the surrounding text's size and weight instead of
  `font.size.meta`. For the link set inside prose the caller has already sized: a
  path inside rendered markdown, a name inside a heading. A size of our own there
  would make one word of a sentence a different size from the rest of it, which
  is worse than any consistency it buys.

## States

| State | Treatment |
|---|---|
| Rest | Per ink above |
| Hover | Ink one step; accent and name add an underline, quiet already has one |
| Focus-visible | The shared ring, at the standard offset |
| Disabled | 45% opacity, `not-allowed`, **underline dropped**, ink kept |
| Pressed | **Nothing.** A control that shrank mid-sentence would move the words after it |

**Disabled keeps its ink.** A sentence whose one action has fallen to
`text.disabled` reads as broken copy rather than as an unavailable action, and
the disabled step is certified for 3:1 non-text contrast only — it may not carry
words.

## Usage

- **One per sentence.** Two link buttons in one line of copy is a line that
  wanted a control row.
- **The label is a verb or a noun the sentence needs**, never "click here" or
  "learn more" as a stand-alone. `principles.md` rejects empty-state copy that
  explains an obvious interaction; a link is copy.
- **Not for a primary action.** If the action is what the view is for, it is a
  button with a box. A link is for an action the sentence mentions in passing.
- **Not for navigation.** A destination the shell can route to is a door and gets
  a real navigation affordance.

## Accessibility

- It is a `<button>`, so Enter and Space both activate it, and it announces as a
  button rather than as a link that goes nowhere.
- The focus ring is the product's one indicator and is not suppressed. On an
  inline element the outline follows the line boxes, including across a wrap,
  which is correct.
- The hit target is the **text**, deliberately: the `size.hit-target-min` floor
  governs a standalone glyph, which has no line to belong to. Growing an inline
  control's box to 24px would push the lines around it apart.
- A disclosure link states `aria-expanded` for the region it opens.

## Shipped implementation

`src/renderer/src/components/ui/LinkButton.tsx`, exporting `LinkButton` with
`ink`, `underline` and `size`.
