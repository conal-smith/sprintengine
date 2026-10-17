import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  parseConversationBackgroundWork,
  parseConversationServerFrame,
} from '../../../../packages/conversation-protocol/src/public'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { ConversationThread as IndexedThread } from '../../../shared/conversation-index'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// What a paired device reads about a chat whose turn is over but which still
// has work going: background agents, and monitors that will wake its agent.

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

function session(workspaceId: string, fields: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
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
    ...fields,
  }
}

function hostFor(input: { threads: Record<string, IndexedThread[]>; sessions: ConversationSessionSummary[] }) {
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
  )
}

async function listedBy(input: Parameters<typeof hostFor>[0]) {
  return new Map((await hostFor(input).list()).map((thread) => [thread.workspaceId, thread]))
}

test('a chat whose turn ended with a background agent running says so, and its phase stays the turn’s', async () => {
  const listed = await listedBy({
    threads: { chat: [indexed('agent-1')] },
    sessions: [session('chat', { backgroundAgents: 2 })],
  })
  assert.deepEqual(listed.get('chat')?.backgroundWork, { agents: 2, monitors: 0 })
  // A phone holds sends while `phase` says a turn runs: a background agent
  // must not hold them for as long as it works.
  assert.equal(listed.get('chat')?.phase, 'completed')
})

test('a monitor with a deadline and a task counted on to report count; a watch with none and a command do not', async () => {
  const listed = await listedBy({
    threads: { waits: [indexed('agent-1')], runs: [indexed('agent-1')] },
    sessions: [
      session('waits', {
        backgroundTasks: [
          { taskId: 'm1', kind: 'monitor', description: 'CI checks' },
          { taskId: 't1', kind: 'task' },
          { taskId: 'c1', kind: 'command', description: 'npm run dev' },
        ],
      }),
      session('runs', {
        backgroundTasks: [
          { taskId: 'm2', kind: 'monitor', persistent: true },
          { taskId: 'c2', kind: 'command' },
        ],
      }),
    ],
  })
  assert.deepEqual(listed.get('waits')?.backgroundWork, { agents: 0, monitors: 2 })
  assert.equal('backgroundWork' in listed.get('runs')!, false, 'nothing there will wake the agent')
})

test('a chat with nothing working in the background lists no background work', async () => {
  const listed = await listedBy({
    threads: { idle: [indexed('agent-1')], history: [indexed('agent-1')] },
    sessions: [session('idle', { backgroundAgents: 0, backgroundTasks: [] })],
  })
  assert.equal('backgroundWork' in listed.get('idle')!, false)
  assert.equal('backgroundWork' in listed.get('history')!, false, 'a chat with no live session has none')
})

test('a live session the history does not hold yet lists its background work too', async () => {
  const listed = await listedBy({
    threads: { other: [] },
    sessions: [session('fresh', { phase: 'idle', backgroundAgents: 1 })],
  })
  assert.deepEqual(listed.get('fresh')?.backgroundWork, { agents: 1, monitors: 0 })
  assert.equal(listed.get('fresh')?.phase, 'idle')
})

test('the client validator keeps background work it can read and drops the rest, never the row', async () => {
  const [row] = JSON.parse(
    JSON.stringify(
      await hostFor({
        threads: { chat: [indexed('agent-1')] },
        sessions: [session('chat', { backgroundAgents: 1 })],
      }).list(),
    ),
  ) as Array<Record<string, unknown>>
  const malformed = [
    true,
    3,
    { agents: 0, monitors: 0 },
    { agents: -1, monitors: 1 },
    { agents: 1.5, monitors: 0 },
    { agents: '1', monitors: 0 },
    { agents: 1 },
  ]
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      row,
      ...malformed.map((backgroundWork, index) => ({ ...row, agentId: `agent-${index + 2}`, backgroundWork })),
    ],
  })
  assert.ok(parsed?.type === 'sessions')
  assert.equal(parsed.sessions.length, malformed.length + 1)
  assert.deepEqual(parsed.sessions[0]?.backgroundWork, { agents: 1, monitors: 0 })
  for (const thread of parsed.sessions.slice(1)) assert.equal('backgroundWork' in thread, false)
  assert.deepEqual(parseConversationBackgroundWork({ agents: 0, monitors: 3, extra: 'x' }), { agents: 0, monitors: 3 })
})
