import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type { ConversationAttachmentStore } from './conversation-attachment-store'
import type { ConversationSkillsResolver } from './conversation-skills'
import type {
  ConversationProviderAdapter,
  ConversationProviderCursor,
  MockAdapterSessionInput,
} from './providers/conversation-provider-adapter'
import type { ConversationCapabilities, ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CAPABILITIES: ConversationCapabilities = {
  tools: true,
  approvals: true,
  questions: false,
  planMode: false,
  images: false,
  skills: 'none',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: false,
  cost: true,
  contextMeter: false,
  liveModelSwitch: false,
  steer: true,
  rewind: true,
}

function event(input: MockAdapterSessionInput, type: ConversationEventType, payload?: object): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload: payload as ConversationEvent['payload'],
  }
}

// The delay the runtime asks a busy send to wait before it is sent again.
const TURN_BUSY_RETRY = 1_000

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await tick()
  assert.ok(condition(), `timed out waiting for ${what}`)
}

type Stream = { push: (event: ConversationEvent) => void; end: () => void }

/**
 * A stateful provider holding one stream per send, driven from the test. Its
 * events are stamped with the turn they were sent for, as a real provider's
 * are; a steer only records the message (and may raise something as it lands).
 */
function steeringProvider(options: { steer?: boolean; cursor?: ConversationProviderCursor } = {}) {
  const streams = new Map<string, Stream>()
  const steers: Array<{ turnId: string; message: string }> = []
  const resolved: string[] = []
  const rewinds: Array<ConversationProviderCursor | null> = []
  const record = {
    base: null as MockAdapterSessionInput | null,
    onSteer: null as ((turnId: string) => void) | null,
    refuse: null as string | null,
  }
  let entries = 0
  const adapter: ConversationProviderAdapter = {
    id: 'steering',
    sessions: 'stateful',
    capabilities: { ...CAPABILITIES, steer: options.steer !== false },
    listModels: () => ['model'],
    startSession: (input) => {
      record.base = input
      return [event(input, 'session_started'), event(input, 'session_ready')]
    },
    async *sendTurn(input) {
      yield event(input, 'turn_started', { turnId: input.turnId })
      const buffered: ConversationEvent[] = []
      let wake: (() => void) | null = null
      let ended = false
      streams.set(input.turnId, {
        push: (next) => {
          buffered.push(next)
          wake?.()
        },
        end: () => {
          ended = true
          wake?.()
        },
      })
      while (!ended || buffered.length) {
        if (!buffered.length) await new Promise<void>((resolve) => (wake = resolve))
        while (buffered.length) yield buffered.shift()!
      }
    },
    resolveApproval: (input) => {
      resolved.push(input.requestId)
      return []
    },
    interrupt: () => [],
    stopSession: () => [],
    rewind: async (input) => {
      rewinds.push(input.cursor)
      return { ok: true }
    },
  }
  if (options.steer !== false)
    adapter.steer = async (input) => {
      if (!streams.has(input.turnId)) return { ok: false, message: 'The provider has no such turn.' }
      if (record.refuse) return { ok: false, message: record.refuse }
      steers.push({ turnId: input.turnId, message: input.message })
      record.onSteer?.(input.turnId)
      return { ok: true, ...(options.cursor ? { providerCursor: options.cursor } : {}) }
    }
  // Play an event out of the stream sent as `turnId`, stamped as that turn's.
  const emit = (turnId: string, type: ConversationEventType, payload: object = {}) =>
    streams.get(turnId)!.push(event(record.base!, type, { turnId, ...payload }))
  // End the stream as a real turn does: with its result, cost and cursor.
  const finish = (turnId: string, payload: object = {}) => {
    emit(turnId, 'turn_completed', {
      providerCursor: { sessionId: 'provider-1', at: `entry-${++entries}` },
      ...payload,
    })
    streams.get(turnId)!.end()
  }
  return { adapter, streams, steers, resolved, rewinds, record, emit, finish }
}

async function setup(
  options: {
    steer?: boolean
    cursor?: ConversationProviderCursor
    attachmentStore?: ConversationAttachmentStore
    resolveSkills?: ConversationSkillsResolver
  } = {},
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-steer-'))
  roots.add(workspaceRoot)
  const provider = steeringProvider(options)
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    ...(options.attachmentStore ? { attachmentStore: options.attachmentStore } : {}),
    ...(options.resolveSkills ? { resolveSkills: options.resolveSkills } : {}),
  })
  runtimes.add(runtime)
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'steering', modelId: 'model' })
  assert.ok(started.ok)
  const sessionId = started.session.sessionId
  const events: ConversationEvent[] = []
  runtime.onEvent((next) => events.push(next))
  const summary = () => {
    const listed = runtime.listSessions({ workspaceId: 'workspace' })
    return listed.ok ? listed.sessions[0] : undefined
  }
  // Send a message and wait until the provider holds its stream; returns the turn it was sent as.
  const sendRunning = async (message: string) => {
    const before = provider.streams.size
    const settled = runtime.sendTurn({ sessionId, message })
    await until(() => provider.streams.size > before, 'the provider to take the turn')
    return { turnId: Array.from(provider.streams.keys()).at(-1)!, settled }
  }
  const landed = (text: string) =>
    events.find((next) => next.type === 'user_message' && next.payload?.text === text)?.payload?.turnId as string
  return { runtime, provider, key, sessionId, events, summary, sendRunning, landed }
}

test('a steer ends the running turn where its message lands, and the same stream carries on as the next turn', async () => {
  const chat = await setup({ cursor: { sessionId: 'provider-1', at: 'entry-mid' } })
  const first = await chat.sendRunning('investigate')
  chat.provider.emit(first.turnId, 'content_delta', { text: 'Reading the config' })
  chat.provider.emit(first.turnId, 'tool_started', { toolUseId: 'tool-1', name: 'Bash', kind: 'shell' })
  await until(() => chat.events.some((next) => next.type === 'tool_started'), 'the tool to start')

  let steerSettled = false
  const steer = chat.runtime
    .sendTurn({ sessionId: chat.sessionId, message: 'use the staging file', localTurnId: 'local-2', steer: true })
    .finally(() => (steerSettled = true))
  await until(() => Boolean(chat.landed('use the staging file')), 'the steered message to land')
  const steeredTurnId = chat.landed('use the staging file')
  assert.deepEqual(chat.provider.steers, [{ turnId: first.turnId, message: 'use the staging file' }])
  assert.equal(chat.provider.streams.size, 1, 'no second provider turn was started')

  // The rest of the stream is the steered turn's, even though the provider
  // still stamps it as the turn it was sent for.
  chat.provider.emit(first.turnId, 'tool_output', { toolUseId: 'tool-1', output: 'ok' })
  chat.provider.emit(first.turnId, 'content_delta', { text: 'Switching to staging' })
  await until(() => chat.events.filter((next) => next.type === 'content_delta').length === 2, 'the reply')
  assert.equal(chat.summary()?.status, 'active')
  await tick()
  assert.equal(steerSettled, false, 'a steer settles with the turn it opened')
  chat.provider.finish(first.turnId, { costUsd: 0.3 })
  assert.equal((await steer).ok, true)
  assert.equal((await first.settled).ok, true)

  const turnEvents = chat.events
    .filter((next) => next.type !== 'session_updated')
    .map((next) => [next.type, next.payload?.turnId === first.turnId ? 'first' : 'steered'])
  assert.deepEqual(turnEvents, [
    ['user_message', 'first'],
    ['turn_started', 'first'],
    ['content_delta', 'first'],
    ['tool_started', 'first'],
    ['turn_completed', 'first'],
    ['user_message', 'steered'],
    ['turn_started', 'steered'],
    ['tool_output', 'steered'],
    ['content_delta', 'steered'],
    ['turn_completed', 'steered'],
  ])
  const ends = chat.events.filter((next) => next.type === 'turn_completed')
  assert.deepEqual(ends[0].payload, {
    turnId: first.turnId,
    steered: true,
    providerCursor: { sessionId: 'provider-1', at: 'entry-mid' },
  })
  assert.equal(ends[1].payload?.turnId, steeredTurnId)
  assert.equal(ends[1].payload?.costUsd, 0.3, 'the cost of the whole stream is the turn that ends it')
  assert.equal(chat.landed('use the staging file'), steeredTurnId)
  assert.equal(
    chat.events.find((next) => next.type === 'user_message' && next.payload?.turnId === steeredTurnId)?.payload
      ?.localTurnId,
    'local-2',
  )
  assert.equal(chat.summary()?.status, 'ready')

  // The session is free for an ordinary send, which is a stream of its own.
  const next = await chat.sendRunning('thanks')
  assert.notEqual(next.turnId, first.turnId)
  chat.provider.finish(next.turnId)
  assert.equal((await next.settled).ok, true)
})

test('a card raised as a steer lands belongs to the steered turn and can still be answered', async () => {
  const chat = await setup()
  const first = await chat.sendRunning('investigate')
  // The child asks for a permission just as the message goes in.
  chat.provider.record.onSteer = (turnId) =>
    chat.provider.emit(turnId, 'approval_requested', { requestId: 'approval_x', action: 'Bash', summary: 'Run tests' })
  const steer = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'also lint', steer: true })
  await until(() => chat.events.some((next) => next.type === 'approval_requested'), 'the card')
  const steeredTurnId = chat.landed('also lint')
  const card = chat.events.find((next) => next.type === 'approval_requested')!
  assert.equal(card.payload?.turnId, steeredTurnId)
  assert.equal(card.payload?.requestId, 'approval_x')
  assert.equal(chat.summary()?.status, 'awaiting_approval')

  assert.equal(
    (await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'approval_x', approved: true })).ok,
    true,
  )
  assert.deepEqual(chat.provider.resolved, ['approval_x'])
  chat.provider.emit(first.turnId, 'approval_resolved', { requestId: 'approval_x', approved: true })
  chat.provider.finish(first.turnId)
  assert.equal((await steer).ok, true)
  assert.equal(chat.events.find((next) => next.type === 'approval_resolved')?.payload?.turnId, steeredTurnId)
  assert.equal(chat.summary()?.status, 'ready')
})

test('a steer that a card overtakes on its way in waits behind the card, which stays answerable', async () => {
  // The steer passes the first look at the session, then waits on its skills
  // while the agent raises a card.
  const hold = { gate: null as Promise<void> | null }
  const chat = await setup({
    resolveSkills: async () => {
      await hold.gate
      return { ids: [], context: '' }
    },
  })
  const first = await chat.sendRunning('investigate')
  let release: () => void = () => undefined
  hold.gate = new Promise<void>((resolve) => (release = resolve))
  const steer = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'and lint', steer: true })
  await tick()
  chat.provider.emit(first.turnId, 'approval_requested', { requestId: 'approval_y', action: 'Bash', summary: 'Deploy' })
  await until(() => chat.summary()?.status === 'awaiting_approval', 'the card')
  release()
  assert.deepEqual(await steer, {
    ok: false,
    code: 'busy',
    retryAfterMs: TURN_BUSY_RETRY,
    message: 'Conversation turn is awaiting approval.',
  })
  assert.deepEqual(chat.provider.steers, [])
  assert.equal(chat.events.filter((next) => next.type === 'user_message').length, 1, 'nothing was written')
  assert.equal(chat.events.find((next) => next.type === 'approval_requested')?.payload?.turnId, first.turnId)
  assert.equal(
    (await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'approval_y', approved: true })).ok,
    true,
  )
  chat.provider.emit(first.turnId, 'approval_resolved', { requestId: 'approval_y', approved: true })
  chat.provider.finish(first.turnId)
  assert.equal((await first.settled).ok, true)
  assert.equal(chat.summary()?.status, 'ready')
})

test('a steer is refused until the running turn has reached the provider, and after the provider ended it', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  // Saving the first message's images holds the turn before the provider has it.
  const attachmentStore = {
    save: async () => {
      await gate
      return []
    },
    read: async () => ({ ok: false as const, message: 'unused' }),
    deleteConversation: async () => undefined,
    directoryFor: () => null,
    pathFor: () => null,
  } as unknown as ConversationAttachmentStore
  const chat = await setup({ attachmentStore })
  const first = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'investigate' })
  await until(() => chat.summary()?.status === 'active', 'the turn to open')
  // Each refusal ran nothing, so it is busy: sent again, it runs again.
  const steerBusy = (message: string) => ({ ok: false, code: 'busy', retryAfterMs: TURN_BUSY_RETRY, message })
  assert.deepEqual(
    await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'early', steer: true }),
    steerBusy('The agent has not started on the last message yet.'),
  )
  release()
  await until(() => chat.provider.streams.size === 1, 'the provider to take the turn')
  const turnId = Array.from(chat.provider.streams.keys())[0]

  // The provider's own refusal is the answer, and nothing is written.
  chat.provider.record.refuse = 'The child is being replaced.'
  const refused = await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'refused', steer: true })
  assert.deepEqual(refused, steerBusy('The child is being replaced.'))
  assert.equal(chat.landed('refused'), undefined)
  chat.provider.record.refuse = null

  // Once the stream has written its own end, a message goes as the next turn
  // rather than into one that is over.
  chat.provider.emit(turnId, 'turn_completed', { costUsd: 0.1 })
  await until(() => chat.summary()?.status === 'ready', 'the turn to end')
  assert.deepEqual(
    await chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'late', steer: true }),
    steerBusy('The agent has just finished; the message goes as the next turn.'),
  )
  chat.provider.streams.get(turnId)!.end()
  assert.equal((await first).ok, true)
  assert.deepEqual(chat.provider.steers, [])
  assert.equal(chat.events.filter((next) => next.type === 'turn_completed').length, 1)
})

// A turn the agent opened by itself (a background task reported back after
// its last reply) comes over the session channel rather than a send's stream.
async function carryingOn(chat: Awaited<ReturnType<typeof setup>>, turnId: string) {
  const first = await chat.sendRunning('investigate')
  chat.provider.finish(first.turnId)
  assert.equal((await first.settled).ok, true)
  const sink = chat.provider.record.base!.onSessionEvent!
  chat.provider.streams.set(turnId, { push: sink, end: () => undefined })
  chat.provider.emit(turnId, 'turn_started')
  chat.provider.emit(turnId, 'content_delta', { text: 'The subagent reported' })
  await until(() => chat.summary()?.status === 'active', 'the agent to carry on')
}

test('a turn the agent carried on with by itself takes a steer, and ends where its stream does', async () => {
  const chat = await setup()
  await carryingOn(chat, 'cont_1')
  let steerSettled = false
  const steer = chat.runtime
    .sendTurn({ sessionId: chat.sessionId, message: 'use my phone', steer: true })
    .finally(() => (steerSettled = true))
  await until(() => Boolean(chat.landed('use my phone')), 'the steered message to land')
  const steeredTurnId = chat.landed('use my phone')
  assert.deepEqual(chat.provider.steers, [{ turnId: 'cont_1', message: 'use my phone' }])

  chat.provider.emit('cont_1', 'content_delta', { text: 'Switching to the phone' })
  await until(() => chat.events.filter((next) => next.type === 'content_delta').length === 2, 'the reply')
  await tick()
  assert.equal(steerSettled, false, 'a steer settles with the turn it opened')
  chat.provider.emit('cont_1', 'turn_completed', { costUsd: 0.2 })
  assert.equal((await steer).ok, true)
  await until(() => chat.summary()?.status === 'ready', 'the session to be free')

  const carried = chat.events
    .filter((next) => next.payload?.turnId === 'cont_1' || next.payload?.turnId === steeredTurnId)
    .map((next) => [next.type, next.payload?.turnId === 'cont_1' ? 'carried' : 'steered'])
  assert.deepEqual(carried, [
    ['turn_started', 'carried'],
    ['content_delta', 'carried'],
    ['turn_completed', 'carried'],
    ['user_message', 'steered'],
    ['turn_started', 'steered'],
    ['content_delta', 'steered'],
    ['turn_completed', 'steered'],
  ])
  const next = await chat.sendRunning('thanks')
  chat.provider.finish(next.turnId)
  assert.equal((await next.settled).ok, true)
})

test('stopping a carried-on turn a steer joined settles the steer', async () => {
  const chat = await setup()
  await carryingOn(chat, 'cont_1')
  const steer = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'use my phone', steer: true })
  await until(() => Boolean(chat.landed('use my phone')), 'the steered message to land')
  assert.equal((await chat.runtime.interrupt({ sessionId: chat.sessionId })).ok, true)
  assert.equal((await steer).ok, true)
  assert.equal(chat.summary()?.status, 'ready')
  chat.provider.emit('cont_1', 'content_delta', { text: 'still going' })
  await tick()
  assert.equal(chat.events.filter((next) => next.type === 'content_delta').length, 1, 'the rest stays out')
})

test('stopping after a steer stops the turn the steer opened, and the rest of the stream stays out', async () => {
  const chat = await setup()
  const first = await chat.sendRunning('investigate')
  const steer = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'use staging', steer: true })
  await until(() => Boolean(chat.landed('use staging')), 'the steered message to land')
  const steeredTurnId = chat.landed('use staging')
  assert.equal((await chat.runtime.interrupt({ sessionId: chat.sessionId })).ok, true)
  const failed = chat.events.filter((next) => next.type === 'turn_failed')
  assert.deepEqual(
    failed.map((next) => [next.payload?.turnId, next.payload?.reason]),
    [[steeredTurnId, 'interrupted']],
  )
  chat.provider.emit(first.turnId, 'content_delta', { text: 'still going' })
  chat.provider.finish(first.turnId)
  assert.equal((await steer).ok, true)
  assert.equal((await first.settled).ok, true)
  assert.equal(
    chat.events.some((next) => next.type === 'content_delta'),
    false,
  )
  assert.equal(chat.summary()?.status, 'ready')
})

// "Edit from here" on a steered message goes back to where the provider stood
// as the message went in; with no such point, before the turn it went into.
for (const known of [true, false])
  test(`editing from a steered message ${known ? 'forks where it went in' : 'goes back before the turn it joined'}`, async () => {
    const chat = await setup(known ? { cursor: { sessionId: 'provider-1', at: 'entry-mid' } } : {})
    const one = await chat.sendRunning('one')
    chat.provider.finish(one.turnId)
    await one.settled
    const two = await chat.sendRunning('two')
    const steer = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'three', steer: true })
    await until(() => Boolean(chat.landed('three')), 'the steered message to land')
    chat.provider.finish(two.turnId)
    await steer
    const seqOf = (text: string) =>
      chat.events.find((next) => next.type === 'user_message' && next.payload?.text === text)?.seq ?? 0
    assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: seqOf('three') }), { ok: true })
    assert.deepEqual(chat.provider.rewinds, [
      known ? { sessionId: 'provider-1', at: 'entry-mid' } : { sessionId: 'provider-1', at: 'entry-1' },
    ])
    const marker = chat.events.at(-1)
    assert.equal(marker?.type, 'session_updated')
    // What stays in view is what the provider still has.
    assert.equal(marker?.payload?.rewoundFromSeq, known ? seqOf('three') : seqOf('two'))
  })

test('a steer the agent took is answered as sent even when its record could not be written, so it is never sent twice', async () => {
  const chat = await setup()
  const first = await chat.sendRunning('investigate')
  // The record of the handover fails once the agent has the message: the
  // event log is out of space, say.
  const runtime = chat.runtime as unknown as { emitNow: (...args: unknown[]) => Promise<unknown> }
  const emitNow = runtime.emitNow
  chat.provider.record.onSteer = () => {
    runtime.emitNow = async () => {
      throw new Error('ENOSPC: no space left on device')
    }
  }
  const warn = console.warn
  console.warn = () => undefined
  try {
    const steer = chat.runtime.sendTurn({ sessionId: chat.sessionId, message: 'use staging', steer: true })
    await until(() => chat.provider.steers.length === 1, 'the agent to take the message')
    await tick()
    runtime.emitNow = emitNow
    chat.provider.finish(first.turnId)
    const answered = await steer
    assert.equal(answered.ok, true, 'not "not delivered": the window would queue it and send it again')
    assert.deepEqual(chat.provider.steers, [{ turnId: first.turnId, message: 'use staging' }], 'told once')
    assert.equal((await first.settled).ok, true)
  } finally {
    console.warn = warn
    runtime.emitNow = emitNow
  }
})
