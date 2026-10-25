// A message scheduled into a chat for a time, kept and sent by the desktop the
// chat runs on: `scheduleSend`, `sendScheduledNow`, `cancelScheduled`,
// `watchScheduled` and the `scheduled` frame, each read as the contract says
// and refused where it must be, with what an older desktop does with each.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationFrame } from '../src/index'
import { CONVERSATION_COMMAND_KINDS, CONVERSATION_MAX_SCHEDULED_MESSAGES } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_SCHEDULED_SENDS_CAPABILITY } from '../src/handshake'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { isKnownConversationServerFrameType, parseConversationServerFrame } from '../src/serverFrames'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const command = (body: Record<string, unknown>, commandId = 'cmd-1') => ({ type: 'command', commandId, command: body })
const SEND_AT = Date.UTC(2026, 9, 26, 7, 0)

test('the capability and the command kinds are named in the contract', () => {
  assert.equal(CONVERSATION_SCHEDULED_SENDS_CAPABILITY, 'conversation-scheduled-sends')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_SCHEDULED_SENDS_CAPABILITY))
  for (const kind of ['scheduleSend', 'sendScheduledNow', 'cancelScheduled'] as const)
    assert.ok(CONVERSATION_COMMAND_KINDS.includes(kind), kind)
})

test('a scheduled send is its words and its time, and nothing else rides with it', () => {
  assert.deepEqual(
    parseConversationClientMessage(
      command({ kind: 'scheduleSend', message: 'Carry on with the docs.', sendAt: SEND_AT, uploadIds: ['u-1'] }),
    ),
    {
      type: 'command',
      commandId: 'cmd-1',
      command: { kind: 'scheduleSend', message: 'Carry on with the docs.', sendAt: SEND_AT },
    },
  )
})

test('a scheduled send without words or a time is a bad frame, not one the desktop does not know', () => {
  for (const body of [
    { message: '', sendAt: SEND_AT },
    { message: '   ', sendAt: SEND_AT },
    { message: 7, sendAt: SEND_AT },
    { message: 'x' },
    { message: 'x', sendAt: 0 },
    { message: 'x', sendAt: 1.5 },
    { message: 'x', sendAt: '2026-10-26' },
  ]) {
    const frame = command({ kind: 'scheduleSend', ...body })
    assert.equal(parseConversationClientMessage(frame), null, JSON.stringify(body))
    assert.equal(explainRejectedConversationMessage(frame).code, 'invalid_frame', JSON.stringify(body))
  }
})

test('Send now and Delete name a scheduled message by its id; a malformed one is a bad frame', () => {
  for (const kind of ['sendScheduledNow', 'cancelScheduled'] as const) {
    assert.deepEqual(parseConversationClientMessage(command({ kind, scheduledId: 'sm-1', note: 1 })), {
      type: 'command',
      commandId: 'cmd-1',
      command: { kind, scheduledId: 'sm-1' },
    })
    for (const scheduledId of [undefined, '', 7, 'x'.repeat(201)]) {
      const frame = command({ kind, scheduledId })
      assert.equal(parseConversationClientMessage(frame), null)
      assert.equal(explainRejectedConversationMessage(frame).code, 'invalid_frame')
    }
  }
})

test('an older desktop knows none of the kinds, and says so under the command id', () => {
  for (const body of [
    { kind: 'scheduleSend', message: 'x', sendAt: SEND_AT },
    { kind: 'sendScheduledNow', scheduledId: 'sm-1' },
    { kind: 'cancelScheduled', scheduledId: 'sm-1' },
  ]) {
    const rejection = explainRejectedConversationFrame(command(body))
    assert.equal(rejection.code, 'unsupported_command', body.kind)
    assert.equal(rejection.commandId, 'cmd-1')
  }
})

test('watchScheduled is a request of its own', () => {
  assert.deepEqual(parseConversationClientMessage({ type: 'watchScheduled', requestId: 'r-1' }), {
    type: 'watchScheduled',
    requestId: 'r-1',
  })
  assert.equal(parseConversationClientMessage({ type: 'watchScheduled' }), null)
})

test('a scheduled frame keeps what each message says, and skips one it cannot read', () => {
  assert.equal(isKnownConversationServerFrameType({ type: 'scheduled' }), true)
  const frame = parseConversationServerFrame({
    type: 'scheduled',
    key,
    messages: [
      { id: 'sm-1', text: 'At seven.', sendAt: SEND_AT, createdAt: 1, extra: true },
      { id: 'sm-2', text: 'Waiting.', sendAt: 5, createdAt: 2, waitingSince: 6 },
      { id: 'sm-3', text: 'Going.', sendAt: 5, createdAt: 3, sending: true },
      { id: 'sm-4', text: 'Refused.', sendAt: 5, createdAt: 4, failure: 'The chat has no folder here' },
      { id: 'sm-5', text: 'No time.', createdAt: 5 },
      { id: '', text: 'No id.', sendAt: 5, createdAt: 5 },
      'not a message',
    ],
  })
  assert.deepEqual(frame, {
    type: 'scheduled',
    key,
    messages: [
      { id: 'sm-1', text: 'At seven.', sendAt: SEND_AT, createdAt: 1 },
      { id: 'sm-2', text: 'Waiting.', sendAt: 5, createdAt: 2, waitingSince: 6 },
      { id: 'sm-3', text: 'Going.', sendAt: 5, createdAt: 3, sending: true },
      { id: 'sm-4', text: 'Refused.', sendAt: 5, createdAt: 4, failure: 'The chat has no folder here' },
    ],
  })
})

test('a scheduled frame names at most the bound, and is refused without its key', () => {
  const many = Array.from({ length: CONVERSATION_MAX_SCHEDULED_MESSAGES + 5 }, (_, index) => ({
    id: `sm-${index}`,
    text: 'x',
    sendAt: SEND_AT,
    createdAt: 1,
  }))
  const frame = parseConversationServerFrame({ type: 'scheduled', key, messages: many })
  assert.ok(frame?.type === 'scheduled')
  assert.equal(frame.messages.length, CONVERSATION_MAX_SCHEDULED_MESSAGES)
  assert.equal(parseConversationServerFrame({ type: 'scheduled', messages: [] }), null)
  assert.equal(parseConversationServerFrame({ type: 'scheduled', key, messages: 'none' }), null)
})
