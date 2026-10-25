import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationServerFrame } from '../src/serverFrames'

// What a paired desktop's management of a listed chat reads: optional
// members of `ConversationThread`, kept when readable and dropped otherwise,
// never the row.

const listed = (fields: Record<string, unknown>) => {
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
        ...fields,
      },
    ],
  })
  assert.ok(frame && frame.type === 'sessions')
  return frame.sessions[0]!
}

test('a listed chat says whether it compacts by itself, either way', () => {
  assert.equal(listed({ autoCompact: true }).autoCompact, true)
  assert.equal(listed({ autoCompact: false }).autoCompact, false)
  assert.equal('autoCompact' in listed({}), false, 'from a desktop before it, nothing')
  assert.equal('autoCompact' in listed({ autoCompact: 'yes' }), false, 'and one it cannot read is dropped')
})
