import type { Workspace, WorkspaceId } from '../../renderer/src/types/workspace'
import { comparablePath } from '../../shared/host-paths'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { WorkspaceSyncService } from '../workspace-sync-service'
import type { PoolChat } from './pool-idle'

type ChatRecord = Pick<
  Workspace,
  | 'id'
  | 'folderPath'
  | 'worktree'
  | 'agents'
  | 'settledAt'
  | 'lastUserMessageAt'
  | 'lastTurnEndedAt'
  | 'lastTerminalActivityAt'
  | 'lastVisitedAt'
> & { worktreeState?: Workspace['worktreeState']; name?: string | null }

/**
 * The chats the pool weighs a slot's use against (pool-idle.ts), read off the
 * workspace registry as the renderer's cleanup plan reads it
 * (`agentWorktreeCleanupPlan`): a chat's folder, every path its agents work
 * in, and every worktree entry still assigned to an agent that exists or
 * being removed. A settled chat nobody has open counts as deleted (owner
 * ruling 2026-10-08) and is left out, so its slot goes back as it always did.
 *
 * Null for a registry with no chats at all: as likely one that could not be
 * read as a machine with none, and read as "no chat uses these" it would let
 * every slot go (`chatIdsOnRecord` reasons the same way).
 */
export function poolChatsOf(state: {
  workspaces: readonly ChatRecord[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: ReadonlyArray<{ activeWorkspaceId: WorkspaceId | null }>
}): PoolChat[] | null {
  if (state.workspaces.length === 0) return null
  const open = new Set<string>(
    [state.activeWorkspaceId, ...state.workspaceWindows.map((window) => window.activeWorkspaceId)].filter(
      (id): id is WorkspaceId => typeof id === 'string',
    ),
  )
  const chats: PoolChat[] = []
  for (const workspace of state.workspaces) {
    const onScreen = open.has(workspace.id)
    if (isSettledWorkspace(workspace) && !onScreen) continue
    const paths = new Set<string>()
    const entries = workspace.worktreeState?.entries ?? {}
    for (const agent of Object.values(workspace.agents ?? {})) {
      const execution = agent?.execution
      if (!execution) continue
      if (execution.cwd) paths.add(execution.cwd)
      const entry = execution.worktreeId ? entries[execution.worktreeId] : undefined
      if (entry?.path) paths.add(entry.path)
    }
    for (const entry of Object.values(entries)) {
      if (entry.status === 'removing') paths.add(entry.path)
      if (entry.status === 'assigned' && (!entry.ownerAgentId || workspace.agents?.[entry.ownerAgentId])) {
        paths.add(entry.path)
      }
    }
    const folderPath = workspace.folderPath ?? null
    if (folderPath) paths.delete(folderPath)
    const times = [
      workspace.lastUserMessageAt,
      workspace.lastTurnEndedAt,
      workspace.lastTerminalActivityAt,
      workspace.lastVisitedAt,
    ].filter((time): time is number => typeof time === 'number' && Number.isFinite(time))
    chats.push({
      workspaceId: workspace.id,
      folderPath,
      branch: workspace.worktree?.branch ?? null,
      otherPaths: [...paths].filter(Boolean),
      open: onScreen,
      lastActiveAt: times.length > 0 ? Math.max(...times) : null,
      name: workspace.name ?? null,
    })
  }
  return chats
}

/**
 * Mark every chat whose own worktree is at `path` as given back
 * (`worktree.reclaimedAt`), as the renderer marks the ones a sweep's report
 * names: the chat then brings its worktree back when it is opened
 * (chatWorktreeRestore.ts), not when its folder is found missing.
 *
 * The slot was kept on `branch`. When its agent had moved there from the
 * lease's own branch (`leaseBranch`, which the chat records), the chat's
 * record moves too: bringing the worktree back checks out the branch the
 * chat records, and that is where its work is now. A chat on any other
 * branch (an older chat in the same folder) is left as it is.
 */
export function markChatsReclaimed(
  workspaceSyncService: Pick<WorkspaceSyncService, 'getSnapshot' | 'updateWorkspaceFields'>,
  slot: { path: string; branch: string; leaseBranch: string },
): void {
  const reclaimedAt = Date.now()
  for (const workspace of workspaceSyncService.getSnapshot().state.workspaces) {
    const worktree = workspace.worktree
    if (!worktree?.branch || !workspace.folderPath) continue
    if (comparablePath(workspace.folderPath) !== comparablePath(slot.path)) continue
    const moved = slot.branch !== slot.leaseBranch && worktree.branch === slot.leaseBranch
    if (!moved && worktree.reclaimedAt !== undefined) continue
    const next = { ...worktree, ...(moved ? { branch: slot.branch } : {}) }
    if (next.reclaimedAt === undefined) next.reclaimedAt = reclaimedAt
    workspaceSyncService.updateWorkspaceFields(workspace.id, { worktree: next }, 'system')
  }
}
