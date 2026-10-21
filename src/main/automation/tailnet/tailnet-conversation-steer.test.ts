import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationHeldMessages } from './tailnet-conversation-host'

// A paired device's send that says `steer` (`conversation-steer-sends`): into
// the running turn where the chat's provider takes one, and otherwise held for
// the turn's end, never lost.

async function fixture(options: { steer?: boolean; held?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-steer-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ steer: options.steer ?? true })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const holds: Array<{ text: string; source: string }> = []
  const heldMessages: ConversationHeldMessages = {
    hold: (_chat, text, source) => {
      holds.push({ text, source })
      return { ok: true }
    },
    cancel: () => ({ ok: false, message: 'Nothing is held.' }),
    list: () => [],
    onChanged: () => () => undefined,
  }
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    options.held === false ? {} : { heldMessages },
  )
  const started = await runtime.startSession({
    ...key,
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  // The session as the runtime lists it while a turn runs.
  const running = (status: ConversationSessionSummary['status'] = 'active') =>
    vi.spyOn(runtime, 'listSessions').mockReturnValue({ ok: true, sessions: [{ ...started.session, status }] })
  return {
    key,
    host,
    runtime,
    holds,
    running,
    session: started.session,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a listed chat says whether its provider takes a steer', async () => {
  const takes = await fixture({ steer: true })
  const cannot = await fixture({ steer: false })
  try {
    assert.equal((await takes.host.list())[0]!.capabilities?.steer, true)
    assert.equal((await cannot.host.list())[0]!.capabilities?.steer, false)
  } finally {
    await takes.cleanup()
    await cannot.cleanup()
  }
})

test('a steer reaches the runtime as one, beside the send still waiting on the turn it joins', async () => {
  const f = await fixture()
  try {
    f.running()
    let release: () => void = () => undefined
    const send = vi.spyOn(f.runtime, 'sendTurn').mockImplementation((input) =>
      input.steer
        ? Promise.resolve({ ok: true, session: f.session })
        : new Promise((resolve) => {
            release = () => resolve({ ok: true, session: f.session })
          }),
    )
    const first = f.host.command(f.key, 'phone', 'first', { kind: 'send', message: 'Fix the flaky test' })
    const steered = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      steer: true,
    })
    assert.equal(steered.ok, true, 'not turned away behind the send it joins')
    assert.equal(send.mock.calls.at(-1)![0].steer, true)
    assert.equal(send.mock.calls.at(-1)![0].message, 'Keep it to one file')
    assert.deepEqual(f.holds, [])
    release()
    assert.equal((await first).ok, true)
  } finally {
    await f.cleanup()
  }
})

test('a steer with no turn running goes as an ordinary send', async () => {
  const f = await fixture()
  try {
    const send = vi.spyOn(f.runtime, 'sendTurn')
    const sent = await f.host.command(f.key, 'phone', 'steer-1', { kind: 'send', message: '/tools', steer: true })
    assert.equal(sent.ok, true, sent.message ?? '')
    assert.equal(send.mock.calls[0]![0].steer, true, 'the runtime is the one that finds no turn to join')
    assert.deepEqual(f.holds, [])
    // The turn it started is the chat's own, with the message as its prompt.
    const listed = (await f.host.list())[0]!
    assert.ok(listed.turnCount >= 1)
  } finally {
    await f.cleanup()
  }
})

test('a steer to a provider that cannot take one is held for the turn, and nothing is sent now', async () => {
  const f = await fixture({ steer: false })
  try {
    f.running()
    const send = vi.spyOn(f.runtime, 'sendTurn')
    const answer = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      steer: true,
    })
    assert.equal(answer.ok, true)
    assert.match(answer.notice ?? '', /queued and goes when this turn ends/)
    assert.deepEqual(f.holds, [{ text: 'Keep it to one file', source: JSON.stringify(['phone', 'steer-1']) }])
    assert.equal(send.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a steer the turn refuses on the way is held instead, with the reason', async () => {
  const f = await fixture()
  try {
    f.running('awaiting_approval')
    vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({
      ok: false,
      message: 'Conversation turn is awaiting approval.',
    })
    const answer = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      steer: true,
    })
    assert.deepEqual(answer, {
      ok: true,
      notice: 'Conversation turn is awaiting approval, so it is queued and goes when this turn ends.',
    })
    assert.equal(f.holds.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a steer whose turn failed after it landed is answered as taken, and not held a second time', async () => {
  const f = await fixture()
  try {
    f.running()
    const listeners: Array<Parameters<ConversationRuntime['onEvent']>[0]> = []
    const onEvent = f.runtime.onEvent.bind(f.runtime)
    vi.spyOn(f.runtime, 'onEvent').mockImplementation((listener) => {
      listeners.push(listener)
      return onEvent(listener)
    })
    vi.spyOn(f.runtime, 'sendTurn').mockImplementation(async (input) => {
      for (const listener of [...listeners])
        listener({
          id: 'event-9',
          type: 'user_message',
          sessionId: f.session.sessionId,
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId: f.session.providerId,
          modelId: f.session.modelId,
          seq: 9,
          createdAt: 1_700_000_000_000,
          payload: { text: input.message, commandId: input.commandId },
        })
      return { ok: false, message: 'The turn failed.' }
    })
    const answer = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      steer: true,
    })
    // Taken, so answered as taken: a refusal would have the device send the
    // same words again, after they are already in the chat.
    assert.deepEqual(answer, { ok: true, notice: 'It reached the agent, and then: The turn failed.' })
    assert.deepEqual(f.holds, [])
  } finally {
    await f.cleanup()
  }
})

test('a steer carrying what a held message cannot is refused busy, with a delay to send it again', async () => {
  const f = await fixture({ steer: false })
  try {
    f.running()
    const answer = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      skills: ['review'],
      steer: true,
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'busy')
    assert.ok((answer.retryAfterMs ?? 0) > 0)
    assert.deepEqual(f.holds, [])
  } finally {
    await f.cleanup()
  }
})

test('a host that holds nothing refuses a steer it cannot deliver busy, as a send made mid-turn', async () => {
  const f = await fixture({ steer: false, held: false })
  try {
    f.running()
    const answer = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      steer: true,
    })
    assert.equal(answer.code, 'busy')
  } finally {
    await f.cleanup()
  }
})

test('a steer behind a send still being prepared waits its turn rather than overtaking it', async () => {
  const f = await fixture()
  try {
    let release: () => void = () => undefined
    const send = vi.spyOn(f.runtime, 'sendTurn').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, session: f.session })
        }),
    )
    // No turn is running yet: the first send is still resuming the chat.
    const first = f.host.command(f.key, 'phone', 'first', { kind: 'send', message: 'Fix the flaky test' })
    const steered = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Keep it to one file',
      steer: true,
    })
    assert.equal(steered.code, 'busy', 'sent again once the first is under way')
    assert.equal(send.mock.calls.length, 1)
    assert.equal(send.mock.calls[0]![0].message, 'Fix the flaky test')
    release()
    assert.equal((await first).ok, true)
  } finally {
    await f.cleanup()
  }
})

/**
 * A chat whose turn stays open until the test ends it, on a provider that says
 * it steers but takes no steer now: the real runtime, its receipts on disk.
 */
async function openTurn() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-steer-receipts-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const base = createMockConversationProvider({ steer: true })
  let end: () => void = () => undefined
  // Settles once the held turn is waiting on `end`. Ending it before then
  // left the turn waiting for good, which a fixed pause could not rule out
  // on a loaded machine.
  let holding: () => void = () => undefined
  const held = new Promise<void>((resolve) => (holding = resolve))
  const adapter = {
    ...base,
    sendTurn: (input: Parameters<typeof base.sendTurn>[0]) =>
      (async function* () {
        const event = (type: 'turn_started' | 'turn_completed') => ({
          id: '',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: 1,
          type,
          payload: { turnId: input.turnId },
        })
        yield event('turn_started')
        if (input.message.startsWith('hold'))
          await new Promise<void>((resolve) => {
            end = resolve
            holding()
          })
        yield event('turn_completed')
      })(),
  }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    resolveSkills: async ({ skills }) => ({ ids: skills.map((skill) => skill.id) }),
  })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
  )
  const started = await runtime.startSession({
    ...key,
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  return {
    key,
    host,
    runtime,
    end: () => end(),
    held,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a steer that can be neither taken nor held is sent again until its turn is over, then goes as the next', async () => {
  const chat = await openTurn()
  const asked: string[] = []
  const stop = chat.runtime.onEvent((event) => {
    if (event.type === 'user_message') asked.push(String(event.payload?.text))
  })
  try {
    const running = chat.host.command(chat.key, 'phone', 'first', { kind: 'send', message: 'hold the turn' })
    await chat.held
    const steer = { kind: 'send' as const, message: 'Keep it to one file', skills: ['review'], steer: true as const }
    // The provider takes no message now, and one with skills cannot be held:
    // busy, and busy again under the same id, never a refusal kept for it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await chat.host.command(chat.key, 'phone', 'steer-1', steer)
      assert.equal(refused.ok, false)
      assert.equal(refused.code, 'busy')
    }
    chat.end()
    assert.equal((await running).ok, true)
    // The same id, once the turn is over, runs: the message goes as the next turn.
    const sent = await chat.host.command(chat.key, 'phone', 'steer-1', steer)
    assert.equal(sent.ok, true, sent.message ?? '')
    assert.deepEqual(asked, ['hold the turn', 'Keep it to one file'])
  } finally {
    stop()
    await chat.cleanup()
  }
})
