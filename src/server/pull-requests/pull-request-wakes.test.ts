import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { PullRequestWake } from './pull-request-watch'
import { createPullRequestWakes, type PullRequestWakesDeps } from './pull-request-wakes'

const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const NOW = Date.parse('2026-10-11T10:00:00Z')

const session = (overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary => ({
  sessionId: 'session-1',
  workspaceId: CHAT.workspaceId,
  agentId: CHAT.agentId,
  providerId: 'claude-agent',
  modelId: 'claude-opus',
  status: 'ready',
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  phase: 'completed',
  ...overrides,
})

const wake = (
  number: number,
  news: PullRequestWake['news'],
  stop: PullRequestWake['stop'] = null,
): PullRequestWake => ({
  url: `https://github.com/acme/app/pull/${number}`,
  number,
  repo: 'acme/app',
  base: 'main',
  headSha: null,
  autoMerge: false,
  checksGreen: false,
  news,
  stop,
})

function setUp(overrides: Partial<PullRequestWakesDeps> = {}) {
  let nowMs = NOW
  let seq = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const sent: Array<{ text: string; commandId: string }> = []
  const gone: string[] = []
  let listener: ((event: ConversationEvent) => void) | null = null
  let sessions = [session()]
  let chat: { settled: boolean } | null = { settled: false }
  let answer: { ok: boolean; code?: string; message?: string } = { ok: true }
  const wakes = createPullRequestWakes({
    listSessions: () => sessions,
    onConversationEvent: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    chat: () => chat,
    send: async (_key, text, commandId) => {
      sent.push({ text, commandId })
      return answer
    },
    onChatGone: (key) => gone.push(key.agentId),
    now: () => nowMs,
    setTimer: (run, ms) => {
      seq += 1
      timers.set(seq, { at: nowMs + ms, run })
      return seq
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    ...overrides,
  })
  return {
    wakes,
    sent,
    gone,
    setSessions: (next: ConversationSessionSummary[]) => void (sessions = next),
    setChat: (next: { settled: boolean } | null) => void (chat = next),
    setAnswer: (next: typeof answer) => void (answer = next),
    emit: (event: Partial<ConversationEvent>) =>
      listener?.({
        sessionId: 'session-1',
        workspaceId: CHAT.workspaceId,
        agentId: CHAT.agentId,
        ...event,
      } as ConversationEvent),
    async advance(ms: number) {
      nowMs += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > nowMs) continue
        timers.delete(id)
        timer.run()
      }
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('news for an idle chat goes at once, as one Studio message', async () => {
  const { wakes, sent } = setUp()
  wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'behind' }]) })
  await settle()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^\[SprintEngine Studio\] Pull request #234 is behind main/)
  assert.match(sent[0].commandId, /^pull-request-watch:/)
  assert.equal(wakes.pendingCount(CHAT), 0)
})

test('a running turn is waited out, and everything learned meanwhile goes as one message when it ends', async () => {
  const { wakes, sent, setSessions, emit, advance } = setUp()
  setSessions([session({ status: 'active', phase: 'running' })])
  wakes.deliver({
    conversation: CHAT,
    wake: wake(234, [{ kind: 'checks-failed', checks: [{ name: 'Build', outcome: 'FAILURE', url: null }] }]),
  })
  wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'behind' }]) })
  wakes.deliver({ conversation: CHAT, wake: wake(240, [{ kind: 'conflicting' }]) })
  await settle()
  assert.equal(sent.length, 0, 'never into a running turn')
  assert.equal(wakes.pendingCount(CHAT), 2)
  setSessions([session()])
  emit({ type: 'turn_completed' })
  await advance(1_500)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /News on 2 pull requests/)
  assert.match(
    sent[0].text,
    /Pull request #234:\n- 1 check failed — Build\. Fix it, push, and end your turn\.\n- It is behind main/,
  )
  assert.match(sent[0].text, /Pull request #240:\n- It conflicts with main/)
})

test('a chat waiting on the person is not woken over the question', async () => {
  const { wakes, sent, setSessions, advance } = setUp()
  setSessions([session({ status: 'awaiting_approval', phase: 'waiting_for_approval' })])
  wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'behind' }]) })
  await advance(60_000)
  assert.equal(sent.length, 0)
  setSessions([session()])
  await advance(60_000)
  assert.equal(sent.length, 1, 'looked at again on its own, if no turn end is heard')
})

test('a settled or deleted chat is never woken: its watches stop instead', async () => {
  const settled = setUp()
  settled.setChat({ settled: true })
  settled.wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'merged' }], 'merged') })
  await settle()
  assert.deepEqual(settled.sent, [])
  assert.deepEqual(settled.gone, ['agent-1'])
  const deleted = setUp()
  deleted.setChat(null)
  deleted.wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'behind' }]) })
  await settle()
  assert.deepEqual(deleted.sent, [])
  assert.deepEqual(deleted.gone, ['agent-1'])
})

test('a usage limit holds the wake until a little after it resets', async () => {
  let limited = true
  const { wakes, sent, advance } = setUp({
    usageLimit: () => ({ limited, resetsAt: limited ? NOW + 10 * 60_000 : null }),
  })
  wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'behind' }]) })
  await settle()
  assert.equal(sent.length, 0)
  await advance(10 * 60_000)
  assert.equal(sent.length, 0, 'not on the stroke of the reset')
  limited = false
  await advance(2 * 60_000)
  assert.equal(sent.length, 1)
})

test('a send refused as busy goes again when the turn ends; news that came meanwhile rides along', async () => {
  const { wakes, sent, setAnswer, setSessions, emit, advance } = setUp()
  // A turn that started between the look and the send.
  setAnswer({ ok: false, code: 'busy' })
  wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'behind' }]) })
  await settle()
  assert.equal(sent.length, 1)
  setSessions([session({ status: 'active', phase: 'running' })])
  wakes.deliver({ conversation: CHAT, wake: wake(234, [{ kind: 'conflicting' }]) })
  await settle()
  assert.equal(sent.length, 1)
  setSessions([session()])
  setAnswer({ ok: true })
  emit({ type: 'turn_completed' })
  await advance(1_500)
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /- It is behind main[^\n]*\n- It conflicts with main/)
  assert.notEqual(sent[0].commandId, sent[1].commandId, 'each send is its own command')
})
