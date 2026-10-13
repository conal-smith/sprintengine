import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationEvent, ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { WindowActivity, WindowActivityState } from '../utils/windowActivity'
import {
  createConversationSessionsStore,
  groupConversationSessionsByWorkspace,
  isConversationStatusEvent,
  type ConversationSessionsApi,
} from './conversationSessionsStore'

afterEach(() => {
  vi.useRealTimers()
})

function fakeActivity(initial = true) {
  let state: WindowActivityState = { visible: initial, focused: initial }
  const listeners = new Set<(state: WindowActivityState) => void>()
  const activity: WindowActivity = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => listeners.clear(),
  }
  return {
    activity,
    set(visible: boolean) {
      state = { visible, focused: visible }
      for (const listener of [...listeners]) listener(state)
    },
  }
}

function summary(fields: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: 's1',
    workspaceId: 'w1',
    agentId: 'a1',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

function harness(initial: ConversationSessionSummary[] = [], visible = true) {
  let current = initial
  const list = vi.fn(async () => ({ ok: true as const, sessions: current.map((item) => ({ ...item })) }))
  let receive!: (event: ConversationEvent) => void
  const unsubscribe = vi.fn()
  const api: ConversationSessionsApi = {
    conversationSessionsList: list,
    onConversationEvent: (listener) => {
      receive = listener
      return unsubscribe
    },
  }
  const window = fakeActivity(visible)
  const store = createConversationSessionsStore({ api: () => api, activity: () => window.activity, refreshMs: 300 })
  const notified = vi.fn()
  const dispose = store.subscribe(notified)
  return {
    store,
    list,
    notified,
    unsubscribe,
    dispose,
    window,
    setSessions(next: ConversationSessionSummary[]) {
      current = next
    },
    emit(type: ConversationEvent['type'], fields: Partial<ConversationEvent> = {}) {
      receive({ type, sessionId: 's1', workspaceId: 'w1', createdAt: Date.now(), ...fields } as ConversationEvent)
    },
  }
}

test('lifecycle events refresh the list; token deltas and partial output never do, and bursts coalesce', async () => {
  vi.useFakeTimers()
  const h = harness()
  expect(h.list).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(0)
  h.emit('content_delta')
  h.emit('reasoning_delta')
  h.emit('tool_output', { payload: { partial: true } })
  await vi.advanceTimersByTimeAsync(400)
  expect(h.list).toHaveBeenCalledTimes(1)
  h.emit('tool_started')
  h.emit('tool_started')
  h.emit('tool_output')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.list).toHaveBeenCalledTimes(2)
  h.emit('user_message')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.list).toHaveBeenCalledTimes(3)
  h.emit('tool_started')
  h.dispose()
  await vi.advanceTimersByTimeAsync(400)
  expect(h.list).toHaveBeenCalledTimes(3)
  expect(h.unsubscribe).toHaveBeenCalledOnce()
})

test('partial tool output is not a status event, its final chunk is', () => {
  expect(isConversationStatusEvent({ type: 'tool_output', payload: { partial: true } })).toBe(false)
  expect(isConversationStatusEvent({ type: 'tool_output', payload: {} })).toBe(true)
  expect(isConversationStatusEvent({ type: 'content_delta' })).toBe(false)
  expect(isConversationStatusEvent({ type: 'turn_completed' })).toBe(true)
})

test('a refetch that changed nothing keeps every identity and notifies nobody', async () => {
  vi.useFakeTimers()
  const h = harness([summary(), summary({ sessionId: 's2', workspaceId: 'w2', agentId: 'a2' })])
  await vi.advanceTimersByTimeAsync(0)
  expect(h.notified).toHaveBeenCalledTimes(1)
  const first = h.store.getSnapshot()
  const w1 = h.store.getWorkspaceSnapshot('w1')
  h.emit('tool_started')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.list).toHaveBeenCalledTimes(2)
  expect(h.notified).toHaveBeenCalledTimes(1)
  expect(h.store.getSnapshot()).toBe(first)

  // One session moves: the list is new, the other session and its
  // workspace's slice are not.
  h.setSessions([
    summary({ lastAssistantText: 'Done.' }),
    summary({ sessionId: 's2', workspaceId: 'w2', agentId: 'a2' }),
  ])
  const w2 = h.store.getWorkspaceSnapshot('w2')
  h.emit('turn_completed')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.notified).toHaveBeenCalledTimes(2)
  const second = h.store.getSnapshot()
  expect(second).not.toBe(first)
  expect(second[1]).toBe(first[1])
  expect(h.store.getWorkspaceSnapshot('w2')).toBe(w2)
  expect(h.store.getWorkspaceSnapshot('w1')).not.toBe(w1)
  expect(h.store.getWorkspaceSnapshot('w1')[0]?.lastAssistantText).toBe('Done.')
})

test('fetches never overlap: an event during a fetch asks for one more after it', async () => {
  vi.useFakeTimers()
  const h = harness([summary()])
  let release!: () => void
  h.list.mockImplementationOnce(
    () => new Promise((resolve) => (release = () => resolve({ ok: true, sessions: [summary()] }))),
  )
  await vi.advanceTimersByTimeAsync(0)
  h.emit('tool_started')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.list).toHaveBeenCalledTimes(2)
  h.emit('tool_started')
  await vi.advanceTimersByTimeAsync(300)
  // Still out: the second event waits for it.
  expect(h.list).toHaveBeenCalledTimes(2)
  release()
  await vi.advanceTimersByTimeAsync(300)
  expect(h.list).toHaveBeenCalledTimes(3)
})

test('a hidden window fetches nothing and catches up once when shown', async () => {
  vi.useFakeTimers()
  const h = harness([summary()])
  await vi.advanceTimersByTimeAsync(0)
  h.window.set(false)
  h.emit('tool_started')
  h.emit('turn_completed')
  h.emit('user_message')
  await vi.advanceTimersByTimeAsync(2_000)
  expect(h.list).toHaveBeenCalledTimes(1)
  h.window.set(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.list).toHaveBeenCalledTimes(2)
  // Shown with nothing missed: no fetch.
  h.window.set(false)
  h.window.set(true)
  await vi.advanceTimersByTimeAsync(400)
  expect(h.list).toHaveBeenCalledTimes(2)
})

test('the working clock starts at the turn and does not restart when updatedAt moves mid-turn', async () => {
  vi.useFakeTimers()
  const h = harness([summary({ status: 'ready', phase: 'idle', updatedAt: 100, lastTurnEndedAt: 90 })])
  await vi.advanceTimersByTimeAsync(0)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBeUndefined()

  h.emit('turn_started', { createdAt: 1_000 })
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 1_000, lastTurnEndedAt: 90 })])
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(1_000)

  // An approval resolves, and main moves updatedAt: the turn did not restart.
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 5_000, lastTurnEndedAt: 90 })])
  h.emit('approval_resolved')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(1_000)

  // The turn ends; the next one starts from its own event.
  h.setSessions([summary({ status: 'ready', phase: 'completed', updatedAt: 6_000, lastTurnEndedAt: 6_000 })])
  h.emit('turn_completed')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBeUndefined()
  h.emit('turn_started', { createdAt: 7_000 })
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 7_000, lastTurnEndedAt: 6_000 })])
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(7_000)
})

test('a background agent waking the chat does not restart the working clock; the person sending does', async () => {
  vi.useFakeTimers()
  const h = harness([summary({ status: 'ready', phase: 'idle', updatedAt: 100, lastTurnEndedAt: 90 })])
  await vi.advanceTimersByTimeAsync(0)
  h.emit('turn_started', { createdAt: 1_000 })
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 1_000, lastUserMessageAt: 990 })])
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(1_000)

  // The turn ends with a background agent still out; when it finishes, the
  // runtime opens a turn of its own to hand the agent's result over.
  const background = { status: 'ready' as const, phase: 'completed' as const, backgroundAgents: 1 }
  h.setSessions([summary({ ...background, updatedAt: 3_000, lastTurnEndedAt: 3_000, lastUserMessageAt: 990 })])
  h.emit('turn_completed')
  await vi.advanceTimersByTimeAsync(300)
  h.emit('turn_started', { createdAt: 4_000 })
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 4_000, lastUserMessageAt: 990 })])
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(1_000)

  // The person sends a message, and that turn is counted from its own start.
  h.emit('turn_started', { createdAt: 6_000 })
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 6_000, lastUserMessageAt: 6_000 })])
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(6_000)
})

test('a window that opens mid-turn holds the first reading it had', async () => {
  vi.useFakeTimers()
  const h = harness([summary({ status: 'active', phase: 'running', updatedAt: 2_000 })])
  await vi.advanceTimersByTimeAsync(0)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(2_000)
  h.setSessions([summary({ status: 'active', phase: 'running', updatedAt: 9_000, modelId: 'opus' })])
  h.emit('session_updated')
  await vi.advanceTimersByTimeAsync(300)
  expect(h.store.getSnapshot()[0]?.turnStartedAt).toBe(2_000)
})

test('a window with no conversation API counts as listed at once', () => {
  const store = createConversationSessionsStore({ api: () => ({}), activity: () => fakeActivity().activity })
  expect(store.hasSnapshot()).toBe(false)
  store.subscribe(() => undefined)
  expect(store.hasSnapshot()).toBe(true)
  expect(store.getSnapshot()).toEqual([])
})

test('grouping keeps a workspace’s array while it holds the same sessions', () => {
  const a = { workspaceId: 'w1', id: 1 }
  const b = { workspaceId: 'w2', id: 2 }
  const first = groupConversationSessionsByWorkspace([a, b], null)
  const c = { workspaceId: 'w2', id: 3 }
  const second = groupConversationSessionsByWorkspace([a, c], first)
  expect(second.get('w1')).toBe(first.get('w1'))
  expect(second.get('w2')).not.toBe(first.get('w2'))
})
