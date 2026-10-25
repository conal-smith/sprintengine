import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_MAX_SEND_SKILLS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_SEND_SKILLS_CAPABILITY } from '../src/handshake'

const send = (command: Record<string, unknown>) =>
  parseConversationClientMessage({
    type: 'command',
    commandId: 'cmd-1',
    key: { workspaceId: 'ws', agentId: 'agent' },
    command: { kind: 'send', message: 'Fix the flaky test', ...command },
  })

test('the capability is listed', () => {
  assert.equal(CONVERSATION_SEND_SKILLS_CAPABILITY, 'conversation-send-skills')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_SEND_SKILLS_CAPABILITY))
})

test('a send keeps the skills it names', () => {
  const frame = send({ skills: ['review', 'superpowers:systematic-debugging'] })
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.deepEqual(frame.command.skills, ['review', 'superpowers:systematic-debugging'])
  assert.equal(frame.command.message, 'Fix the flaky test')
})

test('skills that are not ids, or too many, refuse the frame', () => {
  assert.equal(send({ skills: 'review' }), null)
  assert.equal(send({ skills: ['../etc'] }), null)
  assert.equal(send({ skills: [''] }), null)
  assert.equal(send({ skills: Array.from({ length: CONVERSATION_MAX_SEND_SKILLS + 1 }, (_, i) => `s${i}`) }), null)
  // Beside `queue` they are read, for a desktop that holds them
  // (queued-attachments.test.ts).
  assert.deepEqual(send({ skills: ['review'], queue: true }), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'send', message: 'Fix the flaky test', skills: ['review'], queue: true },
  })
})

test('a send without skills is read as before', () => {
  const frame = send({})
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.equal('skills' in frame.command, false)
})
