import assert from 'node:assert/strict'
import { test } from 'vitest'

import { SCHEDULED_MESSAGES_HOLD_CHANNEL } from '../../shared/scheduled-messages'
import type { ScheduledMessages } from '../scheduled-messages/scheduled-messages'
import { registerScheduledMessagesIpc } from './scheduled-messages-ipc'

// A window's own queued message is held by main under the window's id for it,
// kept apart from a paired machine's command ids, and refused in words when it
// is not one main can keep.

function harness(answer: ReturnType<ScheduledMessages['hold']> = { ok: true, id: 'held-1' }) {
  const holds: unknown[][] = []
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  const scheduled = {
    state: () => ({ messages: [] }),
    update: () => ({ messages: [] }),
    onChanged: () => () => undefined,
    hold: (...args: unknown[]) => {
      holds.push(args)
      return answer
    },
  } as unknown as ScheduledMessages
  registerScheduledMessagesIpc(
    { handle: (channel: string, handler: never) => handlers.set(channel, handler) } as never,
    scheduled,
  )
  return { holds, hold: (input: unknown) => handlers.get(SCHEDULED_MESSAGES_HOLD_CHANNEL)!({}, input) }
}

test('a window queued message is held for the chat, under the window’s id for it', () => {
  const h = harness()
  const answer = h.hold({ workspaceId: 'w1', agentId: 'agent-1', text: '  use staging  ', source: 'local-7' })
  assert.deepEqual(answer, { ok: true, id: 'held-1' })
  assert.deepEqual(h.holds, [[{ workspaceId: 'w1', agentId: 'agent-1' }, 'use staging', 'window:local-7']])
})

test('one main cannot keep is refused in words, and nothing is held', () => {
  const h = harness()
  for (const input of [
    null,
    { workspaceId: 'w1', agentId: 'agent-1', text: '   ', source: 's' },
    { workspaceId: 'w1', agentId: 'agent-1', text: 'x'.repeat(100_001), source: 's' },
    { workspaceId: 'w1', agentId: 'agent-1', text: 'hi' },
  ]) {
    const answer = h.hold(input) as { ok: boolean; reason?: string }
    assert.equal(answer.ok, false)
    assert.ok(answer.reason)
  }
  assert.deepEqual(h.holds, [])
})

test('main’s own refusal is passed on', () => {
  const h = harness({ ok: false, reason: 'Too many messages are waiting in this chat.' })
  assert.deepEqual(h.hold({ workspaceId: 'w1', agentId: 'agent-1', text: 'hi', source: 's' }), {
    ok: false,
    reason: 'Too many messages are waiting in this chat.',
  })
})
