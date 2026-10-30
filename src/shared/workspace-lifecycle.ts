import type { HighlightColor, Workspace } from '../renderer/src/types/workspace'
import type { WorkspaceFieldsPatch } from './workspace-sync'

// A chat's rest and its ordering key, as pure functions of the registry
// record. They began in the renderer, which was the only writer of rest; they
// live here since a paired phone or desktop can settle a chat too
// (`conversation.settle`), and main has to write the same fields the same way
// the row menu does and list the chats in the order the sidebar draws them.
// The renderer modules that grew them re-export them, with the reasoning.

/** The one answer to "is this row resting?". */
export function isSettledWorkspace(workspace: Pick<Workspace, 'settledAt'>): boolean {
  return typeof workspace.settledAt === 'number'
}

/** Ends a snooze: the row is back in the active list now. */
export function wakeSnoozedWorkspacePatch(): WorkspaceFieldsPatch {
  return { snoozedUntil: null }
}

/**
 * The two transitions as registry field patches, so every writer — the
 * sweep, the row menu, the keystroke path, a paired device — changes the
 * same fields the same way and the store's copies cannot drift.
 *
 * A patch that puts a row to rest also carries the person's last-input clock
 * as the store knows it. Main's copy of that clock is otherwise refreshed on a
 * coarse cadence, and a restart rebuilds the row from main's record: a
 * keystroke that never reached main would then read as NEWER than the rest
 * decision and wake the row the moment its session was listed. Sending the
 * clock with the decision makes main at least as current as the decision.
 */
export function settleWorkspacePatch(
  workspace: Pick<Workspace, 'lastTerminalActivityAt' | 'snoozedUntil'>,
  now: number,
  override: 'settled' | null,
): WorkspaceFieldsPatch {
  return {
    // Rest supersedes sleep (snooze, 2026-09-10): a settled row is out of the
    // list for good reasons of its own, and is never read as asleep
    // (`isSnoozedWorkspace`). A snooze still ahead is KEPT underneath it,
    // though, so a Settle made by mistake on a sleeping chat gives the snooze
    // back when it is undone (`wakeWorkspacePatch`); clearing it here lost it
    // for good. One already run out is the Woke mark, which the chat has
    // left behind by resting, and goes here, so no un-settle can bring it back.
    ...(snoozeStillAhead(workspace, now) ? {} : wakeSnoozedWorkspacePatch()),
    settledAt: now,
    settledOverride: override,
    ...(typeof workspace.lastTerminalActivityAt === 'number'
      ? { lastTerminalActivityAt: workspace.lastTerminalActivityAt }
      : {}),
  }
}

/**
 * Brings a resting row back. `'active'` is the person's Un-settle, which
 * hands back a snooze the Settle kept and that is still ahead: the chat goes
 * back to sleeping where it was. `null` is new activity (a keystroke, a
 * message, an agent working), which is the chat coming back NOW, so a kept
 * snooze ends with the rest. A snooze that ran out while the row rested is
 * cleared either way: nobody saw it wake, so it must not come back wearing a
 * Woke mark.
 */
export function wakeWorkspacePatch(
  override: 'active' | null,
  workspace: Pick<Workspace, 'settledAt' | 'snoozedUntil'>,
  now: number,
): WorkspaceFieldsPatch {
  // Only a snooze a Settle kept is this patch's to touch. A row that is not
  // resting (one whose hand decision a keystroke spends) keeps its own.
  const keptBySettle = isSettledWorkspace(workspace) && typeof workspace.snoozedUntil === 'number'
  const keepsSnooze = override === 'active' && snoozeStillAhead(workspace, now)
  return {
    settledAt: null,
    settledOverride: override,
    ...(keptBySettle && !keepsSnooze ? wakeSnoozedWorkspacePatch() : {}),
  }
}

function snoozeStillAhead(workspace: Pick<Workspace, 'snoozedUntil'>, now: number): boolean {
  return (
    typeof workspace.snoozedUntil === 'number' &&
    Number.isFinite(workspace.snoozedUntil) &&
    workspace.snoozedUntil > now
  )
}

/**
 * The row menu's star and colour as a patch: `change` says what moved (a
 * member left out keeps what the record has), and a chat left with neither
 * has its highlight cleared rather than kept as an empty one.
 */
export function highlightWorkspacePatch(
  workspace: Pick<Workspace, 'highlight'>,
  change: { starred?: boolean; color?: HighlightColor | null },
): WorkspaceFieldsPatch {
  const starred = change.starred ?? workspace.highlight?.starred === true
  const color = change.color === undefined ? (workspace.highlight?.color ?? null) : change.color
  return { highlight: starred || color ? { starred, color } : null }
}

/** The latest of when the chat was created and the person's last keystroke into it. */
export function workspaceLastWorkedAt(workspace: Pick<Workspace, 'createdAt' | 'lastTerminalActivityAt'>): number {
  return Math.max(workspace.createdAt, workspace.lastTerminalActivityAt ?? 0)
}

/**
 * THE ordering key for every list of chats: when the person last sent a
 * message into this one, else `workspaceLastWorkedAt` for a row that has
 * never had one. `utils/workspaceRecency.ts` in the renderer says why.
 */
export function workspaceLastUserMessageAt(
  workspace: Pick<Workspace, 'createdAt' | 'lastTerminalActivityAt' | 'lastUserMessageAt'>,
): number {
  return workspace.lastUserMessageAt ?? workspaceLastWorkedAt(workspace)
}

/**
 * THE "finished while you were away" rule (the green row): an agent in the
 * chat finished a turn after anyone last had it on screen, on any device, and
 * nothing in it is working or waiting on the person now. Read off the visit
 * clock (`lastVisitedAt`), which is durable and shared by every device, so a
 * reload, a window hidden overnight or a second machine following the chat
 * all mark the same chats. A chat with no visit recorded reads as seen:
 * nothing recorded visits before the clock existed. Scheduled runs are made
 * with the clock at their creation, so a run nobody has opened reads unseen.
 * The exceptions a row adds (the chat on screen, a sleeping row, a watched
 * pull request) are its caller's.
 */
export function finishedUnseen(input: {
  idle: boolean
  finishedAt: number | null | undefined
  visitedAt: number | null | undefined
}): boolean {
  if (!input.idle || typeof input.finishedAt !== 'number' || typeof input.visitedAt !== 'number') return false
  return input.finishedAt > input.visitedAt
}
