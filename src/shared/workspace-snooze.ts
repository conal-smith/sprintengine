import type { Workspace } from '../renderer/src/types/workspace'
import type { WorkspaceFieldsPatch } from './workspace-sync'

// When a chat is asleep, as pure functions of the registry record and a clock.
// They began in the renderer (`utils/workspaceSnooze.ts`, which keeps the wake
// presets and labels and says what a snooze is); they live here since main
// decides a chat's rest (`workspace-settlement.ts`), and the rest rule reads
// the snooze: a chat asleep is never settled, and one that has woken counts
// its quiet days from the wake. Both processes read the same clock rule, so a
// window and main cannot disagree about whether a row is asleep.

/** Does this row carry a snooze at all — awake or not? The field test, nothing more. */
export function hasSnooze(workspace: Pick<Workspace, 'snoozedUntil'>): boolean {
  return typeof workspace.snoozedUntil === 'number' && Number.isFinite(workspace.snoozedUntil)
}

/**
 * Is the wake time still ahead? This is the WHOLE test — a snoozed row is one
 * whose stamp is in the future, and nothing brings it back early.
 *
 * There was an "early wake" rule here, carried over with the rest of the
 * borrowed model: a snoozed thread came back before its time if the agent got
 * blocked on the person, or if a turn ended after the snooze was set. Both
 * are gone (owner, 2026-09-10), and the reasons are worth keeping:
 *
 *  - Blocked-on-you was the reason a chat asking a question could not be snoozed
 *    at all, since snoozing one would have un-snoozed it on the next tick. "You
 *    should be able to snooze whatever you want" — and under suspend the
 *    question is not lost, it simply waits in the CLI session and is re-asked
 *    when the person resumes the terminal themselves.
 *  - Turn-ended could no longer fire honestly once snoozing suspended the
 *    terminals: a sleeping chat has no process to finish a turn. What it could
 *    still do was fire by ACCIDENT — snooze a working chat and a Stop hook
 *    landing in the moment before the suspend does would un-snooze the row the
 *    person had just put away.
 *
 * So the rule is the clock and only the clock, which is also the thing a person
 * can predict without being told any of the above.
 */
export function isSnoozeUnexpired(workspace: Pick<Workspace, 'snoozedUntil'>, now: number): boolean {
  return hasSnooze(workspace) && (workspace.snoozedUntil as number) > now
}

/**
 * The one answer to "is this row asleep right now?". Rest outranks sleep: a
 * settled row keeps a snooze still ahead underneath its rest, to hand back if
 * the Settle is undone (`settleWorkspacePatch`), and is not asleep meanwhile.
 */
export function isSnoozedWorkspace(workspace: Pick<Workspace, 'snoozedUntil' | 'settledAt'>, now: number): boolean {
  return typeof workspace.settledAt !== 'number' && isSnoozeUnexpired(workspace, now)
}

/**
 * May this row be snoozed at all?
 *
 * A chat blocked on a question may be (the question waits and is re-asked on
 * resume). A chat with an agent still working may not, but that is the
 * caller's to know (`workspaceIsWorking`), not the record's: suspending ends
 * the agent processes, and an agent working in the background does not come
 * back on the wake.
 *
 * The two that may not are the two with nowhere to sleep. A settled row is
 * already out of the list, so a snooze underneath it would do nothing visible
 * and then expire into a Woke mark on a row nobody woke. A row born on a paired
 * machine lives in the Remote band, which has no shelves — the same rule Settle
 * follows for the same reason.
 */
export function canSnoozeWorkspace(workspace: Pick<Workspace, 'settledAt' | 'remoteOrigin'>): boolean {
  if (typeof workspace.settledAt === 'number') return false
  if (workspace.remoteOrigin) return false
  return true
}

/**
 * When a snooze ENDED, or null while it is still running (or never ran).
 *
 * This is the Woke mark: the sidebar's order is deliberately static, so a row
 * that comes back does not move to announce itself and needs to say so on its
 * own face. Cleared by opening the row — the mark exists to get you there.
 *
 * The wake time itself is the answer, because it is the only way a row wakes.
 */
export function workspaceWokeAt(workspace: Pick<Workspace, 'snoozedUntil'>, now: number): number | null {
  if (!hasSnooze(workspace)) return null
  const wakeAt = workspace.snoozedUntil as number
  return wakeAt <= now ? wakeAt : null
}

/**
 * The two transitions as registry field patches, so the row menu, the wake
 * button and Settle all write the same field the same way — the reason
 * `workspaceSettle.ts` hands out patches rather than letting each caller
 * assemble one.
 *
 * One field, since the early-wake rule went: the wake time is the whole of a
 * snooze. It went with a companion `snoozedAt`, which existed only as the line
 * a turn end had to beat to count as news.
 */
export function snoozeWorkspacePatch(wakeAt: number): WorkspaceFieldsPatch {
  return { snoozedUntil: wakeAt }
}

// Waking is shared with Settle, which clears a snooze in the same patch.
export { wakeSnoozedWorkspacePatch } from './workspace-lifecycle'
