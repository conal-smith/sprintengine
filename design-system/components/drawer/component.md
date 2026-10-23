# Drawer

The overlay for work that needs the page still visible. A drawer slides in
from the right edge, sits over the content on a scrim, and holds a task too
large for a popover but not important enough to stop the page for: a runner's
detail, an active review, an inspector summoned rather than docked. Extracted
from the source product's `Drawer` primitive
(`src/renderer/src/components/ui/`).

Use a modal when the page must actually stop — a drawer that asks a blocking
question is a modal wearing the wrong entrance. Use a **side pane**
(`components/side-pane/`) when the surface should share the page instead of
covering it: a side pane lives in the document flow, separates with a hairline,
and never scrims. The two are different components, not variants — see the
rejected idea below.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Root | `.ds-drawer-root` | yes — fixed, full-viewport, `z.drawer`; carries `data-state` |
| Scrim | `.ds-drawer-scrim` | yes — `overlay.scrim`, `aria-hidden`, fades with the panel; pointer-down closes |
| Panel | `.ds-drawer` | yes — `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the title, `tabindex="-1"`; right-docked, full-height |
| Header | `.ds-drawer-header` | yes — title `.ds-drawer-title` plus the close button, under the drawer's one hairline |
| Body | `.ds-drawer-body` | yes — the scroll container; the header never scrolls away |

The panel sits on `bg.surface`, separated from the page by `shadow.drawer` and
a left hairline of `border.strong` — the elevation ramp's middle step, between
`shadow.popover` and `shadow.modal`. Width is a content measure, not a token:
`360px` default, the panel-aside width; wider is a per-consumer decision, and
the panel never exceeds the viewport.

Unlike a dialog's interior, the header here keeps its hairline: the body
scrolls under it, so the rule is a working edge — the seam between fixed
chrome and moving content — not decoration.

## Variants

None. Side and entrance are fixed: drawers come from the right, because that
is where inspectors live and where the reading eye ends. A bottom sheet or a
left drawer would be a new component argued in the principles first.

**Rejected: side pane as a drawer variant.** The shipped `SidePane` shares
nothing that matters with this component — no portal, no scrim, no shadow, no
focus capture, no `z` layer; it is flex chrome inside the page with a
hairline. Folding it in here would put "overlay" and "in flow" —
opposite answers to the one question that defines this family — behind a
single class. It has its own entry.

## States

| State | `data-state` | Treatment |
|---|---|---|
| Closed | — | Not in the document |
| Entering | `entering` | Panel offscreen (`translate3d(100%,0,0)`), scrim transparent; one frame later flips to open so the transition runs |
| Open | `open` | Panel at rest, scrim at full opacity — both over `motion.duration.deliberate` / `motion.ease.standard`, the drawer's sanctioned pace |
| Closing | `closing` | The same transition reversed; the node leaves the document when the slide ends, with a timeout fallback so a missed event can never wedge the lifecycle. The panel keeps the content of its last open render meanwhile, so a consumer that clears its state in the update that closes the drawer does not flash the cleared state on the way out |

Under `prefers-reduced-motion: reduce` the slide and fade are dropped — the
drawer appears and disappears in place, and closing skips straight to closed.

## Usage

**The body scrolls; the chrome does not.** `overflow` lives on
`.ds-drawer-body` so the title and close affordance stay reachable at any
scroll depth. Page scroll is locked while the drawer is mounted — one scroll
context at a time.

**Three ways out.** Escape, pointer-down on the scrim, the header close
button. A drawer holding unsaved work does not suppress them — it confirms on
the way out instead (with a modal, which is the surface for that question).

**Density relaxes, structure does not.** Body text at `font.size.body`, inset
at `space.lg`, primary actions at `size.control.md`. Inside the drawer the
overlay rules hold: space separates sections, not rules; one primary action.

**Rebuilding it in a framework:** what must survive is the lifecycle state
machine (enter/open/closing with the fallback timer), the focus contract
below, scroll lock, and the reduced-motion path that skips the slide entirely
rather than playing it fast.

## Accessibility

- `role="dialog"`, `aria-modal="true"`, named by its title via
  `aria-labelledby` — the scrim, scroll lock, and focus trap make it modal in
  behaviour, and the ARIA must say what the behaviour does.
- **Focus is trapped while open**: sentinel elements before and after the
  panel wrap Tab and Shift+Tab. When the panel lands open, focus moves into
  it (the panel itself, `tabindex="-1"`, when no control claims it).
- On close, focus returns to the element that opened the drawer — after the
  exit completes, and immediately under reduced motion.
- Escape closes — topmost surface only, so a popover open inside the drawer
  consumes it first.
- The close button's `aria-label` names what it closes ("Close review"), not
  a blanket "Close": several surfaces can be dismissible at once.
- The scrim is `aria-hidden` and carries no `backdrop-filter`.

## Known drift

- ~~`Drawer.tsx` ships `aria-modal="false"` while trapping focus, locking
  scroll, and scrimming — ARIA claiming non-modal on a surface that behaves
  modally. The spec above says `"true"`; rides with the focus/modality work in
  the focus-trap sweep.~~ **Resolved 2026-09-02:** `aria-modal="true"`. It had stayed
  false for a mechanical reason — the drawer's Escape handler yields to any
  `[role="dialog"][aria-modal="true"]`, so declaring itself modal made it
  yield to itself; the yield now excludes the drawer's own panel and anything
  inside it. The same pass replaced `outline-none` on the panel (and on
  `Modal`'s shell) with the inset focus ring, since the shell is the tab stop
  focus lands on when the surface opens, and derived the close control's name
  from the title (`Close <title>`, `closeLabel` to override) per the
  Accessibility section above.
- `Drawer.tsx` fades its scrim over a `duration-200` literal that is on no
  motion token (the ramp is 120/180/260). The spec pairs the scrim with the
  panel at `motion.duration.deliberate`; the literal rides with the overlay-geometry sweep.
- Otherwise the shipped drawer is the family's good citizen: it consumes
  `--shadow-drawer` and `--motion-deliberate` through the token plumbing and
  owns its focus trap.
