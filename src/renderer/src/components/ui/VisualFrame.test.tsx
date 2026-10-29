// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { VISUAL_FRAME_MAX_HEIGHT, VisualFrame } from './VisualFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(): HTMLIFrameElement {
  act(() => root.render(<VisualFrame srcDoc="<p>Chart</p>" title="Weekly active users" />))
  return container.querySelector('iframe')!
}

// jsdom lays nothing out: the frame's document is given the height it would have.
function loadAt(frame: HTMLIFrameElement, height: number): void {
  const body = frame.contentDocument!.body
  body.getBoundingClientRect = () => ({ height }) as DOMRect
  act(() => void frame.dispatchEvent(new Event('load')))
}

test('the frame runs nothing: its sandbox grants the origin, to be measured, and no scripts', () => {
  const frame = render()
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
  expect(frame.getAttribute('title')).toBe('Weekly active users')
  expect(frame.getAttribute('loading')).toBe('lazy')
  expect(frame.getAttribute('srcdoc')).toBe('<p>Chart</p>')
})

test('the frame is as tall as its document, up to the cap', () => {
  const frame = render()
  // A reservation until it has loaded.
  expect(frame.style.height).toBe('160px')
  loadAt(frame, 312.4)
  expect(frame.style.height).toBe('313px')
  loadAt(frame, 4000)
  expect(frame.style.height).toBe(`${VISUAL_FRAME_MAX_HEIGHT}px`)
  // A document that measures nothing keeps the height it has.
  loadAt(frame, 0)
  expect(frame.style.height).toBe(`${VISUAL_FRAME_MAX_HEIGHT}px`)
})
