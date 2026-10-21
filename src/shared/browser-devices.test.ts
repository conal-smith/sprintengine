import assert from 'node:assert/strict'
import { test } from 'vitest'

import { fitViewportScale, guestLayoutSize } from './browser-devices'

// A device preset is a CSS size for the page. The app window's own zoom must
// not change it: the guest's element is sized in the window's CSS px, which
// the zoom stretches, so the element is shrunk by the same factor.

test('a device preset in a zoomed window is laid out at the size the preset names', () => {
  assert.deepEqual(guestLayoutSize({ width: 390, height: 844 }, 1.2), { width: 325, height: 844 / 1.2 })
  // What the page sees: the element's width times the window's zoom.
  assert.equal(guestLayoutSize({ width: 390, height: 844 }, 1.2).width * 1.2, 390)
  assert.equal(guestLayoutSize({ width: 1280, height: 800 }, 0.8).width, 1600)
})

test('at window zoom 1, or with no zoom to read, the size is unchanged', () => {
  assert.deepEqual(guestLayoutSize({ width: 390, height: 844 }, 1), { width: 390, height: 844 })
  for (const unreadable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(guestLayoutSize({ width: 390, height: 844 }, unreadable), { width: 390, height: 844 })
  }
})

test('the frame is fitted to the size the guest is laid out at', () => {
  // A 360px-wide pane fits a 390 phone at zoom 1 only by shrinking it; at
  // zoom 1.2 the element is 325 wide and fits as it is.
  const available = { width: 360, height: 1000 }
  assert.ok(fitViewportScale(guestLayoutSize({ width: 390, height: 844 }, 1), available) < 1)
  assert.equal(fitViewportScale(guestLayoutSize({ width: 390, height: 844 }, 1.2), available), 1)
})
