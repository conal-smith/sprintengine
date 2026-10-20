import type { Workspace, WorkspaceId } from '../../renderer/src/types/workspace'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
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
> & { worktreeState?: Workspace['worktreeState'] }

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
    })
  }
  return chats
}
