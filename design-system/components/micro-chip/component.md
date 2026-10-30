# Micro chip

The smallest mark the system has: a hairline rectangle holding one or two
words of **fact about the thing beside it**. "Default" on the option a CLI
would have picked anyway. It is not a badge, not a status, and not a control.
Extracted from the shipped `MicroChip` / `DefaultChip` primitive
(`src/renderer/src/components/ui/DefaultChip.tsx`).

**Why it is not a [badge](../badge/component.md).** The badge family answers
"how many?" and "what state?" — a count in a solid tone, or a label in a
`status.*-soft` fill on `radius.pill`. This answers neither. It says something
that was already true before the person arrived and will still be true after
they leave, so it takes no tone at all: a `border.default` hairline, `text.subtle`
ink, and the rectangular `radius.chip` the badge entry explicitly hands back
("`radius.chip` is the right token for a *rectangular* chip; this is not
one"). Reach for a badge when the mark would change; reach for this when it
would not.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Chip | `.ds-micro-chip` | yes — an inline `<span>`: hairline, `radius.chip`, `font.size.micro` |
| Label | — | yes — the chip's own text, one or two words, sentence case |

The chip has no glyph slot, no dismiss affordance, and no fill. Its inline
padding is `space.2xs` (4px) and it has none in the block direction: the line
box is the height. It never shrinks — `flex: none` — because the row it rides
truncates the title, not the fact.

## Variants

- **`neutral` (the only tone).** Hairline `border.default`, ink `text.subtle`,
  no background. One tone is the variant set, and that is deliberate: a tone
  on this chip would make it a status, and the surface already has a status
  idiom. The shipped `MICRO_CHIP_TONES` map holds exactly one entry so that a
  second one has to be argued here first.
- **`DefaultChip`** — the one shipped instance, reading "Default". It marks
  the option the catalogue (or the CLI itself) would use with nobody choosing,
  and it is one drawing shared by the reasoning selector and the
  permission-preset menu, so the two menus cannot disagree about what
  "default" looks like.
- **`NightlyBuildChip`** (2026-09-22, retired 2026-10-30) — read "Nightly"
  beside the wordmark until the wordmark left the sidebar's chrome row. A
  nightly build now says so with the brand mark's night tile instead; see
  *Nightly identity* under Usage.

## States

| State | Treatment |
|---|---|
| Rest | The only state. No hover, no focus, no pressed, no disabled |
| Inside a hovered row | Unchanged — the row paints its own `bg.hover` behind a transparent chip |
| Inside a selected row | Unchanged — the hairline and the ink both hold on `bg.selected` |

A chip that reacted to the pointer would be advertising a click it does not
have. It is display-only, and the row underneath owns every state.

## Usage

**One fact, one chip, at the end of the row.** It trails the label it
qualifies. Two micro chips on one row is a row that wants a column.

**Never a second status idiom.** If the row already carries a status mark or a
lifecycle glyph, this chip must be saying something *else* — "Default" beside
the working mark is fine, "Active" beside them is the duplicate the principles
reject on sight.

**Never interactive.** No `onClick`, no `role="button"`, no dismiss ✕. A chip
a person can act on is a [button](../button/component.md) or a filter token,
and both look different for a reason.

**Do not reach for it as a size.** "Micro" names the type step, not a
licence to shrink a badge that should have stayed a badge. Primary content
never goes below `font.size.body`; this carries a qualifier, which is why it
is allowed at `font.size.micro` at all.

### Nightly identity

A nightly build says so in two places and nowhere else, and both are keyed to
what the **build** is — the channel its version was cut for, which main
reports as `AppUpdateState.buildChannel` — never to the channel the updater
follows. A nightly switched to stable in Settings is still a nightly until the
stable release installs over it; a stable build following nightly is still
stable. The renderer never parses the version to decide.

- **At launch, the splash plate.** A night sky that comes in from the left and
  right edges toward the centre (`motion.duration.deliberate`, standing down
  under reduced motion), the application icon's "se" on a raised tile built
  from the shell's own vocabulary — `radius.shell-lg`, `color.border-strong`,
  `shadow.modal` — and the word "Nightly" beside the wordmark, in the
  wordmark's weight and tracking, a step down and in `text.muted`. The splash
  is the one surface that shows the mark outside the icon, because it *is* the
  launch of the icon's application; product UI still never does. The plate is
  generated (`scripts/brand/night-sky.js`) rather than painted.
- **In the window, the brand mark's night tile** (owner ruling 2026-10-30).
  The application icon's "se" at the foot of the app rail, below Settings
  (`brand/RailBrandMark.tsx`), sits on a small rounded tile of the nightly
  icon's own night ground; a stable build's "se" stands on the rail with no
  ground at all. This is no longer a micro chip — the chip retired with the
  wordmark it rode beside. The mark's tooltip names the version and the
  channel the build now follows; that detail also lives in Settings, so the
  tooltip is a convenience and not the only place a screen-reader user can
  find it.

No new token was needed. The night sky's palette belongs to the plate's
generator, as every backdrop's palette belongs to its plate, and the rail
tile's few fixed colours are sampled from the nightly icon
(`.brand-night-tile`, assets/index.css); nothing else in the product paints a
night-sky colour as a surface.

A stable build draws none of this: no night tile, the herbarium plate, and a
splash URL with no query at all.

## Accessibility

- The chip is plain text in the document, read in the row's reading order
  after the label it qualifies. It takes no `role` and no `aria-label`: there
  is nothing to name that the word itself does not say.
- It is never marked `aria-hidden`. "Default" is not a repeat of the option's
  name — it is the one fact on the row that nothing else states, and hiding it
  loses it entirely for a screen reader.
- `text.subtle` on `bg.surface` clears AA for the 11px step, and the hairline
  gives the chip a non-text edge at 3:1 — the mark survives greyscale because
  it never had a colour to lose.
- It is not focusable and adds no tab stop to a menu that is already roving
  its rows.

## Known drift

None. `rounded-[3px]` was spelled by hand in the reasoning selector before
this primitive existed; it is now `radius.chip` through the shared chip, which
is what removed the second spelling.

## Shipped implementation

`src/renderer/src/components/ui/DefaultChip.tsx`, exporting `DefaultChip` over
a file-private `MicroChip`. It is deliberately **hookless and outside the
kit's barrel** (`ui/index.ts`): `agentSpawnShared` imports it directly and must
stay clear of the kit's component graph, so a second copy of the drawing never
appears on the spawn path.

`DefaultChip` is the one shipped instance today. The retired
`NightlyBuildChip` was the one that read state (the build identity main
reports); that reading now lives in `brand/RailBrandMark.tsx`.
