// The arithmetic behind the diagram viewer (diagramViewer.tsx): how big a
// drawn diagram is, the scale that fits it to the dialog, and the steps the
// zoom buttons walk. Pure, so the rules are tested without a layout engine.

export type DiagramSize = { width: number; height: number }

/**
 * Zoom stops, the ones a person reads as round numbers. The buttons walk these
 * rather than multiplying, so zooming in and back out lands where it started.
 */
export const DIAGRAM_ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4] as const
export const MIN_DIAGRAM_ZOOM = DIAGRAM_ZOOM_STEPS[0]
export const MAX_DIAGRAM_ZOOM = DIAGRAM_ZOOM_STEPS[DIAGRAM_ZOOM_STEPS.length - 1]

// Fitting never blows a small diagram up past twice its drawn size: past that
// a three-box flowchart fills a monitor with outlines and says nothing more.
const MAX_FIT_ZOOM = 2

// Two zooms this close are the same stop: fit lands between stops, and a
// rounding error must not make "zoom in" skip the stop it is sitting on.
const SAME_ZOOM = 0.005

const positive = (value: number) => Number.isFinite(value) && value > 0

/**
 * The drawn size of a diagram, from its root element's `viewBox`, which the
 * renderer always writes; `width`/`height` in user units when there is none.
 * Null when neither says, and the viewer then shows the diagram at the
 * dialog's width rather than guessing.
 */
export function diagramSize(svg: string): DiagramSize | null {
  const root = /<svg\b[^>]*>/iu.exec(svg)?.[0]
  if (!root) return null
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'iu').exec(root)?.[1]
  const viewBox = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number)
  if (viewBox?.length === 4 && positive(viewBox[2]!) && positive(viewBox[3]!)) {
    return { width: viewBox[2]!, height: viewBox[3]! }
  }
  // A percentage or a unit is not a size the diagram has on its own.
  const width = Number(attribute('width'))
  const height = Number(attribute('height'))
  return positive(width) && positive(height) ? { width, height } : null
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_DIAGRAM_ZOOM, Math.max(MIN_DIAGRAM_ZOOM, zoom))
}

/** The scale at which the whole diagram fits `box`, never enlarged past `MAX_FIT_ZOOM`. */
export function fitDiagramZoom(size: DiagramSize, box: DiagramSize): number {
  if (!positive(box.width) || !positive(box.height)) return 1
  return clampZoom(Math.min(box.width / size.width, box.height / size.height, MAX_FIT_ZOOM))
}

/** The next stop up from `zoom`, or `zoom` itself at the top. */
export function zoomDiagramIn(zoom: number): number {
  return DIAGRAM_ZOOM_STEPS.find((step) => step > zoom + SAME_ZOOM) ?? MAX_DIAGRAM_ZOOM
}

/** The next stop down from `zoom`, or `zoom` itself at the bottom. */
export function zoomDiagramOut(zoom: number): number {
  return [...DIAGRAM_ZOOM_STEPS].reverse().find((step) => step < zoom - SAME_ZOOM) ?? MIN_DIAGRAM_ZOOM
}

/** What the readout says: a whole percentage. */
export function diagramZoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/** The viewer's own keys: + and - step the zoom, 0 fits. `=` and `_` are the same keys unshifted and shifted. */
export function diagramZoomKey(key: string): 'in' | 'out' | 'fit' | null {
  if (key === '+' || key === '=') return 'in'
  if (key === '-' || key === '_') return 'out'
  if (key === '0') return 'fit'
  return null
}
