import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { RepositoryIdentityRead } from '../../shared/repository-identity'
import type { GitRepoTrustDecision, GitRepoTrustView } from '../../shared/ipc/git-repo-trust'
import type { ModuleWorkspaceGitInfoResult } from '../../shared/modules/workspace-view'
import type { GitFileHunksResult, GitHunkRef, GitHunkScope } from '../../shared/git/hunks'
import type { Changelist } from '../../shared/git/changelists'
import type {
  ElectronApi,
  CloneProgress,
  RepositoryCloneInput,
  RepositoryCloneResult,
  GitHubRepoListResult,
  GitHubTokenStatus,
  GitBranchSnapshot,
  GitCommandResult,
  GitConflictFileContent,
  GitFileBaseResult,
  GitFileStage,
  GitFileStageResult,
  GitGraphOptions,
  GitGraphSnapshot,
  GitRepoOperation,
  GitResetMode,
  GitStashListSnapshot,
  GitPatchResult,
  GitPatchSaveResult,
  BranchStepDiff,
  BranchStepSelection,
  BranchStepsSnapshot,
  RevFileResult,
  WorkspaceChangeSummary,
  GitStatusSnapshot,
  GitWorktreeCreateInput,
  GitWorktreeCreated,
  GitWorktreeListSnapshot,
  GitWorktreeOperationResult,
  GitWorktreeRemoveInput,
  GitWorktreeRestoreInput,
  GitWorktreeRestoreResult,
  GitCheckoutChange,
  AgentWorktreeCleanupInput,
  AgentWorktreeCleanupReport,
} from '../../shared/electron-api'

// One subscription to main's `git:checkout-changed` per window, fanned out
// here by checkout; main is asked to watch a checkout while at least one
// listener in this window wants it. Keys are spelled the way main spells them
// (git-repo-watch.ts `checkoutKey`).
type CheckoutChangeListener = (change: GitCheckoutChange) => void
const checkoutListeners = new Map<string, Set<CheckoutChangeListener>>()
let checkoutChannelInstalled = false

function gitCheckoutKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

function installCheckoutChannel(): void {
  if (checkoutChannelInstalled) return
  checkoutChannelInstalled = true
  ipcRenderer.on('git:checkout-changed', (_: IpcRendererEvent, changes: GitCheckoutChange[]) => {
    for (const change of changes) {
      for (const listener of checkoutListeners.get(change.checkoutKey) ?? []) {
        try {
          listener(change)
        } catch (error) {
          console.warn('[git] checkout change listener threw', error)
        }
      }
    }
  })
}

export const gitApi = {
  watchGitCheckout: (checkoutPath: string, cb: CheckoutChangeListener): (() => void) => {
    installCheckoutChannel()
    const key = gitCheckoutKey(checkoutPath)
    let listeners = checkoutListeners.get(key)
    if (!listeners) {
      listeners = new Set()
      checkoutListeners.set(key, listeners)
      void ipcRenderer.invoke('git:checkout-watch-retain', key).catch(() => {})
    }
    listeners.add(cb)
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = checkoutListeners.get(key)
      if (!current) return
      current.delete(cb)
      if (current.size === 0) {
        checkoutListeners.delete(key)
        void ipcRenderer.invoke('git:checkout-watch-release', key).catch(() => {})
      }
    }
  },
  getGitRepoRoot: (folderPath: string, hostId?: string): Promise<string | null> =>
    ipcRenderer.invoke('git:get-repo-root', folderPath, hostId),
  getGitStatus: (repoRoot: string): Promise<GitStatusSnapshot> => ipcRenderer.invoke('git:get-status', repoRoot),
  checkIgnored: (repoRoot: string, relativePaths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('git:check-ignored', repoRoot, relativePaths),
  getWorkspaceChangeSummary: (checkoutPath: string): Promise<WorkspaceChangeSummary> =>
    ipcRenderer.invoke('git:get-workspace-change-summary', checkoutPath),
  getBranchSteps: (checkoutPath: string): Promise<BranchStepsSnapshot> =>
    ipcRenderer.invoke('git:get-branch-steps', checkoutPath),
  getBranchStepDiff: (checkoutPath: string, selection: BranchStepSelection): Promise<BranchStepDiff> =>
    ipcRenderer.invoke('git:get-branch-step-diff', checkoutPath, selection),
  getGitFileAtRev: (repoRoot: string, rev: string, filePath: string): Promise<RevFileResult> =>
    ipcRenderer.invoke('git:get-file-at-rev', repoRoot, rev, filePath),
  getGitFileBase: (repoRoot: string, filePath: string): Promise<GitFileBaseResult> =>
    ipcRenderer.invoke('git:get-file-base', repoRoot, filePath),
  getGitFileAtStage: (repoRoot: string, filePath: string, stage: GitFileStage): Promise<GitFileStageResult> =>
    ipcRenderer.invoke('git:get-file-at-stage', repoRoot, filePath, stage),
  getGitBranches: (repoRoot: string): Promise<GitBranchSnapshot> => ipcRenderer.invoke('git:get-branches', repoRoot),
  getGitRepositoryIdentity: (folderPath: string): Promise<RepositoryIdentityRead> =>
    ipcRenderer.invoke('git:get-repository-identity', folderPath),
  getGitRepoTrust: (folderPath: string): Promise<GitRepoTrustView | null> =>
    ipcRenderer.invoke('git-repo-trust:get', folderPath),
  answerGitRepoTrust: (input: {
    folderPath: string
    hash: string
    decision: GitRepoTrustDecision
  }): Promise<GitRepoTrustView | null> => ipcRenderer.invoke('git-repo-trust:answer', input),
  onGitRepoTrustChanged: (cb: (view: GitRepoTrustView | null) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, view: GitRepoTrustView | null) => cb(view)
    ipcRenderer.on('git-repo-trust:changed', handler)
    return () => ipcRenderer.removeListener('git-repo-trust:changed', handler)
  },
  getModuleWorkspaceGitInfo: (folderPath: string): Promise<ModuleWorkspaceGitInfoResult> =>
    ipcRenderer.invoke('git:get-module-workspace-info', folderPath),
  getGitCommitGraph: (repoRoot: string, options?: GitGraphOptions): Promise<GitGraphSnapshot> =>
    ipcRenderer.invoke('git:get-commit-graph', repoRoot, options),
  getGitConflictFile: (repoRoot: string, filePath: string): Promise<GitConflictFileContent | null> =>
    ipcRenderer.invoke('git:get-conflict-file', repoRoot, filePath),
  resolveGitConflict: (repoRoot: string, filePath: string, content: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:resolve-conflict', repoRoot, filePath, content),
  getGitFileHunks: (repoRoot: string, filePath: string, scope: GitHunkScope): Promise<GitFileHunksResult> =>
    ipcRenderer.invoke('git:get-file-hunks', repoRoot, filePath, scope),
  stageGitHunk: (ref: GitHunkRef): Promise<GitCommandResult> => ipcRenderer.invoke('git:stage-hunk', ref),
  unstageGitHunk: (ref: GitHunkRef): Promise<GitCommandResult> => ipcRenderer.invoke('git:unstage-hunk', ref),
  stageGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stage', repoRoot, paths),
  unstageGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:unstage', repoRoot, paths),
  revertGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:revert', repoRoot, paths),
  commitGitChanges: (repoRoot: string, message: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:commit', repoRoot, message),
  pushGitBranch: (repoRoot: string): Promise<GitCommandResult> => ipcRenderer.invoke('git:push', repoRoot),
  fetchGitRemotes: (repoRoot: string): Promise<GitCommandResult> => ipcRenderer.invoke('git:fetch', repoRoot),
  pullGitBranchWithStash: (repoRoot: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:pull-with-stash', repoRoot),
  switchGitBranch: (repoRoot: string, branchName: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:switch-branch', repoRoot, branchName),
  mergeGitRef: (repoRoot: string, ref: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:merge-ref', repoRoot, ref),
  rebaseGitBranch: (repoRoot: string, ontoRef: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:rebase-branch', repoRoot, ontoRef),
  cherryPickGitCommit: (repoRoot: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:cherry-pick', repoRoot, commitHash),
  revertGitCommit: (repoRoot: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:revert-commit', repoRoot, commitHash),
  resetGitBranchToCommit: (repoRoot: string, commitHash: string, mode: GitResetMode): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:reset-to-commit', repoRoot, commitHash, mode),
  deleteGitBranch: (repoRoot: string, branchName: string, force?: boolean): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:delete-branch', repoRoot, branchName, force),
  renameGitBranch: (repoRoot: string, branchName: string, newName: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:rename-branch', repoRoot, branchName, newName),
  continueGitOperation: (repoRoot: string, operation: GitRepoOperation): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:operation-continue', repoRoot, operation),
  abortGitOperation: (repoRoot: string, operation: GitRepoOperation): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:operation-abort', repoRoot, operation),
  listGitStashes: (repoRoot: string): Promise<GitStashListSnapshot> => ipcRenderer.invoke('git:stash-list', repoRoot),
  pushGitStash: (repoRoot: string, message: string, includeUntracked?: boolean): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stash-push', repoRoot, message, includeUntracked),
  applyGitStash: (repoRoot: string, index: number, expectedHash: string, pop?: boolean): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stash-apply', repoRoot, index, expectedHash, pop),
  dropGitStash: (repoRoot: string, index: number, expectedHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stash-drop', repoRoot, index, expectedHash),
  checkoutGitCommit: (repoRoot: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:checkout-commit', repoRoot, commitHash),
  checkoutGitCommitAsBranch: (repoRoot: string, branchName: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:checkout-commit-as-branch', repoRoot, branchName, commitHash),
  createGitTagFromCommit: (repoRoot: string, tagName: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:tag-from-commit', repoRoot, tagName, commitHash),
  listGitWorktrees: (repoRoot: string): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>> =>
    ipcRenderer.invoke('git:worktree:list', repoRoot),
  createGitWorktree: (input: GitWorktreeCreateInput): Promise<GitWorktreeOperationResult<GitWorktreeCreated>> =>
    ipcRenderer.invoke('git:worktree:create', input),
  restoreGitWorktree: (input: GitWorktreeRestoreInput): Promise<GitWorktreeRestoreResult> =>
    ipcRenderer.invoke('git:worktree:restore', input),
  removeGitWorktree: (input: GitWorktreeRemoveInput): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:remove', input),
  pruneGitWorktrees: (repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:prune', repoRoot),
  unlockAgentGitWorktree: (
    repoRoot: string,
    worktreePath: string,
  ): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:unlock-agent', repoRoot, worktreePath),
  cleanupAgentWorktrees: (input: AgentWorktreeCleanupInput): Promise<AgentWorktreeCleanupReport> =>
    ipcRenderer.invoke('git:worktree:cleanup-agents', input),
  // Changelists and patches (git-commit-window T6). Every changelist call
  // answers with the whole reconciled set, so the panel re-renders from one
  // value instead of patching its own copy.
  getGitChangelists: (repoRoot: string): Promise<Changelist[]> => ipcRenderer.invoke('git:changelists:get', repoRoot),
  setActiveGitChangelist: (repoRoot: string, id: string): Promise<Changelist[]> =>
    ipcRenderer.invoke('git:changelists:set-active', repoRoot, id),
  createGitChangelist: (
    repoRoot: string,
    input: { name: string; comment?: string; activate?: boolean; paths?: string[] },
  ): Promise<Changelist[]> => ipcRenderer.invoke('git:changelists:create', repoRoot, input),
  renameGitChangelist: (
    repoRoot: string,
    id: string,
    input: { name: string; comment?: string },
  ): Promise<Changelist[]> => ipcRenderer.invoke('git:changelists:rename', repoRoot, id, input),
  deleteGitChangelist: (repoRoot: string, id: string): Promise<Changelist[]> =>
    ipcRenderer.invoke('git:changelists:delete', repoRoot, id),
  moveGitChangelistPaths: (repoRoot: string, id: string, paths: string[]): Promise<Changelist[]> =>
    ipcRenderer.invoke('git:changelists:move-paths', repoRoot, id, paths),
  // Main's own writes to a repository's lists (an agent launching, editing or
  // exiting). One channel for every repository, filtered in the renderer on the
  // root, exactly as `terminal:sessions-delta` is one channel for every
  // session: a per-repository channel would need a subscription per open
  // checkout and a teardown nobody would get right.
  onGitChangelistsChanged: (cb: (event: { repoRoot: string }) => void): (() => void) => {
    const ch = 'git:changelists-changed'
    const handler = (_: IpcRendererEvent, event: { repoRoot: string }) => cb(event)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  createGitPatch: (repoRoot: string, paths: string[], cached?: boolean): Promise<GitPatchResult> =>
    ipcRenderer.invoke('git:create-patch', repoRoot, paths, cached),
  saveGitPatch: (repoRoot: string, patch: string, defaultFileName?: string): Promise<GitPatchSaveResult> =>
    ipcRenderer.invoke('git:save-patch', repoRoot, patch, defaultFileName),
  getGitHubTokenStatus: (): Promise<GitHubTokenStatus> => ipcRenderer.invoke('github:token-status'),
  setGitHubToken: (token: string): Promise<GitHubTokenStatus> => ipcRenderer.invoke('github:set-token', token),
  clearGitHubToken: (): Promise<GitHubTokenStatus> => ipcRenderer.invoke('github:clear-token'),
  listGitHubRepos: (): Promise<GitHubRepoListResult> => ipcRenderer.invoke('github:list-repos'),
  cloneRepository: (input: RepositoryCloneInput): Promise<RepositoryCloneResult> =>
    ipcRenderer.invoke('github:clone', input),
  cancelRepositoryClone: (cloneId: string): Promise<void> => ipcRenderer.invoke('github:clone-cancel', cloneId),
  // One channel for every clone, filtered on the id by the caller, as
  // `git:changelists-changed` is one channel for every repository.
  onRepositoryCloneProgress: (cb: (progress: CloneProgress) => void): (() => void) => {
    const ch = 'github:clone-progress'
    const handler = (_: IpcRendererEvent, progress: CloneProgress) => cb(progress)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'watchGitCheckout'
  | 'cleanupAgentWorktrees'
  | 'getGitRepoRoot'
  | 'getGitStatus'
  | 'checkIgnored'
  | 'getWorkspaceChangeSummary'
  | 'getBranchSteps'
  | 'getBranchStepDiff'
  | 'getGitFileAtRev'
  | 'getGitFileBase'
  | 'getGitFileAtStage'
  | 'getGitBranches'
  | 'getGitRepositoryIdentity'
  | 'getGitRepoTrust'
  | 'answerGitRepoTrust'
  | 'onGitRepoTrustChanged'
  | 'getModuleWorkspaceGitInfo'
  | 'getGitCommitGraph'
  | 'getGitConflictFile'
  | 'resolveGitConflict'
  | 'getGitFileHunks'
  | 'stageGitHunk'
  | 'unstageGitHunk'
  | 'stageGitPaths'
  | 'unstageGitPaths'
  | 'revertGitPaths'
  | 'commitGitChanges'
  | 'pushGitBranch'
  | 'fetchGitRemotes'
  | 'pullGitBranchWithStash'
  | 'switchGitBranch'
  | 'mergeGitRef'
  | 'rebaseGitBranch'
  | 'cherryPickGitCommit'
  | 'revertGitCommit'
  | 'resetGitBranchToCommit'
  | 'deleteGitBranch'
  | 'renameGitBranch'
  | 'continueGitOperation'
  | 'abortGitOperation'
  | 'listGitStashes'
  | 'pushGitStash'
  | 'applyGitStash'
  | 'dropGitStash'
  | 'checkoutGitCommit'
  | 'checkoutGitCommitAsBranch'
  | 'createGitTagFromCommit'
  | 'listGitWorktrees'
  | 'createGitWorktree'
  | 'restoreGitWorktree'
  | 'removeGitWorktree'
  | 'pruneGitWorktrees'
  | 'unlockAgentGitWorktree'
  | 'getGitChangelists'
  | 'setActiveGitChangelist'
  | 'createGitChangelist'
  | 'renameGitChangelist'
  | 'deleteGitChangelist'
  | 'moveGitChangelistPaths'
  | 'onGitChangelistsChanged'
  | 'createGitPatch'
  | 'saveGitPatch'
  | 'getGitHubTokenStatus'
  | 'setGitHubToken'
  | 'clearGitHubToken'
  | 'listGitHubRepos'
  | 'cloneRepository'
  | 'cancelRepositoryClone'
  | 'onRepositoryCloneProgress'
>
