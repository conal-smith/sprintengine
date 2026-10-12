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
