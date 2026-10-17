import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { AgentPhaseEvent } from '../../shared/agent-runtime'
import type { TerminalSessionSnapshot } from '../../shared/ipc/terminal'
import type { TourFileSnapshot } from '../../shared/tours/tour-anchor'
import type { TourCreateInput } from '../../shared/tours/tour-input'
import type { Tour } from '../../shared/tours/tour-types'
import type { TourChangedFile } from './tour-git'
import { createTourService, TOUR_CHANNELS, type TourServiceDeps } from './tour-service'
import { createTourStore, readStoredTour, type TourStore } from './tour-store'

// The tour service with its world faked: git answers from a table, timers are
// driven by hand, and the windows are two arrays of what was broadcast. The
// store is the real one, in a temporary folder, so persistence is exercised
// rather than assumed.

const RETRY_NEW = 'export type RetryOptions = {\n  attempts: number\n}\n\nexport function retry() {}\n'
const RETRY: TourFileSnapshot = {
  path: 'src/retry.ts',
  status: 'modified',
  unreadable: null,
  oldText: 'export function retry() {}\n',
  newText: RETRY_NEW,
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 4,
      lines: ['+export type RetryOptions = {', '+  attempts: number', '+}', '+'],
    },
  ],
}

const temps: string[] = []
// Saves still being written. A phase event saves without anyone awaiting it,
// so a test can end with a write still landing in its folder: removing the
// folder under it fails (ENOTEMPTY) or leaves a file behind.
const saving = new Set<Promise<void>>()
afterEach(async () => {
  while (saving.size > 0) await Promise.allSettled([...saving])
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The real store in `dir`, its saves tracked so a test's folder is removed only once they have landed. */
function trackedStore(dir: string): TourStore {
  const store = createTourStore(dir)
  return {
    ...store,
    save(tour) {
      const saved = store.save(tour)
      saving.add(saved)
      void saved.then(
        () => saving.delete(saved),
        () => saving.delete(saved),
      )
      return saved
    },
  }
}

function session(partial: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 's1',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    activity: { kind: 'idle', since: 0 },
    ...partial,
  } as TerminalSessionSnapshot
}

function harness(options: { focused?: boolean; files?: TourFileSnapshot[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-tours-'))
  temps.push(dir)
  const files = options.files ?? [RETRY]
  const fileByPath = new Map(files.map((file) => [file.path, file]))
  const workspaceBroadcasts: Array<{ channel: string; payload: unknown }> = []
  const viewerBroadcasts: Array<{ channel: string; payload: unknown }> = []
  const writes: Array<{ sessionId: string; data: string }> = []
  const attention: string[] = []
  const timers: Array<{ at: number; run: () => void; id: number }> = []
  let clock = 1_000
  let nextId = 0
  let terminals: TerminalSessionSnapshot[] = [session({})]
  const store = trackedStore(dir)
  const checkoutLookups: Array<{ workspaceId: string; agentId: string }> = []

  const deps: TourServiceDeps = {
    store,
    git: {
      resolveRepoRoot: async () => '/Users/dev/app',
      resolveCommit: async (_root, rev) => (rev === 'missing' ? null : `sha-${rev}`),
      resolveHead: async () => 'sha-head',
      listTourFiles: async () => ({
        ok: true,
        files: [...fileByPath.values()].map<TourChangedFile>((file) => ({ path: file.path, status: file.status })),
      }),
      readTourFile: async (_root, _revs, file) => fileByPath.get(file.path)!,
    },
    now: () => clock,
    newId: () => `id-${String(++nextId).padStart(6, '0')}`,
    resolveWorkspaceRoot: () => '/Users/dev/app',
    resolveAgentCheckout: (workspaceId, agentId) => {
      checkoutLookups.push({ workspaceId, agentId })
      return null
    },
    // Every chat's agent has a list here but ws-empty's: `agent-1` recurs in
    // every chat, and one chat's list must never answer for another's.
    readChangelistPaths: async (_root, owner) => (owner.workspaceId === 'ws-empty' ? null : ['src/retry.ts']),
    broadcastToWorkspaceWindows: (channel, payload) => workspaceBroadcasts.push({ channel, payload }),
    broadcastToViewers: (channel, payload) => viewerBroadcasts.push({ channel, payload }),
    isAppFocused: () => options.focused ?? true,
    requestAttention: (key) => attention.push(key),
    listTerminals: () => terminals,
    writeTerminal: (sessionId, data) => writes.push({ sessionId, data }),
    setTimeout: (run, ms) => {
      const id = timers.length + 1
      timers.push({ at: clock + ms, run, id })
      return id
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
  }
  const service = createTourService(deps)
  return {
    service,
    checkoutLookups,
    store,
    dir,
    workspaceBroadcasts,
    viewerBroadcasts,
    writes,
    attention,
    setTerminals: (next: TerminalSessionSnapshot[]) => {
      terminals = next
    },
    setFile: (file: TourFileSnapshot | null, path = 'src/retry.ts') => {
      if (file) fileByPath.set(file.path, file)
      else fileByPath.delete(path)
    },
    advance: async (ms: number) => {
      clock += ms
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > clock) continue
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
      await Promise.resolve()
    },
  }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting')
}

const CALLER = { workspaceId: 'ws-1', agentId: 'agent-1', agentName: 'Claude', cliId: 'claude-code' }

function input(
  steps: TourCreateInput['steps'] = [
    {
      id: 'options',
      title: 'Options',
      body: 'why',
      path: 'src/retry.ts',
      side: 'new',
      match: 'export type RetryOptions',
      lineCount: 3,
    },
  ],
): TourCreateInput {
  return { title: 'Retry', changes: { kind: 'changelist' }, steps }
}

async function created(h: ReturnType<typeof harness>, focusedAck = true, caller = CALLER): Promise<Tour> {
  const pending = h.service.create(input(), caller)
  const request = await waitFor(() =>
    h.workspaceBroadcasts.find(
      (entry) =>
        entry.channel === TOUR_CHANNELS.revealRequest &&
        (entry.payload as { workspaceId: string }).workspaceId === caller.workspaceId,
    ),
  )
  if (focusedAck) h.service.acknowledgeReveal((request.payload as { requestId: string }).requestId)
  else await h.advance(2_000)
  const result = await pending
  if (!result.ok) throw new Error(result.errors.join('\n'))
  assert.equal(result.revealed, focusedAck)
  return result.tour
}

test('creating a tour resolves it, saves it, and asks a window to dock it — revealed when one answers', async () => {
  const h = harness()
  const tour = await created(h)
  assert.equal(tour.author.agentName, 'Claude')
  assert.deepEqual([tour.steps[0].anchor.startLine, tour.steps[0].anchor.endLine], [1, 3])
  assert.equal(tour.playback.started, false, 'nothing plays until Start')
  const stored = await h.store.load('ws-1', tour.id)
  assert.equal(stored?.title, 'Retry')
  assert.deepEqual(h.attention, [], 'a focused app gets no attention event')
})

test('no window answering is revealed: false, not an error; an unfocused app gets ONE attention event', async () => {
  const h = harness({ focused: false })
  const tour = await created(h, false)
  assert.deepEqual(h.attention, [`tour:${tour.id}`])
})

test('a refused tour lists shape and anchor problems together', async () => {
  const h = harness()
  const result = await h.service.create(
    input([
      { id: 'a', title: 'A', body: 'b', path: 'src/retry.ts', side: 'new', match: 'nowhere' },
      { id: 'b', title: 'B', body: 'b', path: 'src/missing.ts', side: 'new', hunk: 1 },
    ]),
    CALLER,
    ['Step 3 ("c"): give exactly one anchor — match, hunk, lines or fileOnly: true.'],
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors.length, 3)
  assert.match(result.errors[0], /Step 3/)
  assert.match(result.errors[1], /"a".*does not appear/)
  assert.match(result.errors[2], /"b".*not in this tour's changes/)
})

test('a changelist tour with no owned files says what to use instead', async () => {
  const h = harness()
  const result = await h.service.create(input(), { workspaceId: 'ws-1' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors[0], /needs the calling agent/)
})

test("a changelist tour reads its own chat's agent's list, not another chat's agent-1", async () => {
  const h = harness()
  const result = await h.service.create(input(), { ...CALLER, workspaceId: 'ws-empty' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors[0], /Your changelist has no uncommitted files/)
})

test('a working-tree tour re-finds its lines, and says moved and gone', async () => {
  const h = harness()
  const tour = await created(h)
  h.setFile({ ...RETRY, newText: `// header\n${RETRY_NEW}` })
  let live = await h.service.read('ws-1', tour.id)
  assert.equal(live.ok && live.value.steps[0].status, 'ok')
  assert.equal(live.ok && live.value.steps[0].startLine, 2)
  h.setFile({ ...RETRY, newText: 'export interface Other {}\n' })
  live = await h.service.read('ws-1', tour.id)
  assert.equal(live.ok && live.value.steps[0].status, 'moved')
  h.setFile(null)
  live = await h.service.read('ws-1', tour.id)
  assert.equal(live.ok && live.value.steps[0].status, 'gone')
  const status = await h.service.status('ws-1', tour.id)
  assert.equal(status.ok && status.status.gone[0], 'options')
})

test('a question is typed in at once when the author has finished its turn — paste, then its own Enter', async () => {
  const h = harness()
  const tour = await created(h)
  h.setTerminals([session({ agentState: { phase: 'idle', since: 0, source: 'hook' } })])
  const asked = await h.service.ask('ws-1', tour.id, 'options', 'Why three lines?')
  assert.equal(asked.ok && asked.value.state, 'sent')
  assert.equal(h.writes.length, 1)
  assert.ok(h.writes[0].data.startsWith('\x1b[200~[Tour "Retry" · step 1/1 "Options"'))
  assert.ok(h.writes[0].data.endsWith('Why three lines?\x1b[201~'))
  await h.advance(2_000)
  assert.deepEqual(h.writes[1], { sessionId: 's1', data: '\r' })
})

test('a question waits while the author is working or blocked on a prompt, and goes when its turn ends', async () => {
  const h = harness()
  const tour = await created(h)
  h.setTerminals([session({ agentState: { phase: 'awaiting_input', since: 0, source: 'hook' } })])
  const asked = await h.service.ask('ws-1', tour.id, 'options', 'Why?')
  assert.equal(asked.ok && asked.value.state, 'queued')
  assert.equal(h.writes.length, 0, 'an Enter on a permission prompt would answer the prompt')

  const phase = (partial: Partial<AgentPhaseEvent>): AgentPhaseEvent => ({
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    executionId: null,
    phase: 'idle',
    previousPhase: 'thinking',
    event: 'Stop',
    turnEnd: true,
    turnFailure: false,
    ts: 0,
    pendingWakeupAt: null,
    ...partial,
  })
  h.service.onAgentPhase(phase({ phase: 'thinking', turnEnd: false }))
  assert.equal(h.writes.length, 0)
  h.service.onAgentPhase(phase({}))
  assert.equal(h.writes.length, 1, 'sent on the turn end')
  const afterSend = await h.service.status('ws-1', tour.id)
  assert.equal(afterSend.ok && afterSend.status.asks[0].state, 'sent')
  h.service.onAgentPhase(phase({}))
  const answered = await h.service.status('ws-1', tour.id)
  assert.equal(answered.ok && answered.status.asks[0].state, 'answered')
})

test('a queued question can be cancelled, and an exited author is reported so a new agent can be asked', async () => {
  const h = harness()
  const tour = await created(h)
  h.setTerminals([session({ agentState: { phase: 'thinking', since: 0, source: 'hook' } })])
  const asked = await h.service.ask('ws-1', tour.id, 'options', 'Why?')
  assert.ok(asked.ok)
  if (asked.ok) await h.service.cancelAsk('ws-1', tour.id, asked.value.id)
  const status = await h.service.status('ws-1', tour.id)
  assert.equal(status.ok && status.status.asks[0].state, 'cancelled')

  h.setTerminals([])
  const gone = await h.service.ask('ws-1', tour.id, 'options', 'Anyone?')
  assert.equal(gone.ok, false)
  assert.equal(gone.authorGone, true)
})

test('goto moves only a viewer that says it moved; with none, it says so', async () => {
  const h = harness()
  const tour = await created(h)
  const before = h.viewerBroadcasts.filter((entry) => entry.channel === TOUR_CHANNELS.gotoRequest).length
  const nobody = h.service.goto('ws-1', tour.id, 'options')
  await waitFor(() =>
    h.viewerBroadcasts.filter((entry) => entry.channel === TOUR_CHANNELS.gotoRequest).length > before
      ? true
      : undefined,
  )
  await h.advance(1_000)
  assert.deepEqual(await nobody, { ok: true, moved: false, reason: 'no_viewer' })

  const followed = h.service.goto('ws-1', tour.id, 'options')
  await waitFor(() =>
    h.viewerBroadcasts.filter((entry) => entry.channel === TOUR_CHANNELS.gotoRequest).length > before + 1
      ? true
      : undefined,
  )
  const request = h.viewerBroadcasts.filter((entry) => entry.channel === TOUR_CHANNELS.gotoRequest).at(-1)
  const requestId = (request?.payload as { requestId: string }).requestId
  h.service.answerGoto({ requestId, moved: false, reason: 'follow_off' })
  h.service.answerGoto({ requestId, moved: true, reason: 'moved' })
  assert.deepEqual(await followed, { ok: true, moved: true, reason: 'moved' })

  const unknown = await h.service.goto('ws-1', tour.id, 'nope')
  assert.equal(unknown.ok, false)
})

test('update inserts after a step, replaces by id, and refuses what it cannot do — all at once', async () => {
  const h = harness()
  const tour = await created(h)
  const detour = { id: 'detour', title: 'Detour', body: 'b', path: 'src/retry.ts', side: 'new' as const, hunk: 1 }
  const inserted = await h.service.update(
    { tourId: tour.id, insertAfter: { after: 'options', steps: [detour] } },
    CALLER,
  )
  assert.equal(inserted.ok && inserted.tour.steps.map((step) => step.id).join(','), 'options,detour')
  const refused = await h.service.update(
    {
      tourId: tour.id,
      remove: ['ghost'],
      insertAfter: { after: 'nowhere', steps: [{ ...detour, id: 'x', match: 'zzz', hunk: undefined }] },
    },
    CALLER,
  )
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.match(refused.errors.join('\n'), /no step "ghost"/)
    assert.match(refused.errors.join('\n'), /insertAfter.after: no step "nowhere"/)
    assert.match(refused.errors.join('\n'), /"x".*does not appear/)
  }
})

test('playback is kept, only merged forward, and survives a restart of the service', async () => {
  const h = harness()
  const tour = await created(h)
  await h.service.reportPlayback('ws-1', tour.id, {
    started: true,
    currentStepId: 'options',
    visited: ['options'],
    follow: true,
  })
  await h.service.reportPlayback('ws-1', tour.id, { started: false, currentStepId: 'bogus', visited: [], follow: true })
  const reloaded = createTourStore(h.dir)
  const again = await reloaded.load('ws-1', tour.id)
  assert.equal(again?.playback.started, true, 'started never goes back')
  assert.deepEqual(again?.playback.visited, ['options'], 'visited is a union')
  assert.equal(again?.playback.currentStepId, null, 'an unknown step id is dropped')
  assert.equal((await reloaded.list('ws-1')).length, 1)
  assert.equal((await reloaded.list('ws-other')).length, 0, 'tours are per workspace')
})

test('a stored file from another schema is not read as a tour', () => {
  assert.equal(readStoredTour({ schemaVersion: 2, id: 'abcdefgh' }), null)
  assert.equal(readStoredTour('nope'), null)
})

test('one question at a time per agent: a second waits for the first answer', async () => {
  const h = harness()
  const tour = await created(h)
  h.setTerminals([session({ agentState: { phase: 'idle', since: 0, source: 'hook' } })])
  const first = await h.service.ask('ws-1', tour.id, 'options', 'One?')
  const second = await h.service.ask('ws-1', tour.id, 'options', 'Two?')
  assert.equal(first.ok && first.value.state, 'sent')
  assert.equal(second.ok && second.value.state, 'queued', 'the snapshot still says idle, but a turn is under way')
  assert.equal(h.writes.length, 1)
})

test('only the author may change a tour or point at it', async () => {
  const h = harness()
  const tour = await created(h)
  const other = { workspaceId: 'ws-1', agentId: 'agent-2' }
  const update = await h.service.update({ tourId: tour.id, remove: ['options'] }, other)
  assert.equal(update.ok, false)
  if (!update.ok) assert.equal(update.code, 'forbidden')
  const goto = await h.service.goto('ws-1', tour.id, 'options', 'agent-2')
  assert.equal(goto.ok, false)
  const close = await h.service.close('ws-1', tour.id, 'agent-2')
  assert.equal(close.ok, false)
  const closed = await h.service.close('ws-1', tour.id, 'agent-1')
  assert.equal(closed.ok, true)
  const afterClose = await h.service.goto('ws-1', tour.id, 'options', 'agent-1')
  assert.equal(afterClose.ok, false, 'a closed tour is not pointed at')
})

// Agent ids are only unique within a workspace: nearly every chat's first agent
// is `agent-1`. Each of these has a second chat whose agent shares the author's
// id, and nothing of one may reach the other.

function phaseOf(partial: Partial<AgentPhaseEvent>): AgentPhaseEvent {
  return {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    executionId: null,
    phase: 'idle',
    previousPhase: 'thinking',
    event: 'Stop',
    turnEnd: true,
    turnFailure: false,
    ts: 0,
    pendingWakeupAt: null,
    ...partial,
  }
}

const IDLE = { agentState: { phase: 'idle' as const, since: 0, source: 'hook' as const } }

test("a question goes to the author's own terminal, never another chat's agent of the same id", async () => {
  const h = harness()
  const tour = await created(h)
  h.setTerminals([session({ ...IDLE, sessionId: 's-other', workspaceId: 'ws-2' })])
  const gone = await h.service.ask('ws-1', tour.id, 'options', 'Why?')
  assert.equal(gone.ok, false)
  assert.equal(gone.authorGone, true, "another chat's agent-1 is not the author")
  assert.equal(h.writes.length, 0)

  h.setTerminals([
    session({ ...IDLE, sessionId: 's-other', workspaceId: 'ws-2' }),
    session({ ...IDLE, sessionId: 's-author' }),
  ])
  const asked = await h.service.ask('ws-1', tour.id, 'options', 'Why?')
  assert.equal(asked.ok && asked.value.state, 'sent')
  assert.deepEqual(
    h.writes.map((write) => write.sessionId),
    ['s-author'],
  )
})

test("another chat's agent of the same id ending its turn or exiting leaves this tour's questions alone", async () => {
  const h = harness()
  const tour = await created(h)
  h.setTerminals([session({ agentState: { phase: 'thinking', since: 0, source: 'hook' } })])
  const queued = await h.service.ask('ws-1', tour.id, 'options', 'Why?')
  assert.equal(queued.ok && queued.value.state, 'queued')

  h.service.onAgentPhase(phaseOf({ workspaceId: 'ws-2' }))
  assert.equal(h.writes.length, 0, "another chat's turn end is not the author's")
  h.service.onAgentPhase(phaseOf({ workspaceId: 'ws-2', phase: 'exited', turnEnd: false }))
  const still = await h.service.status('ws-1', tour.id)
  assert.equal(still.ok && still.status.asks[0].state, 'queued')

  h.service.onAgentPhase(phaseOf({}))
  assert.equal(h.writes.length, 1, "sent on the author's own turn end")
  h.service.onAgentPhase(phaseOf({ workspaceId: 'ws-2' }))
  const sent = await h.service.status('ws-1', tour.id)
  assert.equal(sent.ok && sent.status.asks[0].state, 'sent', "another chat's turn end answers nothing here")
})

test('an author moved to another chat still reads as the author, and its turn ends answer', async () => {
  // Its tour names ws-1, the chat its process was launched in and still names;
  // its session and its phase events now name ws-2, the chat it was dragged to.
  const h = harness()
  const tour = await created(h)
  const moved = { workspaceId: 'ws-2', launchWorkspaceId: 'ws-1' }
  h.setTerminals([session({ ...moved, agentState: { phase: 'thinking', since: 0, source: 'hook' } })])
  const queued = await h.service.ask('ws-1', tour.id, 'options', 'Why?')
  assert.equal(queued.ok && queued.value.state, 'queued', 'the author is not gone')

  h.service.onAgentPhase(phaseOf(moved))
  assert.equal(h.writes.length, 1, "sent on the moved author's turn end")
  h.service.onAgentPhase(phaseOf(moved))
  const answered = await h.service.status('ws-1', tour.id)
  assert.equal(answered.ok && answered.status.asks[0].state, 'answered')
})

test("a question being answered in one chat does not hold back another chat's agent of the same id", async () => {
  const h = harness()
  const mine = await created(h)
  const theirs = await created(h, true, { ...CALLER, workspaceId: 'ws-2' })
  h.setTerminals([
    session({ ...IDLE, sessionId: 's-mine' }),
    session({ ...IDLE, sessionId: 's-theirs', workspaceId: 'ws-2' }),
  ])
  const first = await h.service.ask('ws-2', theirs.id, 'options', 'Theirs?')
  assert.equal(first.ok && first.value.state, 'sent')
  const second = await h.service.ask('ws-1', mine.id, 'options', 'Mine?')
  assert.equal(second.ok && second.value.state, 'sent', 'a different agent, so nothing is under way for it')
  assert.deepEqual(
    h.writes.filter((write) => write.data !== '\r').map((write) => write.sessionId),
    ['s-theirs', 's-mine'],
  )
})

test("the agent's own checkout is looked up in the caller's workspace", async () => {
  const h = harness()
  await created(h, true, { ...CALLER, workspaceId: 'ws-2' })
  assert.deepEqual(h.checkoutLookups, [{ workspaceId: 'ws-2', agentId: 'agent-1' }])
})
