import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { conversationSummaryPhase } from '../shared/conversation/phase'
import { createConversationPeekService } from './conversation-peek/service'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/mock-conversation-provider'

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

/** A provider that answers each message at once, echoing it with `padding` after. */
function echoProvider(options: { padding?: string } = {}): ConversationProviderAdapter {
  return {
    id: 'echo-provider',
    listModels: () => ['model'],
    startSession: (input) => [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')],
    sendTurn: (input) => [
      runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
      runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: `Echo: ${input.message}` }),
      runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: options.padding ?? '' }),
      runtimeEvent(input, 'turn_completed', { turnId: input.turnId }),
    ],
    resolveApproval: () => [],
    interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [runtimeEvent(input, 'session_closed')],
  }
}

async function withRuntime(
  adapters: ConversationProviderAdapter[],
  body: (context: { runtime: ConversationRuntime; workspaceRoot: string }) => Promise<void>,
  options: { now?: () => number } = {},
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-lifecycle-'))
  const runtime = new ConversationRuntime({
    adapters,
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    ...(options.now ? { now: options.now } : {}),
  })
  try {
    await body({ runtime, workspaceRoot })
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

test('the hover card reads the first message and the newest turn, never the chat between', async () =>
  withRuntime([echoProvider({ padding: 'x'.repeat(16 * 1024) })], async ({ runtime, workspaceRoot }) => {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'echo-provider', modelId: 'model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const messages = ['First question', ...Array.from({ length: 40 }, (_, index) => `Middle ${index}`), 'Last one']
    for (const message of messages) assert.ok((await runtime.sendTurn({ sessionId, message })).ok)

    const events = await runtime.readPeekTranscript(key)
    const said = events.filter((event) => event.type === 'user_message').map((event) => event.payload?.text)
    assert.deepEqual(said, ['First question', 'Last one'])
    assert.ok(!events.some((event) => String(event.payload?.text ?? '').includes('Middle')))

    const peek = await createConversationPeekService({
      readSessionState: async () => null,
      readConversationEvents: async () => events,
    }).readConversationPeek(sessionId)
    assert.equal(peek.first?.text, 'First question')
    assert.deepEqual(
      peek.since.map((message) => message.text.slice(0, 14)),
      ['Last one', 'Echo: Last one'],
    )
  }))

test('a chat child in the process tree is labelled with the CLI it runs', async () => {
  const runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    adapters: [
      {
        ...echoProvider(),
        id: 'codex-agent',
        listLiveSessions: () => [
          {
            sessionId: 'conv_codex',
            workspaceId: 'workspace',
            agentId: 'agent',
            workspaceRoot: '/Users/dev/project',
            providerSessionId: 'thread',
            hasChildProcess: true,
            childPid: 4242,
            turnActive: false,
            pendingApproval: false,
            lastActivityAt: 5,
            spawnedAt: 3,
          },
        ],
      },
    ],
  })
  assert.deepEqual(
    runtime.listLiveConversationRoots().map((root) => [root.sessionId, root.cli, root.activityKind]),
    [['conv_codex', 'codex', 'idle']],
  )
})

test("a chat's folder is in use while its provider child lives or a turn runs, and not while it rests", async () => {
  const live = (sessionId: string, workspaceRoot: string, hasChildProcess: boolean, turnActive: boolean) => ({
    sessionId,
    workspaceId: 'workspace',
    agentId: sessionId,
    workspaceRoot,
    providerSessionId: null,
    hasChildProcess,
    childPid: hasChildProcess ? 4242 : null,
    turnActive,
    pendingApproval: false,
    lastActivityAt: 5,
    spawnedAt: 3,
  })
  const runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    adapters: [
      {
        ...echoProvider(),
        id: 'claude-agent',
        listLiveSessions: () => [
          live('child', '/Users/dev/.sprintengine-worktrees/app/child', true, false),
          live('turn', '/Users/dev/.sprintengine-worktrees/app/turn', false, true),
          live('resting', '/Users/dev/.sprintengine-worktrees/app/resting', false, false),
        ],
      },
    ],
  })
  assert.deepEqual((await runtime.liveConversationWorkspaceRoots()).sort(), [
    '/Users/dev/.sprintengine-worktrees/app/child',
    '/Users/dev/.sprintengine-worktrees/app/turn',
  ])
})

/**
 * A stateful provider whose child can be disposed, and which reports an agent
 * it spawned in the background through the session's continuation channel.
 */
function backgroundAgentProvider() {
  const disposed: string[] = []
  const stopped: string[] = []
  let sink: ((event: ConversationEvent) => void) | undefined
  let session: MockAdapterSessionInput | undefined
  const adapter: ConversationProviderAdapter = {
    ...echoProvider(),
    id: 'agent-provider',
    sessions: 'stateful',
    startSession: (input) => {
      sink = input.onSessionEvent
      session = input
      return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
    },
    disposeChildProcess: (sessionId) => {
      disposed.push(sessionId)
      return true
    },
    stopBackgroundTasks: async (sessionId) => {
      stopped.push(sessionId)
      return true
    },
  }
  const agent = (status: 'running' | 'completed') =>
    sink!(
      runtimeEvent(session!, 'subagent_status', {
        toolUseId: 'task_1',
        status,
        background: true,
        description: 'Run the long suite',
      }),
    )
  // The shells and monitors the child runs, as the provider reports them: the
  // whole list each time it changes.
  const tasks = (backgroundTasks: unknown[]) => sink!(runtimeEvent(session!, 'session_updated', { backgroundTasks }))
  return { adapter, disposed, stopped, agent, tasks }
}

function backgroundAgents(runtime: ConversationRuntime): number | undefined {
  const listed = runtime.listSessions()
  return listed.ok ? listed.sessions[0]?.backgroundAgents : undefined
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate())
}

test('the idle sweep leaves a chat whose background agent is still running', async () => {
  let clock = 1_000_000
  const provider = backgroundAgentProvider()
  await withRuntime(
    [provider.adapter],
    async ({ runtime, workspaceRoot }) => {
      runtime.setIdleThresholdMs(60_000)
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'agent-provider',
        modelId: 'model',
      })
      assert.ok(started.ok)
      const sessionId = started.session.sessionId
      assert.ok((await runtime.sendTurn({ sessionId, message: 'start the suite in the background' })).ok)
      provider.agent('running')
      await until(() => backgroundAgents(runtime) === 1)

      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [])
      assert.deepEqual(provider.disposed, [])

      provider.agent('completed')
      await until(() => !backgroundAgents(runtime))
      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [sessionId])
      assert.deepEqual(provider.disposed, [sessionId])
    },
    { now: () => clock },
  )
})

// A monitor wakes the agent when it reports, and a dev server is still being
// served: ending the child ends both, and the monitor never reports at all.
test('the idle sweep leaves a chat whose shell or monitor is still running, and only a monitor keeps it working', async () => {
  const clock = 1_000_000
  const provider = backgroundAgentProvider()
  await withRuntime(
    [provider.adapter],
    async ({ runtime, workspaceRoot }) => {
      runtime.setIdleThresholdMs(60_000)
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'agent-provider',
        modelId: 'model',
      })
      assert.ok(started.ok)
      const sessionId = started.session.sessionId
      const summary = () => {
        const listed = runtime.listSessions()
        return listed.ok ? listed.sessions[0] : undefined
      }
      assert.ok((await runtime.sendTurn({ sessionId, message: 'watch CI and start the dev server' })).ok)
      const monitor = { taskId: 'task_mon', kind: 'monitor', description: 'CI checks' }
      const server = { taskId: 'task_dev', kind: 'command', description: 'npm run dev' }

      provider.tasks([monitor, server])
      await until(() => summary()?.backgroundTasks?.length === 2)
      assert.equal(conversationSummaryPhase(summary()!), 'running')
      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [])

      provider.tasks([server])
      await until(() => summary()?.backgroundTasks?.length === 1)
      assert.equal(conversationSummaryPhase(summary()!), 'completed', 'a dev server left running is not work')
      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [], 'but it is still being served')

      provider.tasks([])
      await until(() => summary()?.backgroundTasks === undefined)
      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [sessionId])
      assert.deepEqual(provider.disposed, [sessionId])
    },
    { now: () => clock },
  )
})

// Stop between turns has no turn to end: what it ends is what the last turn
// left running. With nothing running it refuses, as it always did.
test('Stop between turns stops the background work the chat lists, and refuses when there is none', async () => {
  const provider = backgroundAgentProvider()
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'agent-provider',
      modelId: 'model',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    assert.ok((await runtime.sendTurn({ sessionId, message: 'watch CI' })).ok)

    assert.deepEqual(await runtime.interrupt({ sessionId }), {
      ok: false,
      message: 'Conversation session has no active turn.',
    })
    assert.deepEqual(provider.stopped, [])

    provider.tasks([{ taskId: 'task_mon', kind: 'monitor', description: 'CI checks' }])
    await until(() => {
      const listed = runtime.listSessions()
      return listed.ok && listed.sessions[0]?.backgroundTasks?.length === 1
    })
    assert.equal((await runtime.interrupt({ sessionId })).ok, true)
    assert.deepEqual(provider.stopped, [sessionId])
  })
})

test('the idle sweep rests while the machine sleeps', async () => {
  const listeners = { suspend: new Set<() => void>(), resume: new Set<() => void>() }
  let suspended = false
  const activity = {
    isSuspended: () => suspended,
    onSuspend: (listener: () => void) => {
      listeners.suspend.add(listener)
      return () => listeners.suspend.delete(listener)
    },
    onResume: (listener: () => void) => {
      listeners.resume.add(listener)
      return () => listeners.resume.delete(listener)
    },
  }
  const timers = new Set<unknown>()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((handler: () => void, ms: number) => {
    const timer = realSetInterval(handler, ms)
    timers.add(timer)
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    timers.delete(timer)
    realClearInterval(timer)
  }) as typeof clearInterval
  try {
    const runtime = new ConversationRuntime({ getProviderById: () => undefined, adapters: [echoProvider()] })
    runtime.startIdleSweep(activity)
    assert.equal(timers.size, 1)
    suspended = true
    for (const listener of listeners.suspend) listener()
    assert.equal(timers.size, 0)
    suspended = false
    for (const listener of listeners.resume) listener()
    assert.equal(timers.size, 1)
    runtime.stopIdleSweep()
    assert.equal(timers.size, 0)
    assert.equal(listeners.suspend.size + listeners.resume.size, 0)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

/** Records what the runtime hands the provider, around the echo provider. */
function recordingProvider(overrides: Partial<ConversationProviderAdapter> = {}) {
  const starts: MockAdapterSessionInput[] = []
  const stops: string[] = []
  const turns: Array<{ message: string; messages?: Array<{ role: string; content: string }> }> = []
  const base = echoProvider()
  const adapter: ConversationProviderAdapter = {
    ...base,
    startSession: (input) => {
      starts.push(input)
      return base.startSession(input)
    },
    sendTurn: (input) => {
      turns.push({ message: input.message, messages: input.messages })
      return base.sendTurn(input)
    },
    stopSession: (input) => {
      stops.push(input.sessionId)
      return base.stopSession(input)
    },
    ...overrides,
  }
  return { adapter, starts, stops, turns }
}

test('starting a chat that already has a live session adopts it instead of starting a second', async () => {
  const provider = recordingProvider()
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const input = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent', providerId: 'echo-provider' }
    const first = await runtime.startSession({ ...input, modelId: 'model' })
    assert.ok(first.ok)
    // A remounted pane, or a paired device, asks again.
    const again = await runtime.startSession({ ...input, modelId: 'model' })
    assert.ok(again.ok)
    assert.equal(again.session.sessionId, first.session.sessionId)
    assert.equal(provider.starts.length, 1)
    const listed = runtime.listSessions()
    assert.deepEqual(listed.ok && listed.sessions.map((session) => session.sessionId), [first.session.sessionId])

    // Another chat is its own session.
    const other = await runtime.startSession({ ...input, agentId: 'other', modelId: 'model' })
    assert.ok(other.ok && other.session.sessionId !== first.session.sessionId)
  })
})

test('a live session its provider cannot move to the model asked for is replaced, not doubled', async () => {
  const provider = recordingProvider({ listModels: () => ['model', 'bigger-model'] })
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const input = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent', providerId: 'echo-provider' }
    const first = await runtime.startSession({ ...input, modelId: 'model' })
    assert.ok(first.ok)
    assert.ok((await runtime.sendTurn({ sessionId: first.session.sessionId, message: 'Remember me' })).ok)

    const moved = await runtime.startSession({ ...input, modelId: 'bigger-model' })
    assert.ok(moved.ok)
    assert.notEqual(moved.session.sessionId, first.session.sessionId)
    assert.equal(moved.session.modelId, 'bigger-model')
    assert.deepEqual(provider.stops, [first.session.sessionId])
    const listed = runtime.listSessions()
    assert.deepEqual(listed.ok && listed.sessions.map((session) => session.sessionId), [moved.session.sessionId])

    // The replacement carries the conversation on.
    assert.ok((await runtime.sendTurn({ sessionId: moved.session.sessionId, message: 'Next' })).ok)
    assert.deepEqual(
      provider.turns.at(-1)?.messages?.map((message) => message.content),
      ['Remember me', `Echo: Remember me`, 'Next'],
    )
  })
})

test('a stopped session is listed only until the chat starts again', async () => {
  const provider = recordingProvider()
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const input = {
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'echo-provider',
      modelId: 'model',
    }
    const first = await runtime.startSession(input)
    assert.ok(first.ok)
    await runtime.stopSession({ sessionId: first.session.sessionId })
    let listed = runtime.listSessions()
    assert.deepEqual(listed.ok && listed.sessions.map((session) => session.status), ['stopped'])

    const next = await runtime.startSession(input)
    assert.ok(next.ok && next.session.sessionId !== first.session.sessionId)
    listed = runtime.listSessions()
    assert.deepEqual(listed.ok && listed.sessions.map((session) => session.sessionId), [next.session.sessionId])
  })
})

test('a busy session is adopted as it is, never cut short', async () => {
  let release!: () => void
  const parked = new Promise<void>((resolve) => (release = resolve))
  const base = echoProvider()
  const provider = recordingProvider({
    listModels: () => ['model', 'bigger-model'],
    sendTurn: (input) =>
      (async function* () {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        await parked
        yield* base.sendTurn(input) as ConversationEvent[]
      })(),
  })
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const input = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent', providerId: 'echo-provider' }
    const first = await runtime.startSession({ ...input, modelId: 'model' })
    assert.ok(first.ok)
    const running = runtime.sendTurn({ sessionId: first.session.sessionId, message: 'Long job' })
    await until(() => {
      const listed = runtime.listSessions()
      return listed.ok && listed.sessions[0]?.status === 'active'
    })
    const again = await runtime.startSession({ ...input, modelId: 'bigger-model' })
    assert.ok(again.ok)
    assert.equal(again.session.sessionId, first.session.sessionId)
    assert.deepEqual(provider.stops, [])
    release()
    assert.ok((await running).ok)
  })
})

test('a settled stateless chat drops its history and reads it back for the next send', async () => {
  const provider = recordingProvider()
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'echo-provider',
      modelId: 'model',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    assert.ok((await runtime.sendTurn({ sessionId, message: 'One' })).ok)
    assert.ok((await runtime.suspendSession({ sessionId })).ok)
    assert.ok((await runtime.sendTurn({ sessionId, message: 'Two' })).ok)
    assert.deepEqual(
      provider.turns.at(-1)?.messages?.map((message) => message.content),
      ['One', 'Echo: One', 'Two'],
    )
  })
})

test('only a stateful provider that replays history is handed it at start', async () => {
  const replaying = recordingProvider({ id: 'codex-agent', sessions: 'stateful' })
  const resuming = recordingProvider({ id: 'claude-agent', sessions: 'stateful' })
  await withRuntime([replaying.adapter, resuming.adapter], async ({ runtime, workspaceRoot }) => {
    for (const provider of [replaying, resuming]) {
      const key = { workspaceRoot, workspaceId: 'workspace', agentId: provider.adapter.id, modelId: 'model' }
      const first = await runtime.startSession({ ...key, providerId: provider.adapter.id })
      assert.ok(first.ok)
      assert.ok((await runtime.sendTurn({ sessionId: first.session.sessionId, message: 'Hello' })).ok)
      await runtime.stopSession({ sessionId: first.session.sessionId })
      assert.ok((await runtime.startSession({ ...key, providerId: provider.adapter.id })).ok)
    }
    assert.deepEqual(
      replaying.starts.at(-1)?.fallbackHistory?.map((message) => message.content),
      ['Hello', 'Echo: Hello'],
    )
    assert.equal(resuming.starts.at(-1)?.fallbackHistory, undefined)
  })
})

test('settling a chat whose session is still starting cancels the child being spawned', async () => {
  let release!: () => void
  const spawning = new Promise<void>((resolve) => (release = resolve))
  const disposed: string[] = []
  const base = echoProvider()
  const adapter: ConversationProviderAdapter = {
    ...base,
    sessions: 'stateful',
    startSession: (input) =>
      (async function* () {
        await spawning
        yield* base.startSession(input) as ConversationEvent[]
      })(),
    disposeChildProcess: (sessionId) => {
      disposed.push(sessionId)
      release()
      return true
    },
  }
  await withRuntime([adapter], async ({ runtime, workspaceRoot }) => {
    const starting = runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'echo-provider',
      modelId: 'model',
    })
    let sessionId: string | undefined
    await until(() => {
      const listed = runtime.listSessions()
      sessionId = listed.ok ? listed.sessions[0]?.sessionId : undefined
      return sessionId !== undefined
    })
    assert.ok((await runtime.suspendSession({ sessionId: sessionId! })).ok)
    assert.deepEqual(disposed, [sessionId])
    await starting
  })
})

test('a session summary says when the running turn began, and only while it runs', async () => {
  let clock = 5_000
  let release!: () => void
  const parked = new Promise<void>((resolve) => (release = resolve))
  const base = echoProvider()
  const provider = recordingProvider({
    sendTurn: (input) =>
      (async function* () {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        await parked
        yield* base.sendTurn(input) as ConversationEvent[]
      })(),
  })
  await withRuntime(
    [provider.adapter],
    async ({ runtime, workspaceRoot }) => {
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'echo-provider',
        modelId: 'model',
      })
      assert.ok(started.ok)
      assert.equal(started.session.turnStartedAt, undefined)
      clock = 7_000
      const running = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'Work' })
      const summary = () => {
        const listed = runtime.listSessions()
        return listed.ok ? listed.sessions[0] : undefined
      }
      await until(() => summary()?.status === 'active')
      clock = 9_000
      assert.equal(summary()?.turnStartedAt, 7_000)
      release()
      const ended = await running
      assert.ok(ended.ok)
      assert.equal(ended.session.turnStartedAt, undefined)
      assert.equal(ended.session.lastTurnEndedAt, 9_000)
    },
    { now: () => clock },
  )
})

test('a delta that is only its text is written as it is, and one carrying more is still redacted', async () => {
  const base = echoProvider()
  const provider = recordingProvider({
    sendTurn: (input) => [
      runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
      runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'Use the token from the vault.' }),
      runtimeEvent(input, 'reasoning_delta', { turnId: input.turnId, text: 'Thinking', apiKey: 'sk-live' }),
      ...(base.sendTurn(input) as ConversationEvent[]).slice(-1),
    ],
  })
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'echo-provider', modelId: 'model' })
    assert.ok(started.ok)
    assert.ok((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'Go' })).ok)
    const replayed = await runtime.readTranscript(key)
    assert.ok(replayed.ok)
    const content = replayed.events.find((event) => event.type === 'content_delta')
    const reasoning = replayed.events.find((event) => event.type === 'reasoning_delta')
    assert.equal(content?.payload?.text, 'Use the token from the vault.')
    assert.equal(reasoning?.payload?.apiKey, '[redacted]')
  })
})

test('settling forces the child to end while its background agent works, and the idle sweep never does', async () => {
  const provider = backgroundAgentProvider()
  const forced: unknown[] = []
  const dispose = provider.adapter.disposeChildProcess!
  provider.adapter.disposeChildProcess = ((sessionId: string, options?: { force?: boolean }) => {
    forced.push(options?.force === true)
    return dispose(sessionId)
  }) as typeof dispose
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    runtime.setIdleThresholdMs(60_000)
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'agent-provider',
      modelId: 'model',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    assert.ok((await runtime.sendTurn({ sessionId, message: 'go' })).ok)
    assert.deepEqual(runtime.sweepIdleSessions(Date.now() + 10 * 60_000), [sessionId])
    assert.ok((await runtime.suspendSession({ sessionId })).ok)
    assert.deepEqual(forced, [false, true])
  })
})

/** A stateful provider whose stream for the first message stops short of the turn's end. */
function streamEndsEarlyProvider() {
  let sends = 0
  const base = echoProvider()
  const provider = recordingProvider({
    sessions: 'stateful',
    sendTurn: (input) =>
      ++sends === 1
        ? [
            runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
            runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'Halfway' }),
          ]
        : base.sendTurn(input),
  })
  return { adapter: provider.adapter, sends: () => sends }
}

test('a stateful turn whose stream ends without finishing fails, and the chat takes the next message', async () => {
  const provider = streamEndsEarlyProvider()
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'echo-provider', modelId: 'model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const first = await runtime.sendTurn({ sessionId, message: 'Go' })
    assert.ok(first.ok)
    assert.equal(first.session.status, 'failed')
    const replayed = await runtime.readTranscript(key)
    assert.ok(replayed.ok)
    const failures = replayed.events.filter((event) => event.type === 'turn_failed')
    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.payload?.reason, 'provider')

    const next = await runtime.sendTurn({ sessionId, message: 'Again' })
    assert.ok(next.ok)
    assert.equal(next.session.status, 'ready')
    assert.equal(provider.sends(), 2)
  })
})

test('a stateful turn that finishes is not failed when its stream ends', async () => {
  const provider = recordingProvider({ sessions: 'stateful' })
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'echo-provider', modelId: 'model' })
    assert.ok(started.ok)
    const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'Go' })
    assert.ok(sent.ok)
    assert.equal(sent.session.status, 'ready')
    const replayed = await runtime.readTranscript(key)
    assert.ok(replayed.ok)
    assert.ok(!replayed.events.some((event) => event.type === 'turn_failed'))
    assert.equal(replayed.events.filter((event) => event.type === 'turn_completed').length, 1)
  })
})

test('a stateful turn the person stopped ends as stopped, not as a stream that ended early', async () => {
  const provider = recordingProvider({
    sessions: 'stateful',
    sendTurn: (input) =>
      (async function* () {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'Working' })
        // The provider answers Stop by ending its stream, with no end of its own.
        await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve()))
      })(),
    interrupt: () => [],
  })
  await withRuntime([provider.adapter], async ({ runtime, workspaceRoot }) => {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'echo-provider', modelId: 'model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const running = runtime.sendTurn({ sessionId, message: 'Go' })
    const summary = () => {
      const listed = runtime.listSessions()
      return listed.ok ? listed.sessions[0] : undefined
    }
    await until(() => summary()?.status === 'active')
    assert.ok((await runtime.interrupt({ sessionId })).ok)
    assert.ok((await running).ok)
    assert.equal(summary()?.status, 'ready')
    const replayed = await runtime.readTranscript(key)
    assert.ok(replayed.ok)
    const failures = replayed.events.filter((event) => event.type === 'turn_failed')
    assert.deepEqual(
      failures.map((event) => event.payload?.reason),
      ['interrupted'],
    )
  })
})
