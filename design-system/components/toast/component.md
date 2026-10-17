# Toast

The transient report. A toast announces the result of something the person
just did — or a failure they must not miss — from the viewport's corner,
without taking focus and without asking anything back. It is the answer to
"did it work?" in one line: a count, a name, a state. Extracted from the
source product's `Toast` primitive (`src/renderer/src/components/ui/`).

A toast never carries a question (that is a modal), never carries the only
route to an action (a surface that must be acted on is a banner or an inline
notice, which stay put), and never dumps the operation's inventory — file
counts, hashes, byte sizes are stored, not displayed. The one crack in the
first rule is the answer-in-place variant below, held to a single field and a
persistent surface the request is also readable behind.

## Anatomy

| Part       | Class                                                    | Required                                                                    |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Region     | `.ds-toast-region`                                       | yes — the fixed corner stack at `z.toast`; one per document                 |
| Surface    | `.ds-toast`                                              | yes — `role` and `aria-live` chosen by tone (below)                         |
| Tone mark  | `.ds-toast-mark` + `.ds-status-dot`                      | yes — the tone's status mark (`status-dot`), `aria-hidden`                  |
| Content    | `.ds-toast-content`                                      | yes — title `.ds-toast-title`, optional description `.ds-toast-description` |
| Answer row | `.ds-toast-answer` + `.ds-toast-code` + `.ds-toast-help` | no — the answer-in-place variant's one field and its two answers            |
| Dismiss    | `.ds-toast-dismiss`                                      | no — trailing icon button, `aria-label="Dismiss"`                           |

The surface is **glass** (owner ruling 2026-09-04): `bg.surface-raised` at `glass.opacity` over a `backdrop-filter` of
`glass.blur` and `glass.saturation`, a `border.default` hairline, and
`shadow.toast` drawing the edge over whatever shows through — a 1px lit top
edge (the button's light source) over a lifted drop, so the card reads as
sitting on the page (owner ruling 2026-09-28). Where
`backdrop-filter` is unsupported the card is solid `bg.surface-raised`.

The blur ban (`principles.md`, the modal and drawer specs) exists because a
full-viewport scrim re-samples every terminal pane under it every frame; a
toast's area is a corner, a fraction of that cost.

**Amended 2026-09-07 (owner ruling): two surfaces blur, not one.** The
conversation peek — the hover card that shows what a chat was asked, drawn
deliberately over a running terminal — is the second, through
`PointerPopover`'s opt-in `material="glass"`. It is a larger area than a
toast and this is not pretended otherwise: the ruling accepts that cost for a
surface whose whole point is to sit _over_ the app it is describing, while
the area argument still holds against the thing it was written for, a
full-viewport scrim. **Amended again 2026-09-08:** the trigger-anchored
`Popover` carries the same opt-in, for the composer's skill type-ahead drawn
over the transcript being read — the popover spec's "Material" section had
already ruled glass a material of the whole popover family, and the anchored
shell is that family's engine. **Amended 2026-09-10:** the
[command palette](../command-palette/component.md)'s shell is the fourth,
and the first at dialog scale over the middle of the window where the
terminals are. It is affordable for a reason the earlier three did not have:
the palette holds the terminal repaint pause for its lifetime (the hold
`Modal` takes), so the panes beneath it stop invalidating and the blur is
computed once rather than on every PTY chunk — which is what the ~10fps
measurement actually was. Its scrim stays a plain tone; the area argument
still holds against a full-viewport blur. The conformance lint pins the glass
utility to those four **kit shells** (`Toast.tsx`, `PointerPopover.tsx`,
`Popover.tsx`, `CommandPalette.tsx`); a product file that blurs, or borrows
the utility directly, is still a violation — a surface that wants glass asks
the shell for it.

The tone is carried by the status mark's shape-plus-color and by the words —
never by tinting the surface, and never by a dot: the product draws no status
dots (owner ruling 2026-09-28). A toast that survives greyscale is the test.

## Variants

Five tones, each deciding color, politeness, and persistence:

| Tone        | Mark                                 | Role / live           | Auto-dismiss |
| ----------- | ------------------------------------ | --------------------- | ------------ |
| `--neutral` | ring with a bar, `status.neutral`    | `status` / `polite`   | 5 s          |
| `--good`    | check disc, `status.good`            | `status` / `polite`   | 5 s          |
| `--accent`  | held quarter arc, `accent.primary`   | `status` / `polite`   | 5 s          |
| `--warn`    | ring with "!", `status.warn`         | `alert` / `assertive` | 10 s         |
| `--danger`  | ring with "×", `status.danger`       | `alert` / `assertive` | 10 s         |

**Every tone leaves on its own** (owner ruling 2026-09-28, amending the
earlier never-for-warn-and-danger). A toast is not the state: the
notification bell and the surface behind each report keep what it said, so
a corner of stale cards is furniture, not safety. Warn and danger stay twice
as long as a success, and hovering or focusing any toast holds its clock,
restarting the full duration on leave, so nobody is raced while reading. A
producer that needs a toast to stay says so with `autoDismissMs: false` (the
app-update steps). (The shipped kit names the danger tone `error`; the class
here follows the token grammar, `status.danger`.)

**The action row, five consumers.** Owner ruling 2026-09-04: the CLI-update
toast ("Update available: Codex 0.153.3")
carries `.ds-toast-actions` with **Settings** (ghost) and **Update** (primary),
and `.ds-toast-glyph` — the agent CLI's icon — in place of the tone's mark. It
stays for one minute, not five seconds and not forever (owner ruling
2026-09-18): long enough to reach for Update, short enough that an unasked-for
notice does not sit in the corner until clicked. Missing it loses nothing — the
bell and the Settings row carry the same news. Once Update is pressed the
toast becomes that update's report, and its buttons go with the question
they answered. "Undo" in a toast is still an action on a timer racing its own
dismissal and still belongs where the change is visible; a further consumer of
the action row is a design decision to record here, not a styling choice.

**The action row's second consumer (owner ruling 2026-09-23, amended
2026-09-24).** The app-update toast is one toast, shown again in place at each
step of the update, so the corner always says where the update is:

| Step        | Title                                                                      | Actions                                            |
| ----------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Found       | "SprintEngine Studio 0.7.0 is available" (accent mark)                     | **Later** (ghost), **Download** (primary)          |
| Downloading | "Downloading SprintEngine Studio 0.7.0", the percentage as its description | none                                               |
| Ready       | "SprintEngine Studio 0.7.0 is ready" (good mark)                           | **Later** (ghost), **Restart to update** (primary) |
| Installing  | "Installing update"                                                        | **Restarting…**, busy                              |
| Refused     | "Update not installed", and why (warn mark)                                | **Later** (ghost), **Restart to update** (primary) |

Nothing downloads until the person presses Download (2026-09-24), unless they
turned automatic download on in Settings; then the Found and Downloading steps
are skipped and the toast first appears at Ready. The question is asked where
the person is working rather than behind a trip to Settings. Unlike the
CLI-update toast it stays until answered: it appears once per version, and a
prompt that times out while the person looks away is how an update ends up
found by accident. Later is the dismissal, and loses nothing — a downloaded
update installs at the next quit (except one that needs an administrator, which
says so), and the bell row and the Settings version row still say it is ready.

**The busy action (2026-09-24).** When Restart to update is pressed, the toast
turns into the Installing step before the app does anything else, and its one
button stays: disabled, `aria-busy`, with the [spinner](../spinner/component.md)
beside its label. It is the answer to "did the press go through?" for the few
seconds before the update's progress window takes over, and the one place in a
toast a spinner may appear: the process it marks is live, named, and the one
the person just started. At the start after an update the toast reports how it
went — "Updated to SprintEngine Studio 0.7.0" (good) or "Update to 0.7.0 did
not install" (warn, with the reason) — without buttons.
These two were the only toasts with buttons until the third below.

**The action row's third consumer (2026-10-07).** ⌘⏎ in New chat starts the
chat without opening it, and says so: "Started in the background" (good mark),
the chat's name as its description, and one **Open** (primary). It is a
polite report on the tone's own timer; a second ⌘⏎ replaces it in place, so
Open always means the latest. Open is not the only way there — the chat's row
is in the sidebar the moment it starts — and missing the toast loses nothing,
which is what lets an action ride a timer here. Pressing it takes the toast
down and goes to the chat as a click on its row does.

**The action row's fourth consumer (2026-10-09).** An installed extension's
`RendererHost.toast({ tone, message, detail?, action? })`. The extension's
message is the title; its description always leads with the extension's name,
stamped by the host, so an extension's toast can never pass for the app's own.
It may carry one button, never primary: an extension's toast is a report with a
way onward ("Skill installed in acme/app", **Open**), not a question the app is
asking. It runs on its tone's own timer like every report, pressing the button
takes the toast down first, and the SDK documents that anything the person must
find again belongs in the bell, so missing one loses nothing.

**The action row's fifth consumer (2026-10-17).** ⌘S in a composer sets the
draft aside in the prompt stash and clears the box, and says so: "Prompt
stashed" (good mark), "⌘S in an empty box brings it back." as its
description, and one **Undo** (ghost). This is the one Undo in a toast, and it
is allowed here for the reason the rule above gives against the others: nothing
rides the timer. The draft is not gone, it is in the stash, one ⌘S and one ↵
away from the same box, so a toast that times out unpressed loses nothing. A
second ⌘S replaces it in place, so Undo always means the latest stash, and the
toast goes when the composer it would undo into does. When the stash could not
be written to the device it says so in the description (warn mark) and keeps
its Undo. These five are the only toasts in the system with buttons.

**In a browser tab (2026-10-03).** A web tab has no installer: the server it
talks to is updated, and the tab is a reload away from the new version. So the
app-update toast there has one step, shown when the tab finds the server
serving a newer bundle than the one it loaded: "Studio was updated" (good
mark), "Reload this tab to use the new version. Until then it keeps working as
it is." with **Later** (ghost) and **Reload** (primary). It is the same
consumer in its browser form, not a third, and like the desktop's it stays
until answered, once per new bundle.

**Dismissing an update is "not now" (owner ruling 2026-09-25).** Each outstanding
update also wears a count on the Settings gear and inside Settings (the
[badge](../badge/component.md) entry, "In Settings"). Later, and the dismiss
button on either update toast, are the person saying "not now" to that version,
so they clear its badges; the toast's producer hears the press
(`onDismissPressed` in the kit's store) and records the dismissal. For the
app update the dismissal names the step as well: waving off Found does not
silence Ready when the download lands, which is news of its own; and closing
the Downloading step only hides it, since the person asked for that download. The CLI
toast's one-minute timer is **not** a dismissal — nobody pressed anything, and
the badges stay until the update is installed or dismissed. Going to Settings
from the toast is not one either: it is going to look.

**The answer-in-place row, one consumer.** Owner ruling 2026-09-05: the
incoming pair-request toast carries `.ds-toast-answer` — a six-digit
`.ds-input`, then Decline (ghost) and Allow (primary) — with `.ds-toast-help`
under it holding the instruction, or the refusal in `status.danger` ink. It is
the one toast in the system with a field, and it earns it: the answer IS six
digits, read off the screen of the machine asking to pair, and every other
route to typing them (a popover, a settings tab) walks the person away from
the screen they are reading. The toast times out like any warn, but focus in
the code field holds its clock — a surface holding a half-typed code that
vanishes on a timer is worse than no surface — and the request stays
answerable on its own persistent card, so a toast that left loses nothing. Everything the field cannot express stays on that card:
this variant grants the request's DEFAULT authority and nothing a checkbox
would have chosen. A second consumer, or a second field, is a modal.

## States

| State       | Treatment                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entering    | An 8px rise-and-fade at `motion.duration.normal` / `motion.ease.standard` — a _just-changed_ motion composing the sanctioned pair, removed under reduced motion |
| Resting     | Static; no pulse, no progress ring counting down the dismissal                                                                                                  |
| Busy action | The app-update toast only: its pressed button disabled with a spinner while the work it started runs (above)                                                    |
| Dismissed   | Removed. No exit animation: leaving quietly is the whole job                                                                                                    |

## Usage

**One region, one corner.** All toasts stack in a single `.ds-toast-region`
— bottom-trailing, newest at the bottom, `space.sm` apart. Two corners
announcing at once is two voices; route every producer through the one
region.

The region is shipped as **`ToastRegion`**
(`src/renderer/src/components/ui/ToastRegion.tsx`) — mounted once per document,
reading the toast store every producer writes to, and rendering nothing at all
when the store is empty. Three properties are the component rather than the
consumer's business, and a rebuild keeps all three:

- **It draws nothing.** No surface, no ground, no border, no elevation. The
  card is the glass; the region is a `role="presentation"` stack.
- **It swallows no clicks.** The stack is `pointer-events: none` and each toast
  surface reclaims its own, so an empty or animating region never blocks the
  pane under that corner — a fixed transparent box over the app is a dead zone
  nobody can see.
- **It is fixed width.** Every card is the same measure (340px) regardless of
  its content, so a stack of three reads as one column rather than as a ragged
  edge.

**Report the result, not the inventory.** "Automation archived" — not the branch,
the commit count, and the layout the archiver chose. The description line is
for the one fact the person cannot see from where they are (where a file was
written, which workspace adopted the change).

**A toast is not the state.** Whatever it announces must also be readable
somewhere persistent — the row's status, the detail pane. A person who missed
the toast lost nothing they cannot find.

**The dismiss affordance is optional on polite tones, mandatory on
persistent ones.** A toast that never auto-dismisses without a dismiss button
is a squatter.

**Rebuilding it in a framework:** what must survive is the tone table — the
role/live/persistence mapping is the component's actual contract — plus the
single region, the hit-target floor on the dismiss button, and the glass
staying the toast's alone.

## Accessibility

- Politeness follows severity: `role="status"` + `aria-live="polite"` for
  neutral, good, and accent; `role="alert"` + `aria-live="assertive"` for
  warn and danger. A success must not interrupt; a failure must.
- A toast **never takes focus**. Announcement is the live region's job;
  stealing focus from the person's task to report on it is the interruption
  the polite/assertive split exists to avoid.
- The mark is `aria-hidden`; the words carry the tone for a screen reader,
  and shape-plus-color carries it visually — never color alone.
- The dismiss button carries `aria-label="Dismiss"` and pads its 10px glyph
  out to `size.hit-target-min` with a transparent hit area — the glyph
  shrinks, the target does not.
- The entrance animation honours `prefers-reduced-motion: reduce`.
- Every toast holds its clock while hovered or focused, so an assistive-tech user navigating into
  one is never raced by a timer.

## Known drift

None. Both entries that stood here were spent on 2026-08-05 (the menu-row sweep):

- The dismiss target was 20px, under `--sem-size-hit-target-min`. `Toast.tsx`
  now takes its floor from that token directly, keeping the 10px glyph and the
  flow advance the smaller target had.
- The placement note pointed at the overlay-geometry sweep, which had already shipped.

_2026-09-05:_ the answer-in-place variant, above, was ruled and consumed in
the same breath — the remote epic's pair-request toast stopped pointing at the
Remote glyph and started taking the code. Its `content` slot is one rendered
body between the description and the action row; the shipped kit's store
documents the same single-consumer rule the action row carries.

_2026-09-04:_ the corner region is consumed. The remote-sessions-ux epic's
`toast-host-region` child shipped `.ds-toast-region`'s product counterpart —
one bottom-trailing stack at `z.toast`, newest at the bottom, `space.sm`
apart — and every producer (pair requests, remote-create failures, stranded
attachments) routes through it. The older in-flow toast host at the top of a
scrolling pane remains where a toast belongs to the panel that produced it;
it stacks nothing and is not the region.
