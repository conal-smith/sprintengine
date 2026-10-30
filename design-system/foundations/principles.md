# Principles

The rules this system enforces that tokens alone cannot. Tokens decide what a
value is; these decide when you are allowed to reach for it.

This file is the authority on how SprintEngine Studio looks. Where it and your
instincts disagree, it wins. Where it is silent, decide, and add the rule here.

## Restraint

Restraint is the whole craft. The default failure of a generated interface is
not ugliness — it is genericness: many accents, decorative chrome, a
happy-path-only screen. Density is bought by removing elements, words, and
chrome, never by shrinking type or crushing rhythm.

**The accent budget.** Solid, saturated color is the strongest signal the system
has, so it is spent on almost nothing:

- `accent.primary` as a **solid fill** appears on the **primary action** and
  nowhere else. One per view — an inspector aside counts as its own view.
- `accent.primary` as **ink or a hairline** may mark focus (`focus.ring`) and a
  genuinely live process.
- Everything else earns its weight from the neutral ink and surface ramps.
- The brand monogram's "e" is drawn in `accent.primary` ink, the way the
  application icon draws it. Ink on two letters, not a fill and not a signal.

If a surface needs a second accent, it is missing hierarchy, not color. Status
hues (`status.*`) are not accents: never a button background, section border,
chrome tint, or category code. (Identity hues on vendor marks and file-type
glyphs are a different thing — see "Identity colour" below.)

**The storefront exception** (2026-09-06). A grid of offers — cards in a
catalogue, each with one identical action in the same place — takes the accent on
*every* card's action, not on one. The budget above is a rule about a **working**
surface, where a second accent means the hierarchy is missing; in a storefront
the picture and the title do the ranking and the button is furniture that has to
be findable. Spending the accent once there leaves every card but one with its
call to action as the quietest thing on it.

Two conditions, and both are load-bearing: the actions must be **the same action
repeated** (a row of unlike accented controls is a category code, which the rule
above forbids), and the surrounding chrome must stay neutral — the Extensions
home accents its cards' buttons and deliberately leaves its tile glyphs in
neutral ink for exactly this reason.

**Identity colour** (ruled 2026-09-06, revising the 2026-09-02 monochrome
ruling for two families; a third added 2026-10-04). Three kinds of glyph carry
a colour of their own, and
the accent budget does not count them, because the colour is not ours: it
names something.

- **A vendor's mark wears the vendor's colour.** The editor marks
  on the open-in-editor control, the CLI badges, the product mark. A
  monochrome logo is a drawing of a logo; every other app on the machine shows
  the real one, and the neutral version read as a placeholder. These are brand
  assets with hex of their own, exempted by file from the token guard.
- **A file-type glyph may wear its language's hue** — the `color.mark.*`
  tokens (blue for TypeScript, yellow for JavaScript, orange for HTML …), so a tree of forty files scans by colour before it is read. This
  is opt-in per surface (`FileTypeGlyph tone="kind"`).

  **Amended 2026-09-09 (owner's ruling, the Commit-window epic).** The
  condition used to be **"only where nothing else in the row is coloured"**,
  and it named the Git changes list as the surface that did not qualify. It
  qualifies now. A file row may carry **both** the kind hue on its glyph and a
  status tint on its name, because the two answer different questions in
  different channels: **the hue identifies and the tint grades.** A `.ts`
  glyph is the same blue on the modified row, the added row and the deleted
  row — it never moves with state, so it cannot be read as a grade — and the
  name's tint is the only thing in the row that does move. Those two channels
  remain distinct; the old condition made readers give one of them up.

  What the amendment does **not** license: a second *grading* hue in one row
  (two channels, never three), a kind hue on any glyph that names no language
  (`config`, `text`, `generic` stay in the row's ink), or a row wash stacked
  under the two — the file-tree clause below still caps the washes at two, and
  interaction state still outranks every one of them.

- **A machine's glyph may wear its machine's colour** (owner ruling
  2026-10-04). Every machine other than this one has a kind — laptop, desktop,
  mini, tower, server, cloud VM, container, board or WSL — drawn as the device,
  and one of eight colours: the seven `color.mark.*` hues and a neutral
  (`text.muted`). The default kind comes from what the machine is and the
  default colour from a hash of its stable id, so every device that sees the
  machine shows the same one; a person can change both in Settings › Machines.
  The colour is on the glyph and nowhere else — never the machine's name, a row
  wash or a pill — and this machine wears no mark at all.

What does not change: the hue identifies, it never grades. `color.mark.*` is
not a status ramp and not an accent. A gear or a plain document — glyphs that
name no language — stay in the row's ink; colour that says nothing is still
chrome.

**The file tree answers "what IS this?" on the row** (ruled 2026-09-07,
narrowing the "never a background" half of the clause above). A tree of a
thousand files is the one surface where the question a person arrives with is
not "what is the state of this?" but "which of these is mine to read?" — and
the answer is a property of the file, not of anything they have done. Three
cues carry it, and each owns a channel nothing else in the row uses:

- **Test material takes a teal row wash**, and its glyph takes the notched tile
  with the tick. Teal keeps tests distinct: this product's accent IS green and
  `status.good` is the emerald beside it, so a third green on a row reads as
  "selected" or "passing" rather than "test".
- **Machine-written trees take an orange row wash** — build output, generated
  sources, anything marked Excluded.
- **Ignored files lose contrast rather than gain colour.** `text.disabled` ink,
  and the file glyph drops out of its identity hue back to the row's. This is
  the one cue that is deliberately NOT a hue: a build tree is not something you
  are looking for, and dimming is cheaper to read past than a colour that has to
  be decoded. Giving both "excluded" and "ignored by VCS" the same orange
  would erase the distinction between them.

Three conditions, all load-bearing:

1. **The wash is DECLARED, never sniffed.** A role comes from "Mark directory
   as" — the person said so — or from a test-naming convention that is a
   convention, not a guess. No heuristic gets a row a colour, because a heuristic
   that is wrong 5% of the time makes the whole channel unreadable.
2. **Only two washes exist.** Marking the sources root paints nothing: a wash
   that covers most of the tree has said nothing. If a third wash is proposed,
   the domain wants modelling again, not another hue.
3. **Interaction state outranks the wash, always.** A wash is a property of the
   file; hover and selection are states of the pointer and the keyboard, and
   they paint over it while they last. A row a person has picked is never tinted
   by what it happens to be.

Everything the earlier clause forbade elsewhere still stands: no category code
on a control, a section, or a chrome surface, and the folder mark takes a role
hue only on the folder the role was declared ON, never down the subtree that
inherits it.

**Selection is neutral.** A selected row uses `bg.selected` — a neutral fill —
and lifts its title to `text.primary`. It does not use the accent, and it does
not carry a left bar, a border box, or a glow. A row that is merely *chosen*
must never outrank the one action worth taking. The Backlog rows' epic-colour
left bar was retired on 2026-09-02 under this rule: the `EpicColorDot` carries
epic identity, and the skeleton no longer reserves the bar.

## Quantified restraint

Ceilings, not guidelines. Exceeding one signals missing hierarchy; when a view
exceeds one, model the domain again rather than adding chrome.

| Ceiling | Limit |
|---|---|
| Product accents visible per view | 1 |
| Status idioms | 1 — the status mark or a lifecycle glyph, never both; never a dot |
| Font families | 2 — `font.family.ui`, `font.family.mono` (typeset content excepted; see Type) |
| Font weights per view | 3 |
| Font sizes per view | 3, repeating title / body / meta |
| Border radii per view | 2 |
| Controls above the first content row of a panel | 5 — but see the amendment below |
| Visual elements per repeated row at rest | 4 — but see the amendment below |
| Trailing actions a row may reveal on hover | 2 |
| Motion treatments animating at any moment | 1 |

**The four-element ceiling counts what a row SAYS, not what it lets you do**
(amended 2026-09-09, the Commit-window epic). `components/check-row` carries
five at rest: the checkbox, the file glyph, the name, the directory, and the
trailing status mark.

The ceiling exists because a row with five things to *read* is a row carrying
work that belongs in the detail pane — `list-row`'s entry says exactly that.
That is a statement about how much a person has to take in before they can
choose. A checkbox is not something taken in; it is the row's one control, and
it answers in 16px a question the row would otherwise need a whole second
surface to answer — the Staged / Unstaged split the Commit window deletes, or a
right-click menu. A control is not work carried, it is work saved.

Two conditions, both load-bearing:

1. **The fifth element is a CONTROL, and there is exactly one of it.** The
   things a row is *read* for still cap at four: glyph, name, supporting line,
   trailing mark. A row with five facts on it is over the ceiling as before, and
   a second control on a repeated row is over it too.
2. **The row reveals nothing on hover.** The ceiling and the two-trailing-actions
   allowance are not additive — a row already spending its fifth slot on a
   control has none left to reveal into. At the 24px floor there is no room
   anyway, which is the honest version of the same rule.

A group header is not a repeated row and the ceiling does not reach it; it
holds itself to one chip and one revealed control for its own reasons
(`components/group-header`).

**The five-controls ceiling counts PANE CHROME, not a region's own header**
(amended 2026-09-09, owner's ruling, mockup 2522). The Git panel's glyph band
carries nine: refresh, discard, move to changelist, stash, write commit
message, show diff | group by, expand all, collapse all. The owner accepted
this arrangement because the band belongs to one region rather than the pane.

The ceiling exists because chrome stacked above a region pushes the content
down and makes a person read a row of unrelated affordances before reaching
what they came for. That is a statement about **pane** chrome — a strip that
belongs to the window, sits above everything in it, and would be there whatever
the pane were showing. A band that belongs to ONE region, acts only on that
region, and would disappear with it is that region's own header, and it counts
against the region rather than against the pane. The nine here are nine verbs
about the changes list and nothing else: hide the list and every one of them is
meaningless.

Two conditions, and both are load-bearing:

1. **Every control acts on the region beneath it.** One item that opens a
   pane-level or app-level surface makes the band pane chrome again, and the
   ceiling of five applies to the whole thing.
2. **The band is grouped, not enumerated.** Nine identical squares in a row is
   a search problem; the divider (`components/toolbar`) is what turns it into
   "six about the files, three about the view", and a band that needs a third
   group probably needs an overflow menu instead.

What is unchanged: **two stacked bands of chrome above one region is still a
reject on sight.** The Git panel draws the pane's tabs and then this band, and
the ruling is that the second of the two is not chrome — not that a pane may
have two chrome strips. The conformant fallback, if that argument is ever
rejected, is five glyphs plus one overflow kebab.

## Selection and focus

Selection answers "what did I pick?". Focus answers "where am I typing?". A
**cursor** answers a third question — "which row would Enter act on?" — in a
list that is one tab stop and walks with `aria-activedescendant` rather than
moving DOM focus. Three questions, three treatments, never shared.

- **Focused selection** — `bg.selected`, title at `text.primary`. The list the
  user is driving right now.
- **Resting selection** — `bg.selected-resting`, title at `text.default`. Every
  other pane's selection: it remembers the choice without competing.
- **A multi-pane surface has exactly one focused selection.** In a
  rail → list → detail layout, two of the three panes are always resting. Three
  panes rendering a full-strength selection at once is the defect this rule
  exists to prevent.
- **Focus** is `focus.ring` — a 2px `border.focus` **outline at
  `focus.ring-offset`** — on `:focus-visible`, and it is the product's only
  focus indicator. Never on `:focus`: a mouse click must not draw it. Never
  suppressed, and never at a zero offset. The offset exists because
  `border.focus` and `accent.primary` are the same value: drawn tight against
  an accent-filled control the indicator has nothing to contrast with, and
  focused renders identically to unfocused. An **outline**, not an offset ring —
  the gap is transparent and shows whatever surface is actually behind, where
  `ring-offset-color` has to be told that background and gets it wrong the
  moment the control changes surface. A control that clips its own overflow
  (the halves of a split button) uses a negative `focus.ring-offset` rather
  than a second treatment.
- **Hover** is a background change to `bg.hover`. No shadow, no scale, no glow,
  no border appearing on hover and shifting the layout.
- **The cursor** is a 2px mark in the row's leading gutter, `text.primary`,
  inset from the row's top and bottom edges. It is deliberately neither a fill
  nor an outline: it has to compose on top of a selected row, a hovered row and
  a plain one, and both of those channels are already spoken for. It is not the
  accent either — `border.focus` and `accent.primary` are the same value in all
  but one theme, so an accent bar in the gutter reads as focus.
  Added 2026-09-02, when a conformance sweep replaced two lists' cursors with
  `bg.hover` and made them invisible on the rows a person had already picked.
  A list that moves real DOM focus with its cursor does not need this: there
  the focus ring is the mark, and one idiom is better than two.

## Progressive disclosure

What you withhold is as deliberate as what you show. No screen confronts a
person with everything at once.

- Each screen gets one visual priority. High-signal status and the default
  reading path are visible; secondary detail and lower-frequency configuration
  are revealed as the user reaches for them, behind nearby disclosure.
- **Prefer per-row and per-cell actions revealed on hover or focus over
  always-on controls.** Delete, roll back, close, reveal-in-folder, and the rest
  belong to the row you are pointing at — not to every row simultaneously.
- Anything revealed on hover **must also appear on keyboard focus**, and must
  have a non-hover path (an overflow menu, a context menu, or the detail pane).
  Hover-only is a bug, not a style.
- Revealing an action must not resize or reflow the row. Reserve its space, or
  reveal it over the row's trailing padding.
- Disclosure is not concealment: destructive or state-changing actions stay
  discoverable, and a state a person must act on is never hidden behind hover.

## Hairlines carry the structure

- Borders do the structural work. Cards, fills, and shadows do not. Group with
  space and a heading before reaching for a container; a card inside a card
  needs a real containment reason.
- **A settings group is a card, and that is the stated reason** (ruled
  2026-09-14). The rule above still holds everywhere else: space and a heading
  first, a container only for a reason. A settings page is the reason. It is a
  long scroll of rows that have nothing to do with each other except which page
  they landed on, and the groups run eight and ten rows deep — at that length
  the gap between two groups and the gap between two rows are the same gap, and
  the heading is left labelling a region with no edge. So a run of setting rows
  takes a bordered surface: `border.subtle`, `radius.shell`,
  `bg.surface-raised`, hairlines between rows and never around them. The
  section label stays **outside** the card and keeps its own typography — the
  card is the group's edge, so a heading inside it would draw a second one. See
  [setting-row](../components/setting-row/component.md). This does not license
  cards elsewhere: it licenses them where a group's own length has eaten the
  space that was separating it.
- Hairlines are 1px at canonical zoom. No doubled borders where surfaces meet,
  no 2px divider as decoration.
- **Elevation is a three-step ramp, and every step is an overlay:**
  `shadow.popover` for trigger-anchored surfaces, `shadow.drawer` for drawers
  and side panels, `shadow.modal` for centred dialogs. Nothing in the document
  flow — no card, row, or hover state — takes a shadow.
- **Controls come in three tiers, and only the first catches the light**
  (owner ruling 2026-10-04):
  1. **The primary action** — the filled accent, and the destructive fill that
     stands in for it — carries one faint lit top edge,
     `shadow.control-raised`, and nothing else: no drop, no sheen.
  2. **A standalone secondary** — an outline button, a split button, a launcher
     tile, a field trigger in a form — is flat on a hairline: `border.strong`
     on a transparent ground for the buttons, and the field and tile grounds
     they already had. No highlight, no sheen, no drop.
  3. **A control inside a surface** — a toolbar, a panel header, a composer's
     control row — is ghost: no edge and no ground until the pointer arrives,
     then `bg.hover`. Ghost and icon buttons always were; the toolbar chip and a
     trigger in a toolbar now are too.

  Every control presses the same way, by `scale(0.97)` on the shared hover and
  press motion, and not at all under `prefers-reduced-motion: reduce`. A
  segmented control's selected thumb is the one in-flow lift besides tier 1:
  `bg.selected` over `shadow.control-thumb`, a small drop with no lip, so the
  chosen segment reads as a piece set on its track. See
  [button → Control tiers](../components/button/component.md).

  This recuts the control elevation of 2026-09-02, widened on 2026-10-01, which
  stood every bordered control off the page on a lit lip, a shallow drop and a
  sheen, and sank it on an inset shadow while held. Spread across every
  outline, chip, tile and thumb, that depth stopped saying *this one is
  pressable* and became texture; the five tokens that carried it
  (`shadow.control-edge`, `shadow.control-pressed`, `shadow.control-track`,
  `gradient.control-sheen`, `gradient.control-raised-sheen`) are retired. A
  bevel, an inset press or a sheen coming back on any control is a regression,
  not a refinement.
- In light mode, `bg.surface-raised` is deliberately the same white as
  `bg.surface`: raised surfaces separate by shadow and `border.strong`, not by
  tone. In dark mode the tone step does the work.
- **Inside an overlay, space separates — rules do not.** A dialog's title, its
  content, and its buttons are divided by padding. A rule under the title and
  another above the buttons cuts a small surface into three boxed strips and
  buys nothing: the shell already draws its own edge, and a shell that scrolls
  as one piece never needed the rules as scroll affordances.
- **One chrome row per content region.** Everything that is chrome for the same
  content shares a band — status on the left, controls on the right. A tools bar
  stacked on a status bar spends a second band of vertical space to say what the
  first could hold. When you reach for a second row, the question is which row
  the new control belongs in, not where to put the new row.
- **A notice carries its tone with a glyph, not a coloured edge.** A 2px stripe
  down one side of an error or warning card is decoration wearing a hairline's
  clothes: it doubles the card's own border, breaks the 1px rule, and leaves the
  tone carried by colour alone. Use a 1px neutral hairline, the soft tone tint,
  and the tone glyph at the leading edge — which is what makes it survive
  greyscale.

## Space and size

- Every padding, gap, and margin comes from `sem.space.*` — a 2px grid at the
  dense end opening to 4px steps at panel scale. A raw pixel value in a
  component means the scale is missing a step; add it here rather than locally.
- Controls come from `sem.size.control.*`: `xs` (26px) for icon buttons and
  in-row triggers, `sm` (30px) as the default for anything with a label, `md`
  (34px) for overlay primary actions. An input and a select side by side must
  share a height.
- Nothing interactive is drawn below `sem.size.hit-target-min`. A small glyph
  pads out to it with a transparent hit area rather than shrinking its target.
- An indent that aligns text to a reserved glyph slot (the 28px a leading
  16px glyph plus its gap occupies) is structure, not rhythm: it keeps its
  computed value, off the space scale if need be, with a one-line comment
  saying what it lines up with. Moving it to the nearest step misaligns the
  column it exists to align.
- At most 2 radii per view. `radius.control` (5px) is the default; larger radii
  belong to overlay and modal shells. Marketing radii (`rounded-2xl` and up)
  never appear on operational chrome.
- **The composer is the one named exception to that ceiling** (owner ruling
  2026-10-04). Its box takes `radius.composer` (22px), and the context strip
  tucked under it takes `radius.composer-strip` (16px) on its two bottom
  corners only, so the two read as one piece. The cards set against it — the
  tiles under the New chat composer, and the top corners of the tray docked on
  an open conversation's composer — take `radius.composer-companion` (16px,
  owner ruling 2026-10-05), so a ramp corner beside the box does not read as a
  second family. The composer is the surface a person types into all day, and
  the soft corner is what sets it apart from the chrome around it. All three
  tokens are marked `offRamp`: they are not rungs of the shape scale, the
  conformance guard leaves them out of its ramp exactly as it does `pill`, and
  nothing else may borrow them — a card, popover or control inside the composer
  keeps the ramp.
- A capped column is centred or it is a bug. When a `max-width` element IS the
  page's content — a wizard step, a settings body, a door canvas — it centres
  (`max-w-*` + `mx-auto`), and its footer actions cap to the same measure so
  they align with the content edges. A reading-measure cap *inside* a
  left-anchored composition (prose under an uncapped heading, beside a figure)
  stays anchored with its siblings; centring it alone would misalign the page.

## Type

**Two families, permanently.** `font.family.ui` (Inter) for everything a person
reads; `font.family.mono` (JetBrains Mono) for identifiers, paths, hashes,
code, and `kbd`. There is no third family, and no serif anywhere in the
product. Introducing one is a system change, not a styling choice.

The two families are the interface's. Content the app typesets on a person's
behalf carries the faces its notation needs, and only inside that content
(owner ruling 2026-10-07):

| Content | Faces | Why |
|---|---|---|
| Math in agent replies (KaTeX) | KaTeX's own families (`KaTeX_Main`, `KaTeX_Math`, `KaTeX_AMS`, …), serif included | Mathematical notation is defined by those glyphs; set in Inter, a formula stops reading as one. Bundled with the app and loaded with the first formula, so it costs nothing until a reply has math, and works offline. |
| Canvas drawings | Excalifont, Nunito, Comic Shanns | They are the drawing's own lettering, chosen per element by the person who drew it. |

Diagrams (Mermaid) are not on this list: they are drawn in
`--sem-font-family-ui`. Any face a new kind of content brings is added to this
table, with its reason, before it ships; nothing on the list may be used for
chrome, labels, or prose around the content.

- Sentence case everywhere except real keyboard shortcuts. No uppercase
  letter-spaced labels as hierarchy — not on section headers, metadata,
  breadcrumbs, or chips.
- The scale repeats title / body / meta. Primary content does not go below
  `font.size.body` (13px).
- Tracking is optical, not decorative: `tracking.tight` on titles at 14px and
  up, `tracking.wide` on mono identifiers and micro labels, `tracking.normal`
  everywhere else.
- Line height by context: `line.tight` for display, `line.default` for UI,
  `line.relaxed` for prose. Not a single default applied everywhere.

**The micro-typography pass** — run before any surface is called done:

- `tabular-nums` on every numeric column: counts, ids, timestamps, durations.
- Mono for identifiers only, never for prose.
- Numbers, ids, and percentages right-align in columns; titles left-align.
  Dense data is never centre-aligned.
- Curly quotes and em-dashes in copy, no double spaces. Code is exempt.

## Copy

Copy is the last resort, not the first. A sentence in the interface is an
admission that the interface did not carry the meaning on its own.

**The UI does not explain the UI.** If a control needs a sentence beside it to
say why it exists or what will happen, the control is wrong — redesign it. The
generated-interface tell is a screen where every element has a caption. Delete,
in this order:

- A subtitle that restates the title. "Add a skill source" / "A public GitHub
  repository. We walk it and find the skills" says the same thing twice.
- A field label that restates the dialog title. One field under "New
  automation" does not need an "Automation name" label above it — pass the name
  to the control as its accessible name and let the placeholder do the visible
  work.
- Helper text that restates the placeholder. A field showing `owner/repo` does
  not need "a github.com address, or owner/repo" beneath it.
- A closing paragraph reassuring the user about what just happened. "X is now
  one of your sources. Nothing is installed yet — take skills from it when you
  want them" is three sentences replacing a state the screen already shows.

A line of copy earns its place only by carrying something the screen cannot:
a consequence the user cannot see (where a file will be written), or a fact
they cannot infer (which project this adopted as its home).

**The product does not name itself.** UI copy never says the application's
name. "SprintEngine Studio will run this command", "cannot be undone from
SprintEngine Studio", "while SprintEngine Studio is open" — every one of these
is the app narrating itself in the third person, and no serious product does
it. Write the sentence without the name: "Will run:", "cannot be undone from
here", "while the app is open". The name belongs in exactly four places: the
window title, the About/version line, the sign-in and account surfaces, and
first-run onboarding.

The one carve-out is the brand **monogram** — the application icon's "se" —
which may appear exactly once, as window chrome at the foot of the app rail,
below Settings, where a click opens the project's repository (owner ruling
2026-10-30; it replaced the "sprintengine" wordmark at the top of the left
column). A nightly build draws it on the nightly icon's night tile; a stable
build draws it on the rail's own ground. A mark is not a sentence: it
identifies the window the way a title bar does, and it does not narrate. The
rule above is unchanged for copy — no label, message, tooltip, or empty state
gains the name because the mark exists — and "exactly once" is literal, so a
second placement retires the first rather than joining it.

**Report the result, not the inventory.** When an operation finishes, show the
one fact that answers "did it work?" — a count, a name, a state. Everything
else the operation happens to know (file counts, commit hashes, byte sizes,
which internal layout was chosen) is stored, not displayed. Metadata dumped
into a success message reads as a machine reporting to itself.

**Empty is not invalid.** A required field nobody has filled in yet is not an
error. Do not mark it with a red "Required" or an asterisk on open — the
disabled confirm button already says "not yet". Validation messages appear
after the first keystroke, never before.

## Composition

Tokens govern values and components govern parts. Neither one governs how parts
are assembled into a surface — and that is where generated interfaces actually
fail. A screen can use every correct token, every approved component, and still
be wrong because it has two toolbars, a search detached from the list it
filters, and a heading over a group of one.

So the system fixes canonical **anatomies**. An anatomy is not a suggestion:
where one exists, build to it, and if a surface cannot fit it, the surface is
the thing to reconsider.

**The list surface** — every rail, column, and panel whose job is "find a thing
in a list" is built from exactly these parts, in exactly this order:

1. **The create affordance.** "New …", full width, at the very top. Never below
   the scroll.
2. **The search field, with the filter glyph beside it.** One row. Search is the
   only at-rest narrowing control; every other axis — project, view, sort,
   group — is an option inside the glyph's menu. Because collapsing them hides
   that a filter is applied, the glyph marks itself active whenever any axis is
   off its default.
3. **One divider.** Directly under the search row, and nowhere else in the
   header. This is the line that means "the list starts here" — it is the only
   rule the surface gets.
4. **The rows.**

Two consequences follow, and both were real defects:

- **A second full-width control never stacks above the search.** A project
  Select sitting over the field it narrows is a control competing with the
  control beside it, and it puts the same choice in two different shapes on two
  different surfaces.
- **The search belongs to the column it narrows, not to the screen.** In a
  list-plus-detail layout, a search bar spanning the full width reads as "search
  this screen" while it only ever filters the left column. Constrain it — and
  its divider — to the column it acts on.

**One chrome band per region of content.** Everything that is chrome for the
same content shares a row: status on the left, controls on the right. Reaching
for a second band means asking which band the new control belongs in, not where
to put the new band.

**The door surface** — a full-page surface that takes over the content region
(Automations, Design, Plugins, Skills, the Extensions home) — has
an anatomy too, and it has exactly one band of chrome:

1. **The app's top strip is the door's title bar.** The door's name and its
   controls ride the strip that is already there. A door that draws its own
   title row puts two title bars on one screen, with the first one empty.
2. **The name sits on the content gutter (20px).** The title, the leading edge
   of the tab row under it, and the canvas body share one vertical line. A title
   inset to the window chrome's 6px hangs off the left edge of its own page.
3. **The bar is the name and the controls, nothing else.** No status chip, no
   counts line: the page under the bar already shows its own state, and the rail
   row that opened the door already carries its glyph.
4. **Nothing stacks between the bar and the content.** A status sentence or a
   tools row under the strip is the second band this anatomy exists to prevent —
   the controls belong in the strip, and a status belongs to the thing that has
   it. A notice about the content (a stale change, a failed run) is not chrome
   and keeps its own band.

**Surfaces, not modals** (ruled 2026-09-05, reversing the doors→modals ruling
of 2026-09-01). A destination the shell's own chrome offers — anything an app
rail square or a sidebar drawer row opens — is a DOOR: it takes the card region
and owns the top row above it. Automations, Design, Plugins, Skills and the
Extensions home are doors (Agent CLIs was one until 2026-09-25, when the owner
moved the list to Settings ▸ Agents). They spent four days as modals, and the
modal was wrong for them twice over: a scrim put a dialog between the person
and the very column they had just navigated with, and a float over the card
region means back, forward and the window's history all step to a destination
that mounts invisibly behind it.

What stays a modal is the shape a modal is actually for — a **pick-and-close
task floated over work that stays put**, reached from inside that work rather
than from the chrome:

- **Settings.** Opened from the rail's foot, changed and dismissed; the
  workspace behind it is the thing being configured and must stay visible.
- **The Diff popout.** The pane's own Diff tab grown to workbench width, opened
  from the pane strip. Routing the region would hide the layout it is a bigger
  view OF.
- **Reviews.** A walkthrough is Monaco beside a transcript; the pane column is
  too narrow to read it in, so picking it there floats the surface instead of
  opening a pane tab.

Three tests, all of which a modal must pass. A destination that fails any of
them is a door.

1. **The thing underneath is still the subject.** The workspace being
   configured, the layout the diff is a bigger view of, the change being
   reviewed. If the surface replaces the subject rather than acting on it, it
   wants the region, not a scrim.
2. **Nothing that names a PLACE leads to it.** No section glyph, no drawer row,
   no history entry — a destination reached by navigation has to be somewhere
   the region can go, or back and forward step to a page that mounts invisibly
   behind the scrim. Note the test is about naming a place, not about being
   chrome: Settings is opened from the rail's FOOT, and the foot is deliberately
   not navigation — the account and the gear belong to the window rather than to
   any section of the product, so they route nothing and no history entry
   records them.
3. **It is a task with an end.** Opened, done, dismissed. A surface a person
   navigates around inside, or comes back to and expects to find as they left
   it, is a place, and places are doors.

**A heading must separate something from something else.** Do not label an
ungrouped list ("Skills" over a field that already reads "Search skills…"),
and do not render a group heading when there is only one group — "Recent"
spanning every row groups nothing. Headings appear when there are at least two
groups to tell apart; the list's accessible name carries the label otherwise.

**The app rail** (ruled 2026-09-05; glyphs-only and then three-glyph, same day)
— the window's far-left column of glyphs — is chrome, not a rail in the context-rail sense. It names AREAS of the
product (Home, Extensions) and holds its one standing tool (Automations), never
things inside an area; the sidebar column beside it lists the things, and a
drilled-in surface still replaces that column's content rather than standing
beside it. "One rail, ever" is unchanged: the app rail holds no list a person
walks. Its anatomy:

1. **A fixed set of glyphs on `size.control.lg` squares, no captions.** A
   house and a tile grid do not need "Home" and "Extensions" written under
   them, and the caption is what made the first cut 76px wide. The name is the
   glyph's tooltip and accessible name — the idiom the sidebar's collapsed
   rows already use. The column is one square plus a `space.sm` gutter each
   side: 56px, and no wider. (Revised 2026-09-07 from `control.md` squares in
   a 46px column: the rail squares are a step above the largest in-panel
   control, and that step is what lets the column be found from across the
   window rather than read. `size.control.lg` exists for this column and
   nothing else; the glyphs on it are `icon.size.lg`.)
2. **Selection is `bg.selected` on the square.** Never the accent, never a
   bar on the window's edge. A section glyph is current while its column
   shows; a tool glyph is pressed while its surface floats. The two can light
   together, and they say different things.
3. **Three glyphs: Home, Automations, Extensions.** Automations stands on the
   rail because it is what the product DOES, not something added to it; it is
   the module's own registered surface, gated on the module's enablement, so a
   turned-off module's glyph is simply absent. Plugins does not: it is one of
   the product things under Extensions, and a glyph of its own said it stood
   beside them.
4. **Extensions opens its home, and the sidebar becomes the drawer.** The
   drawer starts with three product rows in a fixed order — Design, Plugins,
   Skills — and installed module doors follow in stable registry order, all
   with the same `SidebarNavButton` chrome. (Agent CLIs was a fourth until
   2026-09-25: the owner moved agent CLIs to Settings ▸ Agents, which already
   listed every CLI per machine.) Registry `order` never moves the product rows; an installed door contributes its
   name, glyph and behaviour, then takes the next available place. The drawer
   STAYS PUT while the card region swaps, which is what makes it the navigation
   rather than a menu:
   a door that is one of its rows renders its own rail beside its canvas
   instead of taking the column. Only Automations replaces it for the length of
   its visit — and it is not a drawer row at all, because the automations it
   lists ARE the navigation while it is open.
   **Add extension leads the drawer.** It is the dashed add-row used by the
   other door rails, opening the native folder chooser for an installable module
   directory. Selection runs through the same validation, copying, signature,
   and trust workflow as Settings → Modules, then opens that settings page for
   access review; choosing a folder never silently grants trust.
   A drawer row reads `aria-current` while its page is showing (it is
   navigation, exactly like a workspace row); the rail's square reads
   `aria-pressed`. Two honest readings of one state — what would be wrong is
   one row of the drawer disagreeing with the row above it.
   **The home is those same rows, said again as tiles** — glyph, name, a
   one-line summary, a live count, a chevron — resolved from the one function
   the drawer's rows are resolved by, so a tile cannot open something its row
   does not, and a module that is off takes both away together. A count on a
   tile is LIVE or ABSENT: a number nobody has measured yet is no line at all,
   and a number that really is nothing is words ("No runs", "None installed"),
   because "0 running" reads as a counter that has not started rather than as
   an answer. No module list on the page: those switches live in Settings →
   Modules, and one choice in two shapes on two surfaces is two things to keep
   in agreement.
5. **The account and Settings cluster pins to its foot.** They belong to the
   window, not to whichever section the sidebar is showing. They sit on the
   same `control.lg` squares as the sections, and no rule separates them from
   the glyphs above: the rail is one column from its first square to its
   last, and the space does the separating (*Hairlines carry the structure*).
   The sidebar's chrome makes the same call — no rule under New chat.
6. **Its top reserves the title strip's height** on every platform, so its
   first glyph sits below the chrome row beside it. On macOS the native
   traffic lights start in that reserve and run past the rail's edge; the
   sidebar's chrome row insets for the remainder.
7. **The divider starts below that reserve, never at the top.** The rail's
   right-hand hairline is a positioned strip from the title row down, not a
   full-height `border-r`: the traffic lights are wider than the rail, so an
   edge that ran the whole height drew a line straight through the green light.
   Across the title row the rail and the chrome beside it are one unbroken
   band.
8. **A square with news wears the badge's corner count** (2026-09-07) — an
   unread activity count. Home counts chats wanting you (blocked on a prompt, crashed, or
   finished while you were away) other than the one on screen; Automations
   counts scheduled runs that ended while its door was closed; Extensions
   counts unread news from anything under it, cards published since its home
   was last open, and an installed door's items waiting on an answer. The tone
   is the loudest thing counted — danger, then warn, then good or the accent. A
   thing still waiting on the person stays counted. Never a toast: a glass card for every
   chat that finished would be over the top, and the count is what says "come
   back here" without interrupting.
9. **Each product drawer row wears its own count, and the square is their sum**
   (2026-09-08). The Extensions square used to read everything under it the
   moment the section opened, and the drawer that appeared said nothing about
   which row the news belonged to — a count that vanished on the click it
   asked for. Now the news goes on the row it came from: a source drift notice
   on Plugins, a run waiting on an answer on the
   door that lists it, entries arrived since the bundle was last shown on
   Design. Installed module rows carry no inferred count: a module owns its
   status inside its door until it contributes a notification contract. A
   counted row draws the same corner counter — trailing when the column is
   expanded, docked on the icon when collapsed — in place of any status mark it
   would otherwise wear (one status idiom per surface), with the row's name in
   its accessible name. Opening a ROW reads its news; opening the section reads
   nothing, and the square keeps counting while the drawer is on screen, the
   way a workspace icon does above its unread channels. The one thing the
   square counts that no row wears is the hosted cards: the square's own
   click opens the home that shows them, so the square is their row. The home
   reads its own cards as it mounts, and marks the ones that were new with
   the New mark, so what the count pointed at is still on screen when the
   person arrives.
10. **The Settings gear counts the updates waiting inside Settings** (owner
   ruling 2026-09-25): an agent CLI behind its release, and a newer
   SprintEngine Studio. The same corner counter, and the same count follows the
   person in — onto General or Agents in the Settings nav, onto the machine's
   segment on the Agents switcher, and beside the CLI row's Update button (the
   badge entry, "In Settings"). Unlike news, opening Settings reads nothing: an
   update is not seen by being looked at, it is answered — installed, or
   dismissed from its toast for that version.

**A dialog is header, content, actions — separated by space.** No rule under the
title, none above the buttons. See *Hairlines carry the structure*.

## Status is earned

- Status reads by **shape first, color second** — every state survives
  grayscale. Healthy, done, and idle render no mark at all.
- One status idiom per surface. A status mark or a lifecycle glyph — never a
  mark and a tinted pill saying the same thing.
- **No status dots, anywhere** (owner ruling 2026-09-28). A 6px disc has no
  shape, so every tone was the same circle and "working" read like
  "waiting". A state is a word, a timer or a shape-coded glyph in its tone's
  ink (`status-dot`); something running right now is the working mark
  (`liveness`), the one "working" mark every surface shares, or a spawned
  agent's character (`agent-glyph`).
  One exception: an MCP server's connection in the composer's Skills & MCPs
  picker is a dot beside the server's name (owner ruling 2026-10-09) — filled
  green connected, amber needs sign-in, red failed, grey connecting, and a
  hollow ring disabled — with the state's word as its accessible name and
  tooltip. A list of servers is scanned down its names for the one that is not
  connected, and the dot is the mark that sits in that column.
- A status is never text-only with no glyph, nor glyph-only with no accessible
  name.
- The accent green (forest) and the success green (bright emerald) are held
  apart by brightness and saturation. Never retune one toward the other.

## Chart colour

A chart that tells series apart by colour takes `color.chart.1` … `color.chart.8`
(`--sem-color-chart-*`; modules read them as `--chart-1` … `--chart-8`), and
the folded remainder takes `color.chart.other`, a neutral grey.

- **Ordered, never cycled.** Series N takes slot N, and the order is the
  colour-vision safety: each slot was placed so its neighbours stay apart under
  protanopia and deuteranopia (worst adjacent pair ΔE 13.1 light, 12.1 dark,
  OKLab ×100; 18 or more for normal vision). A ninth series is never a
  generated hue — fold the tail into "Other" (`chart.other`) or split the
  chart. A scatter, a map or small multiples, where any two series can sit
  side by side, holds three series; the first three slots are validated
  against each other, all pairs, in both modes.
- **Colour follows the entity, never its rank.** A filter that removes a
  series does not repaint the ones that remain.
- **Never status.** The eight are a data palette, not tones. A series that
  MEANS good or bad (pass/fail, an error rate) wears `status.*` with its word,
  and never sits in the same chart as a categorical series. The eight are held
  away from the good, warn and danger tones on purpose; do not borrow a status
  tone as "series 4".
- **Contrast.** Every slot clears 3:1 against `bg.surface` on every theme of
  its mode — white, paper and the cream themes in light, every dark surface in
  dark — so a mark reads without a hairline around it. Values, labels and
  legends stay in text ink; the colour beside them carries identity.
- **A legend for two or more series**, and direct labels where there are four
  or fewer, so a series is never identified by colour alone.

## Motion

- One easing curve (`motion.ease.standard`) and three durations. Hover and
  focus at `fast`, popovers at `normal`, drawers at `deliberate`.
- **Three eased motions, and that is the whole set:** the switch thumb as it
  crosses its track, the hover/press response every interactive surface shares,
  and a popover's entrance. A surface picks one of the three; it does not
  declare its own transition. A fourth is a system change, argued here first —
  and a per-component `transition` restating a duration the tokens already name
  is the tell that one was added by accident. An entrance a *pattern* owns (a
  rail swapping its contents) is not a fourth motion: it composes the same
  duration and easing pair rather than introducing a curve of its own.
- Motion means one of two things: *alive right now* (a working mark, a
  running agent's character, a spinner) or *just changed* (a reorder, a
  just-moved flash). It may carry a little personality while it says so
  (ruling 2026-09-28): a working mark picks one of four patterns, and a spawned
  agent is a small character that moves while it works. What never moves is
  something at rest — ambient decoration on an idle surface is noise.
- Motion is never the sole signal of a state change — the accessible name and
  the visible label carry it too.
- Every animation honors `prefers-reduced-motion: reduce`, including the
  `:active` press scale.
- Never put `backdrop-filter` on a full-viewport scrim over a terminal;
  separation comes from `overlay.scrim` plus the shell's shadow. The one
  blurred scrim is the command palette's, over a conversation with no terminal
  in view (2026-10-21). Glass is a material of four kit
  shells and nothing else, pinned there by the conformance lint: the toast
  card (ruling 2026-09-04, a corner-sized blur), the popover family's opt-in
  `material="glass"` (2026-09-07/08), and the command palette's shell
  (2026-09-10) — the last affordable only because the palette pauses terminal
  repaints while it is up, so the blur beneath it is computed once. The
  scrims behind all of them stay plain tones, but for that one.

## Accessibility

A gate, not a preference. No design system supplies it for you.

- WCAG 2.1 AA, semantic HTML, and full keyboard operation on every surface.
- Body text clears AA on its own surface. `text.subtle` and `text.disabled`
  never carry actionable copy alone. The ink ramp orders identically in both
  modes — `default` darker than `muted` darker than `subtle` darker than
  `disabled` — so a token means the same thing in either theme.
- Visible focus on everything focusable, in a sensible order, never removed.
- Status conveyed by shape or label, never by color alone.
- Real labels on controls; `aria-label` on every icon-only button. Icons that
  duplicate adjacent text are `aria-hidden`.
- Overlays: Escape closes the topmost surface only, focus is restored to the
  trigger, and a modal traps focus while open.
- Design the states, not the happy path. Every data surface distinguishes
  populated, empty, loading, error, unavailable, and permission-denied. A
  failed dependency must never render identically to an empty list.

## Modes

- Light and dark ship from the same semantic tokens. Consumers style with
  `--sem-*` only and never write a per-mode override.
- Dark surfaces are neutral to slightly warm. Blue-shifted darks (`#0a0d18`,
  `#0c1020`) read as generated-dashboard defaults and are out.
- Dark values keep the anti-dither discipline: solid channel values, no pure
  black surfaces.

## Window material

The window's chrome — the app rail, the sidebar's chrome row, the 36px title
band, the aside column — stands on one ground, and the person picks what that
ground is made of. It is a second appearance axis beside the theme: every
material works over every theme and both modes, because each is derived from
the active theme's own `bg.app` and `accent.primary` rather than from colours
of its own. Cards and panels never take part; they stay opaque on top of
whichever ground is chosen, so a material is only ever seen in the chrome.

- **Glass** — the default on macOS. The window is transparent over the OS's
  own vibrancy, and the theme's `bg.app` is laid over the frost once, at half
  strength. The OS composites the frost from what is behind the window, never
  from our content, so it costs nothing per frame. It is not available where
  the OS has no vibrancy.
- **Tinted** — the default on Windows and Linux, and an option on macOS for
  anyone who would rather not have glass (owner ruling 2026-09-24). An opaque
  window with a hint of colour on its ground — read as a tint of the chrome,
  never as a glow:
  - *The ambient wash.* One very large, heavily feathered radial wash on the
    window ground, centred on the top-left corner where the rail and the title
    band meet: `text.primary` over `bg.app` at `tinted.wash` at its heart,
    fading to plain `bg.app` across a large part of the window. Its colour is
    the ink of what stands on it — the rail's glyphs and the chrome's text —
    so on a dark theme it is a faint lift of the foreground, and on a light one
    a faint shade of it.
- **Solid** — the plain opaque `bg.app` ground, with no wash.

The rules that keep Tinted honest:

- **Ambient, never per control** (owner ruling 2026-09-24). No rail button,
  and no other control, wears a glow, a halo or a tile of its own; each looks
  exactly as it does on Solid, in its own box. A glow per rail button was
  tried first and read as a square with a coloured halo round every one of
  them. Selection stays the neutral `bg.selected` fill.
  The nightly build's night tile behind the rail's brand monogram is not the
  material: it is the nightly application icon's own ground, the same on every
  material, theme and mode.
- **The colour follows what it sits behind.** The foreground under the
  foreground, and never the accent. A wash of a colour that nothing on it is
  drawn in reads as a light shining on the chrome.
- **No edge anywhere.** Every wash falls off on a smooth curve (a raised
  cosine, many stops) rather than a few linear stops, so there is no ring, rim
  or band at any stop and nothing is clipped at a box's edge: each wash has
  reached zero before its own box ends. The strengths are small enough that the
  ground moves by about one 8-bit step per tens of pixels, which is also why it
  does not band at 125% or 150% display scaling.
- **Static.** No `backdrop-filter`, no animation, no per-frame blending. The
  washes are rasterised once and repaint only when the window resizes, which is
  why this is the material for machines with no vibrancy.
- **The cards stay raised.** At its heart the ambient wash lifts `bg.app` by
  less than the step between the ground and the cards, so on a dark theme a
  card still reads as standing above the chrome rather than sunk into it.
- **Contrast holds.** The ambient wash moves `bg.app` by one or two hundredths
  of the foreground at its strongest, far below what would take the chrome's text
  or the rail's glyphs out of AA on their ground in either mode.
- **The chrome's fills tint, they do not cover.** On both glass and tinted the
  canvas layers go see-through and the ground is painted once, so a hovered or
  selected row in the rail is a translucent step over the ground rather than an
  opaque slab laid on it — the same rule, for the same reason, on both.
- **The window opens on its own ground.** An opaque material's window is
  created with the theme's `bg.app` as its background colour, so the frames
  before the renderer paints are already the right colour and a light theme
  never flashes dark.
- The strengths are the `sem.tinted.*` tokens, with their own light and dark
  values; a consumer never writes a per-mode override for them.

## Tokens or nothing

- Never hard-code a color, space, size, radius, duration, or z-index the system
  defines. Pick by the token's documented `role` and `use`, not by its looks.
- The `--ref-*` tier is internal plumbing for the token file. Components and
  patterns consume `--sem-*` only.
- Layering comes from `sem.z.*`. A surface that needs to sit between two
  defined layers is the wrong kind of surface. In-flow depth has its own three
  steps below `drawer` — `sticky` (10), `pane` (20, docked panes and in-canvas
  floating chrome) and `float` (30, panel-internal popovers and HUDs) — so a
  bare `z-20` / `z-30` is a hard-coded z-index like any other.

## Reject on sight

Each of these is a restart signal, not a fix-it-later note. Rebuild the
surface rather than patching it.

- Two or more accent hues competing for primary, or an accent used as a
  selection fill.
- More than two radii or more than three font weights in one view.
- A third font family, or a serif anywhere in the product's interface (the
  typeset-content faces listed under Type are the only exception).
- A badge or tinted pill where a status mark carries the same meaning.
- A status dot — a tone-filled disc standing for a state — on any surface.
- A card inside a card with no containment reason.
- A hero composition — oversized headline, decorative blob, three-up stat
  row — inside an operational panel.
- A primary button with a gradient fill of any kind, a drop shadow, a coloured
  glow, or a blurred halo. The one faint lit top edge of
  `shadow.control-raised` is the system's own and is not this; anything past it
  is.
- Depth on a control below tier 1: a lit lip, a drop or a sheen on an outline
  button, a chip, a tile or a trigger, or an inset shadow on press.
- Decorative emoji as iconography, or celebration copy ("✅", "🎉", "Awesome!").
- Placeholder content: "Lorem ipsum", "Card title", "Item 1 / 2 / 3".
- Empty-state copy that explains an obvious interaction ("Click here to
  start"), or marketing copy in operational chrome.
- A subtitle restating the title, a field label restating the dialog title, or
  helper text restating the placeholder.
- The application naming itself in ordinary UI copy.
- A success message that dumps the operation's metadata instead of its result.
- A red "Required" or an asterisk on a field nobody has filled in yet.
- A tone-coloured bar down the left edge of a notice, card, or callout.
- Two stacked bands of chrome above one region of content.
- Dividers separating the sections of a dialog.
- The same count shown in two places where the values could appear to disagree.
- Always-on row actions that should have been revealed on hover — or
  hover-revealed actions with no keyboard path.
