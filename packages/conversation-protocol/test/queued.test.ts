// A message queued while a chat is mid-turn, handed to the desktop the chat
// runs on: `send` with `queue`, `cancelQueued`, `watchQueued` and the `queued`
// frame, each read as the contract says and refused where it must be, with
// what an older desktop does with each.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationFrame, parseConversationClientFrame } from '../src/index'
import { CONVERSATION_COMMAND_KINDS, CONVERSATION_MAX_QUEUED_MESSAGES } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_QUEUED_SENDS_CAPABILITY } from '../src/handshake'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { isKnownConversationServerFrameType, parseConversationServerFrame } from '../src/serverFrames'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const command = (body: Record<string, unknown>, commandId = 'cmd-1') => ({ type: 'command', commandId, command: body })

test('the capability and the command are named in the contract', () => {
  assert.equal(CONVERSATION_QUEUED_SENDS_CAPABILITY, 'conversation-queued-sends')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_QUEUED_SENDS_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('cancelQueued'))
})

test('a queued send keeps `queue`; an older desktop drops it and takes an ordinary send', () => {
  const frame = command({ kind: 'send', message: 'Then the docs.', queue: true })
  assert.deepEqual(parseConversationClientMessage(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Then the docs.', queue: true },
  })
  // The fallback the member is shaped for: the first version strips it, and a
  // send made while a turn runs is refused busy, as every send was.
  assert.deepEqual(parseConversationClientFrame(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Then the docs.' },
  })
  // A send that does not say `queue` reads as it always did.
  assert.deepEqual(parseConversationClientMessage(command({ kind: 'send', message: 'Now.' })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Now.' },
  })
})

test('a queued send says `queue` only as true', () => {
  for (const queue of [false, 'yes', 1, null])
    assert.equal(parseConversationClientMessage(command({ kind: 'send', message: 'x', queue })), null, String(queue))
  assert.equal(parseConversationClientMessage(command({ kind: 'send', message: 7, queue: true })), null)
  assert.equal(
    explainRejectedConversationMessage(command({ kind: 'send', message: 'x', queue: 'yes' })).code,
    'invalid_frame',
  )
})

test('a held message is taken back by its id; a malformed one is a bad frame, and unknown to an older desktop', () => {
  assert.deepEqual(parseConversationClientMessage(command({ kind: 'cancelQueued', queuedId: 'sm-1', note: 1 })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'cancelQueued', queuedId: 'sm-1' },
  })
  for (const queuedId of ['', 7, undefined, 'x'.repeat(201)])
    assert.equal(parseConversationClientMessage(command({ kind: 'cancelQueued', queuedId })), null, String(queuedId))
  const malformed = command({ kind: 'cancelQueued' })
  assert.deepEqual(explainRejectedConversationMessage(malformed), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
    commandId: 'cmd-1',
    commandKind: 'cancelQueued',
  })
  // A desktop from before the capability refuses the kind under its command id.
  assert.equal(parseConversationClientFrame(command({ kind: 'cancelQueued', queuedId: 'sm-1' })), null)
  assert.equal(
    explainRejectedConversationFrame(command({ kind: 'cancelQueued', queuedId: 'sm-1' })).code,
    'unsupported_command',
  )
})

test('watchQueued asks under a request id, which an older desktop answers it under', () => {
  assert.deepEqual(parseConversationClientMessage({ type: 'watchQueued', requestId: 'queued-1', extra: true }), {
    type: 'watchQueued',
    requestId: 'queued-1',
  })
  assert.equal(parseConversationClientMessage({ type: 'watchQueued' }), null)
  assert.equal(parseConversationClientFrame({ type: 'watchQueued', requestId: 'queued-1' }), null)
  assert.deepEqual(explainRejectedConversationFrame({ type: 'watchQueued', requestId: 'queued-1' }), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
    requestId: 'queued-1',
  })
})

test('a queued frame is read whole, an unreadable message left out and the rest kept', () => {
  assert.equal(isKnownConversationServerFrameType({ type: 'queued' }), true)
  const frame = parseConversationServerFrame({
    type: 'queued',
    key: { ...key, workspaceRoot: '/Users/dev/app' },
    messages: [
      { id: 'sm-1', text: 'First this.\nThen that.', createdAt: 1_700_000_000_000, extra: 1 },
      { id: 'sm-2', text: 'Refused.', createdAt: 1_700_000_000_500, failure: 'Conversation session is stopped.' },
      { id: '', text: 'no id', createdAt: 1 },
      { id: 'sm-3', text: 7, createdAt: 1 },
      { id: 'sm-4', text: 'no time' },
      'not a message',
    ],
  })
  assert.deepEqual(frame, {
    type: 'queued',
    key,
    messages: [
      { id: 'sm-1', text: 'First this.\nThen that.', createdAt: 1_700_000_000_000 },
      {
        id: 'sm-2',
        text: 'Refused.',
        createdAt: 1_700_000_000_500,
        failure: 'Conversation session is stopped.',
      },
    ],
  })
  assert.deepEqual(parseConversationServerFrame({ type: 'queued', key, messages: [] }), {
    type: 'queued',
    key,
    messages: [],
  })
  // A frame of the type without its key or list is a broken frame, not an empty one.
  assert.equal(parseConversationServerFrame({ type: 'queued', messages: [] }), null)
  assert.equal(parseConversationServerFrame({ type: 'queued', key }), null)
  const many = Array.from({ length: CONVERSATION_MAX_QUEUED_MESSAGES + 5 }, (_, index) => ({
    id: `sm-${index}`,
    text: 'x',
    createdAt: index,
  }))
  const capped = parseConversationServerFrame({ type: 'queued', key, messages: many })
  assert.ok(capped?.type === 'queued')
  assert.equal(capped.messages.length, CONVERSATION_MAX_QUEUED_MESSAGES)
})
