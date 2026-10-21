import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_CAPABILITIES, CONVERSATION_STEER_SENDS_CAPABILITY } from '../src/handshake'
import { parseConversationServerFrame } from '../src/serverFrames'

const send = (command: Record<string, unknown>) =>
  parseConversationClientMessage({
    type: 'command',
    commandId: 'cmd-1',
    key: { workspaceId: 'ws', agentId: 'agent' },
    command: { kind: 'send', message: 'Keep it to one file', ...command },
  })

const listed = (capabilities: Record<string, unknown>) =>
  parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Fix the flaky test',
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

test('the capability is listed', () => {
  assert.equal(CONVERSATION_STEER_SENDS_CAPABILITY, 'conversation-steer-sends')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_STEER_SENDS_CAPABILITY))
})

test('a send keeps its steer', () => {
  const frame = send({ steer: true })
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.equal(frame.command.steer, true)
  assert.equal(frame.command.message, 'Keep it to one file')
})

test('a steer keeps the pictures and skills it carries', () => {
  const frame = send({ steer: true, uploadIds: ['upload-1'], skills: ['review'] })
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.equal(frame.command.steer, true)
  assert.deepEqual(frame.command.uploadIds, ['upload-1'])
  assert.deepEqual(frame.command.skills, ['review'])
})

test('a steer that is not true, or beside a queued message, refuses the frame', () => {
  assert.equal(send({ steer: false }), null)
  assert.equal(send({ steer: 'yes' }), null)
  assert.equal(send({ steer: true, queue: true }), null)
})

test('a send without steer is read as before', () => {
  const frame = send({})
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.equal('steer' in frame.command, false)
})

test('a listed chat keeps whether it takes a steer, and leaves out a flag it cannot read', () => {
  const takes = listed({ steer: true })
  assert.ok(takes?.type === 'sessions')
  assert.equal(takes.sessions[0]!.capabilities?.steer, true)
  const cannot = listed({ steer: false })
  assert.ok(cannot?.type === 'sessions')
  assert.equal(cannot.sessions[0]!.capabilities?.steer, false)
  const unread = listed({ steer: 'sometimes' })
  assert.ok(unread?.type === 'sessions')
  assert.equal('steer' in (unread.sessions[0]!.capabilities ?? {}), false)
  const older = listed({})
  assert.ok(older?.type === 'sessions')
  assert.equal('steer' in (older.sessions[0]!.capabilities ?? {}), false, 'a desktop from before it says nothing')
})
