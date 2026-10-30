import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationLaunchRequest } from '../conversation-launch-service'
import {
  cronForInstant,
  scheduledAgentScheduleWords,
  validateScheduledAgentDraft,
  type ScheduledAgent,
  type ScheduledAgentDraft,
} from '../../shared/scheduled-agents'
import { isRunChatWorking, runScheduledAgent } from './runner'
import { createScheduledAgentsScheduler } from './scheduler'
import { runAsModuleToolCall } from '../module-host/module-tool-caller'
import { createScheduledAgentsModuleRegistry, createScheduledAgentsService, withinOwnerModuleCeiling } from './service'
import { createScheduledAgentsStore } from './store'

// Wednesday 30 September 2026, 12:10 UTC.
const NOW = Date.UTC(2026, 8, 30, 12, 10)

function draft(overrides: Partial<ScheduledAgentDraft> = {}): ScheduledAgentDraft {
  return {
    prompt: 'Triage the issues opened since the last run.',
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

function agent(overrides: Partial<ScheduledAgent> = {}): ScheduledAgent {
  return {
    ...draft(),
    id: 'sa-1',
    ownerModuleId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastRun: null,
    lastFailureSeenAt: null,
    ...overrides,
  }
}

function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-scheduled-agents-'))
  return { path: join(dir, 'scheduled-agents.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// A clock the scheduler reads and a timer it arms, both under the test's hand.
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
    // Move the clock to `to` and fire the timer if it came due on the way.
    advanceTo: async (to: number) => {
      now = to
      const due = armed
      if (due && due.at <= to) {
        armed = null
        due.callback()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

test('the store keeps scheduled agents in the app data file and reads them back', async () => {
  const file = tempFile()
  try {
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-1' })
    await store.load()
    assert.deepEqual(store.list(), [])
    const created = await store.create(draft(), 'weather-deck')
    assert.equal(created.id, 'sa-1')
    assert.equal(created.ownerModuleId, 'weather-deck')

    const reread = createScheduledAgentsStore({ filePath: file.path, now: () => NOW })
    await reread.load()
    assert.deepEqual(reread.list(), [created])
  } finally {
    file.cleanup()
  }
})

test('a hand-edited entry that no longer validates is skipped, not scheduled', async () => {
  const file = tempFile()
  try {
    writeFileSync(
      file.path,
      JSON.stringify({
        version: 1,
        agents: [agent(), { ...agent({ id: 'sa-2' }), schedule: { cron: '0 25 * * *', timezone: 'UTC' } }],
      }),
    )
    const warnings: string[] = []
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, warn: (m) => warnings.push(m) })
    await store.load()
    assert.deepEqual(
      store.list().map((entry) => entry.id),
      ['sa-1'],
    )
    assert.match(warnings[0] ?? '', /sa-2/u)
  } finally {
    file.cleanup()
  }
})

test('a failed run says so until it is seen', async () => {
  const file = tempFile()
  try {
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-1' })
    await store.load()
    await store.create(draft())
    await store.recordRun('sa-1', { at: NOW, ok: false, message: 'gh: authentication required' })
    assert.equal(store.get('sa-1')?.lastFailureSeenAt, null)
    await store.markFailureSeen('sa-1')
    assert.equal(store.get('sa-1')?.lastFailureSeenAt, NOW)
    const saved = JSON.parse(readFileSync(file.path, 'utf8')) as { agents: ScheduledAgent[] }
    assert.equal(saved.agents[0]?.lastFailureSeenAt, NOW)
  } finally {
    file.cleanup()
  }
})

test('the scheduler runs each agent when its schedule comes round, then counts on from there', async () => {
  const time = fakeTime(NOW)
  const agents = [agent()]
  const runs: string[] = []
  const scheduler = createScheduledAgentsScheduler({
    list: () => agents,
    run: async (entry) => {
      runs.push(new Date(time.now()).toISOString())
      return { at: time.now(), ok: true, workspaceId: `run-for-${entry.id}` }
    },
    recordRun: async () => undefined,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  assert.equal(scheduler.nextRunAt('sa-1'), Date.UTC(2026, 8, 30, 13, 0))
  await time.advanceTo(Date.UTC(2026, 8, 30, 13, 0))
  assert.deepEqual(runs, ['2026-09-30T13:00:00.000Z'])
  assert.equal(scheduler.nextRunAt('sa-1'), Date.UTC(2026, 9, 1, 13, 0))
})

test('times missed while the computer slept run once on waking, not once each', async () => {
  const time = fakeTime(NOW)
  let runCount = 0
  const scheduler = createScheduledAgentsScheduler({
    list: () => [agent({ schedule: { cron: '0 * * * *', timezone: 'UTC' } })],
    run: async () => {
      runCount += 1
      return { at: time.now(), ok: true, workspaceId: 'w' }
    },
    recordRun: async () => undefined,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  // Asleep from 12:10 to 17:30: five hourly runs came due.
  await time.advanceTo(Date.UTC(2026, 8, 30, 17, 30))
  assert.equal(runCount, 1)
  assert.equal(scheduler.nextRunAt('sa-1'), Date.UTC(2026, 8, 30, 18, 0))
})

test('a schedule that changes counts from now; one that closes stops', async () => {
  const time = fakeTime(NOW)
  let agents = [agent()]
  const scheduler = createScheduledAgentsScheduler({
    list: () => agents,
    run: async () => ({ at: time.now(), ok: true, workspaceId: 'w' }),
    recordRun: async () => undefined,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  agents = [agent({ schedule: { cron: '30 12 * * *', timezone: 'UTC' } })]
  scheduler.refresh()
  assert.equal(scheduler.nextRunAt('sa-1'), Date.UTC(2026, 8, 30, 12, 30))
  agents = []
  scheduler.refresh()
  assert.equal(time.armedAt(), null)
})

test('a one-time schedule runs once at its time, and never again', async () => {
  const time = fakeTime(NOW)
  const at = Date.UTC(2026, 8, 30, 15, 30)
  let agents = [agent({ schedule: { cron: cronForInstant(at, 'UTC'), timezone: 'UTC', once: at } })]
  const runs: number[] = []
  const scheduler = createScheduledAgentsScheduler({
    list: () => agents,
    run: async () => {
      runs.push(time.now())
      return { at: time.now(), ok: true, workspaceId: 'w' }
    },
    recordRun: async (_id, run) => {
      agents = agents.map((entry) => ({ ...entry, lastRun: run }))
    },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  assert.equal(scheduler.nextRunAt('sa-1'), at)
  await time.advanceTo(at)
  assert.deepEqual(runs, [at])
  assert.equal(scheduler.nextRunAt('sa-1'), null, 'no next run: its cron names the same day next year, and is not read')
  await time.advanceTo(at + 366 * 24 * 60 * 60 * 1000)
  assert.equal(runs.length, 1)
})

test('a one-time schedule that comes due while a Run now of it is still working runs once that chat rests', async () => {
  const time = fakeTime(NOW)
  const at = Date.UTC(2026, 8, 30, 15, 30)
  // Run now, earlier: its chat is still at work when the schedule's time comes.
  let agents = [
    agent({
      schedule: { cron: cronForInstant(at, 'UTC'), timezone: 'UTC', once: at },
      lastRun: { at: NOW, ok: true, workspaceId: 'w-run-now' },
    }),
  ]
  let working = true
  const runs: number[] = []
  const skipped: string[] = []
  const scheduler = createScheduledAgentsScheduler({
    list: () => agents,
    run: async () => {
      runs.push(time.now())
      return { at: time.now(), ok: true, workspaceId: 'w-timed' }
    },
    recordRun: async (_id, run) => {
      agents = agents.map((entry) => ({ ...entry, lastRun: run }))
    },
    isRunWorking: () => working,
    onSkipped: (entry, reason) => skipped.push(`${entry.id}:${reason}`),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  await time.advanceTo(at)
  assert.deepEqual(runs, [], 'not beside the chat still doing its job')
  assert.deepEqual(skipped, [], 'a one-time schedule waits: skipping it would be never')
  assert.notEqual(time.armedAt(), null, 'it is looked at again')
  await time.advanceTo(time.armedAt()!)
  assert.deepEqual(runs, [], 'still working')
  working = false
  const next = time.armedAt()!
  await time.advanceTo(next)
  assert.deepEqual(runs, [next], 'it runs once the chat before it rests, without a restart')
  await time.advanceTo(next + 24 * 60 * 60 * 1000)
  assert.equal(runs.length, 1, 'and once only')
})

test('a one-time schedule whose time passed while the app was closed runs once it is open', async () => {
  const time = fakeTime(NOW)
  const at = NOW - 60 * 60 * 1000
  let runCount = 0
  const scheduler = createScheduledAgentsScheduler({
    list: () => [agent({ schedule: { cron: cronForInstant(at, 'UTC'), timezone: 'UTC', once: at } })],
    run: async () => {
      runCount += 1
      return { at: time.now(), ok: true, workspaceId: 'w' }
    },
    recordRun: async () => undefined,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  await time.advanceTo(NOW + 1)
  assert.equal(runCount, 1)
  // One whose run already went (it failed, and is kept to say so) is done.
  const ran = createScheduledAgentsScheduler({
    list: () => [
      agent({
        schedule: { cron: cronForInstant(at, 'UTC'), timezone: 'UTC', once: at },
        lastRun: { at: at + 1, ok: false, message: 'No such CLI.' },
      }),
    ],
    run: async () => ({ at: time.now(), ok: true, workspaceId: 'w' }),
    recordRun: async () => undefined,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  ran.start()
  assert.equal(ran.nextRunAt('sa-1'), null)
})

test('a one-time schedule is held to a time ahead, said in words, and its cron is its minute', () => {
  const at = Date.UTC(2026, 9, 7, 15, 30)
  const written = validateScheduledAgentDraft(draft({ schedule: { cron: '', timezone: 'UTC', once: at } }), NOW)
  assert.ok(written.ok)
  assert.deepEqual(written.draft.schedule, { cron: '30 15 7 10 *', timezone: 'UTC', once: at })
  assert.equal(scheduledAgentScheduleWords(written.draft.schedule), 'Once, Wed 7 Oct at 3:30 PM')
  const passed = validateScheduledAgentDraft(draft({ schedule: { cron: '', timezone: 'UTC', once: NOW - 1 } }), NOW)
  assert.deepEqual(passed, { ok: false, message: 'That time has already passed.' })
  // Read back from the file, a time gone by is the one it ran, or missed.
  assert.ok(
    validateScheduledAgentDraft(draft({ schedule: { cron: '', timezone: 'UTC', once: NOW - 1 } }), NOW, {
      stored: true,
    }).ok,
  )
})

test('a time that comes round while the last run is still working is skipped, and said so', async () => {
  const time = fakeTime(NOW)
  let agents = [agent({ lastRun: { at: NOW - 60_000, ok: true, workspaceId: 'run-1' } })]
  const working = new Set(['run-1'])
  const runs: string[] = []
  const skipped: string[] = []
  const scheduler = createScheduledAgentsScheduler({
    list: () => agents,
    run: async (entry) => {
      runs.push(entry.id)
      return { at: time.now(), ok: true, workspaceId: 'run-2' }
    },
    recordRun: async (id, run) => {
      agents = agents.map((entry) => (entry.id === id ? { ...entry, lastRun: run } : entry))
    },
    isRunWorking: (workspaceId) => working.has(workspaceId),
    onSkipped: (entry, reason) => skipped.push(`${entry.id}:${reason}`),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  await time.advanceTo(Date.UTC(2026, 8, 30, 13, 0))
  assert.deepEqual(runs, [], 'no second chat starts beside the working one')
  assert.deepEqual(skipped, ['sa-1:still_working'])
  // Not queued: the next time counts on from the skipped one.
  assert.equal(scheduler.nextRunAt('sa-1'), Date.UTC(2026, 9, 1, 13, 0))

  // Run now is refused the same way while the chat works, and runs once it has finished.
  assert.deepEqual(await scheduler.runNow('sa-1'), { ok: false, refused: 'still_working' })
  working.clear()
  const ran = await scheduler.runNow('sa-1')
  assert.deepEqual(ran, { ok: true, run: { at: time.now(), ok: true, workspaceId: 'run-2' } })
  assert.deepEqual(runs, ['sa-1'])
  assert.deepEqual(await scheduler.runNow('nope'), { ok: false, refused: 'unknown' })
})

test('a failed last run started no chat, so it holds nothing up', async () => {
  const scheduler = createScheduledAgentsScheduler({
    list: () => [agent({ lastRun: { at: NOW, ok: false, message: 'not a git repository' } })],
    run: async () => ({ at: NOW, ok: true, workspaceId: 'run-2' }),
    recordRun: async () => undefined,
    isRunWorking: () => true,
    now: () => NOW,
    setTimer: () => null,
    clearTimer: () => undefined,
  })
  assert.equal((await scheduler.runNow('sa-1')).ok, true)
})

test("a run's chat is working while a turn is open or waiting on a person, and not once it rests", () => {
  assert.equal(isRunChatWorking([]), false, 'no session: the chat settled, or the app restarted since')
  assert.equal(isRunChatWorking([{ status: 'ready' }]), false)
  assert.equal(isRunChatWorking([{ status: 'stopped' }]), false)
  assert.equal(isRunChatWorking([{ status: 'active' }]), true)
  assert.equal(isRunChatWorking([{ status: 'awaiting_approval' }]), true)
  assert.equal(isRunChatWorking([{ status: 'ready', turnStartedAt: NOW }]), true)
})

test('a run is a new chat in the project, on its machine, with what it was made with', async () => {
  const requests: ConversationLaunchRequest[] = []
  const result = await runScheduledAgent(
    agent({
      hostId: 'wsl:Ubuntu',
      cliModel: 'sonnet',
      permissionPreset: 'none',
      skills: [{ id: 'triage', name: 'Triage' }],
      mcpServers: [{ id: 'github', name: 'GitHub' }],
    }),
    {
      launchConversation: async (request) => {
        requests.push(request)
        return {
          ok: true,
          workspaceId: 'w-1',
          agentId: 'a',
          name: 'n',
          cli: 'claude-code',
          providerId: 'p',
          modelId: 'm',
          sessionId: 's',
        }
      },
      getRepoRoot: async () => null,
      createWorktree: async () => ({ ok: false, message: 'not asked' }),
      now: () => NOW,
    },
  )
  assert.deepEqual(result, { at: NOW, ok: true, workspaceId: 'w-1', agentId: 'a' })
  assert.equal(typeof requests[0]?.onFirstSendFailed, 'function', 'the run hears if its first message is refused')
  assert.deepEqual(
    requests.map(({ onFirstSendFailed: _heard, ...request }) => request),
    [
      {
        newChatIn: { folderPath: '/Users/dev/acme', hostId: 'wsl:Ubuntu', worktree: null },
        cli: 'claude-code',
        cliModel: 'sonnet',
        permissionPreset: 'none',
        prompt: 'Triage the issues opened since the last run.',
        skills: ['triage'],
        connectorIds: ['github'],
        // The chat says which schedule started it.
        scheduledAgentId: 'sa-1',
        // And it opens without taking the window from whatever is on screen.
        background: true,
      },
    ],
  )
})

test('a worktree run starts in a fresh worktree named for the run, on the machine’s own git', async () => {
  const requests: ConversationLaunchRequest[] = []
  const worktrees: Array<{ branchName: string; hostId: string | null }> = []
  await runScheduledAgent(agent({ hostId: 'wsl:Ubuntu', worktree: { name: 'triage' } }), {
    launchConversation: async (request) => {
      requests.push(request)
      return {
        ok: true,
        workspaceId: 'w',
        agentId: 'a',
        name: 'n',
        cli: 'c',
        providerId: 'p',
        modelId: 'm',
        sessionId: 's',
      }
    },
    getRepoRoot: async () => '/Users/dev/acme',
    createWorktree: async (input) => {
      worktrees.push({ branchName: input.branchName, hostId: input.hostId })
      return { ok: true, path: `${input.destinationPath}`, branch: input.branchName }
    },
    now: () => new Date(2026, 8, 30, 21, 0).getTime(),
  })
  assert.deepEqual(worktrees, [{ branchName: 'agent/triage-20260930-210000', hostId: 'wsl:Ubuntu' }])
  assert.equal(requests[0]?.newChatIn?.worktree?.branch, 'agent/triage-20260930-210000')
  assert.equal(requests[0]?.newChatIn?.worktree?.repoRoot, '/Users/dev/acme')
})

test('a run whose chat does not start gives back the worktree it made for it', async () => {
  const discarded: Array<{ repoRoot: string; path: string; leaseId: string | null }> = []
  const result = await runScheduledAgent(agent({ worktree: { name: 'triage' } }), {
    launchConversation: async () => ({ ok: false, code: 'conversation_start_failed', message: 'No CLI.' }),
    getRepoRoot: async () => '/Users/dev/acme',
    createWorktree: async () => ({ ok: true, path: '/Users/dev/acme-run', branch: 'agent/triage-run', leaseId: 'l-1' }),
    discardWorktree: async ({ repoRoot, path, leaseId }) => {
      discarded.push({ repoRoot, path, leaseId })
    },
    now: () => NOW,
  })
  assert.deepEqual(result, { at: NOW, ok: false, message: 'No CLI.' })
  assert.deepEqual(discarded, [{ repoRoot: '/Users/dev/acme', path: '/Users/dev/acme-run', leaseId: 'l-1' }])
})

test('a run whose first message is refused is a failed run, whenever the refusal comes', async () => {
  const launched = {
    ok: true as const,
    workspaceId: 'w-1',
    agentId: 'a',
    name: 'n',
    cli: 'c',
    providerId: 'p',
    modelId: 'm',
    sessionId: 's',
  }
  // Refused before the launch has answered: the run fails outright.
  const early = await runScheduledAgent(agent(), {
    launchConversation: async (request) => {
      request.onFirstSendFailed?.('The first message was refused: not signed in')
      return launched
    },
    getRepoRoot: async () => null,
    createWorktree: async () => ({ ok: false, message: 'unused' }),
    now: () => NOW,
  })
  assert.deepEqual(early, { at: NOW, ok: false, message: 'The first message was refused: not signed in' })

  // Refused after: the run is recorded as started, and told of the failure by its chat.
  let refuse: ((message: string) => void) | undefined
  const late: Array<[string, string]> = []
  const started = await runScheduledAgent(agent(), {
    launchConversation: async (request) => {
      refuse = request.onFirstSendFailed
      return launched
    },
    getRepoRoot: async () => null,
    createWorktree: async () => ({ ok: false, message: 'unused' }),
    onFirstSendFailed: (workspaceId, message) => late.push([workspaceId, message]),
    now: () => NOW,
  })
  assert.deepEqual(started, { at: NOW, ok: true, workspaceId: 'w-1', agentId: launched.agentId })
  refuse?.('refused')
  assert.deepEqual(late, [['w-1', 'refused']])
})

test('a started run that failed after all is recorded as failed, only while it is the last run', async () => {
  const file = tempFile()
  try {
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-1' })
    await store.load()
    await store.create(draft())
    await store.recordRun('sa-1', { at: NOW, ok: true, workspaceId: 'run-1' })
    assert.equal(await store.failRun('sa-1', 'run-0', 'late'), false, 'an earlier run is not the last one')
    assert.equal(await store.failRun('sa-1', 'run-1', 'refused'), true)
    assert.deepEqual(store.get('sa-1')?.lastRun, { at: NOW, ok: false, message: 'refused' })
  } finally {
    file.cleanup()
  }
})

test('a run that cannot start says why, and nothing starts', async () => {
  const notRepo = await runScheduledAgent(agent({ worktree: { name: '' } }), {
    launchConversation: async () => {
      throw new Error('must not launch')
    },
    getRepoRoot: async () => null,
    createWorktree: async () => ({ ok: false, message: 'unused' }),
    now: () => NOW,
  })
  assert.equal(notRepo.ok, false)
  if (!notRepo.ok) assert.match(notRepo.message, /not a git repository/u)

  const refused = await runScheduledAgent(agent(), {
    launchConversation: async () => ({ ok: false, code: 'cli_not_conversational', message: 'No chat runtime.' }),
    getRepoRoot: async () => null,
    createWorktree: async () => ({ ok: false, message: 'unused' }),
    now: () => NOW,
  })
  assert.deepEqual(refused, { at: NOW, ok: false, message: 'No chat runtime.' })
})

test('the service validates every write and an extension reaches only its own', async () => {
  const file = tempFile()
  try {
    let id = 0
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => `sa-${++id}` })
    await store.load()
    const scheduler = createScheduledAgentsScheduler({
      list: () => store.list(),
      run: async () => ({ at: NOW, ok: true, workspaceId: 'w' }),
      recordRun: (entry, run) => store.recordRun(entry, run),
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => undefined,
    })
    const service = createScheduledAgentsService({ store, scheduler, now: () => NOW })
    const seen: number[] = []
    service.onChanged((agents) => seen.push(agents.length))

    const bad = await service.create({ ...draft(), schedule: { cron: '0 25 * * *', timezone: 'UTC' } })
    assert.deepEqual(bad, { ok: false, message: 'Hour 25 doesn’t exist — use 0–23.' })
    const never = await service.create({ ...draft(), schedule: { cron: '0 0 30 2 *', timezone: 'UTC' } })
    assert.equal(never.ok, false)

    const mine = await service.create(draft())
    assert.equal(mine.ok, true)
    const registry = createScheduledAgentsModuleRegistry(service, () => [])
    const theirs = await registry.create('weather-deck', draft({ prompt: 'Refresh the forecast.' }))
    assert.equal(theirs.ok, true)

    assert.deepEqual(
      (await registry.list('weather-deck')).map((entry) => entry.prompt),
      ['Refresh the forecast.'],
    )
    assert.deepEqual(await registry.remove('weather-deck', 'sa-1'), {
      ok: false,
      message: 'No scheduled agent "sa-1".',
    })
    assert.deepEqual(await registry.remove('weather-deck', 'sa-2'), { ok: true })
    assert.deepEqual(
      service.list().map((entry) => entry.id),
      ['sa-1'],
    )
    assert.deepEqual(seen, [1, 2, 1])
  } finally {
    file.cleanup()
  }
})

test("an extension's schedule goes no looser than the extension, or the agent calling it, may", async () => {
  const file = tempFile()
  try {
    let id = 0
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => `sa-${++id}` })
    await store.load()
    const ran: string[] = []
    const scheduler = createScheduledAgentsScheduler({
      list: () => store.list(),
      run: async (entry) => {
        ran.push(entry.id)
        return { at: NOW, ok: true, workspaceId: 'w' }
      },
      recordRun: (entry, run) => store.recordRun(entry, run),
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => undefined,
    })
    const service = createScheduledAgentsService({ store, scheduler, now: () => NOW })
    const permissions: Record<string, string[]> = { plain: ['scheduled-agents.manage'], loose: ['conversation:bypass'] }
    const registry = createScheduledAgentsModuleRegistry(service, (moduleId) => permissions[moduleId])

    const plain = await registry.create('plain', draft({ permissionPreset: 'bypass' }))
    assert.equal(plain.ok && plain.agent.permissionPreset, 'auto', 'lowered to the module ceiling')
    const loose = await registry.create('loose', draft({ permissionPreset: 'bypass' }))
    assert.equal(loose.ok && loose.agent.permissionPreset, 'bypass')
    const unset = await registry.create('plain', draft())
    assert.equal(unset.ok && unset.agent.permissionPreset, null, "the person's own default is theirs")
    const updated = await registry.update('plain', 'sa-3', draft({ permissionPreset: 'bypass' }))
    assert.equal(updated.ok && updated.agent.permissionPreset, 'auto')

    // During a capped agent's tool call the stored preset is pinned to that
    // agent's, and a run that could go looser is refused.
    const pinned = await runAsModuleToolCall({ permissionCeiling: 'manual' }, () =>
      registry.create('loose', draft({ permissionPreset: 'bypass' })),
    )
    assert.equal(pinned.ok && pinned.agent.permissionPreset, 'manual')
    const refused = await runAsModuleToolCall({ permissionCeiling: 'manual' }, () => registry.runNow('loose', 'sa-2'))
    assert.equal(refused.ok, false)
    assert.deepEqual(ran, [])
    assert.equal((await registry.runNow('loose', 'sa-2')).ok, true)

    // At run time, the module as it is now: a bypass schedule from a module
    // that no longer declares it runs on the ceiling.
    const stored = store.get('sa-2')!
    assert.equal(withinOwnerModuleCeiling(stored, () => []).permissionPreset, 'auto')
    assert.equal(
      withinOwnerModuleCeiling(stored, (moduleId) => permissions[moduleId]),
      stored,
    )
    const personal = { ...stored, ownerModuleId: null }
    assert.equal(
      withinOwnerModuleCeiling(personal, () => []),
      personal,
      "the person's own schedules are theirs",
    )
  } finally {
    file.cleanup()
  }
})

test("Run now says why it did not run when the last run's chat is still working", async () => {
  const file = tempFile()
  try {
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-1' })
    await store.load()
    await store.create(draft())
    await store.recordRun('sa-1', { at: NOW, ok: true, workspaceId: 'run-1' })
    let working = true
    const scheduler = createScheduledAgentsScheduler({
      list: () => store.list(),
      run: async () => ({ at: NOW, ok: true, workspaceId: 'run-2' }),
      recordRun: (entry, run) => store.recordRun(entry, run),
      isRunWorking: () => working,
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => undefined,
    })
    const service = createScheduledAgentsService({ store, scheduler, now: () => NOW })
    assert.deepEqual(await service.runNow('sa-1'), { ok: false, message: 'Its last run is still working.' })
    assert.deepEqual(store.get('sa-1')?.lastRun, { at: NOW, ok: true, workspaceId: 'run-1' }, 'nothing is recorded')
    working = false
    assert.deepEqual(await service.runNow('sa-1'), { ok: true, run: { at: NOW, ok: true, workspaceId: 'run-2' } })
  } finally {
    file.cleanup()
  }
})

test('a write before the file was read waits for it, so the file keeps what it had', async () => {
  const file = tempFile()
  try {
    writeFileSync(file.path, JSON.stringify({ version: 1, agents: [agent()] }))
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-2' })
    // The window's create arrives before the scheduler's sidecar loads the store.
    const [created] = await Promise.all([store.create(draft()), store.load()])
    assert.equal(created.id, 'sa-2')
    const saved = JSON.parse(readFileSync(file.path, 'utf8')) as { agents: ScheduledAgent[] }
    assert.deepEqual(
      saved.agents.map((entry) => entry.id),
      ['sa-1', 'sa-2'],
    )
  } finally {
    file.cleanup()
  }
})

test('a file that is there but cannot be read refuses every write, rather than replacing it', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  const file = tempFile()
  try {
    const before = JSON.stringify({ version: 1, agents: [agent()] })
    writeFileSync(file.path, before)
    chmodSync(file.path, 0o000)
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-2' })
    await store.load()
    await assert.rejects(store.create(draft()), /could not be read/u)
    const scheduler = createScheduledAgentsScheduler({
      list: () => store.list(),
      run: async () => ({ at: NOW, ok: true, workspaceId: 'w' }),
      recordRun: (entry, run) => store.recordRun(entry, run),
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => undefined,
    })
    const service = createScheduledAgentsService({ store, scheduler, now: () => NOW })
    const answer = await service.create(draft())
    assert.equal(answer.ok, false, 'the caller is told, not thrown at')
    assert.deepEqual(store.list(), [], 'nothing is scheduled that is not saved')
    chmodSync(file.path, 0o600)
    assert.equal(readFileSync(file.path, 'utf8'), before)
  } finally {
    file.cleanup()
  }
})

test('a file that cannot be understood is kept aside, and the list starts empty', async () => {
  const file = tempFile()
  try {
    writeFileSync(file.path, '{"version":1,"agents":[{"id":"sa-1",')
    const warnings: string[] = []
    const store = createScheduledAgentsStore({
      filePath: file.path,
      now: () => NOW,
      newId: () => 'sa-2',
      warn: (message) => warnings.push(message),
    })
    await store.load()
    assert.deepEqual(store.list(), [])
    assert.equal(readFileSync(`${file.path}.corrupt-${NOW}`, 'utf8'), '{"version":1,"agents":[{"id":"sa-1",')
    assert.ok(warnings.some((message) => message.includes('.corrupt-')))
    await store.create(draft())
    const saved = JSON.parse(readFileSync(file.path, 'utf8')) as { agents: ScheduledAgent[] }
    assert.deepEqual(
      saved.agents.map((entry) => entry.id),
      ['sa-2'],
    )
  } finally {
    file.cleanup()
  }
})

test('an entry that no longer validates is written back as it was, not dropped by the next change', async () => {
  const file = tempFile()
  try {
    const invalid = { ...agent({ id: 'sa-9' }), schedule: { cron: '0 25 * * *', timezone: 'UTC' } }
    writeFileSync(file.path, JSON.stringify({ version: 1, agents: [agent(), invalid] }))
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-2' })
    await store.load()
    await store.create(draft())
    await store.remove('sa-1')
    const saved = JSON.parse(readFileSync(file.path, 'utf8')) as { agents: unknown[] }
    assert.deepEqual(saved.agents, [{ ...agent({ id: 'sa-2' }), createdAt: NOW, updatedAt: NOW }, invalid])
  } finally {
    file.cleanup()
  }
})

test('a run whose record cannot be written is logged, not left as an unhandled rejection', async () => {
  const time = fakeTime(Date.UTC(2026, 8, 30, 12, 59))
  const logs: string[] = []
  const ran: string[] = []
  const scheduler = createScheduledAgentsScheduler({
    list: () => [agent()],
    run: async () => ({ at: time.now(), ok: true, workspaceId: 'w' }),
    recordRun: async () => {
      throw new Error('disk full')
    },
    onRan: (entry) => ran.push(entry.id),
    log: (message) => logs.push(message),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  await time.advanceTo(Date.UTC(2026, 8, 30, 13, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(ran, ['sa-1'], 'the run still counts as run')
  assert.match(logs[0] ?? '', /could not be recorded: disk full/u)
  scheduler.stop()
})

test('a run on its way when the scheduler stops (the app quitting) starts no chat and records nothing', async () => {
  const time = fakeTime(Date.UTC(2026, 8, 30, 12, 59))
  let release: () => void = () => undefined
  const recorded: unknown[] = []
  const launched: string[] = []
  const scheduler = createScheduledAgentsScheduler({
    list: () => [agent({ worktree: { name: 'nightly' } })],
    // The run is making its worktree when the quit comes.
    run: (entry, signal) =>
      runScheduledAgent(
        entry,
        {
          getRepoRoot: async () => '/Users/dev/acme',
          createWorktree: async (input) => {
            await new Promise<void>((resolve) => (release = resolve))
            return { ok: true, path: input.destinationPath, branch: input.branchName }
          },
          discardWorktree: async ({ path }) => {
            launched.push(`discarded:${path.includes('nightly')}`)
          },
          launchConversation: async () => {
            launched.push('chat')
            return { ok: true, workspaceId: 'ws-run', agentId: 'agent-1' } as never
          },
          now: time.now,
        },
        signal,
      ),
    recordRun: async (_id, run) => {
      recorded.push(run)
    },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  scheduler.start()
  await time.advanceTo(Date.UTC(2026, 8, 30, 13, 0))
  scheduler.stop()
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(launched, ['discarded:true'], 'its worktree goes back, and no chat starts')
  assert.deepEqual(recorded, [])

  // Started again, Run now works as before.
  scheduler.start()
  const ran = scheduler.runNow('sa-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  assert.equal((await ran).ok, true)
  assert.deepEqual(launched, ['discarded:true', 'chat'])
})
