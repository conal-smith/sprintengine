import { comparablePath } from '../shared/host-paths'
import { dependencyInstallSettingFor } from '../shared/ipc/worktree-pool'
import { chatIdsOnRecord } from './agent-worktree-keep-checks'
import { diagnosticLogger } from './diagnostics-service'
import { seedWorktreeIncludedFiles } from './git'
import { broadcastWorktreePoolChanged, WORKTREE_INSTALL_CHANGED_CHANNEL } from './ipc/worktree-pool-ipc'
import { broadcastToWorkspaceWindows } from './window-factory'
import type { WorkspaceSyncService } from './workspace-sync-service'
import { installWorktreePool } from './worktree-pool/active-pool'
import { createDependencyInstaller, installDependencyInstaller } from './worktree-pool/dependency-install'
import { cachedDependencyInstallEnvironment } from './worktree-pool/install-environment'
import { poolChatsOf } from './worktree-pool/pool-chats'
import { createPoolStore } from './worktree-pool/pool-store'
import { createWorktreePoolService } from './worktree-pool/worktree-pool-service'
import { createWorktreePoolTools } from './worktree-pool/worktree-pool-tools'

/** What app-services.ts wires the worktree pool, its dependency installer and the `worktree` tools from. */
export type WorktreeServicesContext = {
  /** The app's userData folder, where the pool keeps its records. */
  userDataPath: string
  /** Where live work sits (app-services' `liveWorkPaths`): a slot something works in is never recycled. */
  liveWorkPaths: () => Promise<string[]>
  /** Where a chat's session works now (a running turn, or a live child): part of `liveWorkPaths`, asked apart. */
  liveConversationPaths: () => Promise<string[]>
  workspaceSyncService: WorkspaceSyncService
}

export function createWorktreeServices({
  userDataPath,
  liveWorkPaths,
  liveConversationPaths,
  workspaceSyncService,
}: WorktreeServicesContext) {
  // The pool of reusable agent worktrees (worktree-pool/). Every agent
  // worktree made with `fromPool` (git.ts) is leased from it, and the agent
  // worktree cleanup hands back the slots nothing uses. It does nothing on its
  // own: reading its records is all that happens here, and a pool recovers
  // from an interrupted run the first time it is used.
  const worktreePool = createWorktreePoolService({
    store: createPoolStore(userDataPath),
    livePaths: liveWorkPaths,
    liveSessionPaths: liveConversationPaths,
    // Recovery, holds and evictions are what a person asks about later.
    log: diagnosticLogger('worktree-pool'),
    onChange: broadcastWorktreePoolChanged,
    seedIncludedFiles: seedWorktreeIncludedFiles,
    // Settled chats included: a slot holding a chat's history is never removed.
    knownWorkspaceIds: () => chatIdsOnRecord(workspaceSyncService.getSnapshot().state.workspaces),
    // What a slot given back while its chat lives is weighed against
    // (worktree-pool/pool-idle.ts): which chats work in it, whether one is on
    // screen, and when each was last active.
    chats: () => poolChatsOf(workspaceSyncService.getSnapshot().state),
    // The chat whose worktree it was is marked as the cleanup's report marks
    // it (`chatsReclaimedBy`), so opening it brings the worktree back: a slot
    // a lease gave back to make room is in no report.
    onGivenBack: ({ path }) => markChatsReclaimed(workspaceSyncService, path),
  })
  installWorktreePool(worktreePool)
  void worktreePool.load()
  // The dependency install an agent worktree runs when its project opted in
  // and its lockfile changed (worktree-pool/dependency-install.ts), with the
  // environment the person's own terminal has and none of the app's own
  // variables (worktree-pool/install-environment.ts): one login shell's,
  // kept for the leases of the next few minutes.
  const dependencyInstallEnv = cachedDependencyInstallEnvironment()
  const dependencyInstaller = createDependencyInstaller({
    env: () => dependencyInstallEnv.read(),
    forgetEnv: () => dependencyInstallEnv.forget(),
    log: diagnosticLogger('worktree-install'),
    onChange: (view) => broadcastToWorkspaceWindows(WORKTREE_INSTALL_CHANGED_CHANNEL, view),
  })
  installDependencyInstaller(dependencyInstaller)
  // `worktree.lease` and `worktree.release`: in process the gateway's own, out
  // of process the shell's `worktree` toolset.
  const worktreeTools = createWorktreePoolTools({
    pool: worktreePool,
    findWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    // The install a chat's own leased worktree gets, when the project opted in.
    installDependencies: async (request) =>
      dependencyInstaller.prepare({
        ...request,
        setting: dependencyInstallSettingFor(await worktreePool.getSettings(), request.repoRoot),
      }),
  })
  return { worktreePool, dependencyInstaller, worktreeTools }
}

/**
 * Mark every chat whose own worktree is at `path` as given back
 * (`worktree.reclaimedAt`), as the renderer marks the ones a sweep's report
 * names: the chat then brings its worktree back when it is opened
 * (chatWorktreeRestore.ts), not when its folder is found missing.
 */
function markChatsReclaimed(workspaceSyncService: WorkspaceSyncService, path: string): void {
  const reclaimedAt = Date.now()
  for (const workspace of workspaceSyncService.getSnapshot().state.workspaces) {
    const worktree = workspace.worktree
    if (!worktree?.branch || worktree.reclaimedAt !== undefined || !workspace.folderPath) continue
    if (comparablePath(workspace.folderPath) !== comparablePath(path)) continue
    workspaceSyncService.updateWorkspaceFields(workspace.id, { worktree: { ...worktree, reclaimedAt } }, 'system')
  }
}
