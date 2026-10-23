import { expect, test } from 'vitest'
import type { ShellNotice } from '../server/shell-bridge/shell-bridge'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { createAgentAttention } from './agent-attention'
import { createAgentNotifier } from './agent-notifications'
import { createConversationAttentionListener } from './conversation-attention'

function harness(platform = 'darwin', focused = false) {
  const bounces: number[] = []
  const badges: number[] = []
  const flashes: boolean[] = []
  const raised: string[] = []
  const window = {
    isDestroyed: () => false,
    isFocused: () => focused,
    flashFrame: (flag: boolean) => flashes.push(flag),
    ...Object.fromEntries(
      ['focus', 'show', 'restore', 'moveTop', 'setAlwaysOnTop'].map((method) => [method, () => raised.push(method)]),
    ),
  }
  const attention = createAgentAttention({
    platform,
    listWindows: () => [window],
    bounceDock: () => {
      bounces.push(1)
    },
    setBadgeCount: (count) => {
      badges.push(count)
    },
  })
  const notices: ShellNotice[] = []
  const notifier = createAgentNotifier({
    mode: () => 'banner',
    isAnyWindowFocused: () => focused,
    chatLabel: () => ({ title: 'Chat' }),
    show: (notice) => notices.push(notice),
  })
  const listener = createConversationAttentionListener({
    onAgentPhase: (event) => {
      attention.onAgentPhase(event)
      notifier.onAgentPhase(event)
    },
  })
  let seq = 0
  function send(type: ConversationEventType, payload?: Record<string, unknown>, agentId = 'agent') {
    listener({
      type,
      payload,
      id: String(++seq),
      seq,
      sessionId: agentId,
      agentId,
      workspaceId: 'workspace',
      providerId: 'provider',
      modelId: 'model',
      createdAt: seq,
    } satisfies ConversationEvent)
  }
  return { attention, listener, send, bounces, badges, flashes, raised, notices }
}

test('background conversation completion uses passive OS attention without raising a window', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const h = harness(platform)
    for (const type of [
      'session_started',
      'user_message',
      'turn_started',
      'content_delta',
      'reasoning_delta',
      'tool_started',
      'tool_output',
      'usage_updated',
    ] as const)
      h.send(type)
    expect(h.attention.pendingCount()).toBe(0)
    expect(h.bounces).toEqual([])
    expect(h.flashes).toEqual([])
    h.send('turn_completed')
    expect(h.attention.pendingCount()).toBe(1)
    expect(h.bounces).toEqual(platform === 'darwin' ? [1] : [])
    expect(h.flashes).toEqual(platform === 'win32' ? [true] : [])
    expect(h.badges).toEqual(platform === 'win32' ? [] : [1])
    expect(h.raised).toEqual([])
  }
})

test('concurrent approval decisions retain attention until the last decision and do not bounce twice', () => {
  const h = harness()
  h.send('approval_requested', { requestId: 'a' })
  h.send('approval_requested', { requestId: 'b' })
  h.send('tool_started')
  h.send('approval_resolved', { requestId: 'a' })
  expect(h.attention.pendingCount()).toBe(1)
  expect(h.bounces).toEqual([1])
  h.send('approval_resolved', { requestId: 'b' })
  expect(h.attention.pendingCount()).toBe(0)
  expect(h.badges).toEqual([1, 0])
  h.send('turn_failed')
  expect(h.attention.pendingCount()).toBe(1)
  expect(h.bounces).toEqual([1, 1])
  expect(h.raised).toEqual([])
})

test('new work or closing clears only that conversation, and closing never adds a notice', () => {
  const h = harness()
  h.send('turn_completed')
  h.send('turn_completed', undefined, 'another-agent')
  h.send('user_message')
  expect(h.attention.pendingCount()).toBe(1)
  h.send('session_closed', undefined, 'another-agent')
  expect(h.attention.pendingCount()).toBe(0)
  expect(h.bounces).toEqual([1, 1])
  h.send('approval_requested', { requestId: 'fresh' }, 'another-agent')
  expect(h.bounces).toEqual([1, 1, 1])
})

test('a focused app and malformed approval hints do not notify', () => {
  const h = harness('darwin', true)
  h.send('approval_requested', { requestId: 'a' })
  h.send('turn_completed')
  expect(h.attention.pendingCount()).toBe(0)
  expect(h.bounces).toEqual([])
  const background = harness()
  background.send('approval_requested')
  background.send('approval_resolved')
  expect(background.attention.pendingCount()).toBe(0)
  expect(background.bounces).toEqual([])
})

test('remembered grants never request human attention or clear another outstanding approval', () => {
  const h = harness()
  h.send('approval_requested', { requestId: 'automatic', autoApproved: true, ruleLabel: 'Read files' })
  h.send('approval_resolved', { requestId: 'automatic', autoApproved: true })
  expect(h.bounces).toEqual([])
  h.send('approval_requested', { requestId: 'human' })
  h.send('approval_requested', { requestId: 'automatic', autoApproved: true })
  h.send('approval_resolved', { requestId: 'automatic', autoApproved: true })
  expect(h.attention.pendingCount()).toBe(1)
  expect(h.bounces).toEqual([1])
})

test('a turn a steered message ended is not a completion, and a card raised as it lands keeps attention', () => {
  const h = harness()
  h.send('user_message')
  h.send('turn_started')
  h.send('turn_completed', { steered: true })
  h.send('user_message')
  h.send('turn_started')
  expect(h.attention.pendingCount()).toBe(0)
  expect(h.bounces).toEqual([])
  h.send('approval_requested', { requestId: 'a' })
  h.send('user_message')
  h.send('turn_started')
  expect(h.attention.pendingCount()).toBe(1)
  h.send('approval_resolved', { requestId: 'a' })
  h.send('turn_completed')
  expect(h.bounces).toEqual([1, 1])
})

test('a conversation is remembered only while an approval it raised is outstanding', () => {
  const h = harness()
  // A whole turn, then one Settle interrupted while it waited on a card: Settle
  // sends no session_closed, so nothing may be left behind by either.
  h.send('session_started')
  h.send('user_message')
  h.send('turn_started')
  h.send('tool_started')
  expect(h.listener.trackedSessions()).toBe(0)
  h.send('approval_requested', { requestId: 'a' }, 'settled')
  expect(h.listener.trackedSessions()).toBe(1)
  h.send('user_message', undefined, 'settled')
  expect(h.listener.trackedSessions()).toBe(1)
  h.send('turn_failed', { reason: 'interrupted' }, 'settled')
  h.send('turn_completed')
  expect(h.listener.trackedSessions()).toBe(0)
  expect(h.bounces).toEqual([1, 1])
  // A card raised again after that is news again.
  h.send('approval_requested', { requestId: 'b' }, 'settled')
  expect(h.bounces).toEqual([1, 1, 1])
  h.send('approval_requested', { requestId: 'c' }, 'settled')
  expect(h.bounces).toEqual([1, 1, 1])
})

test("a background agent's step after its turn ended neither clears the turn's notice nor reads as working", () => {
  const h = harness()
  h.send('user_message', { turnId: 'turn-1' })
  h.send('turn_completed', { turnId: 'turn-1' })
  expect(h.attention.pendingCount()).toBe(1)
  h.send('tool_started', { parentToolUseId: 'toolu_bg', name: 'Edit' })
  h.send('tool_output', { parentToolUseId: 'toolu_bg', toolUseId: 'child_1' })
  expect(h.attention.pendingCount()).toBe(1)
  // The model's own work after that is new work, and clears it.
  h.send('turn_started', { turnId: 'turn-2' })
  expect(h.attention.pendingCount()).toBe(0)
})

test('a turn the person stopped goes idle without a bounce or a banner', () => {
  // Claude and the runtime fail it with the reason, an ACP agent with the bare
  // word as its message, and Codex completes it marked interrupted.
  for (const [type, payload] of [
    ['turn_failed', { reason: 'interrupted' }],
    ['turn_failed', { message: 'interrupted' }],
    ['turn_completed', { interrupted: true }],
  ] as const) {
    const h = harness()
    h.send('user_message')
    h.send('turn_started')
    h.send(type, payload)
    expect(h.bounces).toEqual([])
    expect(h.badges).toEqual([])
    expect(h.notices).toEqual([])
  }
})

test('a turn that finished or failed on its own still bounces and says which', () => {
  const h = harness()
  h.send('turn_completed', { interrupted: false })
  expect(h.bounces).toEqual([1])
  expect(h.notices.map((notice) => notice.body)).toEqual(['Finished.'])
  h.send('turn_failed', { reason: 'provider_error', message: 'Rate limited' }, 'another-agent')
  expect(h.bounces).toEqual([1, 1])
  expect(h.notices.map((notice) => notice.body)).toEqual(['Finished.', 'Stopped with an error.'])
})
