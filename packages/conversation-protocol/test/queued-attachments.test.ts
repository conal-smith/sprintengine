// A message the desktop holds for a turn's end carrying what a message sent
// now does (`conversation-queued-attachments`): `send` with `queue` beside
// `uploadIds`, `skills` and `mentions`, and `queued` frames naming what each
// held message carries, each read as the contract says, with what an older
// desktop and an older client do with them.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationClientFrame } from '../src/index'
import { CONVERSATION_CAPABILITIES, CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY } from '../src/handshake'
import { parseConversationClientMessage } from '../src/clientFrames'
import { parseConversationServerFrame } from '../src/serverFrames'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const command = (body: Record<string, unknown>) => ({ type: 'command', commandId: 'cmd-1', command: body })

test('the capability is named in the contract', () => {
  assert.equal(CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY, 'conversation-queued-attachments')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY))
})

test('a queued send keeps its uploads, skills and mentions', () => {
  const frame = command({
    kind: 'send',
    message: 'And this one.',
    queue: true,
    uploadIds: ['u-1', 'u-2'],
    skills: ['review'],
    mentions: [{ path: 'src/app.ts', kind: 'file', line: 4 }],
  })
  assert.deepEqual(parseConversationClientMessage(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: {
      kind: 'send',
      message: 'And this one.',
      queue: true,
      uploadIds: ['u-1', 'u-2'],
      skills: ['review'],
      mentions: [{ path: 'src/app.ts', kind: 'file', line: 4 }],
    },
  })
  // The first version keeps the words and the pictures, and drops the rest:
  // which is why a client sends them beside `queue` only where the
  // capability is advertised.
  assert.deepEqual(parseConversationClientFrame(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'And this one.', uploadIds: ['u-1', 'u-2'] },
  })
})

test('a held message still goes in the default mode, and is never a steer', () => {
  assert.equal(
    parseConversationClientMessage(command({ kind: 'send', message: 'x', queue: true, mode: 'plan', skills: ['a'] })),
    null,
  )
  assert.equal(
    parseConversationClientMessage(command({ kind: 'send', message: 'x', queue: true, steer: true, uploadIds: ['u'] })),
    null,
  )
  // A malformed member is refused, not dropped, beside `queue` as anywhere.
  assert.equal(
    parseConversationClientMessage(command({ kind: 'send', message: 'x', queue: true, mentions: [{ path: '/etc' }] })),
    null,
  )
  assert.equal(
    parseConversationClientMessage(command({ kind: 'send', message: 'x', queue: true, skills: ['../up'] })),
    null,
  )
})

test('a queued frame names what each held message carries, and drops only what it cannot read', () => {
  const frame = parseConversationServerFrame({
    type: 'queued',
    key,
    messages: [
      {
        id: 'sm-1',
        text: 'Look at these.',
        createdAt: 5,
        images: ['screenshot.png', 'after.png'],
        files: ['Q3 budget.xlsx'],
        skills: ['review'],
        mentions: [{ path: 'src', kind: 'folder' }],
      },
      // Unreadable members go; the message stays.
      { id: 'sm-2', text: 'Words.', createdAt: 6, images: 'one.png', files: [7], mentions: [{ path: '/abs' }] },
      { id: 'sm-3', text: 'Nothing else.', createdAt: 7, images: [], skills: [] },
    ],
  })
  assert.deepEqual(frame, {
    type: 'queued',
    key,
    messages: [
      {
        id: 'sm-1',
        text: 'Look at these.',
        createdAt: 5,
        images: ['screenshot.png', 'after.png'],
        files: ['Q3 budget.xlsx'],
        skills: ['review'],
        mentions: [{ path: 'src', kind: 'folder' }],
      },
      { id: 'sm-2', text: 'Words.', createdAt: 6 },
      { id: 'sm-3', text: 'Nothing else.', createdAt: 7 },
    ],
  })
})
