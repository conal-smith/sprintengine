import assert from 'node:assert/strict'
import { test } from 'vitest'

import { chatStatusRank, orderByStatus, STATUS_FINISHED_UNSEEN, STATUS_REST, STATUS_WAITING } from './statusOrder'

test('blocked and failed chats wait on the person; a finish nobody saw comes next; the rest after', () => {
  assert.equal(chatStatusRank({ activity: 'needs-input', unseenDone: false }), STATUS_WAITING)
  assert.equal(chatStatusRank({ activity: 'failed', unseenDone: true }), STATUS_WAITING)
  assert.equal(chatStatusRank({ activity: 'idle', unseenDone: true }), STATUS_FINISHED_UNSEEN)
  assert.equal(chatStatusRank({ activity: 'idle', unseenDone: false }), STATUS_REST)
  assert.equal(chatStatusRank({ activity: undefined, unseenDone: false }), STATUS_REST)
})

test('each band keeps the order the chats came in', () => {
  const ranks: Record<string, number> = { a: 2, b: 0, c: 1, d: 2, e: 0 }
  assert.deepEqual(
    orderByStatus(['a', 'b', 'c', 'd', 'e'], (id) => ranks[id]!),
    ['b', 'e', 'c', 'a', 'd'],
  )
})
