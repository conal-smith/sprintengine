import type { Workspace } from '../renderer/src/types/workspace'
import type { BranchPullRequest } from './git/pull-request'
import type { LifecycleState } from './lifecycle-state'
import { isSettledWorkspace, isStarred, workspaceLastActiveAt, workspaceLastUserMessageAt } from './workspace-lifecycle'
import { isSnoozeUnexpired, workspaceWokeAt } from './workspace-snooze'

// A chat settles — moves from its folder's active list into the folder's
// Settled shelf — once it has gone this long without activity: three days by
// default, long enough that a chat someone means to come back to tomorrow is
// never swept out from under them, and anything from a day to ninety in
// Settings ▸ Settled chats (`autoSettleAfterDays`). Settling keeps the
// workspace on disk and in the store, and opening it brings it back — but it
// is no longer free of consequence: a resting chat holds no terminals (owner
// ruling 2026-09-07), so the ptys are killed with the row and the agent
// resumes from its CLI session when the chat is next opened. This module
// still only DECIDES. The rules began in the renderer's sweep; they live here
// since main decides a chat's rest (`main/automation/workspace-settlement-sweep.ts`),
// with or without a window open, and a window's Settle is checked against the
// same record rules there.
const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3
export const MIN_AUTO_SETTLE_AFTER_DAYS = 1
export const MAX_AUTO_SETTLE_AFTER_DAYS = 90
export const WORKSPACE_AUTO_SETTLE_AFTER_MS = DEFAULT_AUTO_SETTLE_AFTER_DAYS * DAY_MS

/** A stored idle delay as whole days in range; the default for anything else. */
export function normalizeAutoSettleAfterDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AUTO_SETTLE_AFTER_DAYS
  return Math.min(MAX_AUTO_SETTLE_AFTER_DAYS, Math.max(MIN_AUTO_SETTLE_AFTER_DAYS, Math.round(value)))
}

/**
 * The Settings ▸ Settled chats choices the rest rule reads: whether a merge
 * settles a chat, whether an open pull request keeps one from the idle rule,
 * and how many quiet days settle one. A window owns them and pushes them to
 * main, which keeps a copy so its sweep has them with no window open; both
 * read a stored value through here.
 */
export type SettledChatsSettings = {
  settleOnPullRequestMerge: boolean
  keepChatsWithOpenPullRequest: boolean
  autoSettleAfterDays: number
}

export function normalizeSettledChatsSettings(
  settings: Partial<SettledChatsSettings> | undefined,
): SettledChatsSettings {
  return {
    settleOnPullRequestMerge:
      typeof settings?.settleOnPullRequestMerge === 'boolean' ? settings.settleOnPullRequestMerge : true,
    // Only an explicit stored `false` lets the idle rule settle a chat whose
    // pull request is still open: a profile from before the setting keeps them.
    keepChatsWithOpenPullRequest: settings?.keepChatsWithOpenPullRequest !== false,
    // Absent before the setting existed: the three days it always was.
    autoSettleAfterDays: normalizeAutoSettleAfterDays(settings?.autoSettleAfterDays),
  }
}

// Module-owned run states that must never settle on their own, no matter how
// old: anything still in flight or waiting on the person. Carried over from the
// archive sweep this rule replaces.
const PINNED_RUN_STATES: ReadonlySet<LifecycleState> = new Set(['in_progress', 'needs_input', 'paused', 'failed'])

/**
 * What the rest rule reads besides the record and the clock: the chat's pull
 * requests (the Studio server's list for the workspace), whether a merge
 * settles a chat at all, and whether an open pull request keeps it from the
 * idle rule (both Settings ▸ Settled chats). `pullRequestsUnread` is the list
 * not having been read yet, as on the first tick after a launch: with the
 * keep on, "no pull requests" is then not known, so the idle rule waits.
 */
export type AutoSettleContext = {
  /**
   * The run state the chat's module reports for it, when its type has a
   * provider (`deriveRunGlyph`): one still in flight or waiting on the person
   * pins the row. Asked of the module by the caller, which knows whether it
   * can ask at all.
   */
  runState?: LifecycleState | null
  pullRequests?: readonly BranchPullRequest[]
  pullRequestsUnread?: boolean
  settleOnMerge?: boolean
  keepWithOpenPullRequest?: boolean
  /** How many quiet days settle a chat (Settings ▸ Settled chats); three when absent. */
  afterDays?: number
}

/**
 * The pure idle rule: true when a row that is not otherwise exempt has been
 * quiet for the threshold. The live blockers — the active row of any window,
 * a working or blocked agent, the unseen finished mark — live with the
 * caller, which knows them; this reads only the record and the clock.
 *
 * Only a row the person switched Auto-settle on for from its menu
 * (`autoSettleEnabled`) is a candidate at all; off is the default.
 *
 * Exempt for good, whatever the clock says: a row already resting, a row with
 * a hand decision on it (`settledOverride`), a starred row (the star is the
 * person saying "keep this in front of me"), a row born on a paired machine
 * (the Remote band has its own model), the rail-hidden hosts, and a row whose
 * module reports a run still in flight.
 *
 * Two ways in: its quiet days, three unless the person chose others (counted from the wake, for a row that has
 * just come back from a snooze), unless one of its pull requests is still open
 * and Keep chats with an open pull request is on; or its pull requests landing
 * (`pullRequestsLanded`) when Settle on merge is on.
 */
export function shouldAutoSettleWorkspace(workspace: Workspace, now: number, context: AutoSettleContext = {}): boolean {
  if (isSettledWorkspace(workspace)) return false
  if (workspace.settledOverride != null) return false
  if (workspace.autoSettleEnabled !== true) return false
  // A running snooze is a hand decision about this row's near future, and the
  // sweep never overrules one of those. Settling a row mid-snooze would strand
  // the person's "ask me again in an hour" behind an Un-settle they never asked
  // for. The plain timer test is enough: a row whose hand is up is `held` on
  // the caller's terms and is not a settle candidate anyway.
  if (isSnoozeUnexpired(workspace, now)) return false
  if (isStarred(workspace.highlight)) return false
  if (workspace.remoteOrigin) return false
  if (context.runState && PINNED_RUN_STATES.has(context.runState)) return false
  // Quiet since its last activity, or since it woke if that is later. A snooze
  // is the person putting the chat aside, not the chat going idle: one snoozed
  // for a week would otherwise wake already a week quiet and settle — its
  // terminals killed — on the very tick it came back to the list.
  const quietSince = Math.max(workspaceLastActiveAt(workspace), workspaceWokeAt(workspace, now) ?? 0)
  const afterMs = normalizeAutoSettleAfterDays(context.afterDays ?? DEFAULT_AUTO_SETTLE_AFTER_DAYS) * DAY_MS
  if (now - quietSince >= afterMs && !keptForOpenPullRequest(context)) return true
  return context.settleOnMerge === true && pullRequestsLanded(workspace, context.pullRequests ?? [])
}

/**
 * Whether the idle rule leaves a chat alone for its pull requests: one is
 * still open (a draft, or one awaiting review), or the list has not been read
 * yet and so might hold one. Only while the person has the keep on.
 */
function keptForOpenPullRequest(context: AutoSettleContext): boolean {
  if (context.keepWithOpenPullRequest !== true) return false
  if (context.pullRequestsUnread === true) return true
  return (context.pullRequests ?? []).some((pr) => pr.state === 'open')
}

/**
 * Whether a chat's work has landed: it has pull requests, none is still open,
 * at least one merged, and the person has not written to the chat since the
 * last of them ended. A chat whose pull requests all closed unmerged did not
 * land; the idle rule settles it in time. A message after the merge is the
 * person carrying on — a follow-up, a question about what landed — and the
 * chat stays.
 *
 * "Written to" is the person's last input of any kind: a message, or a
 * keystroke into one of the chat's terminals (a dev server started in its
 * shell after the merge is carrying on too, and settling would kill it).
 *
 * An entry with no end time (one read before the record kept it) cannot say
 * whether the person wrote after it, so it holds the chat for the idle rule.
 */
export function pullRequestsLanded(workspace: Workspace, pullRequests: readonly BranchPullRequest[]): boolean {
  if (pullRequests.length === 0) return false
  let lastEnded = 0
  for (const pr of pullRequests) {
    if (pr.state === 'open' || typeof pr.endedAt !== 'number') return false
    lastEnded = Math.max(lastEnded, pr.endedAt)
  }
  if (!pullRequests.some((pr) => pr.state === 'merged')) return false
  return lastEnded >= Math.max(workspaceLastUserMessageAt(workspace), workspace.lastTerminalActivityAt ?? 0)
}

/**
 * What the sweep should do to one row, given what only the caller knows.
 * Returned as a decision rather than applied, so the store action and its
 * test read the same three words.
 *
 *  - `busy`: the agent is working — activity. It wakes a resting row (a hand
 *    Settle included: new activity resumes the usual rules, the same way a
 *    keystroke does) and blocks settling an active one.
 *  - `held`: the row wants the person — blocked on a prompt, or wearing the
 *    unseen "finished while you were away" mark. A thing to look at, not
 *    activity: it blocks settling, and it wakes a row the SWEEP settled (a
 *    row that wants the person does not belong in the shelf unless the
 *    person put it there — the sweep can only have settled it on a reading
 *    taken before the sessions were known). It never wakes a hand Settle: a
 *    prompt is a persistent state that was already true when Settle was
 *    chosen, so treating it as a wake would undo every Settle within a tick
 *    until the prompt is answered.
 *  - `active`: the row someone is looking at in some window. Being looked at
 *    is not activity either: selecting a settled row to read it keeps it
 *    settled, and an active row that has gone quiet is simply never settled
 *    out from under the person.
 */
export type SettlementDecision = 'wake' | 'settle' | 'none'

export function decideWorkspaceSettlement(input: {
  workspace: Workspace
  now: number
  active: boolean
  busy: boolean
  held: boolean
  context?: AutoSettleContext
}): SettlementDecision {
  const { workspace, now, active, busy, held } = input
  if (isSettledWorkspace(workspace)) {
    if (busy) return 'wake'
    return held && workspace.settledOverride == null ? 'wake' : 'none'
  }
  if (active || busy || held) return 'none'
  return shouldAutoSettleWorkspace(workspace, now, input.context) ? 'settle' : 'none'
}
