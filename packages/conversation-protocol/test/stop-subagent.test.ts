import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_STOP_SUBAGENT_CAPABILITY } from '../src/handshake'
import { parseConversationServerFrame } from '../src/serverFrames'

const stop = (command: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  key: { workspaceId: 'ws', agentId: 'agent' },
  command: { kind: 'stopSubagent', ...command },
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
        phase: 'running',
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
  assert.equal(CONVERSATION_STOP_SUBAGENT_CAPABILITY, 'conversation-stop-subagent')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_STOP_SUBAGENT_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('stopSubagent'))
})

test('a stop names the agent by the call that spawned it, and nothing else rides with it', () => {
  const frame = parseConversationClientMessage(stop({ toolUseId: 'toolu_agent', extra: 'dropped' }))
  assert.deepEqual(frame, {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'stopSubagent', toolUseId: 'toolu_agent' },
  })
})

test('a stop that names no agent is a bad frame, not one the desktop does not know', () => {
  for (const command of [{}, { toolUseId: '' }, { toolUseId: 7 }, { toolUseId: 'x'.repeat(201) }]) {
    assert.equal(parseConversationClientMessage(stop(command)), null)
    assert.equal(explainRejectedConversationMessage(stop(command)).code, 'invalid_frame')
  }
})

test('a listed chat keeps whether it can stop one agent, and leaves out a flag it cannot read', () => {
  const can = listed({ stopSubagent: true })
  assert.ok(can?.type === 'sessions')
  assert.equal(can.sessions[0]!.capabilities?.stopSubagent, true)
  const cannot = listed({ stopSubagent: false })
  assert.ok(cannot?.type === 'sessions')
  assert.equal(cannot.sessions[0]!.capabilities?.stopSubagent, false)
  const unread = listed({ stopSubagent: 'sometimes' })
  assert.ok(unread?.type === 'sessions')
  assert.equal('stopSubagent' in (unread.sessions[0]!.capabilities ?? {}), false)
  const older = listed({})
  assert.ok(older?.type === 'sessions')
  assert.equal(
    'stopSubagent' in (older.sessions[0]!.capabilities ?? {}),
    false,
    'a desktop from before it says nothing',
  )
})
