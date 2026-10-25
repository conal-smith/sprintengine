// A listed chat's local servers: the dev servers and previews its agents
// linked on the desktop it runs on, read as the contract says, with what a
// client does with one it cannot read.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CONVERSATION_MAX_LOCAL_SERVERS, parseConversationServerFrame } from '../src/serverFrames'

const server = { id: 'srv-1', url: 'http://localhost:5173/', title: 'localhost:5173', port: 5173, state: 'running' }

const listed = (localServers: unknown) =>
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
        ...(localServers === undefined ? {} : { localServers }),
      },
    ],
  })

test("a listed chat keeps its agents' local servers, and only what the contract names", () => {
  const frame = listed([{ ...server, command: 'npm run dev', cwd: '/Users/dev/app' }])
  assert.ok(frame?.type === 'sessions')
  assert.deepEqual(frame.sessions[0]!.localServers, [server])
})

test('a server a client cannot read is dropped, never the row; none read is no member at all', () => {
  const frame = listed([
    server,
    { ...server, id: 'srv-2', url: 'file:///etc/passwd' },
    { ...server, id: 'srv-3', port: 0 },
    { ...server, id: 'srv-4', state: 'exploded' },
    { ...server, id: 'srv-5', title: '' },
  ])
  assert.ok(frame?.type === 'sessions')
  assert.deepEqual(
    frame.sessions[0]!.localServers?.map((entry) => entry.id),
    ['srv-1'],
  )
  for (const unread of ['none', [{ ...server, port: 'x' }], undefined]) {
    const row = listed(unread)
    assert.ok(row?.type === 'sessions')
    assert.equal(row.sessions.length, 1)
    assert.equal('localServers' in row.sessions[0]!, false, JSON.stringify(unread))
  }
})

test('a listed chat carries at most the bound of local servers', () => {
  const many = Array.from({ length: CONVERSATION_MAX_LOCAL_SERVERS + 3 }, (_, index) => ({
    ...server,
    id: `srv-${index}`,
  }))
  const frame = listed(many)
  assert.ok(frame?.type === 'sessions')
  assert.equal(frame.sessions[0]!.localServers?.length, CONVERSATION_MAX_LOCAL_SERVERS)
})
