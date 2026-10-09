// Part of the IPC contract: Git status, history, worktrees and the GitHub surfaces.
// ../electron-api.ts re-exports everything here.

import type { GitFileStatus } from './terminal'
import type { WorktreeDependencyInstallView } from './worktree-pool'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

/** A multi-step operation parked in the repo, awaiting continue or abort. */
export type GitRepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export type GitResetMode = 'soft' | 'mixed' | 'hard'

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  operation: GitRepoOperation | null
  updatedAt: number
}

/**
 * The sidebar row's one-line git story (remote-sessions-ux /
 * two-line-session-rows): branch + working-tree ±lines against HEAD. Quiet on
 * anything unreadable — a row simply shows no git facts.
 */
export type GitRowSummary = {
  branch: string | null
  additions: number
  deletions: number
}

/**
 * How many FILES a reading covers, by what happened to each one — the numbers
 * the sidebar line and the header chip draw (`+added+updated` / `−removed`).
 * Lines are shown only where a single file is in view.
 *
 * A rename counts once, as `updated` (it is one file that moved, never a removed
 * plus an added); so does a type change and a conflicted file mid-merge. An
 * untracked file counts as `added`. The three always sum to the reading's own
 * `changedFiles`, which is what lets a caller draw either number without
 * re-deriving the other.
 */
export type ChangedFileCounts = { added: number; updated: number; removed: number }

/**
 * What a workspace's row reports as changed
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The numbers are the span `merge-base(HEAD, <default branch>) → working tree`
 * taken in the checkout the workspace's agents actually work in, so a pull, a
 * merge or a commit landing under the agent cannot inflate them.
 *
 * `scope` is load-bearing, not diagnostic — it says how much the UI is entitled
 * to claim, and the row's tooltip and spoken label are derived from it:
 * `worktree` (a linked worktree, exclusive to this chat), `branch` (a shared
 * checkout ahead of the default branch — the BRANCH's work, which may include a
 * person's commits), and `folder` (a shared checkout level with the default
 * branch, so only its uncommitted state can be reported).
 */
export type WorkspaceChangeSummary = {
  branch: string | null
  additions: number
  deletions: number
  changedFiles: number
  scope: 'worktree' | 'branch' | 'folder'
  /** The same changed files, split by what happened to them: `added + updated + removed === changedFiles`.
   *  Absent only when the per-status reading could not be taken; a caller must then draw nothing
   *  rather than a zero, exactly as for `uncommitted`. */
  files?: ChangedFileCounts
  /** The checkout's UNCOMMITTED changes alone — index + worktree vs HEAD, untracked files counted as additions.
   *  What the line shows once its branch has landed by squash (decision 2). Absent when unreadable. */
  uncommitted?: {
    additions: number
    deletions: number
    changedFiles: number
    /** Split by status, untracked files counted as `added`: sums to this reading's `changedFiles`. */
    files?: ChangedFileCounts
  }
}

/**
 * One step in a branch's timeline: a commit
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * A step is a commit rather than a captured turn, so the timeline is the repo's
 * own history — it survives a restart, a re-clone and a machine change, and a
 * pull cannot invent one.
 */
export type BranchStep = {
  hash: string
  shortHash: string
  /** The commit subject. May be empty; never trusted to be one line. */
  subject: string
  /** Author date, epoch ms. Zero when git gave something unparseable. */
  authoredAt: number
  /**
   * More than one parent. A merge step still carries a diff — what it brought
   * into the branch — so the strip labels it rather than hiding it.
   */
  isMerge: boolean
}

export type BranchStepsSnapshot = {
  branch: string | null
  /** The merge-base the span measures from, or null when none resolves. */
  baseOid: string | null
  /** Same contract as WorkspaceChangeSummary['scope'] — how much may be claimed. */
  scope: 'worktree' | 'branch' | 'folder'
  /** Oldest first: the order the work happened in. */
  steps: BranchStep[]
  /** Whether the working tree carries anything at all, tracked or untracked. */
  hasUncommitted: boolean
}

/** Which slice of the branch a viewer is showing. */
export type BranchStepSelection = { kind: 'span' } | { kind: 'uncommitted' } | { kind: 'commit'; hash: string }

export type BranchStepFile = {
  path: string
  status: 'new' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** Where a rename came from. Absent for every other status. */
  oldPath?: string
}

/** One side of a step's diff, read at a revision. */
export type RevFileResult = { kind: 'content'; content: string } | { kind: 'absent' } | { kind: 'too-large' }

export type BranchStepDiff = {
  files: BranchStepFile[]
  additions: number
  deletions: number
}

export type GitStashEntry = {
  /** Git's selector for the entry, e.g. `stash@{0}`. */
  ref: string
  /** The stash commit hash — the entry's stable identity; selectors renumber. */
  hash: string
  index: number
  branch: string | null
  message: string
  createdAt: number
}

export type GitStashListSnapshot = {
  repoRoot: string
  stashes: GitStashEntry[]
  updatedAt: number
}

export type GitFileBaseResult = { ok: true; content: string } | { ok: false; message: string }

// Which stored version of a file the diff viewer reads. `head` is the committed
// version (`git show HEAD:<p>`); `index` is the staged version (`git show :0:<p>`).
export type GitFileStage = 'head' | 'index'

// Per-hunk staging (git-commit-window T7). The shapes live beside the parser
// that produces them; they are re-exported here because they are part of this
// IPC contract like everything else in this file.
export type {
  GitFileHunks,
  GitFileHunksResult,
  GitHunkRef,
  GitHunkScope,
  GitHunkUnsupported,
  GitHunkView,
  HunkInclusionSummary,
} from '../git/hunks'

// Changelists (git-commit-window T6): the app's own named sets of paths, one
// file per repository under the user-data dir. Re-exported here because they
// cross this boundary, like the hunk shapes above.
export type { Changelist } from '../git/changelists'

/** `git diff` of a selection, as text. `patch` is empty when there was nothing
 *  to diff, and `message` says which of the two sides was empty. */
export type GitPatchResult = { ok: boolean; patch: string; message: string | null }

/** Where a patch was written, or `null` when the person dismissed the dialog —
 *  a cancel is not a failure, so `ok` stays true. */
export type GitPatchSaveResult = { ok: boolean; path: string | null; message: string | null }

export type GitFileStageResult =
  { ok: true; exists: boolean; content: string; binary: boolean; tooLarge: boolean } | { ok: false; message: string }

export type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitGraphCommit = GitCommit & {
  parents: string[]
}

export type GitGraphSnapshot = {
  commits: GitGraphCommit[]
  refs: GitRef[]
  headHash: string | null
  detached: boolean
  totalCount: number
  hasMore: boolean
  updatedAt: number
}

export type GitGraphOptions = {
  limit?: number
  skip?: number
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
  pushedCommitCount?: number
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  /**
   * Set when the lock is the in-use mark the app places on an agent worktree:
   * this profile's, which it releases itself, or another Studio profile's,
   * which it never touches.
   */
  agentLock?: 'this-profile' | 'other-profile'
  prunable: boolean
  prunableReason: string | null
}

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
  /**
   * Lock the new worktree as in use by an agent, naming this owner: the
   * agent's id, or the branch when the agent does not exist yet. The agent
   * worktree cleanup never removes a worktree another profile has locked, and
   * this profile releases its own lock once its records no longer use it.
   */
  agentLockOwner?: string
  /**
   * An agent's worktree, forked from the default branch: leased from the
   * worktree pool (its path is then a pool slot's, not `destinationPath`), or
   * created fresh from `origin/<default>` when there is no pool to lease from.
   * `baseRef` is used only when the repository has no default branch at all.
   */
  fromPool?: boolean
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
  /**
   * The caller shows the dependency install itself: New chat's worktree,
   * whose install is folded into its chat's working line. The install is
   * marked `quiet`, and no window toasts it unless it fails.
   */
  quietInstall?: boolean
}

/** A created worktree, and what it was forked from. */
export type GitWorktreeCreated = GitWorktreeEntry & {
  /** The ref it was forked from, as the caller should record it (`origin/main`, `HEAD`). */
  baseRef: string
  /** Set when the worktree is a pool slot. */
  leaseId: string | null
  /** The dependency install the lease ran before handing the slot out, when it ran one. */
  dependencyInstall?: WorktreeDependencyInstallView | null
}

/**
 * Check a chat's worktree out again at the path it had, on the branch it kept,
 * after the agent worktree cleanup gave it back.
 */
export type GitWorktreeRestoreInput = {
  repoRoot: string
  path: string
  branchName: string
  copyIncludedFiles?: boolean
  /** Lock it again as in use, naming this owner, as creation does. */
  agentLockOwner?: string
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
}

/**
 * A restore's answer. A refusal marked `definitive` is one no retry changes
 * (the branch was deleted, the path is not one of the app's worktrees); any
 * other may succeed next time (the volume is back, the branch was freed).
 */
export type GitWorktreeRestoreResult =
  GitWorktreeOperationResult<GitWorktreeEntry> | { ok: false; message: string; definitive: true }

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

/**
 * Which readings of a checkout went stale (main's git-repo-watch.ts):
 * `worktree` — status and the row's diff; `refs` — the graph, branches,
 * stashes and worktree list, which every checkout of a repository shares.
 */
export type GitCheckoutChangeKind = 'worktree' | 'refs'

export type GitCheckoutChange = {
  checkoutKey: string
  kinds: GitCheckoutChangeKind[]
  /** `gitdir`: a git file moved; `activity`: an agent's turn ended there; `fallback`: the slow sweep. */
  reason: 'gitdir' | 'activity' | 'fallback'
}

/**
 * Why the cleanup kept an agent worktree, or that it removed it. `recent`: git
 * touched it within the last hour; `ignored-files`: ignored files that are not
 * rebuildable output or unchanged copies; `hidden-edits`: tracked files hidden
 * from `git status` by `--assume-unchanged` or `--skip-worktree`;
 * `not-owned`: an unattended sweep met a worktree this profile never locked.
 */
export type AgentWorktreeCleanupVerdict =
  | 'removed'
  /** A worktree pool slot nobody uses any more, detached and given back to the pool (its branch kept). */
  | 'returned'
  /** A worktree pool slot nobody uses that still holds work; held in the pool for a person to decide. */
  | 'held'
  | 'dirty'
  | 'unmerged'
  | 'in-use'
  | 'locked'
  | 'missing'
  | 'recent'
  | 'ignored-files'
  | 'hidden-edits'
  | 'not-owned'
  | 'no-default-branch'
  | 'error'

export type AgentWorktreeCleanupEntry = {
  path: string
  branch: string | null
  verdict: AgentWorktreeCleanupVerdict
  /** For `unmerged`: commits on the branch that the default branch does not have. */
  uniqueCommits?: number
  /** For `dirty`, `ignored-files` and `hidden-edits`: how many paths kept it. */
  changedPaths?: number
  detail?: string
}

export type AgentWorktreeCleanupInput = {
  repoRoot: string
  /** Paths the app still uses (a workspace's folder, a live agent's worktree). Never removed. */
  protectedPaths: string[]
  /** Report what would happen without removing anything. */
  dryRun?: boolean
  /**
   * Take only worktrees this profile locked and has since released. The
   * unattended sweep sets it; a person's cleanup from the Worktree manager,
   * whose report they read, does not.
   */
  ownedOnly?: boolean
  /**
   * Every agent the app's records hold. A pool slot an agent leased for itself
   * (MCP `worktree.lease`) is in use while its agent exists, wherever the
   * agent's terminal sits. Left out: unknown, and every such slot is kept.
   */
  agentIds?: string[]
  /**
   * The same agents, each with its chat (`agentLeaseKey`): what a lease that
   * records its agent's chat is matched against, since an agent id is unique
   * only within its chat. Left out: unknown, and every such slot is kept.
   */
  agentKeys?: string[]
  /**
   * Branches the app's records still name (a chat's `worktree.branch`, a
   * worktree entry's): never deleted, merged or not, because a chat whose
   * worktree was given back is restored from its branch. Left out: unknown,
   * and no branch is deleted.
   */
  keepBranches?: string[]
}

export type AgentWorktreeCleanupReport = {
  repoRoot: string
  /** The ref "merged" was measured against, e.g. `origin/main`. Null when none could be found. */
  defaultRef: string | null
  entries: AgentWorktreeCleanupEntry[]
  /**
   * `agent/` branches no worktree has checked out whose work is on the default
   * branch: deleted (or, on a dry run, the ones that would be).
   */
  deletedBranches?: string[]
  dryRun: boolean
}

export type GitHubTokenStatus = {
  configured: boolean
  source: 'settings' | 'environment' | 'none'
  encryptionAvailable: boolean
}

export type GitHubRepoSummary = {
  fullName: string
  name: string
  owner: string
  isPrivate: boolean
  description: string | null
  cloneUrl: string
  defaultBranch: string | null
  pushedAt: string | null
}

export type GitHubRepoListResult =
  | { ok: true; repos: GitHubRepoSummary[] }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'network'; message: string }

export type GitHubCloneInput = {
  url: string
  parentDir: string
  folderName: string
}

export type GitHubCloneResult = { ok: true; path: string } | { ok: false; message: string }

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
