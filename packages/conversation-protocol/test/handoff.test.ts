import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_HANDOFF_CAPABILITY } from '../src/handshake'
import { parseConversationServerFrame } from '../src/serverFrames'

const handoff = (frame: Record<string, unknown> = {}, command: Record<string, unknown> = {}) => ({
  type: 'command',
  commandId: 'cmd-1',
  key: { workspaceId: 'ws', agentId: 'agent' },
  command: { kind: 'handoff', ...command },
  ...frame,
})

const listed = (capabilities: Record<string, unknown>) =>
  parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Restyle the design system',
        phase: 'idle',
        updatedAt: 2,
        createdAt: 1,
        providerId: 'claude-agent',
        modelId: 'default',
        turnCount: 1,
        lastSeq: 4,
        capabilities: {
          images: true,
          approvals: true,
          questions: true,
          planMode: false,
          interrupt: true,
          checkpoints: false,
          ...capabilities,
        },
      },
    ],
  })

test('the capability and the command kind are listed', () => {
  assert.equal(CONVERSATION_HANDOFF_CAPABILITY, 'conversation-handoff')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_HANDOFF_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('handoff'))
})

test('a handoff names only the chat, and nothing else rides with it', () => {
  assert.deepEqual(parseConversationClientMessage(handoff({}, { path: '/elsewhere', extra: 1 })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'handoff' },
  })
})

test('a handoff with no command id is a bad frame, not one the desktop does not know', () => {
  for (const commandId of [undefined, '', 7]) {
    const frame = handoff({ commandId })
    assert.equal(parseConversationClientMessage(frame), null)
    assert.equal(explainRejectedConversationMessage(frame).code, 'invalid_frame')
  }
})

test('a listed chat keeps whether it can be handed off, and leaves out a flag it cannot read', () => {
  const can = listed({ handoff: true })
  assert.ok(can?.type === 'sessions')
  assert.equal(can.sessions[0]!.capabilities?.handoff, true)
  const cannot = listed({ handoff: false })
  assert.ok(cannot?.type === 'sessions')
  assert.equal(cannot.sessions[0]!.capabilities?.handoff, false)
  const unread = listed({ handoff: 'yes' })
  assert.ok(unread?.type === 'sessions')
  assert.equal('handoff' in (unread.sessions[0]!.capabilities ?? {}), false)
  const older = listed({})
  assert.ok(older?.type === 'sessions')
  assert.equal('handoff' in (older.sessions[0]!.capabilities ?? {}), false, 'a desktop from before it says nothing')
})
