import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  parseConversationServerFrame,
  parseConversationWireChanges,
} from '../../../../packages/conversation-protocol/src/public'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { ConversationThread as IndexedThread } from '../../../shared/conversation-index'
import type { WorkspaceChangeSummary } from '../../../shared/ipc/git'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import { createConversationGatewayHost, type ConversationListMarks } from './tailnet-conversation-host'
import { conversationCheckoutsOf } from './tailnet-conversation-machine'

// What a paired device reads about a chat's checkout: the files it changed,
// as this desktop's sidebar line and composer strip count them, and whether
// it works in a worktree.

function indexed(agentId: string): IndexedThread {
  return {
    agentId,
    title: `First message of ${agentId}`,
    titleSource: 'first-message',
    createdAt: 1,
    updatedAt: 1,
    turnCount: 1,
    model: 'default',
    providerId: 'mock',
    lastSeq: 4,
    firstUserText: 'hello',
  }
}

function session(workspaceId: string): ConversationSessionSummary {
  return {
    sessionId: `conv-${workspaceId}`,
    workspaceId,
    agentId: 'agent-1',
    providerId: 'mock',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    phase: 'completed',
  }
}

const summary = (over: Partial<WorkspaceChangeSummary> = {}): WorkspaceChangeSummary => ({
  branch: 'agent/chat-1',
  additions: 40,
  deletions: 3,
  changedFiles: 4,
  scope: 'worktree',
  files: { added: 1, updated: 2, removed: 1 },
  uncommitted: { additions: 2, deletions: 0, changedFiles: 1, files: { added: 0, updated: 1, removed: 0 } },
  ...over,
})

function hostFor(input: {
  threads: Record<string, IndexedThread[]>
  sessions: ConversationSessionSummary[]
  marks: ConversationListMarks
}) {
  const runtime = {
    listSessions: () => ({ ok: true, sessions: input.sessions }),
    listThreads: async (key: { workspaceId: string }) => ({ ok: true, threads: input.threads[key.workspaceId] ?? [] }),
    getProviderCapabilities: () => undefined,
  } as unknown as ConversationBackend
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => Object.keys(input.threads).map((workspaceId) => ({ workspaceId, workspaceRoot: '/Users/dev/app' })),
    () => 'bypass',
    () => null,
    async () => null,
    input.marks,
  )
}

test('a live chat lists the files its checkout carries; one at rest lists only its worktree', async () => {
  const summarized: string[] = []
  const marks: ConversationListMarks = {
    checkoutsOf: (keys) =>
      conversationCheckoutsOf(
        keys,
        ({ workspaceId }) => ({ path: `/Users/dev/${workspaceId}`, worktree: workspaceId === 'resting' }),
        async (path) => {
          summarized.push(path)
          return summary()
        },
      ),
  }
  const listed = new Map(
    (
      await hostFor({
        threads: { live: [indexed('agent-1')], resting: [indexed('agent-1')] },
        sessions: [session('live')],
        marks,
      }).list()
    ).map((thread) => [thread.workspaceId, thread]),
  )
  assert.deepEqual(listed.get('live')?.changes, {
    added: 1,
    updated: 2,
    removed: 1,
    scope: 'worktree',
    uncommitted: { added: 0, updated: 1, removed: 0 },
  })
  assert.equal('worktree' in listed.get('live')!, false)
  assert.equal('changes' in listed.get('resting')!, false, 'a parked chat’s numbers would be the checkout’s')
  assert.equal(listed.get('resting')?.worktree, true)
  assert.deepEqual(summarized, ['/Users/dev/live'], 'git is asked about the live chat alone')
})

test('a count git could not split, or could not read, is left out rather than listed as a zero', async () => {
  const keys = [
    { workspaceId: 'unsplit', agentId: 'agent-1', live: true },
    { workspaceId: 'unreadable', agentId: 'agent-1', live: true },
    { workspaceId: 'elsewhere', agentId: 'agent-1', live: true },
  ]
  const found = await conversationCheckoutsOf(
    keys,
    ({ workspaceId }) => (workspaceId === 'elsewhere' ? null : { path: `/Users/dev/${workspaceId}`, worktree: false }),
    async (path) => {
      if (path.endsWith('unreadable')) throw new Error('git failed')
      return summary({ files: undefined })
    },
  )
  assert.equal(found.size, 0)
})

test('the client validator keeps counts it can read and drops the rest, never the row', () => {
  assert.deepEqual(parseConversationWireChanges({ added: 1, updated: 0, removed: 2, scope: 'nonsense' }), {
    added: 1,
    updated: 0,
    removed: 2,
  })
  assert.deepEqual(
    parseConversationWireChanges({ added: 1, updated: 0, removed: 0, uncommitted: { added: -1 } }),
    { added: 1, updated: 0, removed: 0 },
    'an uncommitted reading in the wrong shape goes on its own',
  )
  for (const malformed of [
    true,
    { added: 1 },
    { added: -1, updated: 0, removed: 0 },
    { added: 1.5, updated: 0, removed: 0 },
  ])
    assert.equal(parseConversationWireChanges(malformed), null)
  const row = {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    title: 'Chat',
    phase: 'completed',
    updatedAt: 1,
    createdAt: 1,
    providerId: 'mock',
    modelId: 'default',
    turnCount: 1,
    lastSeq: 1,
  }
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      { ...row, changes: { added: 2, updated: 1, removed: 0, scope: 'branch' }, worktree: true },
      { ...row, workspaceId: 'ws-2', changes: 'lots', worktree: 'yes' },
    ],
  })
  assert.ok(parsed && parsed.type === 'sessions')
  const [first, second] = (parsed as { sessions: Array<Record<string, unknown>> }).sessions
  assert.deepEqual(first?.changes, { added: 2, updated: 1, removed: 0, scope: 'branch' })
  assert.equal(first?.worktree, true)
  assert.equal(second?.changes, undefined)
  assert.equal(second?.worktree, undefined)
})
