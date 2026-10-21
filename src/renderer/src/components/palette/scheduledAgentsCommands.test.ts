import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ScheduledAgentView } from '../../../../shared/scheduled-agents'
import { pauseAllChoices, scheduledAgentsPauseWords, type PauseAllChoice } from '../../utils/scheduledAgentsPause'
import { scheduledAgentPaletteCommands } from './scheduledAgentsCommands'

// Wednesday 30 September 2026, 14:10 local.
const NOW = new Date(2026, 8, 30, 14, 10).getTime()

const agent = (id: string, prompt: string, fields: Partial<ScheduledAgentView> = {}): ScheduledAgentView =>
  ({ id, prompt, schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' }, nextRunAt: null, ...fields }) as ScheduledAgentView

function recorder() {
  const calls: string[] = []
  return {
    calls,
    actions: {
      pauseAll: (choice: PauseAllChoice) => calls.push(`pause-all:${choice.id}:${choice.until}`),
      resumeAll: () => calls.push('resume-all'),
      setPaused: (entry: ScheduledAgentView, paused: boolean) =>
        calls.push(`${paused ? 'pause' : 'resume'}:${entry.id}`),
    },
  }
}

test('the palette offers to pause them all three ways, and each schedule on its own', () => {
  const { calls, actions } = recorder()
  const rows = scheduledAgentPaletteCommands(
    [agent('sa-1', 'Fix open GitHub issues'), agent('sa-2', 'Apply bug fixes to Studio', { pausedAt: NOW - 1 })],
    null,
    NOW,
    actions,
  )
  assert.deepEqual(
    rows.map((row) => row.label),
    [
      'Pause all scheduled agents for 1 hour',
      'Pause all scheduled agents until tomorrow morning',
      'Pause all scheduled agents until I resume them',
      'Pause schedule: Fix open GitHub issues',
      'Resume schedule: Apply bug fixes to Studio',
    ],
  )
  for (const row of rows) row.run()
  const tomorrowNine = new Date(2026, 9, 1, 9, 0).getTime()
  assert.deepEqual(calls, [
    `pause-all:hour:${NOW + 60 * 60 * 1000}`,
    `pause-all:tomorrow:${tomorrowNine}`,
    'pause-all:until-resumed:null',
    'pause:sa-1',
    'resume:sa-2',
  ])
})

test('while they are all paused, the palette offers Resume instead, saying until when', () => {
  const { calls, actions } = recorder()
  const until = NOW + 60 * 60 * 1000
  const rows = scheduledAgentPaletteCommands(
    [agent('sa-1', 'Fix open GitHub issues')],
    { since: NOW, until },
    NOW,
    actions,
  )
  assert.equal(rows[0]?.label, 'Resume scheduled agents')
  assert.equal(rows[0]?.description, scheduledAgentsPauseWords({ since: NOW, until }, NOW))
  assert.equal(
    rows.some((row) => row.label.startsWith('Pause all')),
    false,
  )
  rows[0]!.run()
  assert.deepEqual(calls, ['resume-all'])
})

test('with no scheduled agents there is nothing to pause', () => {
  assert.deepEqual(scheduledAgentPaletteCommands([], null, NOW, recorder().actions), [])
})

test('a pause of them all is said with its end, or without one', () => {
  assert.equal(scheduledAgentsPauseWords({ since: NOW, until: null }, NOW), 'Scheduled agents paused')
  assert.match(
    scheduledAgentsPauseWords({ since: NOW, until: NOW + 60 * 60 * 1000 }, NOW),
    /^Scheduled agents paused until \d/u,
  )
  const [hour, tomorrow, resumed] = pauseAllChoices(NOW)
  assert.equal(hour?.until, NOW + 60 * 60 * 1000)
  assert.equal(tomorrow?.until, new Date(2026, 9, 1, 9, 0).getTime())
  assert.equal(resumed?.until, null)
})
