import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, resolve } from 'path'
import type {
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import { comparablePath } from '../../shared/host-paths'
import { LOCAL_HOST_ID } from '../../shared/execution-host'
import { worktreeContainerPath } from '../../shared/worktree-paths'
import { insideAny, pathSpellings } from '../agent-worktree-keep-checks'
import { worktreeBranchLedger, type WorktreeBranchLedger } from '../worktree-branch-ledger'
import { worktreeBranchPrefix } from '../worktree-branch-prefix'
import { measureDiskUsage, type MeasureDiskUsage } from './disk-usage'
import {
  acquireInstanceLock,
  heartbeatInstanceLock,
  normalizePoolSettings,
  POOL_RECORD_VERSION,
  poolIdFor,
  releaseInstanceLock,
  type InstanceLockDeps,
  type PoolRecord,
  type PoolStore,
  type SlotRecord,
} from './pool-store'
import { defaultSlotGitRunner, type SlotGitRunner } from './slot-git'
import { messageOf, type PoolContext, type PoolRuntime, type ResolvedRepo } from './pool-context'
import { clearIgnored, enforceDiskLimit, evictOverLimit, evictSlot, measure } from './pool-eviction'
import { heldAction } from './pool-held-actions'
import { FETCH_FAILURE_BACKOFF_MS, FETCH_FRESH_MS, lease, reclaim } from './pool-lease'
import { recoverPool } from './pool-recovery'
import { release, returnUnused } from './pool-return'

/**
 * The pool of reusable agent worktrees.
 *
 * A fresh worktree costs a checkout and, far more, whatever the agent then
 * spends rebuilding the ignored files a tree needs before its tests pass
 * (`node_modules`, a virtual environment, build caches). The pool keeps the
 * worktrees agents are done with instead of deleting them, and hands one to the
 * next agent after moving it to the default branch. The ignored files survive
 * the move, so the next agent's install is an incremental one, or none.
 *
 * ## What it costs while nobody uses it
 *
 * Nothing but disk (owner ruling 2026-09-24). No refresh, no fetch and no
 * install runs in the background. Every git step happens because someone asked
 * for a worktree (a lease) or a sweep found one nobody uses (a return), and a
 * slot's size is measured only when Settings ▸ Worktrees asks or, with a disk
 * limit set, when the slot comes back. The
 * pool itself never installs dependencies. A project that opted in
 * (Settings ▸ Worktrees) has its install run on the lease, for the chat or
 * agent that asked and before it gets the worktree, when the lockfile changed
 * (dependency-install.ts); otherwise an agent that needs them runs its own
 * install, which on a reused slot finds most of the work already done.
 *
 * ## Life of a slot
 *
 *   creating → leasing → leased                         (no idle slot to reuse)
 *   idle → leasing → leased                             (fetch, reset to base, branch)
 *   leased → returning → idle                           (clean return)
 *   leased → returning → held                           (work left in it)
 *   idle → evicting → gone                              (over the idle, slot or disk limit)
 *
 * A lease always forks from `origin/<default>` as fetched at that moment (at
 * most once a minute per repository, and never waiting longer than
 * LEASE_FETCH_TIMEOUT_MS: offline, it forks from what the ref already says).
 *
 * A slot lives at `<repo-parent>/.sprintengine-worktrees/<repo>/pool-NN` and
 * keeps that path for its whole life: virtual environments and build caches
 * record absolute paths and do not survive a move. A leased slot is on
 * `<prefix>/<slug>` (the person's branch prefix, `agent` unless changed) and
 * locked with the agent worktree lock
 * (agent-worktree-lock.ts), so git's own `prune` and `remove`, another Studio
 * profile's cleanup and the Worktree manager all leave it alone.
 *
 * ## What the pool never does
 *
 * - It never resets a tree that holds work. Every reset is preceded, in the
 *   same step, by a status read of the slot (untracked files included, ignored
 *   ones not); anything reported makes the slot `held`, and a held slot changes
 *   only when a person picks Commit, Stash, Discard or Keep.
 * - It never recycles a slot something runs in: a live terminal inside the slot
 *   postpones the return.
 * - It never deletes an agent's branch. Returning detaches HEAD; the branch and
 *   its commits stay (the agent worktree cleanup deletes the branch once its
 *   work is on the default branch). A detached HEAD holding commits no ref
 *   reaches is first given a branch of its own.
 * - It never recycles a slot mid-merge, mid-rebase or mid-cherry-pick.
 * - It never runs `clean -x`: ignored files (installed dependencies, build
 *   caches, a copied `.env`) are what makes a reused slot worth having. An
 *   ignored file where the new base adds a tracked one holds the slot instead
 *   of being overwritten.
 *
 * ## Concurrency
 *
 * Each pool has one mutex, held only across a state transition and its
 * persistence, never across a git step. A slot in a transitional state is not
 * leasable, so two leases never get one slot, and a lease never gets a slot
 * that is being returned or evicted. A second Studio is kept off the same slots
 * by a lock file in the container (pool-store.ts). The worktree registry itself
 * is changed under worktree-registry-lock.ts.
 *
 * ## Crash recovery
 *
 * A slot's `op` is persisted before each git step and cleared after it. When a
 * pool is first used after a start, a slot found with an `op` is finished or
 * held, per step (see `recoverPool`), and a `pool-NN` worktree with no record is
 * adopted as held, never reset.
 */

const HEARTBEAT_INTERVAL_MS = 5 * 60_000
/**
 * How long quitting waits for the pool's steps in flight (a lease's fetch and
 * reset, a return) before it gives the container's lock up anyway. A step cut
 * short is what crash recovery exists for; a lock given up under a step still
 * running would let another Studio take over and "recover" a slot this one is
 * moving.
 */
const SHUTDOWN_WAIT_MS = 10_000

export type WorktreePoolServiceDeps = {
  store: PoolStore
  git?: SlotGitRunner
  /**
   * Where live work sits — terminals and the checkouts they observe, and the
   * folders chats are working in (`liveWorkPaths`): a slot one is in is never
   * recycled.
   */
  livePaths?: () => string[] | Promise<string[]>
  onChange?: (snapshot: WorktreePoolSnapshot) => void
  log?: (line: string) => void
  now?: () => number
  instanceId?: string
  lockDeps?: InstanceLockDeps
  /** Keep the instance lock's heartbeat running. Off in tests. */
  timers?: boolean
  /** How long one fetch of the base serves every lease that asks. */
  fetchFreshMs?: number
  /** How long after a failed fetch leases fork from the ref as it stands without fetching. */
  fetchBackoffMs?: number
  /** Copies the repository's `.worktreeinclude` set into a slot (git.ts). */
  seedIncludedFiles?: (repoRoot: string, slotPath: string) => Promise<unknown>
  /** How much disk a slot takes (disk-usage.ts). */
  measure?: MeasureDiskUsage
  /**
   * The person's worktree branch prefix (Settings ▸ Worktrees), read on each
   * lease: a lease asked for by name is put on `<prefix>/<name>`. The
   * process's own (`worktree-branch-prefix.ts`) unless given.
   */
  branchPrefix?: () => string
  /**
   * Where a branch the pool makes (a lease's, a held or rescued slot's) is
   * written down as one Studio made: the cleanup deletes a merged branch only
   * when it is there or under `agent/`. The profile's own unless given.
   */
  branchLedger?: Pick<WorktreeBranchLedger, 'record'>
  /**
   * The ids of every chat on record that is not settled (the workspace
   * registry), or null when unknown. A slot holding the history of one of them
   * is never removed (agent-worktree-keep-checks.ts); a settled chat counts
   * as deleted.
   */
  knownWorkspaceIds?: () => Iterable<string> | null
}

export type WorktreePoolLeaseInput = {
  repoRoot: string
  /** The name the branch is derived from, under the person's branch prefix: `<prefix>/<slug>`. */
  name: string
  /**
   * The branch itself, when the caller already named it (`agentWorktreePaths`,
   * through git.ts): taken as it is, so a worktree's branch is the one its
   * caller recorded even if the prefix changed in between.
   */
  branch?: string
  /** Who the slot's lock names: the agent's id, or the branch while there is no agent yet. */
  owner?: string | null
  /** The agent that asked for the worktree itself (MCP), which keeps it while it exists. */
  agentId?: string | null
  /** The chat that agent is in: an agent id is unique only within its chat. */
  workspaceId?: string | null
  /** The machine the worktree is for; the pool serves only this machine's own git. */
  hostId?: string | null
  /** Copy the repository's `.worktreeinclude` set in, as a fresh worktree would. */
  copyIncludedFiles?: boolean
}

/** What a lease forks from, and why it may be behind the remote (the fetch failed, or was skipped after one that did). */
export type LeaseBase = { ref: string; sha: string; note: string | null }

export type WorktreePoolLeaseResult =
  | {
      ok: true
      leaseId: string
      slotId: string
      /** The project's main checkout, as the pool and its settings name it. */
      repoRoot: string
      path: string
      branch: string
      baseRef: string
      baseSha: string
      /** Set when `baseRef` could not be fetched for this lease: it is where the ref last stood. */
      baseNote: string | null
      /** The reason of the agent worktree lock placed on it, or null when locking failed. */
      lockReason: string | null
      /** The slot was made for this lease; nothing was reused. */
      created: boolean
      elapsedMs: number
    }
  | {
      ok: false
      /**
       * Why no slot was handed out. `branch-exists` and `invalid-name` are the
       * caller's to report (a plain worktree would fail the same way); every
       * other reason means the caller creates a worktree the old way.
       */
      reason:
        | 'disabled'
        | 'unsupported'
        | 'other-instance'
        | 'not-a-repo'
        | 'no-base'
        | 'full'
        | 'invalid-name'
        | 'branch-exists'
        | 'error'
      message: string
      /**
       * The base the pool had already resolved (and fetched) when it gave up:
       * the caller's fresh worktree forks from it instead of fetching again.
       */
      base?: LeaseBase
    }

/** What a return sweep did with each leased slot of a repository (merged into the cleanup report). */
export type WorktreePoolSweepEntry = {
  path: string
  branch: string | null
  verdict: 'in-use' | 'unclaimed' | 'returned' | 'held' | 'postponed'
  detail?: string
}

export type WorktreePoolReturnInput = {
  repoRoot: string
  /** Paths the app's records still use: a slot any of them sits in is kept. */
  protectedPaths: readonly string[]
  /**
   * Agents the app's records still hold; a slot one of them leased through MCP
   * is kept. Left out or null: unknown, and every such slot is kept.
   */
  agentIds?: ReadonlySet<string> | null
  /**
   * The same agents with their chats (`agentLeaseKey`), which a lease that
   * records its agent's chat is matched against: a bare id is unique only
   * within a chat, so another chat's `agent-1` must not keep this one's slot.
   * Left out or null: unknown, and every such slot is kept.
   */
  agentKeys?: ReadonlySet<string> | null
  dryRun?: boolean
}

export type WorktreePoolService = ReturnType<typeof createWorktreePoolService>

export function createWorktreePoolService(deps: WorktreePoolServiceDeps) {
  const git = deps.git ?? defaultSlotGitRunner
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.info(`[worktree-pool] ${line}`))
  const instanceId = deps.instanceId ?? randomUUID()
  const fetchFreshMs = deps.fetchFreshMs ?? FETCH_FRESH_MS
  const fetchBackoffMs = deps.fetchBackoffMs ?? FETCH_FAILURE_BACKOFF_MS
  const measureSize = deps.measure ?? measureDiskUsage
  const branchPrefix = deps.branchPrefix ?? worktreeBranchPrefix
  const branchLedger = deps.branchLedger ?? worktreeBranchLedger()
  const pools = new Map<string, PoolRuntime>()
  const resolvedRepos = new Map<string, Promise<ResolvedRepo | null>>()
  let settings: WorktreePoolSettings | null = null
  let loaded: Promise<void> | null = null
  let stopped = false
  /** Aborts a disk measurement in progress when quitting begins. */
  const stopping = new AbortController()
  let heartbeat: NodeJS.Timeout | null = null
  /** Every public step still running, which quitting waits for (`shutdown`). */
  const inFlight = new Set<Promise<unknown>>()

  function track<T>(step: Promise<T>): Promise<T> {
    inFlight.add(step)
    void step.then(
      () => inFlight.delete(step),
      () => inFlight.delete(step),
    )
    return step
  }

  /** What the step modules (pool-lease.ts, pool-return.ts, …) are handed: see {@link PoolContext}. */
  const ctx: PoolContext = {
    deps,
    git,
    now,
    log,
    fetchFreshMs,
    fetchBackoffMs,
    measureSize,
    branchPrefix,
    recordBranch: (repoRoot, branch) => branchLedger.record(repoRoot, branch).catch(() => undefined),
    pools,
    stopping,
    get stopped() {
      return stopped
    },
    track,
    withPool,
    persist,
    slotById,
    somethingRunsIn,
    getSettings,
    resolveRepo,
    poolFor,
    ready,
    load,
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  function withPool<T>(pool: PoolRuntime, work: () => Promise<T> | T): Promise<T> {
    const run = pool.chain.catch(() => {}).then(work)
    pool.chain = run.catch(() => {})
    return run
  }

  /**
   * Write the record, and tell the windows. `sizeOnly`: a measurement, which
   * the window that asked for it reads in its answer; announcing each one
   * would have an open Settings ▸ Worktrees re-read every worktree per slot.
   */
  async function persist(pool: PoolRuntime, options: { sizeOnly?: boolean } = {}): Promise<void> {
    await deps.store.write(pool.record)
    if (!options.sizeOnly) deps.onChange?.(snapshotOf(pool))
  }

  function slotById(pool: PoolRuntime, slotId: string): SlotRecord | undefined {
    return pool.record.slots.find((slot) => slot.id === slotId)
  }

  /**
   * Whether a live terminal or chat works inside `path`. Compared under every
   * spelling (agent-worktree-keep-checks.ts): a terminal opened through a
   * symlink to the container is still in the slot.
   */
  async function somethingRunsIn(path: string): Promise<boolean> {
    const live = ((await deps.livePaths?.()) ?? []).filter(Boolean)
    if (live.length === 0) return false
    const slotSpellings = await pathSpellings(path)
    for (const each of live) if (insideAny(await pathSpellings(each), slotSpellings)) return true
    return false
  }

  async function getSettings(): Promise<WorktreePoolSettings> {
    settings ??= await deps.store.readSettings()
    return settings
  }

  async function resolveRepo(repoRoot: string): Promise<ResolvedRepo | null> {
    const key = comparablePath(repoRoot)
    let pending = resolvedRepos.get(key)
    if (!pending) {
      pending = (async () => {
        const result = await git(repoRoot, [
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-common-dir',
        ])
        if (!result.ok) return null
        const [toplevel, common] = result.stdout.split(/\r?\n/u).map((line) => line.trim())
        if (!toplevel || !common) return null
        const commonDir = isAbsolute(common) ? common : resolve(toplevel, common)
        // The main checkout is the one whose `.git` IS the common dir. A bare
        // repository has no main checkout to hang a container off.
        if (basename(commonDir) !== '.git') return null
        return { repoRoot: dirname(commonDir), commonDir }
      })()
      resolvedRepos.set(key, pending)
      void pending.then((value) => {
        if (!value) resolvedRepos.delete(key)
      })
    }
    return pending
  }

  function runtimeFor(record: PoolRecord): PoolRuntime {
    let pool = pools.get(record.poolId)
    if (!pool) {
      pool = {
        record,
        containerPath: worktreeContainerPath(record.repoRoot),
        chain: Promise.resolve(),
        busy: new Set(),
        instance: 'unknown',
        fetch: null,
        fetchFailedAt: null,
        recovered: null,
        keptVerdicts: new Map(),
      }
      pools.set(record.poolId, pool)
    }
    return pool
  }

  async function poolFor(repoRoot: string, create: boolean): Promise<PoolRuntime | null> {
    await load()
    const repo = await resolveRepo(repoRoot)
    if (!repo) return null
    const poolId = poolIdFor(repo.commonDir, LOCAL_HOST_ID)
    const existing = pools.get(poolId)
    if (existing) return existing
    if (!create) return null
    const record: PoolRecord = {
      version: POOL_RECORD_VERSION,
      poolId,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
      hostId: LOCAL_HOST_ID,
      defaultRef: null,
      lastFetchAt: null,
      lastLeaseAt: null,
      createdAt: now(),
      slots: [],
      releasedPaths: [],
    }
    const pool = runtimeFor(record)
    await persist(pool)
    return pool
  }

  async function holdInstance(pool: PoolRuntime): Promise<boolean> {
    // Held means held NOW: the lock file is read (and touched) on every use, so
    // an instance that lost it — deleted by hand, taken over by a Studio that
    // judged it stale — stops driving the pool at its next step instead of
    // acting on slots someone else now owns. Recovery runs again if it wins the
    // lock back, since the other holder may have moved every slot meanwhile.
    if (pool.instance === 'held') {
      const beat = await heartbeatInstanceLock(pool.containerPath, instanceId).catch(() => 'unknown' as const)
      if (beat !== 'lost') return true
      log(`${pool.record.repoRoot}: lost the pool's lock`)
      pool.instance = 'unknown'
      pool.recovered = null
    }
    const result = await acquireInstanceLock(pool.containerPath, instanceId, deps.lockDeps).catch(() => ({
      ok: false as const,
      holder: 'unreadable lock',
    }))
    pool.instance = result.ok ? 'held' : 'foreign'
    if (!result.ok) log(`${pool.record.repoRoot}: pool held by another Studio (${result.holder})`)
    else startHeartbeat()
    return result.ok
  }

  /**
   * Whether this instance may drive the pool: it holds the container's lock,
   * and the pool has been recovered. Recovery runs only under the lock — a
   * second Studio must never "recover" slots the first one is using.
   */
  async function ready(pool: PoolRuntime): Promise<boolean> {
    if (stopped) return false
    if (!(await holdInstance(pool))) return false
    if (!pool.recovered) {
      const recovering: Promise<void> = recoverPool(ctx, pool).catch((error: unknown) => {
        log(`${pool.record.repoRoot}: recovery failed: ${messageOf(error)}; it is tried again at the next use`)
        // Not remembered as done: a dead run's slots would stay as it left them.
        if (pool.recovered === recovering) pool.recovered = null
      })
      pool.recovered = recovering
    }
    await pool.recovered
    return true
  }

  /**
   * The instance lock's heartbeat: one touch of one file every few minutes
   * while this instance holds a pool, so a Studio on another machine sharing
   * the container never judges it stale. No git runs on it.
   */
  function startHeartbeat(): void {
    if (heartbeat || stopped || deps.timers === false) return
    heartbeat = setInterval(() => {
      for (const pool of pools.values()) {
        if (pool.instance === 'held') void holdInstance(pool)
      }
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref?.()
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  function snapshotOf(pool: PoolRuntime): WorktreePoolSnapshot {
    const record = pool.record
    return {
      poolId: record.poolId,
      repoRoot: record.repoRoot,
      containerPath: pool.containerPath,
      heldByOtherInstance: pool.instance === 'foreign',
      defaultRef: record.defaultRef,
      lastFetchAt: record.lastFetchAt,
      slots: record.slots.map((slot) => ({
        id: slot.id,
        path: slot.path,
        state: slot.state,
        baseRef: slot.baseRef,
        baseSha: slot.baseSha,
        error: slot.error,
        lease: slot.lease
          ? {
              leaseId: slot.lease.leaseId,
              branch: slot.lease.branch,
              owner: slot.lease.owner,
              agentId: slot.lease.agentId,
              workspaceId: slot.lease.workspaceId,
              leasedAt: slot.lease.leasedAt,
            }
          : null,
        held: slot.held ? { ...slot.held } : null,
        lastUsedAt: slot.lastUsedAt,
        uses: slot.uses,
        lastBranch: slot.lastBranch,
        size: slot.size,
        kept: slot.kept,
      })),
    }
  }

  // ── Public surface ───────────────────────────────────────────────────────

  function load(): Promise<void> {
    loaded ??= (async () => {
      for (const { poolId, record } of await deps.store.readAll()) {
        if (!record || record.poolId !== poolId) {
          log(`pool ${poolId}: record unreadable; its slots are adopted as held on next use`)
          continue
        }
        runtimeFor(record)
      }
    })()
    return loaded
  }

  async function snapshot(repoRoot: string): Promise<WorktreePoolSnapshot | null> {
    const pool = await poolFor(repoRoot, false)
    return pool ? snapshotOf(pool) : null
  }

  async function action(input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> {
    if (input.kind === 'release') return releaseAction(input.leaseId)
    const pool = await poolFor(input.repoRoot, false)
    if (!pool) return { ok: false, message: 'This repository has no worktree pool.' }
    if (!(await ready(pool))) return { ok: false, message: 'Another Studio is using this pool.' }
    const slot = slotById(pool, input.slotId)
    if (!slot) return { ok: false, message: 'No such worktree in the pool.' }
    if (input.kind === 'evict') {
      const evicted = await evictSlot(ctx, pool, slot, 'by request')
      return evicted === true ? { ok: true, message: 'Removed.' } : { ok: false, message: evicted }
    }
    if (input.kind === 'clear-ignored') return clearIgnored(ctx, pool, slot)
    return heldAction(ctx, pool, slot, input.action, input.message)
  }

  /** A lease given back by the window that took it, whose chat went before it landed. */
  async function releaseAction(leaseId: string): Promise<WorktreePoolActionResult> {
    const outcome = await release(ctx, leaseId)
    if (outcome === 'returned') return { ok: true, message: 'Returned to the pool.' }
    if (outcome === 'held') return { ok: true, message: 'Held: it has changes a person should look at.' }
    if (outcome === 'not-found') return { ok: false, message: 'No such lease.' }
    if (outcome === 'busy') return { ok: false, message: 'Another Studio is using this pool.' }
    return { ok: false, message: 'Something is still running in it; the next sweep returns it.' }
  }

  /** The lease an agent took through MCP, by the slot path it was given. */
  function leaseAt(
    path: string,
  ): { leaseId: string; agentId: string | null; workspaceId: string | null; branch: string } | null {
    for (const pool of pools.values()) {
      const slot = pool.record.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(path))
      if (slot?.lease) {
        const { leaseId, agentId, workspaceId, branch } = slot.lease
        return { leaseId, agentId, workspaceId, branch }
      }
    }
    return null
  }

  async function updateSettings(patch: Partial<WorktreePoolSettings>): Promise<WorktreePoolSettings> {
    const next = normalizePoolSettings({ ...(await getSettings()), ...patch })
    settings = next
    await deps.store.writeSettings(next)
    // A lower limit takes effect now, and the caller (Settings) sees the pools
    // it leaves behind.
    for (const pool of pools.values()) {
      if (pool.instance === 'held' && (await ready(pool))) await evictOverLimit(ctx, pool)
    }
    await enforceDiskLimit(ctx)
    return next
  }

  /** Whether a path is one of the pool's slots (the agent worktree cleanup hands those to the pool). */
  function ownsPath(path: string): boolean {
    for (const pool of pools.values()) {
      if (pool.record.slots.some((slot) => comparablePath(slot.path) === comparablePath(path))) return true
    }
    return false
  }

  /**
   * Stop, wait up to `waitMs` (ten seconds unless the caller is short of time)
   * for the steps in flight, and give each pool's lock up.
   */
  async function shutdown(options: { waitMs?: number } = {}): Promise<void> {
    stopped = true
    stopping.abort()
    if (heartbeat) clearInterval(heartbeat)
    // Nothing new starts now (`ready` refuses); what already runs is waited
    // for, briefly, before the lock that keeps another Studio off it goes.
    // Until none is left, not just the ones running now: a recovery already
    // under way when quitting began still schedules its slot moves (`track`).
    if (inFlight.size > 0) {
      let timer: NodeJS.Timeout | null = null
      let timedOut = false
      const deadline = new Promise<void>((resolveWait) => {
        timer = setTimeout(() => {
          timedOut = true
          resolveWait()
        }, options.waitMs ?? SHUTDOWN_WAIT_MS)
        timer.unref?.()
      })
      while (inFlight.size > 0 && !timedOut) await Promise.race([Promise.allSettled([...inFlight]), deadline])
      if (timer) clearTimeout(timer)
    }
    for (const pool of pools.values()) {
      await pool.chain.catch(() => {})
      if (pool.instance === 'held') await releaseInstanceLock(pool.containerPath, instanceId)
    }
  }

  return {
    /** Read the records. Recovery waits for each pool's first use: nothing runs at start. */
    load,
    lease: (input: WorktreePoolLeaseInput) => track(lease(ctx, input)),
    reclaim: (input: Parameters<typeof reclaim>[1]) => track(reclaim(ctx, input)),
    release: (leaseId: string) => track(release(ctx, leaseId)),
    returnUnused: (input: WorktreePoolReturnInput) => track(returnUnused(ctx, input)),
    leaseAt,
    action: (input: WorktreePoolActionInput) => track(action(input)),
    snapshot,
    snapshots: async () => {
      await load()
      return [...pools.values()].map(snapshotOf)
    },
    getSettings,
    updateSettings: (patch: Partial<WorktreePoolSettings>) => track(updateSettings(patch)),
    measure: (repoRoot?: string) => track(measure(ctx, repoRoot)),
    ownsPath,
    shutdown,
  }
}
