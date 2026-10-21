import assert from 'node:assert/strict'
import { test } from 'vitest'

import { publishRemoteChatLinkTargets, remoteChatLinkTarget } from './remoteChatLinks'
import { buildRemoteBand } from './remoteSessionsModel'
import type { MeshConnection } from '../../../../../shared/tailnet-mesh'
import { chatLinkIdOf } from '../sidebar/contextMenus'

test('a link names a paired machine’s chat by its id there, and opens what that machine lists', () => {
  const connection = {
    id: 'c-mini',
    machineName: 'mac-mini',
    endpoint: 'mac-mini.tail1234.ts.net:8471',
    deviceId: 'tnd_mini',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'] as MeshConnection['scopes'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request' as const,
  }
  const groups = buildRemoteBand({
    connections: [connection],
    browses: new Map([
      [
        connection.id,
        {
          browse: null,
          loading: false,
          error: null,
          at: 1,
          conversations: [
            {
              workspaceId: 'rw1',
              agentId: 'agent-1',
              title: 'Ada',
              chatTitle: 'Review the parser',
              phase: 'idle' as const,
              updatedAt: 1,
              createdAt: 1,
              providerId: 'claude-agent',
              modelId: 'opus',
              turnCount: 1,
              lastSeq: 1,
            },
          ],
        },
      ],
    ]),
    reachability: new Map(),
    workspaces: [],
  })
  publishRemoteChatLinkTargets(groups)
  const target = remoteChatLinkTarget('rw1')
  assert.equal(target?.connectionId, 'c-mini')
  assert.deepEqual(target?.conversation, { workspaceId: 'rw1', agentId: 'agent-1' })
  assert.equal(remoteChatLinkTarget('rw-elsewhere'), null)
  publishRemoteChatLinkTargets([])
  assert.equal(remoteChatLinkTarget('rw1'), null, 'a list that no longer names it opens nothing')

  // A row opened here from it copies the same link its machine's own row does.
  assert.equal(chatLinkIdOf({ id: 'ws-here', remoteOrigin: { workspaceId: 'rw1' } as never }), 'rw1')
  assert.equal(chatLinkIdOf({ id: 'ws-here', remoteOrigin: null }), 'ws-here')
})
