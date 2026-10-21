// A message a person scheduled into a chat goes out when its time comes: the
// file it is kept in, the one timer, the wait on a busy chat, a refusal kept
// with Retry, and the ways one is moved, sent early or let go.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { parseScheduledMessageUpdate } from '../../shared/scheduled-messages'
import {
  createScheduledMessages,
  scheduledMessagesFileStorage,
  type ScheduledMessageSendResult,
  type ScheduledMessagesStorage,
} from './scheduled-messages'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.UTC(2026, 9, 7, 21, 0)
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const OTHER = { workspaceId: 'ws-2', agentId: 'agent-2' }

const scratch = mkdtempSync(join(tmpdir(), 'se-scheduled-messages-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function memoryStorage(initial: string | null = null): ScheduledMessagesStorage & { body: string | null } {
  const storage = {
    body: initial,
    read: async () => storage.body,
    write: async (body: string) => {
      storage.body = body
    },
  }
  return storage
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: { storage?: ScheduledMessagesStorage; now?: number; idPrefix?: string } = {}) {
  let now = options.now ?? T0
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = []
  const eventListeners = new Set<(event: ConversationEvent) => void>()
  const sessions: ConversationSessionSummary[] = []
  const chats = new Set<string>([`${CHAT.workspaceId}/${CHAT.agentId}`, `${OTHER.workspaceId}/${OTHER.agentId}`])
  const sent: Array<{ chat: typeof CHAT; text: string; commandId: string }> = []
  const storage = options.storage ?? memoryStorage()
  let sendAnswer: () => ScheduledMessageSendResult = () => ({ ok: true })
  let ids = 0

  const scheduled = createScheduledMessages({
    storage,
    listSessions: () => sessions,
    onConversationEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    chatExists: (chat) => chats.has(`${chat.workspaceId}/${chat.agentId}`),
    send: async (chat, text, commandId) => {
      sent.push({ chat, text, commandId })
      return sendAnswer()
    },
    now: () => now,
    newId: () => `${options.idPrefix ?? 'sm'}-${++ids}`,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })

  /** Move the wall clock, running each timer whose time came, as a computer that stays awake would. */
  async function advance(ms: number) {
    const target = now + ms
    for (;;) {
      const next = timers.filter((timer) => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      next.cleared = true
      now = Math.max(now, next.at)
      next.callback()
      await settle()
    }
    now = target
    await settle()
  }

  function working(chat = CHAT, phase: ConversationSessionSummary['phase'] = 'running') {
    sessions.splice(0, sessions.length, {
      sessionId: `s-${chat.agentId}`,
      ...chat,
      providerId: 'claude-agent',
      modelId: 'default',
      status: 'active',
      createdAt: T0 - HOUR,
      updatedAt: T0,
      phase,
    })
  }

  return {
    scheduled,
    storage,
    sessions,
    chats,
    sent,
    advance,
    working,
    idle: () => sessions.splice(0, sessions.length),
    jump: (ms: number) => {
      now += ms
    },
    emit: (event: Partial<ConversationEvent>) =>
      eventListeners.forEach((listener) => listener({ ...CHAT, ...event } as ConversationEvent)),
    answerSends: (answer: typeof sendAnswer) => {
      sendAnswer = answer
    },
    now: () => now,
  }
}

// Past the start's grace, so a test's first message is not held by it.
async function started(h: ReturnType<typeof harness>) {
  await h.scheduled.start()
  await h.advance(MINUTE)
}

test('a scheduled message waits for its time, then goes into its chat as the person wrote it', async () => {
  const storage = memoryStorage()
  const h = harness({ storage })
  await started(h)
  const state = h.scheduled.update({
    kind: 'schedule',
    ...CHAT,
    text: 'Carry on with the migration.',
    sendAt: h.now() + 2 * HOUR,
  })
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0]?.text, 'Carry on with the migration.')
  await h.advance(2 * HOUR - MINUTE)
  assert.equal(h.sent.length, 0, 'not before its time')
  await h.advance(MINUTE)
  assert.deepEqual(h.sent, [{ chat: CHAT, text: 'Carry on with the migration.', commandId: 'scheduled-message:sm-1' }])
  assert.deepEqual(h.scheduled.state().messages, [], 'sent, it is gone')
  assert.deepEqual(JSON.parse(storage.body ?? '{}').messages, [], 'from the file too')
})

test('a chat in a turn when the message comes due gets it once the turn ends, and the tray says it waits', async () => {
  const h = harness()
  await started(h)
  h.scheduled.update({ kind: 'schedule', ...CHAT, text: 'Now the tests.', sendAt: h.now() + HOUR })
  h.working()
  await h.advance(HOUR)
  assert.equal(h.sent.length, 0, 'never into a running turn')
  assert.equal(h.scheduled.state().messages[0]?.waitingSince, h.now(), 'it says it waits')
  h.idle()
  h.emit({ type: 'turn_completed' })
  await h.advance(2_000)
  assert.equal(h.sent.length, 1, 'the turn ending is heard: it goes then, not at the next poll')
  assert.deepEqual(h.scheduled.state().messages, [])
})

test('a busy refusal is waited out like a busy chat; any other is kept, with Retry sending it again', async () => {
  const h = harness()
  await started(h)
  h.scheduled.update({ kind: 'schedule', ...CHAT, text: 'Ship it.', sendAt: h.now() + HOUR })
  h.answerSends(() => ({ ok: false, code: 'busy', retryAfterMs: 5_000 }))
  await h.advance(HOUR)
  assert.equal(h.sent.length, 1)
  assert.ok(h.scheduled.state().messages[0]?.waitingSince, 'busy: it waits')
  h.answerSends(() => ({ ok: false, message: 'The chat has no folder on this machine.' }))
  await h.advance(30_000)
  assert.equal(h.sent.length, 2, 'looked at again')
  const failed = h.scheduled.state().messages[0]
  assert.equal(failed?.failure, 'The chat has no folder on this machine', 'refused: kept, saying why')
  await h.advance(HOUR)
  assert.equal(h.sent.length, 2, 'a refused one is not sent again on its own')
  h.answerSends(() => ({ ok: true }))
  h.scheduled.update({ kind: 'send-now', id: failed!.id })
  await settle()
  assert.equal(h.sent.length, 3, 'Retry sends it')
  assert.equal(h.sent[2]?.commandId, 'scheduled-message:sm-1:1', 'under a command id of its own')
  assert.deepEqual(h.scheduled.state().messages, [])
})

test('send now, a new time, and delete are the person’s to ask for at any time', async () => {
  const h = harness()
  await started(h)
  h.scheduled.update({ kind: 'schedule', ...CHAT, text: 'First.', sendAt: h.now() + HOUR })
  h.scheduled.update({ kind: 'schedule', ...CHAT, text: 'Second.', sendAt: h.now() + 2 * HOUR })
  h.scheduled.update({ kind: 'schedule', ...OTHER, text: 'Elsewhere.', sendAt: h.now() + 3 * HOUR })
  h.scheduled.update({ kind: 'reschedule', id: 'sm-1', sendAt: h.now() + 4 * HOUR })
  h.scheduled.update({ kind: 'delete', id: 'sm-2' })
  h.scheduled.update({ kind: 'send-now', id: 'sm-3' })
  await settle()
  assert.deepEqual(
    h.sent.map((entry) => entry.text),
    ['Elsewhere.'],
  )
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 1, 'the moved one is not sent at its old time')
  await h.advance(HOUR)
  assert.deepEqual(
    h.sent.map((entry) => entry.text),
    ['Elsewhere.', 'First.'],
  )
})

test('a deleted chat takes its scheduled messages with it', async () => {
  const h = harness()
  await started(h)
  h.scheduled.update({ kind: 'schedule', ...CHAT, text: 'Never mind.', sendAt: h.now() + HOUR })
  h.chats.delete(`${CHAT.workspaceId}/${CHAT.agentId}`)
  h.scheduled.prune()
  assert.deepEqual(h.scheduled.state().messages, [])
  await h.advance(2 * HOUR)
  assert.equal(h.sent.length, 0)
})

test('one due while the app was closed goes out once it is open again, after the start’s grace', async () => {
  const file = join(scratch, 'scheduled-messages.json')
  const first = harness({ storage: scheduledMessagesFileStorage(file) })
  await started(first)
  first.scheduled.update({ kind: 'schedule', ...CHAT, text: 'Overnight job.', sendAt: first.now() + HOUR })
  await first.scheduled.dispose()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.messages[0].text, 'Overnight job.')

  const second = harness({ storage: scheduledMessagesFileStorage(file), now: T0 + 10 * HOUR })
  await second.scheduled.start()
  assert.equal(second.scheduled.state().messages.length, 1, 'read back')
  assert.equal(second.sent.length, 0, 'not in the start’s first seconds: the app is still finding its chats')
  await second.advance(MINUTE)
  assert.deepEqual(
    second.sent.map((entry) => entry.text),
    ['Overnight job.'],
  )
})

test('several due together go one after another', async () => {
  const h = harness()
  await started(h)
  h.scheduled.update({ kind: 'schedule', ...CHAT, text: 'One.', sendAt: h.now() + HOUR })
  h.scheduled.update({ kind: 'schedule', ...OTHER, text: 'Two.', sendAt: h.now() + HOUR })
  await h.advance(HOUR)
  assert.equal(h.sent.length, 1)
  await h.advance(5_000)
  assert.equal(h.sent.length, 2)
})

test('a window’s update is read strictly', () => {
  assert.deepEqual(
    parseScheduledMessageUpdate({ kind: 'schedule', workspaceId: 'ws', agentId: 'a', text: '  hi  ', sendAt: 5 }),
    { kind: 'schedule', workspaceId: 'ws', agentId: 'a', text: 'hi', sendAt: 5 },
  )
  assert.equal(
    parseScheduledMessageUpdate({ kind: 'schedule', workspaceId: 'ws', agentId: 'a', text: ' ', sendAt: 5 }),
    null,
  )
  assert.equal(parseScheduledMessageUpdate({ kind: 'schedule', workspaceId: 'ws', agentId: 'a', text: 'x' }), null)
  assert.deepEqual(parseScheduledMessageUpdate({ kind: 'delete', id: 'sm-1' }), { kind: 'delete', id: 'sm-1' })
  assert.equal(parseScheduledMessageUpdate({ kind: 'reschedule', id: 'sm-1', sendAt: -1 }), null)
  assert.equal(parseScheduledMessageUpdate({ kind: 'explode', id: 'sm-1' }), null)
})

test('a message a paired machine queued is held until the turn ends, then goes from here', async () => {
  const h = harness()
  await started(h)
  h.working()
  const held = h.scheduled.hold(CHAT, '  And add a test for it.  ', 'device-1:cmd-1')
  assert.deepEqual(held, { ok: true, id: 'sm-1' })
  const [message] = h.scheduled.state().messages
  assert.equal(message?.queued, true)
  assert.equal(message?.text, 'And add a test for it.')
  assert.equal(message?.waitingSince, h.now(), 'the tray says it waits on the turn from the start')
  await h.advance(10 * MINUTE)
  assert.equal(h.sent.length, 0, 'never into the running turn')
  h.idle()
  h.emit({ type: 'turn_completed' })
  await h.advance(2_000)
  assert.deepEqual(
    h.sent.map((entry) => [entry.chat, entry.text]),
    [[CHAT, 'And add a test for it.']],
  )
  assert.deepEqual(h.scheduled.state().messages, [])
})

test('several queued in one turn go as one message, and the same command twice is held once', async () => {
  const h = harness()
  await started(h)
  h.working()
  h.scheduled.hold(CHAT, 'First this.', 'device-1:cmd-1')
  h.scheduled.hold(CHAT, 'First this.', 'device-1:cmd-1')
  h.scheduled.hold(CHAT, 'Then that.', 'device-1:cmd-2')
  assert.deepEqual(
    h.scheduled.state().messages.map((message) => [message.agentId, message.text]),
    [[CHAT.agentId, 'First this.\nThen that.']],
  )
  // Held for another chat, it is a message of its own; that chat is not
  // working, so it goes at once.
  h.scheduled.hold(OTHER, 'Elsewhere.', 'device-1:cmd-3')
  await h.advance(0)
  assert.deepEqual(
    h.sent.map((entry) => entry.text),
    ['Elsewhere.'],
  )
  h.idle()
  h.emit({ type: 'turn_completed' })
  await h.advance(5_000)
  assert.deepEqual(
    h.sent.map((entry) => entry.text),
    ['Elsewhere.', 'First this.\nThen that.'],
  )
})

test('a held message for a chat that is gone, or with no words, is refused rather than kept', async () => {
  const h = harness()
  await started(h)
  h.chats.clear()
  assert.equal(h.scheduled.hold(CHAT, 'Hello?', 'device-1:cmd-1').ok, false)
  h.chats.add(`${CHAT.workspaceId}/${CHAT.agentId}`)
  assert.equal(h.scheduled.hold(CHAT, '   ', 'device-1:cmd-2').ok, false)
  assert.deepEqual(h.scheduled.state().messages, [])
})

test('a held message outlives a restart, still held for the turn', async () => {
  const storage = memoryStorage()
  const first = harness({ storage })
  await started(first)
  first.working()
  first.scheduled.hold(CHAT, 'Keep this.', 'device-1:cmd-1')
  await first.scheduled.dispose()
  const second = harness({ storage, now: first.now() })
  await second.scheduled.start()
  const [message] = second.scheduled.state().messages
  assert.equal(message?.queued, true)
  assert.equal(message?.text, 'Keep this.')
})

test('the same held command arriving again after its message went is not held or sent a second time', async () => {
  const h = harness()
  await started(h)
  assert.deepEqual(h.scheduled.hold(CHAT, 'Ship it.', 'device-1:cmd-1'), { ok: true, id: 'sm-1' })
  await h.advance(5_000)
  assert.deepEqual(
    h.sent.map((entry) => entry.text),
    ['Ship it.'],
  )
  assert.deepEqual(h.scheduled.state().messages, [])
  // The device lost the answer and offers it again under the same id.
  assert.deepEqual(h.scheduled.hold(CHAT, 'Ship it.', 'device-1:cmd-1'), { ok: true, id: 'sm-1' })
  await h.advance(HOUR)
  assert.deepEqual(h.scheduled.state().messages, [])
  assert.equal(h.sent.length, 1, 'sent once')
  // A message taken back is gone too: its command does not bring it back.
  h.working()
  h.scheduled.hold(CHAT, 'Not this.', 'device-1:cmd-2')
  const [held] = h.scheduled.state().messages
  h.scheduled.update({ kind: 'delete', id: held!.id })
  assert.equal(h.scheduled.hold(CHAT, 'Not this.', 'device-1:cmd-2').ok, true)
  assert.deepEqual(h.scheduled.state().messages, [])
})

test('the same held command after a restart is not held or sent a second time', async () => {
  const storage = memoryStorage()
  const first = harness({ storage })
  await started(first)
  first.working()
  first.scheduled.hold(CHAT, 'First this.', 'device-1:cmd-1')
  first.scheduled.hold(CHAT, 'Then that.', 'device-1:cmd-2')
  first.idle()
  first.emit({ type: 'turn_completed' })
  await first.advance(5_000)
  assert.deepEqual(
    first.sent.map((entry) => entry.text),
    ['First this.\nThen that.'],
  )
  first.working()
  first.scheduled.hold(CHAT, 'Still waiting.', 'device-1:cmd-3')
  await first.scheduled.dispose()

  const second = harness({ storage, now: first.now() })
  second.working()
  await started(second)
  // Gone before the restart, and still held across it: neither is held again.
  for (const [text, source] of [
    ['First this.', 'device-1:cmd-1'],
    ['Then that.', 'device-1:cmd-2'],
    ['Still waiting.', 'device-1:cmd-3'],
  ] as const)
    assert.equal(second.scheduled.hold(CHAT, text, source).ok, true)
  assert.deepEqual(
    second.scheduled.state().messages.map((message) => message.text),
    ['Still waiting.'],
  )
  second.idle()
  second.emit({ type: 'turn_completed' })
  await second.advance(5_000)
  assert.deepEqual(
    second.sent.map((entry) => entry.text),
    ['Still waiting.'],
  )
  // A command first seen now is a message of its own.
  second.scheduled.hold(CHAT, 'Something new.', 'device-1:cmd-4')
  await second.advance(5_000)
  assert.deepEqual(
    second.sent.map((entry) => entry.text),
    ['Still waiting.', 'Something new.'],
  )
})

test('a command held while the file is read, and already in it, is the file’s message', async () => {
  const storage = memoryStorage()
  const first = harness({ storage })
  await started(first)
  first.working()
  first.scheduled.hold(CHAT, 'Keep this.', 'device-1:cmd-1')
  await first.scheduled.dispose()
  // Another run mints other ids, as the app's random ones are.
  const second = harness({ storage, now: first.now(), idPrefix: 'run-2' })
  second.working()
  const starting = second.scheduled.start()
  second.scheduled.hold(CHAT, 'Keep this.', 'device-1:cmd-1')
  await starting
  assert.deepEqual(
    second.scheduled.state().messages.map((message) => message.text),
    ['Keep this.'],
  )
})
