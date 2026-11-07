import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_CAPABILITIES, CONVERSATION_SUBAGENTS_CAPABILITY } from '../src/handshake'
import {
  CONVERSATION_MAX_SUBAGENTS,
  isKnownConversationServerFrameType,
  parseConversationServerFrame,
} from '../src/serverFrames'

// A chat's sub-agents, said where the chat is followed (`conversation-subagents`):
// asked for, whole each time, and never in the `list`.

const key = { workspaceId: 'ws', agentId: 'parent' }
const row = {
  workspaceId: 'ws',
  agentId: 'child',
  title: 'Cursor · grok-4.7',
  providerId: 'cursor-agent',
  modelId: 'grok-4.7',
  readOnly: true,
  status: 'working',
  task: 'Review the calendar screen',
  startedAt: 1_000,
}

test('the capability is named, and the watch is a request of its own', () => {
  assert.equal(CONVERSATION_SUBAGENTS_CAPABILITY, 'conversation-subagents')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_SUBAGENTS_CAPABILITY))
  assert.deepEqual(parseConversationClientMessage({ type: 'watchSubagents', requestId: 'r-1' }), {
    type: 'watchSubagents',
    requestId: 'r-1',
  })
  assert.equal(parseConversationClientMessage({ type: 'watchSubagents' }), null)
  assert.equal(explainRejectedConversationMessage({ type: 'watchSubagents' }).code, 'invalid_frame')
})

test('a row names what a listed chat names of itself, beside what is a sub-agent’s own', () => {
  const capabilities = { images: true, approvals: true, questions: true, planMode: false, interrupt: true }
  const frame = parseConversationServerFrame({
    type: 'subagents',
    key,
    subagents: [
      {
        ...row,
        sessionId: 'session-1',
        permissionPreset: 'manual',
        permissionMode: 'acceptEdits',
        capabilities: { ...capabilities, stopSubagent: true },
        endedAt: 2_000,
        status: 'failed',
        error: 'The model is unavailable.',
        unknownToThisClient: 'skipped',
      },
    ],
  })
  assert.deepEqual(frame, {
    type: 'subagents',
    key,
    subagents: [
      {
        ...row,
        sessionId: 'session-1',
        permissionPreset: 'manual',
        permissionMode: 'acceptEdits',
        capabilities: { ...capabilities, checkpoints: false, stopSubagent: true },
        endedAt: 2_000,
        status: 'failed',
        error: 'The model is unavailable.',
      },
    ],
  })
})

test('one row this client cannot read does not hide the rest', () => {
  const frame = parseConversationServerFrame({
    type: 'subagents',
    key,
    subagents: [{ ...row, status: 'dreaming' }, { ...row, title: 7 }, 'nonsense', { ...row, agentId: 'child-2' }],
  })
  assert.ok(frame?.type === 'subagents')
  assert.deepEqual(
    frame.subagents.map((subagent) => subagent.agentId),
    ['child-2'],
  )
})

test('a frame names the newest, and one in the wrong shape is refused whole', () => {
  const many = Array.from({ length: CONVERSATION_MAX_SUBAGENTS + 2 }, (_, index) => ({
    ...row,
    agentId: `child-${index}`,
  }))
  const frame = parseConversationServerFrame({ type: 'subagents', key, subagents: many })
  assert.ok(frame?.type === 'subagents')
  assert.equal(frame.subagents.length, CONVERSATION_MAX_SUBAGENTS)
  assert.equal(frame.subagents.at(-1)?.agentId, `child-${CONVERSATION_MAX_SUBAGENTS + 1}`)
  assert.equal(frame.subagents[0]?.agentId, 'child-2')
  assert.equal(parseConversationServerFrame({ type: 'subagents', key }), null)
  assert.equal(parseConversationServerFrame({ type: 'subagents', subagents: [] }), null)
  assert.ok(isKnownConversationServerFrameType({ type: 'subagents' }))
})
