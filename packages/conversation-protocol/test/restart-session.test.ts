import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_RESTART_SESSION_CAPABILITY } from '../src/handshake'

const restart = (frame: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  key: { workspaceId: 'ws', agentId: 'agent' },
  command: { kind: 'restartSession', extra: 'dropped' },
  ...frame,
})

test('the capability and the command kind are listed', () => {
  assert.equal(CONVERSATION_RESTART_SESSION_CAPABILITY, 'conversation-restart-session')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_RESTART_SESSION_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('restartSession'))
})

test('a restart names nothing but the chat it is sent to', () => {
  assert.deepEqual(parseConversationClientMessage(restart({})), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'restartSession' },
  })
})

test('a restart with no command id is a bad frame, not one the desktop does not know', () => {
  assert.equal(parseConversationClientMessage(restart({ commandId: '' })), null)
  assert.equal(explainRejectedConversationMessage(restart({ commandId: '' })).code, 'invalid_frame')
})
