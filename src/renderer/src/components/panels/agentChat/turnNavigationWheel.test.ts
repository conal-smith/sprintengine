// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { forwardWheel } from './turnNavigation'

function scroller(height = 600) {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientHeight', { value: height })
  const scrollBy = vi.fn()
  element.scrollBy = scrollBy as unknown as HTMLElement['scrollBy']
  return { element, scrollBy }
}

const wheel = (init: WheelEventInit) => new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init })

test('a wheel over the minimap scrolls the transcript by the same distance', () => {
  const { element, scrollBy } = scroller()
  const event = wheel({ deltaY: 120 })
  forwardWheel(event, element)
  expect(scrollBy).toHaveBeenCalledWith({ top: 120 })
  expect(event.defaultPrevented).toBe(true)
})

test('a wheel that counts lines or pages is turned into pixels', () => {
  const lines = scroller()
  forwardWheel(wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE }), lines.element)
  expect(lines.scrollBy).toHaveBeenCalledWith({ top: 48 })
  const pages = scroller(600)
  forwardWheel(wheel({ deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE }), pages.element)
  expect(pages.scrollBy).toHaveBeenCalledWith({ top: -600 })
})

test("the transcript's own wheel listeners hear the forwarded wheel", () => {
  const { element, scrollBy } = scroller()
  const heard = vi.fn()
  element.addEventListener('wheel', heard)
  forwardWheel(wheel({ deltaY: 40 }), element)
  expect(heard).toHaveBeenCalledTimes(1)
  expect(scrollBy).toHaveBeenCalledTimes(1)
})

test('a pinch, a sideways wheel and a wheel already handled are left alone', () => {
  const { element, scrollBy } = scroller()
  const pinch = wheel({ deltaY: 10, ctrlKey: true })
  forwardWheel(pinch, element)
  expect(pinch.defaultPrevented).toBe(false)
  forwardWheel(wheel({ deltaX: 30, deltaY: 0 }), element)
  const handled = wheel({ deltaY: 10 })
  handled.preventDefault()
  forwardWheel(handled, element)
  expect(scrollBy).not.toHaveBeenCalled()
})
