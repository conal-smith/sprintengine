import assert from 'node:assert/strict'
import { workspaceStorePath } from './workspace-store'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConversationRuntime } from './conversation-runtime'
import type { LoadedConversationProvider } from '../shared/plugin-manifest'
import type { ProviderSecretStore } from './secret-store'
import type {
  ConversationMessage,
  ConversationProviderAdapter,
  ConversationSessionEventSink,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './providers/mock-conversation-provider'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationPermissionPreset,
} from '../shared/conversation-runtime'
import { test } from 'vitest'

// Every runtime a case creates is shut down before its workspace is removed.
// A runtime left running holds its transcript streams open until the garbage
// collector closes them, which newer Node versions report as an error.
const liveRuntimes = new Set<ConversationRuntime>()
class TrackedConversationRuntime extends ConversationRuntime {
  constructor(options?: ConstructorParameters<typeof ConversationRuntime>[0]) {
    super(options)
    liveRuntimes.add(this)
  }
}
async function shutdownRuntimes(): Promise<void> {
  const runtimes = Array.from(liveRuntimes)
  liveRuntimes.clear()
  await Promise.all(runtimes.map((runtime) => runtime.shutdown().catch(() => undefined)))
}

test('conversation-runtime', async () => {
  async function main(): Promise<void> {
    await testMockSessionTurnApprovalInterruptStopAndPersistence()
    await testStartFailuresAreExplicit()
    await testProviderWithAuthRequiresConfiguredSecret()
    await testBlockedExecutableProviderTrustErrorSurfaces()
    await testOpenAiCompatibleRuntimeTurnCompletesThroughLocalEndpoint()
    await testMultiTurnHistoryAccumulates()
    await testImageAttachmentsReachTheAdapterButNotHistoryOrTranscript()
    await testImageOnlyFirstTurnLeavesTheFirstMessageToTheNextWords()
    await testSetPermissionAppliesThroughTheAdapterOrRefuses()
    await testSetModelSwitchesALiveSessionOrRefuses()
    await testPermissionTransitionsAreSerialized()
    await testInterruptSuppressesLateAsyncProviderEvents()
    await testStopSessionSuppressesLateAsyncProviderEvents()
    await testStatefulProviderMidTurnApprovalAndNoHistoryReplay()
    await testToolAfterTurnResultResolvesThroughContinuationChannel()
    await testSendIsRejectedWhileAContinuationTurnIsOpen()
    await testBackgroundAgentsKeepTheSessionWorkingAndEndWithTheirProcess()
    await testContinuationTurnDoesNotSuppressAnInFlightUserTurn()
    await testSubagentToolEventsKeepTheirParentLink()
    await testStatefulProviderResumeCursorReadFromTranscript()
    await testResumeCursorWrittenByAnotherProviderIsIgnored()
    await testReadTranscriptClosesUnfinishedTurns()
    await testTurnFailureWithDanglingApprovalDoesNotWedgeTheSession()
    await testIdleSweepDisposesOnlyTrulyIdleSessions()
    await testSuspendSessionEndsTheChildAndKeepsTheSession()
    await testShutdownStopsSessionsAndDisposesChildren()
    await testStartingAChatAgainKeepsOneSessionForIt()
    await testListLiveConversationRootsMapsAdapterInventory()
    await testMcpServersReachOnlyAProviderThatTakesThem()

    await shutdownRuntimes()
    console.log('conversation-runtime tests passed')
  }

  async function testMcpServersReachOnlyAProviderThatTakesThem(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-mcp-servers-'))
    const received: Array<MockAdapterSessionInput['mcpServers']> = []
    const adapter = (id: string, acceptsMcpServers: boolean): ConversationProviderAdapter => ({
      id,
      displayName: id === 'takes' ? 'Takes' : 'Plain',
      sessions: 'stateful',
      ...(acceptsMcpServers ? { acceptsMcpServers } : {}),
      listModels: () => ['model'],
      startSession: (input) => {
        received.push(input.mcpServers)
        return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
      },
      sendTurn: async function* () {},
      resolveApproval: () => [],
      interrupt: () => [],
      stopSession: () => [],
    })
    const server = { id: 'railway', name: 'Railway', transport: 'stdio' as const, command: 'npx' }
    try {
      const runtime = new TrackedConversationRuntime({
        adapters: [adapter('takes', true), adapter('plain', false)],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const base = { workspaceRoot, workspaceId: 'ws-1', modelId: 'model' }
      const started = await runtime.startSession({ ...base, agentId: 'a', providerId: 'takes', mcpServers: [server] })
      assert.equal(started.ok, true)
      assert.deepEqual(received, [[server]])
      // Never reported: a server's env can carry the person's tokens.
      assert.equal(started.ok && 'mcpServers' in started.session, false)

      // Refused before the provider is asked, naming the provider and the server.
      const refused = await runtime.startSession({ ...base, agentId: 'b', providerId: 'plain', mcpServers: [server] })
      assert.equal(refused.ok, false)
      assert.match(refused.ok ? '' : refused.message, /A Plain chat cannot be started with MCP servers of its own/)
      assert.match(refused.ok ? '' : refused.message, /"Railway"/)
      assert.equal(received.length, 1)

      // Without servers, a provider that takes none starts as always.
      assert.equal((await runtime.startSession({ ...base, agentId: 'c', providerId: 'plain' })).ok, true)

      // The same chat asked for with other servers is a different process.
      const again = await runtime.startSession({ ...base, agentId: 'a', providerId: 'takes', mcpServers: [] })
      assert.equal(again.ok, true)
      assert.notEqual(again.ok && again.session.sessionId, started.ok && started.session.sessionId)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Stateful adapter with the optional lifecycle surface, for idle-sweep and
  // shutdown coverage. `sendTurn('ask')` blocks on a mid-turn approval;
  // anything else completes immediately.
  function createLifecycleProvider(capture: {
    disposedChildren: string[]
    disposeAllCalls: number
    stoppedSessions: string[]
    live: Array<Record<string, unknown>>
  }): ConversationProviderAdapter {
    let pending: { requestId: string; resolve: (approved: boolean) => void } | null = null
    return {
      id: 'lifecycle-provider',
      sessions: 'stateful',
      listModels: () => ['lifecycle-model'],
      startSession(input) {
        return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
      },
      async *sendTurn(input: MockAdapterTurnInput) {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        if (input.message === 'ask') {
          yield runtimeEvent(input, 'approval_requested', {
            turnId: input.turnId,
            requestId: input.requestId,
            action: 'Bash',
            summary: 'Bash: ls',
          })
          const approved = await new Promise<boolean>((resolve) => {
            pending = { requestId: input.requestId, resolve }
          })
          yield runtimeEvent(input, 'approval_resolved', { turnId: input.turnId, requestId: input.requestId, approved })
        }
        yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
      },
      resolveApproval(input) {
        if (pending && pending.requestId === input.requestId) {
          const resolve = pending.resolve
          pending = null
          resolve(input.approved)
        }
        return []
      },
      interrupt(input) {
        return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
      },
      stopSession(input) {
        capture.stoppedSessions.push(input.sessionId)
        return [runtimeEvent(input, 'session_closed')]
      },
      listLiveSessions() {
        return capture.live as never
      },
      disposeChildProcess(sessionId: string) {
        capture.disposedChildren.push(sessionId)
        return true
      },
      disposeAll() {
        capture.disposeAllCalls += 1
      },
    }
  }

  function lifecycleCapture(): {
    disposedChildren: string[]
    disposeAllCalls: number
    stoppedSessions: string[]
    live: Array<Record<string, unknown>>
  } {
    return { disposedChildren: [], disposeAllCalls: 0, stoppedSessions: [], live: [] }
  }

  // A provider child that dies while a permission card is pending emits
  // approval_requested with no resolution, then turn_failed. The terminal event
  // must win: the session ends 'failed' (not wedged in awaiting_approval) and
  // the next send is accepted.
  async function testTurnFailureWithDanglingApprovalDoesNotWedgeTheSession(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const crashingProvider: ConversationProviderAdapter = {
        id: 'crashing-provider',
        sessions: 'stateful',
        listModels: () => ['crash-model'],
        startSession(input) {
          return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
        },
        sendTurn(input: MockAdapterTurnInput) {
          if (input.message === 'crash') {
            return [
              runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
              runtimeEvent(input, 'approval_requested', {
                turnId: input.turnId,
                requestId: input.requestId,
                action: 'Bash',
                summary: 'Bash: ls',
              }),
              runtimeEvent(input, 'turn_failed', { turnId: input.turnId, reason: 'provider', message: 'child died' }),
            ]
          }
          return [
            runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
            runtimeEvent(input, 'turn_completed', { turnId: input.turnId }),
          ]
        },
        resolveApproval() {
          return []
        },
        interrupt(input) {
          return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
        },
        stopSession(input) {
          return [runtimeEvent(input, 'session_closed')]
        },
      }
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [crashingProvider],
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'crashing-provider',
        modelId: 'crash-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId

      const crashed = await runtime.sendTurn({ sessionId, message: 'crash' })
      assert.equal(crashed.ok, true)
      if (!crashed.ok) return
      assert.equal(crashed.session.status, 'failed', 'terminal event outranks the dangling approval')

      // The session is not wedged: the next send is accepted and completes.
      const retried = await runtime.sendTurn({ sessionId, message: 'retry' })
      assert.equal(retried.ok, true)
      if (!retried.ok) return
      assert.equal(retried.session.status, 'ready')
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testIdleSweepDisposesOnlyTrulyIdleSessions(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      let clock = 1_000_000
      const capture = lifecycleCapture()
      const runtime = new TrackedConversationRuntime({
        now: () => clock,
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createLifecycleProvider(capture)],
      })
      runtime.setIdleThresholdMs(60_000)
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'lifecycle-provider',
        modelId: 'lifecycle-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId

      await runtime.sendTurn({ sessionId, message: 'hello' })
      const completedAt = clock
      // When the person last sent something, read off the message itself.
      const sent = runtime.listSessions({ workspaceId: 'workspace' })
      assert.equal(sent.ok && sent.sessions[0]?.lastUserMessageAt, completedAt)
      assert.equal(sent.ok && sent.sessions[0]?.resting, undefined)

      // Not yet past the threshold: nothing disposed.
      assert.deepEqual(runtime.sweepIdleSessions(completedAt + 59_000), [])
      // Past the threshold: the idle child goes away, session survives.
      events.length = 0
      assert.deepEqual(runtime.sweepIdleSessions(completedAt + 61_000), [sessionId])
      assert.deepEqual(capture.disposedChildren, [sessionId])
      const listed = runtime.listSessions({ workspaceId: 'workspace' })
      assert.equal(listed.ok && listed.sessions[0]?.status, 'ready')
      // It says it rests, and the session lists are told once to read again.
      assert.equal(listed.ok && listed.sessions[0]?.resting, true)
      assert.deepEqual(events, ['session_updated'])
      runtime.sweepIdleSessions(completedAt + 62_000)
      assert.deepEqual(events, ['session_updated'])

      // A pending approval/question card blocks disposal no matter how idle.
      clock += 5_000
      const askPromise = runtime.sendTurn({ sessionId, message: 'ask' })
      await waitForEvent(events, 'approval_requested')
      const asking = runtime.listSessions({ workspaceId: 'workspace' })
      assert.equal(asking.ok && asking.sessions[0]?.resting, undefined)
      assert.equal(asking.ok && asking.sessions[0]?.lastUserMessageAt, clock)
      const askedAt = clock
      assert.equal(asking.ok && asking.sessions[0]?.waitingSince, askedAt, 'waiting since the card went up')
      assert.equal(sent.ok && sent.sessions[0]?.waitingSince, undefined, 'nothing was asked before')
      // Time passing while it waits does not move when it started waiting.
      clock += 30_000
      const stillAsking = runtime.listSessions({ workspaceId: 'workspace' })
      assert.equal(stillAsking.ok && stillAsking.sessions[0]?.waitingSince, askedAt)
      assert.deepEqual(runtime.sweepIdleSessions(clock + 10_000_000), [])
      const requestEvent = await readLastEvent(workspaceRoot, 'workspace', 'agent')
      await runtime.respondToRequest({
        sessionId,
        requestId: requestEvent.payload?.requestId as string,
        approved: true,
      })
      await askPromise
      const answered = runtime.listSessions({ workspaceId: 'workspace' })
      assert.equal(answered.ok && answered.sessions[0]?.waitingSince, undefined, 'answered, it waits no more')
      // Answered and idle again → disposable.
      clock += 1
      assert.deepEqual(runtime.sweepIdleSessions(clock + 61_000), [sessionId])
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Settle and Snooze: the child goes whatever the session is doing, and the
  // session stays usable, so an un-settled chat takes the next message.
  async function testSuspendSessionEndsTheChildAndKeepsTheSession(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const capture = lifecycleCapture()
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createLifecycleProvider(capture)],
      })
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'lifecycle-provider',
        modelId: 'lifecycle-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId

      // Idle: the child is disposed, the session is not stopped.
      await runtime.sendTurn({ sessionId, message: 'hello' })
      const idle = await runtime.suspendSession({ sessionId })
      assert.equal(idle.ok && idle.session.status, 'ready')
      assert.equal(idle.ok && idle.session.resting, true)
      assert.deepEqual(capture.disposedChildren, [sessionId])
      assert.deepEqual(capture.stoppedSessions, [])

      // Mid-turn, at a pending approval: the turn is interrupted, then the
      // child disposed. The idle sweep would have left this one running.
      void runtime.sendTurn({ sessionId, message: 'ask' })
      await waitForEvent(events, 'approval_requested')
      const busy = await runtime.suspendSession({ sessionId })
      assert.equal(busy.ok && busy.session.status, 'ready')
      assert.deepEqual(events.slice(-2), ['turn_failed', 'session_updated'])
      assert.deepEqual(capture.disposedChildren, [sessionId, sessionId])

      // The next message is taken, which a stopped session would refuse.
      const resumed = await runtime.sendTurn({ sessionId, message: 'hello again' })
      assert.equal(resumed.ok && resumed.session.status, 'ready')
      assert.equal(resumed.ok && resumed.session.resting, undefined)

      // Stopping disposes too (a child still spawning is cancelled); a stopped
      // session has nothing left to suspend; an unknown one is refused.
      await runtime.stopSession({ sessionId })
      assert.deepEqual(capture.disposedChildren, [sessionId, sessionId, sessionId])
      const stopped = await runtime.suspendSession({ sessionId })
      assert.equal(stopped.ok && stopped.session.status, 'stopped')
      assert.deepEqual(capture.disposedChildren, [sessionId, sessionId, sessionId])
      assert.equal((await runtime.suspendSession({ sessionId: 'missing' })).ok, false)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A chat view that remounts asks to start a chat main already holds. It gets
  // that session back while it is live; one that failed is replaced, not kept
  // beside the new one, so a chat never shows as two agents.
  async function testStartingAChatAgainKeepsOneSessionForIt(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const stopped: string[] = []
      const provider: ConversationProviderAdapter = {
        id: 'restart-provider',
        sessions: 'stateful',
        listModels: () => ['restart-model'],
        startSession(input) {
          return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
        },
        sendTurn(input: MockAdapterTurnInput) {
          return [
            runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
            input.message === 'crash'
              ? runtimeEvent(input, 'turn_failed', { turnId: input.turnId, reason: 'provider', message: 'child died' })
              : runtimeEvent(input, 'turn_completed', { turnId: input.turnId }),
          ]
        },
        resolveApproval() {
          return []
        },
        interrupt(input) {
          return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
        },
        stopSession(input) {
          stopped.push(input.sessionId)
          return [runtimeEvent(input, 'session_closed')]
        },
      }
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [provider],
      })
      const start = () =>
        runtime.startSession({
          workspaceRoot,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'restart-provider',
          modelId: 'restart-model',
        })
      const listed = () => {
        const result = runtime.listSessions({ workspaceId: 'workspace', agentId: 'agent' })
        return result.ok ? result.sessions.map((session) => session.sessionId) : []
      }

      const first = await start()
      assert.equal(first.ok, true)
      if (!first.ok) return
      const again = await start()
      assert.equal(again.ok && again.session.sessionId, first.session.sessionId)
      assert.deepEqual(listed(), [first.session.sessionId])

      const crashed = await runtime.sendTurn({ sessionId: first.session.sessionId, message: 'crash' })
      assert.equal(crashed.ok, true)
      const failed = runtime.listSessions({ agentId: 'agent' })
      assert.equal(failed.ok && failed.sessions[0]?.status, 'failed')
      const replaced = await start()
      assert.equal(replaced.ok, true)
      if (!replaced.ok) return
      assert.notEqual(replaced.session.sessionId, first.session.sessionId)
      assert.deepEqual(stopped, [first.session.sessionId])
      assert.deepEqual(listed(), [replaced.session.sessionId])
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testShutdownStopsSessionsAndDisposesChildren(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const capture = lifecycleCapture()
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createLifecycleProvider(capture)],
      })
      const first = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent-one',
        providerId: 'lifecycle-provider',
        modelId: 'lifecycle-model',
      })
      const second = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent-two',
        providerId: 'lifecycle-provider',
        modelId: 'lifecycle-model',
      })
      assert.equal(first.ok && second.ok, true)

      await runtime.shutdown()
      assert.equal(capture.stoppedSessions.length, 2)
      assert.equal(capture.disposeAllCalls, 1)
      const listed = runtime.listSessions({})
      assert.equal(listed.ok && listed.sessions.every((session) => session.status === 'stopped'), true)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testListLiveConversationRootsMapsAdapterInventory(): Promise<void> {
    const capture = lifecycleCapture()
    capture.live.push(
      {
        sessionId: 'conv_live',
        workspaceId: 'workspace',
        agentId: 'agent-one',
        workspaceRoot: '/tmp/x',
        providerSessionId: 'cursor',
        hasChildProcess: true,
        childPid: 4242,
        turnActive: true,
        pendingApproval: false,
        lastActivityAt: 5,
        spawnedAt: 3,
      },
      // No child process → not a root.
      {
        sessionId: 'conv_idle',
        workspaceId: 'workspace',
        agentId: 'agent-two',
        workspaceRoot: '/tmp/x',
        providerSessionId: null,
        hasChildProcess: false,
        childPid: null,
        turnActive: false,
        pendingApproval: false,
        lastActivityAt: 9,
        spawnedAt: null,
      },
    )
    const runtime = new TrackedConversationRuntime({
      getProviderById: () => undefined,
      secretStore: unusedSecretStore(),
      adapters: [createLifecycleProvider(capture)],
    })
    const roots = runtime.listLiveConversationRoots()
    assert.equal(roots.length, 1)
    assert.deepEqual(roots[0], {
      sessionId: 'conv_live',
      rootPid: 4242,
      workspaceId: 'workspace',
      agentId: 'agent-one',
      terminalId: null,
      kind: 'agent',
      // The adapter's own id names no CLI; one that does is labelled with it.
      cli: null,
      activityKind: 'working',
      processAlive: true,
      startedAt: 3,
    })
  }

  // A minimal stateful adapter: owns its own history (asserts the runtime does
  // NOT replay any), emits a mid-turn approval that must resolve through
  // resolveApproval while the same sendTurn stream keeps going.
  function createStatefulProvider(capture: {
    resumeSessionIds: Array<string | undefined>
    messages: Array<ConversationMessage[] | undefined>
  }): ConversationProviderAdapter {
    let pending: { requestId: string; resolve: (approved: boolean) => void } | null = null
    return {
      id: 'stateful-provider',
      sessions: 'stateful',
      listModels: () => ['stateful-model'],
      startSession(input) {
        capture.resumeSessionIds.push(input.resumeSessionId)
        return [
          runtimeEvent(input, 'session_started', { providerSessionId: input.resumeSessionId ?? null }),
          runtimeEvent(input, 'session_ready'),
        ]
      },
      async *sendTurn(input: MockAdapterTurnInput) {
        capture.messages.push(input.messages)
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        yield runtimeEvent(input, 'session_updated', { providerSessionId: 'provider-cursor-1' })
        yield runtimeEvent(input, 'approval_requested', {
          turnId: input.turnId,
          requestId: input.requestId,
          action: 'Bash',
          summary: 'Bash: ls',
        })
        const approved = await new Promise<boolean>((resolve) => {
          pending = { requestId: input.requestId, resolve }
        })
        yield runtimeEvent(input, 'approval_resolved', { turnId: input.turnId, requestId: input.requestId, approved })
        yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: approved ? 'done' : 'skipped' })
        yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
      },
      resolveApproval(input) {
        if (pending && pending.requestId === input.requestId) {
          const resolve = pending.resolve
          pending = null
          resolve(input.approved)
        }
        return []
      },
      interrupt(input) {
        return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
      },
      stopSession(input) {
        return [runtimeEvent(input, 'session_closed')]
      },
    }
  }

  async function testStatefulProviderMidTurnApprovalAndNoHistoryReplay(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      let id = 0
      const capture: {
        resumeSessionIds: Array<string | undefined>
        messages: Array<ConversationMessage[] | undefined>
      } = {
        resumeSessionIds: [],
        messages: [],
      }
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createStatefulProvider(capture)],
      })
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'stateful-provider',
        modelId: 'stateful-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      assert.deepEqual(capture.resumeSessionIds, [undefined])

      const sessionId = started.session.sessionId
      const sentPromise = runtime.sendTurn({ sessionId, message: 'run ls' })
      await waitForEvent(events, 'approval_requested')

      // While the approval is pending the turn is still live: a second send must
      // be rejected, and the pending request must be resolvable.
      const rejected = await runtime.sendTurn({ sessionId, message: 'too soon' })
      assert.equal(rejected.ok, false)

      const responded = await runtime.respondToRequest({ sessionId, requestId: 'approval_3', approved: true })
      assert.equal(responded.ok, true)
      if (!responded.ok) return
      assert.equal(responded.session.status, 'active')

      const sent = await sentPromise
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      assert.equal(sent.session.status, 'ready')
      // Stateful turns never receive replayed history.
      assert.deepEqual(capture.messages, [undefined])
      assert.deepEqual(events, [
        'session_started',
        'session_ready',
        'user_message',
        'turn_started',
        'session_updated',
        'approval_requested',
        'approval_resolved',
        'content_delta',
        'turn_completed',
      ])

      // A second turn still gets no history (the adapter owns it).
      const respondAgain = runtime.sendTurn({ sessionId, message: 'again' })
      for (let i = 0; i < 100; i += 1) {
        if (events.filter((type) => type === 'approval_requested').length >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await runtime.respondToRequest({ sessionId, requestId: 'approval_5', approved: false })
      const second = await respondAgain
      assert.equal(second.ok, true)
      assert.deepEqual(capture.messages, [undefined, undefined])
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A stateful adapter whose child keeps working after the turn `result`. The
  // sendTurn completes and its IPC resolves; only later — when a background
  // subagent completes and the model raises a tool approval — does the adapter
  // push events on the session-scoped continuation channel, exactly the 1775
  // scenario. `raiseBackgroundTool` stands in for that delayed resumption. The
  // approval must surface (not auto-deny) and resolve through respondToRequest.
  function createContinuationProvider(capture: {
    base: MockAdapterSessionInput | null
    sink: ConversationSessionEventSink | null
    resolved: Array<{ requestId: string; approved: boolean }>
  }): ConversationProviderAdapter {
    const contTurnId = 'cont_turn_1'
    return {
      id: 'continuation-provider',
      sessions: 'stateful',
      listModels: () => ['continuation-model'],
      startSession(input) {
        capture.base = input
        capture.sink = input.onSessionEvent ?? null
        return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
      },
      async *sendTurn(input: MockAdapterTurnInput) {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'launching background agents' })
        yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
      },
      resolveApproval(input) {
        capture.resolved.push({ requestId: input.requestId, approved: input.approved })
        const sink = capture.sink
        if (sink) {
          sink(
            runtimeEvent(input, 'approval_resolved', {
              turnId: contTurnId,
              requestId: input.requestId,
              approved: input.approved,
            }),
          )
          sink(
            runtimeEvent(input, 'content_delta', { turnId: contTurnId, text: input.approved ? 'ran ls' : 'skipped' }),
          )
          sink(runtimeEvent(input, 'turn_completed', { turnId: contTurnId }))
        }
        return []
      },
      interrupt(input) {
        return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
      },
      stopSession(input) {
        return [runtimeEvent(input, 'session_closed')]
      },
    }
  }

  async function testToolAfterTurnResultResolvesThroughContinuationChannel(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const capture: {
        base: MockAdapterSessionInput | null
        sink: ConversationSessionEventSink | null
        resolved: Array<{ requestId: string; approved: boolean }>
      } = { base: null, sink: null, resolved: [] }
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createContinuationProvider(capture)],
      })
      const events: ConversationEvent[] = []
      runtime.onEvent((event) => events.push(event))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'continuation-provider',
        modelId: 'continuation-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId

      const sent = await runtime.sendTurn({ sessionId, message: 'investigate' })
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      // The per-turn IPC resolved at `result`, freeing the composer — the child's
      // later work does not hold it open.
      assert.equal(sent.session.status, 'ready')

      // Later, a background subagent completes and the model raises a tool
      // approval over the continuation channel. It reaches the UI instead of
      // being auto-denied.
      const base = capture.base
      const sink = capture.sink
      assert.ok(base && sink, 'the adapter received a session-scoped continuation sink')
      if (!base || !sink) return
      sink(runtimeEvent(base, 'turn_started', { turnId: 'cont_turn_1' }))
      sink(
        runtimeEvent(base, 'approval_requested', {
          turnId: 'cont_turn_1',
          requestId: 'cont_req_1',
          action: 'Bash',
          summary: 'Bash: ls',
        }),
      )
      await waitForEventType(events, 'approval_requested')
      const request = events.find((event) => event.type === 'approval_requested')
      assert.equal(request?.payload?.requestId, 'cont_req_1')
      await waitForStatus(runtime, 'workspace', 'awaiting_approval')

      // The answer routes back through the unchanged respond-to-request path.
      const responded = await runtime.respondToRequest({ sessionId, requestId: 'cont_req_1', approved: true })
      assert.equal(responded.ok, true)
      await waitForStatus(runtime, 'workspace', 'ready')

      assert.deepEqual(
        capture.resolved,
        [{ requestId: 'cont_req_1', approved: true }],
        'the tool was answered, not auto-denied',
      )
      assert.deepEqual(
        events.map((event) => event.type),
        [
          'session_started',
          'session_ready',
          'user_message',
          'turn_started',
          'content_delta',
          'turn_completed',
          'turn_started',
          'approval_requested',
          'approval_resolved',
          'content_delta',
          'turn_completed',
        ],
      )
      // Nothing was denied and the session is usable again.
      assert.equal(
        events.some((event) => event.type === 'turn_failed'),
        false,
      )
      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      assert.equal(persisted.filter((event) => event.type === 'approval_requested').length, 1)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A background agent reports over the session channel after its turn ended.
  // The session summary counts it as work still running, and a restart marks an
  // agent the transcript left running as stopped: its process is gone.
  async function testBackgroundAgentsKeepTheSessionWorkingAndEndWithTheirProcess(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-background-agents-'))
    try {
      const capture: {
        base: MockAdapterSessionInput | null
        sink: ConversationSessionEventSink | null
        resolved: Array<{ requestId: string; approved: boolean }>
      } = { base: null, sink: null, resolved: [] }
      const start = (runtime: ConversationRuntime) =>
        runtime.startSession({
          workspaceRoot,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'continuation-provider',
          modelId: 'continuation-model',
        })
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createContinuationProvider(capture)],
      })
      const events: ConversationEvent[] = []
      runtime.onEvent((event) => events.push(event))
      const started = await start(runtime)
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'count the files' })
      assert.equal(sent.ok, true)
      const base = capture.base!
      const summary = () => runtime.listSessions({ workspaceId: 'workspace' })
      capture.sink!(runtimeEvent(base, 'subagent_status', { toolUseId: 'lane-1', status: 'running', background: true }))
      capture.sink!(
        runtimeEvent(base, 'subagent_status', { toolUseId: 'lane-2', status: 'running', background: false }),
      )
      await waitForEventType(events, 'subagent_status')
      for (let i = 0; i < 100 && events.filter((event) => event.type === 'subagent_status').length < 2; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      const working = summary()
      assert.equal(working.ok && working.sessions[0]?.backgroundAgents, 1, 'only background agents outlive a turn')
      assert.equal(working.ok && working.sessions[0]?.status, 'ready', 'the agents open no turn')

      // The app goes away with lane-1 still running; the next start stops it.
      await shutdownRuntimes()
      const restarted = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createContinuationProvider(capture)],
      })
      const again = await start(restarted)
      assert.equal(again.ok, true)
      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      const stopped = persisted.filter(
        (event) => event.type === 'subagent_status' && event.payload?.status === 'stopped',
      )
      assert.deepEqual(stopped.map((event) => event.payload?.toolUseId).sort(), ['lane-1', 'lane-2'])
      const after = restarted.listSessions({ workspaceId: 'workspace' })
      assert.equal(after.ok && after.sessions[0]?.backgroundAgents, undefined)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // 1798, half one: a continuation turn holds the session. `pendingRequestId` is
  // null throughout one (processContinuationEvent clears it), so the old guard let
  // a queued send in — which then took the provider's turn over and blanked the
  // continuation. The shared busy predicate rejects the send until it closes.
  async function testSendIsRejectedWhileAContinuationTurnIsOpen(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-send-race-'))
    try {
      const capture: {
        base: MockAdapterSessionInput | null
        sink: ConversationSessionEventSink | null
        resolved: Array<{ requestId: string; approved: boolean }>
      } = { base: null, sink: null, resolved: [] }
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createContinuationProvider(capture)],
      })
      const events: ConversationEvent[] = []
      runtime.onEvent((event) => events.push(event))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'continuation-provider',
        modelId: 'continuation-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId
      assert.equal((await runtime.sendTurn({ sessionId, message: 'investigate' })).ok, true)

      // A background subagent reports: the adapter opens a continuation turn.
      const base = capture.base
      const sink = capture.sink
      assert.ok(base && sink, 'the adapter received a session-scoped continuation sink')
      if (!base || !sink) return
      sink(runtimeEvent(base, 'turn_started', { turnId: 'cont_turn_1' }))
      sink(runtimeEvent(base, 'content_delta', { turnId: 'cont_turn_1', text: 'subagent reported' }))
      await waitForStatus(runtime, 'workspace', 'active')

      // The composer flushes a type-ahead message into that window. It is
      // busy, to send again, not failed.
      const busy = {
        ok: false,
        code: 'busy',
        retryAfterMs: 1_000,
        message: 'Conversation turn is already in progress.',
      }
      assert.deepEqual(await runtime.sendTurn({ sessionId, message: 'and this too' }), busy)
      // A phone's send under its command id is answered the same, and its
      // refusal is not kept as that command's answer.
      assert.deepEqual(await runtime.sendTurn({ sessionId, message: 'from the phone', commandId: 'phone-1' }), busy)
      assert.equal(
        events.filter((event) => event.type === 'user_message').length,
        1,
        'the rejected send never opened a turn or persisted a user bubble',
      )

      // Once the continuation closes, the same send is accepted.
      sink(runtimeEvent(base, 'turn_completed', { turnId: 'cont_turn_1' }))
      await waitForStatus(runtime, 'workspace', 'ready')
      const flushed = await runtime.sendTurn({ sessionId, message: 'and this too' })
      assert.equal(flushed.ok, true)
      assert.equal(events.filter((event) => event.type === 'user_message').length, 2)
      // And the phone's retry under the same id runs, rather than replaying
      // the busy refusal.
      await waitForStatus(runtime, 'workspace', 'ready')
      const retried = await runtime.sendTurn({ sessionId, message: 'from the phone', commandId: 'phone-1' })
      assert.equal(retried.ok, true, retried.ok ? '' : retried.message)
      assert.equal(events.filter((event) => event.type === 'user_message').length, 3)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // 1798, the reverse interleaving: a continuation turn opening while a user turn
  // streams used to overwrite `activeTurnId`, after which every remaining event of
  // the live turn was dropped by shouldSuppressEvent — blank in the UI and absent
  // from the JSONL. The live turn keeps the session; the raced mirror is dropped.
  async function testContinuationTurnDoesNotSuppressAnInFlightUserTurn(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-suppression-'))
    try {
      const capture: {
        base: MockAdapterSessionInput | null
        sink: ConversationSessionEventSink | null
        events: ConversationEvent[]
      } = { base: null, sink: null, events: [] }
      const adapter: ConversationProviderAdapter = {
        id: 'interleave-provider',
        sessions: 'stateful',
        listModels: () => ['interleave-model'],
        startSession(input) {
          capture.base = input
          capture.sink = input.onSessionEvent ?? null
          return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
        },
        async *sendTurn(input: MockAdapterTurnInput) {
          yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
          yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'first half' })
          // Mid-turn, a continuation the adapter opened before this send was
          // accepted reaches the runtime. The trailing session_updated carries no
          // turnId, so it is never suppressed: once it lands, the continuation
          // ahead of it in the serialized channel has been processed.
          const base = capture.base
          const sink = capture.sink
          if (base && sink) {
            sink(runtimeEvent(base, 'turn_started', { turnId: 'cont_turn_1' }))
            sink(runtimeEvent(base, 'session_updated', { providerSessionId: 'cursor-2' }))
            await waitForEventType(capture.events, 'session_updated')
          }
          yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'second half' })
          yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
        },
        resolveApproval: () => [],
        interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
        stopSession: (input) => [runtimeEvent(input, 'session_closed')],
      }

      const runtime = new TrackedConversationRuntime({
        adapters: [adapter],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      runtime.onEvent((event) => capture.events.push(event))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'interleave-provider',
        modelId: 'interleave-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return

      const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'investigate' })
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      assert.equal(sent.session.status, 'ready', 'the live turn completed under its own id')

      assert.deepEqual(
        capture.events.map((event) => event.type),
        [
          'session_started',
          'session_ready',
          'user_message',
          'turn_started',
          'content_delta',
          'session_updated',
          'content_delta',
          'turn_completed',
        ],
        'the raced continuation turn_started is dropped; every live-turn event survives',
      )
      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      assert.deepEqual(
        persisted.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text),
        ['first half', 'second half'],
        'both halves of the live turn reach the transcript',
      )
      assert.equal(
        persisted.some((event) => event.payload?.turnId === 'cont_turn_1'),
        false,
      )
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Subagent lanes (1777) are a provider-shaped contract: the runtime is a pipe
  // for them. `parentToolUseId` and the lane markers must survive broadcast and
  // persistence untouched, on the in-turn path and the continuation channel alike.
  async function testSubagentToolEventsKeepTheirParentLink(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-lanes-'))
    try {
      const capture: { base: MockAdapterSessionInput | null; sink: ConversationSessionEventSink | null } = {
        base: null,
        sink: null,
      }
      const adapter: ConversationProviderAdapter = {
        id: 'lane-provider',
        sessions: 'stateful',
        listModels: () => ['lane-model'],
        startSession(input) {
          capture.base = input
          capture.sink = input.onSessionEvent ?? null
          return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
        },
        async *sendTurn(input: MockAdapterTurnInput) {
          yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
          yield runtimeEvent(input, 'tool_started', {
            turnId: input.turnId,
            toolCallId: 'task_1',
            tool: 'Task',
            summary: 'Task: map the router',
            subagentLane: true,
            subagentType: 'Explore',
          })
          yield runtimeEvent(input, 'tool_started', {
            turnId: input.turnId,
            toolCallId: 'child_1',
            tool: 'Grep',
            summary: 'Grep: router',
            parentToolUseId: 'task_1',
          })
          yield runtimeEvent(input, 'tool_output', {
            turnId: input.turnId,
            toolCallId: 'child_1',
            output: '12 matches',
            isError: false,
            parentToolUseId: 'task_1',
          })
          yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
        },
        resolveApproval: () => [],
        interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
        stopSession: (input) => [runtimeEvent(input, 'session_closed')],
      }

      const runtime = new TrackedConversationRuntime({
        adapters: [adapter],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const events: ConversationEvent[] = []
      runtime.onEvent((event) => events.push(event))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'lane-provider',
        modelId: 'lane-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return

      const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'investigate' })
      assert.equal(sent.ok, true)

      // A subagent that finishes after the turn closed keeps the same link when
      // it arrives over the continuation channel.
      const base = capture.base
      const sink = capture.sink
      assert.ok(base && sink, 'the adapter received a session-scoped continuation sink')
      if (!base || !sink) return
      sink(runtimeEvent(base, 'turn_started', { turnId: 'cont_turn_1' }))
      sink(
        runtimeEvent(base, 'tool_started', {
          turnId: 'cont_turn_1',
          toolCallId: 'child_2',
          tool: 'Read',
          summary: 'Read: a.ts',
          parentToolUseId: 'task_1',
        }),
      )
      sink(runtimeEvent(base, 'turn_completed', { turnId: 'cont_turn_1' }))
      // The continuation channel is serialized off the send path. Its terminal
      // event also drains the index refresh before fixture files are removed.
      for (
        let i = 0;
        i < 100 && !events.some((event) => event.type === 'turn_completed' && event.payload?.turnId === 'cont_turn_1');
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      assert.ok(events.some((event) => event.type === 'turn_completed' && event.payload?.turnId === 'cont_turn_1'))

      const laneRows = events.filter((event) => event.type === 'tool_started' || event.type === 'tool_output')
      assert.deepEqual(
        laneRows.map((event) => event.payload?.parentToolUseId),
        [undefined, 'task_1', 'task_1', 'task_1'],
        'only the lane header is parentless; every child keeps its link',
      )
      assert.equal(laneRows[0]?.payload?.subagentLane, true)
      assert.equal(laneRows[0]?.payload?.subagentType, 'Explore')

      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      const persistedRows = persisted.filter((event) => event.type === 'tool_started' || event.type === 'tool_output')
      assert.deepEqual(
        persistedRows.map((event) => event.payload?.parentToolUseId),
        [undefined, 'task_1', 'task_1', 'task_1'],
        'the replayed transcript rebuilds the same lanes',
      )
      assert.equal(persistedRows[0]?.payload?.subagentLane, true)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testStatefulProviderResumeCursorReadFromTranscript(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const capture: {
        resumeSessionIds: Array<string | undefined>
        messages: Array<ConversationMessage[] | undefined>
      } = {
        resumeSessionIds: [],
        messages: [],
      }
      // Simulate a previous app run's transcript carrying the provider cursor.
      const dir = workspaceStorePath(workspaceRoot, 'conversations', 'workspace')
      await mkdir(dir, { recursive: true })
      const priorEvents = [
        {
          id: 'old_1',
          sessionId: 'conv_old',
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'stateful-provider',
          modelId: 'stateful-model',
          type: 'session_started',
          createdAt: 1,
          payload: { providerSessionId: null },
        },
        {
          id: 'old_2',
          sessionId: 'conv_old',
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'stateful-provider',
          modelId: 'stateful-model',
          type: 'session_updated',
          createdAt: 2,
          payload: { providerSessionId: 'cursor-from-disk' },
        },
      ]
      await writeFile(
        join(dir, 'agent.jsonl'),
        priorEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
        'utf-8',
      )

      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createStatefulProvider(capture)],
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'stateful-provider',
        modelId: 'stateful-model',
      })
      assert.equal(started.ok, true)
      assert.deepEqual(capture.resumeSessionIds, ['cursor-from-disk'])
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A transcript restarted on another provider holds that provider's cursor
  // last; this one resumes from the newest cursor it wrote itself.
  async function testResumeCursorWrittenByAnotherProviderIsIgnored(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const capture: {
        resumeSessionIds: Array<string | undefined>
        messages: Array<ConversationMessage[] | undefined>
      } = {
        resumeSessionIds: [],
        messages: [],
      }
      const dir = workspaceStorePath(workspaceRoot, 'conversations', 'workspace')
      await mkdir(dir, { recursive: true })
      const cursor = (
        id: string,
        sessionId: string,
        providerId: string,
        providerSessionId: string,
        createdAt: number,
      ) => ({
        id,
        sessionId,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId,
        modelId: 'model',
        type: 'session_updated',
        createdAt,
        payload: { providerSessionId },
      })
      const priorEvents = [
        cursor('old_1', 'conv_first', 'stateful-provider', 'own-cursor', 1),
        cursor('old_2', 'conv_second', 'other-provider', 'other-provider-thread', 2),
      ]
      await writeFile(
        join(dir, 'agent.jsonl'),
        priorEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
        'utf-8',
      )

      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createStatefulProvider(capture)],
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'stateful-provider',
        modelId: 'stateful-model',
      })
      assert.equal(started.ok, true)
      assert.deepEqual(capture.resumeSessionIds, ['own-cursor'])
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testReadTranscriptClosesUnfinishedTurns(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const dir = workspaceStorePath(workspaceRoot, 'conversations', 'workspace')
      await mkdir(dir, { recursive: true })
      const base = { sessionId: 'conv_x', workspaceId: 'workspace', agentId: 'agent', providerId: 'p', modelId: 'm' }
      const lines = [
        { id: 'e1', ...base, type: 'user_message', createdAt: 1, payload: { turnId: 't1', text: 'hi' } },
        { id: 'e2', ...base, type: 'turn_started', createdAt: 2, payload: { turnId: 't1' } },
        { id: 'e3', ...base, type: 'turn_completed', createdAt: 3, payload: { turnId: 't1' } },
        { id: 'e4', ...base, type: 'user_message', createdAt: 4, payload: { turnId: 't2', text: 'killed mid-turn' } },
        { id: 'e5', ...base, type: 'turn_started', createdAt: 5, payload: { turnId: 't2' } },
      ]
      await writeFile(join(dir, 'agent.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')

      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [],
      })
      const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId: 'workspace', agentId: 'agent' })
      assert.equal(transcript.ok, true)
      if (!transcript.ok) return
      assert.equal(transcript.events.length, 6)
      const closure = transcript.events.at(-1)
      assert.equal(closure?.type, 'turn_failed')
      assert.equal(closure?.payload?.turnId, 't2')
      assert.equal(closure?.payload?.reason, 'interrupted')

      // Missing transcript file → empty replay, not an error.
      const missing = await runtime.readTranscript({ workspaceRoot, workspaceId: 'workspace', agentId: 'nobody' })
      assert.deepEqual(missing, { ok: true, events: [] })
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testInterruptSuppressesLateAsyncProviderEvents(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      let id = 0
      const gate = createDeferred<void>()
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createSlowProvider(gate)],
      })
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'slow-provider',
        modelId: 'slow-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return

      const sentPromise = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'slow' })
      await waitForEvent(events, 'turn_started')
      const interrupted = await runtime.interrupt({ sessionId: started.session.sessionId })
      assert.equal(interrupted.ok, true)
      if (!interrupted.ok) return
      assert.equal(interrupted.session.status, 'ready')
      // Stopped is not failed: the sidebar reads the phase, and a stop it
      // called "Failed" flagged the chat as needing a look.
      assert.equal(interrupted.session.phase, 'completed')
      gate.resolve()
      const sent = await sentPromise
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      assert.equal(sent.session.status, 'ready')
      assert.deepEqual(events, ['session_started', 'session_ready', 'user_message', 'turn_started', 'turn_failed'])
      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      assert.deepEqual(
        persisted.map((event) => event.type),
        events,
      )
      assert.equal(JSON.stringify(persisted).includes('late output'), false)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testStopSessionSuppressesLateAsyncProviderEvents(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      let id = 0
      const gate = createDeferred<void>()
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
        adapters: [createSlowProvider(gate)],
      })
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'slow-provider',
        modelId: 'slow-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return

      const sentPromise = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'slow' })
      await waitForEvent(events, 'turn_started')
      const stopped = await runtime.stopSession({ sessionId: started.session.sessionId })
      assert.equal(stopped.ok, true)
      if (!stopped.ok) return
      assert.equal(stopped.session.status, 'stopped')
      gate.resolve()
      const sent = await sentPromise
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      assert.equal(sent.session.status, 'stopped')
      assert.deepEqual(events, [
        'session_started',
        'session_ready',
        'user_message',
        'turn_started',
        'turn_failed',
        'session_closed',
      ])
      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      assert.deepEqual(
        persisted.map((event) => event.type),
        events,
      )
      assert.equal(JSON.stringify(persisted).includes('late output'), false)
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testOpenAiCompatibleRuntimeTurnCompletesThroughLocalEndpoint(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    const server = createServer(handleOpenAiCompatibleRequest)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const provider = openAiProvider(`http://127.0.0.1:${address.port}`)
    try {
      let id = 0
      let now = 1000
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        now: () => ++now,
        getProviderById: () => provider,
        secretStore: {
          getStatus: async () => ({
            ok: true,
            status: {
              providerId: provider.manifest.id,
              configured: true,
              source: 'environment',
              persistence: 'environment',
              encryptionAvailable: false,
              label: 'API key',
            },
          }),
          resolveSecret: async () => ({
            ok: true,
            providerId: provider.manifest.id,
            value: 'sk-test',
            source: 'environment',
          }),
        },
      })
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))

      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: provider.manifest.id,
        modelId: 'test-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      assert.equal(sent.session.status, 'ready')
      assert.deepEqual(events, [
        'session_started',
        'session_ready',
        'user_message',
        'turn_started',
        'content_delta',
        'content_delta',
        'usage_updated',
        'turn_completed',
      ])

      const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
      assert.equal(JSON.stringify(persisted).includes('sk-test'), false)
      assert.deepEqual(persisted.at(-2)?.payload, {
        turnId: 'turn_2',
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      })
    } finally {
      server.close()
      await once(server, 'close')
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testMockSessionTurnApprovalInterruptStopAndPersistence(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      let id = 0
      let now = 100
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        now: () => ++now,
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const events: string[] = []
      runtime.onEvent((event) => events.push(event.type))

      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace/one',
        agentId: 'agent-one',
        providerId: 'mock-provider',
        modelId: 'mock-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      assert.equal(started.session.status, 'ready')

      const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
      assert.equal(sent.ok, true)
      if (!sent.ok) return
      assert.equal(sent.session.status, 'awaiting_approval')

      const requestEvent = await readLastEvent(workspaceRoot, 'workspace/one', 'agent-one')
      assert.equal(requestEvent.type, 'approval_requested')
      assert.equal(JSON.stringify(requestEvent).includes('secret'), false)

      const resolved = await runtime.respondToRequest({
        sessionId: started.session.sessionId,
        requestId: requestEvent.payload?.requestId as string,
        approved: true,
      })
      assert.equal(resolved.ok, true)
      if (!resolved.ok) return
      assert.equal(resolved.session.status, 'ready')

      await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'interrupt me' })
      const interrupted = await runtime.interrupt({ sessionId: started.session.sessionId })
      assert.equal(interrupted.ok, true)
      if (!interrupted.ok) return
      assert.equal(interrupted.session.status, 'ready')

      const stopped = await runtime.stopSession({ sessionId: started.session.sessionId })
      assert.equal(stopped.ok, true)
      assert.deepEqual(runtime.listSessions({ workspaceId: 'workspace/one' }).ok, true)
      assert.deepEqual(events, [
        'session_started',
        'session_ready',
        'user_message',
        'turn_started',
        'content_delta',
        'approval_requested',
        'approval_resolved',
        'usage_updated',
        'turn_completed',
        'user_message',
        'turn_started',
        'content_delta',
        'approval_requested',
        'turn_failed',
        'session_closed',
      ])
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testStartFailuresAreExplicit(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const runtime = new TrackedConversationRuntime({
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })

      assert.deepEqual(
        await runtime.startSession({
          workspaceRoot: join(workspaceRoot, 'missing'),
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'mock-provider',
          modelId: 'mock-model',
        }),
        { ok: false, message: 'Workspace path is unavailable.' },
      )
      assert.deepEqual(
        await runtime.startSession({
          workspaceRoot,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'missing-provider',
          modelId: 'mock-model',
        }),
        { ok: false, message: 'Conversation provider is not installed.' },
      )
      assert.deepEqual(
        await runtime.startSession({
          workspaceRoot,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'mock-provider',
          modelId: 'bad-model',
        }),
        { ok: false, message: 'Conversation model is invalid.' },
      )
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testProviderWithAuthRequiresConfiguredSecret(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const runtime = new TrackedConversationRuntime({
        adapters: [],
        getProviderById: () => ({
          manifest: {
            kind: 'provider',
            id: 'openai-compatible',
            displayName: 'OpenAI Compatible',
            version: 1,
            providerType: 'model-provider',
            models: [{ id: 'gpt-5' }],
            auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
          },
          source: 'bundled',
          manifestPath: '/fixtures/openai-compatible/plugin.json',
          pluginRoot: '/fixtures/openai-compatible',
          adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
        }),
        secretStore: {
          getStatus: async () => ({
            ok: true,
            status: {
              providerId: 'openai-compatible',
              configured: false,
              source: 'none',
              persistence: 'encrypted',
              encryptionAvailable: true,
              label: 'API key',
            },
          }),
        },
      })

      assert.deepEqual(
        await runtime.startSession({
          workspaceRoot,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'openai-compatible',
          modelId: 'gpt-5',
        }),
        { ok: false, message: 'Conversation provider secret is not configured.' },
      )
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testBlockedExecutableProviderTrustErrorSurfaces(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-runtime-'))
    try {
      const runtime = new TrackedConversationRuntime({
        adapters: [],
        getProviderById: () => ({
          manifest: {
            kind: 'provider',
            id: 'unsigned-adapter',
            displayName: 'Unsigned Adapter',
            version: 1,
            providerType: 'model-provider',
            models: [{ id: 'demo' }],
            adapter: {
              kind: 'trusted-executable',
              entry: 'dist/provider.js',
              sha256: '0'.repeat(64),
            },
          },
          source: 'user',
          manifestPath: '/fixtures/unsigned-adapter/plugin.json',
          pluginRoot: '/fixtures/unsigned-adapter',
          adapter: {
            kind: 'trusted-executable',
            execution: 'blocked',
            trust: 'unsigned',
            entry: 'dist/provider.js',
            trustError: 'Unsigned executable provider adapters cannot run in production mode.',
          },
        }),
        secretStore: unusedSecretStore(),
      })

      assert.deepEqual(
        await runtime.startSession({
          workspaceRoot,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: 'unsigned-adapter',
          modelId: 'demo',
        }),
        { ok: false, message: 'Unsigned executable provider adapters cannot run in production mode.' },
      )
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  function unusedSecretStore(): Pick<ProviderSecretStore, 'getStatus'> &
    Partial<Pick<ProviderSecretStore, 'resolveSecret'>> {
    return {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    }
  }

  async function testMultiTurnHistoryAccumulates(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-history-'))
    const captured: ConversationMessage[][] = []
    try {
      let id = 0
      let now = 1000
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        now: () => ++now,
        adapters: [createCapturingProvider(captured)],
        getProviderById: () => undefined,
        secretStore: {
          getStatus: async () => ({
            ok: true,
            status: {
              providerId: 'capture-provider',
              configured: true,
              source: 'environment',
              persistence: 'environment',
              encryptionAvailable: false,
              label: 'API key',
            },
          }),
          resolveSecret: async () => ({ ok: true, providerId: 'capture-provider', value: 'x', source: 'environment' }),
        },
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'w',
        agentId: 'a',
        providerId: 'capture-provider',
        modelId: 'capture-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return

      await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
      await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'and again' })

      assert.deepEqual(captured[0], [{ role: 'user', content: 'hello' }], 'the first turn sends just the user message')
      assert.deepEqual(
        captured[1],
        [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'reply to hello' },
          { role: 'user', content: 'and again' },
        ],
        'the second turn carries the prior completed turn as context',
      )
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Attachments ride the turn call to the adapter, but their bytes never enter
  // replayed history or the persisted JSONL transcript — the transcript keeps
  // attachment-store references at most (conversation-attachment-store.test.ts).
  async function testImageAttachmentsReachTheAdapterButNotHistoryOrTranscript(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-attachments-'))
    const captured: ConversationMessage[][] = []
    const turns: MockAdapterTurnInput[] = []
    try {
      let id = 0
      let now = 1000
      const capturing = createCapturingProvider(captured)
      const runtime = new TrackedConversationRuntime({
        randomId: () => `${++id}`,
        now: () => ++now,
        adapters: [
          {
            ...capturing,
            sendTurn(input: MockAdapterTurnInput) {
              turns.push(input)
              return capturing.sendTurn(input)
            },
          },
        ],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'w',
        agentId: 'a',
        providerId: 'capture-provider',
        modelId: 'capture-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId
      const attachment = { id: 'img-1', mediaType: 'image/png', dataBase64: 'Zm9v', byteLength: 3 }

      const withText = await runtime.sendTurn({ sessionId, message: 'describe', attachments: [attachment] })
      assert.equal(withText.ok, true)
      assert.deepEqual(turns[0]?.attachments, [attachment], 'attachments reach the adapter turn call')

      // A turn carrying only images (no text) is a valid send.
      const imageOnly = await runtime.sendTurn({ sessionId, message: '   ', attachments: [attachment] })
      assert.equal(imageOnly.ok, true, 'an attachments-only turn is accepted')

      // ...but a turn with neither text nor attachments is still rejected.
      assert.deepEqual(await runtime.sendTurn({ sessionId, message: '  ' }), {
        ok: false,
        message: 'Conversation turn message is required.',
      })

      // History replayed to the provider stays text-only.
      for (const messages of captured) {
        for (const message of messages) {
          assert.equal('attachments' in message, false, 'history carries no attachments')
        }
      }

      // The persisted transcript must not contain the base64 payload.
      const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId: 'w', agentId: 'a' })
      assert.equal(transcript.ok, true)
      if (!transcript.ok) return
      assert.equal(
        JSON.stringify(transcript.events).includes(attachment.dataBase64),
        false,
        'image data is never persisted to the JSONL transcript',
      )
      const userMessages = transcript.events.filter((event) => event.type === 'user_message')
      assert.equal(userMessages.length, 2)
      assert.equal(userMessages[0]?.payload?.text, 'describe')
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // The summary's first message is what a chat is titled and listed by. An
  // image-only opener has no words to offer, so it must not claim the slot:
  // the first turn that does say something takes it, restart included.
  async function testImageOnlyFirstTurnLeavesTheFirstMessageToTheNextWords(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-image-first-'))
    try {
      let id = 0
      let now = 1000
      const options = {
        randomId: () => `${++id}`,
        now: () => ++now,
        adapters: [createCapturingProvider([])],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      }
      const key = { workspaceRoot, workspaceId: 'w', agentId: 'a' }
      const runtime = new TrackedConversationRuntime(options)
      const started = await runtime.startSession({ ...key, providerId: 'capture-provider', modelId: 'capture-model' })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId
      const attachment = { id: 'img-1', mediaType: 'image/png', dataBase64: 'Zm9v', byteLength: 3 }

      assert.equal((await runtime.sendTurn({ sessionId, message: '', attachments: [attachment] })).ok, true)
      const afterImage = runtime.listSessions({ workspaceId: 'w' })
      assert.equal(afterImage.ok && afterImage.sessions[0]?.firstUserText, undefined)

      assert.equal((await runtime.sendTurn({ sessionId, message: 'Fix the upload retry' })).ok, true)
      assert.equal((await runtime.sendTurn({ sessionId, message: 'And add a test' })).ok, true)
      const afterWords = runtime.listSessions({ workspaceId: 'w' })
      assert.equal(afterWords.ok && afterWords.sessions[0]?.firstUserText, 'Fix the upload retry')
      assert.equal(afterWords.ok && afterWords.sessions[0]?.lastUserText, 'And add a test')

      await runtime.shutdown()
      const resumed = await new TrackedConversationRuntime(options).startSession({
        ...key,
        providerId: 'capture-provider',
        modelId: 'capture-model',
      })
      assert.equal(resumed.ok && resumed.session.firstUserText, 'Fix the upload retry')
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A model switch goes through the adapter, gated on its declared
  // `liveModelSwitch`; once accepted the session is on the new model and the
  // transcript records it, so the thread index, a resume and a remote list read
  // the model the conversation is now on.
  async function testSetModelSwitchesALiveSessionOrRefuses(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-model-'))
    const switched: string[] = []
    try {
      const captured: ConversationMessage[][] = []
      const capturing = createCapturingProvider(captured)
      const runtime = new TrackedConversationRuntime({
        adapters: [
          {
            ...capturing,
            sessions: 'stateful',
            capabilities: { ...capturing.capabilities!, liveModelSwitch: true },
            async setModel(input) {
              switched.push(input.nextModelId)
              return { ok: true, notice: 'From the next turn.' }
            },
          },
          { ...capturing, id: 'fixed-provider', listModels: () => ['capture-model'] },
        ],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'w',
        agentId: 'a',
        providerId: 'capture-provider',
        modelId: 'capture-model',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const result = await runtime.setModel({ sessionId: started.session.sessionId, modelId: 'other-model' })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(switched, ['other-model'])
      assert.equal(result.session.modelId, 'other-model')
      assert.equal(result.notice, 'From the next turn.')
      const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId: 'w', agentId: 'a' })
      assert.ok(transcript.ok)
      const recorded = transcript.ok ? transcript.events.at(-1) : undefined
      assert.equal(recorded?.type, 'session_updated')
      assert.equal(recorded?.modelId, 'other-model', 'the transcript names the model the chat is now on')

      const fixed = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'w',
        agentId: 'b',
        providerId: 'fixed-provider',
        modelId: 'capture-model',
      })
      assert.equal(fixed.ok, true)
      if (!fixed.ok) return
      assert.deepEqual(await runtime.setModel({ sessionId: fixed.session.sessionId, modelId: 'other-model' }), {
        ok: false,
        message: 'This conversation provider cannot change models mid-conversation.',
      })
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // 1771: the preset is switchable mid-conversation. The runtime hands the change
  // to the adapter and only records it once the adapter confirms, so a refusal
  // leaves the session reporting the preset the provider is actually honoring.
  async function testSetPermissionAppliesThroughTheAdapterOrRefuses(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-permission-'))
    const applied: ConversationPermissionPreset[] = []
    let refusal: string | null = null
    try {
      const captured: ConversationMessage[][] = []
      const capturing = createCapturingProvider(captured)
      const runtime = new TrackedConversationRuntime({
        adapters: [
          {
            ...capturing,
            sessions: 'stateful',
            async setPermissionPreset(input) {
              if (refusal) return { ok: false, message: refusal }
              applied.push(input.permissionPreset)
              return { ok: true }
            },
          },
          // Second provider with no live permission surface at all.
          { ...capturing, id: 'static-provider', listModels: () => ['capture-model'] },
        ],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'w',
        agentId: 'a',
        providerId: 'capture-provider',
        modelId: 'capture-model',
        permissionPreset: 'none',
      })
      assert.equal(started.ok, true)
      if (!started.ok) return
      const sessionId = started.session.sessionId
      assert.equal(started.session.permissionPreset, 'none', 'the summary reports the preset in force')

      const switched = await runtime.setPermission({ sessionId, permissionPreset: 'bypass' })
      assert.equal(switched.ok, true)
      if (!switched.ok) return
      assert.deepEqual(applied, ['bypass'], 'the adapter applied the preset to its live session')
      assert.equal(switched.session.permissionPreset, 'bypass')
      assert.equal(runtime.listSessions({ workspaceId: 'w' }).ok, true)

      // A provider refusal is surfaced verbatim and does not move the session.
      refusal = 'Claude Code refused the permission change.'
      assert.deepEqual(await runtime.setPermission({ sessionId, permissionPreset: 'none' }), {
        ok: false,
        message: refusal,
      })
      const listed = runtime.listSessions({ workspaceId: 'w' })
      assert.equal(listed.ok && listed.sessions[0]?.permissionPreset, 'bypass')
      refusal = null

      // A session it does not hold is named as such, so its caller starts the chat's session again.
      assert.deepEqual(await runtime.setPermission({ sessionId: 'conv_missing', permissionPreset: 'none' }), {
        ok: false,
        code: 'session_not_found',
        message: 'Conversation session is invalid.',
      })
      for (const commandId of [undefined, 'cmd-1']) {
        const sent = await runtime.sendTurn({
          sessionId: 'conv_missing',
          message: 'hi',
          ...(commandId ? { commandId } : {}),
        })
        assert.equal(sent.ok ? null : sent.code, 'session_not_found', 'a send, with or without a command id')
      }

      // A provider with no live permission surface refuses rather than recording a
      // preset it would never honor.
      const staticSession = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'w',
        agentId: 'b',
        providerId: 'static-provider',
        modelId: 'capture-model',
      })
      assert.equal(staticSession.ok, true)
      if (!staticSession.ok) return
      assert.equal(staticSession.session.permissionPreset, undefined, 'no preset chosen means none reported')
      assert.deepEqual(
        await runtime.setPermission({ sessionId: staticSession.session.sessionId, permissionPreset: 'bypass' }),
        { ok: false, message: 'This conversation provider cannot change tool permissions mid-conversation.' },
      )

      const stopped = await runtime.stopSession({ sessionId })
      assert.equal(stopped.ok, true)
      assert.deepEqual(await runtime.setPermission({ sessionId, permissionPreset: 'none' }), {
        ok: false,
        message: 'Conversation session is stopped.',
      })
    } finally {
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Preset changes reach the provider one at a time, in the order they were
  // made, and nothing about the preset gates a send: a chat in Bypass takes a
  // turn like any other.
  async function testPermissionTransitionsAreSerialized(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-permission-order-'))
    const turnGate = createDeferred<void>()
    const permissionGate = createDeferred<void>()
    const permissionEntered = createDeferred<void>()
    let pausePermissions = true
    const applied: ConversationPermissionPreset[] = []
    const events: string[] = []
    const runtime = new TrackedConversationRuntime({
      adapters: [
        {
          ...createSlowProvider(turnGate),
          async setPermissionPreset(input) {
            applied.push(input.permissionPreset)
            if (pausePermissions) {
              permissionEntered.resolve()
              await permissionGate.promise
            }
            return { ok: true }
          },
        },
      ],
      getProviderById: () => undefined,
    })
    runtime.onEvent((event) => events.push(event.type))
    try {
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'slow-provider',
        modelId: 'slow-model',
        permissionPreset: 'none',
      })
      assert.ok(started.ok)
      const sessionId = started.session.sessionId
      const bypass = runtime.setPermission({ sessionId, permissionPreset: 'bypass' })
      await permissionEntered.promise
      const none = runtime.setPermission({ sessionId, permissionPreset: 'none' })
      assert.deepEqual(applied, ['bypass'], 'the second change waits for the first')
      pausePermissions = false
      permissionGate.resolve()
      assert.ok((await bypass).ok)
      assert.ok((await none).ok)
      assert.deepEqual(applied, ['bypass', 'none'])

      assert.ok((await runtime.setPermission({ sessionId, permissionPreset: 'bypass' })).ok)
      const sending = runtime.sendTurn({ sessionId, message: 'go' })
      await waitForEvent(events, 'turn_started')
      turnGate.resolve()
      const sent = await sending
      assert.ok(sent.ok, 'a send to a chat in Bypass is accepted')
      assert.equal(sent.session.permissionPreset, 'bypass')
    } finally {
      permissionGate.resolve()
      turnGate.resolve()
      await runtime.shutdown()
      await shutdownRuntimes()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  function createCapturingProvider(captured: ConversationMessage[][]): ConversationProviderAdapter {
    return {
      id: 'capture-provider',
      listModels: () => ['capture-model'],
      startSession(input) {
        return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
      },
      sendTurn(input: MockAdapterTurnInput) {
        captured.push(input.messages ?? [])
        return [
          runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
          runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: `reply to ${input.message}` }),
          runtimeEvent(input, 'turn_completed', { turnId: input.turnId }),
        ]
      },
      resolveApproval() {
        return []
      },
      interrupt(input) {
        return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
      },
      stopSession(input) {
        return [runtimeEvent(input, 'session_closed')]
      },
    }
  }

  function createSlowProvider(gate: { promise: Promise<void> }): ConversationProviderAdapter {
    return {
      id: 'slow-provider',
      listModels: () => ['slow-model'],
      startSession(input) {
        return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
      },
      async *sendTurn(input: MockAdapterTurnInput) {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        await gate.promise
        yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'late output' })
        yield runtimeEvent(input, 'usage_updated', { turnId: input.turnId, inputTokens: 1, outputTokens: 2 })
        yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
      },
      resolveApproval() {
        return []
      },
      interrupt(input) {
        return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
      },
      stopSession(input) {
        return [runtimeEvent(input, 'session_closed')]
      },
    }
  }

  function runtimeEvent(
    input: MockAdapterSessionInput,
    type: ConversationEventType,
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

  function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  async function waitForEvent(events: string[], type: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (events.includes(type)) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error(`Timed out waiting for ${type}`)
  }

  async function waitForEventType(events: ConversationEvent[], type: ConversationEventType): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (events.some((event) => event.type === type)) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error(`Timed out waiting for ${type}`)
  }

  async function waitForStatus(runtime: ConversationRuntime, workspaceId: string, status: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const listed = runtime.listSessions({ workspaceId })
      if (listed.ok && listed.sessions[0]?.status === status) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error(`Timed out waiting for session status ${status}`)
  }

  async function readLastEvent(
    workspaceRoot: string,
    workspaceId: string,
    agentId: string,
  ): Promise<Record<string, any>> {
    const events = await readConversationEvents(workspaceRoot, workspaceId, agentId)
    return events[events.length - 1] ?? {}
  }

  async function readConversationEvents(
    workspaceRoot: string,
    workspaceId: string,
    agentId: string,
  ): Promise<Record<string, any>[]> {
    const content = await readFile(
      workspaceStorePath(
        workspaceRoot,
        'conversations',
        encodeURIComponent(workspaceId.replace(/[\\/]/g, '-')),
        `${agentId}.jsonl`,
      ),
      'utf-8',
    )
    return content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
  }

  function openAiProvider(baseUrl: string): LoadedConversationProvider {
    return {
      manifest: {
        kind: 'provider',
        id: 'openai-compatible-api',
        displayName: 'OpenAI Compatible API',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'test-model' }],
        auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
        adapter: { kind: 'declarative' },
        openaiCompatible: { baseUrl, chatCompletionsPath: '/v1/chat/completions' },
      },
      source: 'bundled',
      manifestPath: '/fixtures/openai-compatible-api/plugin.json',
      pluginRoot: '/fixtures/openai-compatible-api',
      adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
    }
  }

  function handleOpenAiCompatibleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer sk-test') {
      res.writeHead(req.headers.authorization === 'Bearer sk-test' ? 404 : 401)
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
      assert.equal(body.stream, true)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n')
      res.write(
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      )
      res.end('data: [DONE]\n\n')
    })
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
