// Z-index ladder for the renderer. ONE ladder of record, and it is the design
// system's — `--sem-z-*`, aliased into the app as `--z-*` in assets/index.css.
// This comment used to declare a second one, and the two disagreed
// about the top of the stack:
//
//   in-flow depth       --z-sticky 10 (sticky headers, in-card raise),
//                       --z-pane 20 (docked panes, in-canvas floating chrome),
//                       --z-float 30 (panel-internal popovers and HUDs) —
//                       `sem.z.sticky` / `sem.z.pane` / `sem.z.float` in
//                       design-system/foundations/tokens.tokens.json. These
//                       describe depth within a pane, not overlay layers; they
//                       used to exist only in this comment, as Tailwind's
//                       `z-20` / `z-30`, until 2026-09-02 put them in the source.
//   overlay layers      --z-drawer 40, --z-modal 70, --z-popover 80,
//                       --z-menu 90, --z-toast 100.
//
// The ordering is deliberate (interaction-canon merge review, 2026-08-05):
// TRANSIENT surfaces sit ABOVE modal. A popover, menu, or tooltip opened from
// inside a dialog is always the topmost, self-dismissing thing on screen — at
// the old popover 50 / menu 60 / modal 70 ladder, every picker a dialog hosted
// painted UNDER its own scrim. Modal beats the page and the drawer; the
// transient family beats modal; toast beats everything. Consuming the token
// removes the second ladder this file used to carry.
import React, { useEffect, useRef, useState } from 'react'
import { backdropHasNoTerminal } from '../palette/paletteBackdrop'
import { acquireTerminalRepaintPause } from '../../utils/terminalRepaintPause'
import { CloseIconButton, DangerButton, GhostButton, PrimaryButton } from './Buttons'
import { FocusTrap } from './FocusTrap'
import { TruncatedText } from './TruncatedText'
import { FOCUS_RING_INSET_CLASS, OVERLAY_SHELL_CLASS, overlayWidthStyle, type OverlayWidth } from './tokens'

type ModalProps = {
  open: boolean
  onClose: () => void
  labelledBy?: string
  /** Accessible name, for a dialog whose title is not a labelable element. */
  label?: string
  /**
   * A step on the width scale (`OVERLAY_WIDTH_PX`), never a pixel count. There
   * is no `width` escape hatch on purpose: the scale is the whole point of
   * the overlay-geometry sweep, and one caller with a private measure re-opens it.
   */
  size?: OverlayWidth
  /**
   * `scroll` — the shell scrolls as one piece under a viewport cap. The default,
   * and what a form or a question wants: header, body and footer move together,
   * which is why neither is separated by a rule.
   *
   * `panel` — a fixed-height flex column that clips its own overflow, for a
   * workbench whose interior panes scroll independently. One height for all of
   * them, so two workbenches opened in a row are the same box.
   */
  layout?: 'scroll' | 'panel'
  children: React.ReactNode
  contained?: boolean
  /**
   * `plain` (default) is the flat darkening scrim. `glass` also blurs what is
   * behind it (owner ruling 2026-11-03) — the workbench modals, Settings and
   * Extensions, so the page recedes behind the dialog — whenever no terminal
   * is drawn under it (`backdropHasNoTerminal`, the ~10fps measurement was a
   * blur over a streaming terminal). Over a terminal it stays the plain tone.
   */
  backdrop?: 'plain' | 'glass'
}

/**
 * The one selector that finds a live modal surface in the document. Exported
 * because three files ask the same question — "is a dialog on screen above me?"
 * — and three hand-typed copies of an attribute pair is how a rename to
 * `role="alertdialog"` would silently unhook two of them. It is also the
 * spelling the accessibility guard has to be able to tell apart from a real
 * JSX `aria-modal` attribute, which is why it lives here rather than being
 * retyped at each call site.
 */
export const MODAL_SURFACE_SELECTOR = '[role="dialog"][aria-modal="true"]'

const PANEL_LAYOUT_CLASS = 'flex h-[min(760px,85vh)] flex-col overflow-hidden'
const SCROLL_LAYOUT_CLASS = 'max-h-[92vh] overflow-y-auto'

export function Modal({
  open,
  onClose,
  labelledBy,
  label,
  size = 'standard',
  layout = 'scroll',
  children,
  contained = false,
  backdrop = 'plain',
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Read once, as the dialog opens: nothing under a modal changes while it is
  // up, and the terminal repaint pause below holds it still.
  const [blurBackdrop] = useState(() => backdrop === 'glass' && !contained && backdropHasNoTerminal())

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handle = window.requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      if (node.contains(document.activeElement)) return
      node.focus()
    })
    return () => {
      window.cancelAnimationFrame(handle)
      previous?.focus()
    }
  }, [open])

  // While this dialog covers the app, terminal panes stop writing. A streaming
  // pane under an overlay re-invalidates the covered region on every PTY chunk,
  // and the compositor redoes that region every time — the cost is
  // `repaint rate x covered area`, which is why the scrim below carries no
  // backdrop-filter and why a GPU renderer would not have fixed this either
  // (it makes the pane's own paint cheaper, not rarer). Output is withheld at
  // `createXtermOutputQueue` and flushed in order when the last dialog closes.
  //
  // The signal is refcounted, so a confirm opened over a workbench does not
  // resume the panes when only IT closes. `isAlive` is the self-heal: a hold
  // whose dialog is no longer in the document is reclaimed by the store's
  // watchdog, so no abnormal unmount can leave every terminal in the product
  // frozen. See `terminalRepaintPause.ts`.
  useEffect(() => {
    if (!open) return
    return acquireTerminalRepaintPause({
      label: 'Modal',
      isAlive: () => ref.current?.isConnected === true,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // Escape closes the TOPMOST surface only. A popover or menu open inside
      // the dialog consumes the key first and marks it handled; without this
      // check the dialog closes out from under it, taking the surface the
      // person was actually dismissing with it.
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      // Scrim: `.overlay-scrim`, matching the Command Palette and every other
      // full-screen overlay so modals read as one system. That claim used to be
      // true of the scrim ONLY — the two shells inside it disagreed on width,
      // radius, border and shadow, and this one carried no shadow at all. Both
      // now draw `OVERLAY_SHELL_CLASS` and a step of the width scale, so the
      // comment describes the whole surface. No backdrop-filter — see
      // the class definition for the framerate cliff it causes.
      //
      // `contain: paint` on the full-window scrim, and deliberately not on the
      // shell inside it. It promises the compositor that nothing in the overlay
      // subtree paints outside this box, so an invalidation raised inside the
      // dialog (a spinner, a hover, a caret) is bounded by the overlay instead
      // of being reasoned about against the whole document — which, under this
      // overlay, is a live terminal. It is behaviour-neutral HERE, which is the
      // whole reason it goes on this element: the scrim is already positioned
      // and already a stacking context, so it is already the containing block
      // for what it holds; the new clip is the viewport, which nothing inside a
      // 92vh/95vw shell can reach; and every transient surface a dialog opens
      // (popover, menu, tooltip) portals to <body>, so containment never sees
      // it at all.
      //
      // The shell would be the wrong site for the same property: it hosts
      // arbitrary panel surfaces through `ModalSurfaceFrame`, and containment
      // there would both clip and re-anchor any absolutely positioned chrome
      // those panels bring with them. The `contained` variant is excluded for
      // the same reason in miniature — its scrim is only as big as the panel it
      // sits in, which a 92vh dialog can legitimately exceed.
      className={`overlay-scrim overlay-scrim-enter ${blurBackdrop ? 'scrim-glass ' : ''}${contained ? 'absolute' : 'fixed [contain:paint]'} inset-0 z-[var(--z-modal)] flex items-center justify-center p-6`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {/* `aria-modal="true"` promises assistive tech that the page behind is
          unreachable. `FocusTrap` is what makes that true for the keyboard. */}
      <FocusTrap>
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-label={label}
          tabIndex={-1}
          style={overlayWidthStyle(size)}
          // Geometry from the scale, not from here: `OVERLAY_SHELL_CLASS` is the
          // same chrome the Command Palette and every migrated shell draw.
          // This primitive used to spell its own `rounded-[8px]` and
          // cast NO shadow at all, so the surface every dialog is supposed to
          // converge on was the shabbiest one in the product.
          // The shell takes focus on open (above) and is therefore a tab stop:
          // it wears the ring like everything focusable, inset as `TabPanel`
          // does because the indicator sits at the edge of the surface. The
          // `outline-none` this replaced left a keyboard user with no sign of
          // where focus was until the first Tab.
          className={`overlay-shell-enter ${OVERLAY_SHELL_CLASS} ${layout === 'panel' ? PANEL_LAYOUT_CLASS : SCROLL_LAYOUT_CLASS} ${FOCUS_RING_INSET_CLASS}`}
        >
          {children}
        </div>
      </FocusTrap>
    </div>
  )
}

type ModalHeaderProps = {
  title: string
  subtitle?: string
  titleId?: string
  onClose?: () => void
  /**
   * The mark of the thing the dialog is about — a monogram, an extension icon
   * — set before the title at the title's own top edge. For a dialog that
   * opens ON an item (a skill, a plugin) rather than asking a question, so
   * the item is recognised by the same mark its row carried. A question has
   * no leading mark: it is not about a thing that has one.
   */
  leading?: React.ReactNode
}

// Header, body, and footer are separated by space, not by rules. The modal
// shell already draws its own edge; a divider under the title and another above
// the buttons cuts a small dialog into three boxed strips for no structural
// gain. The shell scrolls as one piece, so neither rule was a scroll affordance
// either.
//
// The inset is 24px (`space.3xl`, the step the token's own metadata names as the
// modal inset), not the 20px this shipped with — the last of the four geometry
// drifts `design-system/components/modal/component.md` files under the overlay-geometry sweep.
export function ModalHeader({ title, subtitle, titleId, onClose, leading }: ModalHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pb-0 pt-6">
      <div className="flex min-w-0 items-start gap-3">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0">
          <TruncatedText
            as="h2"
            id={titleId}
            text={title}
            className="text-title font-semibold tracking-tight text-[color:var(--text-strong)]"
          />
          {subtitle ? <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{subtitle}</p> : null}
        </div>
      </div>
      {onClose ? <CloseIconButton size="md" aria-label="Close" onClick={onClose} /> : null}
    </div>
  )
}

export function ModalBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-6 py-4 ${className ?? ''}`}>{children}</div>
}

export function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-2">{children}</div>
}

// A second `Field` used to live here: a `text-micro` label wrapped around its
// child, with no `htmlFor`, no `id`, and no ARIA wiring of any kind. It arrived
// through the same `../ui` barrel as `ui/Field`, so whoever imported "the" Field
// got a coin flip on both the label type scale and whether the control had an
// accessible name — and the dialogs that happened to import this one (among
// them the backlog create dialog) were the ones with
// no name at all. Removed in the field sweep; those now take `ui/Field`, which
// clones `id` and the describedby/invalid/required wiring onto the control it
// labels. Import it from `../ui`, not from here.

type ButtonVariant = 'primary' | 'ghost' | 'danger'

type ModalButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}

// A NAME for the footer's three roles, not a fourth button. Every variant is
// the kit primitive at the `md` step, so a dialog's confirm is pixel-identical
// to the Commit button in the Git panel and to the hub footer's Create.
//
// What this used to be — `rounded-md px-3.5 py-2`, sized by its padding rather
// than by the ramp — was the third of five rival primary idioms in the product:
// a 6px radius against the kit's 5px, and a height that fell wherever the line
// box landed instead of on `sem.size.control.*`. Two dialogs beside each other
// disagreed by a pixel or two, which is exactly the drift nobody files and
// everybody perceives.
const VARIANT_COMPONENT: Record<ButtonVariant, typeof PrimaryButton> = {
  primary: PrimaryButton,
  ghost: GhostButton,
  danger: DangerButton,
}

export function ModalButton({ variant = 'ghost', className, ...rest }: ModalButtonProps) {
  const Component = VARIANT_COMPONENT[variant]
  // `md` — the largest ramp step. A dialog footer is the one place in the
  // product where the button IS the screen's terminal action, so it takes the
  // roomiest control rather than the dense-chrome default.
  return <Component {...rest} size="md" className={className} />
}
