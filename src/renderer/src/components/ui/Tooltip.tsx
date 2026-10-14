import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type TooltipChildProps = {
  'aria-describedby'?: string
  onMouseEnter?: (event: React.MouseEvent) => void
  onMouseLeave?: (event: React.MouseEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
  onPointerDown?: (event: React.PointerEvent) => void
}

type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

type TooltipProps = {
  /** Short helper text or rich node shown beside the trigger. */
  content: React.ReactNode
  /**
   * Preferred side relative to the trigger. The tooltip flips to the opposite
   * side when the preferred side would overflow the viewport, then clamps to
   * the viewport on both axes, so it is never cropped at a screen edge. `right`
   * suits narrow vertical chrome (e.g. a collapsed sidebar rail).
   */
  placement?: TooltipPlacement
  /** A single focusable trigger. The tooltip clones it to wire ARIA + handlers. */
  children: React.ReactElement<TooltipChildProps>
  /** Hover open delay. Focus opens immediately so keyboard users do not wait. */
  openDelayMs?: number
  /**
   * Let the tooltip wrap over several lines inside a capped measure, for content
   * that is a sentence rather than a label (a full prompt, a path, an error).
   * This REPLACES the default `whitespace-nowrap` rather than being appended
   * beside it: two whitespace utilities in one class attribute are resolved by
   * stylesheet order, not attribute order, so a caller cannot reliably override
   * the base from `className`.
   */
  multiline?: boolean
  className?: string
  /**
   * Classes applied to the wrapping span around the trigger. Use this when the
   * default `inline-flex` would shrink the trigger to its content — e.g. a
   * drop-target button inside a flex column that should fill the row.
   */
  wrapperClassName?: string
  /**
   * Role for the wrapping span. Pass `presentation` when the wrapper sits
   * between a container and its semantic child (e.g. a `tree` and its
   * `treeitem`) so it stays transparent in the accessibility tree and does not
   * break the owned-element relationship.
   */
  wrapperRole?: React.AriaRole
  /**
   * Which layer the surface sits on. `popover` (the default, `z.popover`) is
   * right for a trigger in the page.
   *
   * `menu` is for a trigger that lives INSIDE a menu-tier surface — a
   * `PointerPopover`, a `ContextMenu`. Those sit at `z.menu`, one above the
   * default, so a tooltip opened from inside one painted UNDERNEATH it: the
   * moment the surface flipped the tooltip onto itself, the description became
   * a smear behind the glass. A tooltip must be able to sit above the surface
   * that owns it, so it joins that surface's tier; being portaled later it
   * paints above its owner at the same z, and it still cannot cover a
   * context menu summoned afterwards.
   */
  layer?: 'popover' | 'menu'
}

// Gap between the trigger and the tooltip, and the minimum margin the tooltip
// keeps from every viewport edge.
const TRIGGER_GAP = 6
const VIEWPORT_PADDING = 8

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

// Viewport-relative (position: fixed) coordinates for the tooltip. The tooltip
// renders in a body portal so it escapes any `overflow` clipping from an
// ancestor (e.g. the scrollable sidebar nav), then flips + clamps so it can
// never be cropped at a viewport edge.
function computeTooltipCoords(
  triggerRect: DOMRect,
  tip: { width: number; height: number },
  preferred: TooltipPlacement,
): { top: number; left: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight

  const candidates: Record<TooltipPlacement, { top: number; left: number }> = {
    top: {
      top: triggerRect.top - tip.height - TRIGGER_GAP,
      left: triggerRect.left + triggerRect.width / 2 - tip.width / 2,
    },
    bottom: {
      top: triggerRect.bottom + TRIGGER_GAP,
      left: triggerRect.left + triggerRect.width / 2 - tip.width / 2,
    },
    left: {
      top: triggerRect.top + triggerRect.height / 2 - tip.height / 2,
      left: triggerRect.left - tip.width - TRIGGER_GAP,
    },
    right: {
      top: triggerRect.top + triggerRect.height / 2 - tip.height / 2,
      left: triggerRect.right + TRIGGER_GAP,
    },
  }

  // Does the candidate stay on-screen along the axis it points from?
  const fitsMainAxis = (side: TooltipPlacement): boolean => {
    const c = candidates[side]
    if (side === 'top') return c.top >= VIEWPORT_PADDING
    if (side === 'bottom') return c.top + tip.height <= vh - VIEWPORT_PADDING
    if (side === 'left') return c.left >= VIEWPORT_PADDING
    return c.left + tip.width <= vw - VIEWPORT_PADDING
  }

  // Flip to the opposite side only when the preferred side overflows and the
  // opposite side fits; otherwise keep the preferred side and rely on clamping.
  let side = preferred
  if (!fitsMainAxis(side) && fitsMainAxis(OPPOSITE[side])) {
    side = OPPOSITE[side]
  }

  const chosen = candidates[side]
  const maxLeft = Math.max(VIEWPORT_PADDING, vw - tip.width - VIEWPORT_PADDING)
  const maxTop = Math.max(VIEWPORT_PADDING, vh - tip.height - VIEWPORT_PADDING)
  return {
    top: Math.min(Math.max(chosen.top, VIEWPORT_PADDING), maxTop),
    left: Math.min(Math.max(chosen.left, VIEWPORT_PADDING), maxLeft),
  }
}

// The spec shows a tooltip on `:focus-visible`, not on any focus: a click
// focuses its control too, and so does the window giving focus back to the
// control that last had it when the app is activated again. Those are not a
// person asking what the control is. An engine that cannot answer the
// selector (the test DOM) is treated as keyboard focus, the old behaviour.
function isFocusVisible(target: EventTarget): boolean {
  const matches = (target as Partial<Element>).matches
  if (typeof matches !== 'function') return true
  try {
    return matches.call(target, ':focus-visible')
  } catch {
    return true
  }
}

// `:focus-visible` alone still lets a programmatic focus through: Chromium
// lends it whatever key was pressed last, so Settings closing on Escape and
// handing focus back to the gear stood the gear's tooltip up again. The root's
// `data-focus-source` (utils/focusSource) is the app's answer to "did the
// keyboard move focus?" — the same one that decides whether a focus ring is
// drawn — so a focus the pointer last steered opens no tooltip, as it draws no
// ring. A document without the stamp (a test DOM) leaves it to the selector.
function pointerSteeredFocus(target: EventTarget): boolean {
  const doc = (target as Partial<Node>).ownerDocument
  return doc?.documentElement?.dataset.focusSource === 'pointer'
}

export function Tooltip({
  content,
  placement = 'top',
  children,
  openDelayMs = 200,
  multiline = false,
  className,
  wrapperClassName,
  wrapperRole,
  layer = 'popover',
}: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<number | null>(null)
  const triggerWrapRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const close = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  // Whether `coords` holds a position, so a tooltip mounting closed clears
  // nothing: that update cost the control it sits on a second commit, which
  // a send button swapped in on Enter paid on the send's own frame.
  const placedRef = useRef(false)
  const position = useCallback(() => {
    const wrap = triggerWrapRef.current
    const tip = tooltipRef.current
    if (!wrap || !tip) return
    placedRef.current = true
    setCoords(
      computeTooltipCoords(
        wrap.getBoundingClientRect(),
        { width: tip.offsetWidth, height: tip.offsetHeight },
        placement,
      ),
    )
  }, [placement])

  // Measure before paint, and keep the tooltip pinned to its trigger while open
  // (scroll uses capture so nested scroll containers are caught too).
  useLayoutEffect(() => {
    if (!open) {
      if (placedRef.current) {
        placedRef.current = false
        setCoords(null)
      }
      return
    }
    position()
    const reposition = () => position()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The topmost-surface contract: an open tooltip is the topmost
        // transient (z 80, above modal 70), so its Escape dismisses IT and
        // marks the event; the host dialog's `defaultPrevented` guard then
        // yields. On `document` so this runs before any window listener.
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    // The app losing focus is a way out too. A click that opens the browser
    // leaves the pointer resting on the trigger, so no mouseleave ever comes,
    // and the tooltip would still be standing over the composer on return.
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [open, close])

  useEffect(() => clearTimer, [clearTimer])

  const childProps = children.props

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent) => {
      childProps.onMouseEnter?.(event)
      // React delivers enter and leave along its own tree, so a menu the
      // trigger portals out (a split button's chevron menu) counts as inside
      // it: entering its rows would summon the trigger's tooltip over them.
      // Only the trigger's own DOM is the trigger.
      if (!triggerWrapRef.current?.contains(event.target as Node)) return
      clearTimer()
      timer.current = window.setTimeout(() => setOpen(true), openDelayMs)
    },
    [childProps, clearTimer, openDelayMs],
  )

  const handleMouseLeave = useCallback(
    (event: React.MouseEvent) => {
      childProps.onMouseLeave?.(event)
      close()
    },
    [childProps, close],
  )

  const handleFocus = useCallback(
    (event: React.FocusEvent) => {
      childProps.onFocus?.(event)
      if (!isFocusVisible(event.target) || pointerSteeredFocus(event.target)) return
      clearTimer()
      setOpen(true)
    },
    [childProps, clearTimer],
  )

  // Pressing the trigger answers the question the tooltip was for, and a
  // press that opens a menu or the browser would otherwise leave it standing:
  // the menu is portalled (so React never reports the pointer leaving) and the
  // browser takes the app's focus (so nothing reports anything).
  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      childProps.onPointerDown?.(event)
      close()
    },
    [childProps, close],
  )

  const handleBlur = useCallback(
    (event: React.FocusEvent) => {
      childProps.onBlur?.(event)
      close()
    },
    [childProps, close],
  )

  const trigger = React.cloneElement<TooltipChildProps>(children, {
    'aria-describedby': open ? id : childProps['aria-describedby'],
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onPointerDown: handlePointerDown,
  })

  return (
    <span ref={triggerWrapRef} role={wrapperRole} className={`relative ${wrapperClassName ?? 'inline-flex'}`}>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              id={id}
              style={{
                position: 'fixed',
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                // Hidden until measured so the first paint never flashes at 0,0.
                visibility: coords ? 'visible' : 'hidden',
              }}
              className={[
                // No entrance animation (tooltip spec → States): the surface
                // is neither alive nor arriving, it is the label made visible.
                'pointer-events-none',
                layer === 'menu' ? 'z-[var(--z-menu)]' : 'z-[var(--z-popover)]',
                multiline ? 'max-w-[420px] whitespace-pre-wrap break-words' : 'whitespace-nowrap',
                'rounded-sm border border-[color:var(--border-strong)]',
                // 10/6px and `meta`, per design-system/components/tooltip.
                // This shipped at `micro` (11px), which put the
                // tooltip a type step BELOW the 12px row it exists to make
                // readable — backwards for a component whose whole job is to
                // show what the surface could not.
                'bg-[color:var(--bg-surface-raised)] px-2.5 py-1.5',
                'text-meta leading-snug text-[color:var(--text-strong)]',
                className ?? '',
              ].join(' ')}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
