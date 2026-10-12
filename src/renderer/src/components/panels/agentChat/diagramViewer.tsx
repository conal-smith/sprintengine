import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { scopeDiagramIds } from '../../../lib/diagram/mermaidDiagram'
import { GhostButton, IconButton, Tooltip } from '../../ui'
import { Modal, ModalHeader } from '../../ui/Modal'
import { EnlargeGlyph, ZoomInGlyph, ZoomOutGlyph } from '../../ui/CodeBlockGlyphs'
import {
  DIAGRAM_ZOOM_STEPS,
  diagramSize,
  diagramZoomKey,
  diagramZoomLabel,
  fitDiagramZoom,
  zoomDiagramIn,
  zoomDiagramOut,
  type DiagramSize,
} from './diagramViewerModel'

// A diagram drawn in a reply is held to the chat's column, and a large one —
// a sequence across eight services, a flowchart with thirty boxes — shrinks
// there until its labels cannot be read. The viewer opens the same drawing in
// a dialog as large as the window allows, fitted to it, with zoom buttons and
// the keys a person expects (+, - and 0) for a closer look and the dialog's
// own scrolling to move around at that size.
//
// Nothing is drawn again: the viewer takes the SVG the block already holds,
// already sanitized on its way out of the renderer, so opening it costs one
// copy of markup and no renderer run.

let viewerCopies = 0

// Room left around the drawing inside the scroll area, so a fitted diagram
// does not sit against the dialog's edges.
const FIT_INSET_PX = 48

/** The header action that opens a drawn diagram larger. */
export function OpenDiagramButton({ svg }: { svg: string }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <Tooltip content="Open diagram">
        <IconButton size="xs" tone="subtle" aria-label="Open diagram" onClick={() => setOpen(true)}>
          <EnlargeGlyph className="size-icon-xs" />
        </IconButton>
      </Tooltip>
      {open ? <DiagramViewer svg={svg} onClose={close} /> : null}
    </>
  )
}

export function DiagramViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const titleId = useId()
  // Ids of its own, as each copy in the transcript has: markers and gradients
  // are found by id, and two copies on one page must not answer for each other.
  const [scope] = useState(() => `diagram-view-${++viewerCopies}`)
  const markup = useMemo(() => scopeDiagramIds(svg, scope), [svg, scope])
  const size = useMemo(() => diagramSize(svg), [svg])
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<DiagramSize | null>(null)
  // 'fit' follows the dialog's size; a number is the person's own choice and
  // stays put when the window changes.
  const [zoom, setZoom] = useState<number | 'fit'>('fit')

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () =>
      setBox({
        width: Math.max(0, scroller.clientWidth - FIT_INSET_PX),
        height: Math.max(0, scroller.clientHeight - FIT_INSET_PX),
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  const fitted = size && box ? fitDiagramZoom(size, box) : 1
  const scale = zoom === 'fit' ? fitted : zoom
  const step = useCallback(
    (direction: 'in' | 'out' | 'fit') => {
      if (direction === 'fit') return setZoom('fit')
      setZoom((current) => {
        const from = current === 'fit' ? fitted : current
        return direction === 'in' ? zoomDiagramIn(from) : zoomDiagramOut(from)
      })
    },
    [fitted],
  )

  // A pinch on a trackpad arrives as a wheel event with the control key held.
  // Listened for directly, not through React, because only a listener that is
  // not passive may keep the page from zooming instead.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      step(event.deltaY < 0 ? 'in' : 'out')
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [step])

  // The keys bare, without the platform modifier: ⌘+ and ⌘- belong to the
  // app's own zoom, which the menu takes before the page sees them. Typed into
  // a field they are text, so a field keeps them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
        return
      const direction = diagramZoomKey(event.key)
      if (!direction) return
      event.preventDefault()
      step(direction)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [step])

  const atMost = scale >= DIAGRAM_ZOOM_STEPS[DIAGRAM_ZOOM_STEPS.length - 1]
  const atLeast = scale <= DIAGRAM_ZOOM_STEPS[0]
  // Without a size of its own the drawing takes the dialog's width, and zoom
  // has nothing to scale.
  const frame = size ? { width: size.width * scale, height: size.height * scale } : undefined

  // Portalled to the body: the block sits inside the transcript's virtual
  // list, whose rows are positioned by transform, and a transformed ancestor
  // becomes the containing block of a fixed scrim — the dialog would open
  // inside the chat column, under the composer, instead of over the window.
  return createPortal(
    <Modal open onClose={onClose} labelledBy={titleId} size="workbench" layout="panel">
      <div className="flex min-h-0 flex-1 flex-col">
        <ModalHeader titleId={titleId} title="Diagram" onClose={onClose} />
        <div className="flex items-center justify-end gap-1 px-6 pb-2 pt-3" role="toolbar" aria-label="Zoom">
          <Tooltip content="Zoom out (-)">
            <IconButton
              size="sm"
              tone="subtle"
              aria-label="Zoom out"
              disabled={!size || atLeast}
              onClick={() => step('out')}
            >
              <ZoomOutGlyph className="size-icon-sm" />
            </IconButton>
          </Tooltip>
          <Tooltip content="Fit to window (0)">
            <GhostButton
              size="sm"
              tone="subtle"
              pressed={zoom === 'fit'}
              disabled={!size}
              aria-label={`Zoom ${diagramZoomLabel(scale)}, fit to window`}
              className="min-w-14 justify-center tabular-nums"
              onClick={() => step('fit')}
            >
              {diagramZoomLabel(scale)}
            </GhostButton>
          </Tooltip>
          <Tooltip content="Zoom in (+)">
            <IconButton
              size="sm"
              tone="subtle"
              aria-label="Zoom in"
              disabled={!size || atMost}
              onClick={() => step('in')}
            >
              <ZoomInGlyph className="size-icon-sm" />
            </IconButton>
          </Tooltip>
        </div>
        <div
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-auto border-t border-[color:var(--border-subtle)]"
          data-diagram-viewer=""
        >
          {/* `min-*-full` centres a drawing smaller than the area and lets a
              larger one scroll from its own top-left corner rather than
              overflowing past the start where scrolling cannot reach. */}
          <div className={`grid min-h-full min-w-full place-items-center p-6${size ? ' w-max' : ''}`}>
            <div
              className={
                size
                  ? '[&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none'
                  : 'w-full [&_svg]:!h-auto [&_svg]:!w-full [&_svg]:!max-w-full'
              }
              style={frame}
              data-zoom={diagramZoomLabel(scale)}
              dangerouslySetInnerHTML={{ __html: markup }}
            />
          </div>
        </div>
      </div>
    </Modal>,
    document.body,
  )
}
