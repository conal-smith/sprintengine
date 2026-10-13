// The pointer drag behind the workspace's two resizable columns — the sidebar's
// right edge and the pane aside's left edge.
//
// Why this is not just `window.addEventListener('pointermove')`: the pane
// aside hosts a browser tab, and a browser tab is a real Electron `<webview>`
// guest (pane/browser/BrowserTab.tsx). A guest is a separate WebContents, so
// the moment the pointer crosses into it the host renderer stops seeing
// pointer events at all — they are delivered to the guest instead. A drag wired
// to `window` therefore froze the instant it moved over the page: the column
// stopped tracking (you could widen it, because that direction moves over the
// workspace card, but never narrow it), and `pointerup` landed in the guest so
// the drag never ended — it stayed armed until the next click on host chrome.
//
// Two guards, because they fail in different places:
//
//   1. Pointer capture on the handle. This is the design system's ruling for
//      the side-pane resize contract (components/side-pane/component.md:
//      "panes routinely host iframes that would otherwise swallow pointermove
//      mid-drag"), and ui/SidePane.tsx already follows it. Capture asks the
//      browser to force every pointer event of this gesture at the handle,
//      whatever it is over.
//   2. A drag shield: one transparent fixed element over the whole window for
//      the life of the drag. Capture is a request the compositor honours for
//      out-of-process frames; a guest WebContents is a stronger boundary than
//      an iframe, so the shield is what actually guarantees the pointer never
//      reaches the guest. It also carries the `col-resize` cursor over the
//      page, which `document.body`'s cursor cannot do — the guest paints its
//      own.
//
// The drag ends on pointer-up, on pointer-cancel, on losing capture (the
// handle unmounted mid-drag), and on the window losing focus. Whichever comes
// first, `onDragEnd` runs exactly once and the shield always comes back down —
// a shield left up would swallow every click in the app. Only a pointer-up
// says where the drag stopped: the width is drawn at the release's x before
// `onDragEnd` commits, because the last move may still be waiting for its
// frame, and a quick flick would otherwise persist a width short of where the
// pointer let go.

import type React from 'react'

import { beginInteractiveLayoutResize } from '../../utils/layoutTransition'

export type ColumnResizeDragOptions = {
  /**
   * The live pointer x, coalesced to at most one call per animation frame.
   * Callers write the width straight to the DOM here; the store is for
   * `onDragEnd`.
   */
  onDrag: (clientX: number) => void
  /** Runs exactly once, however the drag ends. Commit the final width here. */
  onDragEnd: () => void
}

/**
 * Begin a column resize from a handle's `pointerdown`. The caller owns the
 * width maths and the button check; this owns the gesture.
 */
export function startColumnResizeDrag(
  event: React.PointerEvent<HTMLElement>,
  { onDrag, onDragEnd }: ColumnResizeDragOptions,
): void {
  event.preventDefault()
  const handle = event.currentTarget
  const pointerId = event.pointerId
  let pendingX = event.clientX
  let drawnX = event.clientX
  let frame: number | null = null
  let ended = false
  // Terminals beside the column follow the drag at a throttled rate instead
  // of resizing their pty on every frame, and fit once more when it ends.
  const endInteractiveResize = beginInteractiveLayoutResize()

  // Above every tier of the one z ladder: the shield has to cover docked panes,
  // overlays and the guest alike for the length of the drag.
  const shield = document.createElement('div')
  shield.setAttribute('aria-hidden', 'true')
  shield.dataset.columnResizeShield = 'true'
  shield.style.position = 'fixed'
  shield.style.inset = '0'
  shield.style.zIndex = 'var(--z-toast)'
  shield.style.cursor = 'col-resize'

  const apply = (): void => {
    frame = null
    drawnX = pendingX
    onDrag(pendingX)
  }
  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    pendingX = e.clientX
    if (frame === null) frame = window.requestAnimationFrame(apply)
  }
  const end = (releasedAt?: number): void => {
    if (ended) return
    ended = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    if (releasedAt !== undefined && releasedAt !== drawnX) onDrag(releasedAt)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onPointerEnd)
    window.removeEventListener('pointercancel', onPointerEnd)
    window.removeEventListener('blur', interrupt)
    handle.removeEventListener('lostpointercapture', interrupt)
    try {
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
    } catch {
      // Already released (the handle unmounted, or the gesture was cancelled).
    }
    shield.remove()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    onDragEnd()
    // After the final width is committed, so the trailing fit reads it.
    endInteractiveResize()
  }
  const onPointerEnd = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    end(e.type === 'pointerup' ? e.clientX : undefined)
  }
  const interrupt = (): void => end()

  try {
    handle.setPointerCapture(pointerId)
  } catch {
    // No capture available (a synthetic pointer, a stale id). The shield alone
    // keeps the gesture in this document, so the drag still completes.
  }
  handle.addEventListener('lostpointercapture', interrupt)
  document.body.appendChild(shield)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onPointerEnd)
  window.addEventListener('pointercancel', onPointerEnd)
  window.addEventListener('blur', interrupt)
}
