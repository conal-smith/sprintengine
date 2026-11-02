import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import { normalizeSettledChatsSettings, type SettledChatsSettings } from '../../shared/workspace-settlement'
import { createConversationLifecycle, type SweepDecision } from './conversation-lifecycle'
import {
  SETTLEMENT_SWEEP_INTERVAL_MS,
  createWorkspaceSettlementSweep,
  settlementSignals,
  type SettlementSignals,
} from './workspace-settlement-sweep'

// Main's rest sweep, end to end through main's lifecycle: no window, no
// renderer, a clock and a scheduler the test turns by hand.

const DAY = 24 * 60 * 60 * 1000
const BORN = 1_000_000_000_000

type Timer = { at: number; job: () => void; cancelled: boolean }

function harness(records: Array<Partial<WorkspaceRegistryRecord>>) {
  let clock = BORN
  const timers: Timer[] = []
  const store = new Map<string, WorkspaceRegistryRecord>()
  for (const fields of records) {
    const record = {
      name: 'chat',
      mode: 'standard',
      createdAt: BORN,
      autoSettleEnabled: true,
      revision: 1,
      ...fields,
    } as WorkspaceRegistryRecord
    store.set(record.id, record)
  }
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch }> = []
  const signals = new Map<string, SettlementSignals>()
  const pullRequests = new Map<string, readonly BranchPullRequest[]>()
  let pullRequestsLoaded = true
  let settings: SettledChatsSettings = normalizeSettledChatsSettings(undefined)
  let onScreen = new Set<string>()
  const settledIds: string[] = []
  const commits: SweepDecision[] = []
  let ready = true
  // Runs while a pass commits, as a registry listener would.
  let duringCommit: (() => void) | null = null

  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => store.get(workspaceId) ?? null,
    updateWorkspaceFields: (workspaceId, patch) => {
      const record = store.get(workspaceId)!
      writes.push({ workspaceId, patch })
      applyWorkspaceFieldsPatch(record as unknown as Record<string, unknown>, patch)
      record.revision += 1
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('the sweep never moves the visit clock'),
    isWorking: () => false,
    now: () => clock,
  })
  const sweep = createWorkspaceSettlementSweep({
    records: () => [...store.values()],
    record: (workspaceId) => store.get(workspaceId) ?? null,
    onScreen: () => onScreen,
    signals: (record) => signals.get(record.id) ?? { busy: false, held: false },
    pullRequests: (workspaceId) => (pullRequestsLoaded ? (pullRequests.get(workspaceId) ?? []) : undefined),
    settings: () => settings,
    ready: () => ready,
    commit: (decision) => {
      commits.push(decision)
      duringCommit?.()
      return lifecycle.applySweepDecision(decision)
    },
    settled: (workspaceId) => settledIds.push(workspaceId),
    now: () => clock,
    schedule: (job, ms) => {
      const timer = { at: clock + ms, job, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })

  /** Move the clock on, running every timer that comes due on the way, in order. */
  const advance = (ms: number) => {
    const until = clock + ms
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cancelled = true
      clock = Math.max(clock, due.at)
      due.job()
    }
    clock = until
  }
  const settle = () => advance(0)

  return {
    store,
    writes,
    signals,
    pullRequests,
    settledIds,
    commits,
    sweep,
    lifecycle,
    advance,
    settle,
    row: (id: string) => store.get(id)!,
    now: () => clock,
    setClock: (at: number) => {
      clock = at
    },
    setOnScreen: (ids: string[]) => {
      onScreen = new Set(ids)
    },
    setSettings: (next: Partial<SettledChatsSettings>) => {
      settings = { ...settings, ...next }
    },
    setPullRequestsLoaded: (loaded: boolean) => {
      pullRequestsLoaded = loaded
    },
    setReady: (value: boolean) => {
      ready = value
    },
    onCommit: (run: (() => void) | null) => {
      duringCommit = run
    },
    timersPending: () => timers.filter((timer) => !timer.cancelled).length,
  }
}

const merged = (endedAt: number): BranchPullRequest => ({
  url: 'https://github.com/acme/app/pull/1',
  repoKey: 'github.com/acme/app',
  repoName: 'app',
  number: 1,
  title: 'Fix it',
  state: 'merged',
  isDraft: false,
  openedAt: BORN,
  stateAt: endedAt,
  endedAt,
})

test('with no window at all, a quiet chat settles on the minute after its quiet days, stamped then', () => {
  const h = harness([{ id: 'quiet' }])
  h.sweep.start()
  h.settle()
  assert.equal(h.row('quiet').settledAt ?? null, null, 'not before its three days')
  h.advance(3 * DAY + SETTLEMENT_SWEEP_INTERVAL_MS)
  assert.equal(typeof h.row('quiet').settledAt, 'number', 'the minute’s pass settled it')
  // The clock is read as the decision is taken: never a stale one.
  assert.ok(h.row('quiet').settledAt! >= BORN + 3 * DAY, 'stamped on the clock as it is now')
  assert.ok(h.row('quiet').settledAt! <= h.now())
  assert.equal(h.row('quiet').settledOverride ?? null, null, 'and no hand decision is recorded')
  assert.deepEqual(h.settledIds, ['quiet'], 'its processes are put away')
})

test('a second pass over the same chats writes nothing', () => {
  const h = harness([{ id: 'a' }, { id: 'b', autoSettleEnabled: null }])
  h.setClock(BORN + 4 * DAY)
  h.sweep.start()
  h.settle()
  assert.equal(h.writes.length, 1, 'one chat settles')
  h.sweep.request()
  h.settle()
  h.advance(SETTLEMENT_SWEEP_INTERVAL_MS * 3)
  assert.equal(h.writes.length, 1, 'and nothing more is written, however often it looks')
})

test('a chat on screen in some window, at work, or wanting the person is never settled', () => {
  const h = harness([{ id: 'shown' }, { id: 'busy' }, { id: 'held' }, { id: 'free' }])
  h.setOnScreen(['shown'])
  h.signals.set('busy', { busy: true, held: false })
  h.signals.set('held', { busy: false, held: true })
  h.setClock(BORN + 4 * DAY)
  h.sweep.start()
  h.settle()
  assert.equal(h.row('shown').settledAt ?? null, null)
  assert.equal(h.row('busy').settledAt ?? null, null)
  assert.equal(h.row('held').settledAt ?? null, null)
  assert.equal(typeof h.row('free').settledAt, 'number')

  // Leaving the chat on screen is what makes it due: the registry change says so.
  h.setOnScreen([])
  h.sweep.noteRegistryChanged()
  h.settle()
  assert.equal(typeof h.row('shown').settledAt, 'number', 'a chat a window left is looked at again at once')
})

test('a resting chat at work wakes at once; one wanting the person wakes only from a sweep settle', () => {
  const h = harness([{ id: 'swept' }, { id: 'hand', settledAt: BORN, settledOverride: 'settled' }])
  h.setClock(BORN + 4 * DAY)
  h.sweep.start()
  h.settle()
  assert.equal(typeof h.row('swept').settledAt, 'number')

  h.signals.set('swept', { busy: false, held: true })
  h.signals.set('hand', { busy: false, held: true })
  h.sweep.request(['swept', 'hand'])
  h.settle()
  assert.equal(h.row('swept').settledAt ?? null, null, 'a sweep-settled chat that wants the person comes back')
  assert.equal(typeof h.row('hand').settledAt, 'number', 'a hand Settle survives a chat that wants the person')

  h.signals.set('hand', { busy: true, held: false })
  h.sweep.request(['hand'])
  h.settle()
  assert.equal(h.row('hand').settledAt ?? null, null, 'work wakes even a hand Settle')
  assert.equal(h.row('hand').settledOverride ?? null, null, 'and spends the hand decision')
})

test('a merge settles a chat only when nobody wrote to it after the merge', () => {
  const h = harness([
    { id: 'landed', lastUserMessageAt: BORN + 1_000 },
    { id: 'carried-on', lastUserMessageAt: BORN + 3_000 },
  ])
  h.pullRequests.set('landed', [merged(BORN + 2_000)])
  h.pullRequests.set('carried-on', [merged(BORN + 2_000)])
  h.setClock(BORN + 5_000)
  h.sweep.start()
  h.settle()
  assert.equal(typeof h.row('landed').settledAt, 'number', 'its work landed after the last message')
  assert.equal(h.row('carried-on').settledAt ?? null, null, 'a message after the merge is the person carrying on')

  // Settle on merge off: nothing settles for a merge.
  const off = harness([{ id: 'landed' }])
  off.pullRequests.set('landed', [merged(BORN + 2_000)])
  off.setSettings({ settleOnPullRequestMerge: false })
  off.setClock(BORN + 5_000)
  off.sweep.start()
  off.settle()
  assert.equal(off.row('landed').settledAt ?? null, null)
})

test('with the keep on, the idle rule waits until the pull request record has been read', () => {
  const h = harness([{ id: 'quiet' }])
  h.setPullRequestsLoaded(false)
  h.setClock(BORN + 4 * DAY)
  h.sweep.start()
  h.settle()
  assert.equal(h.row('quiet').settledAt ?? null, null, '"no pull requests" is not known yet')
  h.setPullRequestsLoaded(true)
  h.sweep.request()
  h.settle()
  assert.equal(typeof h.row('quiet').settledAt, 'number')
})

test('a snooze is a hand decision the sweep never overrules, and its wake restarts the quiet days', () => {
  const wakeAt = BORN + 7 * DAY
  const h = harness([{ id: 'slept', snoozedUntil: wakeAt }])
  h.setClock(BORN + 6 * DAY)
  h.sweep.start()
  h.settle()
  assert.equal(h.row('slept').settledAt ?? null, null, 'a chat asleep is not settled')
  // It wakes a week quiet; the sweep counts from the wake, read on its own clock.
  h.advance(DAY + SETTLEMENT_SWEEP_INTERVAL_MS)
  assert.equal(h.row('slept').settledAt ?? null, null, 'not on the tick it wakes')
  h.advance(3 * DAY)
  assert.equal(typeof h.row('slept').settledAt, 'number', 'three days after the wake')
})

test('a decision on a chat that changed before it landed is refused', () => {
  const h = harness([{ id: 'quiet' }])
  h.setClock(BORN + 4 * DAY)
  // The person types into the chat while the pass is deciding.
  h.onCommit(() => {
    h.row('quiet').lastTerminalActivityAt = h.now()
    h.onCommit(null)
  })
  h.sweep.start()
  h.settle()
  assert.equal(h.commits.length, 1, 'a settle was decided')
  assert.equal(h.row('quiet').settledAt ?? null, null, 'and refused: the chat moved on')
  assert.equal(h.writes.length, 0)
})

test('a trigger during a pass runs as a pass of its own, after it', () => {
  const h = harness([{ id: 'a' }, { id: 'b' }])
  h.setClock(BORN + 4 * DAY)
  let asked = false
  h.onCommit(() => {
    if (asked) return
    asked = true
    // A registry listener hearing the first write asks for both chats again.
    h.sweep.request(['a', 'b'])
  })
  h.sweep.start()
  h.advance(0)
  assert.equal(typeof h.row('a').settledAt, 'number')
  assert.equal(typeof h.row('b').settledAt, 'number')
  assert.equal(h.writes.length, 2, 'the second pass found nothing left to do')
})

test('the sweep waits for the live state to have been read once, and stops when disposed', () => {
  const h = harness([{ id: 'quiet' }])
  h.setClock(BORN + 4 * DAY)
  h.setReady(false)
  h.sweep.start()
  h.settle()
  assert.equal(h.row('quiet').settledAt ?? null, null, 'every chat reads idle before the sessions are listed')
  h.setReady(true)
  h.advance(SETTLEMENT_SWEEP_INTERVAL_MS)
  assert.equal(typeof h.row('quiet').settledAt, 'number', 'the next minute looks')

  h.sweep.dispose()
  assert.equal(h.timersPending(), 0, 'no timer outlives it')
})

test('the live reading: at work, waiting on the person, an unseen finish, a watched pull request', () => {
  const record = { id: 'ws', lastTurnEndedAt: null, lastVisitedAt: BORN } as unknown as WorkspaceRegistryRecord
  const chat = (fields: Partial<ConversationSessionSummary>) =>
    ({
      sessionId: 's',
      workspaceId: 'ws',
      agentId: 'agent-1',
      status: 'ready',
      ...fields,
    }) as ConversationSessionSummary
  const read = (input: Partial<Parameters<typeof settlementSignals>[0]>) =>
    settlementSignals({ record, conversations: [], terminals: [], pullRequests: [], ...input })

  assert.deepEqual(read({}), { busy: false, held: false })
  assert.deepEqual(read({ conversations: [chat({ phase: 'running' })] }), { busy: true, held: false })
  assert.deepEqual(read({ conversations: [chat({ phase: 'idle', backgroundAgents: 1 })] }), {
    busy: true,
    held: false,
  })
  assert.deepEqual(read({ conversations: [chat({ phase: 'waiting_for_input' })] }), { busy: false, held: true })
  assert.deepEqual(read({ conversations: [chat({ phase: 'running', status: 'stopped' })] }), {
    busy: false,
    held: false,
  })
  assert.deepEqual(
    read({ terminals: [{ kind: 'agent', workspaceId: 'ws', processAlive: true, activity: { kind: 'working' } }] }),
    { busy: true, held: false },
  )
  assert.deepEqual(
    read({ terminals: [{ kind: 'terminal', workspaceId: 'ws', processAlive: true, activity: { kind: 'working' } }] }),
    { busy: false, held: false },
    'a plain shell printing is not work',
  )
  assert.deepEqual(
    read({
      terminals: [{ kind: 'agent', workspaceId: 'ws', processAlive: true, agentState: { phase: 'awaiting_input' } }],
    }),
    { busy: false, held: true },
  )
  assert.deepEqual(
    read({ conversations: [chat({ phase: 'completed', lastTurnEndedAt: BORN + 1 })] }),
    { busy: false, held: true },
    'a turn finished after the last visit is unseen',
  )
  assert.deepEqual(
    read({ pullRequests: [{ ...merged(BORN), state: 'open', watch: { kind: 'checks' } as never }] }),
    { busy: false, held: true },
    'a watched pull request holds the chat',
  )
})
