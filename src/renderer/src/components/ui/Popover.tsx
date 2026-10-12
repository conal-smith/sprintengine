import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_CHROME_CLASS, OVERLAY_SURFACE_CLASS } from './tokens'

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

type PopoverRenderTriggerArgs = {
  ref: { current: HTMLButtonElement | null }
  open: boolean
  openPopover: () => void
  closePopover: (restoreFocus?: boolean) => void
  togglePopover: () => void
  triggerProps: {
    'aria-haspopup': 'menu' | 'listbox' | 'dialog' | 'true'
    'aria-expanded': boolean
    'aria-controls': string | undefined
  }
}

type PopoverSurfaceElement = 'div' | 'ul'

type PopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  ariaLabel: string
  popupRole: 'menu' | 'listbox' | 'dialog'
  /**
   * Which layer the surface sits on. `popover` (the default, `z.popover`) is
   * right for a surface opened out of the page. `menu` (`z.menu`) is for one
   * opened from inside a surface that is ALREADY on the menu tier — a
   * pointer-anchored card, a context menu — where the default tier would paint
   * this underneath the thing that opened it (design-system/components/menu →
   * Surface).
   */
  layer?: 'popover' | 'menu'
  renderTrigger: (args: PopoverRenderTriggerArgs) => React.ReactNode
  children: React.ReactNode
  placement?: PopoverPlacement
  className?: string
  surfaceClassName?: string
  surfaceAs?: PopoverSurfaceElement
  onOpenAutoFocus?: (surface: HTMLElement) => void
  /**
   * The surface's material. `raised` is the ordinary opaque popover chrome and
   * stays the family default.
   *
   * `glass` is `bg.surface-raised` at the system's own `glass.opacity` over a
   * blur and saturate of whatever is behind it — the `surface-glass` utility,
   * the same material `PointerPopover` offers. Per the popover spec it is
   * opt-in per surface, for a card drawn deliberately over live app content the
   * reader should still see: the skill type-ahead sits over the conversation
   * the person is mid-way through reading, and a solid slab there reads as
   * having replaced the transcript rather than as sitting over it. An opaque
   * menu is still the right answer for a menu.
   */
  material?: 'raised' | 'glass'
}

// The surface is portaled to <body> and positioned with fixed coordinates so it
// can never be clipped by an ancestor's overflow. Gap matches the former mt-1/mb-1.
const SURFACE_GAP = 4
const VIEWPORT_EDGE = 8

// The surface is anchored by the CSS edge nearest the trigger (right for `end`,
// left for `start`; bottom for flipped-up, top otherwise) so its measured size
// never enters the horizontal math — the chosen edge stays glued to the trigger
// and can't drift by a surface-width if the measurement is momentarily off.
type SurfacePosition = {
  top?: number
  bottom?: number
  left?: number
  right?: number
  triggerWidth: number
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(value, max))
}

function computeSurfacePosition(
  trigger: DOMRect,
  surfaceWidth: number,
  surfaceHeight: number,
  placement: PopoverPlacement,
): SurfacePosition {
  const vw = window.innerWidth
  const vh = window.innerHeight

  const wantsBottom = placement.startsWith('bottom')
  const spaceBelow = vh - trigger.bottom - VIEWPORT_EDGE
  const spaceAbove = trigger.top - VIEWPORT_EDGE
  let onBottom = wantsBottom
  if (wantsBottom && surfaceHeight + SURFACE_GAP > spaceBelow && spaceAbove > spaceBelow) onBottom = false
  if (!wantsBottom && surfaceHeight + SURFACE_GAP > spaceAbove && spaceBelow > spaceAbove) onBottom = true

  const vertical = onBottom
    ? { top: clamp(trigger.bottom + SURFACE_GAP, VIEWPORT_EDGE, vh - surfaceHeight - VIEWPORT_EDGE) }
    : { bottom: clamp(vh - trigger.top + SURFACE_GAP, VIEWPORT_EDGE, vh - surfaceHeight - VIEWPORT_EDGE) }

  // Anchor the end-aligned surface by its right edge and the start-aligned one by
  // its left edge. Width only feeds an overflow guard so a surface wider than the
  // space on its anchored side flips to the opposite edge instead of clipping.
  const wantsEnd = placement.endsWith('end')
  const overflowsLeft = wantsEnd && trigger.right - surfaceWidth < VIEWPORT_EDGE
  const overflowsRight = !wantsEnd && trigger.left + surfaceWidth > vw - VIEWPORT_EDGE
  const horizontal =
    (wantsEnd && !overflowsLeft) || overflowsRight
      ? { right: clamp(vw - trigger.right, VIEWPORT_EDGE, vw - surfaceWidth - VIEWPORT_EDGE) }
      : { left: clamp(trigger.left, VIEWPORT_EDGE, vw - surfaceWidth - VIEWPORT_EDGE) }

  return { ...vertical, ...horizontal, triggerWidth: trigger.width }
}

// Open popovers in stacking order, each with its own surface and the element it
// was opened FROM. The surface is carried (not just the id) so a popover can
// tell whether a pointer landed in one stacked ABOVE it — see the outside-click
// guard below. The ANCHOR is carried for the question a host surface asks:
// "is one of these mine?" — see `openPopoversWithin`.
type OpenPopoverEntry = {
  id: string
  surface: React.MutableRefObject<HTMLElement | null>
  /** The trigger's own container, which is where in the page this was opened from. */
  anchor: React.MutableRefObject<HTMLElement | null>
}

const openPopoverStack: OpenPopoverEntry[] = []

function indexOfOpenPopover(id: string): number {
  return openPopoverStack.findIndex((entry) => entry.id === id)
}

function pushOpenPopover(
  id: string,
  surface: React.MutableRefObject<HTMLElement | null>,
  anchor: React.MutableRefObject<HTMLElement | null>,
): void {
  const existing = indexOfOpenPopover(id)
  if (existing >= 0) openPopoverStack.splice(existing, 1)
  openPopoverStack.push({ id, surface, anchor })
}

function removeOpenPopover(id: string): void {
  const existing = indexOfOpenPopover(id)
  if (existing >= 0) openPopoverStack.splice(existing, 1)
}

function isTopmostPopover(id: string): boolean {
  return openPopoverStack[openPopoverStack.length - 1]?.id === id
}

// Every surface is portaled to <body>, so a popover opened FROM inside another
// one is not a DOM descendant of it — `surface.contains(target)` reads a click
// on the nested surface as an outside click. Dismissing on that mousedown
// unmounts the nested popover before its own click lands, so the choice the
// user just made is silently dropped. Anything stacked above this popover
// therefore counts as inside it.
function pointerLandedInPopoverAbove(id: string, target: Node): boolean {
  const index = indexOfOpenPopover(id)
  if (index < 0) return false
  return openPopoverStack.slice(index + 1).some((entry) => entry.surface.current?.contains(target))
}

/**
 * The open popovers that belong to `host` — the ones opened from inside it,
 * directly or through one of their own surfaces.
 *
 * Scoped, not stack-wide. The stack is global: every `Popover` open anywhere in
 * the window is in it, including ones from a panel behind the host. A host that
 * treated ALL of them as "part of me" would refuse to dismiss on a press inside
 * a completely unrelated menu, which is a press that should close it like any
 * other outside press.
 *
 * "Belongs to" is transitive because a popover's surface is portaled to
 * `<body>`: a menu opened from inside the host is a DOM child of `<body>`, so a
 * flyout opened from inside THAT menu has an anchor that is inside neither the
 * host nor the body-level surface of anything but its own parent. Walking the
 * stack in stacking order (a popover opened from inside another was pushed
 * after it) resolves the whole chain in one pass.
 */
function openPopoversWithin(host: Node): OpenPopoverEntry[] {
  const mine: OpenPopoverEntry[] = []
  for (const entry of openPopoverStack) {
    const anchor = entry.anchor.current
    if (!anchor) continue
    if (host.contains(anchor) || mine.some((owned) => owned.surface.current?.contains(anchor))) {
      mine.push(entry)
    }
  }
  return mine
}

/**
 * The outside-press question asked from OUTSIDE the stack, for a surface that
 * dismisses on an outside press but is not a `Popover` itself —
 * `PointerPopover`, which anchors to a coordinate rather than to a trigger.
 *
 * A menu opened from inside such a surface is portaled to `<body>` too, so the
 * host's own `contains()` reads a click on it as an outside click and unmounts
 * the host (and with it the menu) before the row's click can land. The choice
 * the person just made is then silently dropped. A popover the host itself
 * opened is part of the host, so a press inside one is never "outside" —
 * and a press inside anyone ELSE's popover still is.
 */
export function pointerLandedInPopoverWithin(host: Node | null, target: Node): boolean {
  if (!host) return false
  return openPopoversWithin(host).some((entry) => entry.surface.current?.contains(target))
}

/**
 * Whether a popover opened from inside `host` is on screen right now — the
 * Escape question, and the mirror of the pointer rule above.
 *
 * Escape closes the TOPMOST thing, and a menu opened from inside a card is
 * above the card. But `Popover` registers its Escape handler when it opens and
 * a host surface registers one when it MOUNTS, and same-target listeners fire
 * in registration order, so the host's handler always runs first and would
 * close the whole card on the keypress meant for its menu. The host asks this
 * and stands down; the menu's own handler then takes the key.
 */
export function popoverOpenWithin(host: Node | null): boolean {
  if (!host) return false
  return openPopoversWithin(host).length > 0
}

/**
 * Whether a popover's trigger is off screen: detached, inside an inert or
 * aria-hidden subtree (a background workspace layer, a view under a door), or
 * not rendered (display/visibility/content-visibility), where the engine can
 * tell us.
 */
function anchorHidden(anchor: Element): boolean {
  if (!anchor.isConnected) return true
  if (anchor.closest('[inert], [aria-hidden="true"], [hidden]')) return true
  const visible = (anchor as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility
  return typeof visible === 'function'
    ? !visible.call(anchor, { visibilityProperty: true, contentVisibilityAuto: true })
    : false
}

export function Popover({
  open,
  onOpenChange,
  ariaLabel,
  popupRole,
  layer = 'popover',
  renderTrigger,
  children,
  placement = 'bottom-start',
  className,
  surfaceClassName,
  surfaceAs = 'div',
  onOpenAutoFocus,
  material = 'raised',
}: PopoverProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Wrapper around the trigger. Used as the positioning anchor when a caller's
  // renderTrigger doesn't forward `ref` to a button (e.g. a trigger that is itself
  // a composite control like OverflowMenu). The wrapper is `relative inline-flex`,
  // so it shrink-wraps the trigger and its rect matches it closely enough to anchor.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const popoverId = useId()
  const [position, setPosition] = useState<SurfacePosition | null>(null)

  const closePopover = useCallback(
    (restoreFocus = true) => {
      onOpenChange(false)
      if (restoreFocus) triggerRef.current?.focus()
    },
    [onOpenChange],
  )

  const openPopover = useCallback(() => {
    onOpenChange(true)
  }, [onOpenChange])

  const togglePopover = useCallback(() => {
    onOpenChange(!open)
  }, [onOpenChange, open])

  useEffect(() => {
    if (!open) return
    const surface = surfaceRef.current
    if (surface) onOpenAutoFocus?.(surface)
  }, [open, onOpenAutoFocus])

  // Measure the trigger and surface once open, then anchor the surface with fixed
  // coordinates. Reposition on viewport resize and on scroll anywhere in the tree
  // (capture phase) so the menu tracks its trigger inside scrollable panels.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const reposition = () => {
      const anchor = triggerRef.current ?? containerRef.current
      const surface = surfaceRef.current
      if (!anchor || !surface) return
      const triggerRect = anchor.getBoundingClientRect()
      setPosition(computeSurfacePosition(triggerRect, surface.offsetWidth, surface.offsetHeight, placement))
    }
    // The surface scrolls its own content when it is taller than the viewport;
    // that scroll moves no trigger, so it is not a reason to re-measure.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && surfaceRef.current?.contains(event.target)) return
      reposition()
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', onScroll, true)
    // A surface whose content grows after it opened — a menu that steps into
    // a taller view, an error line appearing — is measured again, so it flips
    // or clamps exactly as it would have had it opened at that size, instead
    // of running off the bottom of the window with its buttons. Placing it
    // moves it without resizing it, so this never feeds itself.
    const resizes =
      typeof ResizeObserver === 'undefined' || !surfaceRef.current ? null : new ResizeObserver(() => reposition())
    if (resizes && surfaceRef.current) resizes.observe(surfaceRef.current)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', onScroll, true)
      resizes?.disconnect()
    }
  }, [open, placement])

  useEffect(() => {
    if (!open) return
    pushOpenPopover(popoverId, surfaceRef, containerRef)
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (surfaceRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      if (pointerLandedInPopoverAbove(popoverId, target)) return
      onOpenChange(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!isTopmostPopover(popoverId)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closePopover(true)
      }
    }
    window.addEventListener('mousedown', onPointer)
    // On document, not window: hosting dialogs key their own Escape handlers off
    // event.defaultPrevented, but their window listeners are registered at mount
    // — before this one — and same-target listeners fire in registration order.
    // Document bubble listeners always run before window listeners, so the
    // popover consumes Escape first regardless of when it opened.
    document.addEventListener('keydown', onKey)
    return () => {
      removeOpenPopover(popoverId)
      window.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closePopover, onOpenChange, popoverId])

  // Close when the trigger stops being on screen. The surface is portaled to
  // <body>, so hiding the trigger's layer — switching workspace (its layer goes
  // `invisible` and aria-hidden), switching tab, a door painting over it inert —
  // hid the anchor and left the menu floating over whatever came next, still
  // answering clicks for a view nobody could see. Watched only while open.
  //
  // Only the trigger and its ancestors are watched, each on its own
  // attributes: whatever hides the trigger is an attribute on that chain.
  // Watching the whole of <body> meant every class or style write anywhere
  // (a streaming transcript, a terminal's helper textarea) forced a style and
  // layout check on the next frame while any menu was open. An intersection
  // observer on the trigger adds the cases no attribute on the chain names,
  // such as a stylesheet taking it out of layout.
  useEffect(() => {
    if (!open) return
    const anchor = triggerRef.current ?? containerRef.current
    if (!anchor) return
    let frame: number | null = null
    const check = () => {
      frame = null
      if (anchorHidden(anchor)) onOpenChange(false)
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(check)
    }
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    for (let node: Element | null = anchor; node && mutations; node = node.parentElement) {
      mutations.observe(node, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'],
      })
    }
    const intersections =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => !entry.isIntersecting)) schedule()
          })
    intersections?.observe(anchor)
    return () => {
      mutations?.disconnect()
      intersections?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [open, onOpenChange])

  const Surface = surfaceAs

  return (
    <div ref={containerRef} className={['relative inline-flex', className ?? ''].join(' ')}>
      {renderTrigger({
        ref: triggerRef,
        open,
        openPopover,
        closePopover,
        togglePopover,
        triggerProps: {
          'aria-haspopup': popupRole === 'dialog' ? 'dialog' : popupRole,
          'aria-expanded': open,
          'aria-controls': open ? popoverId : undefined,
        },
      })}
      {open
        ? createPortal(
            <Surface
              ref={surfaceRef as React.Ref<never>}
              id={popoverId}
              role={popupRole}
              aria-label={ariaLabel}
              style={{
                position: 'fixed',
                top: position?.top,
                bottom: position?.bottom,
                left: position?.left,
                right: position?.right,
                // Exposed so width-coupled surfaces (Select, module listboxes)
                // can match the trigger via min-w-[var(--popover-trigger-width)]
                // without an inline width that would clobber their own min-w floor.
                ['--popover-trigger-width' as string]: position ? `${position.triggerWidth}px` : undefined,
                // Hidden until measured so the first paint never flashes at 0,0.
                visibility: position ? 'visible' : 'hidden',
                // The other half of "clamps 8px inside the viewport": a surface
                // taller than the window is bounded to it and scrolls, rather
                // than being pinned to the top edge and running off the bottom
                // (the New chat project selector, with enough projects, lost
                // its Browse… and Import rows exactly this way).
                maxHeight: `calc(100vh - ${VIEWPORT_EDGE * 2}px)`,
                overflowY: 'auto',
              }}
              className={[
                // The chrome is the shared one, so the surface a pointer-summoned
                // menu draws for itself cannot drift from the surface an anchored
                // one gets here. What sits on it owns its own inset.
                // One z utility, chosen here rather than appended by a caller:
                // two `z-*` classes on one element are resolved by stylesheet
                // order rather than by the order they were written.
                layer === 'menu' ? 'popover-enter z-[var(--z-menu)]' : 'popover-enter z-[var(--z-popover)]',
                // One ground per surface, written as one class each: `surface-glass`
                // sets `background` and the raised chrome sets `background-color`,
                // so spelling both would leave which one wins to stylesheet order.
                material === 'glass' ? `${OVERLAY_CHROME_CLASS} surface-glass` : OVERLAY_SURFACE_CLASS,
                surfaceClassName ?? '',
              ].join(' ')}
            >
              {children}
            </Surface>,
            document.body,
          )
        : null}
    </div>
  )
}

export type { PopoverProps }
