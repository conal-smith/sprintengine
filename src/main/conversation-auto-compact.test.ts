import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../shared/conversation-runtime'
import {
  AUTO_COMPACT_EXPIRY_SKEW_MS,
  autoCompactPlan,
  createAutoCompactScheduler,
  type AutoCompactChat,
} from './conversation-auto-compact'

// Auto compact's timing and its rules: when a compaction is sent for each
// cache lifetime, the guard against sending one too late, the size floor,
// what counts as idle, and the chats it leaves alone.

const NOW = Date.UTC(2026, 9, 21, 9, 0, 0)
const MINUTE = 60_000

function session(overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    status: 'ready',
    phase: 'completed',
    createdAt: NOW - 30 * MINUTE,
    updatedAt: NOW - MINUTE,
    promptCache: { ttl: '5m', expiresAt: NOW + 4 * MINUTE, recacheTokens: 221_000 },
    ...overrides,
  }
}

const chat = (overrides: Partial<AutoCompactChat> = {}): AutoCompactChat => ({
  autoCompactEnabled: true,
  settled: false,
  remote: false,
  ...overrides,
})

const skew = AUTO_COMPACT_EXPIRY_SKEW_MS

test('a five-minute cache is compacted a minute before it expires, an hour’s five minutes before', () => {
  assert.deepEqual(autoCompactPlan(session(), chat(), false, NOW), {
    kind: 'at',
    at: NOW + 4 * MINUTE - skew - MINUTE,
    expiresAt: NOW + 4 * MINUTE,
  })
  const hour = session({ promptCache: { ttl: '1h', expiresAt: NOW + 40 * MINUTE, recacheTokens: 221_000 } })
  assert.deepEqual(autoCompactPlan(hour, chat(), false, NOW), {
    kind: 'at',
    at: NOW + 40 * MINUTE - skew - 5 * MINUTE,
    expiresAt: NOW + 40 * MINUTE,
  })
})

test('never with under twenty seconds of cache left, the late stamp allowed for', () => {
  const late = session({ promptCache: { ttl: '5m', expiresAt: NOW + 24_000, recacheTokens: 221_000 } })
  assert.deepEqual(autoCompactPlan(late, chat(), false, NOW), { kind: 'skip', reason: 'too late' })
  const inTime = session({ promptCache: { ttl: '5m', expiresAt: NOW + 30_000, recacheTokens: 221_000 } })
  assert.equal(autoCompactPlan(inTime, chat(), false, NOW).kind, 'at')
})

test('only a conversation of at least 100k tokens', () => {
  const small = session({ promptCache: { ttl: '5m', expiresAt: NOW + 4 * MINUTE, recacheTokens: 99_999 } })
  assert.deepEqual(autoCompactPlan(small, chat(), false, NOW), { kind: 'skip', reason: 'small' })
  const unknown = session({ promptCache: { ttl: '5m', expiresAt: NOW + 4 * MINUTE, recacheTokens: null } })
  assert.equal(autoCompactPlan(unknown, chat(), false, NOW).kind, 'skip')
  const nothing = session({ promptCache: { ttl: '5m', expiresAt: null, recacheTokens: 221_000 } })
  assert.deepEqual(autoCompactPlan(nothing, chat(), false, NOW), { kind: 'skip', reason: 'nothing cached' })
})

test('only while idle: no turn, no card waiting, no agent, shell or monitor', () => {
  const busy = (overrides: Partial<ConversationSessionSummary>) =>
    autoCompactPlan(session(overrides), chat(), false, NOW)
  assert.deepEqual(busy({ status: 'active', phase: 'running' }), { kind: 'skip', reason: 'busy' })
  assert.deepEqual(busy({ status: 'awaiting_approval', phase: 'waiting_for_approval' }), {
    kind: 'skip',
    reason: 'busy',
  })
  assert.deepEqual(busy({ status: 'starting', phase: 'starting' }), { kind: 'skip', reason: 'busy' })
  assert.deepEqual(busy({ backgroundAgents: 1 }), { kind: 'skip', reason: 'busy' })
  assert.deepEqual(busy({ backgroundTasks: [{ taskId: 'dev', kind: 'command' }] }), { kind: 'skip', reason: 'busy' })
  // A child the idle sweep ended is still idle: the send starts it again.
  assert.equal(busy({ resting: true }).kind, 'at')
})

test('a settled chat, a paired machine’s, a chat that is not Claude, or one switched off, is left alone', () => {
  assert.deepEqual(autoCompactPlan(session(), chat({ settled: true }), false, NOW), { kind: 'skip', reason: 'settled' })
  assert.deepEqual(autoCompactPlan(session(), chat({ remote: true }), false, NOW), { kind: 'skip', reason: 'remote' })
  assert.deepEqual(autoCompactPlan(session({ providerId: 'codex' }), chat(), false, NOW), {
    kind: 'skip',
    reason: 'not Claude',
  })
  assert.deepEqual(autoCompactPlan(session(), chat({ autoCompactEnabled: false }), true, NOW), {
    kind: 'skip',
    reason: 'off',
  })
  assert.deepEqual(autoCompactPlan(session(), null, true, NOW), { kind: 'skip', reason: 'no chat' })
})

test('a chat that leaves it unset follows the default, which is off unless switched on', () => {
  assert.deepEqual(autoCompactPlan(session(), chat({ autoCompactEnabled: null }), false, NOW), {
    kind: 'skip',
    reason: 'off',
  })
  assert.equal(autoCompactPlan(session(), chat({ autoCompactEnabled: null }), true, NOW).kind, 'at')
})

function clock() {
  let now = NOW
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = []
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { at: now + ms, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer: unknown) => {
      ;(timer as { cleared: boolean }).cleared = true
    },
    // Move the clock, running every timer that comes due on the way.
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cleared && timer.at <= until)
          .sort((left, right) => left.at - right.at)[0]
        if (!due) break
        due.cleared = true
        now = Math.max(now, due.at)
        due.callback()
      }
      now = until
    },
    // The machine slept through `ms`: no timer ran meanwhile.
    sleep(ms: number) {
      now += ms
    },
  }
}

function scheduler(overrides: { sessions?: ConversationSessionSummary[]; chat?: AutoCompactChat } = {}) {
  const time = clock()
  const sent: string[] = []
  let sessions = overrides.sessions ?? [session()]
  const compact = createAutoCompactScheduler({
    listSessions: () => sessions,
    chat: () => overrides.chat ?? chat(),
    enabledByDefault: () => false,
    send: async (_session, commandId) => {
      sent.push(commandId)
      return { ok: true }
    },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  return {
    time,
    sent,
    compact,
    setSessions: (next: ConversationSessionSummary[]) => {
      sessions = next
    },
  }
}

test('the scheduler sends `/compact` once, when its time comes', () => {
  const s = scheduler()
  s.compact.recompute()
  assert.equal(s.compact.armed(), 1)
  s.time.advance(2 * MINUTE)
  assert.deepEqual(s.sent, [])
  s.time.advance(MINUTE)
  assert.deepEqual(s.sent, [`auto-compact:session-1:${NOW + 4 * MINUTE}`])
  // The same reading is never sent again, however often it is looked at.
  s.compact.recompute()
  s.time.advance(MINUTE)
  assert.equal(s.sent.length, 1)
})

test('a chat that starts working before its time is not compacted', () => {
  const s = scheduler()
  s.compact.recompute()
  s.setSessions([session({ status: 'active', phase: 'running' })])
  s.time.advance(3 * MINUTE)
  assert.deepEqual(s.sent, [])
})

test('a request that refreshes the cache moves the compaction with it', () => {
  const s = scheduler()
  s.compact.recompute()
  s.time.advance(2 * MINUTE)
  s.setSessions([session({ promptCache: { ttl: '5m', expiresAt: NOW + 7 * MINUTE, recacheTokens: 230_000 } })])
  s.compact.recompute()
  s.time.advance(MINUTE + 10_000)
  assert.deepEqual(s.sent, [])
  s.time.advance(3 * MINUTE)
  assert.deepEqual(s.sent, [`auto-compact:session-1:${NOW + 7 * MINUTE}`])
})

test('waking from sleep looks again, and sends nothing with under twenty seconds left', () => {
  const s = scheduler()
  s.compact.recompute()
  // Asleep through the minute it was due, and woken with ten seconds left.
  s.time.sleep(4 * MINUTE - skew - 10_000)
  s.compact.recompute()
  s.time.advance(0)
  assert.deepEqual(s.sent, [])
  assert.equal(s.compact.armed(), 0)
})

test('waking from sleep with time still left sends at once', () => {
  const s = scheduler()
  s.compact.recompute()
  s.time.sleep(3 * MINUTE + 20_000)
  s.compact.recompute()
  s.time.advance(0)
  assert.equal(s.sent.length, 1)
})

test('a session that has gone is forgotten, its timer with it', () => {
  const s = scheduler()
  s.compact.recompute()
  s.setSessions([])
  s.compact.recompute()
  assert.equal(s.compact.armed(), 0)
  s.time.advance(5 * MINUTE)
  assert.deepEqual(s.sent, [])
})

test('settled, paired-machine and non-Claude chats arm nothing', () => {
  for (const each of [
    scheduler({ chat: chat({ settled: true }) }),
    scheduler({ chat: chat({ remote: true }) }),
    scheduler({ sessions: [session({ providerId: 'codex' })] }),
  ]) {
    each.compact.recompute()
    assert.equal(each.compact.armed(), 0)
    each.time.advance(5 * MINUTE)
    assert.deepEqual(each.sent, [])
  }
})
