import assert from 'node:assert/strict'

import { test } from 'vitest'

import { tabReorderSlot, tabReorderTargetIndex } from './tabReorder'

// Three tabs whose middles sit at 50, 150 and 250.
const MIDDLES = [50, 150, 250]

test('the slot is the number of tab middles left of the pointer', () => {
  assert.equal(tabReorderSlot(MIDDLES, 10), 0, 'before the first tab')
  assert.equal(tabReorderSlot(MIDDLES, 51), 1, 'past the first middle is after the first tab')
  assert.equal(tabReorderSlot(MIDDLES, 149), 1)
  assert.equal(tabReorderSlot(MIDDLES, 400), 3, 'past the last tab')
  assert.equal(tabReorderSlot([], 400), 0)
})

test('a slot right of the dragged tab counts the place the tab left', () => {
  assert.equal(tabReorderTargetIndex(3, 0), 2, 'first to last')
  assert.equal(tabReorderTargetIndex(0, 2), 0, 'last to first')
  assert.equal(tabReorderTargetIndex(2, 0), 1)
})

test('the two slots either side of the tab leave it where it is', () => {
  assert.equal(tabReorderTargetIndex(1, 1), 1)
  assert.equal(tabReorderTargetIndex(2, 1), 1)
})
