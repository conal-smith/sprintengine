// Canonical right-slide-in Drawer primitive. Consumers do not roll their own
// drawer chrome: this primitive owns the elevation (`--shadow-drawer`), the
// slide-in motion (.drawer-panel + `--motion-deliberate`), focus capture,
// Escape close, focus restoration to the opener, and body scroll-lock.
//
// API:
//   <Drawer open onClose title ariaLabel>
//     <Drawer.Body>...</Drawer.Body>
//   </Drawer>

import React, { useEffect, useId, useRef, useState } from 'react'
import { CloseIconButton } from './Buttons'
import { FocusTrap } from './FocusTrap'
import { TruncatedText } from './TruncatedText'
import { MODAL_SURFACE_SELECTOR } from './Modal'
import { FOCUS_RING_INSET_CLASS } from './tokens'

type DrawerLifecycle = 'closed' | 'entering' | 'open' | 'closing'

const EXIT_FALLBACK_MS = 320

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type DrawerProps = {
  open: boolean
  onClose: () => void
  /** Visible header title. */
  title: string
  /** Accessible name for the dialog. Use a sentence that matches the drawer purpose. */
  ariaLabel: string
  /** Accessible name of the close control. Defaults to `Close <title>` — the
   *  spec wants the name to say WHAT it closes, because several surfaces can
   *  be dismissible at once. Override when the title is not the right noun. */
  closeLabel?: string
  /** Drawer width in pixels. Defaults to 360, the shared panel-aside width. */
  width?: number
  children: React.ReactNode
}

function DrawerRoot({ open, onClose, title, ariaLabel, closeLabel, width = 360, children }: DrawerProps) {
  const [lifecycle, setLifecycle] = useState<DrawerLifecycle>('closed')
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const exitTimerRef = useRef<number | null>(null)
  const enterFrameRef = useRef<number | null>(null)
  const titleId = useId()
  // What the drawer shows while it slides shut: the children of its last open
  // render. A consumer clears what it shows in the same update that closes it
  // (the side question drops its entries with the drawer), and drawing that
  // live would flash the empty state across the exit. Keyed off `open`, which
  // changes a render before the lifecycle turns `closing`, and let go once the
  // exit lands.
  const [retained, setRetained] = useState<React.ReactNode>(null)
  if (open && retained !== children) setRetained(children)

  useEffect(() => {
    if (open) {
      if (lifecycle === 'closed') {
        const active = document.activeElement
        restoreFocusRef.current = active instanceof HTMLElement ? active : null
        setLifecycle('entering')
      } else if (lifecycle === 'closing') {
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current)
          exitTimerRef.current = null
        }
        setLifecycle('open')
      }
      return
    }

    if (!open && (lifecycle === 'open' || lifecycle === 'entering')) {
      setLifecycle('closing')
    }
  }, [open, lifecycle])

  useEffect(() => {
    if (lifecycle !== 'entering') return undefined
    enterFrameRef.current = window.requestAnimationFrame(() => {
      enterFrameRef.current = window.requestAnimationFrame(() => {
        setLifecycle('open')
      })
    })
    return () => {
      if (enterFrameRef.current !== null) {
        window.cancelAnimationFrame(enterFrameRef.current)
        enterFrameRef.current = null
      }
    }
  }, [lifecycle])

  useEffect(() => {
    if (lifecycle !== 'closing') return undefined
    const reduced = prefersReducedMotion()
    const finish = () => {
      setLifecycle('closed')
      setRetained(null)
      exitTimerRef.current = null
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (target && document.contains(target)) {
        target.focus()
      }
    }
    if (reduced) {
      finish()
      return undefined
    }
    exitTimerRef.current = window.setTimeout(finish, EXIT_FALLBACK_MS)
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [lifecycle])

  // Move focus into the panel when it lands open.
  useEffect(() => {
    if (lifecycle !== 'open') return undefined
    const handle = window.requestAnimationFrame(() => {
      const node = panelRef.current
      if (!node) return
      if (node.contains(document.activeElement)) return
      node.focus()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [lifecycle])

  // Body scroll-lock while the drawer is mounted.
  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [lifecycle])

  // Escape close. Two yields keep "Escape reaches only the topmost surface"
  // true: a transient child (popover, menu)
  // that already handled Escape marks the event, and a surface stacked ABOVE
  // this drawer must win even though the drawer's window listener registered
  // first — the drawer yields by state rather than by listener order.
  //
  // The drawer is itself `aria-modal="true"` (it scrims, traps focus and locks
  // scroll, so the claim is honest), so "any other modal is open" is the wrong
  // test twice over: it would make the drawer yield to itself, and two open
  // drawers would each yield to the other and neither would close.
  //
  // "Above" is document order. `Modal` renders IN PLACE rather than through a
  // portal, so a dialog hosted inside the drawer body is a DESCENDANT — which
  // `DOCUMENT_POSITION_CONTAINED_BY` reports as FOLLOWING, and it must win. A
  // second drawer or a modal opened later mounts after this panel, so it is
  // FOLLOWING too. Anything that precedes this panel is below it and does not
  // take the key.
  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        const panel = panelRef.current
        const surfaceAbove = Array.from(document.querySelectorAll(MODAL_SURFACE_SELECTOR)).some(
          (node) =>
            node !== panel &&
            panel !== null &&
            (panel.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        )
        if (surfaceAbove) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lifecycle, onClose])

  if (lifecycle === 'closed') return null

  return (
    <div className="fixed inset-0 z-[var(--z-drawer)]">
      <div
        aria-hidden="true"
        className="overlay-scrim absolute inset-0 transition-opacity duration-200"
        style={{ opacity: lifecycle === 'open' ? 1 : 0 }}
        onMouseDown={onClose}
      />

      {/* Same trap as every dialog in the kit — the drawer used to
          carry its own copy of it. */}
      <FocusTrap>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={titleId}
          tabIndex={-1}
          data-state={lifecycle}
          style={{ width }}
          // The shell is the tab stop focus lands on when the drawer opens
          // (above), so it wears the ring like every other focusable — inset,
          // as `TabPanel` does, because the indicator sits at the edge of a
          // full-height surface. `outline-none` here was the one suppressed
          // ring in the kit.
          className={`drawer-panel absolute inset-y-0 right-0 flex h-full max-w-full flex-col border-l border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] ${FOCUS_RING_INSET_CLASS}`}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-default)] px-3 py-2">
            <TruncatedText
              as="h2"
              id={titleId}
              text={title}
              className="text-[length:var(--text-size-md)] font-semibold tracking-tight text-[color:var(--text-strong)]"
            />
            <CloseIconButton aria-label={closeLabel ?? `Close ${title}`} onClick={onClose} />
          </header>

          {open ? children : retained}
        </div>
      </FocusTrap>
    </div>
  )
}

function DrawerBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={[
        'min-h-0 flex-1 overflow-auto px-3 py-3 text-[length:var(--text-size-sm)] text-[color:var(--text-default)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export const Drawer = Object.assign(DrawerRoot, { Body: DrawerBody })
export type { DrawerProps }
