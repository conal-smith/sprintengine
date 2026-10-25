// An approval answered from a paired device with a rule that outlives the
// conversation (`conversation-permanent-approvals`): `resolveApproval` with
// `decision: 'always'`, read by the full contract and refused by the first
// version, as a desktop without the capability refuses it.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationFrame, parseConversationClientFrame } from '../src/index'
import { CONVERSATION_CAPABILITIES, CONVERSATION_PERMANENT_APPROVALS_CAPABILITY } from '../src/handshake'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'

const command = (body: Record<string, unknown>) => ({ type: 'command', commandId: 'cmd-1', command: body })

test('the capability is named in the contract', () => {
  assert.equal(CONVERSATION_PERMANENT_APPROVALS_CAPABILITY, 'conversation-permanent-approvals')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_PERMANENT_APPROVALS_CAPABILITY))
})

test('an always answer is read by the full contract, and refused as unsafe by the first version', () => {
  const frame = command({ kind: 'resolveApproval', requestId: 'req-1', decision: 'always', note: 1 })
  assert.deepEqual(parseConversationClientMessage(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'resolveApproval', requestId: 'req-1', decision: 'always' },
  })
  // What a desktop from before the capability does with it.
  assert.equal(parseConversationClientFrame(frame), null)
  assert.equal(explainRejectedConversationFrame(frame).code, 'unsafe_remote_decision')
})

test('an always answer without a request is refused under its command id', () => {
  const frame = command({ kind: 'resolveApproval', decision: 'always' })
  assert.equal(parseConversationClientMessage(frame), null)
  assert.equal(explainRejectedConversationMessage(frame).commandId, 'cmd-1')
})
