import { expect, test } from 'vitest'
import { readConversationGoal } from '../src/goal.js'

test('a payload with a goal reads as that goal, and one with goal null as none', () => {
  expect(readConversationGoal({ goal: { objective: ' ship the docs ', status: 'paused' } })).toEqual({
    objective: 'ship the docs',
    status: 'paused',
  })
  expect(readConversationGoal({ goal: null })).toBeNull()
  expect(readConversationGoal({ goal: { objective: '  ', status: 'active' } })).toBeNull()
})

test('a payload that says nothing about a goal leaves the one known in place', () => {
  expect(readConversationGoal({ notice: 'Model changed' })).toBeUndefined()
  expect(readConversationGoal(undefined)).toBeUndefined()
})

test('a status this package does not know reads as a running goal', () => {
  expect(readConversationGoal({ goal: { objective: 'ship the docs', status: 'snoozed' } })?.status).toBe('active')
})
