import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  DIAGRAM_ZOOM_STEPS,
  MAX_DIAGRAM_ZOOM,
  MIN_DIAGRAM_ZOOM,
  diagramSize,
  diagramZoomKey,
  diagramZoomLabel,
  fitDiagramZoom,
  zoomDiagramIn,
  zoomDiagramOut,
} from './diagramViewerModel'

test('a diagram is as big as its root viewBox says', () => {
  const svg =
    '<svg id="d1" width="100%" style="max-width: 812.5px;" viewBox="-8 -8 812.5 430" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
  assert.deepEqual(diagramSize(svg), { width: 812.5, height: 430 })
})

test('a viewBox written with commas reads the same', () => {
  assert.deepEqual(diagramSize("<svg viewBox='0,0,300,120'></svg>"), { width: 300, height: 120 })
})

test('only the root element is read, not a nested drawing', () => {
  const svg = '<svg width="200" height="100"><svg viewBox="0 0 9000 9000"></svg></svg>'
  assert.deepEqual(diagramSize(svg), { width: 200, height: 100 })
})

test('a diagram with no size of its own has none', () => {
  assert.equal(diagramSize('<svg width="100%" height="auto"></svg>'), null)
  assert.equal(diagramSize('<svg viewBox="0 0 0 120"></svg>'), null)
  assert.equal(diagramSize('<div>not a drawing</div>'), null)
  assert.equal(diagramSize(''), null)
})

test('fitting shrinks a large diagram to the box, on its tighter side', () => {
  assert.equal(fitDiagramZoom({ width: 2000, height: 500 }, { width: 1000, height: 600 }), 0.5)
  assert.equal(fitDiagramZoom({ width: 400, height: 1600 }, { width: 1000, height: 800 }), 0.5)
})

test('fitting enlarges a small diagram, but never past twice its size', () => {
  assert.equal(fitDiagramZoom({ width: 400, height: 300 }, { width: 600, height: 600 }), 1.5)
  assert.equal(fitDiagramZoom({ width: 100, height: 50 }, { width: 1000, height: 600 }), 2)
})

test('fitting stays inside the zoom range, and an unmeasured box leaves the diagram at its size', () => {
  assert.equal(fitDiagramZoom({ width: 100_000, height: 100 }, { width: 1000, height: 600 }), MIN_DIAGRAM_ZOOM)
  assert.equal(fitDiagramZoom({ width: 400, height: 300 }, { width: 0, height: 0 }), 1)
})

test('zooming walks the stops, and in then out lands where it started', () => {
  assert.equal(zoomDiagramIn(1), 1.25)
  assert.equal(zoomDiagramOut(1), 0.9)
  for (const step of DIAGRAM_ZOOM_STEPS.slice(1, -1)) assert.equal(zoomDiagramOut(zoomDiagramIn(step)), step)
})

test('zooming from a fitted scale goes to the next stop past it', () => {
  assert.equal(zoomDiagramIn(0.61), 0.67)
  assert.equal(zoomDiagramOut(0.61), 0.5)
  // A hair off a stop is that stop, so the step is not swallowed.
  assert.equal(zoomDiagramIn(0.999), 1.25)
})

test('zooming stops at both ends', () => {
  assert.equal(zoomDiagramIn(MAX_DIAGRAM_ZOOM), MAX_DIAGRAM_ZOOM)
  assert.equal(zoomDiagramOut(MIN_DIAGRAM_ZOOM), MIN_DIAGRAM_ZOOM)
})

test('the readout is a whole percentage', () => {
  assert.equal(diagramZoomLabel(1), '100%')
  assert.equal(diagramZoomLabel(0.333), '33%')
  assert.equal(diagramZoomLabel(0.6666), '67%')
})

test('the viewer answers +, - and 0, shifted or not, and nothing else', () => {
  assert.equal(diagramZoomKey('+'), 'in')
  assert.equal(diagramZoomKey('='), 'in')
  assert.equal(diagramZoomKey('-'), 'out')
  assert.equal(diagramZoomKey('_'), 'out')
  assert.equal(diagramZoomKey('0'), 'fit')
  assert.equal(diagramZoomKey('f'), null)
  assert.equal(diagramZoomKey('Escape'), null)
})
