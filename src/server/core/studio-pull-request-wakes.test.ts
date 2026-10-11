// The Studio core's pull request wakes, wired as the core builds them: the
// chat a wake is for is its own agent in its workspace's record, a settled
// workspace is put away, the send goes through a host whose sends are
// Studio's, and a chat provider's usage limit is read off the store.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { readConversationMessageOrigin } from '../../shared/conversation-runtime'
import {
  PULL_REQUEST_WATCH_ORIGIN,
  STUDIO_PULL_REQUEST_WATCH_CLIENT_ID,
  studioPullRequestWakes,
} from './studio-pull-request-wakes'

function wiring() {
  const records = new Map<string, { settledAt?: number | null; agents: Record<string, unknown> }>([
    ['ws-1', { agents: { 'agent-1': {} } }],
    ['ws-2', { settledAt: 1, agents: { 'agent-2': {} } }],
  ])
  const hosts: unknown[] = []
  const commands: unknown[][] = []
  const sessions: ConversationSessionSummary[] = []
  const wakes = studioPullRequestWakes({
    conversations: { listSessions: () => ({ ok: true, sessions }) },
    workspaceRecord: (workspaceId) => records.get(workspaceId) ?? null,
    createHost: (options) => {
      hosts.push(options)
      return {
        resolveKey: (workspaceId: string, agentId: string) =>
          workspaceId === 'ws-1' ? ({ workspaceId, agentId, workspaceRoot: '/Users/dev/acme-app' } as never) : null,
        command: async (...args: unknown[]) => {
          commands.push(args)
          return { ok: true } as never
        },
      }
    },
    rateLimit: (provider) => ({ limited: provider === 'claude', resetsAt: null, windowId: null }),
  })
  return { wakes, hosts, commands }
}

test('a chat is its agent in its workspace record; a settled workspace is put away; a missing one is gone', () => {
  const { wakes } = wiring()
  assert.deepEqual(wakes.chat({ workspaceId: 'ws-1', agentId: 'agent-1' }), { settled: false })
  assert.deepEqual(wakes.chat({ workspaceId: 'ws-2', agentId: 'agent-2' }), { settled: true })
  assert.equal(wakes.chat({ workspaceId: 'ws-1', agentId: 'agent-9' }), null)
  assert.equal(wakes.chat({ workspaceId: 'ws-9', agentId: 'agent-1' }), null)
})

test('a wake goes through a host whose sends are Studio’s, as a send command', async () => {
  const { wakes, hosts, commands } = wiring()
  const sent = await wakes.send({ workspaceId: 'ws-1', agentId: 'agent-1' }, 'News', 'pull-request-watch:1')
  assert.equal(sent.ok, true)
  assert.deepEqual(hosts, [{ origin: PULL_REQUEST_WATCH_ORIGIN }])
  assert.deepEqual(readConversationMessageOrigin(PULL_REQUEST_WATCH_ORIGIN), {
    kind: 'studio',
    reason: 'pull-request-watch',
  })
  assert.deepEqual(commands[0].slice(1), [
    STUDIO_PULL_REQUEST_WATCH_CLIENT_ID,
    'pull-request-watch:1',
    { kind: 'send', message: 'News' },
  ])
  const nowhere = await wakes.send({ workspaceId: 'ws-2', agentId: 'agent-2' }, 'News', 'pull-request-watch:2')
  assert.equal(nowhere.ok, false)
})

test('a chat provider’s usage limit is read off the store; one with no plan never holds a wake', () => {
  const { wakes } = wiring()
  assert.equal(wakes.usageLimit?.('claude-agent').limited, true)
  assert.equal(wakes.usageLimit?.('some-other-provider').limited, false)
})
