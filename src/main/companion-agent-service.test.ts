import assert from 'node:assert/strict'
import { workspaceStorePath } from './workspace-store'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConversationRuntime } from './conversation-runtime'
import {
  createCompanionAgentService,
  companionAgentIdFor,
  createCompanionAgentsModuleRegistry,
  extractJson,
  redactEvent,
  CompanionValidationError,
  type CompanionAgentService,
} from './companion-agent-service'
import {
  createMockConversationProvider,
  type ConversationProviderAdapter,
  type MockAdapterSessionInput,
  type MockAdapterTurnInput,
} from './providers/mock-conversation-provider'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import type { ProviderSecretStore } from './secret-store'
import { test } from 'vitest'

test('companion-agent-service', async () => {
  async function main(): Promise<void> {
    await testAttachIsAbsentAndDoesNotSpawn()
    await testFirstRunStructuredSpawnsAndResolvesTyped()
    await testSystemPromptPreambleDeliveredOnce()
    await testInvalidThenValidRetriesOnce()
    await testInvalidTwiceRejectsWithValidatorErrors()
    await testInterruptLeavesSessionReusable()
    await testSecondRunInterruptsFirst()
    await testDisposeEndsSessionAndReattachWorks()
    await testSameKeyAttachReturnsSameHandle()
    await testMockProviderApprovalIsAutoResolvedForStructuredRun()
    await testColdLoadPersistedRecordDoesNotSpawnUntilIntent()
    await testEventStreamHasNoSecrets()
    await testModuleRegistryEnforcesCompanionPermission()
    await testModuleRegistryNamespacesAgentIdsByModule()
    await testEventsBeforeTheCompanionSessionStartsNeverLeak()
    testExtractJsonVariants()

    console.log('companion-agent-service tests passed')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function ev(
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

  // An autonomous companion provider: each turn completes on its own with the
  // next scripted response as content (no approval card). Mirrors a companion
  // session running with an autonomous permission posture.
  function scriptedProvider(script: { responses: string[]; seenMessages: string[] }): ConversationProviderAdapter {
    let turn = 0
    return {
      id: 'companion-mock',
      listModels: () => ['companion-model'],
      startSession: (input) => [ev(input, 'session_started'), ev(input, 'session_ready')],
      sendTurn: (input: MockAdapterTurnInput) => {
        script.seenMessages.push(input.message)
        const text = script.responses[Math.min(turn, script.responses.length - 1)] ?? ''
        turn += 1
        return [
          ev(input, 'turn_started', { turnId: input.turnId }),
          ev(input, 'content_delta', { turnId: input.turnId, text }),
          ev(input, 'turn_completed', { turnId: input.turnId }),
        ]
      },
      resolveApproval: () => [],
      interrupt: (input) => [ev(input, 'turn_failed', { reason: 'interrupted' })],
      stopSession: (input) => [ev(input, 'session_closed')],
    }
  }

  // A gated provider: sendTurn streams turn_started, then blocks until released,
  // so a turn can be interrupted mid-flight.
  function gatedProvider(gate: { promise: Promise<void> }): ConversationProviderAdapter {
    return {
      id: 'companion-mock',
      listModels: () => ['companion-model'],
      startSession: (input) => [ev(input, 'session_started'), ev(input, 'session_ready')],
      async *sendTurn(input: MockAdapterTurnInput) {
        yield ev(input, 'turn_started', { turnId: input.turnId })
        await gate.promise
        yield ev(input, 'content_delta', { turnId: input.turnId, text: '{"done":true}' })
        yield ev(input, 'turn_completed', { turnId: input.turnId })
      },
      resolveApproval: () => [],
      interrupt: (input) => [ev(input, 'turn_failed', { reason: 'interrupted' })],
      stopSession: (input) => [ev(input, 'session_closed')],
    }
  }

  function unusedSecretStore(): Pick<ProviderSecretStore, 'getStatus'> &
    Partial<Pick<ProviderSecretStore, 'resolveSecret'>> {
    return {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    }
  }

  function companionRuntime(adapter: ConversationProviderAdapter): ConversationRuntime {
    return new ConversationRuntime({
      adapters: [adapter],
      getProviderById: () => undefined,
      secretStore: unusedSecretStore(),
    })
  }

  function companionService(runtime: ConversationRuntime): CompanionAgentService {
    return createCompanionAgentService({
      runtime,
      resolveEngineDefaults: () => ({ providerId: 'companion-mock', modelId: 'companion-model' }),
    })
  }

  const SPEC_BASE = {
    workspaceId: 'workspace',
    agentId: 'review-guide',
    name: 'Review Guide',
    systemPrompt: 'You are the review guide.',
  }

  function createDeferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void
    const promise = new Promise<void>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  function okSessions<T>(result: { ok: true; sessions: T[] } | { ok: false; message: string }): T[] {
    if (!result.ok) throw new Error(result.message)
    return result.sessions
  }

  // ── Tests ────────────────────────────────────────────────────────────────────

  async function testAttachIsAbsentAndDoesNotSpawn(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = companionRuntime(scriptedProvider({ responses: [], seenMessages: [] }))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })
      assert.equal(handle.status(), 'absent')
      assert.deepEqual(runtime.listSessions({ workspaceId: 'workspace' }).ok, true)
      assert.equal(okSessions(runtime.listSessions({ workspaceId: 'workspace' })).length, 0)
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testFirstRunStructuredSpawnsAndResolvesTyped(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = companionRuntime(
        scriptedProvider({ responses: ['{"score": 42, "label": "ok"}'], seenMessages: [] }),
      )
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      const statuses: string[] = []
      handle.onStatus((status) => statuses.push(status))

      const value = await handle.runStructured<{ score: number; label: string }>({
        prompt: 'Rate it.',
        validate: (raw) => {
          const record = raw as { score?: unknown; label?: unknown }
          if (typeof record.score === 'number' && typeof record.label === 'string') {
            return { ok: true, value: { score: record.score, label: record.label } }
          }
          return { ok: false, errors: ['score/label missing'] }
        },
      })
      assert.deepEqual(value, { score: 42, label: 'ok' })
      assert.equal(handle.status(), 'ready')
      // onStatus fired an initial 'absent' then moved to a live status.
      assert.equal(statuses[0], 'absent')
      assert.ok(statuses.includes('ready'))
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testSystemPromptPreambleDeliveredOnce(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const script = { responses: ['{"ok":true}', '{"ok":true}'], seenMessages: [] as string[] }
      const runtime = companionRuntime(scriptedProvider(script))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      const validate = (raw: unknown) => ({ ok: true as const, value: raw })
      await handle.runStructured({ prompt: 'First.', validate })
      await handle.runStructured({ prompt: 'Second.', validate })

      assert.equal(script.seenMessages.length, 2)
      // Preamble rides the first turn only.
      assert.ok(script.seenMessages[0].includes('You are the review guide.'))
      assert.ok(script.seenMessages[0].includes('First.'))
      assert.equal(script.seenMessages[1].includes('You are the review guide.'), false)
      assert.ok(script.seenMessages[1].includes('Second.'))
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testInvalidThenValidRetriesOnce(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const script = { responses: ['not json at all', '{"ok": true}'], seenMessages: [] as string[] }
      const runtime = companionRuntime(scriptedProvider(script))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      const phases: string[] = []
      const value = await handle.runStructured<{ ok: boolean }>({
        prompt: 'Answer.',
        onPhase: (phase) => phases.push(phase),
        validate: (raw) => {
          const record = raw as { ok?: unknown }
          return record.ok === true ? { ok: true, value: { ok: true } } : { ok: false, errors: ['expected ok=true'] }
        },
      })
      assert.deepEqual(value, { ok: true })
      assert.equal(script.seenMessages.length, 2)
      // The retry prompt carries the validator error back to the agent.
      assert.ok(script.seenMessages[1].includes('could not be accepted'))
      assert.ok(phases.includes('retrying'))
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testInvalidTwiceRejectsWithValidatorErrors(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const script = { responses: ['{"ok": false}', '{"ok": false}'], seenMessages: [] as string[] }
      const runtime = companionRuntime(scriptedProvider(script))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      await assert.rejects(
        handle.runStructured({
          prompt: 'Answer.',
          validate: (raw) => {
            const record = raw as { ok?: unknown }
            return record.ok === true ? { ok: true, value: record } : { ok: false, errors: ['expected ok=true'] }
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CompanionValidationError)
          assert.deepEqual(error.errors, ['expected ok=true'])
          return true
        },
      )
      // Default retries = 1, so exactly two attempts.
      assert.equal(script.seenMessages.length, 2)
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testInterruptLeavesSessionReusable(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const gate = createDeferred()
      const runtime = companionRuntime(gatedProvider(gate))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      const events: string[] = []
      handle.onEvent((event) => events.push(event.type))

      const runPromise = handle.runStructured({ prompt: 'Slow.', validate: (raw) => ({ ok: true, value: raw }) })
      await waitFor(() => events.includes('turn_started'))
      handle.interrupt()
      gate.resolve()
      await assert.rejects(runPromise)

      const sessionIdAfterInterrupt = okSessions(runtime.listSessions({ workspaceId: 'workspace' }))[0]?.sessionId

      // The session survives: a new run reuses the same session and completes.
      const gate2 = createDeferred()
      gate2.resolve()
      const value = await handle.runStructured({ prompt: 'Again.', validate: (raw) => ({ ok: true, value: raw }) })
      assert.deepEqual(value, { done: true })
      const sessionIdAfterReuse = okSessions(runtime.listSessions({ workspaceId: 'workspace' }))[0]?.sessionId
      assert.equal(sessionIdAfterReuse, sessionIdAfterInterrupt)
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testSecondRunInterruptsFirst(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const gate = createDeferred()
      const runtime = companionRuntime(gatedProvider(gate))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      const events: string[] = []
      handle.onEvent((event) => events.push(event.type))

      const first = handle.runStructured({ prompt: 'First.', validate: (raw) => ({ ok: true, value: raw }) })
      await waitFor(() => events.includes('turn_started'))
      // A second concurrent run interrupts the first.
      const second = handle.runStructured({ prompt: 'Second.', validate: (raw) => ({ ok: true, value: raw }) })
      await assert.rejects(first)
      gate.resolve()
      const value = await second
      assert.deepEqual(value, { done: true })
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testDisposeEndsSessionAndReattachWorks(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = companionRuntime(
        scriptedProvider({ responses: ['{"ok":true}', '{"ok":true}'], seenMessages: [] }),
      )
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })
      await handle.runStructured({ prompt: 'Go.', validate: (raw) => ({ ok: true, value: raw }) })
      const firstSessionId = okSessions(runtime.listSessions({ workspaceId: 'workspace' }))[0]?.sessionId
      assert.ok(firstSessionId)

      handle.dispose()
      assert.equal(handle.status(), 'absent')
      // The underlying session is stopped (best-effort, next tick).
      await waitFor(() => okSessions(runtime.listSessions({ workspaceId: 'workspace' }))[0]?.status === 'stopped')

      // Re-attach after dispose works and spawns a fresh session.
      const reattached = service.attach({ ...SPEC_BASE, workspaceRoot })
      assert.equal(reattached.status(), 'absent')
      await reattached.runStructured({ prompt: 'Again.', validate: (raw) => ({ ok: true, value: raw }) })
      const secondSessionId = okSessions(runtime.listSessions({ workspaceId: 'workspace' })).find(
        (session) => session.status !== 'stopped',
      )?.sessionId
      assert.ok(secondSessionId)
      assert.notEqual(secondSessionId, firstSessionId)
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testSameKeyAttachReturnsSameHandle(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = companionRuntime(scriptedProvider({ responses: [], seenMessages: [] }))
      const service = companionService(runtime)
      const a = service.attach({ ...SPEC_BASE, workspaceRoot })
      const b = service.attach({ ...SPEC_BASE, workspaceRoot })
      assert.equal(a, b)
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // The canonical mock-conversation-provider ends its turn at an approval card
  // (stateless). A structured run with `tools: 'auto'` approves it, and the
  // turn reaches turn_completed. The mock's content is not JSON, so validation
  // then fails — which is exactly how we observe the auto-approve drove the
  // stateless turn to completion. (The default, `none`, denies it instead:
  // companion-agent-service.tools.test.ts.)
  async function testMockProviderApprovalIsAutoResolvedForStructuredRun(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = new ConversationRuntime({
        adapters: [createMockConversationProvider()],
        getProviderById: () => undefined,
        secretStore: unusedSecretStore(),
      })
      const service = createCompanionAgentService({
        runtime,
        resolveEngineDefaults: () => ({ providerId: 'mock-provider', modelId: 'mock-model' }),
      })
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })
      const events: string[] = []
      handle.onEvent((event) => events.push(event.type))

      await assert.rejects(
        handle.runStructured({ prompt: 'Anything.', tools: 'auto', validate: () => ({ ok: false, errors: ['n/a'] }) }),
        (error: unknown) => error instanceof CompanionValidationError,
      )
      // The approval was auto-resolved and the turn completed.
      assert.ok(events.includes('approval_requested'))
      assert.ok(events.includes('approval_resolved'))
      assert.ok(events.includes('turn_completed'))
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A persisted companion transcript on disk must NOT auto-spawn on attach; status
  // stays 'absent' until a live intent. Mirrors resolveAgentColdLoadDecision.
  async function testColdLoadPersistedRecordDoesNotSpawnUntilIntent(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      // Seed a prior run's transcript for this companion (a persisted record).
      const dir = workspaceStorePath(workspaceRoot, 'conversations', 'workspace')
      await mkdir(dir, { recursive: true })
      const prior = [
        {
          id: 'p1',
          sessionId: 'conv_old',
          workspaceId: 'workspace',
          agentId: 'review-guide',
          providerId: 'companion-mock',
          modelId: 'companion-model',
          type: 'session_started',
          createdAt: 1,
          payload: {},
        },
      ]
      await writeFile(
        join(dir, 'review-guide.jsonl'),
        prior.map((event) => JSON.stringify(event)).join('\n') + '\n',
        'utf-8',
      )

      const runtime = companionRuntime(scriptedProvider({ responses: ['{"ok":true}'], seenMessages: [] }))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })

      // Reopened cold: no session spawned, status absent.
      assert.equal(handle.status(), 'absent')
      assert.equal(okSessions(runtime.listSessions({ workspaceId: 'workspace' })).length, 0)

      // First live intent spawns.
      await handle.runStructured({ prompt: 'Go.', validate: (raw) => ({ ok: true, value: raw }) })
      assert.equal(okSessions(runtime.listSessions({ workspaceId: 'workspace' })).length, 1)
      assert.equal(handle.status(), 'ready')
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testEventStreamHasNoSecrets(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const leakyProvider: ConversationProviderAdapter = {
        id: 'companion-mock',
        listModels: () => ['companion-model'],
        startSession: (input) => [ev(input, 'session_started'), ev(input, 'session_ready')],
        sendTurn: (input: MockAdapterTurnInput) => [
          ev(input, 'turn_started', { turnId: input.turnId }),
          ev(input, 'tool_output', {
            turnId: input.turnId,
            apiKey: 'sk-super-secret',
            authorization: 'Bearer abc',
            note: 'safe',
          }),
          ev(input, 'content_delta', { turnId: input.turnId, text: '{"ok":true}' }),
          ev(input, 'turn_completed', { turnId: input.turnId }),
        ],
        resolveApproval: () => [],
        interrupt: (input) => [ev(input, 'turn_failed', { reason: 'interrupted' })],
        stopSession: (input) => [ev(input, 'session_closed')],
      }
      const runtime = companionRuntime(leakyProvider)
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })
      const forwarded: ConversationEvent[] = []
      handle.onEvent((event) => forwarded.push(event))

      await handle.runStructured({ prompt: 'Go.', validate: (raw) => ({ ok: true, value: raw }) })

      const serialized = JSON.stringify(forwarded)
      assert.equal(serialized.includes('sk-super-secret'), false)
      assert.equal(serialized.includes('Bearer abc'), false)
      assert.ok(serialized.includes('[redacted]'))
      assert.ok(serialized.includes('safe'))
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // The moduleId-scoped registry (what the SDK's getCompanionAgentsService
  // resolves) must refuse a module that did not declare `agents:companion`, and
  // admit one that did.
  async function testModuleRegistryEnforcesCompanionPermission(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = companionRuntime(scriptedProvider({ responses: [], seenMessages: [] }))
      const service = companionService(runtime)
      const permissionsByModule: Record<string, string[]> = {
        'with-perm': ['agents:companion'],
        'no-perm': ['network'],
      }
      const registry = createCompanionAgentsModuleRegistry({
        service,
        getModulePermissions: (moduleId) => permissionsByModule[moduleId],
      })
      const spec = { ...SPEC_BASE, workspaceRoot }

      assert.throws(() => registry.attach('no-perm', spec), /must declare the "agents:companion" permission/)
      assert.throws(() => registry.attach('unknown-module', spec), /agents:companion/)
      const handle = registry.attach('with-perm', spec)
      assert.equal(handle.status(), 'absent')
      service.dispose()
      // A finished turn refreshes the thread index in the background.
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A module picks its companion's id; the registry runs it inside that
  // module's namespace, so two modules picking the same id get two agents.
  async function testModuleRegistryNamespacesAgentIdsByModule(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    try {
      const runtime = companionRuntime(scriptedProvider({ responses: [], seenMessages: [] }))
      const service = companionService(runtime)
      const registry = createCompanionAgentsModuleRegistry({
        service,
        getModulePermissions: () => ['agents:companion'],
      })
      const spec = { ...SPEC_BASE, workspaceRoot }
      const reviews = registry.attach('reviews', spec)
      const calendar = registry.attach('calendar', spec)
      assert.equal(reviews.agentId, 'companion-reviews-review-guide')
      assert.equal(calendar.agentId, 'companion-calendar-review-guide')
      assert.equal(companionAgentIdFor('reviews', 'review-guide'), reviews.agentId)
      assert.notEqual(reviews, calendar, 'two modules, two companions')
      assert.equal(registry.attach('reviews', spec), reviews, 'the same module and id is the same companion')
      service.dispose()
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Before its own session exists, a companion hears nothing on its key: not
  // a session left from an earlier run being retired as it starts, and not
  // that earlier session's events. Its own session's first events, emitted
  // before startSession answered with its id, still arrive once it has.
  async function testEventsBeforeTheCompanionSessionStartsNeverLeak(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-'))
    const otherRoot = await mkdtemp(join(tmpdir(), 'companion-other-'))
    try {
      const runtime = companionRuntime(scriptedProvider({ responses: ['{"ok":true}'], seenMessages: [] }))
      const service = companionService(runtime)
      const handle = service.attach({ ...SPEC_BASE, workspaceRoot })
      const seen: ConversationEvent[] = []
      handle.onEvent((event) => seen.push(event))

      // A session on the same key that is not the companion's.
      const stray = await runtime.startSession({
        workspaceRoot: otherRoot,
        workspaceId: SPEC_BASE.workspaceId,
        agentId: SPEC_BASE.agentId,
        providerId: 'companion-mock',
        modelId: 'companion-model',
      })
      assert.ok(stray.ok)
      assert.equal(seen.length, 0, 'nothing reaches a companion before its own session exists')

      await handle.runStructured({ prompt: 'go', validate: (raw) => ({ ok: true, value: raw }) })
      const own = okSessions(
        runtime.listSessions({ workspaceId: SPEC_BASE.workspaceId, agentId: SPEC_BASE.agentId }),
      ).find((session) => session.status !== 'stopped')
      assert.ok(own)
      assert.notEqual(own.sessionId, stray.session.sessionId)
      assert.ok(seen.length > 0)
      assert.ok(
        seen.every((event) => event.sessionId === own.sessionId),
        "every event delivered is the companion session's own",
      )
      assert.ok(
        seen.some((event) => event.type === 'session_started'),
        'its own start, emitted before startSession answered, is delivered',
      )
      service.dispose()
      await runtime.shutdown()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
      await rm(otherRoot, { recursive: true, force: true })
    }
  }

  function testExtractJsonVariants(): void {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
    assert.deepEqual(extractJson('prose before {"a":1,"b":"x"} prose after'), { a: 1, b: 'x' })
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
    assert.deepEqual(extractJson('first ```json\n{"a":1}\n``` then ```json\n{"a":2}\n```'), { a: 2 })
    assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3])
    assert.equal(extractJson('no json here'), undefined)
    assert.equal(extractJson(''), undefined)
    // redactEvent leaves payload-free events untouched.
    const bare: ConversationEvent = {
      id: 'x',
      sessionId: 's',
      workspaceId: 'w',
      agentId: 'a',
      providerId: 'p',
      modelId: 'm',
      type: 'session_ready',
      createdAt: 0,
    }
    assert.equal(redactEvent(bare), bare)
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
