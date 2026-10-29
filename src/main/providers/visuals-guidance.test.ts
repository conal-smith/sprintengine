import assert from 'node:assert/strict'
import { test } from 'vitest'
import { VISUALS_INSTRUCTION } from './visuals-guidance'

test('a chat is told, plainly, to show a chart as a visual block', () => {
  // Drawn when it helps, not only when asked, and only in the fence the chat draws.
  assert.match(VISUALS_INSTRUCTION, /```visual/)
  assert.match(VISUALS_INSTRUCTION, /even if not asked/)
  // What keeps it inert and in the window's colours.
  assert.match(VISUALS_INSTRUCTION, /No scripts/)
  assert.match(VISUALS_INSTRUCTION, /no remote images, fonts or CSS/)
  for (const variable of ['--chart-1', '--chart-8', '--fg', '--fg-muted', '--border'])
    assert.ok(VISUALS_INSTRUCTION.includes(`var(${variable})`), variable)
  assert.match(VISUALS_INSTRUCTION, /fixed pixel height/)
  assert.match(VISUALS_INSTRUCTION, /No vh units/)
  assert.match(VISUALS_INSTRUCTION, /title and a one-line caption/)
  assert.match(VISUALS_INSTRUCTION, /Do not restate/)
  // Short on purpose: it goes with every chat.
  assert.ok(VISUALS_INSTRUCTION.length < 1000)
})
