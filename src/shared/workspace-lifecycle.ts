import type { HighlightColor, Workspace, WorkspaceHighlight } from '../renderer/src/types/workspace'
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

/**
 * What a rest decision was taken on: the chat's rest and sleep as they stood,
 * and its activity clock (`workspaceLastActiveAt`). Every Settle, Snooze and
 * automatic settle or wake carries one to main, which refuses the decision if
 * the chat has moved on since (`lifecycleSnapshotIsStale`): someone else
 * settled, woke or snoozed it, or there was activity the decision did not see.
 * A decision taken on a reading of a chat is about that reading, and a chat
 * that changed underneath it is a different question.
 */
export type WorkspaceLifecycleSnapshot = {
  settledAt: number | null
  settledOverride: 'settled' | 'active' | null
  snoozedUntil: number | null
  activityAt: number
}

type LifecycleRecord = Pick<
  Workspace,
  | 'settledAt'
  | 'settledOverride'
  | 'snoozedUntil'
  | 'createdAt'
  | 'lastTerminalActivityAt'
  | 'lastUserMessageAt'
  | 'lastTurnEndedAt'
>

const stamp = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const override = (value: unknown): WorkspaceLifecycleSnapshot['settledOverride'] =>
  value === 'settled' || value === 'active' ? value : null

export function workspaceLifecycleSnapshot(workspace: LifecycleRecord): WorkspaceLifecycleSnapshot {
  return {
    settledAt: stamp(workspace.settledAt),
    settledOverride: override(workspace.settledOverride),
    snoozedUntil: stamp(workspace.snoozedUntil),
    activityAt: workspaceLastActiveAt(workspace),
  }
}

/**
 * Whether the chat has changed since `snapshot` was taken of it. Its rest and
 * sleep must read exactly as they did; its activity may not have moved past
 * the snapshot's. A snapshot AHEAD of the record is not stale: a window learns
 * the person's keystrokes before main does (it reports that clock on a coarse
 * cadence), and a decision taken on more than main knows is still current.
 */
export function lifecycleSnapshotIsStale(workspace: LifecycleRecord, snapshot: WorkspaceLifecycleSnapshot): boolean {
  const current = workspaceLifecycleSnapshot(workspace)
  return (
    current.settledAt !== snapshot.settledAt ||
    current.settledOverride !== snapshot.settledOverride ||
    current.snoozedUntil !== snapshot.snoozedUntil ||
    current.activityAt > snapshot.activityAt
  )
}

/** A snapshot from across a process boundary, or null when it is not one. */
export function parseWorkspaceLifecycleSnapshot(value: unknown): WorkspaceLifecycleSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const nullableStamp = (field: unknown) => field === null || stamp(field) !== null
  if (!nullableStamp(raw.settledAt) || !nullableStamp(raw.snoozedUntil) || stamp(raw.activityAt) === null) return null
  if (raw.settledOverride !== null && override(raw.settledOverride) === null) return null
  return {
    settledAt: stamp(raw.settledAt),
    settledOverride: override(raw.settledOverride),
    snoozedUntil: stamp(raw.snoozedUntil),
    activityAt: raw.activityAt as number,
  }
}

/**
 * A window's row-menu gesture on a chat's rest, sent to main with the
 * reading of the chat it was made on (`snapshot`). Settle carries the
 * person's keystroke clock as the window knows it, which main's copy lags.
 */
export type WorkspaceLifecycleIntent =
  { kind: 'settle'; lastInputAt?: number } | { kind: 'unsettle' } | { kind: 'snooze'; until: number } | { kind: 'wake' }

export type WorkspaceLifecycleRequest = {
  workspaceId: string
  intent: WorkspaceLifecycleIntent
  snapshot: WorkspaceLifecycleSnapshot
}

/** Main's answer. A refusal carries the chat's rest as main has it, for the window to put its row back to. */
export type WorkspaceLifecycleResult =
  { ok: true; workspaceId: string } | { ok: false; code: string; message: string; current?: WorkspaceLifecycleSnapshot }

/** A request from across the process boundary, or null when it is not one. */
export function parseWorkspaceLifecycleRequest(value: unknown): WorkspaceLifecycleRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId.trim() : ''
  const snapshot = parseWorkspaceLifecycleSnapshot(raw.snapshot)
  const intent = parseIntent(raw.intent)
  return workspaceId && snapshot && intent ? { workspaceId, intent, snapshot } : null
}

function parseIntent(value: unknown): WorkspaceLifecycleIntent | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'settle':
      return stamp(raw.lastInputAt) === null
        ? { kind: 'settle' }
        : { kind: 'settle', lastInputAt: raw.lastInputAt as number }
    case 'unsettle':
    case 'wake':
      return { kind: raw.kind }
    case 'snooze':
      return stamp(raw.until) === null ? null : { kind: 'snooze', until: raw.until as number }
    default:
      return null
  }
}

/**
 * What a Settle put away beside the chat, taken as the rest lands so that
 * Un-settle can hand it back: a snooze still ahead (one already run out is the
 * Woke mark, which resting leaves behind). A Settle touches no star, so there
 * is no star to keep. Belongs to the one rest it was taken for (`settledAt`).
 */
export type SettleUndo = { settledAt: number; snoozedUntil: number | null }

export function planSettleUndo(workspace: Pick<Workspace, 'snoozedUntil'>, settledAt: number): SettleUndo {
  return { settledAt, snoozedUntil: snoozeStillAhead(workspace, settledAt) ? workspace.snoozedUntil! : null }
}

/**
 * Un-settle with the undo of the Settle that put the chat to rest: the
 * person's Un-settle (`wakeWorkspacePatch('active')`), with the snooze the
 * Settle displaced put back while it is still ahead, whether or not the
 * record still carries it underneath the rest. An undo taken for another rest
 * than the one on the record is no undo for this one.
 */
export function undoSettlePatch(
  undo: SettleUndo,
  workspace: Pick<Workspace, 'settledAt' | 'snoozedUntil'>,
  now: number,
): WorkspaceFieldsPatch {
  const patch = wakeWorkspacePatch('active', workspace, now)
  if (workspace.settledAt !== undo.settledAt) return patch
  return snoozeStillAhead(undo, now) ? { ...patch, snoozedUntil: undo.snoozedUntil } : patch
}

function snoozeStillAhead(workspace: Pick<Workspace, 'snoozedUntil'>, now: number): boolean {
  return (
    typeof workspace.snoozedUntil === 'number' &&
    Number.isFinite(workspace.snoozedUntil) &&
    workspace.snoozedUntil > now
  )
}

/** Whether the person starred the chat: "keep this in front of me". */
export function isStarred(highlight: WorkspaceHighlight | undefined | null): boolean {
  return highlight?.starred === true
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
 * When the chat was last active, by anyone: the latest of the person's last
 * real work (creation or a keystroke, `workspaceLastWorkedAt`), the person's
 * last message, and the agent's last turn end. This is the rest rule's clock
 * (`workspace-settlement.ts`) — "has this chat gone quiet", where an agent that
 * spoke an hour ago plainly means it has not. Deliberately not an ordering
 * key: what keeps a chat out of the Settled shelf is a different question from
 * where it sits in the list.
 *
 * The message clock has to be in here even though a message into a terminal
 * always moves the keystroke clock with it: a conversation-runtime chat has no
 * pty and no turn-end hook, so its message clock is the ONLY thing that ever
 * moves. Without it, a chat the person writes in every day is three days idle
 * by this reading from the moment it is created, and the sweep shelves it out
 * from under them.
 */
export function workspaceLastActiveAt(
  workspace: Pick<Workspace, 'createdAt' | 'lastTerminalActivityAt' | 'lastUserMessageAt' | 'lastTurnEndedAt'>,
): number {
  return Math.max(workspaceLastWorkedAt(workspace), workspace.lastUserMessageAt ?? 0, workspace.lastTurnEndedAt ?? 0)
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
