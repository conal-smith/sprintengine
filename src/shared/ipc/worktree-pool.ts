// Part of the IPC contract: the pool of reusable agent worktrees.
// ../electron-api.ts re-exports everything here.
//
// Main owns every pool (src/main/worktree-pool/). A window only ever sees the
// snapshots below and asks for a held-slot action; it never runs a git command
// against a slot itself. Leases are not asked for here: an agent worktree
// created with `fromPool` (GitWorktreeCreateInput) comes from the pool.

import { comparablePath } from '../host-paths'

/**
 * Where a slot is in its life:
 *
 * - `creating`: `worktree add` is running for it.
 * - `idle`: detached, clean, unlocked, ready to lease. It sits at whatever base
 *   it was last leased at; the lease brings it up to date.
 * - `leasing`: being fetched up, reset and handed to an agent (a moment).
 * - `leased`: an agent owns it, on `agent/<slug>`, locked.
 * - `returning`: its owner is gone and it is being checked for work.
 * - `held`: it holds work (or could not be checked) and waits for a person.
 * - `evicting`: being removed from disk.
 */
export type WorktreePoolSlotState = 'creating' | 'idle' | 'leasing' | 'leased' | 'returning' | 'held' | 'evicting'

/**
 * Why a slot is held:
 * - `dirty`: uncommitted or untracked changes.
 * - `operation`: a merge, rebase, cherry-pick, revert or bisect is in progress.
 * - `unexpected-head`: an idle slot is on a branch, or moved off its base.
 * - `recovery`: the app stopped in the middle of an operation that cannot be
 *   safely re-run, or found a slot it had no record of.
 * - `error`: a git step failed; the detail says which.
 */
export type WorktreePoolHeldReason = 'dirty' | 'operation' | 'unexpected-head' | 'recovery' | 'error'

export type WorktreePoolSettings = {
  /** Agent worktrees come from the pool. Off: every one is created fresh and removed by the cleanup. */
  enabled: boolean
  /** Idle worktrees each repository keeps for reuse; a return beyond this removes the oldest. */
  keepIdle: number
  /**
   * Worktrees one repository's pool may hold in all, leased ones included.
   * Past it a new chat still gets a worktree, but a fresh one the cleanup
   * removes when the chat is done.
   */
  maxSlots: number
  /**
   * Disk every pool together may use, in gigabytes, or null for no limit.
   * Past it the least recently used idle worktrees are removed; one in use or
   * holding work never is. Sizes are measured only while a limit is set, or
   * when Settings ▸ Worktrees asks.
   */
  diskLimitGb: number | null
  /**
   * Per project, keyed by its main checkout's path as the pool names it: run
   * the dependency install in a leased worktree when its lockfile changed
   * since that worktree last installed (owner ruling 2026-10-06). A project
   * with no entry is off: the install runs the repository's own scripts.
   */
  dependencyInstall: Record<string, WorktreeDependencyInstallSetting>
}

export type WorktreeDependencyInstallSetting = {
  enabled: boolean
  /** Run instead of the command the lockfile implies (`npm ci`, …); null to infer it. */
  command: string | null
}

/** The longest install command kept; anything longer is a paste gone wrong. */
export const WORKTREE_INSTALL_COMMAND_MAX = 1_000

export const WORKTREE_POOL_KEEP_IDLE_MAX = 6
export const WORKTREE_POOL_MAX_SLOTS_MIN = 2
/** The hard ceiling `maxSlots` is clamped to. */
export const WORKTREE_POOL_MAX_SLOTS_CEILING = 32
export const WORKTREE_POOL_DISK_LIMIT_CHOICES_GB = [10, 20, 30, 50, 100, 200] as const
export const DEFAULT_WORKTREE_POOL_SETTINGS: WorktreePoolSettings = {
  enabled: true,
  keepIdle: 3,
  maxSlots: 12,
  diskLimitGb: null,
  dependencyInstall: {},
}

/** The entry `settings.dependencyInstall` holds for a project, however its path is spelled. */
export function dependencyInstallSettingFor(
  settings: Pick<WorktreePoolSettings, 'dependencyInstall'>,
  repoRoot: string,
): WorktreeDependencyInstallSetting | null {
  const wanted = comparablePath(repoRoot)
  for (const [root, setting] of Object.entries(settings.dependencyInstall ?? {})) {
    if (comparablePath(root) === wanted) return setting
  }
  return null
}

/**
 * How much disk a worktree takes, as allocated on disk (`du`), with the
 * biggest entries at its top level (`node_modules`, `out`, …) so a person can
 * see what the space is. Measured on request, never on a timer.
 */
export type WorktreeDiskUsage = {
  bytes: number
  measuredAt: number
  /** The largest top-level entries, largest first; the rest are summed as `…`. */
  parts: Array<{ name: string; bytes: number }>
}

export type WorktreePoolSlotView = {
  id: string
  path: string
  state: WorktreePoolSlotState
  baseRef: string | null
  baseSha: string | null
  /** The tail of a failed git step. */
  error: string | null
  lease: {
    leaseId: string
    branch: string
    owner: string
    /** The agent that leased it itself through MCP (`worktree.lease`); null for a chat's own worktree. */
    agentId: string | null
    /** The chat that agent is in; null for a chat's own worktree and a lease taken before chats were recorded. */
    workspaceId: string | null
    leasedAt: number
  } | null
  held: {
    reason: WorktreePoolHeldReason
    detail: string | null
    changedPaths: number | null
    branch: string | null
    since: number
  } | null
  lastUsedAt: number | null
  /** How many leases the slot has served. */
  uses: number
  /** The branch of its last lease, kept after the slot came back. */
  lastBranch: string | null
  /** As last measured; null until something asked. */
  size: WorktreeDiskUsage | null
  /**
   * Why the pool did not remove this idle slot when it last tried (over the
   * idle or disk limit, or asked to), as a phrase that follows "kept:":
   * `has ignored files that may be someone’s work: .env`. Null when nothing
   * kept it.
   */
  kept: string | null
}

export type WorktreePoolSnapshot = {
  poolId: string
  repoRoot: string
  /** Where the slots live: `<repo-parent>/.sprintengine-worktrees/<repo>`. */
  containerPath: string
  /** Another Studio holds this pool; this one creates worktrees fresh. */
  heldByOtherInstance: boolean
  defaultRef: string | null
  lastFetchAt: number | null
  slots: WorktreePoolSlotView[]
}

/**
 * An agent as a pool lease names it: its chat and its id together. Agent ids
 * are unique only within a chat (older chats each have an `agent-1`), so a
 * bare id says nothing about whose lease a slot is.
 */
export function agentLeaseKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`
}

export type WorktreePoolHeldAction = 'commit' | 'stash' | 'discard' | 'keep'

export type WorktreePoolActionInput =
  | { kind: 'held'; repoRoot: string; slotId: string; action: WorktreePoolHeldAction; message?: string }
  | { kind: 'evict'; repoRoot: string; slotId: string }
  /** Delete an idle slot's ignored files (`git clean -dX`): the space, at the price of the next install. */
  | { kind: 'clear-ignored'; repoRoot: string; slotId: string }
  /**
   * Give a lease back at once: a New chat that was closed while its worktree
   * was being made has no one to use the slot (utils/newChatWorktree.ts).
   * The same return a sweep makes, so a slot with changes is held, not reset.
   */
  | { kind: 'release'; leaseId: string }

export type WorktreePoolActionResult = { ok: true; message: string | null } | { ok: false; message: string }

// ── Dependency installs ─────────────────────────────────────────────────────
//
// A leased worktree whose project opted in installs its dependencies before
// its agent starts (worktree-pool/dependency-install.ts). Windows are sent
// `worktree-install:changed` as one starts, now and then while it runs, and
// as it ends; nothing else about it is kept.

/**
 * Why it runs: the worktree never installed (`first`), its lockfile or the
 * command changed since it last did (`changed`), or its installed
 * dependencies are gone (`missing`, after "Clear ignored files").
 */
export type WorktreeDependencyInstallReason = 'first' | 'changed' | 'missing'

export type WorktreeDependencyInstallState = 'running' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled'

export type WorktreeDependencyInstallView = {
  id: string
  /** The project's main checkout, as the pool names it. */
  repoRoot: string
  /** The leased worktree it runs in. */
  path: string
  branch: string
  command: string
  reason: WorktreeDependencyInstallReason
  state: WorktreeDependencyInstallState
  startedAt: number
  endedAt: number | null
  /** The last line it printed. */
  lastLine: string | null
  /** The end of what it printed, once it did not succeed. */
  output: string | null
  exitCode: number | null
  /** Its caller shows it (`GitWorktreeCreateInput.quietInstall`): no toast while it runs or once it succeeds. */
  quiet?: boolean
}

// ── Settings ▸ Worktrees ────────────────────────────────────────────────────

/** One git worktree of a project, as Settings ▸ Worktrees lists it. The main checkout is never one. */
export type WorktreeInventoryEntry = {
  path: string
  branch: string | null
  head: string | null
  /** The pool slot at this path; null for a worktree the pool does not own. */
  slotId: string | null
  /** Locked by hand or by another Studio profile (not the pool's or this profile's agent lock). */
  lockedByOther: boolean
  /** Registered with git but gone from disk: `git worktree prune` forgets it. */
  missing: boolean
  /** Commits on it the default branch lacks, or null when unknown (no default branch, git failed). */
  uniqueCommits: number | null
  /** Commits on the default branch it lacks. */
  behindCommits: number | null
  /** Every change on it is on the default branch already (by ancestry, or by content after a squash merge). */
  merged: boolean | null
  /** Uncommitted and untracked paths, ignored ones aside; null when status failed. */
  changedPaths: number | null
  /** The first few of those, as `git status --short` codes and paths. */
  changes: Array<{ code: string; path: string }>
  size: WorktreeDiskUsage | null
  /**
   * When it was last used, in ms since the epoch: its index or HEAD moved
   * (a stage, commit or checkout in it), or, for a pool slot, its last lease.
   * Null when unknown.
   */
  lastUsedAt: number | null
}

export type WorktreeInventoryProject = {
  /** The main checkout. */
  repoRoot: string
  defaultRef: string | null
  pool: WorktreePoolSnapshot | null
  worktrees: WorktreeInventoryEntry[]
  error: string | null
}

export type WorktreeInventoryInput = {
  /** Projects the window knows of; pools on record are added to them. */
  repoRoots: string[]
  /** Measure every worktree's size now (slow: seconds per worktree), instead of reporting the last one. */
  measure?: boolean
}

export type WorktreeInventory = {
  projects: WorktreeInventoryProject[]
  /** When sizes were last measured, or null if never. */
  measuredAt: number | null
}
