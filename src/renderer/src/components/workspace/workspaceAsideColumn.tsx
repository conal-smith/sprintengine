import React, { useCallback, useRef, useState } from 'react'

import { FOCUS_RING_CLASS } from '../ui/tokens'
import { startColumnResizeDrag } from './columnResizeDrag'
import {
  WORKSPACE_ASIDE_DEFAULT_WIDTH,
  WORKSPACE_ASIDE_MIN_WIDTH,
  clampWorkspaceAsideWidth,
} from './workspaceAsideWidth'

// The workspace aside: the right-docked, width-consuming column that sits
// OUTSIDE the rounded workspace card, on the same --bg-app gutter as the
// workspace sidebar. Chrome only — the width, the drag-to-resize edge, and the
// labelled landmark. The workspace pane (pane/WorkspacePaneColumn.tsx) is its
// tenant since the browser-pane epic. Store-free by design: the caller owns
// where the width lives, so this renders identically under the app store and
// under a test harness.
//
// It is a side-pane in the design system's sense (components/side-pane): in
// the document flow, one hairline on its inner edge, no shadow. `collapsed`
// keeps the column mounted at zero width so a tenant's retained content (a
// terminal, a browser page) survives the pane closing; `fill` is the
// expanded variant that takes the whole row and drops the hairline.

type WorkspaceAsideColumnProps = {
  /** Accessible name for the column landmark — the tenant's surface name. */
  label: string
  width: number
  /** Called once on pointer-up / key step, never per drag frame. */
  onWidthChange: (width: number) => void
  /** Mounted but zero-width: hidden from the accessibility tree, no handle. */
  collapsed?: boolean
  /**
   * Keep a COLLAPSED column interactive, because a tenant is painting outside
   * it — the pane's floating browser player, which is `position: fixed` and so
   * escapes the zero width. `inert` on the column would reach it through the
   * DOM and kill its drag, resize and buttons. The tenant is then responsible
   * for marking its own still-clipped chrome inert.
   */
  keepInteractive?: boolean
  /** Take the whole row (the caller hides the neighbour); no inner hairline. */
  fill?: boolean
  children: React.ReactNode
}

export function WorkspaceAsideColumn({
  label,
  width,
  onWidthChange,
  collapsed = false,
  fill = false,
  keepInteractive = false,
  children,
}: WorkspaceAsideColumnProps) {
  const asideRef = useRef<HTMLElement>(null)
  // Live width during an active drag — written straight to the element (never
  // through `onWidthChange`) so no frame pays for a persisted-registry
  // re-serialization; the final width is reported once on pointer-up. A stray
  // re-render mid-drag re-reads this ref instead of snapping back to the stale
  // committed value. Same idiom as the workspace sidebar's resize.
  const dragWidthRef = useRef<number | null>(null)
  // True for the length of a drag, so the handle's guideline sits at full
  // strength — the side-pane's "Resizing" state. Two renders per drag (start
  // and end), never one per frame.
  const [isResizing, setIsResizing] = useState(false)

  // The widest the column can be: the whole row it shares with the workspace
  // card. Read at the moment of a drag or a key step, because the row changes
  // with the window and the left sidebar.
  const rowWidth = useCallback(() => asideRef.current?.parentElement?.clientWidth || Number.POSITIVE_INFINITY, [])

  // Drag the column's left edge to resize. The column is right-docked, so
  // moving the pointer LEFT widens it. rAF-coalesced: at most one pure DOM
  // width write per frame.
  //
  // The gesture itself lives in startColumnResizeDrag: this column's tenant is
  // often a browser tab, whose `<webview>` guest would otherwise swallow every
  // pointer event once the drag crossed into the page — which froze the width
  // and left the drag armed with no pointer-up to end it.
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const startX = event.clientX
      // The drawn width, not the stored one: a width stored on a wider window
      // is drawn capped to the row, and a drag starts from what is on screen.
      const startWidth = dragWidthRef.current ?? asideRef.current?.getBoundingClientRect().width ?? width
      const maxWidth = rowWidth()
      dragWidthRef.current = startWidth
      setIsResizing(true)
      startColumnResizeDrag(event, {
        onDrag: (clientX) => {
          const next = Math.min(clampWorkspaceAsideWidth(startWidth + (startX - clientX)), maxWidth)
          dragWidthRef.current = next
          if (asideRef.current) asideRef.current.style.width = `${next}px`
        },
        onDragEnd: () => {
          setIsResizing(false)
          const finalWidth = dragWidthRef.current
          dragWidthRef.current = null
          if (finalWidth !== null) onWidthChange(finalWidth)
        },
      })
    },
    [width, onWidthChange, rowWidth],
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16
      // Left edge of a right-docked column: ArrowLeft widens.
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onWidthChange(Math.min(width + STEP, rowWidth()))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onWidthChange(Math.max(WORKSPACE_ASIDE_MIN_WIDTH, width - STEP))
      } else if (event.key === 'Home') {
        event.preventDefault()
        onWidthChange(WORKSPACE_ASIDE_DEFAULT_WIDTH)
      }
    },
    [width, onWidthChange, rowWidth],
  )

  const resizable = !collapsed && !fill
  const columnStyle: React.CSSProperties = collapsed
    ? { width: 0 }
    : fill
      ? {}
      : // Never wider than its row, so a width chosen on a wider window does
        // not push the column off the edge of a narrower one.
        { width: clampWorkspaceAsideWidth(dragWidthRef.current ?? width), maxWidth: '100%' }

  return (
    <aside
      ref={asideRef}
      aria-label={label}
      aria-hidden={(collapsed && !keepInteractive) || undefined}
      // A zero-width column is out of the accessibility tree AND out of the
      // tab order: focus stranded in hidden chrome types into a hidden terminal.
      inert={collapsed && !keepInteractive}
      className={[
        'flex shrink-0 flex-col overflow-hidden',
        // Docked, the column is a gutter beside the card and sits on the app
        // ground with the workspace sidebar. FILLING, it is not a gutter — it
        // covers the card, so it has to be the card's own opaque surface.
        // `--bg-canvas` is `transparent` under the glass window material (the
        // canvas layers go clear so the OS frost shows and the tint is painted
        // once, on body), which is why a maximised pane on glass showed the
        // workspace's FlexLayout tab strip straight through its own tab strip.
        fill ? 'bg-[color:var(--bg-surface)]' : 'bg-[color:var(--bg-canvas)]',
        // Filling: the column floats over the card row (the caller's
        // `relative` wrapper) below the 36px WorkspaceHeader rather than
        // growing beside the content, so the header's controls stay reachable
        // and the terminals underneath keep their size — nothing reflows on
        // maximise.
        fill ? 'absolute inset-x-0 bottom-0 top-[36px] z-[var(--z-pane)]' : 'relative h-full',
        // Inset-card layout: no hairline on the inner edge.
        // The gap IS the separator and it is the CARD's margin, not this
        // column's padding (WorkspacePane) — padding here would inset the
        // pane's 36px tab strip too, and that strip belongs to the window's
        // top band, which runs full width.
      ].join(' ')}
      // No entrance animation on purpose: animating the width reflows the whole
      // workspace card (terminals included) every frame and reads as lag. The
      // column mounts instantly, like the workspace sidebar. During a drag the
      // live width comes from dragWidthRef, so a mid-drag re-render keeps the
      // pointer width instead of snapping back to the committed one.
      style={columnStyle}
    >
      {/* Drag the left edge to resize (same idiom as the workspace sidebar). */}
      {resizable ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} panel`}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          className={`group absolute left-0 top-0 z-[var(--z-pane)] h-full w-1.5 -translate-x-1/2 cursor-col-resize ${FOCUS_RING_CLASS}`}
        >
          <span
            aria-hidden="true"
            // Starts BELOW the 36px band, exactly like the app rail's hairline
            // (AppRail.tsx): nothing draws a vertical line through the top bar.
            className={`absolute bottom-0 top-[36px] left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
              isResizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
            }`}
          />
        </div>
      ) : null}
      {children}
    </aside>
  )
}
