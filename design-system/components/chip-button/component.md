# Chip button

A **content-height** pill that toggles, filters, or names one thing. A view-mode
segment on a canvas header, a zoom readout, a branch step in a wizard's trail, an
epic pill on a card, a "Debug" preset that throws a tinted ground.

**Why it is not a button size.** Every step of
[button](../button/component.md)'s ramp pins a `size.control.*` height, and a
chip's height is its **line box**. A chip sits inside a row that has already
decided how tall it is; a 26px control there sets the row's height instead of
riding it, and passing a block inset alongside does not fix it — the caller's
padding and the size step's height are different properties, and the height
wins. So the chip spends its size on the inset and the type, and on nothing else.

**Why it is not a [micro chip](../micro-chip/component.md).** That mark is
display-only and takes no state at all: it says something that was already true
before the person arrived. This is a **control**. If the mark would never react
to the pointer, it is a micro chip; if it toggles, filters, or navigates, it is
this.

**Why it is not a [segmented control](../segmented-control/component.md).** That
is a bar of mutually exclusive options sharing one track. Chips are individual —
they appear alone, in unlike company, and in numbers the bar could not hold.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Chip | `.ds-chip-button` | yes — a `<button>` |
| Variant | `--outline` / `--overlay` / `--raised` / `--pill` | no |
| Tone | `--warn` / `--error` | no |
| Leading mark | — | no — an identity colour dot or a glyph, sized by the caller. Never a status mark: the tone tints say the chip's state |
| Label | — | yes, `font.size.micro`, sentence case |

`font.size.micro` and no lower. A chip is a label *about* the thing beside it,
and it must not outweigh what it qualifies.

## Variants

- **Default (ghost)** — no edge, no ground. A toggle in a chrome strip.
- **`--outline`** — a `border.default` hairline over `bg.surface-raised`. For a
  chip that must be findable on a busy surface: a wizard's branch step, a
  related-node chip on a canvas.
- **`--overlay`** — the form a chip takes when it **floats over content** rather
  than sitting in the flow: a canvas HUD control, a badge over a pan/zoom
  surface. `radius.overlay` and a `border.default` edge over `bg.surface`, so it
  reads as a small floating surface rather than as part of what is underneath.
  Still **no shadow**: the elevation ramp is for surfaces a person opened, not
  for chrome that was always there.

### The toolbar chip, `--raised` (owner rulings 2026-10-01 and 2026-10-04)

**`--raised`** is a chip that is a **control in a toolbar row** rather than a
label inside a line: the composer's model, skills & MCPs, permissions, worktree
and ⋯ triggers, and the project and machine pickers on the launch row. Those
had been `--outline` and ghost chips at `radius.chip` on their line box, and
they read as squarer and shorter than the buttons they shared a row with.

It takes the toolbar's box: `size.control.xs`, `radius.control`, the
`space.md` inset and a `font.size.meta` label. And it is **ghost** — tier 3 of
[button → Control tiers](../button/component.md): no edge and no ground at
rest, `text.muted` ink, `bg.hover` and `text.primary` under the pointer, and
`bg.active` under the shared press scale. A control inside a surface has the
surface for an edge; a hairline and a lift on every chip of a row made the row
read as a strip of tiles. It keeps everything that makes it a chip rather than
a button: the tones, the identity tint, and the thrown states.

It is the **one chip variant that is not content-height**, and that is the whole
reason it is a variant rather than a re-skin of the default: a toolbar row has
already decided it is a row of controls, so riding a line box there is the
defect, not the virtue. A chip inside a sentence, a card's meta line or a
canvas HUD stays on one of the three inline variants.

The name is the 2026-10-01 one and stays, because modules import it; since
2026-10-04 it draws flat. From 2026-10-01 to 2026-10-04 it wore the outline
button's border and the retired lit lip, drop and sheen.

A composite that has to wear the same box without being one button — the
worktree switch is a glyph button and a name field in one box — takes the shell
from the shipped primitive's `RAISED_CHIP_SHELL` export rather than spelling
it, so it cannot drift a pixel from the chips beside it.

### The filter pill, `--pill` (owner ruling 2026-11-03)

**`--pill`** is a chip that picks **which part of a gallery is shown**: the
Extensions catalogue's line of Installed and its sources. The strip of tabs it
replaced scrolled sideways once a person had more than a few sources, and the
ones off its edge were sources nobody found.

It takes `size.control.sm`, a full radius, the `space.lg` inset and a
`font.size.meta` label, and rests on `bg.well` so the line reads as a set of
choices before any is chosen. The chosen pill takes the neutral selection fill,
as every thrown chip does. A line of them holds as many as fit and folds the
rest into a **More** pill that opens a menu; it never scrolls.

A line of pills that switches a panel is a **tablist**: each pill is a
`role="tab"` with `aria-selected` and `aria-controls`, the arrow keys walk the
pills the line shows, and `aria-current` is not used.

### A row too narrow for its chips

A row of raised chips never answers a narrow panel by crushing every chip to a
sliver. From 2026-10-01 to 2026-10-04 the conversation composer folded its
secondary chips behind a chevron; it no longer needs to. Its row is now the New
chat composer's — the "+", the attached tags, the engine chip and send — short
enough to wrap only in a pane narrower than any it is drawn in, and its
facts moved to the strip under the box, which keeps to one line by moving what
does not fit into a "⋮" menu in a fixed order (the conversation strip in
`src/renderer/src/components/panels/agentChat/conversationStrip.tsx`). The
rules the fold kept still hold for whatever answers a narrow row next:

- **Measured against the row, not the window.** The same panel width is a
  different budget depending on what sits beside the panel.
- **Nothing is dropped.** A control that leaves the row is reachable from the
  menu it moved to, doing what it did on the row.
- **Mounted once.** A control moves; it is not drawn twice, so there are never
  two focus targets or two accessible names for one control.
- **A standing warning survives.** A chip carrying the warn tone (permissions
  bypassed) keeps it wherever the control goes — the engine chip wears it now
  that the permissions are inside its picker.

The edge, where a variant has one, is present **at rest and held through every
state**. A border that appeared when the chip was thrown would resize the row it
sits in.

## Tone

- **Default** — `text.subtle`, lifting to `text.default`. The chip is a
  qualifier.
- **`neutral`** — `text.default`, lifting to `text.primary`. One step up, where
  the chip's label is the row's own information.
- **`--warn` / `--error`** — a **standing warning the chip itself carries**:
  scripts are running in this preview, permissions are bypassed on this preset.
  Thrown, it fills the tone's soft tint and takes the tone's `on-tint` ink, which
  is what keeps the label legible on the fill.

The tone tints are the one narrow exception to "status is never a pill". The
condition is that the chip **is the control that sets the state** — the person
turned bypass on, and the chip is where they turn it off. A chip that merely
*reports* a state, beside a row that also carries a status mark, is the
two-idioms collision the system rejects on sight.

## Identity tint

A chip may carry an **identity colour** of its own — an epic's hue, a bucket's —
resolved per item by the caller. It paints the ink and a 12% mix of the same
value as a ground, **never a solid fill**: an identity hue is a name, not a
status and not an emphasis (`principles.md` → Identity colour). It is the same
12% weight the `status.*-soft` tokens carry, so an epic pill and a warn chip sit
at the same depth on the surface.

A thrown state **outranks** the tint. Interaction state is a state of the pointer
and the keyboard; an identity is a property of the thing, and the state paints
over it while it lasts — the same ordering the file tree's row washes follow.

## States

| State | Treatment |
|---|---|
| Rest | Per variant and tone above |
| Hover | `bg.hover` ground, ink one step up — **only while not thrown** |
| Thrown | `bg.selected` (neutral tones) or the tone's soft tint, held through hover |
| Focus-visible | The shared ring |
| Disabled | 45% opacity, `not-allowed` |
| Pressed | `scale(0.97)`, like every control (removed under reduced motion). `--raised` also steps its ground to `bg.active` while held |

## Accessibility

- **`aria-pressed` for a toggle, `aria-current` for one of a set.** A view-mode
  chip you switch on is pressed; the step you are on in a trail is current. Both
  are tri-state in the shipped implementation: undefined on a chip that is
  neither, `false` on a toggle that is off.
- The label carries the meaning; a chip whose state is colour alone fails
  grayscale. A thrown chip changes its **ground**, which survives it.
- Chips are individually focusable. A row of chips is a row of tab stops unless
  the host makes it a composite, in which case the host owns roving focus and the
  chips take `tabIndex` from it.

## Known drift

**The tone tints' ink.** The reference CSS here paints a thrown `--warn` /
`--error` chip in the tone's own colour on the tone's soft fill — the call
[badge](../badge/component.md) and [banner](../banner/component.md) already make
in this bundle. The shipped primitive darkens it one step, to an "on tint" ink
mixed toward `text.primary`, because the raw tone on a 20% tint of itself is
close to the contrast floor at `font.size.micro`.

That step exists in the consuming app and **has no token here yet**, so it is
recorded rather than invented locally: adding `status.*-on-tint` to the
foundations is a token decision with nineteen themes downstream of it, not a
component's to make. The shape, the fill and the condition are the same either
way.

## Shipped implementation

`src/renderer/src/components/ui/ChipButton.tsx`, exporting `ChipButton` with
`variant`, `tone`, `pressed`, `selected` and `tint`, and `RAISED_CHIP_SHELL` —
the `--raised` box for a composite that has to wear it.
