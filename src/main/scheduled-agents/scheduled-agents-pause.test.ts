import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { ScheduledAgentDraft, ScheduledAgentLastRun } from '../../shared/scheduled-agents'
import { createScheduledAgentsScheduler } from './scheduler'
import { createScheduledAgentsService, type ScheduledAgentsService } from './service'
import { createScheduledAgentsStore, type ScheduledAgentsStore } from './store'

// Pausing a scheduled agent, and every one of them for a while. The rules the
// person reads in the app, held here against the real store, scheduler and
// service on a clock the test moves:
//   - a paused schedule starts nothing at its times, and its timer is let go
//     of rather than checked when it fires;
//   - resumed, it runs next at its first time after the resume, never the
//     ones that passed while it was paused;
//   - Run now still runs it, and a run already going carries on;
//   - pausing them all is kept apart from each one's own pause, and one with
//     an until ends at it — after a restart too.

// Wednesday 30 September 2026, 12:10 UTC. Each schedule below runs daily at 13:00.
const NOW = Date.UTC(2026, 8, 30, 12, 10)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const at13 = (daysAhead: number) => Date.UTC(2026, 8, 30 + daysAhead, 13, 0)

function draft(overrides: Partial<ScheduledAgentDraft> = {}): ScheduledAgentDraft {
  return {
    prompt: 'Fix open GitHub issues for production.',
    schedule: { cron: '0 13 * * *', timezone: 'UTC' },
    folderPath: '/Users/dev/acme',
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: null,
    skills: [],
    mcpServers: [],
    worktree: null,
    ...overrides,
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-scheduled-agents-pause-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'scheduled-agents.json')
}

// One clock for the store, the scheduler and the service, and the scheduler's
// one timer, under the test's hand.
function fakeTime(start: number) {
  let now = start
  let armed: { callback: () => void; at: number } | null = null
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      armed = { callback, at: now + ms }
      return armed
    },
    clearTimer: (handle: unknown) => {
      if (armed === handle) armed = null
    },
    armedAt: () => armed?.at ?? null,
    // Move the clock and fire the timer, again and again, while it is due on
    // the way — an hour-capped timer re-arms itself across a long stretch.
    advanceTo: async (to: number) => {
      for (;;) {
        const due = armed
        if (!due || due.at > to) break
        now = Math.max(now, due.at)
        armed = null
        due.callback()
        await settle()
      }
      now = to
      await settle()
    },
    // The clock moves with no timer firing: the computer was asleep.
    sleepUntil: (to: number) => {
      now = to
    },
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

type Harness = {
  store: ScheduledAgentsStore
  service: ScheduledAgentsService
  scheduler: ReturnType<typeof createScheduledAgentsScheduler>
  runs: Array<{ id: string; at: number }>
}

/** The module's own wiring, on a file and a clock of the test's. */
function harness(
  filePath: string,
  time: ReturnType<typeof fakeTime>,
  run?: (id: string) => Promise<ScheduledAgentLastRun>,
): Harness {
  const runs: Array<{ id: string; at: number }> = []
  let ids = 0
  const store = createScheduledAgentsStore({ filePath, now: time.now, newId: () => `sa-${(ids += 1)}` })
  let service: ScheduledAgentsService | null = null
  const scheduler = createScheduledAgentsScheduler({
    list: () => store.list(),
    recordRun: (id, ran) => store.recordRun(id, ran),
    run: async (agent) => {
      runs.push({ id: agent.id, at: time.now() })
      return run ? run(agent.id) : { at: time.now(), ok: true, workspaceId: `run-${runs.length}` }
    },
    pausedAll: () => store.pausedAll(),
    onPauseAllEnded: (pause) => void service?.resumeAll(pause),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  service = createScheduledAgentsService({ store, scheduler, now: time.now })
  return { store, service, scheduler, runs }
}

async function started(h: Harness): Promise<Harness> {
  await h.store.load()
  h.scheduler.start()
  return h
}

async function created(h: Harness, overrides: Partial<ScheduledAgentDraft> = {}): Promise<string> {
  const made = await h.service.create(draft(overrides))
  assert.ok(made.ok, made.ok ? '' : made.message)
  return made.agent.id
}

test('a file from before pausing loads with every schedule running, and the file keeps its version', async () => {
  const filePath = tempFile()
  writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      agents: [
        {
          ...draft(),
          id: 'sa-old',
          ownerModuleId: null,
          createdAt: NOW - DAY,
          updatedAt: NOW - DAY,
          lastRun: null,
          lastFailureSeenAt: null,
        },
      ],
    }),
  )
  const time = fakeTime(NOW)
  const h = await started(harness(filePath, time))
  assert.equal(h.store.get('sa-old')?.pausedAt, undefined)
  assert.equal(h.service.pausedAll(), null)
  assert.equal(h.service.get('sa-old')?.nextRunAt, at13(0))

  // Paused, it is written beside the fields an older app reads, at the same
  // version: an older app reads the file, and runs the schedule as it did.
  await h.service.pause('sa-old')
  await h.service.pauseAll(NOW + HOUR)
  const saved = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  assert.equal(saved.version, 1)
  assert.deepEqual(saved.pausedAll, { since: NOW, until: NOW + HOUR })
  const [entry] = saved.agents as Array<Record<string, unknown>>
  assert.equal(entry?.pausedAt, NOW)
  assert.equal(entry?.prompt, draft().prompt)

  // Read back, both pauses hold; a pause in a shape this build never writes is none.
  const reread = createScheduledAgentsStore({ filePath, now: time.now })
  await reread.load()
  assert.equal(reread.get('sa-old')?.pausedAt, NOW)
  assert.deepEqual(reread.pausedAll(), { since: NOW, until: NOW + HOUR })
  writeFileSync(filePath, JSON.stringify({ ...saved, pausedAll: { since: 'yesterday', until: null } }))
  const garbled = createScheduledAgentsStore({ filePath, now: time.now })
  await garbled.load()
  assert.equal(garbled.pausedAll(), null)
  assert.equal(garbled.list().length, 1, 'the schedules are kept')
})

test('a paused schedule does not run at its time, and its timer is let go of', async () => {
  const time = fakeTime(NOW)
  const h = await started(harness(tempFile(), time))
  const id = await created(h)
  assert.equal(time.armedAt(), at13(0))

  const paused = await h.service.pause(id)
  assert.ok(paused.ok)
  assert.equal(paused.agent.pausedAt, NOW)
  assert.equal(paused.agent.nextRunAt, null, 'no next run while paused')
  assert.equal(time.armedAt(), null, 'the timer is gone, not checked when it fires')

  await time.advanceTo(at13(3))
  assert.deepEqual(h.runs, [])

  // A computer waking from a sleep through its time finds nothing due.
  time.sleepUntil(at13(4) + 5 * 60 * 1000)
  h.service.notifyChanged()
  await settle()
  assert.deepEqual(h.runs, [])

  // Pausing it again keeps when it was first paused.
  const again = await h.service.pause(id)
  assert.ok(again.ok)
  assert.equal(again.agent.pausedAt, NOW)
})

test('resumed, a schedule runs next at its first time after now, not the ones it missed', async () => {
  const time = fakeTime(NOW)
  const h = await started(harness(tempFile(), time))
  const id = await created(h)
  await h.service.pause(id)
  // Three of its times pass while it is paused.
  await time.advanceTo(at13(2) + 60 * 60 * 1000)

  const resumed = await h.service.resume(id)
  assert.ok(resumed.ok)
  assert.equal(resumed.agent.pausedAt, undefined)
  assert.equal(resumed.agent.nextRunAt, at13(3))
  await settle()
  assert.deepEqual(h.runs, [], 'nothing missed is made up')

  await time.advanceTo(at13(3))
  assert.deepEqual(h.runs, [{ id, at: at13(3) }])
  assert.equal(h.service.get(id)?.nextRunAt, at13(4))
})

test('pausing them all stops every schedule, and one paused for an hour resumes at its end', async () => {
  const time = fakeTime(Date.UTC(2026, 8, 30, 12, 30))
  const h = await started(harness(tempFile(), time))
  const daily = await created(h)
  const hourly = await created(h, { schedule: { cron: '0 * * * *', timezone: 'UTC' } })

  const paused = await h.service.pauseAll(time.now() + HOUR)
  assert.ok(paused.ok)
  assert.deepEqual(h.service.pausedAll(), { since: time.now(), until: time.now() + HOUR })
  assert.equal(h.service.get(daily)?.nextRunAt, null)
  assert.equal(h.service.get(hourly)?.nextRunAt, null)
  // Woken for the pause's end, which is sooner than either run.
  assert.equal(time.armedAt(), Date.UTC(2026, 8, 30, 13, 30))

  // 13:00 comes for both while the pause holds: neither runs.
  await time.advanceTo(Date.UTC(2026, 8, 30, 13, 15))
  assert.deepEqual(h.runs, [])

  // At 13:30 it ends by itself, and is gone from the file.
  await time.advanceTo(Date.UTC(2026, 8, 30, 13, 30))
  assert.equal(h.service.pausedAll(), null)
  assert.equal(h.store.pausedAll(), null)
  assert.deepEqual(h.runs, [], 'the 13:00 runs are not made up')
  assert.equal(h.service.get(hourly)?.nextRunAt, Date.UTC(2026, 8, 30, 14, 0))
  assert.equal(h.service.get(daily)?.nextRunAt, at13(1))

  await time.advanceTo(Date.UTC(2026, 8, 30, 14, 0))
  assert.deepEqual(h.runs, [{ id: hourly, at: Date.UTC(2026, 8, 30, 14, 0) }])

  // A time already gone is no end for a pause.
  assert.deepEqual(await h.service.pauseAll(time.now() - 1), { ok: false, message: 'That time has already passed.' })
})

test('a pause of them all outlives a restart, and ends at its time though the app was closed through it', async () => {
  const filePath = tempFile()
  const time = fakeTime(NOW)
  const before = await started(harness(filePath, time))
  const id = await created(before)
  await before.service.pauseAll(NOW + 2 * HOUR)
  before.scheduler.stop()

  // Started again inside the pause: still paused, woken for its end.
  time.sleepUntil(NOW + HOUR)
  const during = await started(harness(filePath, time))
  assert.deepEqual(during.service.pausedAll(), { since: NOW, until: NOW + 2 * HOUR })
  assert.equal(during.service.get(id)?.nextRunAt, null)
  assert.equal(time.armedAt(), NOW + 2 * HOUR)
  during.scheduler.stop()

  // Started after its end, with 13:00 gone by while the app was closed: the
  // pause is over and let go of, and the 13:00 run is not made up.
  time.sleepUntil(Date.UTC(2026, 8, 30, 15, 0))
  const after = await started(harness(filePath, time))
  await settle()
  assert.equal(after.service.pausedAll(), null)
  assert.equal(after.store.pausedAll(), null, 'cleared from the file at start')
  const saved = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  assert.equal('pausedAll' in saved, false)
  assert.equal(after.service.get(id)?.nextRunAt, at13(1))
  assert.deepEqual(after.runs, [])
})

test("pausing them all and a schedule's own pause are kept apart", async () => {
  const time = fakeTime(NOW)
  const h = await started(harness(tempFile(), time))
  const own = await created(h)
  const other = await created(h)
  await h.service.pause(own)
  await h.service.pauseAll(null)
  assert.deepEqual(h.service.pausedAll(), { since: NOW, until: null })

  // Resuming one under the pause of them all does not run it.
  await h.service.resume(other)
  assert.equal(h.service.get(other)?.nextRunAt, null)
  await h.service.pause(other)

  // Ending the pause of them all leaves each one's own pause where it was.
  await h.service.resumeAll()
  assert.equal(h.service.pausedAll(), null)
  assert.equal(h.service.get(own)?.pausedAt, NOW)
  assert.equal(h.service.get(own)?.nextRunAt, null)
  await h.service.resume(other)
  assert.equal(h.service.get(other)?.nextRunAt, at13(0))

  await time.advanceTo(at13(0))
  assert.deepEqual(
    h.runs.map((run) => run.id),
    [other],
  )

  // A pause that came to its end does not end one the person set since.
  await h.service.pauseAll(time.now() + HOUR)
  const first = h.service.pausedAll()!
  await h.service.pauseAll(null)
  await h.service.resumeAll(first)
  assert.equal(h.service.pausedAll()?.until, null, 'the newer pause holds')
})

test('Run now runs a paused schedule, and it stays paused', async () => {
  const time = fakeTime(NOW)
  const h = await started(harness(tempFile(), time))
  const id = await created(h)
  await h.service.pause(id)
  await h.service.pauseAll(null)

  const ran = await h.service.runNow(id)
  assert.ok(ran.ok)
  assert.deepEqual(h.runs, [{ id, at: NOW }])
  assert.equal(h.service.get(id)?.pausedAt, NOW)
  assert.equal(h.service.get(id)?.nextRunAt, null)
})

test('a run already going when its schedule is paused carries on, and is recorded', async () => {
  const time = fakeTime(NOW)
  let finish: (run: ScheduledAgentLastRun) => void = () => {}
  const h = await started(
    harness(tempFile(), time, () => new Promise<ScheduledAgentLastRun>((resolve) => (finish = resolve))),
  )
  const id = await created(h)
  await time.advanceTo(at13(0))
  assert.equal(h.runs.length, 1, 'the run is on its way')

  await h.service.pause(id)
  await h.service.pauseAll(null)
  finish({ at: at13(0), ok: true, workspaceId: 'run-1' })
  await settle()
  assert.deepEqual(h.service.get(id)?.lastRun, { at: at13(0), ok: true, workspaceId: 'run-1' })
  assert.equal(h.service.get(id)?.pausedAt, at13(0))
})
