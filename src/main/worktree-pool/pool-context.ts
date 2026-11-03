import type { WorktreePoolSettings } from '../../shared/ipc/worktree-pool'
import {
  holdIfIdle,
  WORKTREE_POOL_OWNER,
  type WorktreeBlocked,
  type WorktreeExclusiveOptions,
  type WorktreeHold,
  type WorktreeLeases,
} from '../worktree-leases'
import type { MeasureDiskUsage } from './disk-usage'
import type { PoolRecord, SlotRecord } from './pool-store'
import type { SlotGitRunner } from './slot-git'
import type { WorktreePoolServiceDeps, LeaseBase } from './worktree-pool-service'

/** How much of git's message a note on a slot (or a log line) keeps: its end, where the reason is. */
const NOTE_TAIL_CHARS = 200

export type PoolRuntime = {
  record: PoolRecord
  containerPath: string
  chain: Promise<unknown>
  busy: Set<string>
  instance: 'unknown' | 'held' | 'foreign'
  fetch: Promise<LeaseBase> | null
  /** When the base's last fetch failed, while no fetch has succeeded since. Not persisted. */
  fetchFailedAt: number | null
  /** Recovery, run once this instance holds the pool's container. */
  recovered: Promise<void> | null
  /**
   * Slots the automatic eviction last kept for their ignored files, by the
   * verdict key they were kept under (`keptKey`): not checked again until it
   * changes. Not persisted.
   */
  keptVerdicts: Map<string, string>
}

export type ResolvedRepo = { repoRoot: string; commonDir: string }

/**
 * What the pool's steps share: the service's dependencies, its pools, and the
 * plumbing every step goes through (the pool's mutex, persistence, the
 * instance lock). Built once by `createWorktreePoolService`; each step module
 * (pool-lease.ts, pool-return.ts, pool-eviction.ts, …) takes it first.
 */
export type PoolContext = {
  deps: WorktreePoolServiceDeps
  git: SlotGitRunner
  now: () => number
  log: (line: string) => void
  /** How long one fetch of the base serves every lease that asks. */
  fetchFreshMs: number
  /** How long after a failed fetch leases fork from the ref as it stands without fetching. */
  fetchBackoffMs: number
  measureSize: MeasureDiskUsage
  /** The person's worktree branch prefix, read as each lease or rescue names a branch. */
  branchPrefix: () => string
  /** Write down a branch the pool just made as one Studio made (worktree-branch-ledger.ts). Never throws. */
  recordBranch: (repoRoot: string, branch: string) => Promise<void>
  pools: Map<string, PoolRuntime>
  /** Aborts a disk measurement in progress when quitting begins. */
  stopping: AbortController
  /** Quitting has begun: nothing new starts, and a step going through slots stops between them. */
  readonly stopped: boolean
  /** Counts a step among those quitting waits for. */
  track: <T>(step: Promise<T>) => Promise<T>
  /** Run `work` under the pool's mutex. */
  withPool: <T>(pool: PoolRuntime, work: () => Promise<T> | T) => Promise<T>
  persist: (pool: PoolRuntime, options?: { sizeOnly?: boolean }) => Promise<void>
  slotById: (pool: PoolRuntime, slotId: string) => SlotRecord | undefined
  somethingRunsIn: (path: string) => Promise<boolean>
  /**
   * The process's holds on worktree paths (worktree-leases.ts): a step that
   * changes what is at a slot's path holds it exclusive, through
   * {@link holdIdle}, so a turn or terminal starting there waits for it.
   */
  leases: WorktreeLeases
  getSettings: () => Promise<WorktreePoolSettings>
  resolveRepo: (repoRoot: string) => Promise<ResolvedRepo | null>
  poolFor: (repoRoot: string, create: boolean) => Promise<PoolRuntime | null>
  /** Whether this instance may drive the pool: it holds the container's lock, and the pool has been recovered. */
  ready: (pool: PoolRuntime) => Promise<boolean>
  load: () => Promise<void>
}

/**
 * The exclusive hold on a slot's path for a pool step that changes what is
 * there, once nothing runs in it (worktree-leases.ts `holdIfIdle`), taken as
 * the pool's own. Taken before the pool's mutex, never inside it.
 */
export function holdIdle(
  ctx: PoolContext,
  path: string,
  reason: string,
  options: Omit<WorktreeExclusiveOptions, 'owner'> = {},
): Promise<WorktreeHold | WorktreeBlocked | { live: true }> {
  return holdIfIdle(ctx.leases, path, reason, ctx.deps.livePaths, { ...options, owner: WORKTREE_POOL_OWNER })
}

export function tail(text: string | null | undefined, max = NOTE_TAIL_CHARS): string | null {
  const value = (text ?? '').trim()
  if (!value) return null
  return value.length > max ? `…${value.slice(-max)}` : value
}

export { errorMessage as messageOf } from '../../shared/errors'

/** Why a step that answers `{ ok, message }` failed, or null when it did not. */
export function failureOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== false) return null
  return 'message' in result && typeof result.message === 'string' ? result.message : 'no reason given'
}
