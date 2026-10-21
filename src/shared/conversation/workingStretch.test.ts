import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  WORKING_STRETCH_GAP_MS,
  workingStretchOnReading,
  workingStretchOnTurn,
  workingStretchSince,
} from './workingStretch'

test('a person’s message begins a stretch, and a turn the chat opens by itself carries it on', () => {
  const sent = workingStretchOnTurn(undefined, { at: 1_000, byPerson: true })
  assert.deepEqual(sent, { since: 1_000 })
  // The turn ended with a background agent still out: the chat is busy.
  const between = workingStretchOnReading(sent, { busy: true, at: 5_000 })
  assert.equal(workingStretchSince(between), 1_000)
  const woken = workingStretchOnTurn(between, { at: 60_000, byPerson: false })
  assert.equal(workingStretchSince(woken), 1_000)
  // The person writes again while it works: that is new work.
  assert.equal(workingStretchSince(workingStretchOnTurn(woken, { at: 90_000, byPerson: true })), 90_000)
})

test('a stretch survives the moment between its last agent ending and the turn that agent wakes', () => {
  const held = workingStretchOnTurn(undefined, { at: 1_000, byPerson: true })
  const stopped = workingStretchOnReading(held, { busy: false, at: 10_000 })
  assert.equal(workingStretchSince(stopped), undefined, 'nothing in hand reports no start')
  const woken = workingStretchOnTurn(stopped, { at: 12_000, byPerson: false })
  assert.equal(workingStretchSince(woken), 1_000)
  // An answer to a card brings it back without a turn opening.
  assert.equal(workingStretchSince(workingStretchOnReading(stopped, { busy: true, at: 11_000 })), 1_000)
})

test('a chat that settled with nothing working begins afresh', () => {
  const held = workingStretchOnTurn(undefined, { at: 1_000, byPerson: true })
  const stopped = workingStretchOnReading(held, { busy: false, at: 10_000 })
  const later = 10_000 + WORKING_STRETCH_GAP_MS + 1
  assert.equal(workingStretchSince(workingStretchOnTurn(stopped, { at: later, byPerson: false })), later)
  assert.equal(workingStretchOnReading(stopped, { busy: false, at: later }), undefined, 'and is forgotten')
  // Busy again with no stretch: the turn now running, else the reading's time.
  assert.equal(workingStretchSince(workingStretchOnReading(undefined, { busy: true, at: 9, startedAt: 7 })), 7)
  assert.equal(workingStretchSince(workingStretchOnReading(undefined, { busy: true, at: 9 })), 9)
})
