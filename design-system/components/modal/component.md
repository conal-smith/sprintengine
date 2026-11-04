# Modal

The one surface allowed to stop the page. A modal takes the keyboard, dims
everything behind a scrim, and holds the floor until the person answers — so
it is spent only on decisions that cannot be deferred and cannot be made in
place: confirming a destruction, naming a thing before it can exist, a task
that must complete or be abandoned. Extracted from the source product's
`Modal` and `ConfirmDialog` primitives (`src/renderer/src/components/ui/`).

Use a popover when the task is anchored to a control and light-dismiss is
acceptable. Use a drawer when the person needs the page visible while they
work. A modal that merely *shows* something — a preview, a detail — is a
drawer wearing a scrim.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Scrim | `.ds-modal-scrim` | yes — `overlay.scrim` at `z.modal`, centring the shell; a pointer-down on it closes |
| Shell | `.ds-modal` | yes — `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the title, `tabindex="-1"` |
| Header | `.ds-modal-header` | yes — title `.ds-modal-title`, optional subtitle `.ds-modal-subtitle`, optional close button; optionally a leading mark `.ds-modal-leading` before the title, for a dialog that opens **on** an item (a skill, a plugin) so it is recognised by the same monogram or icon its row carried — a question has no leading mark |
| Body | `.ds-modal-body` | no — a confirm with a self-explaining title needs none |
| Footer | `.ds-modal-footer` | yes — the actions, right-aligned, built from `ds-button` |

**Header, content, actions — separated by space.** No rule under the title and
none above the buttons: the shell already draws its own edge, and it scrolls as
one piece (`max-height` on the shell, not on the body), so neither rule would
even be a scroll affordance. A divided dialog is on the reject-on-sight list.

The shell sits on `bg.surface` — not `bg.surface-raised` — because the scrim
and `shadow.modal` already do the separating; a tone step on top would be a
third signal for the same fact.

That ruling holds only if `shadow.modal` actually separates in both modes,
and in dark it did not: a black drop shadow over a scrimmed near-black
ground draws nothing, and the `border.subtle` hairline is 6% white — so a
dark-mode shell read as painted on the scrim rather than above it
(remote-sessions-ux, 2026-09-03). The fix lives in the TOKEN, not on any
surface: `shadow.modal`'s dark value now leads with an inset top highlight —
the lit edge, the same trick `shadow.control-raised` already encodes — so
every consumer separates again and the two-signal reasoning above stays
true. No shell may compensate locally with a raised ground or a stronger
border; that would be the third signal this section rules out.

## Geometry

Every floating surface in the product draws from one scale. Shape and
elevation are tokens; width is a content measure, and therefore a **named
scale** rather than a token — a width is chosen for the content it holds, not
composed against by other surfaces.

| Axis | Value |
|---|---|
| Radius | `radius.shell` (12px) for a dialog-scale shell; `radius.overlay` (8px) for the popover family — anchored menus, flyouts, floating cards. Nothing between the two steps. |
| Border | `color.border.subtle`, 1px |
| Elevation | `shadow.modal` for a shell, `shadow.popover` for the popover family, `shadow.drawer` for an edge-docked drawer. Every one of them per-theme; a shell is never shadowless. |
| Inset | `space.3xl` (24px), the step the token's own metadata names as the modal inset |

The width scale, capped at `95vw` throughout:

| Step | Width | For |
|---|---|---|
| `confirm` | 460px | A question with two buttons — it should read in one line |
| `standard` | 560px | The default: a short form, a list of options, a prompt |
| `palette` | 600px | The command palette: a query over a long result list |
| `wide` | 720px | A form needing two columns, or a list beside an editor |
| `workbench` | 1040px | Panes, a rail, a flow the person works inside |

A dialog that wants a sixth width wants one of these five and a shorter
sentence. The shipped scale is `OVERLAY_WIDTH_PX` in
`src/renderer/src/components/ui/tokens.ts`, beside `OVERLAY_SHELL_CLASS` — the
shell chrome above, spelled once — and `Modal` takes a step by name, never a
pixel count.

## Variants

- `.ds-modal--workbench` — the widest step, `1040px`, and the one variant that
  changes the shell's own behaviour: it takes a fixed height and lets its
  interior panes scroll instead of scrolling as one piece. Everything else —
  radius, border, elevation — is unchanged, because a wide surface is not a
  different kind of surface.
- `.ds-modal--confirm` — the two-button question, `460px`. Title, optional one
  or two sentences of body, then exactly **cancel** (`ds-button--ghost`) and
  **confirm** (`ds-button--primary`). The confirm button takes initial focus:
  Enter answers the question the dialog asked.
- **Danger tone** — a destructive confirm swaps the confirm fill to
  `status.danger` with `text.on-accent` ink (the swap `button/component.md`
  already prescribes). The scrim, shell, and title do not turn red: the tone
  lives on the one control that does the damage.
- **Pending** — while the confirmed action runs: both buttons disabled, the
  confirm label swapped for its pending form ("Deleting…"), and every close
  path (Escape, scrim, close button) suppressed, because half-done destruction
  is worse than a short wait.

A prompt (one text field under the title) is a confirm with an input: the
dialog title names what is being asked for, so the field carries **no visible
label** — its accessible name repeats the ask for screen readers — and an
empty required field shows no error; the disabled confirm button already says
"not yet". Validation appears after the first keystroke, never before.

## States

| State | Treatment |
|---|---|
| Closed | Not in the document |
| Open | Scrim plus shell, immediately — a modal has **no entrance animation**: the three sanctioned motions are the switch thumb, hover/press, and a popover's entrance, and an interruption should not also perform one |
| Scrolled | The shell scrolls as one piece at `max-height: 92vh`; header and footer scroll with it |
| Pending (confirm) | Actions disabled, close paths suppressed |

## Usage

**One modal at a time.** A dialog opening a dialog means the first one asked
its question too early. The shipped confirm provider enforces this by
resolving (as cancelled) any confirm still open when the next one is requested.

**Three ways out, all equivalent to cancel.** Escape, a pointer-down on the
scrim, and the header close button all mean "no". The footer's cancel button
is the same answer with a label. Anything destructive therefore only ever
happens through the one explicitly labelled confirm.

**The footer holds two buttons, rarely three.** Cancel then confirm, in that
order, right-aligned. A third action ("Don't save") is the ceiling; a fourth
means the dialog is a form pretending to be a question.

**Copy rules apply with less room to hide.** The title is the question
("Delete workspace?"), sentence case, no terminal narration. The body earns
its place only by carrying a consequence the person cannot see — what will be
lost, what cannot be undone from here. A body restating the title is deleted.

**Rebuilding it in a framework:** what must survive is the focus contract
below, the scrim-press-not-scrim-click distinction (`pointerdown` on the scrim
itself, so a drag that ends outside the shell does not dismiss), and the
pending-state lockout.

## Accessibility

- `role="dialog"` with `aria-modal="true"` and `aria-labelledby` pointing at
  the title. The shell takes `tabindex="-1"` so focus can land on it when the
  content has no obvious first control.
- **Focus is trapped while open.** Tab from the last focusable element wraps
  to the first; Shift+Tab from the first wraps to the last (sentinel elements
  before and after the shell, as the shipped Drawer does). The page behind the
  scrim is never reachable by keyboard while the modal holds the floor.
- Initial focus: the confirm button in a confirm, the input in a prompt, the
  shell itself otherwise. On close, focus returns to the element that opened
  the modal.
- Escape closes — unless a popover is open inside the modal, in which case the
  popover consumes it first: Escape closes the topmost surface only.
- The scrim is `aria-hidden` plumbing, never `backdrop-filter` — separation
  comes from `overlay.scrim` plus `shadow.modal`.

## Shipped implementation

`src/renderer/src/components/ui/Modal.tsx`, with `ConfirmDialog.tsx` as the
`--confirm` variant above: its `title` / `body` / `confirmLabel` /
`cancelLabel` / `pendingLabel` / `tone` / `pending` options are this entry's
confirm and prompt specs, and `ConfirmDialogProvider` + `useConfirmDialog()` are how a caller asks the
question without mounting a dialog of its own.

## Known drift

- ~~`Modal.tsx` ships `z-50` against the token ladder's 70.~~ **Resolved
  2026-08-05:** the token ladder is canonical and `Modal` consumes
  `--z-modal` (70). Note the ladder itself was then re-ruled at the
  interaction-canon merge review (same date): transient surfaces sit ABOVE
  modal — popover 80, menu 90, toast 100 — so a menu or picker opened from
  inside a dialog paints over the scrim by design. What the fix ended was
  Modal keeping a second, private ladder, not menus painting above dialogs.
- ~~`Modal.tsx` ships **no focus trap**.~~ **Resolved:** every
  `aria-modal` shell in the renderer wraps its dialog in the shared
  `FocusTrap`, sentinels either side, as specified above.
- ~~`Modal.tsx` ships shadowless, `rounded-[8px]`, and a 20px inset.~~
  **Resolved 2026-08-05:** the shell casts `shadow.modal`, rounds at
  `radius.shell`, and insets at `space.3xl`. The same change put every other
  floating surface on the geometry above — the Command Palette, the New
  workspace dialog, the review walkthrough and the diagnostics overlay had each grown a
  private width, radius, border and shadow, and three of the four were shells
  re-implementing this one rather than consuming it. Worth recording is what
  the item asked for and did not get: it proposed `radius.overlay` (7px) as the
  single radius for every overlay, which would have left `radius.shell`
  consumed by nothing and contradicted this entry. The ramp's two steps split
  by surface class instead, exactly as the elevation ramp does.
