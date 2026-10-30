import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { cronForInstant, type ScheduledAgent, type ScheduledAgentLastRun } from '../../shared/scheduled-agents'
import { createScheduledRunOutcomes } from './run-outcomes'
import { createScheduledAgentsStore } from './store'

const NOW = Date.UTC(2026, 8, 30, 12, 10)
const ONCE = NOW - 60_000
const STARTED: ScheduledAgentLastRun = { at: NOW, ok: true, workspaceId: 'ws-run', agentId: 'chat' }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup(schedule: { once?: number } = { once: ONCE }) {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-run-outcomes-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = createScheduledAgentsStore({
    filePath: join(dir, 'scheduled-agents.json'),
    now: () => NOW,
    newId: () => 'sa-1',
  })
  const created = await store.create({
    prompt: 'Send the release notes.',
    schedule: {
      cron: schedule.once !== undefined ? cronForInstant(schedule.once, 'UTC') : '0 13 * * *',
      timezone: 'UTC',
      ...(schedule.once !== undefined ? { once: schedule.once } : {}),
    },
    folderPath: '/Users/dev/acme',
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: null,
    skills: [],
    mcpServers: [],
    worktree: null,
  })
  const ran: ScheduledAgentLastRun[] = []
  let changes = 0
  const outcomes = createScheduledRunOutcomes({
    store,
    notifyRan: (_agent, run) => ran.push(run),
    notifyChanged: () => {
      changes += 1
    },
    warn: (message) => assert.fail(message),
  })
  // The scheduler's order: the run is recorded, then reported.
  const finish = async (agent: ScheduledAgent, run: ScheduledAgentLastRun) => {
    await outcomes.recordRun(agent.id, run)
    outcomes.onRan(agent, run)
  }
  return { store, agent: created, outcomes, finish, ran, changes: () => changes }
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

test('a one-time schedule whose chat started and took its first message is closed', async () => {
  const { store, agent, finish, ran } = await setup()
  await finish(agent, STARTED)
  await settled()
  assert.equal(store.get(agent.id), null)
  assert.deepEqual(ran, [STARTED], 'its run is heard before it closes')
})

test('a one-time schedule whose first message was refused before its start was recorded stays, with the failure', async () => {
  const { store, agent, outcomes, finish } = await setup()
  outcomes.firstSendFailed(agent.id, 'ws-run', 'The CLI is signed out.')
  await settled()
  await finish(agent, STARTED)
  await settled()
  const kept = store.get(agent.id)
  assert.ok(kept, 'a failed one-time schedule stays to say so')
  assert.deepEqual(kept.lastRun, { at: NOW, ok: false, message: 'The CLI is signed out.' })
})

test('a refusal heard between the record and the close keeps the schedule', async () => {
  const { store, agent, outcomes } = await setup()
  await outcomes.recordRun(agent.id, STARTED)
  outcomes.firstSendFailed(agent.id, 'ws-run', 'The chat is busy elsewhere.')
  outcomes.onRan(agent, STARTED)
  await settled()
  assert.deepEqual(store.get(agent.id)?.lastRun, { at: NOW, ok: false, message: 'The chat is busy elsewhere.' })
})

test('a refusal heard after the one-time schedule closed puts it back, with the failure', async () => {
  const { store, agent, outcomes, finish, changes } = await setup()
  await finish(agent, STARTED)
  await settled()
  assert.equal(store.get(agent.id), null)
  const before = changes()
  outcomes.firstSendFailed(agent.id, 'ws-run', 'The dependency install failed.')
  await settled()
  const back = store.get(agent.id)
  assert.ok(back, 'the schedule is back to say its run failed')
  assert.deepEqual(back.lastRun, { at: NOW, ok: false, message: 'The dependency install failed.' })
  assert.equal(back.prompt, agent.prompt)
  assert.ok(changes() > before, 'the windows hear it is back')
})

test('a refusal for a repeating schedule is recorded on it, and it was never closed', async () => {
  const { store, agent, outcomes, finish } = await setup({})
  await finish(agent, STARTED)
  outcomes.firstSendFailed(agent.id, 'ws-run', 'Refused.')
  await settled()
  assert.deepEqual(store.get(agent.id)?.lastRun, { at: NOW, ok: false, message: 'Refused.' })
})

test('a refusal for a chat no schedule started changes nothing', async () => {
  const { store, agent, outcomes, finish } = await setup()
  await finish(agent, STARTED)
  await settled()
  outcomes.firstSendFailed(agent.id, 'ws-other', 'Refused.')
  await settled()
  assert.equal(store.get(agent.id), null)
})
