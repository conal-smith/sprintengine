import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_STALE_SEND_MS, isStaleConversationSend } from '../src/commands'
import { parseConversationClientFrame } from '../src/index'

const frame = (command: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  command: { kind: 'send', message: 'Run the migration', ...command },
})

test('a send keeps when it was written and whether the person confirmed it', () => {
  assert.deepEqual(parseConversationClientMessage(frame({ composedAt: 1_700_000_000_000 })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Run the migration', composedAt: 1_700_000_000_000 },
  })
  assert.deepEqual(parseConversationClientMessage(frame({ composedAt: 5, confirmedStale: true })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Run the migration', composedAt: 5, confirmedStale: true },
  })
})

test('the stamp rides beside a held, steered or skilled send', () => {
  const held = parseConversationClientMessage(frame({ queue: true, composedAt: 9 }))
  assert.deepEqual(held?.type === 'command' && held.command, {
    kind: 'send',
    message: 'Run the migration',
    queue: true,
    composedAt: 9,
  })
  const steered = parseConversationClientMessage(frame({ steer: true, composedAt: 9, confirmedStale: true }))
  assert.deepEqual(steered?.type === 'command' && steered.command, {
    kind: 'send',
    message: 'Run the migration',
    steer: true,
    composedAt: 9,
    confirmedStale: true,
  })
  const skilled = parseConversationClientMessage(frame({ skills: ['review'], composedAt: 9 }))
  assert.deepEqual(skilled?.type === 'command' && skilled.command, {
    kind: 'send',
    message: 'Run the migration',
    skills: ['review'],
    composedAt: 9,
  })
  // A held message is still its words alone.
  assert.equal(parseConversationClientMessage(frame({ queue: true, uploadIds: ['u'], composedAt: 9 })), null)
})

test('a malformed stamp refuses the frame', () => {
  assert.equal(parseConversationClientMessage(frame({ composedAt: -1 })), null)
  assert.equal(parseConversationClientMessage(frame({ composedAt: 1.5 })), null)
  assert.equal(parseConversationClientMessage(frame({ composedAt: '2026-10-19' })), null)
  assert.equal(parseConversationClientMessage(frame({ confirmedStale: false })), null)
})

test('the first version of the lane drops both members, as a desktop from before them does', () => {
  assert.deepEqual(parseConversationClientFrame(frame({ composedAt: 5, confirmedStale: true })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Run the migration' },
  })
})

test('a send is stale only when it says it was written past the limit and was not confirmed', () => {
  const now = 1_700_000_000_000
  assert.equal(isStaleConversationSend({}, now), false)
  assert.equal(isStaleConversationSend({ composedAt: now - CONVERSATION_STALE_SEND_MS }, now), false)
  assert.equal(isStaleConversationSend({ composedAt: now - CONVERSATION_STALE_SEND_MS - 1 }, now), true)
  assert.equal(isStaleConversationSend({ composedAt: now - 23 * 3_600_000, confirmedStale: true }, now), false)
  // A clock ahead of the desktop's is not stale.
  assert.equal(isStaleConversationSend({ composedAt: now + 60_000 }, now), false)
})
