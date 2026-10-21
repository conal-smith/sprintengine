import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { ConversationSessionApi } from './conversation-session-api'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/conversation-provider-adapter'
import type {
  ConversationEvent,
  ConversationSessionFrame,
  ConversationSessionSummary,
} from '../shared/conversation-runtime'
import { workspaceStorePath } from './workspace-store'
import { ConversationApprovalRuleStore } from './conversation-approval-rules'

function event(
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
    createdAt: 1,
    type,
    payload,
  }
}
async function fixture(adapter = createMockConversationProvider()) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-session-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const started = await runtime.startSession({ ...key, providerId: adapter.id, modelId: adapter.listModels()[0] })
  assert.equal(started.ok, true)
  return {
    runtime,
    key,
    sessionId: started.session.sessionId,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('interrupt persists one terminal event when a provider closes only its send stream', async () => {
  let entered!: () => void
  const streaming = new Promise<void>((resolve) => {
    entered = resolve
  })
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    async *sendTurn(input) {
      yield event(input, 'turn_started', { turnId: input.turnId })
      entered()
      await new Promise<void>((resolve) => input.signal!.addEventListener('abort', () => resolve(), { once: true }))
      yield event(input, 'turn_failed', { turnId: input.turnId, reason: 'interrupted' })
    },
    interrupt: () => [],
  }
  const f = await fixture(adapter)
  try {
    const observed: ConversationEvent[] = []
    f.runtime.onEvent((value) => observed.push(value))
    const sending = f.runtime.sendTurn({ sessionId: f.sessionId, message: 'wait' })
    await streaming
    assert.ok((await f.runtime.interrupt({ sessionId: f.sessionId })).ok)
    await sending
    const terminal = observed.filter((value) => value.type === 'turn_failed')
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0].payload?.reason, 'interrupted')
    const transcript = await f.runtime.readTranscript(f.key, { all: true, closeOpenTurns: false })
    assert.ok(transcript.ok)
    assert.equal(transcript.events.filter((value) => value.type === 'turn_failed').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('tool details preserve large outputs and edit inputs, redact secrets, and disappear with the transcript', async () => {
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn(input) {
      return [
        event(input, 'tool_started', {
          turnId: input.turnId,
          toolCallId: 'edit',
          tool: 'Edit',
          input: { path: 'example.txt', oldText: 'before', newText: 'after', apiKey: 'private-value' },
        }),
        event(input, 'tool_output', {
          turnId: input.turnId,
          toolCallId: 'edit',
          output: 'x'.repeat(50_000),
          isError: false,
        }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((e) => events.push(e))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'edit' })
    const output = events.find((e) => e.type === 'tool_output')!
    assert.equal(String(output.payload?.preview).length, 4000)
    assert.equal(output.payload?.totalBytes, 50_000)
    assert.equal(output.payload?.truncated, true)
    const result = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'edit' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(String(result.detail.output).length, 50_000)
      assert.deepEqual(result.detail.input, {
        path: 'example.txt',
        oldText: 'before',
        newText: 'after',
        apiKey: '[redacted]',
      })
    }
    const path = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.tools', 'edit.json')
    assert.equal((await readFile(path, 'utf8')).includes('private-value'), false)
    const missing = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'missing' })
    assert.deepEqual(missing.ok ? null : missing.code, 'not_found')
    await f.runtime.stopSession({ sessionId: f.sessionId })
    await f.runtime.deleteTranscript(f.key)
    assert.equal((await f.runtime.getToolDetail({ ...f.key, toolUseId: 'edit' })).ok, false)
  } finally {
    await f.cleanup()
  }
})

test('large inputs are kept out of events and binary tools carry only metadata', async () => {
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn(input) {
      return [
        event(input, 'tool_started', {
          turnId: input.turnId,
          toolCallId: 'binary',
          tool: 'Read',
          input: { content: 'x'.repeat(70_000) },
        }),
        event(input, 'tool_output', {
          turnId: input.turnId,
          toolCallId: 'binary',
          output: 'encoded-content',
          mime: 'image/png',
          totalBytes: 32,
        }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((e) => events.push(e))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'read' })
    assert.equal(events.find((e) => e.type === 'tool_started')?.payload?.inputTruncated, true)
    const output = events.find((e) => e.type === 'tool_output')!
    assert.equal(output.payload?.preview, '')
    assert.equal(output.payload?.totalBytes, 32)
    assert.equal(JSON.stringify(events).includes('encoded-content'), false)
  } finally {
    await f.cleanup()
  }
})

test('tool detail files are capped and preserve their head and tail', async () => {
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn(input) {
      return [
        event(input, 'tool_output', {
          turnId: input.turnId,
          toolCallId: 'huge',
          output: 'HEAD' + 'x'.repeat(6 * 1024 * 1024) + 'TAIL',
        }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'large' })
    const result = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'huge' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.detail.clipped, true)
      assert.ok(String(result.detail.output).startsWith('HEAD'))
      assert.ok(String(result.detail.output).endsWith('TAIL'))
    }
    const path = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.tools', 'huge.json')
    assert.ok((await stat(path)).size <= 5 * 1024 * 1024)
  } finally {
    await f.cleanup()
  }
})

test('three simultaneous approvals resolve in any order without losing pending requests', async () => {
  const resolved: string[] = []
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sessions: 'stateful',
    sendTurn(input) {
      return [
        event(input, 'turn_started', { turnId: input.turnId }),
        ...['first', 'second', 'third'].map((requestId) =>
          event(input, 'approval_requested', {
            turnId: input.turnId,
            requestId,
            kind: 'tool',
            action: 'Read',
            input: { path: 'example.txt' },
          }),
        ),
      ]
    },
    resolveApproval(input) {
      resolved.push(input.requestId)
      return [
        event(input, 'approval_resolved', {
          turnId: input.turnId,
          requestId: input.requestId,
          approved: input.approved,
        }),
        ...(resolved.length === 3 ? [event(input, 'turn_completed', { turnId: input.turnId })] : []),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    assert.ok((await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'Read three files' })).ok)
    for (const requestId of ['third', 'first', 'second']) {
      const result = await f.runtime.respondToRequest({
        sessionId: f.sessionId,
        requestId,
        approved: true,
        decision: 'once',
      })
      assert.ok(result.ok, result.ok ? '' : result.message)
      if (requestId !== 'second') {
        const [summary] = (f.runtime.listSessions() as { sessions: ConversationSessionSummary[] }).sessions
        assert.equal(summary.phase, 'waiting_for_approval', `still waiting after ${requestId}`)
        assert.equal(summary.status, 'awaiting_approval')
      }
    }
    assert.deepEqual(resolved, ['third', 'first', 'second'])
    const replay = await f.runtime.readTranscript(f.key, { all: true, closeOpenTurns: false })
    assert.ok(replay.ok)
    assert.equal(replay.events.filter((value) => value.type === 'approval_resolved').length, 3)
    assert.equal(replay.events.filter((value) => value.type === 'turn_completed').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('concurrent duplicate commands and receipts after restart produce one user message', async () => {
  const f = await fixture()
  try {
    const commandId = randomUUID()
    const input = { sessionId: f.sessionId, message: '/tools', commandId }
    const [first, second] = await Promise.all([f.runtime.sendTurn(input), f.runtime.sendTurn(input)])
    assert.deepEqual(first, second)
    await f.runtime.shutdown()
    const restarted = new ConversationRuntime({
      adapters: [createMockConversationProvider()],
      getProviderById: () => undefined,
    })
    try {
      const session = await restarted.startSession({ ...f.key, providerId: 'mock-provider', modelId: 'mock-model' })
      assert.equal(session.ok, true)
      if (!session.ok) return
      assert.deepEqual(await restarted.sendTurn({ ...input, sessionId: session.session.sessionId }), first)
      const replay = await restarted.readTranscript(f.key)
      assert.equal(replay.ok && replay.events.filter((e) => e.type === 'user_message').length, 1)
      assert.equal(replay.ok && replay.events.find((e) => e.type === 'user_message')?.payload?.commandId, commandId)
      if (replay.ok)
        assert.deepEqual(
          replay.events.map((e) => e.seq),
          replay.events.map((_, i) => i + 1),
        )
    } finally {
      await restarted.shutdown()
    }
  } finally {
    await f.cleanup()
  }
})

test('a command id named for a different command is refused, while the first runs, after it, and after a restart', async () => {
  const f = await fixture()
  try {
    const commandId = randomUUID()
    const send = (message: string, commandFingerprint: string) =>
      f.runtime.sendTurn({ sessionId: f.sessionId, message, commandId, commandFingerprint })
    const conflict = {
      ok: false,
      code: 'command_id_conflict',
      message: 'That command id was already used for a different command. Send this one under a new id.',
    }
    assert.equal(await f.runtime.hasCommandReceipt(f.sessionId, commandId), false, 'nothing is held before it runs')
    const running = send('/tools', 'fp-tools')
    assert.equal(await f.runtime.hasCommandReceipt(f.sessionId, commandId), true, 'held while it runs')
    const [first, racing] = await Promise.all([running, send('/help', 'fp-help')])
    assert.equal(first.ok, true)
    assert.deepEqual(racing, conflict, 'while the first is still running')
    assert.deepEqual(await send('/tools', 'fp-tools'), first, 'the same command again is answered from its receipt')
    assert.deepEqual(await send('/help', 'fp-help'), conflict, 'and another one under its id is refused')
    // A receipt's answer is its command's result: the fingerprint is the receipt's own.
    assert.equal('fingerprint' in (await send('/tools', 'fp-tools')), false)
    await f.runtime.shutdown()
    const restarted = new ConversationRuntime({
      adapters: [createMockConversationProvider()],
      getProviderById: () => undefined,
    })
    try {
      const session = await restarted.startSession({ ...f.key, providerId: 'mock-provider', modelId: 'mock-model' })
      if (!session.ok) throw new Error(session.message)
      const again = (message: string, commandFingerprint?: string) =>
        restarted.sendTurn({
          sessionId: session.session.sessionId,
          message,
          commandId,
          ...(commandFingerprint ? { commandFingerprint } : {}),
        })
      assert.equal(
        await restarted.hasCommandReceipt(session.session.sessionId, commandId),
        true,
        'a receipt on disk is held',
      )
      assert.deepEqual(await again('/help', 'fp-help'), conflict, 'the receipt on disk keeps what the command was')
      assert.deepEqual(await again('/tools', 'fp-tools'), first)
      // A caller that names no fingerprint (the IPC never does) is answered as before.
      assert.deepEqual(await again('/anything'), first)
      const replay = await restarted.readTranscript(f.key)
      assert.equal(replay.ok && replay.events.filter((e) => e.type === 'user_message').length, 1)
    } finally {
      await restarted.shutdown()
    }
  } finally {
    await f.cleanup()
  }
})

test('a crash after command intent persistence never replays its side effect', async () => {
  let intent = ''
  let receiptsPath = ''
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    async sendTurn(input) {
      intent = await readFile(receiptsPath, 'utf8')
      return [event(input, 'turn_completed', { turnId: input.turnId })]
    },
  }
  const f = await fixture(adapter)
  const restarted = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    receiptsPath = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.receipts.json')
    const commandId = randomUUID()
    assert.ok((await f.runtime.sendTurn({ sessionId: f.sessionId, commandId, message: 'one effect' })).ok)
    assert.equal(JSON.parse(intent)[0][1].ok, false, 'intent must exist before invoking the provider')
    await f.runtime.shutdown()
    // Preserve the exact durable state from before the result receipt was written.
    await writeFile(receiptsPath, intent)
    const opened = await restarted.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })
    assert.ok(opened.ok)
    const duplicate = await restarted.sendTurn({
      sessionId: opened.session.sessionId,
      commandId,
      message: 'one effect',
    })
    assert.equal(duplicate.ok, false)
    const transcript = await restarted.readTranscript(f.key, { all: true })
    assert.ok(transcript.ok)
    assert.equal(transcript.events.filter((entry) => entry.type === 'user_message').length, 1)
  } finally {
    await restarted.shutdown()
    await f.cleanup()
  }
})

test('first subscription pages even a small transcript while reconnects keep exact sequence replay', async () => {
  const f = await fixture({
    ...createMockConversationProvider(),
    sendTurn: (input) => [
      event(input, 'content_delta', { turnId: input.turnId, text: 'answer' }),
      event(input, 'turn_completed', { turnId: input.turnId }),
    ],
  })
  try {
    for (let index = 0; index < 12; index++)
      await f.runtime.sendTurn({ sessionId: f.sessionId, message: `Question ${index}` })
    const frames: ConversationSessionFrame[] = []
    const subscription = new ConversationSessionApi(f.runtime).subscribe({ key: f.key, turnLimit: 3 }, (frame) =>
      frames.push(frame),
    )
    await subscription.ready
    const first = frames[0]
    assert.equal(first.type, 'snapshot')
    if (first.type === 'snapshot') {
      assert.equal(first.page.events.filter((event) => event.type === 'user_message').length, 3)
      assert.equal(first.page.hasMore, true)
    }
    subscription.dispose()
    const renamed = await f.runtime.renameThread({ ...f.key, title: 'My durable name' })
    assert.equal(renamed.ok, true)
    await f.runtime.renameThread({ ...f.key, title: 'Generated name' }, 'generated')
    const listed = await f.runtime.listThreads(f.key)
    assert.equal(listed.ok && listed.threads[0].title, 'My durable name')
    const search = await f.runtime.searchThreads({ ...f.key, query: 'Question 11' })
    assert.equal(search.ok && search.hits.length, 1)
    const controller = new AbortController()
    controller.abort()
    assert.equal(
      (await f.runtime.searchThreads({ ...f.key, query: 'Question' }, { signal: controller.signal })).ok,
      false,
    )
    const replay = await f.runtime.readTranscript(f.key, { all: true })
    assert.ok(replay.ok)
    assert.equal(replay.events.filter((event) => event.payload?.titleSource).length, 1)
    assert.deepEqual(
      replay.events.map((event) => event.seq),
      replay.events.map((_, index) => index + 1),
    )
  } finally {
    await f.cleanup()
  }
})

test('reconnecting replaces cached history authoritatively and excludes unrelated agents', async () => {
  const f = await fixture()
  try {
    const api = new ConversationSessionApi(f.runtime)
    const frames: ConversationSessionFrame[] = []
    const joined = api.subscribe({ key: f.key, afterSeq: 0 }, (frame) => frames.push(frame))
    await joined.ready
    const initial = frames.find((frame) => frame.type === 'snapshot')
    assert.ok(initial?.type === 'snapshot')
    const afterSeq = initial.page.events.at(-1)!.seq!
    joined.dispose()
    joined.dispose()
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })
    const rejoined: ConversationSessionFrame[] = []
    const replay = api.subscribe({ key: f.key, afterSeq }, (frame) => rejoined.push(frame))
    await replay.ready
    const full = await f.runtime.readTranscript(f.key)
    assert.ok(full.ok)
    const snapshot = rejoined.find((frame) => frame.type === 'snapshot')
    assert.ok(snapshot?.type === 'snapshot' && snapshot.reset)
    assert.deepEqual(snapshot.page.events, full.events)
    const count = rejoined.length
    await f.runtime.startSession({ ...f.key, agentId: 'other', providerId: 'mock-provider', modelId: 'mock-model' })
    assert.equal(rejoined.length, count)
    replay.dispose()
  } finally {
    await f.cleanup()
  }
})

test('cursors without a generation, or ahead of the log, receive reset snapshots before live events', async () => {
  const f = await fixture()
  try {
    const api = new ConversationSessionApi(f.runtime)
    const initial = await f.runtime.readTranscript(f.key, { all: true, closeOpenTurns: false })
    assert.ok(initial.ok)
    const initialTail = initial.events.at(-1)!.seq!
    // A crashed client can be ahead of disk, collide with a recovery event, or
    // fall behind a different client's continuation. None proves prefix identity.
    for (const cursor of [initialTail + 1000, initialTail, 1]) {
      const before = await f.runtime.readTranscript(f.key, { all: true, closeOpenTurns: false })
      assert.ok(before.ok)
      const frames: ConversationSessionFrame[] = []
      const joined = api.subscribe({ key: f.key, afterSeq: cursor }, (frame) => frames.push(frame))
      await joined.ready
      const snapshot = frames[0]
      assert.ok(snapshot.type === 'snapshot' && snapshot.reset)
      assert.deepEqual(snapshot.page.events, before.events)
      assert.equal(frames[1].type === 'synchronized' && frames[1].seq, before.events.at(-1)!.seq)
      await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })
      const live = frames.filter((frame) => frame.type === 'event')
      assert.ok(live.length > 0)
      assert.equal(live[0].event.seq, before.events.at(-1)!.seq! + 1)
      assert.ok(live.some((frame) => frame.event.type === 'turn_completed'))
      joined.dispose()
    }
  } finally {
    await f.cleanup()
  }
})

test('legacy 5000-event logs get stable sequences and turn-aligned pages reaching the first event', async () => {
  const f = await fixture()
  try {
    await f.runtime.stopSession({ sessionId: f.sessionId })
    const path = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.jsonl')
    const events = Array.from({ length: 5000 }, (_, index) => ({
      id: `legacy_${index}`,
      sessionId: 'old',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
      createdAt: index,
      type: index % 5 === 0 ? 'user_message' : index % 5 === 4 ? 'turn_completed' : 'tool_started',
      payload: { turnId: `turn_${Math.floor(index / 5)}`, tool: 'Bash' },
    }))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const api = new ConversationSessionApi(f.runtime)
    const frames: ConversationSessionFrame[] = []
    const subscription = api.subscribe({ key: f.key }, (frame) => frames.push(frame))
    await subscription.ready
    const snapshot = frames.find((frame) => frame.type === 'snapshot')
    assert.ok(snapshot?.type === 'snapshot')
    assert.equal(snapshot.page.hasMore, true)
    assert.equal(snapshot.page.events.length, 50)
    let page = snapshot.page
    while (page.hasMore) {
      const prior = await api.loadEarlier({ key: f.key, beforeCursor: page.beforeCursor!, turnLimit: 100 })
      assert.ok(prior.ok)
      page = prior.page
      assert.equal(page.events[0].type, 'user_message')
    }
    assert.equal(page.events[0].seq, 1)
    assert.equal(page.events[1].payload?.kind, 'command')
    subscription.dispose()
  } finally {
    await f.cleanup()
  }
})

test('throwing providers and listeners leave a retryable session', async () => {
  let fail = true
  const mock = createMockConversationProvider()
  const f = await fixture({
    ...mock,
    sendTurn(input) {
      if (fail) {
        fail = false
        throw new Error('provider failed')
      }
      return mock.sendTurn(input)
    },
  })
  try {
    let healthy = 0
    f.runtime.onEvent(() => {
      throw new Error('listener failed')
    })
    f.runtime.onEvent(() => healthy++)
    assert.equal((await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })).ok, false)
    assert.equal((await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })).ok, true)
    assert.ok(healthy > 2)
  } finally {
    await f.cleanup()
  }
})

test('subscribe joins a racing replay without gaps or duplicates and disposes synchronously', async () => {
  let resolveRead!: (value: unknown) => void
  const listeners = new Set<(event: ConversationEvent) => void>()
  const read = new Promise((resolve) => {
    resolveRead = resolve
  })
  const runtime = {
    recoverTranscript: async () => undefined,
    onEvent(listener: (event: ConversationEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readConversationSync: () => read,
  } as unknown as ConversationRuntime
  const api = new ConversationSessionApi(runtime)
  const key = { workspaceRoot: '/workspace', workspaceId: 'workspace', agentId: 'agent' }
  const envelope = { ...key, sessionId: 'session', providerId: 'mock-provider', modelId: 'mock-model' }
  const first = { ...event(envelope, 'content_delta', { text: 'a' }), seq: 1 }
  const second = { ...event(envelope, 'content_delta', { text: 'b' }), seq: 2 }
  const frames: ConversationSessionFrame[] = []
  const subscription = api.subscribe({ key, afterSeq: 0 }, (frame) => frames.push(frame))
  for (const listener of listeners) listener(second)
  resolveRead({
    ok: true,
    kind: 'snapshot',
    page: { events: [first, second], hasMore: false, beforeCursor: 1 },
    head: 2,
    generation: 'g',
  })
  await subscription.ready
  for (const listener of listeners) listener({ ...second, seq: 3 })
  assert.deepEqual(
    frames.flatMap((frame) =>
      frame.type === 'snapshot'
        ? frame.page.events.map((event) => event.seq)
        : [frame.type === 'event' ? frame.event.seq : frame.type],
    ),
    [1, 2, 'synchronized', 3],
  )
  subscription.dispose()
  subscription.dispose()
  assert.equal(listeners.size, 0)
  const throwing = api.subscribe({ key }, () => {
    throw new Error('renderer disappeared')
  })
  await throwing.ready
  assert.equal(listeners.size, 0)
})

test('cold subscriptions persist crash recovery exactly once before snapshots and reconnects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-recovery-'))
  const key = { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' }
  const path = workspaceStorePath(root, 'conversations', 'workspace', 'agent.jsonl')
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  try {
    await mkdir(dirname(path), { recursive: true })
    const input = { ...key, sessionId: 'crashed', providerId: 'mock-provider', modelId: 'mock-model' }
    await writeFile(
      path,
      [
        event(input, 'user_message', { text: 'Interrupted question', turnId: 'lost' }),
        event(input, 'turn_started', { turnId: 'lost' }),
      ]
        .map((item, index) => JSON.stringify({ ...item, seq: index + 1 }))
        .join('\n') + '\n',
    )
    const api = new ConversationSessionApi(runtime)
    const frames: ConversationSessionFrame[] = []
    const a = api.subscribe({ key }, (frame) => frames.push(frame)),
      b = api.subscribe({ key, afterSeq: 2 }, () => undefined)
    await Promise.all([a.ready, b.ready])
    const snapshot = frames.find((frame) => frame.type === 'snapshot')
    assert.equal(snapshot?.type === 'snapshot' && snapshot.page.events.at(-1)?.type, 'turn_failed')
    const persisted = await runtime.readTranscript(key, { all: true, closeOpenTurns: false })
    assert.ok(persisted.ok)
    assert.equal(persisted.events.filter((item) => item.type === 'turn_failed').length, 1)
    a.dispose()
    b.dispose()
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })).ok, true)
  } finally {
    await runtime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('deleting an idle live thread disposes its identity and starts fresh without resurrecting a native cursor', async () => {
  const adapter = {
    ...createMockConversationProvider(),
    sendTurn: (input: Parameters<ConversationProviderAdapter['sendTurn']>[0]) => [
      event(input, 'turn_completed', { turnId: input.turnId }),
    ],
  }
  const f = await fixture(adapter)
  try {
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'Finished' })
    assert.equal((await f.runtime.deleteTranscript(f.key)).ok, true)
    assert.equal((await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'Must fail' })).ok, false)
    const listed = await f.runtime.listThreads(f.key)
    assert.equal(listed.ok && listed.threads.length, 0)
    const restarted = await f.runtime.startSession({ ...f.key, providerId: adapter.id, modelId: 'mock-model' })
    assert.ok(restarted.ok)
    const transcript = await f.runtime.readTranscript(f.key, { all: true })
    assert.ok(transcript.ok)
    assert.equal(
      transcript.events.some((item) => item.type === 'user_message'),
      false,
    )
    assert.equal(transcript.events[0].seq, 1)
  } finally {
    await f.cleanup()
  }
})

test('failed startup does not leave a zombie and a rejecting persister clears a busy turn', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-failure-'))
  const key = {
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  }
  const brokenStart = new ConversationRuntime({
    adapters: [
      {
        ...createMockConversationProvider(),
        startSession() {
          throw new Error('start failed')
        },
      },
    ],
    getProviderById: () => undefined,
  })
  let writes = 0
  const brokenWrite = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    eventLog: {
      openStream: async () => ({
        write: async () => {
          if (++writes === 3) throw new Error('disk failed')
        },
        close: async () => {},
      }),
      onError: (_path, error) => {
        throw error
      },
    },
  })
  try {
    assert.equal((await brokenStart.startSession(key)).ok, false)
    assert.deepEqual(brokenStart.listSessions(), { ok: true, sessions: [] })
    const session = await brokenWrite.startSession(key)
    assert.ok(session.ok)
    assert.equal((await brokenWrite.sendTurn({ sessionId: session.session.sessionId, message: '/tools' })).ok, false)
    const listed = brokenWrite.listSessions()
    assert.ok(listed.ok)
    assert.equal(listed.sessions[0].status, 'failed')
  } finally {
    await brokenStart.shutdown()
    await brokenWrite.shutdown().catch(() => undefined)
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('remembered approvals auto-resolve later matching tools and persistence failures preserve manual control', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-permissions-'))
  const storeRoot = join(workspaceRoot, 'settings')
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const mock = createMockConversationProvider()
  let approvalHints: Record<string, unknown> = {}
  const adapter = {
    ...mock,
    sendTurn(input: import('./providers/conversation-provider-adapter').MockAdapterTurnInput) {
      return [
        event(input, 'turn_started', { turnId: input.turnId }),
        event(input, 'approval_requested', {
          turnId: input.turnId,
          requestId: input.requestId,
          action: 'Read',
          kind: 'tool',
          toolKind: 'file_read',
          input: { file_path: join(workspaceRoot, 'file.txt') },
          ...approvalHints,
        }),
      ]
    },
  }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    approvalRules: new ConversationApprovalRuleStore(storeRoot),
  })
  try {
    await writeFile(join(workspaceRoot, 'file.txt'), 'read me')
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const events: ConversationEvent[] = []
    runtime.onEvent((value) => events.push(value))
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'first' })
    const requestId = String(events.find((value) => value.type === 'approval_requested')?.payload?.requestId)
    assert.ok(
      (
        await runtime.respondToRequest({
          sessionId: started.session.sessionId,
          requestId,
          approved: true,
          decision: 'conversation',
        })
      ).ok,
    )
    let complete!: () => void
    const completed = new Promise<void>((resolve) => {
      complete = resolve
    })
    const stop = runtime.onEvent((value) => {
      if (value.type === 'turn_completed') complete()
    })
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'second' })
    await completed
    // Terminal publication precedes the adapter response's final turn-lock
    // cleanup; start the next user action on the next event-loop turn.
    await new Promise<void>((resolve) => setImmediate(resolve))
    stop()
    assert.equal(events.filter((value) => value.type === 'approval_resolved').at(-1)?.payload?.autoApproved, true)
    const automaticRequest = events.filter((value) => value.type === 'approval_requested').at(-1)!
    const automaticResolution = events.filter((value) => value.type === 'approval_resolved').at(-1)!
    assert.equal(automaticRequest.payload?.autoApproved, true)
    assert.equal(typeof automaticRequest.payload?.ruleLabel, 'string')
    assert.ok(events.indexOf(automaticRequest) < events.indexOf(automaticResolution))
    for (const hint of ['defaultToNo', 'suppressAlwaysAllowRule']) {
      approvalHints = { [hint]: true }
      assert.ok((await runtime.sendTurn({ sessionId: started.session.sessionId, message: `flagged ${hint}` })).ok)
      const request = events.filter((value) => value.type === 'approval_requested').at(-1)!
      assert.notEqual(request.payload?.autoApproved, true)
      assert.equal(request.payload?.ruleLabel, undefined)
      assert.ok(
        (
          await runtime.respondToRequest({
            sessionId: started.session.sessionId,
            requestId: String(request.payload?.requestId),
            approved: false,
          })
        ).ok,
      )
    }
    approvalHints = {}
    await mkdir(storeRoot, { recursive: true })
    await writeFile(join(storeRoot, 'conversation-approval-rules.json'), '{bad')
    const broken = new ConversationRuntime({
      adapters: [adapter],
      getProviderById: () => undefined,
      approvalRules: new ConversationApprovalRuleStore(storeRoot),
    })
    try {
      const session = await broken.startSession({
        ...key,
        agentId: 'other',
        providerId: 'mock-provider',
        modelId: 'mock-model',
      })
      assert.ok(session.ok)
      let request = ''
      broken.onEvent((value) => {
        if (value.type === 'approval_requested') request = String(value.payload?.requestId)
      })
      await broken.sendTurn({ sessionId: session.session.sessionId, message: 'third' })
      assert.equal(
        (
          await broken.respondToRequest({
            sessionId: session.session.sessionId,
            requestId: request,
            approved: true,
            decision: 'always',
          })
        ).ok,
        false,
      )
      assert.equal(
        (
          await broken.respondToRequest({
            sessionId: session.session.sessionId,
            requestId: request,
            approved: true,
            decision: 'once',
          })
        ).ok,
        true,
      )
    } finally {
      await broken.shutdown()
    }
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a tool approval says whether it can be allowed for the conversation, in the words the menu uses', async () => {
  const requests = [
    { requestId: 'simple', action: 'Bash', kind: 'tool', input: { command: 'git status --short' } },
    { requestId: 'compound', action: 'Bash', kind: 'tool', input: { command: 'ls && echo --- && cat x 2>/dev/null' } },
    { requestId: 'flagged', action: 'Bash', kind: 'tool', input: { command: 'git status' }, defaultToNo: true },
    { requestId: 'question', action: 'AskUserQuestion', kind: 'question', input: {} },
  ]
  const mock = createMockConversationProvider()
  const { runtime, sessionId, cleanup } = await fixture({
    ...mock,
    sendTurn: (input) => [
      event(input, 'turn_started', { turnId: input.turnId }),
      ...requests.map((request) => event(input, 'approval_requested', { turnId: input.turnId, ...request })),
    ],
  })
  try {
    const events: ConversationEvent[] = []
    runtime.onEvent((value) => events.push(value))
    await runtime.sendTurn({ sessionId, message: 'look around' })
    const stamped = new Map(
      events
        .filter((value) => value.type === 'approval_requested')
        .map((value) => [value.payload?.requestId, value.payload]),
    )
    assert.equal(stamped.get('simple')?.rememberable, true)
    assert.equal(stamped.get('simple')?.rememberLabel, 'Allow "git status …" for this conversation')
    // A compound command has no rule a remembered grant could name.
    for (const requestId of ['compound', 'flagged']) {
      assert.equal(stamped.get(requestId)?.rememberable, false, requestId)
      assert.equal(stamped.get(requestId)?.rememberLabel, undefined, requestId)
    }
    // Only a tool request is a permission; a question carries neither field.
    assert.equal(stamped.get('question')?.rememberable, undefined)
  } finally {
    await cleanup()
  }
})

/** A provider whose turn streams whatever the test pushes, until it ends the turn. */
function pushProvider() {
  let push: (text: string | null) => void = () => undefined
  let started!: () => void
  const turnStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn: (input) =>
      (async function* () {
        const queue: Array<string | null> = []
        let wake: (() => void) | null = null
        push = (text) => {
          queue.push(text)
          wake?.()
        }
        yield event(input, 'turn_started', { turnId: input.turnId })
        started()
        for (;;) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
          wake = null
          const text = queue.shift()!
          if (text === null) break
          yield event(input, 'content_delta', { turnId: input.turnId, text })
        }
        yield event(input, 'turn_completed', { turnId: input.turnId })
      })(),
  }
  return { adapter, turnStarted, push: (text: string | null) => push(text) }
}

const frameSeqs = (frames: ConversationSessionFrame[]) =>
  frames.flatMap((frame) => (frame.type === 'event' ? [frame.event.seq!] : []))

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate())
}

test('a reconnect mid-turn with its cursor gets exactly the missed events while deltas keep streaming', async () => {
  const provider = pushProvider()
  const f = await fixture(provider.adapter)
  try {
    const api = new ConversationSessionApi(f.runtime)
    const first: ConversationSessionFrame[] = []
    const joined = api.subscribe({ key: f.key }, (frame) => first.push(frame))
    await joined.ready
    const sending = f.runtime.sendTurn({ sessionId: f.sessionId, message: 'stream' })
    await provider.turnStarted
    for (let index = 0; index < 5; index++) provider.push(`before-${index} `)
    await waitFor(() => first.some((frame) => frame.type === 'event' && frame.event.payload?.text === 'before-4 '))
    const synchronized = first.find((frame) => frame.type === 'synchronized')
    assert.ok(synchronized?.type === 'synchronized' && synchronized.generation)
    const cursor = Math.max(...frameSeqs(first))
    joined.dispose()

    // Offline: more deltas land and are published to nobody.
    for (let index = 0; index < 5; index++) provider.push(`missed-${index} `)
    const watcher: number[] = []
    const stopWatching = f.runtime.onEvent((value) => watcher.push(value.seq!))
    await waitFor(() => watcher.length >= 5)

    const rejoined: ConversationSessionFrame[] = []
    const again = api.subscribe({ key: f.key, afterSeq: cursor, generation: synchronized.generation }, (frame) =>
      rejoined.push(frame),
    )
    // Deltas keep arriving while the reconnect is reading.
    for (let index = 0; index < 5; index++) provider.push(`during-${index} `)
    await again.ready
    for (let index = 0; index < 3; index++) provider.push(`after-${index} `)
    provider.push(null)
    await sending
    await waitFor(() => rejoined.some((frame) => frame.type === 'event' && frame.event.type === 'turn_completed'))
    stopWatching()

    assert.equal(
      rejoined.some((frame) => frame.type === 'snapshot'),
      false,
      'a cursor the log can vouch for is not answered with a reset',
    )
    const seqs = frameSeqs(rejoined)
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'in order',
    )
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicates')
    assert.ok(seqs[0] > cursor)
    const text = rejoined
      .flatMap((frame) =>
        frame.type === 'event' && frame.event.type === 'content_delta' ? [frame.event.payload!.text] : [],
      )
      .join('')
    const expected = [
      ...Array.from({ length: 5 }, (_, index) => `missed-${index} `),
      ...Array.from({ length: 5 }, (_, index) => `during-${index} `),
      ...Array.from({ length: 3 }, (_, index) => `after-${index} `),
    ].join('')
    assert.equal(text, expected, 'every missed and later delta exactly once, none from before the cursor')
    const transcript = await f.runtime.readTranscript(f.key, { all: true, closeOpenTurns: false })
    assert.ok(transcript.ok)
    const head = transcript.events.at(-1)!.seq!
    assert.equal(seqs.at(-1), head, 'caught up to the end of the log')
    again.dispose()
  } finally {
    await f.cleanup()
  }
})

test('a cursor from another log generation or too far behind gets a reset snapshot', async () => {
  const f = await fixture()
  try {
    const api = new ConversationSessionApi(f.runtime)
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })
    const frames: ConversationSessionFrame[] = []
    const joined = api.subscribe({ key: f.key }, (frame) => frames.push(frame))
    await joined.ready
    joined.dispose()
    const synchronized = frames.find((frame) => frame.type === 'synchronized')
    assert.ok(synchronized?.type === 'synchronized' && synchronized.generation)

    const stale: ConversationSessionFrame[] = []
    const other = api.subscribe({ key: f.key, afterSeq: 1, generation: 'another-log' }, (frame) => stale.push(frame))
    await other.ready
    other.dispose()
    assert.ok(stale[0].type === 'snapshot' && stale[0].reset)

    const current: ConversationSessionFrame[] = []
    const caughtUp = api.subscribe({ key: f.key, afterSeq: 1, generation: synchronized.generation }, (frame) =>
      current.push(frame),
    )
    await caughtUp.ready
    caughtUp.dispose()
    assert.equal(current[0].type, 'event')

    // The log is deleted and a new one takes its path: the old cursor must not replay against it.
    assert.equal((await f.runtime.deleteTranscript(f.key)).ok, true)
    const restarted = await f.runtime.startSession({ ...f.key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(restarted.ok)
    await f.runtime.sendTurn({ sessionId: restarted.session.sessionId, message: '/tools' })
    const recreated: ConversationSessionFrame[] = []
    const fresh = api.subscribe({ key: f.key, afterSeq: 1, generation: synchronized.generation }, (frame) =>
      recreated.push(frame),
    )
    await fresh.ready
    fresh.dispose()
    assert.ok(recreated[0].type === 'snapshot' && recreated[0].reset)
  } finally {
    await f.cleanup()
  }
})

test('a reconnect further behind than the catch-up budget gets a snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-behind-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    transcriptLimits: { catchUpEvents: 3 },
  })
  try {
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const api = new ConversationSessionApi(runtime)
    const frames: ConversationSessionFrame[] = []
    const joined = api.subscribe({ key }, (frame) => frames.push(frame))
    await joined.ready
    joined.dispose()
    const synchronized = frames.find((frame) => frame.type === 'synchronized')
    assert.ok(synchronized?.type === 'synchronized')
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    const behind: ConversationSessionFrame[] = []
    const again = api.subscribe({ key, afterSeq: synchronized.seq, generation: synchronized.generation }, (frame) =>
      behind.push(frame),
    )
    await again.ready
    again.dispose()
    assert.ok(behind[0].type === 'snapshot' && behind[0].reset)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a transcript past the whole-file limit still subscribes, catches up, pages and resumes', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-large-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const path = workspaceStorePath(workspaceRoot, 'conversations', 'workspace', 'agent.jsonl')
  const envelope = { ...key, sessionId: 'old', providerId: 'mock-provider', modelId: 'mock-model' }
  const lines: string[] = []
  let seq = 0
  lines.push(
    JSON.stringify({ ...event(envelope, 'session_started', { providerSessionId: 'native-1' }), id: 'e0', seq: ++seq }),
  )
  for (let turn = 0; turn < 60; turn++) {
    lines.push(
      JSON.stringify({
        ...event(envelope, 'user_message', { turnId: `t${turn}`, text: `Question ${turn}` }),
        id: `u${turn}`,
        seq: ++seq,
      }),
    )
    const parts = ['An', 'swer ', `${turn}`].map((text, index) => [`d${turn}_${index}`, 1, text.length, ++seq])
    lines.push(
      JSON.stringify({
        ...event(envelope, 'content_delta', { turnId: `t${turn}`, text: `Answer ${turn}` }),
        id: `d${turn}_0`,
        seq: parts[0][3],
        parts,
      }),
    )
    lines.push(
      JSON.stringify({
        ...event(envelope, 'turn_completed', { turnId: `t${turn}` }),
        id: `c${turn}`,
        seq: ++seq,
        createdAt: 1_000 + turn,
      }),
    )
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.join('\n') + '\n')
  const size = (await stat(path)).size
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    // Well under the file: before, any read past this failed outright.
    transcriptLimits: { fullReadBytes: Math.floor(size / 4), pageBytes: Math.floor(size / 8) },
  })
  try {
    const api = new ConversationSessionApi(runtime)
    const frames: ConversationSessionFrame[] = []
    const joined = api.subscribe({ key, turnLimit: 5 }, (frame) => frames.push(frame))
    await joined.ready
    joined.dispose()
    const snapshot = frames[0]
    assert.ok(snapshot.type === 'snapshot', JSON.stringify(frames[0]))
    assert.equal(snapshot.page.events.filter((item) => item.type === 'user_message').length, 5)
    assert.equal(snapshot.page.hasMore, true)
    const merged = snapshot.page.events.find((item) => item.type === 'content_delta')!
    assert.equal(merged.payload?.text, 'Answer 55', 'a merged run stays one event in a snapshot')
    assert.equal('parts' in merged, false)
    const synchronized = frames.find((frame) => frame.type === 'synchronized')
    assert.ok(synchronized?.type === 'synchronized')
    assert.equal(synchronized.seq, seq)

    // Page all the way back: every turn exactly once, in order.
    const questions: string[] = []
    let page = snapshot.page
    questions.unshift(
      ...page.events.filter((item) => item.type === 'user_message').map((item) => String(item.payload?.text)),
    )
    while (page.hasMore) {
      const earlier = await api.loadEarlier({ key, beforeCursor: page.beforeCursor!, turnLimit: 7 })
      assert.ok(earlier.ok)
      page = earlier.page
      questions.unshift(
        ...page.events.filter((item) => item.type === 'user_message').map((item) => String(item.payload?.text)),
      )
    }
    assert.deepEqual(
      questions,
      Array.from({ length: 60 }, (_, index) => `Question ${index}`),
    )
    assert.equal(page.events[0].type, 'session_started')

    // A cursor in the middle of a merged run gets the rest of the run only.
    const midRun = seq - 2
    const caught: ConversationSessionFrame[] = []
    const again = api.subscribe({ key, afterSeq: midRun, generation: synchronized.generation }, (frame) =>
      caught.push(frame),
    )
    await again.ready
    again.dispose()
    assert.deepEqual(
      caught.flatMap((frame) =>
        frame.type === 'event' ? [[frame.event.type, frame.event.payload?.text ?? null]] : [],
      ),
      [
        ['content_delta', '59'],
        ['turn_completed', null],
      ],
    )

    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok, 'a long chat still starts')
    assert.equal(started.session.firstUserText, 'Question 0')
    assert.equal(started.session.lastTurnEndedAt, 1_059, 'the finished time is the last turn’s, not the resume’s')
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })).ok, true)
    const tail = await runtime.readTranscript(key, { all: true, closeOpenTurns: false })
    assert.ok(tail.ok)
    assert.ok((tail.events.at(-1)?.seq ?? 0) > seq, 'new events continue the stored sequence')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('subscribing while a turn appends to the transcript succeeds every time', async () => {
  const provider = pushProvider()
  const f = await fixture(provider.adapter)
  try {
    const api = new ConversationSessionApi(f.runtime)
    const sending = f.runtime.sendTurn({ sessionId: f.sessionId, message: 'stream' })
    await provider.turnStarted
    let streaming = true
    const pump = (async () => {
      for (let index = 0; streaming; index++) {
        provider.push(`token-${index} `)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    })()
    for (let attempt = 0; attempt < 20; attempt++) {
      const frames: ConversationSessionFrame[] = []
      const joined = api.subscribe({ key: f.key }, (frame) => frames.push(frame))
      await joined.ready
      joined.dispose()
      assert.equal(
        frames.some((frame) => frame.type === 'error'),
        false,
        JSON.stringify(frames.find((frame) => frame.type === 'error')),
      )
      assert.ok(frames.some((frame) => frame.type === 'synchronized'))
      const page = await api.loadEarlier({ key: f.key, beforeCursor: Number.MAX_SAFE_INTEGER })
      assert.equal(page.ok, true)
    }
    streaming = false
    await pump
    provider.push(null)
    await sending
  } finally {
    await f.cleanup()
  }
})

function streamingToolAdapter(chunks: string[], final: Record<string, unknown>): ConversationProviderAdapter {
  return {
    ...createMockConversationProvider(),
    sendTurn: (input) =>
      (async function* () {
        yield event(input, 'tool_started', {
          turnId: input.turnId,
          toolCallId: 'cmd',
          tool: 'Bash',
          input: { command: 'build' },
        })
        for (const output of chunks)
          yield event(input, 'tool_output', {
            turnId: input.turnId,
            toolUseId: 'cmd',
            output,
            outputMode: 'append',
            partial: true,
            status: 'ok',
          })
        yield event(input, 'tool_output', { turnId: input.turnId, toolUseId: 'cmd', status: 'ok', ...final })
        yield event(input, 'turn_completed', { turnId: input.turnId })
      })(),
  }
}

test('appended tool output streams a tail preview, coalesces in the transcript and builds the full detail once', async () => {
  const chunks = Array.from({ length: 200 }, (_, index) => `line ${index} ${'.'.repeat(100)}\n`)
  const f = await fixture(streamingToolAdapter(chunks, { output: '', outputMode: 'append', exitCode: 0 }))
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((value) => events.push(value))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'build' })
    const outputs = events.filter((value) => value.type === 'tool_output')
    const final = outputs.at(-1)!
    const whole = chunks.join('')
    assert.equal(final.payload?.preview, whole.slice(-4000), 'the preview follows the newest output')
    assert.equal(final.payload?.totalBytes, Buffer.byteLength(whole))
    assert.equal(final.payload?.truncated, true)
    assert.equal('outputMode' in final.payload!, false, 'published events always carry the whole preview')
    for (const partial of outputs.slice(0, -1)) assert.equal(String(partial.payload?.preview).length <= 4000, true)
    const transcript = await readFile(
      workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.jsonl'),
      'utf8',
    )
    const persisted = transcript.split('\n').filter((line) => line.includes('"tool_output"'))
    assert.ok(persisted.length < 10, `tool output is coalesced on disk (${persisted.length} records for 200 chunks)`)
    const detail = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'cmd' })
    assert.ok(detail.ok)
    assert.equal(detail.detail.output, whole)
    assert.deepEqual(detail.detail.input, { command: 'build' })
    assert.equal(detail.detail.exitCode, 0)
  } finally {
    await f.cleanup()
  }
})

test('a whole final output after appended partial output replaces what streamed', async () => {
  // Claude's shape: the running command's output read from its file as it is
  // written, then the tool result with all of it.
  const f = await fixture(
    streamingToolAdapter(['PASS a.test.ts\n', 'PASS b'], {
      output: 'PASS a.test.ts\nPASS b.test.ts\n',
      isError: false,
    }),
  )
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((value) => events.push(value))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'test' })
    const final = events.filter((value) => value.type === 'tool_output').at(-1)!
    assert.equal(final.payload?.partial, undefined)
    assert.equal(final.payload?.preview, 'PASS a.test.ts\nPASS b.test.ts\n', 'the result, not the stream plus it')
    const detail = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'cmd' })
    assert.ok(detail.ok)
    assert.equal(detail.detail.output, 'PASS a.test.ts\nPASS b.test.ts\n')
  } finally {
    await f.cleanup()
  }
})

test('streamed tool output past the detail budget keeps its head and newest tail', async () => {
  const chunks = ['first-line\n', ...Array.from({ length: 7 }, () => 'x'.repeat(1024 * 1024)), '\nlast-line']
  const f = await fixture(streamingToolAdapter(chunks, { output: '', outputMode: 'append' }))
  try {
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'build' })
    const detail = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'cmd' })
    assert.ok(detail.ok)
    assert.equal(detail.detail.clipped, true)
    assert.match(String(detail.detail.output), /^first-line\n/)
    assert.match(String(detail.detail.output), /\nlast-line$/)
    assert.ok(Buffer.byteLength(String(detail.detail.output)) < 5 * 1024 * 1024 + 30)
    assert.equal(detail.detail.totalBytes, Buffer.byteLength(chunks.join('')))
  } finally {
    await f.cleanup()
  }
})

test('cumulative partial output previews its newest text and keeps the detail current', async () => {
  const f = await fixture({
    ...createMockConversationProvider(),
    sendTurn: (input) => [
      event(input, 'tool_started', { turnId: input.turnId, toolCallId: 'acp', tool: 'Bash', input: { command: 'ls' } }),
      // Cumulative adapters send the whole output so far on every update.
      event(input, 'tool_output', { turnId: input.turnId, toolUseId: 'acp', output: 'a'.repeat(5000), partial: true }),
      event(input, 'tool_output', {
        turnId: input.turnId,
        toolUseId: 'acp',
        output: `${'a'.repeat(5000)}END`,
        partial: true,
      }),
      event(input, 'turn_completed', { turnId: input.turnId }),
    ],
  })
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((value) => events.push(value))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'ls' })
    const outputs = events.filter((value) => value.type === 'tool_output')
    assert.equal(outputs.length, 1, 'the superseded preview is not published')
    assert.ok(String(outputs[0].payload?.preview).endsWith('END'), 'a live row shows the newest output')
    const detail = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'acp' })
    assert.ok(detail.ok)
    assert.equal(detail.detail.output, `${'a'.repeat(5000)}END`)
    assert.deepEqual(detail.detail.input, { command: 'ls' })
  } finally {
    await f.cleanup()
  }
})

test('a full final output replaces what streamed', async () => {
  const f = await fixture(streamingToolAdapter(['partial one ', 'partial two'], { output: 'complete output' }))
  try {
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'build' })
    const detail = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'cmd' })
    assert.ok(detail.ok)
    assert.equal(detail.detail.output, 'complete output')
    const streamed = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.tools', 'cmd.output')
    await assert.rejects(stat(streamed), { code: 'ENOENT' })
  } finally {
    await f.cleanup()
  }
})

test('a receipts read that fails once does not fail every later command', async () => {
  const f = await fixture()
  try {
    const folder = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace')
    const receipts = join(folder, 'agent.receipts.json')
    await mkdir(join(folder, 'elsewhere'), { recursive: true })
    await writeFile(join(folder, 'elsewhere', 'receipts.json'), '[]')
    await symlink(join(folder, 'elsewhere', 'receipts.json'), receipts)
    const refused = await f.runtime.sendTurn({ sessionId: f.sessionId, commandId: 'first', message: '/tools' })
    assert.equal(refused.ok, false)
    await rm(receipts)
    const accepted = await f.runtime.sendTurn({ sessionId: f.sessionId, commandId: 'second', message: '/tools' })
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message)
  } finally {
    await f.cleanup()
  }
})

test('a corrupt receipts file is moved aside instead of refusing commands', async () => {
  const f = await fixture()
  try {
    const folder = workspaceStorePath(f.key.workspaceRoot, 'conversations', 'workspace')
    await writeFile(join(folder, 'agent.receipts.json'), '{broken')
    const result = await f.runtime.sendTurn({
      sessionId: f.sessionId,
      commandId: 'after-corruption',
      message: '/tools',
    })
    assert.equal(result.ok, true)
    assert.equal(await readFile(join(folder, 'agent.receipts.json.corrupt'), 'utf8'), '{broken')
    const receipts = JSON.parse(await readFile(join(folder, 'agent.receipts.json'), 'utf8')) as [string, unknown][]
    assert.deepEqual(
      receipts.map(([id]) => id),
      ['after-corruption'],
    )
  } finally {
    await f.cleanup()
  }
})

test('a command that throws records its failure, so a retry gets that result instead of an interrupted one', async () => {
  let calls = 0
  const f = await fixture({
    ...createMockConversationProvider(),
    setPermissionPreset: async () => {
      calls++
      throw new Error('provider refused the change')
    },
  })
  try {
    const first = await f.runtime.setPermission({
      sessionId: f.sessionId,
      commandId: 'perm',
      permissionPreset: 'bypass',
    })
    assert.deepEqual(first, { ok: false, message: 'provider refused the change' })
    const retry = await f.runtime.setPermission({
      sessionId: f.sessionId,
      commandId: 'perm',
      permissionPreset: 'bypass',
    })
    assert.deepEqual(retry, first)
    assert.equal(calls, 1, 'the retry is answered from its receipt, not executed again')
  } finally {
    await f.cleanup()
  }
})

test('a turn failure the transcript cannot store still reaches subscribers, numbered', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-unwritable-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  let broken = false
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    eventLog: {
      openStream: async () => ({
        write: async () => {
          if (broken) throw new Error('disk failed')
        },
        close: async () => {},
      }),
      onError: (_path, error) => {
        throw error
      },
    },
  })
  try {
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const frames: ConversationSessionFrame[] = []
    const joined = new ConversationSessionApi(runtime).subscribe({ key }, (frame) => frames.push(frame))
    await joined.ready
    const synchronized = frames.find((frame) => frame.type === 'synchronized')
    assert.ok(synchronized?.type === 'synchronized')
    broken = true
    const result = await runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    assert.equal(result.ok, false)
    const failed = frames.find((frame) => frame.type === 'event' && frame.event.type === 'turn_failed')
    assert.ok(failed?.type === 'event', 'the failure is delivered, not dropped for lacking a sequence number')
    assert.ok(failed.event.seq! > synchronized.seq)
    joined.dispose()

    // Its numbering is no longer on disk, so a reconnect is sent a snapshot.
    const again: ConversationSessionFrame[] = []
    const rejoined = new ConversationSessionApi(runtime).subscribe(
      { key, afterSeq: synchronized.seq, generation: synchronized.generation },
      (frame) => again.push(frame),
    )
    await rejoined.ready
    rejoined.dispose()
    assert.ok(again[0].type === 'snapshot' && again[0].reset)
  } finally {
    await runtime.shutdown().catch(() => undefined)
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

async function throttledRuntime(sendTurn: ConversationProviderAdapter['sendTurn'], toolPreviewIntervalMs = 250) {
  const adapter = { ...createMockConversationProvider(), sendTurn }
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-session-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    // The log alone would write a running tool's preview every 20 ms here.
    eventLog: { flushDelayMs: 5, toolOutputFlushDelayMs: 20 },
    toolPreviewIntervalMs,
  })
  const started = await runtime.startSession({ ...key, providerId: adapter.id, modelId: adapter.listModels()[0] })
  assert.ok(started.ok)
  const published: ConversationEvent[] = []
  runtime.onEvent((value) => published.push(value))
  const persistedPreviews = async () =>
    (await readFile(workspaceStorePath(workspaceRoot, 'conversations', 'workspace', 'agent.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"tool_output"') && line.includes('"partial":true'))
  return {
    runtime,
    key,
    sessionId: started.session.sessionId,
    published,
    persistedPreviews,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a preview released while the final output is being prepared never lands after it', async () => {
  // The second preview is held with a short timer; the final output behind it
  // is large, so storing it outlasts that timer. The held preview must not be
  // published after the final output and leave stale output on a finished tool.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const f = await throttledRuntime(
      (input) =>
        (async function* () {
          yield event(input, 'tool_started', { turnId: input.turnId, toolCallId: 'cmd', tool: 'Bash', input: {} })
          for (const output of ['first\n', 'second\n']) {
            yield event(input, 'tool_output', {
              turnId: input.turnId,
              toolUseId: 'cmd',
              output,
              outputMode: 'append',
              partial: true,
            })
          }
          yield event(input, 'tool_output', {
            turnId: input.turnId,
            toolUseId: 'cmd',
            output: 'x'.repeat(4 * 1024 * 1024),
            outputMode: 'append',
          })
          yield event(input, 'turn_completed', { turnId: input.turnId })
        })(),
      1,
    )
    try {
      await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'build' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const outputs = f.published.filter((value) => value.type === 'tool_output')
      assert.equal(outputs.at(-1)?.payload?.partial, undefined, 'the final output is the last one published')
    } finally {
      await f.cleanup()
    }
  }
})

test('a long-running tool writes a preview only every preview interval, and its final output at the end', async () => {
  const chunks = Array.from({ length: 120 }, (_, index) => `line ${index} ${'.'.repeat(100)}\n`)
  const f = await throttledRuntime((input) =>
    (async function* () {
      yield event(input, 'tool_started', { turnId: input.turnId, toolCallId: 'cmd', tool: 'Bash', input: {} })
      for (const output of chunks) {
        yield event(input, 'tool_output', {
          turnId: input.turnId,
          toolUseId: 'cmd',
          output,
          outputMode: 'append',
          partial: true,
        })
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      yield event(input, 'tool_output', { turnId: input.turnId, toolUseId: 'cmd', output: '', outputMode: 'append' })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    })(),
  )
  try {
    const began = Date.now()
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'build' })
    const elapsed = Date.now() - began
    const previews = f.published.filter((value) => value.type === 'tool_output' && value.payload?.partial === true)
    const onDisk = await f.persistedPreviews()
    assert.equal(onDisk.length, previews.length, 'every published preview is on disk')
    assert.ok(
      previews.length <= Math.ceil(elapsed / 250) + 1,
      `${previews.length} previews in ${elapsed} ms, at most one per interval`,
    )
    const final = f.published.filter((value) => value.type === 'tool_output').at(-1)!
    assert.equal(final.payload?.partial, undefined)
    assert.equal(final.payload?.preview, chunks.join('').slice(-4000))
    const detail = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'cmd' })
    assert.ok(detail.ok)
    assert.equal(detail.detail.output, chunks.join(''), 'every held-back chunk is still in the detail')
  } finally {
    await f.cleanup()
  }
})

test('a running preview that shows nothing new is not written again', async () => {
  const f = await throttledRuntime((input) =>
    (async function* () {
      yield event(input, 'tool_started', { turnId: input.turnId, toolCallId: 'acp', tool: 'Bash', input: {} })
      for (let index = 0; index < 4; index++) {
        yield event(input, 'tool_output', { turnId: input.turnId, toolUseId: 'acp', output: 'same', partial: true })
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      yield event(input, 'tool_output', { turnId: input.turnId, toolUseId: 'acp', output: 'same, done' })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    })(),
  )
  try {
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'ls' })
    assert.equal((await f.persistedPreviews()).length, 1)
    const outputs = f.published.filter((value) => value.type === 'tool_output')
    assert.deepEqual(
      outputs.map((value) => value.payload?.preview),
      ['same', 'same, done'],
    )
  } finally {
    await f.cleanup()
  }
})

test('a chat’s prompt cache survives a restart: resumed from the transcript, it goes cold when it really did', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-cache-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const path = workspaceStorePath(workspaceRoot, 'conversations', 'workspace', 'agent.jsonl')
  const envelope = { ...key, sessionId: 'old', providerId: 'mock-provider', modelId: 'mock-model' }
  const at = 1_700_000_000_000
  const lines = [
    { ...event(envelope, 'session_started', { providerSessionId: 'native-1' }), id: 'e0', seq: 1 },
    { ...event(envelope, 'user_message', { turnId: 't0', text: 'Question' }), id: 'u0', seq: 2 },
    {
      ...event(envelope, 'usage_updated', {
        turnId: 't0',
        promptCache: { ttl: '1h', cached: true, recacheTokens: 310_000 },
      }),
      id: 'p0',
      seq: 3,
      createdAt: at,
    },
    { ...event(envelope, 'turn_completed', { turnId: 't0' }), id: 'c0', seq: 4, createdAt: at + 5_000 },
  ]
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  try {
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    // One lifetime after the request was seen to start — the transcript's
    // time, not the resume's.
    assert.deepEqual(started.session.promptCache, { ttl: '1h', expiresAt: at + 60 * 60_000, recacheTokens: 310_000 })
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test("a turn left open when its chat's server stopped shows as interrupted, and the server's own log replaces it once back", async () => {
  const key = { workspaceRoot: '/home/dev/repo', workspaceId: 'workspace', agentId: 'agent' }
  const base = {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    createdAt: 1,
  }
  const asked: Array<{ afterSeq?: number; generation?: string }> = []
  let resumed: (key: string) => void = () => undefined
  let lost: (key: string, message: string) => void = () => undefined
  const routed = {
    onEvent: () => () => undefined,
    recoverTranscript: async () => undefined,
    readConversationSync: async (_key: unknown, input: { afterSeq?: number; generation?: string }) => {
      asked.push(input)
      if (asked.length === 1)
        return {
          ok: true,
          kind: 'events',
          head: 2,
          generation: 'g1',
          events: [
            { ...base, id: 'e1', seq: 1, type: 'user_message', payload: { turnId: 't1', text: 'go' } },
            { ...base, id: 'e2', seq: 2, type: 'turn_started', payload: { turnId: 't1' } },
          ],
        }
      return { ok: true, kind: 'snapshot', head: 3, generation: 'g1', page: { events: [], hasMore: false } }
    },
    routeOf: () => 'Ubuntu',
    onRouteResumed: (listener: (key: string) => void) => {
      resumed = listener
      return () => undefined
    },
    onRouteLost: (listener: (key: string, message: string) => void) => {
      lost = listener
      return () => undefined
    },
  }
  const api = new ConversationSessionApi(routed as never)
  const frames: ConversationSessionFrame[] = []
  const subscription = api.subscribe({ key, afterSeq: 0, generation: 'g1' }, (frame) => frames.push(frame))
  await subscription.ready
  frames.length = 0

  lost('Debian', 'another distribution')
  assert.equal(frames.length, 0, "another server's loss is not this chat's")
  lost('Ubuntu', 'The Studio server in Ubuntu stopped while this turn was running.')
  assert.equal(frames.length, 1)
  const closed = frames[0].type === 'event' ? frames[0].event : null
  assert.equal(closed?.type, 'turn_failed')
  assert.equal(closed?.seq, 3)
  assert.deepEqual(closed?.payload, {
    turnId: 't1',
    reason: 'interrupted',
    message: 'The Studio server in Ubuntu stopped while this turn was running.',
  })
  lost('Ubuntu', 'again')
  assert.equal(frames.length, 1, 'a turn is closed once')

  // Back: a reset snapshot from the log, which the restarted server closed
  // in its own words, rather than events after a turn this side closed.
  resumed('Ubuntu')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(asked.at(-1), { afterSeq: 2, generation: undefined, turnLimit: undefined })
  const snapshot = frames.find((frame) => frame.type === 'snapshot')
  assert.ok(snapshot && snapshot.type === 'snapshot' && snapshot.reset === true)
  subscription.dispose()
})
