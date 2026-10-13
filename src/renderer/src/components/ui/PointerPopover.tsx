import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useClampedMenuPosition } from './ContextMenu'
import { pointerLandedInPopoverWithin, popoverOpenWithin } from './Popover'

type PointerPopoverProps = {
  /** Viewport x of the open point (e.g. `event.clientX` or a button corner). */
  x: number
  /** Viewport y of the open point. */
  y: number
  /** Required accessible name for the surface. */
  ariaLabel: string
  onClose: () => void
  children: React.ReactNode
  /** ARIA role for the surface. Defaults to `menu`. */
  popupRole?: 'menu' | 'listbox' | 'dialog'
  /** Extra surface classes — typically a width floor. */
  surfaceClassName?: string
  /**
   * The surface's material. `raised` is the default opaque popover chrome.
   *
   * `glass` is `bg.surface-raised` at the system's own `glass.opacity` over a
   * blur and saturate of whatever is behind it — the `surface-glass` utility,
   * and the only other sanctioned site for it beside the toast card. It exists
   * for a surface that is drawn ACROSS the running app rather than out of a
   * control: the conversation peek covers a terminal mid-turn, and a solid pane
   * there reads as having replaced the window rather than as sitting over it.
   * It is a per-surface material and not a new default: an opaque menu is still
   * the right answer for a menu.
   */
  material?: 'raised' | 'glass'
}

// Pointer-positioned popover for RICH content — the coordinate-anchored analog of
// `Popover` (which anchors to a trigger element) and the rich-content counterpart
// to `ContextMenu` (which is for roving menu-item lists only). Opens at a viewport
// point, clamps inside the viewport, and dismisses on outside pointerdown or
// Escape. Children own their own internal roles; the surface carries the popup
// role so a portaled rich body (search field, listboxes, nested flyouts that
// position themselves `fixed`) reads as one menu/dialog.
//
// Nested `fixed` flyouts rendered by the children stay DOM descendants of this
// surface, so the contains() check keeps them from dismissing their own parent.
export function PointerPopover({
  x,
  y,
  ariaLabel,
  onClose,
  children,
  popupRole = 'menu',
  surfaceClassName,
  material = 'raised',
}: PointerPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const pos = useClampedMenuPosition(x, y, ref)

  const restoreFocus = useCallback(() => {
    previousFocusRef.current?.focus()
  }, [])

  // Capture the opener so a close (Escape or keyboard activation inside the
  // surface) hands focus back. The cleanup runs before the node leaves the DOM,
  // so focus is restored only when it was still inside the menu.
  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const surface = ref.current
    return () => {
      if (surface?.contains(document.activeElement)) restoreFocus()
    }
  }, [restoreFocus])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      // A `Popover` opened from INSIDE this surface — a split button's menu on
      // a card's head line — portals its own surface to <body>, so the
      // contains() check above reads a press on it as an outside press. Closing
      // on that press unmounts this surface, and the menu with it, before the
      // row's click has landed: the choice is silently dropped. A popover this
      // surface opened is part of this surface. Scoped to OUR popovers, not to
      // the whole stack: a press inside an unrelated menu somewhere else in the
      // window is an outside press like any other, and used to leave this card
      // standing. (`Popover` applies the same rule to itself — see
      // `pointerLandedInPopoverAbove`.)
      if (pointerLandedInPopoverWithin(ref.current, target)) return
      onClose()
    }
    // Bubble phase + defaultPrevented guard so rich children (e.g. a nested chip
    // flyout that closes itself on Escape) can handle the key first, matching
    // Popover/ContextMenu.
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        // A menu opened from inside this surface owns the key: Escape closes
        // the TOPMOST thing, and the split button's menu on a card's head line
        // is above the card. The `defaultPrevented` guard above cannot see it —
        // this listener was registered when the card mounted and the menu's
        // when it opened, and same-target listeners fire in registration order,
        // so this one runs FIRST and closed the whole card on the keypress that
        // was meant for the menu. Standing down here lets the menu's own
        // handler take it; the next Escape, with nothing of ours open, closes
        // the card. Same rule as the pointer branch above, same scope.
        if (popoverOpenWithin(ref.current)) return
        event.preventDefault()
        restoreFocus()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    // keydown on document, not window: runs before a host Modal's window
    // listener, so preventDefault() protects the dialog (matches Popover).
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, restoreFocus])

  return createPortal(
    <div
      ref={ref}
      role={popupRole}
      aria-label={ariaLabel}
      // The surface is portaled to `<body>`, but it is still a React CHILD of
      // whatever opened it, and React propagates events through the REACT tree
      // rather than the DOM tree. So without this every click, press and key
      // inside the surface ALSO ran the opener's handlers: a copy button inside
      // a card opened from a list row selected that row, a middle-click closed
      // it, a double-click to select a word started a rename, a right-click put
      // the row's context menu over the card, and arrow keys drove the list
      // behind it. Sealed here, once, so no consumer has to know this — and
      // sealed at the surface, not on each control, because the leak is the
      // whole subtree's.
      //
      // Deliberately NOT sealed: pointerdown/pointerup (the outside-press
      // dismissal is a window listener and never sees these anyway) and focus,
      // which hosts legitimately track to decide whether to stay open.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      // The menu tier (`--z-menu`) keeps it above the popover layer, matching ContextMenu.
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 'var(--z-menu)' }}
      className={[
        // Clickable over a window-drag region; see OVERLAY_SURFACE_CLASS.
        'app-no-drag rounded-[7px] border border-[color:var(--border-strong)]',
        // design-tokens-allow: canonical popover elevation shared by anchored app-shell surfaces (matches Popover)
        // One ground per surface, written as one class each: `surface-glass`
        // sets `background` and the raised arm sets `background-color`, so
        // spelling both would leave which one wins to stylesheet order.
        material === 'glass'
          ? 'surface-glass shadow-[var(--shadow-popover)]'
          : 'bg-[color:var(--bg-surface-raised)] shadow-[var(--shadow-popover)]',
        surfaceClassName ?? '',
      ].join(' ')}
    >
      {children}
    </div>,
    document.body,
  )
}
