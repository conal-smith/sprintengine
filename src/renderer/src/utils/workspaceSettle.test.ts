import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import { getRendererHost } from '../modules'
import {
  WORKSPACE_AUTO_SETTLE_AFTER_MS,
  decideWorkspaceSettlement,
  isSettledWorkspace,
  settleWorkspacePatch,
  shouldAutoSettleWorkspace,
  wakeWorkspacePatch,
  workspaceLastActiveAt,
} from './workspaceSettle'
import { isSnoozedWorkspace } from './workspaceSnooze'
import { test } from 'vitest'

test('workspaceSettle', async () => {
  const NOW = 1_000_000_000_000
  const DAY = 24 * 60 * 60 * 1000

  // Only the fields the rules read; cast at the test boundary keeps the
  // fixtures readable without an `any`. Auto-settle is switched on here so the
  // rules below are exercised; its default, off, is asserted on its own.
  function ws(fields: Partial<Workspace>): Workspace {
    return {
      id: 'w',
      name: 'w',
      mode: 'standard',
      createdAt: NOW - 10 * DAY,
      lastTerminalActivityAt: null,
      autoSettleEnabled: true,
      ...fields,
    } as unknown as Workspace
  }

  // One predicate for "resting".
  assert.equal(isSettledWorkspace(ws({})), false, 'a fresh row is not settled')
  assert.equal(isSettledWorkspace(ws({ settledAt: NOW })), true, 'settledAt rests')
  assert.equal(isSettledWorkspace(ws({ settledAt: null })), false, 'an explicit null is not a stamp')

  // Last activity is the whole chat going quiet: the person's last work OR the
  // agent's last turn end, whichever is later.
  assert.equal(workspaceLastActiveAt(ws({})), NOW - 10 * DAY, 'creation when nothing else')
  assert.equal(
    workspaceLastActiveAt(ws({ lastTerminalActivityAt: NOW - 2 * DAY, lastTurnEndedAt: NOW - 5 * DAY })),
    NOW - 2 * DAY,
    'typing later than the turn end wins',
  )
  assert.equal(
    workspaceLastActiveAt(ws({ lastTerminalActivityAt: NOW - 5 * DAY, lastTurnEndedAt: NOW - DAY })),
    NOW - DAY,
    'a turn that ended after the last keystroke counts as activity',
  )

  // Auto-settle is opt-in per chat: a row nobody switched it on for never
  // settles by itself, however long it has been quiet.
  assert.equal(shouldAutoSettleWorkspace(ws({ autoSettleEnabled: undefined }), NOW), false, 'off by default')
  assert.equal(shouldAutoSettleWorkspace(ws({ autoSettleEnabled: null }), NOW), false, 'a cleared switch is off')

  // The 3-day idle rule, measured from last activity.
  assert.equal(shouldAutoSettleWorkspace(ws({}), NOW), true, 'idle 10 days settles')
  assert.equal(
    shouldAutoSettleWorkspace(ws({ lastTerminalActivityAt: NOW - DAY }), NOW),
    false,
    'typed yesterday stays',
  )
  assert.equal(
    shouldAutoSettleWorkspace(ws({ lastTurnEndedAt: NOW - DAY }), NOW),
    false,
    'an agent that finished yesterday stays',
  )
  assert.equal(
    shouldAutoSettleWorkspace(ws({ createdAt: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS + 1 }), NOW),
    false,
    'just inside the window stays',
  )
  assert.equal(
    shouldAutoSettleWorkspace(ws({ createdAt: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS }), NOW),
    true,
    'exactly at the threshold settles',
  )

  // Exempt for good: already resting, a hand decision, starred, remote-born, the hosts.
  assert.equal(shouldAutoSettleWorkspace(ws({ settledAt: NOW - DAY }), NOW), false, 'never re-settle')
  assert.equal(
    shouldAutoSettleWorkspace(ws({ settledOverride: 'active' }), NOW),
    false,
    'a manual Un-settle holds the row active',
  )
  assert.equal(
    shouldAutoSettleWorkspace(ws({ settledOverride: 'settled' }), NOW),
    false,
    "a manual Settle is not the sweep's to touch",
  )
  // A running snooze is a hand decision about the near future; the sweep never
  // overrules one (snooze, 2026-09-10). A SPENT one holds nothing off.
  assert.equal(
    shouldAutoSettleWorkspace(ws({ snoozedUntil: NOW + 60 * 60 * 1000 }), NOW),
    false,
    'a sleeping row is not settled out from under its own wake time',
  )
  assert.equal(
    shouldAutoSettleWorkspace(ws({ snoozedUntil: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS }), NOW),
    true,
    'once the snooze is long spent the usual idle rule resumes',
  )
  assert.equal(
    shouldAutoSettleWorkspace(ws({ highlight: { starred: true, color: null } }), NOW),
    false,
    'starred never settles',
  )
  assert.equal(
    shouldAutoSettleWorkspace(
      ws({ remoteOrigin: { connectionId: 'c', machineName: 'm' } as unknown as Workspace['remoteOrigin'] }),
      NOW,
    ),
    false,
    "a row born on a paired machine is the Remote band's, not the sweep's",
  )

  // A row whose MODULE reports a run still in flight never settles on its own,
  // however old it is; a run the module reports finished settles like any other
  // quiet row. The status comes from the owning workspace type's run-glyph
  // provider, so the rule is exercised against types registered here — no bundled
  // type ships a provider.
  {
    const settleHost = getRendererHost()
    const registerSettleProbe = (id: string, state: string | null): void => {
      settleHost.hostFor('scheduled-agents').registerWorkspaceType({
        id,
        label: id,
        description: 'Test-only workspace type.',
        icon: () => null,
        hiddenFromPicker: true,
        createTemplate: () => ({
          id,
          name: id,
          description: 'Test-only workspace type.',
          previewSlots: [],
          layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
        }),
        deriveRunGlyph: () => (state ? { state, live: false, label: state } : null),
      } as never)
    }
    registerSettleProbe('settle-probe-running', 'in_progress')
    registerSettleProbe('settle-probe-waiting', 'needs_input')
    registerSettleProbe('settle-probe-done', 'done')
    registerSettleProbe('settle-probe-quiet', null)

    assert.equal(
      shouldAutoSettleWorkspace(ws({ mode: 'settle-probe-running' as Workspace['mode'] }), NOW),
      false,
      'a run still in flight never settles',
    )
    assert.equal(
      shouldAutoSettleWorkspace(ws({ mode: 'settle-probe-waiting' as Workspace['mode'] }), NOW),
      false,
      'a run waiting on the person never settles',
    )
    assert.equal(
      shouldAutoSettleWorkspace(ws({ mode: 'settle-probe-done' as Workspace['mode'] }), NOW),
      true,
      'a finished run settles once idle',
    )
    assert.equal(
      shouldAutoSettleWorkspace(ws({ mode: 'settle-probe-quiet' as Workspace['mode'] }), NOW),
      true,
      'a provider reporting no run signal pins nothing',
    )
  }

  // The sweep's decision, given what only the caller knows.
  const decide = (workspace: Workspace, flags: { active?: boolean; busy?: boolean; held?: boolean } = {}) =>
    decideWorkspaceSettlement({
      workspace,
      now: NOW,
      active: flags.active ?? false,
      busy: flags.busy ?? false,
      held: flags.held ?? false,
    })
  assert.equal(decide(ws({})), 'settle', 'a quiet idle row settles')
  assert.equal(decide(ws({}), { active: true }), 'none', 'the row someone is looking at is never settled under them')
  assert.equal(decide(ws({}), { busy: true }), 'none', 'a busy row is not idle, whatever the clock says')
  assert.equal(decide(ws({}), { held: true }), 'none', 'a row wearing the unseen finished mark is not settled away')
  assert.equal(decide(ws({ lastTerminalActivityAt: NOW - DAY })), 'none', 'a recent row is left alone')
  assert.equal(decide(ws({ settledAt: NOW - DAY })), 'none', 'a resting quiet row keeps resting')
  assert.equal(decide(ws({ settledAt: NOW - DAY }), { active: true }), 'none', 'reading a settled row does not wake it')
  assert.equal(decide(ws({ settledAt: NOW - DAY }), { busy: true }), 'wake', 'a resting row that is busy again wakes')
  assert.equal(
    decide(ws({ settledAt: NOW - DAY, settledOverride: 'settled' }), { busy: true }),
    'wake',
    'activity wakes even a hand-settled row — new activity resumes the usual rules',
  )
  assert.equal(
    decide(ws({ settledAt: NOW - DAY, settledOverride: 'settled' }), { held: true }),
    'none',
    'the unseen mark is a thing to look at, not activity: it never undoes a hand Settle',
  )
  assert.equal(
    decide(ws({ settledAt: NOW - DAY }), { held: true }),
    'wake',
    'but a row the SWEEP settled that wants the person comes back — it was settled on a reading taken too early',
  )
  assert.equal(decide(ws({ settledOverride: 'active' })), 'none', 'a hand Un-settle holds against the sweep')

  // Settle on merge: a chat a day old (too recent for the idle rule) whose
  // pull requests have landed.
  const recent = (fields: Partial<Workspace> = {}) =>
    ws({ createdAt: NOW - 2 * DAY, lastUserMessageAt: NOW - DAY, ...fields })
  const pr = (state: 'open' | 'merged' | 'closed', endedAt?: number) =>
    ({
      url: `https://github.com/o/r/pull/${state}${endedAt ?? ''}`,
      repoKey: 'github.com/o/r',
      repoName: 'r',
      number: 1,
      title: '',
      state,
      isDraft: false,
      openedAt: NOW - 2 * DAY,
      stateAt: NOW,
      ...(endedAt !== undefined ? { endedAt } : {}),
    }) as const
  const onMerge = (workspace: Workspace, pullRequests: ReturnType<typeof pr>[], settleOnMerge = true) =>
    decideWorkspaceSettlement({
      workspace,
      now: NOW,
      active: false,
      busy: false,
      held: false,
      context: { pullRequests, settleOnMerge },
    })
  assert.equal(onMerge(recent(), [pr('merged', NOW - 60_000)]), 'settle', 'a merged pull request settles its chat')
  assert.equal(
    onMerge(recent(), [pr('merged', NOW - 60_000), pr('closed', NOW - 30_000)]),
    'settle',
    'one merged and one closed is still landed',
  )
  assert.equal(onMerge(recent(), [pr('closed', NOW - 60_000)]), 'none', 'closed without merging did not land')
  assert.equal(
    onMerge(recent(), [pr('merged', NOW - 60_000), pr('open')]),
    'none',
    'an open pull request is work still going',
  )
  assert.equal(
    onMerge(recent({ lastUserMessageAt: NOW - 1000 }), [pr('merged', NOW - 60_000)]),
    'none',
    'a message after the merge is the person carrying on',
  )
  assert.equal(
    onMerge(recent({ lastTerminalActivityAt: NOW - 1000 }), [pr('merged', NOW - 60_000)]),
    'none',
    'so is a keystroke into one of its terminals: a dev server started after the merge would die with the chat',
  )
  assert.equal(onMerge(recent(), [pr('merged')]), 'none', 'a merge with no time cannot say who came after it')
  assert.equal(onMerge(recent(), [pr('merged', NOW - 60_000)], false), 'none', 'the setting off, merges settle nothing')
  assert.equal(onMerge(recent(), []), 'none', 'no pull requests, nothing landed')
  assert.equal(
    onMerge(recent({ autoSettleEnabled: null }), [pr('merged', NOW - 60_000)]),
    'none',
    'auto-settle off for the chat holds it against a merge',
  )
  assert.equal(decide(ws({ autoSettleEnabled: null })), 'none', 'and against three quiet days')

  // The two transitions as field patches. A rest decision carries the input
  // clock so main is never behind the decision; a wake clears the stamp and
  // sets (or spends) the hand decision. A snooze that has run out (a Woke
  // mark) is tombstoned by a settle; one still ahead is kept underneath it.
  assert.deepEqual(settleWorkspacePatch(ws({ lastTerminalActivityAt: NOW - 5 * DAY }), NOW, 'settled'), {
    snoozedUntil: null,
    settledAt: NOW,
    settledOverride: 'settled',
    lastTerminalActivityAt: NOW - 5 * DAY,
  })
  assert.deepEqual(
    settleWorkspacePatch(ws({}), NOW, null),
    { snoozedUntil: null, settledAt: NOW, settledOverride: null },
    'no input clock, no clock in the patch (absent is "no opinion")',
  )
  assert.deepEqual(wakeWorkspacePatch('active', ws({ settledAt: NOW }), NOW), {
    settledAt: null,
    settledOverride: 'active',
  })
  assert.deepEqual(wakeWorkspacePatch(null, ws({ settledAt: NOW }), NOW), { settledAt: null, settledOverride: null })

  console.log('workspaceSettle tests passed')
})

// A snooze puts a chat aside on purpose, so the quiet it spent asleep is not
// idleness: the idle clock starts again from the wake.
const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

function snoozable(fields: Partial<Workspace>): Workspace {
  return {
    id: 'w',
    name: 'w',
    mode: 'standard',
    createdAt: NOW - 30 * DAY,
    lastTerminalActivityAt: null,
    autoSettleEnabled: true,
    ...fields,
  } as unknown as Workspace
}

test('a chat snoozed for a week is not settled on the tick it wakes', () => {
  const lastActive = NOW - 7 * DAY
  const chat = snoozable({ lastTerminalActivityAt: lastActive, snoozedUntil: NOW })
  assert.equal(shouldAutoSettleWorkspace(chat, NOW - 1), false, 'asleep')
  assert.equal(shouldAutoSettleWorkspace(chat, NOW), false, 'the moment it wakes')
  assert.equal(shouldAutoSettleWorkspace(chat, NOW + 30_000), false, 'the next sweep tick')
  assert.equal(
    decideWorkspaceSettlement({ workspace: chat, now: NOW + 30_000, active: false, busy: false, held: false }),
    'none',
  )
})

test('a woken chat settles once the idle window has passed since it woke', () => {
  const chat = snoozable({ lastTerminalActivityAt: NOW - 7 * DAY, snoozedUntil: NOW })
  assert.equal(shouldAutoSettleWorkspace(chat, NOW + WORKSPACE_AUTO_SETTLE_AFTER_MS - 1), false)
  assert.equal(shouldAutoSettleWorkspace(chat, NOW + WORKSPACE_AUTO_SETTLE_AFTER_MS), true)
})

test('activity after the wake still moves the idle clock on', () => {
  const chat = snoozable({ snoozedUntil: NOW, lastUserMessageAt: NOW + DAY })
  assert.equal(shouldAutoSettleWorkspace(chat, NOW + WORKSPACE_AUTO_SETTLE_AFTER_MS), false)
  assert.equal(shouldAutoSettleWorkspace(chat, NOW + DAY + WORKSPACE_AUTO_SETTLE_AFTER_MS), true)
})

test('a chat that was never snoozed settles on its last activity, as before', () => {
  const quiet = snoozable({ lastTerminalActivityAt: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS })
  assert.equal(shouldAutoSettleWorkspace(quiet, NOW), true)
  assert.equal(shouldAutoSettleWorkspace(snoozable({ lastTerminalActivityAt: NOW - DAY }), NOW), false)
  assert.equal(
    shouldAutoSettleWorkspace(
      snoozable({ lastTerminalActivityAt: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS, snoozedUntil: null }),
      NOW,
    ),
    true,
    'a snooze already cleared leaves nothing to count from',
  )
})

const pullRequest = (state: 'open' | 'merged' | 'closed', fields: { isDraft?: boolean; endedAt?: number } = {}) =>
  ({
    url: `https://github.com/acme/app/pull/${state}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number: 1,
    title: '',
    state,
    isDraft: fields.isDraft ?? false,
    openedAt: NOW - 20 * DAY,
    stateAt: NOW - 10 * DAY,
    ...(fields.endedAt !== undefined ? { endedAt: fields.endedAt } : {}),
  }) as const

// Ten quiet days: past the idle threshold whatever else is true.
const idle = () => snoozable({ lastTerminalActivityAt: NOW - 10 * DAY })

test('with the keep on, a quiet chat whose pull request is open stays', () => {
  for (const open of [pullRequest('open'), pullRequest('open', { isDraft: true })])
    assert.equal(shouldAutoSettleWorkspace(idle(), NOW, { pullRequests: [open], keepWithOpenPullRequest: true }), false)
})

test('with the keep on, a quiet chat whose pull requests all ended still settles on the idle rule', () => {
  assert.equal(
    shouldAutoSettleWorkspace(idle(), NOW, {
      pullRequests: [pullRequest('closed', { endedAt: NOW - 9 * DAY })],
      keepWithOpenPullRequest: true,
    }),
    true,
  )
  assert.equal(shouldAutoSettleWorkspace(idle(), NOW, { pullRequests: [], keepWithOpenPullRequest: true }), true)
})

test('with the keep off, an open pull request does not hold a quiet chat', () => {
  assert.equal(
    shouldAutoSettleWorkspace(idle(), NOW, { pullRequests: [pullRequest('open')], keepWithOpenPullRequest: false }),
    true,
  )
})

test('with the keep on, the idle rule waits for the pull requests to be read', () => {
  assert.equal(
    shouldAutoSettleWorkspace(idle(), NOW, { pullRequestsUnread: true, keepWithOpenPullRequest: true }),
    false,
  )
  assert.equal(shouldAutoSettleWorkspace(idle(), NOW, { pullRequestsUnread: true }), true, 'keep off: as before')
})

test('settling on merge is unchanged by the keep', () => {
  const recent = snoozable({ createdAt: NOW - 2 * DAY, lastUserMessageAt: NOW - DAY })
  assert.equal(
    shouldAutoSettleWorkspace(recent, NOW, {
      pullRequests: [pullRequest('merged', { endedAt: NOW - 60_000 })],
      settleOnMerge: true,
      keepWithOpenPullRequest: true,
    }),
    true,
  )
})

// A Settle made by mistake on a sleeping chat used to clear its snooze, and
// Un-settle could not give it back. The snooze is kept under the rest instead,
// is not read as asleep while the row rests, and comes back with Un-settle.
test('a snooze still ahead survives a Settle and comes back with Un-settle', () => {
  const HOUR = 60 * 60 * 1000
  const sleeping = snoozable({ snoozedUntil: NOW + 3 * HOUR })
  const settle = settleWorkspacePatch(sleeping, NOW, 'settled')
  assert.equal('snoozedUntil' in settle, false, 'the Settle leaves a snooze still ahead where it is')
  const resting = { ...sleeping, ...settle } as Workspace
  assert.equal(isSnoozedWorkspace(resting, NOW + HOUR), false, 'rest outranks sleep: a resting row is not asleep')

  const unsettle = wakeWorkspacePatch('active', resting, NOW + HOUR)
  assert.deepEqual(unsettle, { settledAt: null, settledOverride: 'active' }, 'Un-settle hands the snooze back')
  const back = { ...resting, ...unsettle } as Workspace
  assert.equal(isSnoozedWorkspace(back, NOW + HOUR), true, 'and the chat sleeps on until its wake time')

  // Woken while it rested: nobody saw the wake, so it comes back with no Woke mark.
  assert.deepEqual(wakeWorkspacePatch('active', resting, NOW + 4 * HOUR), {
    settledAt: null,
    settledOverride: 'active',
    snoozedUntil: null,
  })
  // New activity is the chat coming back now: the kept snooze ends with the rest.
  assert.deepEqual(wakeWorkspacePatch(null, resting, NOW + HOUR), {
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
  })
  // A row that is not resting keeps its own snooze through a spent hand decision.
  assert.deepEqual(wakeWorkspacePatch(null, sleeping, NOW + HOUR), { settledAt: null, settledOverride: null })
  // A Woke mark (a snooze already run out) is tombstoned by the Settle, as before.
  const woke = settleWorkspacePatch(snoozable({ snoozedUntil: NOW - HOUR }), NOW, 'settled')
  assert.equal(woke.snoozedUntil, null)
})
