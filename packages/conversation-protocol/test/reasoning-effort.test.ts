import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_REASONING_EFFORT_CAPABILITY } from '../src/handshake'
import { parseConversationServerFrame } from '../src/serverFrames'

const set = (command: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  key: { workspaceId: 'ws', agentId: 'agent' },
  command: { kind: 'setReasoningEffort', ...command },
})

const listed = (thread: Record<string, unknown>, capabilities: Record<string, unknown>) =>
  parseConversationServerFrame({
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
        ...thread,
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
  assert.equal(CONVERSATION_REASONING_EFFORT_CAPABILITY, 'conversation-reasoning-effort')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_REASONING_EFFORT_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('setReasoningEffort'))
})

test('a change names a level, or none for the provider default, and nothing else rides with it', () => {
  assert.deepEqual(parseConversationClientMessage(set({ effort: 'high', extra: 'dropped' })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'setReasoningEffort', effort: 'high' },
  })
  assert.deepEqual(parseConversationClientMessage(set({})), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'setReasoningEffort' },
  })
})

test('a level that cannot be one is a bad frame, not one the desktop does not know', () => {
  for (const command of [{ effort: '' }, { effort: 3 }, { effort: '--max' }, { effort: 'x'.repeat(41) }]) {
    assert.equal(parseConversationClientMessage(set(command)), null)
    assert.equal(explainRejectedConversationMessage(set(command)).code, 'invalid_frame')
  }
})

test('a listed chat keeps its levels and the one it runs at, and leaves out what it cannot read', () => {
  const read = listed({ reasoningEffort: 'high' }, { reasoningEfforts: ['low', 'high', '<b>'] })
  assert.ok(read?.type === 'sessions')
  assert.equal(read.sessions[0]!.reasoningEffort, 'high')
  assert.deepEqual(read.sessions[0]!.capabilities?.reasoningEfforts, ['low', 'high'])
  const older = listed({}, {})
  assert.ok(older?.type === 'sessions')
  assert.equal('reasoningEffort' in older.sessions[0]!, false)
  assert.equal(
    'reasoningEfforts' in (older.sessions[0]!.capabilities ?? {}),
    false,
    'a desktop from before it says nothing',
  )
  const odd = listed({ reasoningEffort: 7 }, { reasoningEfforts: 'high' })
  assert.ok(odd?.type === 'sessions')
  assert.equal('reasoningEffort' in odd.sessions[0]!, false)
  assert.equal('reasoningEfforts' in (odd.sessions[0]!.capabilities ?? {}), false)
})
