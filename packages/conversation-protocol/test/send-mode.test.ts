import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_SEND_MODES } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_SEND_MODE_CAPABILITY } from '../src/handshake'

const send = (command: Record<string, unknown>) =>
  parseConversationClientMessage({
    type: 'command',
    commandId: 'cmd-1',
    key: { workspaceId: 'ws', agentId: 'agent' },
    command: { kind: 'send', message: 'What does the upload test wait on?', ...command },
  })

test('the capability and the modes are listed', () => {
  assert.equal(CONVERSATION_SEND_MODE_CAPABILITY, 'conversation-send-mode')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_SEND_MODE_CAPABILITY))
  assert.deepEqual(CONVERSATION_SEND_MODES, ['default', 'plan', 'ask'])
})

test('a send keeps the mode its turn runs in, beside what else it says', () => {
  const asked = send({ mode: 'ask', skills: ['review'], composedAt: 5 })
  assert.ok(asked && asked.type === 'command' && asked.command.kind === 'send')
  assert.equal(asked.command.mode, 'ask')
  assert.deepEqual(asked.command.skills, ['review'])
  assert.equal(asked.command.composedAt, 5)
  const planned = send({ mode: 'plan', steer: true })
  assert.ok(planned && planned.type === 'command' && planned.command.kind === 'send')
  assert.equal(planned.command.mode, 'plan')
  assert.equal(planned.command.steer, true)
})

test('the default mode is read as no mode, as a send without one is', () => {
  for (const frame of [send({ mode: 'default' }), send({})]) {
    assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
    assert.equal('mode' in frame.command, false)
  }
})

test('a mode the contract does not name, or one beside a held message, refuses the frame', () => {
  assert.equal(send({ mode: 'yolo' }), null)
  assert.equal(send({ mode: 7 }), null)
  assert.equal(send({ mode: 'ask', queue: true }), null)
})
