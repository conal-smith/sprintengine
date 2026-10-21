// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { cancelNextMiddleButtonRelease } from './middleButtonRelease'

function release(button: number, target: EventTarget = document.body): MouseEvent {
  const event = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function press(button: number): void {
  document.body.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true, cancelable: true }))
}

afterEach(() => {
  // Leave no armed listener behind for the next case.
  press(0)
})

test('the middle release after arming is cancelled wherever it lands', () => {
  const elsewhere = document.body.appendChild(document.createElement('div'))
  cancelNextMiddleButtonRelease(window)
  expect(release(1, elsewhere).defaultPrevented).toBe(true)
  elsewhere.remove()
})

test('only that one release is cancelled', () => {
  cancelNextMiddleButtonRelease(window)
  release(1)
  expect(release(1).defaultPrevented).toBe(false)
})

test('a release of another button is left alone and keeps it armed', () => {
  cancelNextMiddleButtonRelease(window)
  expect(release(0).defaultPrevented).toBe(false)
  expect(release(2).defaultPrevented).toBe(false)
  expect(release(1).defaultPrevented).toBe(true)
})

test('a new press disarms it, so a later middle-click paste goes through', () => {
  cancelNextMiddleButtonRelease(window)
  press(1)
  expect(release(1).defaultPrevented).toBe(false)
})

test('a middle release with nothing armed is left alone', () => {
  expect(release(1).defaultPrevented).toBe(false)
})
