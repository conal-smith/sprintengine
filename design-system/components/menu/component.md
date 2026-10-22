# Menu

A list of actions, summoned onto a popover surface. Right-click a row, press a
kebab, or open a narrowing glyph: whichever way it was asked for, what appears
is this.

Use a menu when the list is *actions*. Use [select](../select/component.md) when
it is a value being chosen — including when that value has to be filtered for —
and the detail pane when the answer is something to read rather than something
to do.

## Why this spec exists

The system shipped three menus and no spec, so each host answered the same
questions alone — and a row could be right-clicked and kebab-pressed into two
menus that disagreed about radius, border, ground, item type, hover shape and
divider colour. `OverflowMenu.tsx:200` admitted the split in a comment.

Measured 2026-08-05, before this ruling:

| | ContextMenu | OverflowMenu | FilterMenu |
|---|---|---|---|
| Surface radius | 6px | 7px (popover) | 7px (popover) |
| Surface border | `border.default` | `border.strong` | `border.strong` |
| Surface ground | `bg.surface` | `bg.surface-raised` | `bg.surface-raised` |
| Item type | body (13px) | meta (12px) | meta (12px) |
| Hover fill | inset, 4px radius | full-bleed | full-bleed |
| Divider | `border.subtle` | `border.default` | `border.subtle` |

## The rulings

Decided by what the rest of the system already does, not by counting.

**Surface: the popover shell, unchanged.** `popover/` is already the
anchored-overlay engine, and its own CSS says it carries no padding *"because a
menu wants full-bleed rows"* — the shell was written expecting this component.
ContextMenu is the outlier, and the only thing that actually distinguishes it is
that it positions at a **pointer** rather than an anchor. That is a positioning
difference. Nothing about a right-click justifies a different radius, border or
ground, and a person who opens the same actions two ways should not be able to
tell which way they used.

**Item type: `meta` (12px).** A menu item is chrome — it names an action; it is
not prose. At 13px a menu row also sits *above* the 12px list rows it was
usually summoned from, which reads as the menu mattering more than the thing it
acts on.

**Hover fill: full-bleed, no per-item radius.** An inset rounded fill inside a
padded surface reads as a card nested inside a card. Every other row list in the
system — `list-surface`, `context-rail`, `inbox-row` — fills to its own inset
instead, and a menu is a row list.

**Divider: `border.subtle`.** Inside an already-bordered surface a divider
separates siblings; at `border.default` it competes with the surface's own edge
and the menu reads as two stacked panels.

**Hover and keyboard highlight are one state.** A menu is walked with the arrow
keys as often as with the pointer, and "the row about to be activated" is one
idea. Two highlights for it is the same class of split this spec closes.

**Casing: sentence case, including a menu that stays native.** The product's
`principles.md` rule — *"sentence case everywhere except real keyboard
shortcuts"* — is a rule about the product's voice, so it does not stop at the
edge of a surface the OS draws. macOS conventionally Title-Cases its menus, and
that convention loses here: a native menu borrows the OS's metrics and
rendering, never its wording. "Close other editor tabs", not "Close Other
Editor Tabs". Keys stay keys. Which hosts may stay native at all is a separate
question, ruled per host under [native menus](#native-menus--the-per-host-ruling)
— where the single exception, the OS application menu bar, is also ruled.

### Why the losing values lost

- **13px items** — retired above: chrome, not prose.
- **6px radius** (`rounded-md`) — a radius off-ramp, and one step off the
  `radius.overlay` every other floating surface in the product uses. A menu is
  not a shape of its own.
- **`border.default` on `bg.surface`** — ContextMenu's border/ground pair
  described a *flat* surface. It floats, and floating chrome is already ruled:
  the popover shell's `border.strong` on `bg.surface-raised`. The weaker border
  on the lower ground made the same menu read as nearer the page when opened by
  right-click than when opened by kebab.
- **`border.default` dividers** — retired above, for `border.subtle`.
- **The inset rounded hover fill** — retired above, for full-bleed.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Surface | `.ds-popover` | yes — the shared shell, `role="menu"` |
| List | `.ds-menu` | yes — vertical padding only, so rows reach both edges |
| Item | `.ds-menu-item` | yes — `role="menuitem"` (or `menuitemradio` / `menuitemcheckbox`) |
| Leading slot | `.ds-menu-item-glyph` | all items in a menu, or none |
| Trailing hint | `.ds-menu-item-hint` | no — a shortcut, or a submenu chevron |
| Separator | `.ds-menu-separator` | no — `role="separator"` |
| Group label | `.ds-menu-group-label` | no — the alternative to a separator, not an addition |

The **leading slot is all-or-nothing per menu**. Give every item a glyph or give
none of them one: a menu where only some rows carry one ladders its own labels,
and the reader's eye loses the left edge it was tracking. Where a menu is
genuinely mixed, render the empty slot on the rows without a glyph rather than
letting their labels slide left.

## Surface

| Property | Token | Value |
|---|---|---|
| Radius | `radius.overlay` | 7px |
| Border | `border.strong` | 1px |
| Ground | `bg.surface-raised` | |
| Shadow | `shadow.popover` | |
| Padding | `space.2xs` vertical, none horizontal | 4px / 0 |
| Layer | `z.popover`, or `z.menu` when pointer-positioned | 80 / 90 |

The horizontal zero is the load-bearing part: it is what makes rows full-bleed,
and it is what an inset fill needs in order to look wrong.

A pointer-positioned menu sits one tier up, at `z.menu`, because it is summoned
*over* whatever is already open — including an open popover. **So does a menu
opened from INSIDE a surface already on that tier** — a menu on a hover card's
head line — for the same reason read the other way round: at the popover tier it
would paint underneath the card that opened it, which is not a menu at all.

## Item

| Property | Token | Value |
|---|---|---|
| Type | `font.size.meta` | 12px |
| Padding | `space.xs` vertical, `space.md` horizontal | 6px / 10px |
| Gap | `space.sm` | 8px |
| Radius | none | full-bleed |

Vertical padding (6px) is deliberately what the three menus already agreed on
before this spec. A spec that moves values which were never divergent is a spec
nobody can adopt cheaply.

**The size travels with the item, never with the host.** A host that sets the
type size on the surface — including the surface of a submenu it opens — is
rebuilding the drift this spec closed.

### The stacked item

There is **one** second row shape, and it exists for a picker whose entries
carry a supporting line under the name — a skill and its description, a
connector and what it does. It shares the item's inset, gap, highlight, disabled
state and focus ring, and differs in exactly two ways:

| Property | Stacked item | Why |
|---|---|---|
| Cross-axis alignment | `start`, not `center` | a glyph and a trailing mark belong on the FIRST line; centred, they float against the gap between two |
| Type | none of its own | each line names its own step — `body` for the name, `meta` for the support |

It is a *shape*, not a host's preference, and it is the only one: a menu that
wants a third is a menu asking for a list. Nothing else about it is negotiable,
and no host may reach for `start` alignment itself — an alignment written beside
the item's own is resolved by stylesheet order rather than by the order the
class names appear, so the two shapes have to be two named things.

### The value row

A menu row that shows the **value in force** rather than an action is a species
of its own, and it has its own entry:
[menu-option](../menu-option/component.md). It shares everything here — inset,
gap, alignment rule, highlight, disabled step, inset focus ring, both shapes —
and differs on three things a class cannot carry: the role comes from the caller
(`option` inside a listbox, `radio` inside a radiogroup), selection is a rendered
state with its own fill, and the tab stop is the group's to place.

The mechanical consequence for this spec is one split. The row geometry no
longer bundles the highlight: `MENU_ROW_HOVER_CLASS` is separate, so a selected
row simply **does not receive it**. Writing a second highlight beside the first
to cancel it would be two declarations of one property at equal specificity, and
the shipped code had four hosts that had tried exactly that.

### What a row must pass through

An item that swallows its caller's attributes is not usable outside the menu that
shipped it, and the 2026-09-08 sweep found nine rows that had stayed raw
`<button>` elements for that reason alone — the class reproduced every pixel, and
the component could not take the attribute.

So the item forwards, unchanged:

- **`tabIndex`.** Roving focus is the menu's, so a row is not a tab stop by
  default; a group whose *current value* must be the stop states its own.
- **`data-*`.** A host drives roving focus by querying for its own hook, and its
  tests select on the same one.
- **The click event.** The handler receives it: the Windows/Linux application
  menu positions its native popup from the clicked row's rect, and a handler that
  could not see the event had no way to ask.
- **`aria-expanded`,** for a row that opens a sub-surface rather than committing
  an action. Without it a drill-in row announces as a choice that never takes
  effect.

## Divider

`border.subtle`, 1px, with `space.2xs` (4px) of air above and below. A group
label is the *alternative* to a divider, not an addition to it: one or the other
says "a new group starts here", and both together says it twice.

A group label is `font.size.micro` at `text.subtle`, on the item's own
horizontal inset so the heading and its rows share a left edge — quieter than
the rows, and never bolder. A heading that out-weighs the actions under it is
competing with them.

## Destructive item

Ink, never a fill: `status.danger` on the label (the product aliases it
`--tone-error`), and the same `bg.hover` on hover that every other row gets. A red row among black ones is read before it is aimed
at; a red *block* is read as something that has already happened.

There is no size variant, no tone variant beyond destructive, and no "compact"
menu. A menu that needs to be denser is a menu with too many items in it.

## Row descriptions

A row may carry a description of what it does (`DescribedMenuItem`, and
`MenuFlyoutItem`'s `tooltip`): one or two plain sentences in a
[tooltip](../tooltip/component.md) to the row's right, on the menu's own layer,
opened by hover after a longer delay than a toolbar's (a person runs the
pointer down a menu reading labels) and at once by keyboard focus. It adds to
the label, never replaces it. A flyout row's description gives way while its
flyout is open, which stands where it would. A disabled row says why in its
description on hover, and in its hint for the keyboard, which skips it. A chat
row's right-click menu describes every row (`chatMenuTooltips`), and its test
holds each row to one.

## Keyboard hints

A shortcut hint sits in the trailing slot as **mono `font.size.micro` (11px) at
`text.disabled`** — plain text, not [kbd-chord](../kbd-chord/component.md)
capsules. The chord is the right vocabulary where the shortcut is the subject
(a settings row that lists it, a walkthrough step that teaches it); in a menu it
is a footnote to an action the row already offers, and a line of capsules
out-weighs the label they annotate.

Carry a hint only for a shortcut that **works without the menu open** — the hint
teaches the reader how to skip this menu next time. A key that only works while
the menu is open is menu mechanics, not an accelerator, and belongs in the
keyboard contract below rather than painted onto a row.

Hints are `text.disabled` and right-aligned into a column, so they read as one
quiet annotation rather than as trailing content on each label.

**The slot also carries a non-keyboard annotation**, in exactly the same
treatment: how long ago a row's subject happened, how many of something it
holds — the conversation peek's pull request menu puts each row's age there. It
is the same slot because it is the same job, a footnote to the label that must
not compete with it; it is stated separately because the two are different
promises, and a reader who has learned that this column means "a key you can
press" must not find a date in it without the spec having said so. **One or the
other per row, never both**: two footnotes right-aligned into one column is a
second label.

## Submenu

A flyout item opens a nested menu beside itself. The nested surface is the
same material as its parent — same class, same tokens — and **inherits its type
size**; no host pins it.

**Anchoring.** The flyout opens at the parent item's right edge with a 2px gap,
pulled up by 5px (the surface's 4px vertical padding plus its 1px border) so its
first row top-aligns with the item that opened it. When the viewport is tight on
the right, it flips to open leftward of the item rather than sliding across and
covering the parent menu.

**Opening.** Hovering the trigger, clicking it, or pressing `ArrowRight`,
`Enter`, or `Space`. The trigger keeps the hover highlight while its flyout is
open, so the path back is visible.

**Closing.** `Escape` or `ArrowLeft` closes the flyout and returns focus to the
trigger; the pointer leaving both the trigger and the flyout closes it after a
short grace period, so crossing the gap between them does not dismiss it. A
choice inside the flyout dismisses the whole menu the way any item does — by
the consumer closing it, which is what lets a toggle row leave it open.

**Structure.** The trigger is a `menuitem` with `aria-haspopup="menu"` and
`aria-expanded`, and a trailing chevron. The nested surface is its own `menu`
with its own accessible name and its own roving focus — each surface roves only
its own level. It stays inside the parent menu's DOM so a click in the flyout
reads as a click inside the parent.

**Disabled.** A trigger with nothing to open is disabled like any row — dimmed,
skipped by the arrow keys, its flyout never opening — and says why in the
trailing hint slot, before its chevron, in the hint's own treatment: Export
chat on a chat tab with no message yet reads "No messages yet".

## States

- **Rest** — transparent; the surface is the only ground.
- **Hover / active** (`data-active="true"`) — `bg.hover`, ink lifts to
  `text.primary`. One state for both pointer and keyboard.
- **Focus-visible** — the shared ring, drawn *inset*, because a full-bleed row
  touches the surface border and an outset ring straddles it.
- **Disabled** — the whole row dims to 45% and the cursor says not-allowed. It
  dims rather than re-inking because the row is label *plus* leading glyph plus
  hint, and an ink rule reaches only the label. Kept in the list rather than
  removed: a control that vanishes when unavailable teaches nothing, and the gap
  it leaves moves every row below it.

## Accessibility

- The surface is `role="menu"`; items are `role="menuitem"`, or
  `menuitemradio` / `menuitemcheckbox` when they carry a selected state.
- Focus moves through items with `ArrowUp` / `ArrowDown`, wrapping. `Home` and
  `End` jump to the ends. `Escape` closes the menu and returns focus to the
  trigger that opened it — the menu never leaves focus on `<body>`.
- The trigger carries `aria-haspopup="menu"` and `aria-expanded`.
- A checked item states it with `aria-checked`, not with the tick glyph alone.
- Disabled items carry the `disabled` attribute and are skipped by the arrow
  keys, so the keyboard walk only ever lands on rows that do something. They
  stay visible, and their dimmed state is what says why they were skipped.

## Native menus — the per-host ruling

The product also shipped a third register: **native Electron context menus**,
drawn by the OS through `window.api.showContextMenu`. Four hosts used one, and
after the context-menu sweep none do.

| Host | Ruling |
|---|---|
| Editor (`EditorPanel`) | **In-app.** Monaco's own menu was already off; the native popup only returned a command id, so nothing about the clipboard actions depended on it. In-app, the rows carry the ⌘X/⌘C/⌘V/⌘A hints Monaco already binds — which a native menu built from ids, not roles, could not show. The conversion also found Paste dead: a programmatic `clipboardPasteAction` is refused by Chromium, so the row had never worked under either menu. It reads the clipboard over IPC and applies an edit instead. |
| File tree (`FileExplorer`) | **In-app.** The richest menu in the product, and the one that looked least like it. Its submenu is `MenuFlyoutItem`, its explainer row a disabled `MenuItem`, and Delete is destructive ink for the first time. |
| Git change rows (`GitPanel`) | **In-app.** Two menu systems lived in one panel: change rows opened an OS menu while the log rows beside them opened `OverflowMenu`. |
| Tab strip (`WorkspaceLayout`) | **In-app.** Its colour submenu could only list the seven highlights as Title-Cased rows of their *names*; in-app it is `MenuSwatchRow`, the control the workspace sidebar already used for the same choice. |

**Why none stayed.** A native menu can carry none of this spec: no
`role="menu"`, no Escape-restores-focus, no roving focus, no shortcut column, no
destructive ink, and metrics the OS owns. That is a price worth paying only for
something the DOM cannot do — an OS-level integration, a services menu, a
drag-target the renderer never sees. None of the four needed one. A host that
does may stay native, but it states its reason in this table first; silence is
not a ruling.

**The one native menu that remains is the application MENU BAR**
(`src/main/app-menu.ts`), and it is the exception to the casing rule above. It
is not a product surface: it is the OS's, sitting among every other app's menu
bar, and half its rows are Electron `role:` items — Undo, Cut, Paste, Toggle
Full Screen — whose labels the OS supplies and the app cannot restyle. Sentence
case there would produce a submenu that disagreed with itself. **Title Case in
the menu bar, sentence case in every menu the product draws inside its own
window.**

Held by `ui/accessibility-contracts.test.ts`, which fails on any
`window.api.showContextMenu` call under `src/renderer/src`, and exercised
against the running app — a native menu has no DOM, so a pass that finds
`role="menu"` at each of these four places is proof the conversion is real.

## Retired — reject these on sight

Both shipped, both are named here by where they lived so a reviewer can
recognise them coming back:

1. **Host-pinned item size** — `OverflowMenu.tsx:200` (pre-convergence) passed
   `text-meta` onto the surface of every flyout it opened, with a comment
   explaining that the nested surface's own base class was "the 13px right-click
   idiom". A host that knows it must correct another component's type size is
   evidence the size lives in the wrong place. The size now travels with the
   item; a new pin is a regression, not a fix.
2. **Literal danger hover** — `ui/ContextMenu.tsx:257` (pre-convergence) drew
   the destructive row's hover as `rgba(255, 120, 124, 0.08)`: a raw colour
   invisible to the token system, and a second signal saying what the ink
   already said. Destructive rows hover like every other row.

## Shipped implementation

`src/renderer/src/components/ui/ContextMenu.tsx` (pointer-positioned, and the
`MenuItem` / `MenuDivider` / `MenuFlyoutItem` / `MenuSwatchRow` vocabulary —
`MenuSwatchRow` being the one row that is not a label, a line of colour swatches
for picking a workspace accent without leaving the menu),
`OverflowMenu.tsx` (the kebab), `FilterMenu.tsx` (the narrowing glyph).

**Reconciled 2026-08-05.** `ContextMenu` moved furthest: onto the popover shell
(7px radius, `border.strong`, `bg.surface-raised`), vertical-only padding so its
rows are full-bleed, `meta` items instead of `body`, an inset focus ring, and
the retired hover literal above. `OverflowMenu`'s divider moved from
`border.default` to `border.subtle`. `FilterMenu` already met the spec.

The values then moved out of the components and into one shared class pair,
`ui/menuClasses.ts` — the surface and the item — which is what makes a host
unable to drift: a component that takes `MENU_ITEM_CLASS` gets the size, the
full-bleed geometry, the one highlight state and the inset ring together, and
has nothing left to answer for itself. Every menu host now consumes it, and the
flyout size pin above is gone with it.

`SplitButton`'s alternatives list and `Select`'s listbox belong to the same
family: same chrome, same row geometry, same highlight. A select option keeps
`body` (13px) rather than `meta`, because its popup echoes strings its trigger
is already showing at that size and picking a value must not resize it
([select](../select/component.md)). A menu item has no such at-rest twin, which
is why 12px is right here and not there.

Held by `ui/designSystemAxes.test.ts`, whose menu checks take **this document —
`design-system/components/menu/component.md` — as their source of truth**, and
which compares the three components against each other rather than each against
itself: the divergence only ever existed *between* components, so a
per-component test could not have caught it.

**Reconciled 2026-08-05, again.** The class pair above had converged
the five components the kit owns; every menu row *outside* them was still
hand-rolled — the model picker popover, both in-app menubar fallbacks, the
account menu, the reasoning selector — each with its own inset, its own type
step and no disabled state. Two of them were the same menu drawn at two sizes.
They consume `MENU_ITEM_CLASS` now, their surfaces consume `MENU_LIST_CLASS`
(and so gave up the horizontal padding this spec rules out), and the two picker
popovers that had shipped as byte-identical copies of one hand-rolled row became
the stacked item above. `role="menuitem"` also stopped appearing on things that
are not rows: the notifications popover put it on a report block carrying its own
buttons, and is a `dialog` popover now.

Held additionally by the menu-row rules in
`src/renderer/src/components/ui/designSystemConformance.test.tsx`, which read
the literals a developer types across a directory list that grows as each
surface converges — the earlier sweeps' scoped guards plus an unscoped
"complete" claim are precisely how this tail survived three of them.
