// A chat forked from a paired device (`conversation-fork`): the command names
// the point and the new chat's id, and nothing else rides with it.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_FORK_CAPABILITY } from '../src/handshake'
import { parseConversationServerFrame } from '../src/serverFrames'

const fork = (command: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  command: { kind: 'fork', newAgentId: 'conversation-claude-agent-abc', ...command },
})

const listed = (capabilities: Record<string, unknown>) => {
  const frame = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Restyle the design system',
        phase: 'completed',
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
  assert.ok(frame?.type === 'sessions')
  return frame.sessions[0]!.capabilities
}

test('the capability and the command kind are listed', () => {
  assert.equal(CONVERSATION_FORK_CAPABILITY, 'conversation-fork')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_FORK_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('fork'))
})

test('a fork at a reply names its turn, and one before a message names that message', () => {
  assert.deepEqual(parseConversationClientMessage(fork({ side: 'assistant', turnId: 'turn-3', turnSeq: 9 })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'fork', newAgentId: 'conversation-claude-agent-abc', side: 'assistant', turnId: 'turn-3' },
  })
  assert.deepEqual(parseConversationClientMessage(fork({ side: 'user', turnSeq: 7, title: 'dropped' })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'fork', newAgentId: 'conversation-claude-agent-abc', side: 'user', turnSeq: 7 },
  })
})

test('a fork that names no point, or no chat to fork into, is a bad frame, not one the desktop does not know', () => {
  for (const command of [
    { side: 'assistant' },
    { side: 'assistant', turnId: '' },
    { side: 'user' },
    { side: 'user', turnSeq: 0 },
    { side: 'user', turnSeq: 1.5 },
    { side: 'middle', turnId: 'turn-3' },
    { side: 'assistant', turnId: 'turn-3', newAgentId: '' },
    { side: 'assistant', turnId: 'turn-3', newAgentId: 'x'.repeat(201) },
  ]) {
    assert.equal(parseConversationClientMessage(fork(command)), null, JSON.stringify(command))
    assert.equal(explainRejectedConversationMessage(fork(command)).code, 'invalid_frame', JSON.stringify(command))
  }
})

test('a listed chat keeps whether it can be forked, and leaves out a flag it cannot read', () => {
  assert.equal(listed({ fork: true })?.fork, true)
  assert.equal(listed({ fork: false })?.fork, false)
  assert.equal('fork' in (listed({ fork: 'yes' }) ?? {}), false)
  assert.equal('fork' in (listed({}) ?? {}), false, 'a desktop from before it says nothing')
})
