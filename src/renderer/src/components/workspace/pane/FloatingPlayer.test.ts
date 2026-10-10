import assert from 'node:assert/strict'
import { test } from 'vitest'

import { FLOAT_DEFAULT_HEIGHT, FLOAT_DEFAULT_WIDTH } from '../../../store/slices/workspacePaneSlice'
import { FLOAT_EDGE_GAP_FALLBACK as GAP, clearOfComposer } from './FloatingPlayer'

// Where the miniature parks when it first comes up: the bottom-right corner,
// lifted clear of the composer when the two would overlap.

const corner = { x: 1064, y: 684, width: FLOAT_DEFAULT_WIDTH, height: FLOAT_DEFAULT_HEIGHT }

test('the default corner is lifted clear of the composer when they would overlap', () => {
  const composer = { left: 490, top: 737, right: 1258, bottom: 880 }
  assert.deepEqual(clearOfComposer(corner, composer), { ...corner, y: 737 - GAP - FLOAT_DEFAULT_HEIGHT })
})

test('the default corner stands when it clears the composer, or there is no room above it', () => {
  assert.deepEqual(clearOfComposer(corner, null), corner)
  assert.deepEqual(clearOfComposer(corner, { left: 100, top: 737, right: 900, bottom: 880 }), corner)
  assert.deepEqual(clearOfComposer(corner, { left: 490, top: 120, right: 1258, bottom: 880 }), corner)
})
