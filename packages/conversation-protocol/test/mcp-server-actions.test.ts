import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS, CONVERSATION_MCP_SERVER_ACTIONS } from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY } from '../src/handshake'
import { parseConversationServerFrame } from '../src/serverFrames'

const act = (command: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  key: { workspaceId: 'ws', agentId: 'agent' },
  command: { kind: 'mcpServerAction', ...command },
})

const listed = (capabilities: Record<string, unknown>) =>
  parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Wire up the tracker',
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

test('the capability, the command kind and its actions are listed', () => {
  assert.equal(CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY, 'conversation-mcp-server-actions')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('mcpServerAction'))
  assert.deepEqual(CONVERSATION_MCP_SERVER_ACTIONS, ['reconnect', 'enable', 'disable'])
})

test('an action names its server and what to do to it, and nothing else rides with it', () => {
  assert.deepEqual(parseConversationClientMessage(act({ serverId: 'github', action: 'reconnect', extra: 1 })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'mcpServerAction', serverId: 'github', action: 'reconnect' },
  })
})

test('a sign-in, an action the contract does not name, or no server is a bad frame', () => {
  for (const command of [
    { serverId: 'github', action: 'sign-in' },
    { serverId: 'github', action: 'restart' },
    { serverId: '', action: 'reconnect' },
    { action: 'enable' },
  ]) {
    assert.equal(parseConversationClientMessage(act(command)), null)
    assert.equal(explainRejectedConversationMessage(act(command)).code, 'invalid_frame')
  }
})

test('a listed chat keeps the actions it can read, and says nothing where a desktop did not', () => {
  const read = listed({ mcpServerActions: ['reconnect', 'sign-in', 'disable', 3] })
  assert.ok(read?.type === 'sessions')
  assert.deepEqual(read.sessions[0]!.capabilities?.mcpServerActions, ['reconnect', 'disable'])
  const older = listed({})
  assert.ok(older?.type === 'sessions')
  assert.equal('mcpServerActions' in (older.sessions[0]!.capabilities ?? {}), false)
})
