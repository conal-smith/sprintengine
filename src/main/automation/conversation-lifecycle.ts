import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import type { WorkspaceFieldsPatch, WorkspaceSyncCommandResult, WorkspaceSyncEvent } from '../../shared/workspace-sync'
import {
  highlightWorkspacePatch,
  isSettledWorkspace,
  settleWorkspacePatch,
  wakeSnoozedWorkspacePatch,
  wakeWorkspacePatch,
} from '../../shared/workspace-lifecycle'
import type { HighlightColor } from '../../renderer/src/types/workspace'
import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { conversationSessionWorking, conversationTurnInProgress } from '../../shared/conversation/phase'
import { backgroundTasksWakeAgent } from '../../shared/conversation/backgroundTasks'

// A chat's rest and its two person-clocks, written for a paired device.
//
// The desktop is the one owner of whether a chat is resting, of when a person
// last wrote to it and of when one last looked at it: a phone or a second
// desktop asks, and the answer is written to the same registry record, with
// the same patches, that the desktop's own sidebar writes. Its windows learn
// the change from main's broadcast like any other, and the window showing a
// chat that was settled from elsewhere carries out the rest of a Settle there
// (WorkspaceSidebar's `settledElsewhere`).

export type ConversationLifecycleDeps = {
  getRecord(workspaceId: string): WorkspaceRegistryRecord | null
  updateWorkspaceFields(
    workspaceId: string,
    patch: WorkspaceFieldsPatch,
    actor: WorkspaceRegistryActor,
  ): WorkspaceSyncCommandResult
  /**
   * Mark unread's own write, the one that may move the visit clock back: the
   * service stamps `visitRewoundAt` beside it (`rewindVisit`), and refuses
   * that stamp in any other patch.
   */
  rewindVisit(workspaceId: string, lastVisitedAt: number, actor: WorkspaceRegistryActor): WorkspaceSyncCommandResult
  /**
   * Whether an agent in the workspace's chats is working. Settling ends the
   * chat's agent processes, and the work with them, so it waits, as the row
   * menu's Settle does.
   */
  isWorking(workspaceId: string): boolean
  /**
   * Whether the one piece of work in the workspace is `agentId`'s own chat
   * turn: its chat is mid-turn, nothing it launched works on in the
   * background, and no other chat or agent terminal of the workspace is at
   * work. What lets an agent settle its own chat once its turn is over.
   * Absent, an agent's request is refused while it works, as anyone's is.
   */
  onlyTurnOf?(workspaceId: string, agentId: string): boolean
  /**
   * Whether a message is waiting on the end of one of the workspace's chats'
   * turns to go in (one a paired machine queued, or a scheduled one that came
   * due mid-turn). A chat about to be written to is not put away.
   */
  messageWaiting?(workspaceId: string): boolean
  /**
   * The row menu's Rename, from a paired device: the chat's name, as a
   * person's rename in a window writes it (locked against the titler, and
   * stamped now). Absent, a rename is refused as a write this build cannot make.
   */
  renameWorkspace?(workspaceId: string, name: string, actor: WorkspaceRegistryActor): WorkspaceSyncCommandResult
  /** Run `job` after `ms`; returns the cancel. Injected so tests drive the clock. */
  schedule?: (job: () => void, ms: number) => () => void
  log?: (message: string) => void
  /**
   * When a chat in the workspace last finished a turn, by its transcripts'
   * index and the chats main holds now (`latestTurnEnd`, the reading the
   * conversation list takes, so a chat the list says has finished can be
   * marked); undefined when none has. The record's own `lastTurnEndedAt`
   * (its terminal agents') is read beside it.
   */
  latestChatTurnEnd?(workspaceId: string): number | undefined | Promise<number | undefined>
  now?: () => number
}

export type ConversationLifecycleFailure = {
  ok: false
  code: 'unknown_workspace' | 'working' | 'write_failed' | 'nothing_finished' | 'settled' | 'invalid_arguments'
  message: string
}

export type ConversationSettleResult =
  | { ok: true; workspaceId: string; settledAt: number | null }
  | { ok: true; workspaceId: string; settledAt: null; settlesWhenTurnEnds: true }
  | ConversationLifecycleFailure
export type ConversationVisitResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | ConversationLifecycleFailure
export type ConversationMarkUnreadResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | ConversationLifecycleFailure

export type ConversationSnoozeResult =
  { ok: true; workspaceId: string; snoozedUntil: number | null } | ConversationLifecycleFailure
export type ConversationHighlightResult =
  { ok: true; workspaceId: string; starred: boolean; color: HighlightColor | null } | ConversationLifecycleFailure
export type ConversationAutoSettleResult =
  { ok: true; workspaceId: string; autoSettle: boolean } | ConversationLifecycleFailure
export type ConversationRenameResult = { ok: true; workspaceId: string; name: string } | ConversationLifecycleFailure
export type ConversationAutoCompactResult =
  { ok: true; workspaceId: string; autoCompact: boolean } | ConversationLifecycleFailure

/** The longest name a chat takes from a paired device: the sidebar shows far less. */
export const MAX_CHAT_NAME_LENGTH = 500

export type ConversationLifecycle = ReturnType<typeof createConversationLifecycle>

/**
 * After the turn of an agent that asked to settle its own chat ends, how long
 * the settle waits. The runtime lets go of the turn just after it says the
 * turn ended, and a message the person queued in the chat's composer goes in
 * then: that message is heard as the chat's next `user_message` inside this
 * wait, and the settle stands down for it.
 */
export const OWN_SETTLE_GRACE_MS = 2_000

/**
 * Whether, of a workspace's chats, the one piece of work is `agentId`'s own
 * turn: its chat is mid-turn with no agent or monitor it launched still
 * working in the background (settling would end those), and no other chat is at work. Only
 * a chat counts as the asking agent's: a chat's turn end is what the settle
 * waits on, and a terminal agent's is not heard where the settle is kept.
 */
export function onlyOwnChatTurn(sessions: ReadonlyArray<ConversationSessionSummary>, agentId: string): boolean {
  const own = sessions.filter((session) => session.agentId === agentId && session.status !== 'stopped')
  if (
    own.length !== 1 ||
    !conversationTurnInProgress(own[0]) ||
    (own[0].backgroundAgents ?? 0) > 0 ||
    backgroundTasksWakeAgent(own[0].backgroundTasks)
  )
    return false
  return !sessions.some((session) => session !== own[0] && conversationSessionWorking(session))
}

/** A settle an agent asked for on its own chat, waiting for its turn to end. */
type PendingSettle = {
  agentId: string
  actor: WorkspaceRegistryActor
  /** The cancel of the grace's timer, once the turn has ended. */
  cancel: (() => void) | null
}

export function createConversationLifecycle(deps: ConversationLifecycleDeps) {
  const now = deps.now ?? Date.now
  const schedule =
    deps.schedule ??
    ((job: () => void, ms: number) => {
      const timer = setTimeout(job, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  // By workspace. In memory only: a restart ends the turn it waits on, and
  // the request with it, so the chat stays as it was and the agent, told the
  // settle waits on its turn, can ask again in its next one.
  const pending = new Map<string, PendingSettle>()
  const unknown = (workspaceId: string): ConversationLifecycleFailure => ({
    ok: false,
    code: 'unknown_workspace',
    message: `There is no chat "${workspaceId}" on this machine.`,
  })
  const write = (
    workspaceId: string,
    patch: WorkspaceFieldsPatch,
    actor: WorkspaceRegistryActor,
  ): ConversationLifecycleFailure | null => {
    const written = deps.updateWorkspaceFields(workspaceId, patch, actor)
    return written.ok ? null : { ok: false, code: 'write_failed', message: written.message }
  }

  /**
   * Settle a chat, or bring it back: the row menu's Settle and Un-settle,
   * patch for patch. Settling one already resting, or waking one that is
   * not, writes nothing and answers how it stands, so a retry is harmless.
   * `caller` is the agent of this app the request came from, when it came
   * from one: asking for its own chat, it may be answered "when this turn
   * ends" where anyone else is refused as working.
   */
  function settle(
    workspaceId: string,
    settled: boolean,
    actor: WorkspaceRegistryActor,
    caller?: { workspaceId: string; agentId: string } | null,
  ): ConversationSettleResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    // Bringing the chat back takes back a settle waiting on a turn; the same
    // agent asking again is told what it was told the first time.
    const waiting = pending.get(workspaceId)
    if (!settled) dropPending(workspaceId)
    else if (waiting && caller?.workspaceId === workspaceId && waiting.agentId === caller.agentId)
      return { ok: true, workspaceId, settledAt: null, settlesWhenTurnEnds: true }
    if (settled === isSettledWorkspace(record))
      return { ok: true, workspaceId, settledAt: isSettledWorkspace(record) ? record.settledAt! : null }
    // An agent asking from inside the chat is mid-turn by definition, so
    // "settle this chat" from it would always be refused as working. When its
    // own turn is the only work there, the settle waits for that turn to end.
    if (
      settled &&
      caller?.workspaceId === workspaceId &&
      deps.isWorking(workspaceId) &&
      deps.onlyTurnOf?.(workspaceId, caller.agentId)
    ) {
      pending.set(workspaceId, { agentId: caller.agentId, actor, cancel: null })
      return { ok: true, workspaceId, settledAt: null, settlesWhenTurnEnds: true }
    }
    if (settled && deps.isWorking(workspaceId))
      return {
        ok: false,
        code: 'working',
        message: 'An agent in this chat is still working, or waiting on an answer. Settle it once it has finished.',
      }
    const patch = settled ? settleWorkspacePatch(record, now(), 'settled') : wakeWorkspacePatch('active', record, now())
    const failed = write(workspaceId, patch, actor)
    if (failed) return failed
    if (settled) dropPending(workspaceId)
    return { ok: true, workspaceId, settledAt: typeof patch.settledAt === 'number' ? patch.settledAt : null }
  }

  /**
   * A person has the chat on screen. Only moves the visit clock forward, and
   * never to a time this machine has not reached yet, so a device whose clock
   * runs ahead cannot mark a later finish as seen. A visit stamped no later
   * than the chat's last Mark unread was taken before it, however late it
   * arrives, and does not undo it. It is not activity: the message clock and
   * the chat's rest are left as they are.
   */
  function visit(
    workspaceId: string,
    visitedAt: number | undefined,
    actor: WorkspaceRegistryActor,
  ): ConversationVisitResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const at = Math.min(visitedAt ?? now(), now())
    const stored = typeof record.lastVisitedAt === 'number' ? record.lastVisitedAt : null
    const seenBeforeRewind = typeof record.visitRewoundAt === 'number' && at <= record.visitRewoundAt
    if (stored !== null && (stored >= at || seenBeforeRewind)) return { ok: true, workspaceId, lastVisitedAt: stored }
    const failed = write(workspaceId, { lastVisitedAt: at }, actor)
    if (failed) return failed
    return { ok: true, workspaceId, lastVisitedAt: at }
  }

  /**
   * Mark unread, from any device: the visit clock goes back to just before
   * the chat's latest finish (that finish less a millisecond), so its
   * "finished, unseen" mark comes back everywhere and the next opening's
   * "New" divider sits above its latest reply. The one write that moves the
   * clock back, and it says so: it goes through its own command, which
   * stamps `visitRewoundAt` beside it (`rewindVisit`, `visitRewindApplies`).
   * A chat already unread from further back keeps its
   * clock, and one whose agent has finished nothing is refused.
   */
  async function markUnread(workspaceId: string, actor: WorkspaceRegistryActor): Promise<ConversationMarkUnreadResult> {
    if (!deps.getRecord(workspaceId)) return unknown(workspaceId)
    const chats = await Promise.resolve(deps.latestChatTurnEnd?.(workspaceId)).catch(() => undefined)
    // Read after the transcripts were, so the clock compared is the one now.
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const recorded = typeof record.lastTurnEndedAt === 'number' ? record.lastTurnEndedAt : undefined
    const finishedAt = Math.max(recorded ?? Number.NEGATIVE_INFINITY, chats ?? Number.NEGATIVE_INFINITY)
    if (!Number.isFinite(finishedAt))
      return {
        ok: false,
        code: 'nothing_finished',
        message: 'No agent in this chat has finished anything yet, so there is nothing to mark unread.',
      }
    const stored = typeof record.lastVisitedAt === 'number' ? record.lastVisitedAt : null
    // Already unread from further back, the clock stays there; the stamp is
    // still written, which is what every device reads a Mark unread from.
    const at = stored !== null && stored < finishedAt - 1 ? stored : finishedAt - 1
    const written = deps.rewindVisit(workspaceId, at, actor)
    if (!written.ok) return { ok: false, code: 'write_failed', message: written.message }
    return { ok: true, workspaceId, lastVisitedAt: at }
  }

  /**
   * Snooze, from any device: the row menu's Snooze and Wake now. A chat
   * sleeps until `until`, and `null` wakes it. As the menu does, it refuses
   * while an agent there is working (this desktop's windows end the chat's
   * processes for a snooze, and the work with them), and for a resting chat,
   * which has nowhere to sleep. Waking one that is awake writes nothing.
   */
  function snooze(workspaceId: string, until: number | null, actor: WorkspaceRegistryActor): ConversationSnoozeResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const asleep = typeof record.snoozedUntil === 'number' && record.snoozedUntil > now()
    if (until === null) {
      if (record.snoozedUntil == null) return { ok: true, workspaceId, snoozedUntil: null }
      const failed = write(workspaceId, wakeSnoozedWorkspacePatch(), actor)
      return failed ?? { ok: true, workspaceId, snoozedUntil: null }
    }
    if (!Number.isFinite(until) || until <= now())
      return { ok: false, code: 'invalid_arguments', message: 'A chat sleeps until a time that is still ahead.' }
    if (isSettledWorkspace(record))
      return { ok: false, code: 'settled', message: 'This chat is settled. Bring it back before snoozing it.' }
    if (!asleep && deps.isWorking(workspaceId))
      return {
        ok: false,
        code: 'working',
        message: 'An agent in this chat is still working. Snooze it once it has finished.',
      }
    const at = Math.trunc(until)
    const failed = write(workspaceId, { snoozedUntil: at }, actor)
    return failed ?? { ok: true, workspaceId, snoozedUntil: at }
  }

  /**
   * The row menu's Star and Highlight color, from any device. A member left
   * out keeps what the chat has; a chat left with neither has its highlight
   * cleared.
   */
  function highlight(
    workspaceId: string,
    change: { starred?: boolean; color?: HighlightColor | null },
    actor: WorkspaceRegistryActor,
  ): ConversationHighlightResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const patch = highlightWorkspacePatch(record, change)
    const next = patch.highlight ?? null
    const failed = write(workspaceId, patch, actor)
    return failed ?? { ok: true, workspaceId, starred: next?.starred === true, color: next?.color ?? null }
  }

  /**
   * The row menu's Auto-settle switch, from any device. Settles nothing by
   * itself: the rest sweep reads it on its next tick.
   */
  function setAutoSettle(
    workspaceId: string,
    enabled: boolean,
    actor: WorkspaceRegistryActor,
  ): ConversationAutoSettleResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    if ((record.autoSettleEnabled === true) === enabled) return { ok: true, workspaceId, autoSettle: enabled }
    const failed = write(workspaceId, { autoSettleEnabled: enabled ? true : null }, actor)
    return failed ?? { ok: true, workspaceId, autoSettle: enabled }
  }

  /**
   * The row menu's Rename, from any device: the name every device lists the
   * chat by. A name the chat has already writes nothing, so a retry is
   * harmless.
   */
  function rename(workspaceId: string, name: string, actor: WorkspaceRegistryActor): ConversationRenameResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > MAX_CHAT_NAME_LENGTH)
      return {
        ok: false,
        code: 'invalid_arguments',
        message: `A chat's name is between 1 and ${MAX_CHAT_NAME_LENGTH} characters.`,
      }
    if (record.name === trimmed && record.titleLocked === true) return { ok: true, workspaceId, name: trimmed }
    if (!deps.renameWorkspace)
      return { ok: false, code: 'write_failed', message: 'This machine cannot rename its chats from elsewhere.' }
    const written = deps.renameWorkspace(workspaceId, trimmed, actor)
    if (!written.ok) return { ok: false, code: 'write_failed', message: written.message }
    return { ok: true, workspaceId, name: trimmed }
  }

  /**
   * The row menu's Auto compact switch, from any device: the chat's own
   * choice from here on, whatever this machine's default says. Compacts
   * nothing at once: the sweep reads it when the chat next sits idle.
   */
  function setAutoCompact(
    workspaceId: string,
    enabled: boolean,
    actor: WorkspaceRegistryActor,
  ): ConversationAutoCompactResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    if (record.autoCompactEnabled === enabled) return { ok: true, workspaceId, autoCompact: enabled }
    const failed = write(workspaceId, { autoCompactEnabled: enabled }, actor)
    return failed ?? { ok: true, workspaceId, autoCompact: enabled }
  }

  /**
   * A person sent one of the workspace's chats a message from a paired
   * device. The same as a message typed here (`recordWorkspaceUserMessage`):
   * the clock moves forward, and a resting chat wakes, with any hand decision
   * about its rest spent.
   */
  function noteUserMessage(workspaceId: string, at: number, actor: WorkspaceRegistryActor): void {
    const record = deps.getRecord(workspaceId)
    if (!record) return
    if (typeof record.lastUserMessageAt === 'number' && record.lastUserMessageAt >= at) return
    const waking = isSettledWorkspace(record) || record.settledOverride != null
    write(workspaceId, { ...(waking ? wakeWorkspacePatch(null, record, now()) : {}), lastUserMessageAt: at }, actor)
  }

  function dropPending(workspaceId: string): void {
    pending.get(workspaceId)?.cancel?.()
    pending.delete(workspaceId)
  }

  /**
   * Carry out a settle an agent asked for on its own chat, or let it go. It
   * goes ahead only once that agent's turn completes, and only if nothing new
   * happened in the chat meanwhile: a turn that failed or was stopped, a
   * message to any of the workspace's chats (the person's, or one steered
   * into the running turn), a turn starting, or the session closing each
   * leave the chat as it is. The settle itself is the tool's own, so it is
   * refused, and dropped, if any agent there is working by then.
   */
  function onConversationEvent(event: ConversationEvent): void {
    const waiting = pending.get(event.workspaceId)
    if (!waiting) return
    const own = event.agentId === waiting.agentId
    switch (event.type) {
      case 'user_message':
        dropPending(event.workspaceId)
        return
      case 'turn_started':
        // The asking turn had started before it asked; a turn starting now is new work.
        if (!own || waiting.cancel) dropPending(event.workspaceId)
        return
      case 'turn_failed':
      case 'session_closed':
        if (own) dropPending(event.workspaceId)
        return
      case 'turn_completed':
        // A turn a steered message ended goes straight on, and the message
        // that steered it has already let the settle go.
        if (!own || event.payload?.steered === true || waiting.cancel) return
        waiting.cancel = schedule(() => {
          if (pending.get(event.workspaceId) !== waiting) return
          pending.delete(event.workspaceId)
          if (deps.messageWaiting?.(event.workspaceId)) return
          const result = settle(event.workspaceId, true, waiting.actor)
          if (!result.ok)
            deps.log?.(`A chat its agent asked to settle was left as it is: ${result.message} (${result.code})`)
        }, OWN_SETTLE_GRACE_MS)
        return
    }
  }

  return {
    settle,
    visit,
    markUnread,
    snooze,
    highlight,
    setAutoSettle,
    rename,
    setAutoCompact,
    noteUserMessage,
    onConversationEvent,
    /** Whether a settle waits on an agent's turn in the workspace. Exposed for tests. */
    settlesWhenTurnEnds: (workspaceId: string) => pending.has(workspaceId),
  }
}

/**
 * Whether a registry change moves what a paired device's conversation list
 * says, so the change feed tells it to list again.
 *
 * The list reads the desktop's records now — whether a chat is resting, its
 * title, when it was last written to and looked at — so a change to one is a
 * change to the list, as a turn ending is. All but one are rare. A visit is
 * stamped every few seconds while a chat is on screen, and a phone re-listing
 * that often would be told nothing new: a visit only changes what a device
 * draws when it is the first since the chat's agent finished. So a visit
 * alone is passed on the first time this run sees one for the chat, and after
 * that only when a turn has ended since the last one (`turnEndOf`, read from
 * the chats main holds now).
 */
export function createConversationListChangeFilter(deps: {
  turnEndOf(workspaceId: string): number | undefined
}): (event: WorkspaceSyncEvent) => boolean {
  const lastVisit = new Map<string, number>()
  return (event) => {
    if (event.type === 'workspace.renamed' || event.type === 'workspace.removed' || event.type === 'workspace.created')
      return true
    if (event.type !== 'workspace.fields_updated') return false
    const { workspaceId, patch } = event.payload
    if (LIST_FIELDS.some((field) => patch[field] !== undefined)) return true
    if (typeof patch.lastVisitedAt !== 'number') return false
    const previous = lastVisit.get(workspaceId)
    // Mark unread moves the clock back, which every device has to hear.
    if (typeof patch.visitRewoundAt === 'number') {
      lastVisit.set(workspaceId, patch.lastVisitedAt)
      return true
    }
    lastVisit.set(workspaceId, Math.max(previous ?? 0, patch.lastVisitedAt))
    if (previous === undefined) return true
    const turnEnd = deps.turnEndOf(workspaceId)
    return turnEnd !== undefined && turnEnd > previous
  }
}

/** The record fields a listed chat reads, beside the visit clock. */
const LIST_FIELDS = [
  'settledAt',
  'lastUserMessageAt',
  'snoozedUntil',
  'highlight',
  'autoSettleEnabled',
  // What a paired desktop's chat management reads (`ConversationThread.autoCompact`).
  'autoCompactEnabled',
] as const satisfies ReadonlyArray<keyof WorkspaceFieldsPatch>

/**
 * Whether a registry change moves what `workspace.list` says, so the change
 * feed tells a paired device to read it again. Every change does but a patch
 * of the clocks alone, which the list does not carry: a visit is stamped every
 * few seconds while a chat is on screen, and a keystroke or a turn's end moves
 * one too, and each was a re-read of every workspace on every paired device
 * for a list that came back the same. The conversation list, which does read
 * them, has its own filter above.
 */
export function movesWorkspaceList(event: WorkspaceSyncEvent): boolean {
  if (event.type !== 'workspace.fields_updated') return true
  return Object.entries(event.payload.patch).some(
    ([field, value]) => value !== undefined && !UNLISTED_CLOCKS.has(field as keyof WorkspaceFieldsPatch),
  )
}

/** The record's clocks, none of which `workspace.list` projects. */
const UNLISTED_CLOCKS = new Set<keyof WorkspaceFieldsPatch>([
  'lastVisitedAt',
  'visitRewoundAt',
  'lastTerminalActivityAt',
  'lastUserMessageAt',
  'lastTurnEndedAt',
])

const epoch = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * When a chat last finished a turn: the latest of the reading given (its
 * transcript's index, which keeps it across a restart and for turns that
 * ended before a session of this run held it) and of what the sessions this
 * run holds read off the same events. With no `agentId`, any of the
 * workspace's chats. Never `updatedAt`, which a rename, a session starting or
 * stopping, or a usage report moves too. The one reading of it the list, the
 * change feed and Mark unread all take, so they cannot disagree.
 */
export function latestTurnEnd(
  sessions: ReadonlyArray<Pick<ConversationSessionSummary, 'workspaceId' | 'agentId' | 'lastTurnEndedAt'>>,
  key: { workspaceId: string; agentId?: string },
  known?: number | null,
): number | undefined {
  let latest = epoch(known) ? known : undefined
  for (const session of sessions) {
    if (session.workspaceId !== key.workspaceId) continue
    if (key.agentId !== undefined && session.agentId !== key.agentId) continue
    if (epoch(session.lastTurnEndedAt) && session.lastTurnEndedAt > (latest ?? -1)) latest = session.lastTurnEndedAt
  }
  return latest
}
