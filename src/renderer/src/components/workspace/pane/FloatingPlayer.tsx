import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { FLOAT_DEFAULT_HEIGHT, FLOAT_DEFAULT_WIDTH } from '../../../store/slices/workspacePaneSlice'
import type { WorkspaceId, WorkspacePaneTab } from '../../../types/workspace'
import { CloseIconButton, FloatingButton, Tooltip } from '../../ui'
import { agentBrowserTracker } from './browser/agentBrowserFloat'

// The floating browser player (browser-pane epic, `floating-preview`): a
// miniature of the pane's browser tab kept in view over the workspace while
// the pane is closed, so a person reading the transcript can see that an agent
// is looking at a page, and which. The person floats a tab from its View menu;
// an agent taking a page in a closed pane floats it by itself
// (useAgentBrowserAutoFloat).
//
// A Canvas tab floats the same way when an agent draws on its board with the
// pane closed, as a picture of the drawing (CanvasTab) rather than the editor.
//
// The player is NOT a new surface. It is the same panel element the pane
// renders, restyled to `position: fixed` — see the comment at the restyle in
// `WorkspacePaneBody` — and the page inside it scaled down to fit (BrowserTab).
// Everything here is the overlay laid over that element plus the arithmetic
// that keeps its rectangle on screen.

/**
 * What the player keeps clear of the window's edges, so it never sits flush
 * against the frame or looks half fallen off: `--sem-space-xl`, read from the
 * token, with its value as the fallback where no stylesheet is loaded.
 */
export const FLOAT_EDGE_GAP_FALLBACK = 16
let edgeGapCache: number | null = null
function edgeGap(): number {
  if (edgeGapCache !== null) return edgeGapCache
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return FLOAT_EDGE_GAP_FALLBACK
  const token = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sem-space-xl'))
  edgeGapCache = Number.isFinite(token) && token > 0 ? token : FLOAT_EDGE_GAP_FALLBACK
  return edgeGapCache
}

export type FloatRect = { left: number; top: number; width: number; height: number }

/**
 * The rectangle drawn for a stored or dragged position. The size is always the
 * miniature's own: a size saved by an older, resizable player is ignored, so
 * every player reads as the same small thumbnail.
 */
function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): FloatRect {
  const EDGE_GAP = edgeGap()
  const width = FLOAT_DEFAULT_WIDTH
  const height = FLOAT_DEFAULT_HEIGHT
  const maxLeft = Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP)
  const maxTop = Math.max(EDGE_GAP, viewport.height - height - EDGE_GAP)
  return {
    left: Math.min(Math.max(rect.x, EDGE_GAP), maxLeft),
    top: Math.min(Math.max(rect.y, EDGE_GAP), maxTop),
    width,
    height,
  }
}

/** The default corner: bottom-right, where a video player parks. */
function defaultRect(viewport: { width: number; height: number }): {
  x: number
  y: number
  width: number
  height: number
} {
  const EDGE_GAP = edgeGap()
  return {
    x: viewport.width - FLOAT_DEFAULT_WIDTH - EDGE_GAP,
    y: viewport.height - FLOAT_DEFAULT_HEIGHT - EDGE_GAP,
    width: FLOAT_DEFAULT_WIDTH,
    height: FLOAT_DEFAULT_HEIGHT,
  }
}

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * The default corner lifted clear of the chat's composer, when the two would
 * overlap: a player parked over the field the person types into, or over its
 * send button, is in the way of the one thing they came to do. Lifted only as
 * far as sitting just above it; when the window is too short for that the
 * corner stands, since a player that is somewhere beats one that is nowhere.
 */
export function clearOfComposer(
  rect: { x: number; y: number; width: number; height: number },
  composer: Box | null,
): { x: number; y: number; width: number; height: number } {
  if (!composer) return rect
  const overlaps =
    rect.x < composer.right &&
    rect.x + rect.width > composer.left &&
    rect.y < composer.bottom &&
    rect.y + rect.height > composer.top
  if (!overlaps) return rect
  const EDGE_GAP = edgeGap()
  const lifted = composer.top - EDGE_GAP - rect.height
  return lifted >= EDGE_GAP ? { ...rect, y: lifted } : rect
}

/** The composer on screen in this window, if a chat is showing one. */
function visibleComposerBox(): Box | null {
  // Every chat tab keeps its composer mounted. A workspace kept warm behind
  // the one on screen is `invisible` (laid out, not drawn), so a box alone
  // does not say it is the composer the person sees.
  for (const frame of document.querySelectorAll<HTMLElement>('[data-chat-composer]')) {
    if (frame.closest('[hidden], [inert], [aria-hidden="true"], .invisible')) continue
    const check = (frame as HTMLElement & { checkVisibility?: (options?: object) => boolean }).checkVisibility
    if (typeof check === 'function' && !check.call(frame, { visibilityProperty: true })) continue
    const box = frame.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) return box
  }
  return null
}

/**
 * The rectangle to draw the player at, clamped to the live window.
 *
 * Null when nothing is floating. Recomputed on resize so a window dragged
 * smaller pulls the player back in rather than leaving it off the edge. A
 * player with no rect of its own yet takes the default corner, lifted clear
 * of the composer.
 */
export function useFloatRect(workspaceId: WorkspaceId, tab: WorkspacePaneTab | null): FloatRect | null {
  const stored = tab?.float
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const tabId = tab?.id ?? null
  // Read once per player and window size, not per render: the composer only
  // moves when the window does.
  const fallback = useMemo(
    () => (tabId === null ? null : clearOfComposer(defaultRect(viewport), visibleComposerBox())),
    [tabId, viewport],
  )
  if (!tab || !fallback) return null
  void workspaceId
  return clampRect(stored ?? fallback, viewport)
}

type ChromeProps = {
  workspaceId: WorkspaceId
  tab: WorkspacePaneTab
  rect: FloatRect
}

/**
 * Laid over the miniature: the whole player is the handle that drags it, and a
 * hover (or keyboard focus) shows Open in its middle, which takes the page to
 * the browser pane, and a Close in its corner that puts the miniature away.
 *
 * Nothing shows at rest (owner ruling 2026-10-10). The miniature is there to
 * say an agent is looking at something, and a title bar, an address field and
 * a row of page controls over a 320px picture of a page drowned out the page.
 * Everything those controls did is one click away in the pane.
 */
export function FloatingPlayerChrome({ workspaceId, tab, rect }: ChromeProps) {
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const setPaneTabFloating = useWorkspaceStore((s) => s.setPaneTabFloating)
  const dismissPaneTabFloat = useWorkspaceStore((s) => s.dismissPaneTabFloat)
  // The live position during a drag. Written straight to the store on
  // pointer-up so no frame pays for a persisted-registry re-serialization; the
  // same idiom the aside column's resize uses.
  const drag = useRef<{ startX: number; startY: number; rect: FloatRect } | null>(null)

  const open = useCallback(
    () => setPaneTabFloating(workspaceId, tab.id, false),
    [setPaneTabFloating, workspaceId, tab.id],
  )
  const close = useCallback(() => {
    // Down for the rest of this agent session, or the agent's next step would
    // bring it straight back up (agentBrowserFloat.AGENT_SESSION_QUIET_MS).
    agentBrowserTracker.dismiss(tab.id, Date.now())
    dismissPaneTabFloat(workspaceId, tab.id)
  }, [dismissPaneTabFloat, workspaceId, tab.id])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Left button only: a right-click is a context menu, not a drag.
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { startX: event.clientX, startY: event.clientY, rect }
    },
    [rect],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current) return
    const next = clampRect(
      {
        x: current.rect.left + event.clientX - current.startX,
        y: current.rect.top + event.clientY - current.startY,
        width: current.rect.width,
        height: current.rect.height,
      },
      { width: window.innerWidth, height: window.innerHeight },
    )
    // The panel is the element being moved; writing straight to its style keeps
    // the drag at pointer speed instead of one store write per frame.
    const panel = event.currentTarget.closest('[role="tabpanel"]') as HTMLElement | null
    if (panel) {
      panel.style.left = `${next.left}px`
      panel.style.top = `${next.top}px`
    }
  }, [])

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const current = drag.current
      if (!current) return
      drag.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      const panel = event.currentTarget.closest('[role="tabpanel"]') as HTMLElement | null
      if (!panel) return
      // `getBoundingClientRect`, not `offsetLeft`: a fixed element has no
      // offsetParent, and the border box is what `left`/`top` were written as,
      // so this round-trips exactly.
      const box = panel.getBoundingClientRect()
      updatePaneTab(workspaceId, tab.id, {
        float: { x: Math.round(box.left), y: Math.round(box.top), width: rect.width, height: rect.height },
      })
    },
    [rect.height, rect.width, tab.id, updatePaneTab, workspaceId],
  )

  // The buttons own their own presses; without this a press on one starts a
  // drag, and a double-click on one opens the pane twice over.
  const stopDrag = (event: React.SyntheticEvent) => event.stopPropagation()

  return (
    <div
      // Above the page, which is a picture here: it takes no pointer of its own
      // (BrowserTab), so a press anywhere on the miniature is a drag.
      // Double-clicking it opens the page, the way double-clicking a thumbnail
      // opens what it shows.
      className="group absolute inset-0 z-[var(--z-float)] cursor-grab active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={open}
    >
      {/* No scrim: the page stays as bright under the pointer as at rest, and
          the one action rides on top of it, as on a video thumbnail. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <FloatingButton
          size="xs"
          className="pointer-events-auto"
          onPointerDown={stopDrag}
          onDoubleClick={stopDrag}
          onClick={open}
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
            <path
              d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Open
        </FloatingButton>
        <span className="pointer-events-auto absolute right-1.5 top-1.5 rounded-[var(--radius-sm)] bg-[color:var(--composer-surface)]">
          <Tooltip content="Close" placement="bottom">
            <CloseIconButton
              size="3xs"
              aria-label={tab.kind === 'canvas' ? 'Close the floating board' : 'Close the floating browser'}
              onPointerDown={stopDrag}
              onDoubleClick={stopDrag}
              onClick={close}
            />
          </Tooltip>
        </span>
      </div>
    </div>
  )
}
