import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch } from '../../shared/workspace-sync'
import { normalizeSettledChatsSettings } from '../../shared/workspace-settlement'
import { createConversationLifecycle } from '../../main/automation/conversation-lifecycle'
import type { SettlementTerminal } from '../../main/automation/workspace-settlement-sweep'
import { createStudioSettlement } from './studio-settlement'

// The rest sweep as the core wires it: what it reads of the core's state, the
// triggers it listens to, and what a settle it makes puts away. No window.

const DAY = 24 * 60 * 60 * 1000
const BORN = 1_000_000_000_000

function harness(
  records: Array<Partial<WorkspaceRegistryRecord>>,
  options: { known?: boolean; listed?: boolean } = {},
) {
  let clock = BORN + 4 * DAY
  const pending: Array<() => void> = []
  const store = new Map<string, WorkspaceRegistryRecord>()
  for (const fields of records)
    store.set(fields.id!, {
      name: 'chat',
      mode: 'standard',
      createdAt: BORN,
      autoSettleEnabled: true,
      revision: 1,
      ...fields,
    } as WorkspaceRegistryRecord)
  const state = {
    activeWorkspaceId: null as string | null,
    workspaceWindows: [] as Array<{ activeWorkspaceId: string | null }>,
  }
  const registryListeners = new Set<() => void>()
  const eventListeners = new Set<(event: ConversationEvent) => void>()
  const settingsListeners = new Set<() => void>()
  const terminalListeners = new Set<() => void>()
  let chats: ConversationSessionSummary[] = []
  let terminals: SettlementTerminal[] = []
  let known = options.known ?? true
  let listed = options.listed ?? true
  const suspended: string[] = []
  const ended: string[] = []
  const turnEnds: Array<[string, number]> = []

  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => store.get(workspaceId) ?? null,
    updateWorkspaceFields: (workspaceId, patch) => {
      const record = store.get(workspaceId)!
      applyWorkspaceFieldsPatch(record as unknown as Record<string, unknown>, patch)
      record.revision += 1
      for (const listener of [...registryListeners]) listener()
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('not here'),
    isWorking: () => false,
    isBusy: (workspaceId) => settlement.isBusy(workspaceId),
    now: () => clock,
  })
  const settlement = createStudioSettlement({
    registry: {
      getRecords: () => [...store.values()],
      getRecord: (workspaceId) => store.get(workspaceId) ?? null,
      getState: () => state as never,
      subscribe: (listener) => {
        registryListeners.add(listener)
        return () => registryListeners.delete(listener)
      },
    },
    conversations: {
      listSessions: (input) => ({
        ok: true,
        sessions: chats.filter((session) => !input?.workspaceId || session.workspaceId === input.workspaceId),
      }),
      onEvent: (listener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      suspendSession: async ({ sessionId }) => {
        suspended.push(sessionId)
      },
    },
    pullRequests: {
      whenLoaded: () => Promise.resolve(),
      forWorkspace: () => [],
      onChanged: () => () => undefined,
    },
    settings: {
      get: () => normalizeSettledChatsSettings(undefined),
      known: () => known,
      subscribe: (listener) => {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
    },
    terminals: {
      list: () => terminals,
      listed: () => listed,
      onChanged: (listener) => {
        terminalListeners.add(listener)
        return () => terminalListeners.delete(listener)
      },
      end: (workspaceId) => ended.push(workspaceId),
    },
    lifecycle,
    recordTurnEnd: (workspaceId, at) => {
      turnEnds.push([workspaceId, at])
      store.get(workspaceId)!.lastTurnEndedAt = at
    },
    onResume: () => () => undefined,
    now: () => clock,
    // Every timer runs on the next `flush`, whatever its delay: the minute's
    // tick is driven by hand below.
    schedule: (job) => {
      let cancelled = false
      pending.push(() => {
        if (!cancelled) job()
      })
      return () => {
        cancelled = true
      }
    },
  })
  const flush = async () => {
    await Promise.resolve()
    for (let round = 0; round < 5 && pending.length > 0; round += 1) for (const job of pending.splice(0)) job()
  }
  return {
    settlement,
    lifecycle,
    flush,
    row: (id: string) => store.get(id)!,
    state,
    suspended,
    ended,
    turnEnds,
    setChats: (next: Array<Partial<ConversationSessionSummary>>) => {
      chats = next as ConversationSessionSummary[]
    },
    setTerminals: (next: SettlementTerminal[]) => {
      terminals = next
      for (const listener of [...terminalListeners]) listener()
    },
    push: () => {
      known = true
      for (const listener of [...settingsListeners]) listener()
    },
    list: () => {
      listed = true
      for (const listener of [...terminalListeners]) listener()
    },
    emit: (event: Partial<ConversationEvent>) => {
      for (const listener of [...eventListeners]) listener(event as ConversationEvent)
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test('nothing settles on settings no window has pushed; the first push sweeps at once', async () => {
  const h = harness([{ id: 'quiet' }], { known: false })
  h.settlement.start()
  await h.flush()
  assert.equal(h.row('quiet').settledAt ?? null, null, 'defaults are not the person’s choice')
  h.push()
  await h.flush()
  assert.equal(typeof h.row('quiet').settledAt, 'number', 'the push is what it waited for')
})

test('nothing settles before the shell has listed its terminals; the first list sweeps at once', async () => {
  const h = harness([{ id: 'quiet' }], { listed: false })
  h.settlement.start()
  await h.flush()
  assert.equal(h.row('quiet').settledAt ?? null, null)
  h.list()
  await h.flush()
  assert.equal(typeof h.row('quiet').settledAt, 'number')
})

test('a settle the sweep makes suspends the chat’s idle sessions and ends its terminals', async () => {
  const h = harness([{ id: 'quiet' }])
  h.setChats([
    { sessionId: 'idle-chat', workspaceId: 'quiet', agentId: 'agent-1', status: 'ready' },
    { sessionId: 'old-chat', workspaceId: 'quiet', agentId: 'agent-2', status: 'stopped' },
  ])
  h.settlement.start()
  await h.flush()
  assert.equal(typeof h.row('quiet').settledAt, 'number')
  assert.deepEqual(h.suspended, ['idle-chat'], 'a stopped session has nothing to suspend')
  assert.deepEqual(h.ended, ['quiet'], 'its terminals end with it, window or none')
})

test('the chats on screen in any window are never settled, and one a window leaves is looked at again', async () => {
  const h = harness([{ id: 'shown' }, { id: 'other' }])
  h.state.workspaceWindows = [{ activeWorkspaceId: 'shown' }]
  h.settlement.start()
  await h.flush()
  assert.equal(h.row('shown').settledAt ?? null, null)
  assert.equal(typeof h.row('other').settledAt, 'number')
  h.state.workspaceWindows = [{ activeWorkspaceId: null }]
  // Any registry change is what says so.
  h.lifecycle.visit('other', BORN + 4 * DAY, 'ui')
  await h.flush()
  assert.equal(typeof h.row('shown').settledAt, 'number')
})

test('a chat whose agent starts working wakes on the chat event, and on the terminal changing', async () => {
  const h = harness([{ id: 'chat' }, { id: 'term' }])
  h.settlement.start()
  await h.flush()
  assert.equal(typeof h.row('chat').settledAt, 'number')
  assert.equal(typeof h.row('term').settledAt, 'number')

  h.setChats([{ sessionId: 's', workspaceId: 'chat', agentId: 'agent-1', status: 'active', phase: 'running' }])
  h.emit({ type: 'turn_started', workspaceId: 'chat', agentId: 'agent-1' })
  await h.flush()
  assert.equal(h.row('chat').settledAt ?? null, null, 'woken by the event')

  h.setTerminals([
    {
      sessionId: 'pty',
      kind: 'agent',
      workspaceId: 'term',
      processAlive: true,
      activity: { kind: 'working' },
    },
  ])
  await h.flush()
  assert.equal(h.row('term').settledAt ?? null, null, 'woken by the terminal list')
})

test('a window’s Settle is held to busy: a chat waiting on a question may be settled, one at work may not', () => {
  const h = harness([{ id: 'asking' }, { id: 'working' }])
  h.setChats([
    { sessionId: 'a', workspaceId: 'asking', agentId: 'agent-1', status: 'active', phase: 'waiting_for_input' },
    { sessionId: 'b', workspaceId: 'working', agentId: 'agent-1', status: 'active', phase: 'running' },
  ])
  assert.equal(h.settlement.isBusy('asking'), false)
  assert.equal(h.settlement.isBusy('working'), true)
  assert.equal(h.settlement.isBusy('nobody'), false)
})

test('a module chat settles on the run state a window pushed, and never on a guess', async () => {
  const h = harness([
    { id: 'module-running', mode: 'probe-type' },
    { id: 'module-quiet', mode: 'probe-type' },
    { id: 'module-unknown', mode: 'probe-type' },
  ])
  h.settlement.start()
  await h.flush()
  for (const id of ['module-running', 'module-quiet', 'module-unknown'])
    assert.equal(h.row(id).settledAt ?? null, null, `${id}: nothing pushed, nothing settled`)
  h.settlement.setModuleRunStates({
    'module-running': 'in_progress',
    'module-quiet': null,
    'module-unknown': 'not-a-state',
  })
  await h.flush()
  assert.equal(h.row('module-running').settledAt ?? null, null, 'a run in flight is pinned')
  assert.equal(typeof h.row('module-quiet').settledAt, 'number', 'a type with no run signal settles as any chat')
  assert.equal(h.row('module-unknown').settledAt ?? null, null, 'a state that is not one is not taken')
})

test('an agent terminal’s turn end the record has not heard is kept on the record, once', async () => {
  const h = harness([{ id: 'ran', lastTurnEndedAt: BORN }])
  h.settlement.start()
  const pty = (lastTurnEndedAt: number) => ({
    sessionId: 'pty',
    kind: 'agent',
    workspaceId: 'ran',
    processAlive: true,
    activity: { kind: 'idle' },
    lastTurnEndedAt,
  })
  h.setTerminals([pty(BORN + DAY)])
  assert.deepEqual(h.turnEnds, [['ran', BORN + DAY]], 'written while the terminal still holds it')
  h.setTerminals([pty(BORN + DAY)])
  assert.equal(h.turnEnds.length, 1, 'a turn end the record has is not written again')
  // The terminal exits: the record keeps what it said.
  h.setTerminals([])
  await h.flush()
  assert.equal(h.row('ran').lastTurnEndedAt, BORN + DAY)
})
