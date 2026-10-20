import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { parseConversationServerFrame } from '../../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { ConversationThread as IndexedThread } from '../../../shared/conversation-index'
import { conversationPhaseWorking, conversationSummaryPhase } from '../../../shared/conversation/phase'
import { WORKING_STRETCH_GAP_MS } from '../../../shared/conversation/workingStretch'
import type { MeshConnection, MeshConversation } from '../../../shared/tailnet-mesh'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import { buildRemoteBand } from '../../../renderer/src/components/workspace/remoteBand/remoteSessionsModel'
import { createConversationSessionsStore } from '../../../renderer/src/hooks/conversationSessionsStore'
import { ConversationRuntime } from '../../conversation-runtime'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
} from '../../providers/conversation-provider-adapter'
import { createConversationGatewayHost, type ConversationListWorkspace } from './tailnet-conversation-host'

// How long a chat has been working, as a paired machine reads it from this
// desktop's list: from the person's message that began the work, through the
// turns the chat opens by itself while its background agent works, the same
// number this desktop's own sidebar counts from. The Mac mini read 14m while
// the MacBook Air following it read 5s: the Air counted from each turn the
// chat had opened by itself, and between them read it as idle.

function runtimeEvent(
  input: MockAdapterSessionInput,
  type: ConversationEvent['type'],
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

/**
 * A provider whose every send starts an agent in the background and ends its
 * turn, and which reports that agent, and the turns its result wakes the chat
 * for, on the session's continuation channel.
 */
function backgroundAgentProvider() {
  let sink: ((event: ConversationEvent) => void) | undefined
  let session: MockAdapterSessionInput | undefined
  const adapter: ConversationProviderAdapter = {
    id: 'agent-provider',
    sessions: 'stateful',
    listModels: () => ['model'],
    startSession: (input) => {
      sink = input.onSessionEvent
      session = input
      return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
    },
    sendTurn: (input) => [
      runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
      runtimeEvent(input, 'subagent_status', {
        toolUseId: 'task_1',
        status: 'running',
        background: true,
        description: 'Run the long suite',
      }),
      runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'The suite runs in the background.' }),
      runtimeEvent(input, 'turn_completed', { turnId: input.turnId }),
    ],
    resolveApproval: () => [],
    interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [runtimeEvent(input, 'session_closed')],
  }
  const push = (type: ConversationEvent['type'], payload?: Record<string, unknown>) =>
    sink!(runtimeEvent(session!, type, payload))
  return {
    adapter,
    agentEnds: () =>
      push('subagent_status', { toolUseId: 'task_1', status: 'completed', background: true, description: 'Run' }),
    wakes: (turnId: string) => push('turn_started', { turnId }),
    replies: (turnId: string) => push('content_delta', { turnId, text: 'The suite passed.' }),
    ends: (turnId: string) => push('turn_completed', { turnId }),
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate())
}

async function chatOnTheMini() {
  let clock = 1_000_000
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-working-since-'))
  const provider = backgroundAgentProvider()
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    now: () => clock,
  })
  const host = createConversationGatewayHost(
    runtime,
    () => workspaceRoot,
    () => [{ workspaceId: 'workspace', workspaceRoot }],
    () => 'bypass',
  )
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'agent-provider',
    modelId: 'model',
  })
  assert.ok(started.ok)
  const summary = (): ConversationSessionSummary => {
    const listed = runtime.listSessions()
    assert.ok(listed.ok)
    return listed.sessions[0]!
  }
  // What a paired machine is sent, as it reads it off the wire.
  const listed = async (): Promise<MeshConversation> => {
    const frame = parseConversationServerFrame(
      JSON.parse(JSON.stringify({ type: 'sessions', requestId: 'list', sessions: await host.list() })),
    )
    assert.ok(frame?.type === 'sessions')
    assert.equal(frame.sessions.length, 1)
    return frame.sessions[0]!
  }
  return {
    runtime,
    provider,
    summary,
    listed,
    sessionId: started.session.sessionId,
    at: (time: number) => {
      clock = time
    },
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a chat stays working from the person’s message through the turns its background agent wakes it for', async () => {
  const chat = await chatOnTheMini()
  try {
    const t0 = 1_000_000
    chat.at(t0)
    assert.ok((await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'Run the long suite' })).ok)

    // The turn is over and the agent it launched works on: working, from t0.
    chat.at(t0 + 60_000)
    const between = await chat.listed()
    assert.equal(between.phase, 'completed', 'the phase stays the turn’s own')
    assert.deepEqual(between.backgroundWork, { agents: 1, monitors: 0 })
    assert.equal(between.turnStartedAt, undefined)
    assert.equal(between.workingSince, t0)

    // The chat opens a turn by itself at t1: the turn has its own start, the
    // work does not restart.
    const t1 = t0 + 14 * 60_000
    chat.at(t1)
    chat.provider.wakes('cont_1')
    chat.provider.replies('cont_1')
    await until(() => chat.summary().status === 'active')
    chat.at(t1 + 5_000)
    const woken = await chat.listed()
    assert.equal(woken.phase, 'running')
    assert.equal(woken.turnStartedAt, t1)
    assert.equal(woken.workingSince, t0, 'fourteen minutes of work, not five seconds')

    chat.provider.ends('cont_1')
    await until(() => chat.summary().status === 'ready')
    assert.equal((await chat.listed()).workingSince, t0, 'and between that turn and the next')

    // Its last agent ends and wakes it once more, a moment later: still the same work.
    chat.at(t1 + 60_000)
    chat.provider.agentEnds()
    await until(() => !chat.summary().backgroundAgents)
    const settledForAMoment = await chat.listed()
    assert.equal(settledForAMoment.workingSince, undefined, 'nothing in hand reports no start')
    assert.equal(settledForAMoment.backgroundWork, undefined)
    chat.at(t1 + 63_000)
    chat.provider.wakes('cont_2')
    chat.provider.replies('cont_2')
    await until(() => chat.summary().status === 'active')
    assert.equal((await chat.listed()).workingSince, t0)
    chat.provider.ends('cont_2')
    await until(() => chat.summary().status === 'ready')

    // Settled with nothing working: idle, with no start at all.
    chat.at(t1 + 120_000)
    const idle = await chat.listed()
    assert.equal(idle.phase, 'completed')
    assert.equal(idle.backgroundWork, undefined)
    assert.equal(idle.workingSince, undefined)
    assert.equal(idle.turnStartedAt, undefined)
  } finally {
    await chat.cleanup()
  }
})

test('the person writing again, or the chat waking long after it settled, begins new work', async () => {
  const chat = await chatOnTheMini()
  try {
    const t0 = 1_000_000
    chat.at(t0)
    assert.ok((await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'Run the long suite' })).ok)
    // The person sends again while the agent still works.
    const t1 = t0 + 5 * 60_000
    chat.at(t1)
    assert.ok((await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'And the docs build' })).ok)
    assert.equal((await chat.listed()).workingSince, t1)

    // The agent ends and the chat sits with nothing in hand past the gap; a
    // turn it opens after that is new work.
    chat.at(t1 + 60_000)
    chat.provider.agentEnds()
    await until(() => !chat.summary().backgroundAgents)
    const t2 = t1 + 60_000 + WORKING_STRETCH_GAP_MS + 1
    chat.at(t2)
    chat.provider.wakes('cont_1')
    chat.provider.replies('cont_1')
    await until(() => chat.summary().status === 'active')
    assert.equal((await chat.listed()).workingSince, t2)
  } finally {
    await chat.cleanup()
  }
})

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

function hostOf(sessions: ConversationSessionSummary[], records: Record<string, ConversationListWorkspace> = {}) {
  const runtime = {
    listSessions: () => ({ ok: true, sessions }),
    listThreads: async () => ({ ok: true, threads: [indexed('agent-1')] }),
    getProviderCapabilities: () => undefined,
  } as unknown as ConversationBackend
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => Object.keys(records).map((workspaceId) => ({ workspaceId, workspaceRoot: '/Users/dev/app' })),
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { workspaceOf: (workspaceId) => records[workspaceId] ?? null },
  )
}

test('a listed chat names the schedule that started it, and a snooze still ahead', async () => {
  const now = Date.now()
  const record = (fields: Partial<ConversationListWorkspace>): ConversationListWorkspace => ({
    name: 'Nightly triage',
    createdAt: now - 60_000,
    lastVisitedAt: now - 60_000,
    ...fields,
  })
  const listed = new Map(
    (
      await hostOf([], {
        run: record({ scheduledAgentId: 'sa-1' }),
        mine: record({ name: 'Fix the parser' }),
        sleeping: record({ snoozedUntil: now + 3_600_000 }),
        woke: record({ snoozedUntil: now - 1 }),
      }).list()
    ).map((thread) => [thread.workspaceId, thread]),
  )
  assert.equal(listed.get('run')?.scheduledAgentId, 'sa-1')
  assert.equal('scheduledAgentId' in listed.get('mine')!, false, 'a chat a person started carries none')
  assert.equal(listed.get('sleeping')?.snoozedUntil, Math.trunc(now + 3_600_000))
  assert.equal('snoozedUntil' in listed.get('woke')!, false, 'a snooze that has run out is a chat awake')
  // The client validator keeps both.
  const frame = parseConversationServerFrame(
    JSON.parse(JSON.stringify({ type: 'sessions', requestId: 'list', sessions: [...listed.values()] })),
  )
  assert.ok(frame?.type === 'sessions')
  const parsed = new Map(frame.sessions.map((thread) => [thread.workspaceId, thread]))
  assert.equal(parsed.get('run')?.scheduledAgentId, 'sa-1')
  assert.equal(parsed.get('sleeping')?.snoozedUntil, Math.trunc(now + 3_600_000))
})

test('one summary reads as the same work, from the same start, in this desktop’s sidebar and on a paired machine', async () => {
  const t0 = 1_000_000
  const summaries: Array<[string, Partial<ConversationSessionSummary>, { working: boolean; since?: number }]> = [
    // The turn is over and an agent works on.
    [
      'between turns',
      { status: 'ready', phase: 'completed', backgroundAgents: 1, workingSince: t0, updatedAt: t0 + 600_000 },
      { working: true, since: t0 },
    ],
    // A turn the chat opened by itself.
    [
      'a woken turn',
      {
        status: 'active',
        phase: 'running',
        backgroundAgents: 1,
        turnStartedAt: t0 + 840_000,
        workingSince: t0,
        updatedAt: t0 + 845_000,
      },
      { working: true, since: t0 },
    ],
    // A monitor that will wake it, with an idle phase.
    [
      'a monitor',
      {
        status: 'ready',
        phase: 'idle',
        backgroundTasks: [{ taskId: 'm1', kind: 'monitor', description: 'CI checks' }],
        workingSince: t0,
      },
      { working: true, since: t0 },
    ],
    ['settled', { status: 'ready', phase: 'completed', lastTurnEndedAt: t0 + 900_000 }, { working: false }],
  ]
  const mini: MeshConnection = {
    id: 'c-mini',
    machineName: 'mac-mini',
    endpoint: 'mac-mini.tail1234.ts.net:8471',
    deviceId: 'tnd_mini',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  for (const [name, fields, expected] of summaries) {
    const summary: ConversationSessionSummary = {
      sessionId: 'conv-chat',
      workspaceId: 'chat',
      agentId: 'agent-1',
      providerId: 'mock',
      modelId: 'default',
      createdAt: 1,
      updatedAt: t0,
      status: 'ready',
      ...fields,
    }

    // This desktop: the sidebar's store, and the phase its rows read.
    vi.useFakeTimers()
    const store = createConversationSessionsStore({
      api: () => ({ conversationSessionsList: async () => ({ ok: true as const, sessions: [summary] }) }),
      activity: () => ({
        get: () => ({ visible: true, focused: true }),
        subscribe: () => () => undefined,
        dispose: () => undefined,
      }),
    })
    const dispose = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    const entry = store.getSnapshot()[0]!
    dispose()
    vi.useRealTimers()
    const local = {
      working: conversationPhaseWorking(conversationSummaryPhase(entry)),
      since: entry.turnStartedAt,
    }

    // The paired machine: the list it is sent, read into its row.
    const frame = parseConversationServerFrame(
      JSON.parse(
        JSON.stringify({
          type: 'sessions',
          requestId: 'list',
          sessions: await hostOf([summary], { chat: { name: 'Chat', createdAt: 1 } }).list(),
        }),
      ),
    )
    assert.ok(frame?.type === 'sessions')
    const [group] = buildRemoteBand({
      connections: [mini],
      browses: new Map([
        [mini.id, { browse: null, loading: false, error: null, at: 1, conversations: frame.sessions }],
      ]),
      reachability: new Map(),
      workspaces: [],
    })
    const row = group!.rows[0]!
    const remote = { working: row.activity === 'working', since: row.activity === 'working' ? row.since : undefined }

    assert.equal(local.working, expected.working, `${name}: this desktop`)
    assert.deepEqual(remote, local, `${name}: the paired machine reads it as this desktop does`)
    if (expected.since !== undefined) assert.equal(local.since, expected.since, name)
  }
})
