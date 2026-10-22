import { conversationWorkingRoot, type AgentState } from '../../shared/agent-state'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'

/** A chat as the publish roots read it off the workspace registry. */
type PublishingChat = {
  folderPath?: string | null
  agents?: Record<string, Pick<AgentState, 'execution'> | undefined>
}

/** A worktree the pool has lent, and to whom. */
type LentWorktree = { path: string; lease: { workspaceId: string | null; agentId: string | null } | null }

export type ArtifactPublishRootsDeps = {
  findWorkspace(workspaceId: string): PublishingChat | null
  /** The pool's worktrees, leased or not; empty where there is no pool. */
  poolWorktrees(): Promise<LentWorktree[]>
  /** Folders of the app's own that hold pages to publish (its artifacts folder). */
  appDirs: readonly string[]
}

/**
 * The folders an `artifacts.publish` caller may take files from: its chat's
 * project folder, the worktree the chat runs in, the pool worktrees leased to
 * it, and the app's own artifacts folder. A caller that is no agent of this
 * app gets none, and publishes nothing.
 */
export function createArtifactPublishRoots(
  deps: ArtifactPublishRootsDeps,
): (context: McpConnectionContext | undefined) => Promise<string[] | null> {
  return async (context) => {
    const caller = context?.metadata
    if (caller?.kind !== 'studio-agent' || !caller.workspaceId) return null
    const workspace = deps.findWorkspace(caller.workspaceId)
    if (!workspace) return null
    const roots = new Set<string>()
    if (workspace.folderPath?.trim()) roots.add(workspace.folderPath)
    const agent = caller.agentId ? workspace.agents?.[caller.agentId] : undefined
    const working = conversationWorkingRoot(agent, workspace.folderPath)
    if (working) roots.add(working)
    for (const worktree of await deps.poolWorktrees().catch(() => [])) {
      const lease = worktree.lease
      if (!lease || lease.workspaceId !== caller.workspaceId) continue
      if (lease.agentId && caller.agentId && lease.agentId !== caller.agentId) continue
      roots.add(worktree.path)
    }
    for (const dir of deps.appDirs) roots.add(dir)
    return [...roots]
  }
}
