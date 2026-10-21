// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { TimelineMinimap, minimapIndexAtPointer, minimapTickTop } from './TimelineMinimap'
import { fixedTurnPosition, type TurnMark, type TurnNavigation } from './turnNavigation'

const marks = (count: number): TurnMark[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `u${index}`,
    rowIndex: index * 2,
    prompt: `Prompt ${index}`,
  }))

const navigation = (count: number, current: number): TurnNavigation => ({
  marks: marks(count),
  position: fixedTurnPosition({ current, hasPrevious: current > 0, hasNext: current < count - 1 }),
  jump: vi.fn(),
  step: vi.fn(),
  reply: (index) => `Reply ${index}`,
  wheel: vi.fn(),
})

test('ticks spread evenly over the strip and the pointer picks the nearest', () => {
  expect(minimapTickTop(0, 5)).toBe(0)
  expect(minimapTickTop(2, 5)).toBe(50)
  expect(minimapTickTop(4, 5)).toBe(100)
  expect(minimapTickTop(0, 1)).toBe(0)
  expect(minimapIndexAtPointer(5, 100, 40, 100)).toBe(0)
  expect(minimapIndexAtPointer(5, 100, 40, 119)).toBe(2)
  expect(minimapIndexAtPointer(5, 100, 40, 400)).toBe(4)
  expect(minimapIndexAtPointer(5, 100, 40, 0)).toBe(0)
})

test('the minimap stays away until the conversation has three prompts', () => {
  expect(renderToStaticMarkup(<TimelineMinimap navigation={navigation(2, 0)} />)).toBe('')
  const html = renderToStaticMarkup(<TimelineMinimap navigation={navigation(3, 0)} />)
  expect(html).toContain('aria-label="Conversation turns"')
  expect(html.match(/data-current="true"/g)).toHaveLength(1)
  expect(html).toMatch(/aria-label="Previous turn" disabled=""/)
  expect(html).not.toMatch(/aria-label="Next turn" disabled=""/)
  // Chrome only: the step buttons reveal on hover and on keyboard focus alike.
  expect(html).toContain('group-focus-within/minimap:opacity-100')
})

// Mounts a five-turn minimap whose strip spans y 0-40, so y 40 is the last turn.
function mountMinimap(): { strip: HTMLElement; unmount: () => void } {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(<TimelineMinimap navigation={navigation(5, 0)} />))
  const strip = host.querySelector<HTMLElement>('[data-minimap-strip]')!
  strip.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 16, width: 16 }) as DOMRect
  return {
    strip,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

const mouse = (target: EventTarget, type: string, clientY: number, buttons: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY, buttons }))
  })

test('a selection dragged onto the strip passes through to the text until the button comes up', () => {
  const { strip, unmount } = mountMinimap()
  mouse(strip, 'mousemove', 20, 1)
  expect(strip.dataset.expanded).toBeUndefined()
  expect(strip.textContent).toBe('')
  expect(strip.className).toContain('pointer-events-none')
  for (const button of document.querySelectorAll('[aria-label$="turn"]')) {
    expect(button.className).toContain('pointer-events-none')
  }
  // Still held: the selection carries on over the text.
  mouse(window, 'mousemove', 30, 1)
  expect(strip.dataset.passThrough).toBe('true')
  mouse(window, 'mouseup', 30, 0)
  expect(strip.dataset.passThrough).toBeUndefined()
  expect(strip.className).toContain('pointer-events-auto')
  unmount()
})

test('a move without the button held ends the pass-through when the release was missed', () => {
  const { strip, unmount } = mountMinimap()
  mouse(strip, 'mousemove', 20, 1)
  expect(strip.dataset.passThrough).toBe('true')
  mouse(window, 'mousemove', 20, 0)
  expect(strip.dataset.passThrough).toBeUndefined()
  unmount()
})

test('a press on the strip still scrubs through the turns with the button held', () => {
  const { strip, unmount } = mountMinimap()
  mouse(strip, 'mousedown', 0, 1)
  mouse(strip, 'mousemove', 0, 1)
  expect(strip.dataset.expanded).toBe('true')
  expect(strip.textContent).toContain('Prompt 0')
  mouse(strip, 'mousemove', 40, 1)
  expect(strip.textContent).toContain('Prompt 4')
  expect(strip.dataset.passThrough).toBeUndefined()
  unmount()
})

test('a plain hover opens the preview', () => {
  const { strip, unmount } = mountMinimap()
  mouse(strip, 'mousemove', 20, 0)
  expect(strip.dataset.expanded).toBe('true')
  expect(strip.textContent).toContain('Prompt 2')
  expect(strip.textContent).toContain('Reply 2')
  unmount()
})

test('the hover preview shows a markdown reply as its words, and the prompt as typed', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  const withMarkdown: TurnNavigation = {
    ...navigation(3, 0),
    marks: [...marks(2), { id: 'u2', rowIndex: 4, prompt: 'Why does **this** fail?' }],
    reply: () => '## The cause\nThe `login` route reads **an old** [token](https://example.com/token).',
  }
  act(() => root.render(<TimelineMinimap navigation={withMarkdown} />))
  const strip = host.querySelector<HTMLElement>('[data-minimap-strip]')!
  strip.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 16, width: 16 }) as DOMRect
  mouse(strip, 'mousemove', 40, 0)
  expect(strip.textContent).toContain('Why does **this** fail?')
  expect(strip.textContent).toContain('The cause The login route reads an old token.')
  expect(strip.textContent).not.toContain('https://example.com')
  act(() => root.unmount())
  host.remove()
})
