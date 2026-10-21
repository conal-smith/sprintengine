import type { AgentWorktreeCleanupReport } from '../../../shared/electron-api'
import { agentLeaseKey } from '../../../shared/ipc/worktree-pool'
import { workspaceProjectRootOf } from '../../../shared/worktree-paths'
import type { Workspace } from '../types/workspace'
import { samePath } from './paths'
import { isSettledWorkspace } from './workspaceSettle'

type CleanupWorkspace = Pick<Workspace, 'id' | 'folderPath' | 'worktree' | 'agents' | 'worktreeState' | 'settledAt'>

/**
 * What the agent worktree cleanup (main's agent-worktree-cleanup.ts) is asked
 * to sweep, and what it must leave alone, read off the app's own records.
 *
 * Protected — never removed, whatever git says about them:
 * - every workspace's folder: a chat opened on a worktree IS its folder, and
 *   the person can come back to it until the chat is deleted;
 * - every path an agent record points at (its worktree entry or its cwd),
 *   because a parked agent can be resumed into it;
 * - every worktree entry still `assigned` to an agent that exists, or
 *   mid-`removing`.
 *
 * Except a SETTLED chat, which counts as deleted (owner ruling 2026-10-08):
 * nothing it records keeps anything. Its folder, every path its agents and
 * worktree entries point at, its agents (so a slot one of them leased for
 * itself goes back) and its branches are all left out, and the sweep's own
 * rules decide. Offered, not given: main still keeps a worktree with changes,
 * or with ignored files that may be work, and removing a worktree never
 * deletes an unmerged branch, so returning to the chat checks it out again
 * when its branch is still there (`chatWorktreeRestore.ts`). A settled chat
 * someone has open in a window (`activeWorkspaceIds`) keeps everything while
 * it is looked at. A project's own checkout is never the sweep's to take,
 * whichever chat sits in it.
 *
 * An entry still marked `assigned` to an agent that no longer exists is an
 * orphan from before agents released their worktrees, and is NOT protected:
 * that is exactly the backlog this sweep exists to clear.
 *
 * Every agent the records hold is named, because a worktree pool slot an agent
 * leased for itself (MCP `worktree.lease`) is in use while that agent exists,
 * wherever its terminal sits. Each is named with its chat as well
 * (`agentKeys`): an agent id is unique only within its chat. Every branch a
 * chat or worktree entry records is named too: main deletes Studio's merged
 * branches (the person's prefix or `agent/`), but never one a chat that is not
 * settled may still be restored from (`chatWorktreeRestore.ts`).
 *
 * Every project root the records mention is swept. Main's own rules decide
 * what in it is an agent worktree at all (one of Studio's branches in the
 * app's container) and whether it is clean and merged.
 */
export function agentWorktreeCleanupPlan(
  workspaces: readonly CleanupWorkspace[],
  activeWorkspaceIds: Iterable<string | null> = [],
): {
  repoRoots: string[]
  protectedPaths: string[]
  agentIds: string[]
  agentKeys: string[]
  keepBranches: string[]
} {
  const active = new Set(activeWorkspaceIds)
  const protectedPaths = new Set<string>()
  const agentIds = new Set<string>()
  const agentKeys = new Set<string>()
  const keepBranches = new Set<string>()
  const repoRoots: string[] = []
  const addRoot = (root: string | null): void => {
    if (root && !repoRoots.some((existing) => samePath(existing, root))) repoRoots.push(root)
  }

  for (const workspace of workspaces) {
    addRoot(workspaceProjectRootOf(workspace))
    // Settled and not open anywhere: as good as deleted, and nothing it records keeps anything.
    if (isSettledWorkspace(workspace) && !active.has(workspace.id)) continue
    if (workspace.folderPath) protectedPaths.add(workspace.folderPath)
    if (workspace.worktree?.branch) keepBranches.add(workspace.worktree.branch)
    const entries = workspace.worktreeState?.entries ?? {}
    for (const [agentId, agent] of Object.entries(workspace.agents ?? {})) {
      agentIds.add(agentId)
      agentKeys.add(agentLeaseKey(workspace.id, agentId))
      const execution = agent?.execution
      if (!execution) continue
      if (execution.cwd) protectedPaths.add(execution.cwd)
      const entry = execution.worktreeId ? entries[execution.worktreeId] : undefined
      if (entry?.path) protectedPaths.add(entry.path)
    }
    for (const entry of Object.values(entries)) {
      if (entry.branch) keepBranches.add(entry.branch)
      if (entry.status === 'removing') protectedPaths.add(entry.path)
      if (entry.status === 'assigned' && (!entry.ownerAgentId || workspace.agents?.[entry.ownerAgentId])) {
        protectedPaths.add(entry.path)
      }
    }
  }

  return {
    repoRoots,
    protectedPaths: [...protectedPaths],
    agentIds: [...agentIds],
    agentKeys: [...agentKeys],
    keepBranches: [...keepBranches],
  }
}

/** Every window's open chat: a settled chat someone is reading keeps its worktree meanwhile. */
export function openWorkspaceIds(state: {
  activeWorkspaceId: string | null
  workspaceWindows: ReadonlyArray<{ activeWorkspaceId: string | null }>
}): Array<string | null> {
  return [state.activeWorkspaceId, ...state.workspaceWindows.map((windowState) => windowState.activeWorkspaceId)]
}

/**
 * The worktree chats whose own folder a report removed, or handed back to the
 * worktree pool (whose next lease may give the slot to another agent): their
 * worktree was given back, and is marked so (`worktree.reclaimedAt`) so the chat brings it
 * back when it is opened rather than reading as a chat with a missing folder.
 * Only a settled chat's folder is ever offered, but the chat is not required
 * to still be settled here: one un-settled while main was sweeping lost its
 * folder all the same, and needs the mark more than any.
 */
export function chatsReclaimedBy(
  workspaces: readonly CleanupWorkspace[],
  report: AgentWorktreeCleanupReport,
): string[] {
  if (report.dryRun) return []
  const removed = report.entries
    .filter((entry) => entry.verdict === 'removed' || entry.verdict === 'returned')
    .map((entry) => entry.path)
  if (removed.length === 0) return []
  return workspaces
    .filter(
      (workspace) =>
        Boolean(workspace.worktree?.branch) &&
        workspace.worktree?.reclaimedAt === undefined &&
        removed.some((path) => samePath(path, workspace.folderPath)),
    )
    .map((workspace) => workspace.id)
}

/**
 * The store entries a report took away, as `[workspaceId, entryId]` pairs to
 * drop: worktrees removed from disk, and pool slots given back to the pool,
 * whose path the next lease hands to someone else.
 */
export function entriesRemovedBy(
  workspaces: readonly CleanupWorkspace[],
  report: AgentWorktreeCleanupReport,
): Array<[string, string]> {
  if (report.dryRun) return []
  const removed = report.entries
    .filter((entry) => entry.verdict === 'removed' || entry.verdict === 'returned')
    .map((entry) => entry.path)
  if (removed.length === 0) return []
  const pairs: Array<[string, string]> = []
  for (const workspace of workspaces) {
    for (const entry of Object.values(workspace.worktreeState?.entries ?? {})) {
      if (removed.some((path) => samePath(path, entry.path))) pairs.push([workspace.id, entry.id])
    }
  }
  return pairs
}
