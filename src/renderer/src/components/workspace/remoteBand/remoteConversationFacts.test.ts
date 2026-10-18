import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { MeshConversation } from '../../../../../shared/tailnet-mesh'
import { meshConversationSessionId } from '../../../../../shared/tailnet-mesh'
import {
  publishRemoteConversationList,
  remoteConversationFactsKey,
  readRemoteConversationFacts,
  resetRemoteConversationFacts,
} from './remoteConversationFacts'

const read = readRemoteConversationFacts

function conversation(overrides: Partial<MeshConversation> = {}): MeshConversation {
  return {
    workspaceId: 'rw1',
    agentId: 'agent-1',
    title: 'Agent one',
    phase: 'completed',
    updatedAt: 1_000,
    createdAt: 500,
    lastTurnEndedAt: 900,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 1,
    lastSeq: 3,
    ...overrides,
  } as MeshConversation
}

const KEY = remoteConversationFactsKey('c1', meshConversationSessionId('rw1', 'agent-1'))

afterEach(() => resetRemoteConversationFacts())

test('a listed chat is filed by its pairing and session, with what its tab draws', () => {
  publishRemoteConversationList('c1', [conversation()])
  assert.deepEqual(read().get(KEY), {
    cli: 'claude-code',
    modelId: 'opus',
    phase: 'completed',
    live: false,
    lastTurnEndedAt: 900,
    pullRequests: [],
    branch: null,
    worktree: false,
    changes: null,
  })
})

test('the files a chat changed are kept, and a change in them is a change', () => {
  const changes = { added: 1, updated: 2, removed: 0, scope: 'branch' as const }
  publishRemoteConversationList('c1', [conversation({ changes, worktree: true })])
  const first = read()
  assert.deepEqual(first.get(KEY)?.changes, changes)
  assert.equal(first.get(KEY)?.worktree, true)
  publishRemoteConversationList('c1', [conversation({ changes: { ...changes }, worktree: true })])
  assert.equal(read(), first, 'the same counts read again move nothing')
  publishRemoteConversationList('c1', [conversation({ changes: { ...changes, removed: 1 }, worktree: true })])
  assert.equal(read().get(KEY)?.changes?.removed, 1)
})

test('the branch a chat is listed on is kept, and a change of it is a change', () => {
  publishRemoteConversationList('c1', [conversation({ branch: 'agent/chat-1' })])
  const first = read()
  assert.equal(first.get(KEY)?.branch, 'agent/chat-1')
  publishRemoteConversationList('c1', [conversation({ branch: 'agent/chat-1' })])
  assert.equal(read(), first)
  publishRemoteConversationList('c1', [conversation({ branch: 'main' })])
  assert.equal(read().get(KEY)?.branch, 'main')
})

test('a re-read that moved nothing a tab draws keeps the snapshot', () => {
  publishRemoteConversationList('c1', [conversation()])
  const first = read()
  // Every event moves `updatedAt`; no tab draws it.
  publishRemoteConversationList('c1', [conversation({ updatedAt: 2_000, lastSeq: 9 })])
  assert.equal(read(), first)
})

test('a phase that moved replaces only that chat', () => {
  publishRemoteConversationList('c1', [conversation(), conversation({ agentId: 'agent-2' })])
  const before = read()
  publishRemoteConversationList('c1', [
    conversation({ phase: 'running', sessionId: 's1' } as Partial<MeshConversation>),
    conversation({ agentId: 'agent-2' }),
  ])
  const after = read()
  assert.notEqual(after, before)
  assert.equal(after.get(KEY)?.phase, 'running')
  assert.equal(after.get(KEY)?.live, true)
  const other = remoteConversationFactsKey('c1', meshConversationSessionId('rw1', 'agent-2'))
  assert.equal(after.get(other), before.get(other), 'the unchanged chat keeps its facts')
})

test("a chat its machine no longer lists is forgotten, and another machine's are kept", () => {
  publishRemoteConversationList('c1', [conversation()])
  publishRemoteConversationList('c2', [conversation()])
  publishRemoteConversationList('c1', [])
  assert.equal(read().get(KEY), undefined)
  assert.ok(read().get(remoteConversationFactsKey('c2', meshConversationSessionId('rw1', 'agent-1'))))
})
