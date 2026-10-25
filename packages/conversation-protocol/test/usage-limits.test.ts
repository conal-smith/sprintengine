// What the desktop a chat runs on knows of its agents' usage limits:
// `watchUsageLimits`, the `usageLimits` frame and `usageLimitResume`, each read
// as the contract says and refused where it must be, with what an older
// desktop does with each.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationFrame } from '../src/index'
import {
  CONVERSATION_COMMAND_KINDS,
  CONVERSATION_MAX_USAGE_LIMIT_PLANS,
  CONVERSATION_MAX_USAGE_LIMIT_WINDOWS,
} from '../src/commands'
import { CONVERSATION_CAPABILITIES, CONVERSATION_USAGE_LIMITS_CAPABILITY } from '../src/handshake'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { isKnownConversationServerFrameType, parseConversationServerFrame } from '../src/serverFrames'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const command = (body: Record<string, unknown>, commandId = 'cmd-1') => ({ type: 'command', commandId, command: body })
const RESET = Date.UTC(2026, 9, 25, 23, 40)

const window = {
  id: 'five_hour',
  label: 'Session (5h)',
  usedPercent: 100,
  resetsAt: RESET,
  durationMs: 5 * 60 * 60_000,
  status: 'rejected',
  observedAt: 10,
}

test('the capability and the command kind are named in the contract', () => {
  assert.equal(CONVERSATION_USAGE_LIMITS_CAPABILITY, 'conversation-usage-limits')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_USAGE_LIMITS_CAPABILITY))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('usageLimitResume'))
})

test("a resume names what to do with the chat's notice, and only a schedule may say always", () => {
  for (const action of ['schedule', 'cancel', 'dismiss', 'retry'])
    assert.deepEqual(parseConversationClientMessage(command({ kind: 'usageLimitResume', action, note: 1 })), {
      type: 'command',
      commandId: 'cmd-1',
      command: { kind: 'usageLimitResume', action },
    })
  assert.deepEqual(
    parseConversationClientMessage(command({ kind: 'usageLimitResume', action: 'schedule', always: true })),
    { type: 'command', commandId: 'cmd-1', command: { kind: 'usageLimitResume', action: 'schedule', always: true } },
  )
  for (const body of [
    { action: 'resume' },
    {},
    { action: 'cancel', always: true },
    { action: 'schedule', always: 'yes' },
  ]) {
    const frame = command({ kind: 'usageLimitResume', ...body })
    assert.equal(parseConversationClientMessage(frame), null, JSON.stringify(body))
    assert.equal(explainRejectedConversationMessage(frame).code, 'invalid_frame', JSON.stringify(body))
  }
  // An older desktop knows no such kind, and says so under the command id.
  assert.equal(
    explainRejectedConversationFrame(command({ kind: 'usageLimitResume', action: 'schedule' })).code,
    'unsupported_command',
  )
})

test('watchUsageLimits is a request of its own', () => {
  assert.deepEqual(parseConversationClientMessage({ type: 'watchUsageLimits', requestId: 'r-1' }), {
    type: 'watchUsageLimits',
    requestId: 'r-1',
  })
  assert.equal(parseConversationClientMessage({ type: 'watchUsageLimits' }), null)
})

test('a usageLimits frame keeps the notice and the plans, and leaves out what it cannot read', () => {
  assert.equal(isKnownConversationServerFrameType({ type: 'usageLimits' }), true)
  const frame = parseConversationServerFrame({
    type: 'usageLimits',
    key,
    notice: {
      provider: 'claude',
      limit: 'session',
      resetsAt: RESET,
      hitAt: 5,
      resumeAt: null,
      failure: 'The chat has no folder here',
      extra: true,
    },
    autoResume: false,
    limits: [
      {
        provider: 'claude',
        billing: 'subscription',
        plan: 'max',
        observedAt: 10,
        windows: [
          window,
          { ...window, id: 'seven_day', label: 'Weekly', usedPercent: 140, status: 'warning', scope: 'model' },
          { ...window, id: 'broken', status: 'gone' },
        ],
      },
      { provider: 'Not A Token', observedAt: 1, windows: [] },
    ],
  })
  assert.deepEqual(frame, {
    type: 'usageLimits',
    key,
    notice: {
      provider: 'claude',
      limit: 'session',
      resetsAt: RESET,
      hitAt: 5,
      resumeAt: null,
      failure: 'The chat has no folder here',
    },
    autoResume: false,
    limits: [
      {
        provider: 'claude',
        plan: 'max',
        observedAt: 10,
        windows: [
          window,
          { ...window, id: 'seven_day', label: 'Weekly', usedPercent: 100, status: 'warning', scope: 'model' },
        ],
      },
    ],
  })
})

test('a notice it cannot read is none, and the frame needs its key, its setting and its plans', () => {
  const unread = parseConversationServerFrame({
    type: 'usageLimits',
    key,
    notice: { provider: 'claude', hitAt: 'yesterday' },
    autoResume: true,
    limits: [],
  })
  assert.ok(unread?.type === 'usageLimits')
  assert.equal(unread.notice, null)
  for (const broken of [
    { key, notice: null, limits: [] },
    { key, notice: null, autoResume: true },
    { notice: null, autoResume: true, limits: [] },
  ])
    assert.equal(parseConversationServerFrame({ type: 'usageLimits', ...broken }), null, JSON.stringify(broken))
})

test('a usageLimits frame names at most the bound of plans and of windows', () => {
  const frame = parseConversationServerFrame({
    type: 'usageLimits',
    key,
    notice: null,
    autoResume: false,
    limits: Array.from({ length: CONVERSATION_MAX_USAGE_LIMIT_PLANS + 2 }, () => ({
      provider: 'codex',
      observedAt: 1,
      windows: Array.from({ length: CONVERSATION_MAX_USAGE_LIMIT_WINDOWS + 2 }, (_, index) => ({
        ...window,
        id: `w-${index}`,
      })),
    })),
  })
  assert.ok(frame?.type === 'usageLimits')
  assert.equal(frame.limits.length, CONVERSATION_MAX_USAGE_LIMIT_PLANS)
  assert.equal(frame.limits[0]!.windows.length, CONVERSATION_MAX_USAGE_LIMIT_WINDOWS)
})
