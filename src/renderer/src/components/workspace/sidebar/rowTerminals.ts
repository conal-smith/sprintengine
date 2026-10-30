// Which terminals and mesh panes a sidebar row stands for, and which of
// their completions the user has not seen yet.

import { finishedUnseen } from '../../../../../shared/workspace-lifecycle'
import { type Workspace } from '../../../types/workspace'
import { meshPanesOf, meshMachineNamesOf } from './folderGroups'

/**
 * The panes this workspace's layout mounts FROM other machines: one entry per
 * remote conversation tab, with the machine it names and the CLI mark if the
 * tab carries one. The layout JSON is the one durable record of a remote
 * pane, so a walk of it — not a live socket — is what says a workspace
 * is remote-flavoured even while the peer sleeps. Each pane is an open
 * terminal for the row's head stack, exactly as a local live session is.
 */
/**
 * The open terminals a row shows as heads, and the one liveness test the row
 * has (the-diff-an-agent-made, decision 9): the local sessions whose process is
 * alive, plus the mesh panes the layout mounts from other machines. A
 * suspended or exited local session is not open — `isLiveTerminal` is the
 * filter the caller applies before building the map — so a chat whose agent
 * has been parked has no heads, no line 2, and no git facts.
 */
export function rowOpenTerminals(
  workspace: Workspace,
  liveSessionsByWorkspaceId: ReadonlyMap<string, ReadonlyArray<{ sessionId: string; cli?: string }>>,
): Array<{ sessionId: string; cli?: string; remote?: boolean }> {
  return [
    ...(liveSessionsByWorkspaceId.get(workspace.id) ?? []).map((session) => ({
      sessionId: session.sessionId,
      ...(session.cli ? { cli: session.cli } : {}),
    })),
    ...meshPanesOf(workspace).map((pane) => ({
      sessionId: pane.tabId,
      ...(pane.cli ? { cli: pane.cli } : {}),
      remote: true,
    })),
  ]
}

/** Whether a row has any open terminal at all — the gate on its second line and its git poll. */
export function rowHasOpenTerminals(
  workspace: Workspace,
  liveSessionsByWorkspaceId: ReadonlyMap<string, ReadonlyArray<unknown>>,
): boolean {
  return (liveSessionsByWorkspaceId.get(workspace.id)?.length ?? 0) > 0 || meshPanesOf(workspace).length > 0
}

/**
 * The machines a row says it lives on. `remoteOrigin` is the primary source —
 * set once at creation and kept when the pane closes — and the layout walk is
 * the fallback for rows that predate it, plus any machine a local workspace
 * has since mounted a pane from. Local is the unmarked default (decision 7).
 */
export function provenanceMachinesOf(workspace: Workspace): string[] {
  const names = new Set<string>()
  if (workspace.remoteOrigin) names.add(workspace.remoteOrigin.machineName)
  for (const name of meshMachineNamesOf(workspace)) names.add(name)
  return [...names]
}

/**
 * The unseen-completion mark — a "Done" pill on the row, drawn by
 * `doneRowClass`: which workspaces finished a turn while the person was
 * looking elsewhere, and have not been opened since.
 *
 * Sourced ONLY from hook-authoritative activity ([[agent-state-hooks-only]]):
 * `workingSince` is `deriveWorkspaceWorkingSince` — the clock the row's
 * working counter already trusts, non-null only while hooks say a turn is in
 * flight. A turn is DONE when that clock stops on a workspace that still has a
 * hook-settled session (`settledWorkspaceIds`): a process that was killed
 * mid-turn also stops the clock, and it did not finish anything. Opening the
 * workspace clears its mark, and so does going back to work — a parked model
 * that its background agent re-invoked is not finished, and earns the mark
 * again when that turn ends. The active workspace never earns one — the
 * person is watching. Pure, so the sidebar's effect stays a one-liner.
 */
export function deriveUnseenCompletions(input: {
  previous: ReadonlySet<string>
  workingSinceBefore: Readonly<Record<string, number | null | undefined>>
  workingSinceNow: Readonly<Record<string, number | null | undefined>>
  settledWorkspaceIds: ReadonlySet<string>
  activeWorkspaceId: string | null
}): Set<string> {
  const next = new Set<string>()
  for (const id of input.previous) {
    if (id === input.activeWorkspaceId) continue
    if (!(id in input.workingSinceNow)) continue
    if (typeof input.workingSinceNow[id] === 'number') continue
    next.add(id)
  }
  for (const id of Object.keys(input.workingSinceNow)) {
    const before = input.workingSinceBefore[id]
    const now = input.workingSinceNow[id]
    const stopped = typeof before === 'number' && typeof now !== 'number'
    if (!stopped) continue
    if (id === input.activeWorkspaceId) continue
    if (!input.settledWorkspaceIds.has(id)) continue
    next.add(id)
  }
  return next
}

/**
 * The unseen-completion marks a visit from elsewhere has not cleared.
 *
 * A mark is this window's own reading, but whether the finish has been seen
 * is not: a person who read the chat on their phone, or in another desktop
 * following it, has seen it, and the chat's `lastVisitedAt` says so. A mark
 * that a visit landed on or after (`markedAt`, when this window put it up)
 * comes down, so reading a chat anywhere clears its green here too. Answers
 * `marks` itself when nothing changed, so a caller can keep its identity.
 */
export function keepUnvisitedCompletions(input: {
  marks: ReadonlySet<string>
  markedAt: ReadonlyMap<string, number>
  visitedAt: (workspaceId: string) => number | null | undefined
}): ReadonlySet<string> {
  let next: Set<string> | null = null
  for (const id of input.marks) {
    const marked = input.markedAt.get(id)
    const visited = input.visitedAt(id)
    if (marked === undefined || typeof visited !== 'number' || visited < marked) continue
    next ??= new Set(input.marks)
    next.delete(id)
  }
  return next ?? input.marks
}

/**
 * The unseen-completion marks the visit clock says, read off the record
 * rather than watched happen: every chat whose latest finish is newer than
 * anyone's last look at it, on any device, and which has nothing working or
 * waiting now (`finishedUnseen`, the rule a paired machine's row for the same
 * chat is marked by). This is what survives a reload or a window hidden
 * overnight, where the transitions `deriveUnseenCompletions` watches for
 * were never seen; and what makes the green row here and on a paired machine
 * the same. The chat on screen is being looked at, and a chat followed from a
 * paired machine keeps its read state there, so neither is marked. Answers
 * `previous` itself when the marks are the same, so a caller keeps its identity.
 *
 * `visitedAt` reads the chat's visit clock somewhere other than the record
 * handed in, for a caller whose records can be a visit behind.
 */
export function visitClockCompletions<W extends Pick<Workspace, 'id' | 'lastVisitedAt' | 'remoteOrigin'>>(input: {
  workspaces: readonly W[]
  /** When an agent in the chat last finished a turn, as far as this window knows. */
  finishedAt: (workspace: W) => number | null
  idle: (workspaceId: string) => boolean
  onScreenWorkspaceId: string | null
  visitedAt?: (workspace: W) => number | null | undefined
  previous?: ReadonlySet<string>
}): ReadonlySet<string> {
  const next = new Set<string>()
  for (const workspace of input.workspaces) {
    if (workspace.id === input.onScreenWorkspaceId || workspace.remoteOrigin) continue
    if (
      finishedUnseen({
        idle: input.idle(workspace.id),
        finishedAt: input.finishedAt(workspace),
        visitedAt: input.visitedAt ? input.visitedAt(workspace) : workspace.lastVisitedAt,
      })
    )
      next.add(workspace.id)
  }
  const previous = input.previous
  if (previous && previous.size === next.size && [...next].every((id) => previous.has(id))) return previous
  return next
}

/** A live session whose hooks report a settled phase: the turn ended, the agent is still there. */
export function isHookSettledSession(session: {
  processAlive: boolean
  agentState?: { phase: string; source: string }
}): boolean {
  if (!session.processAlive) return false
  const state = session.agentState
  if (!state || state.source !== 'hook') return false
  return state.phase === 'idle' || state.phase === 'awaiting_input'
}
