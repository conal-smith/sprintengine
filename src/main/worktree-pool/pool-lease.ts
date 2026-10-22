import { randomUUID } from 'crypto'
import { comparablePath } from '../../shared/host-paths'
import { hostIdForFolder, isWslHostId, normalizeExecutionHostId } from '../../shared/execution-host'
import { pathJoin } from '../../shared/paths'
import { worktreeBranchName } from '../../shared/worktree-branch'
import { slugifyWorktreeName } from '../../shared/worktree-paths'
import { poolSlotName, poolSlotNumber, poolSlotStemForContainer } from '../../shared/worktree-pool-slot-name'
import { agentWorktreeLockReason, lockAgentWorktree } from '../agent-worktree-lock'
import { hiddenEditPaths } from '../agent-worktree-keep-checks'
import { pathExists } from '../git-utils'
import { GIT_NETWORK_TIMEOUT_MS } from '../git-run'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import { isNetworkSharePath, type SlotRecord } from './pool-store'
import {
  branchBlockedBy,
  branchBlockedMessage,
  branchShadowing,
  amongIgnored,
  cleanWouldRemove,
  clearStaleIndexLock,
  commitIsReachable,
  fetchBase,
  hasFile,
  ignoredPaths,
  ignoredFilesInTheWay,
  parallelCheckoutConfig,
  operationInProgress,
  pathsBetween,
  readSlotGitDir,
  readSlotStatus,
  resolvePoolBaseRef,
  revParseCommit,
  usesLfs,
  writeSlotMarker,
} from './slot-git'
import { type PoolContext, type PoolRuntime, tail, messageOf, failureOf } from './pool-context'
import type { LeaseBase, WorktreePoolLeaseInput, WorktreePoolLeaseResult } from './worktree-pool-service'
import { hold, holdAfterFailure, forgetSlotsGoneFromDisk, reservationAt } from './pool-slot-steps'
import { findLease } from './pool-return'
import { makeRoom } from './pool-idle'

/** Leasing a slot (worktree-pool-service.ts): the base it forks from, the reset that moves it there, and the lease itself. */

/**
 * The most slots a pool may ever have, leased ones included, whatever the
 * `maxSlots` setting says; past the setting a lease falls back to a plain
 * worktree.
 */
export const POOL_MAX_SLOTS = 32

/** `<project>-01` … `<project>-999`: past that a container holds something other than slots, and no name is picked. */
const SLOT_NUMBER_LIMIT = 1000

export const FETCH_FRESH_MS = 60_000
/**
 * How long after a failed fetch of the base leases go ahead without trying
 * again: offline, each try would hold a new chat up for the fetch's whole
 * deadline (LEASE_FETCH_TIMEOUT_MS).
 */
export const FETCH_FAILURE_BACKOFF_MS = 5 * 60_000

/**
 * Why a repository's worktree cannot come from a pool on this machine, or
 * null when it can. Any WSL machine is declined — its worktrees are made by
 * its own git (`withGitHost`) — and so is a network share.
 */
function unsupportedHost(repoRoot: string, named: string | null | undefined): string | null {
  if (isWslHostId(normalizeExecutionHostId(named)) || isWslHostId(hostIdForFolder(repoRoot))) {
    return 'Worktrees on a WSL machine are made by that machine’s git; it has no pool.'
  }
  if (isNetworkSharePath(repoRoot)) return 'Repositories on a network share do not have a worktree pool.'
  return null
}

// ── Fetching the base ────────────────────────────────────────────────────

/**
 * The commit a lease forks from: `origin/<default>` after at most one fetch
 * per pool per minute, shared by every lease that asks meanwhile. A failed
 * or slow fetch (offline, no credentials) falls back to what
 * `origin/<default>` already says, which is still the default branch, and
 * is not tried again for {@link FETCH_FAILURE_BACKOFF_MS}: offline, every
 * new chat would otherwise wait out the fetch's whole deadline. The base
 * then carries a note saying it may be behind the remote.
 *
 * `local` is where the ref stands before the fetch ({@link localBase}): a
 * lease prepares its slot there while the fetch runs. Never rejects: a fetch
 * that throws is a base at `local`, with the reason as its note.
 */
function ensureBase(ctx: PoolContext, pool: PoolRuntime, local: { ref: string; sha: string }): Promise<LeaseBase> {
  if (pool.fetch) return pool.fetch
  const run = (async (): Promise<LeaseBase> => {
    const record = pool.record
    const ref = local.ref
    let note: string | null = null
    const stale = !record.lastFetchAt || ctx.now() - record.lastFetchAt >= ctx.fetchFreshMs
    const backingOff = pool.fetchFailedAt !== null && ctx.now() - pool.fetchFailedAt < ctx.fetchBackoffMs
    if (ref.includes('/') && stale && backingOff) {
      note = `${ref} was not fetched (the last fetch failed); forked from where it last stood`
    } else if (ref.includes('/') && stale) {
      const fetched = await fetchBase(ctx.git, record.repoRoot, ref)
      if (!fetched.ok) {
        ctx.log(`${record.repoRoot}: fetch of ${ref} failed (${tail(fetched.message)}); using the ref as it is`)
        note = `${ref} could not be fetched (${tail(fetched.message) ?? 'no reason given'}); forked from where it last stood`
      }
      pool.fetchFailedAt = fetched.ok ? null : ctx.now()
      await ctx.withPool(pool, async () => {
        if (fetched.ok) record.lastFetchAt = ctx.now()
        record.defaultRef = ref
        await ctx.persist(pool)
      })
    } else if (record.defaultRef !== ref) {
      await ctx.withPool(pool, async () => {
        record.defaultRef = ref
        await ctx.persist(pool)
      })
    }
    const sha = await revParseCommit(ctx.git, record.repoRoot, ref)
    return sha ? { ref, sha, note } : { ...local, note: note ?? `${ref} could not be read after the fetch` }
  })().catch((error: unknown): LeaseBase => ({
    ...local,
    note: `${local.ref} could not be fetched (${messageOf(error)}); forked from where it last stood`,
  }))
  pool.fetch = run
  void run.then(() => {
    if (pool.fetch === run) pool.fetch = null
  })
  return run
}

/** `origin/<default>` (else the local default branch) and the commit it names now, before any fetch. */
async function localBase(ctx: PoolContext, pool: PoolRuntime): Promise<{ ref: string; sha: string } | null> {
  const ref = (await resolvePoolBaseRef(ctx.git, pool.record.repoRoot)) ?? pool.record.defaultRef
  if (!ref) return null
  const sha = await revParseCommit(ctx.git, pool.record.repoRoot, ref)
  return sha ? { ref, sha } : null
}

// ── Resetting ────────────────────────────────────────────────────────────

/**
 * Move a clean, detached slot to `target`. The reset is the one destructive
 * step in the pool, so it is fenced three ways: the slot must read clean and
 * detached immediately before it; HEAD is moved with a compare-and-swap
 * against the commit that read saw (`update-ref <new> <old>`), so anything
 * that moved HEAD in between makes it fail; and only then are the index and
 * tree brought along (`read-tree --reset -u`) and the untracked leftovers of
 * the old tree removed (`clean -fd`, never `-x`).
 *
 * True when the slot now sits at `target`; false when it was held instead.
 * The caller has marked the slot busy.
 */
async function resetSlot(ctx: PoolContext, pool: PoolRuntime, slot: SlotRecord, target: string): Promise<boolean> {
  const gitDir = await readSlotGitDir(ctx.git, slot.path)
  if (!gitDir) {
    await hold(ctx, pool, slot, 'error', 'the slot is no longer a git worktree')
    return false
  }
  // A reset op still on the slot is a previous run's, cut short (recovery
  // leaves it for exactly this): the `index.lock` in the slot is that dead
  // run's own, whatever its age.
  const resumingOwnReset = slot.op?.kind === 'reset'
  const lockVerdict = await clearStaleIndexLock(
    gitDir,
    !(await ctx.somethingRunsIn(slot.path)),
    ctx.now(),
    resumingOwnReset,
  )
  if (lockVerdict === 'busy') {
    await hold(ctx, pool, slot, 'error', 'git is busy in this worktree (index.lock)')
    return false
  }
  const operation = await operationInProgress(gitDir)
  if (operation) {
    await hold(ctx, pool, slot, 'operation', `a ${operation} is in progress`)
    return false
  }
  const status = await readSlotStatus(ctx.git, slot.path)
  if (!status.ok) {
    await hold(ctx, pool, slot, 'error', `status failed: ${status.message}`)
    return false
  }
  const { oid, branch, changedPaths, trackedPaths, untracked } = status.status
  if (branch !== null) {
    await hold(ctx, pool, slot, 'unexpected-head', `an idle slot is on ${branch}`, { branch })
    return false
  }
  // A reset the previous run of the app started and did not finish leaves
  // the tree half-moved, which reads as dirty. That dirt is the pool's own,
  // and only then, with HEAD at one end of that very reset, is the reset
  // re-run over it…
  const previous = resumingOwnReset ? slot.op : null
  let resuming =
    previous !== null &&
    Boolean(previous?.toSha && previous?.fromSha) &&
    oid !== null &&
    (oid === previous?.toSha || oid === previous?.fromSha)
  // …and only when every change in the tree is one that reset makes: no
  // untracked file (a reset leaves none behind until `clean`), and no tracked
  // path outside the two commits' difference. Anything else was written by
  // someone while the app was down.
  if (resuming && changedPaths > 0) {
    const between = await pathsBetween(ctx.git, slot.path, previous!.fromSha!, previous!.toSha!)
    resuming = untracked === 0 && between !== null && trackedPaths.every((path) => between.has(path))
  }
  if (changedPaths > 0 && !resuming) {
    await hold(ctx, pool, slot, 'dirty', 'changes appeared in an idle slot', { changedPaths })
    return false
  }
  if (!resuming && slot.baseSha && oid !== slot.baseSha) {
    await hold(ctx, pool, slot, 'unexpected-head', 'an idle slot moved off the commit it was left at')
    return false
  }
  // Tracked files hidden from `status` (`--assume-unchanged`,
  // `--skip-worktree`) are overwritten by the reset without a word.
  const hidden = await hiddenEditPaths(slot.path, ctx.git)
  if (!hidden.ok || hidden.paths.length > 0) {
    await hold(
      ctx,
      pool,
      slot,
      'dirty',
      hidden.ok ? `edits hidden from git status: ${hidden.paths.slice(0, 5).join(', ')}` : hidden.message,
      { changedPaths: hidden.ok ? hidden.paths.length : null },
    )
    return false
  }
  const from = resuming && previous?.fromSha ? previous.fromSha : oid
  if (oid === target && !resuming) return true
  if (from !== target && from !== null) {
    // Ignored files where the new base adds tracked ones would be
    // overwritten silently by the reset; they are nobody's to lose.
    const inTheWay = await ignoredFilesInTheWay(ctx.git, slot.path, from, target)
    if (inTheWay === null || inTheWay.length > 0) {
      await hold(
        ctx,
        pool,
        slot,
        'dirty',
        inTheWay === null
          ? 'could not check for ignored files the reset would overwrite'
          : `ignored files the reset would overwrite: ${inTheWay.slice(0, 5).join(', ')}`,
        { changedPaths: inTheWay?.length ?? null },
      )
      return false
    }
  }
  // The ignored files as the tree stands before the move. A file whose
  // ignore rule the new base drops (an `.env.local` the old `.gitignore`
  // named) turns untracked with the move, and `clean -fd` below would
  // delete it as if it were the old tree's leftovers.
  const ignoredBefore = await ignoredPaths(ctx.git, slot.path)
  if (ignoredBefore === null) {
    await hold(ctx, pool, slot, 'error', 'could not list its ignored files before the reset')
    return false
  }
  await ctx.withPool(pool, async () => {
    slot.op = { kind: 'reset', startedAt: ctx.now(), pid: process.pid, fromSha: from, toSha: target }
    await ctx.persist(pool)
  })
  if (oid !== target) {
    const moved = await ctx.git(slot.path, [
      'update-ref',
      '--no-deref',
      '-m',
      'worktree pool: reset',
      'HEAD',
      target,
      oid ?? '',
    ])
    if (!moved.ok) {
      await hold(ctx, pool, slot, 'unexpected-head', `HEAD moved during the reset: ${tail(moved.message)}`)
      return false
    }
  }
  const reset = await ctx.git(slot.path, [
    ...(await parallelCheckoutConfig(ctx.git, pool.record.repoRoot)),
    'read-tree',
    '--reset',
    '-u',
    'HEAD',
  ])
  if (!reset.ok) {
    await hold(ctx, pool, slot, 'error', `reset failed: ${tail(reset.message)}`)
    return false
  }
  const removable = await cleanWouldRemove(ctx.git, slot.path)
  const wasIgnored = removable?.filter((path) => amongIgnored(path, ignoredBefore)) ?? null
  if (wasIgnored === null || wasIgnored.length > 0) {
    await hold(
      ctx,
      pool,
      slot,
      'dirty',
      wasIgnored === null
        ? 'could not check what cleaning up after the reset would remove'
        : `files the new base no longer ignores, which cleaning up would delete: ${wasIgnored.slice(0, 5).join(', ')}`,
      { changedPaths: wasIgnored?.length ?? null },
    )
    return false
  }
  const cleaned = await ctx.git(slot.path, ['clean', '-fd', '--quiet'])
  if (!cleaned.ok) {
    await hold(ctx, pool, slot, 'error', `clean failed: ${tail(cleaned.message)}`)
    return false
  }
  return true
}

/**
 * {@link resetSlot} for a lease in progress: the slot is recorded at
 * `target` once it is there, so a second move (the fetch moved the ref on)
 * checks it against where it now is, and its op is the lease's again.
 */
async function moveSlot(ctx: PoolContext, pool: PoolRuntime, slot: SlotRecord, target: string): Promise<boolean> {
  if (!(await resetSlot(ctx, pool, slot, target))) return false
  await ctx.withPool(pool, async () => {
    slot.baseSha = target
    slot.op = { kind: 'lease', startedAt: ctx.now(), pid: process.pid }
    await ctx.persist(pool)
  })
  return true
}

// ── Leasing ──────────────────────────────────────────────────────────────

async function nextSlotPath(pool: PoolRuntime): Promise<{ id: string; path: string } | null> {
  // Named after the project (shared/worktree-pool-slot-name.ts). A number a
  // slot already has under the old `pool-NN` spelling is taken too: one pool
  // counts once, so `multicode-03` is never made beside a live `pool-03`.
  const stem = poolSlotStemForContainer(pool.containerPath)
  const taken = new Set(pool.record.slots.map((slot) => slot.id))
  const takenNumbers = new Set(
    pool.record.slots.map((slot) => poolSlotNumber(slot.id, stem)).filter((n): n is number => n !== null),
  )
  // A path kept for a chat whose parked slot was removed is that chat's to
  // come back to (`reclaim`): a new slot there would be someone else's.
  const released = new Set(
    [...pool.record.releasedPaths, ...pool.record.reservedPaths.map((entry) => entry.path)].map(comparablePath),
  )
  for (let n = 1; n < SLOT_NUMBER_LIMIT; n += 1) {
    if (takenNumbers.has(n)) continue
    const id = poolSlotName(stem, n)
    // Joined in the container's own spelling (git's, forward slashes even on
    // Windows), so the slot's path compares equal to what `worktree list` says.
    const path = pathJoin(pool.containerPath, id)
    if (taken.has(id) || released.has(comparablePath(path))) continue
    if (await pathExists(path)) continue
    return { id, path }
  }
  return null
}

/** A new slot, made for a lease that found no idle one: detached at the base, marked, busy. */
async function createSlot(
  ctx: PoolContext,
  pool: PoolRuntime,
  base: { ref: string; sha: string },
): Promise<SlotRecord | 'full' | 'error'> {
  // The name is picked under the pool's mutex, in the same step that records
  // it: two leases creating at once must never both pick `<project>-01`.
  const { maxSlots } = await ctx.getSettings()
  const slot = await ctx.withPool(pool, async () => {
    if (pool.record.slots.length >= Math.min(maxSlots, POOL_MAX_SLOTS)) return null
    const target = await nextSlotPath(pool)
    if (!target) return null
    const created: SlotRecord = {
      id: target.id,
      path: target.path,
      state: 'creating',
      baseRef: base.ref,
      baseSha: base.sha,
      error: null,
      lease: null,
      held: null,
      lastUsedAt: null,
      createdAt: ctx.now(),
      op: { kind: 'create', startedAt: ctx.now(), pid: process.pid },
      uses: 0,
      lastBranch: null,
      size: null,
      kept: null,
      parked: null,
    }
    pool.record.slots.push(created)
    pool.busy.add(created.id)
    await ctx.persist(pool)
    return created
  })
  if (!slot) return 'full'
  const checkoutConfig = await parallelCheckoutConfig(ctx.git, pool.record.repoRoot)
  const result = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
    ctx.git(pool.record.repoRoot, [...checkoutConfig, 'worktree', 'add', '--quiet', '--detach', slot.path, base.sha]),
  )
  if (!result.ok) {
    ctx.log(`${slot.path}: worktree add failed (${tail(result.message, 300)})`)
    await ctx.withPool(pool, async () => {
      pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
      await ctx.persist(pool)
    })
    pool.busy.delete(slot.id)
    return 'error'
  }
  await writeSlotMarker(ctx.git, slot.path).catch((error: unknown) =>
    ctx.log(
      `${slot.path}: could not mark it as a slot (${messageOf(error)}); it is not adopted back if its record is lost`,
    ),
  )
  await ctx.withPool(pool, async () => {
    slot.state = 'leasing'
    slot.op = { kind: 'lease', startedAt: ctx.now(), pid: process.pid }
    await ctx.persist(pool)
  })
  return slot
}

async function branchExists(ctx: PoolContext, repoRoot: string, branch: string): Promise<boolean> {
  const result = await ctx.git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.ok && result.stdout.trim().length > 0
}

export async function lease(ctx: PoolContext, input: WorktreePoolLeaseInput): Promise<WorktreePoolLeaseResult> {
  const started = ctx.now()
  if (ctx.stopped) return { ok: false, reason: 'disabled', message: 'The worktree pool is shutting down.' }
  if (!(await ctx.getSettings()).enabled) return { ok: false, reason: 'disabled', message: 'The worktree pool is off.' }
  // A caller that named the branch (git.ts, from `agentWorktreePaths`) is
  // taken at its word; a name alone (`worktree.lease`) goes under the prefix.
  let branch = input.branch
  if (!branch) {
    const slug = slugifyWorktreeName(input.name)
    if (!slug) {
      return { ok: false, reason: 'invalid-name', message: `"${input.name}" does not reduce to a usable branch name.` }
    }
    branch = worktreeBranchName(ctx.branchPrefix(), slug)
  }
  // Declined before any git runs: under a WSL machine's scope even the
  // repository lookup is that machine's git, and its answer (`/mnt/c/…`)
  // would be remembered for this computer's own leases of the folder.
  const declined = unsupportedHost(input.repoRoot, input.hostId)
  if (declined) return { ok: false, reason: 'unsupported', message: declined }
  const repo = await ctx.resolveRepo(input.repoRoot)
  if (!repo) return { ok: false, reason: 'not-a-repo', message: 'Not a git repository with a main checkout.' }
  const unsupported = unsupportedHost(repo.repoRoot, input.hostId)
  if (unsupported) return { ok: false, reason: 'unsupported', message: unsupported }
  const pool = await ctx.poolFor(repo.repoRoot, true)
  if (!pool) return { ok: false, reason: 'not-a-repo', message: 'Not a git repository.' }
  if (!(await ctx.ready(pool))) {
    return { ok: false, reason: 'other-instance', message: 'Another Studio is using this repository’s pool.' }
  }
  const format = await ctx.git(pool.record.repoRoot, ['check-ref-format', '--branch', branch])
  if (!format.ok) return { ok: false, reason: 'invalid-name', message: `"${branch}" is not a valid branch name.` }
  const shadowing = await branchShadowing(ctx.git, pool.record.repoRoot, branch)
  if (shadowing) return { ok: false, reason: 'invalid-name', message: shadowing }
  const blocker = await branchBlockedBy(ctx.git, pool.record.repoRoot, branch)
  if (blocker) return { ok: false, reason: 'branch-exists', message: branchBlockedMessage(blocker) }
  if (await branchExists(ctx, pool.record.repoRoot, branch)) {
    return {
      ok: false,
      reason: 'branch-exists',
      message: `Branch "${branch}" already exists. Choose a different worktree name.`,
    }
  }
  await forgetSlotsGoneFromDisk(ctx, pool)
  const local = await localBase(ctx, pool)
  if (!local) return { ok: false, reason: 'no-base', message: 'This repository has no default branch to fork from.' }
  // The fetch and the slot's preparation overlap: the slot is made (or
  // reset) at where `origin/<default>` stands now while the fetch runs, and
  // moved on to the fetched commit only if the fetch moved the ref. A new
  // chat waits for the slower of the two, not for both.
  const fetching = ensureBase(ctx, pool, local)
  const owner = input.owner?.trim() || branch

  // Idle slots, the least recently used first: the slot a settled chat gave
  // back most recently is the last to go to someone else, so reopening that
  // chat finds its worktree still free to reclaim (`reclaim`). A slot parked
  // for a chat that still exists is never one of them: that chat comes back
  // to it. A full pool makes room instead (`makeRoom`).
  // Idle slots passed over for this lease (a terminal sits in one): it stays
  // idle, and picking it again would never get past it.
  const passedOver = new Set<string>()
  for (let attempt = 0; attempt <= POOL_MAX_SLOTS; attempt += 1) {
    let created = false
    let slot: SlotRecord | null = await ctx.withPool(pool, async () => {
      const picked = pool.record.slots
        .filter(
          (candidate) =>
            candidate.state === 'idle' &&
            !candidate.parked &&
            !pool.busy.has(candidate.id) &&
            !passedOver.has(candidate.id),
        )
        .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0]
      if (!picked) return null
      picked.state = 'leasing'
      pool.busy.add(picked.id)
      await ctx.persist(pool)
      return picked
    })
    if (!slot) {
      let made = await createSlot(ctx, pool, local)
      // Full: a slot nobody is using is given back and removed to make room,
      // before the lease is refused (pool-idle.ts). Refused, the message names
      // every slot and what holds it, so the person knows what to free.
      if (made === 'full') {
        const room = await makeRoom(ctx, pool)
        if (room.ok) made = await createSlot(ctx, pool, local)
        if (made === 'full') {
          const { maxSlots } = await ctx.getSettings()
          const held = room.ok ? [] : room.reasons
          // The slot only the idle period holds that is up first: when to ask
          // again, in whole minutes.
          const soonest = room.ok ? null : room.soonest
          const minutes = soonest ? Math.max(1, Math.ceil(soonest.inMs / 60_000)) : null
          const retryInMs = minutes !== null ? minutes * 60_000 : undefined
          const when =
            soonest && minutes !== null
              ? ` ${soonest.slot} may come free in ${minutes} minute${minutes === 1 ? '' : 's'}, if nothing else holds it.`
              : ''
          return {
            ok: false,
            reason: 'full',
            message:
              held.length > 0
                ? `The pool already has ${maxSlots} worktrees, and none can be given back now. ${held.join('; ')}.${when} Commit and push what is done, close what you are not using, or raise the limit in Settings ▸ Worktrees.`
                : `The pool already has ${maxSlots} worktrees.`,
            ...(retryInMs !== undefined ? { retryInMs } : {}),
            base: await fetching,
          }
        }
      }
      if (made === 'error') {
        return { ok: false, reason: 'error', message: 'Could not create a pool worktree.', base: await fetching }
      }
      slot = made
      created = true
    }

    try {
      if (!created) {
        if (await ctx.somethingRunsIn(slot.path)) {
          // Someone opened a terminal in an idle slot; it is not reset under them.
          passedOver.add(slot.id)
          await ctx.withPool(pool, async () => {
            slot!.state = 'idle'
            await ctx.persist(pool)
          })
          continue
        }
        if (!(await moveSlot(ctx, pool, slot, local.sha))) continue
      }
      const base = await fetching
      // The fetch moved the ref past where the slot was prepared: brought
      // along, with the same checks, so the fork is the freshly fetched
      // default branch.
      if (base.sha !== slot.baseSha && !(await moveSlot(ctx, pool, slot, base.sha))) {
        if (created) return { ok: false, reason: 'error', message: 'Could not move a new pool worktree.', base }
        continue
      }
      // Both talk to a remote, and the new chat waits on them: each has the
      // network deadline, and one that runs out is a note on the slot (the
      // agent can run it again), not a failed lease.
      const notes: string[] = []
      if (await hasFile(slot.path, '.gitmodules')) {
        const modules = await ctx.git(slot.path, ['submodule', 'update', '--init', '--recursive'], {
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        })
        if (!modules.ok) notes.push(`submodules: ${tail(modules.message)}`)
      }
      if (await usesLfs(slot.path)) {
        const lfs = await ctx.git(slot.path, ['lfs', 'pull'], { timeoutMs: GIT_NETWORK_TIMEOUT_MS })
        if (!lfs.ok) notes.push(`lfs: ${tail(lfs.message)}`)
      }
      // `.worktreeinclude` names ignored files (an `.env`) the tree needs; a
      // reused slot still has the last copy, but the checkout's may have
      // changed since.
      if (input.copyIncludedFiles && ctx.deps.seedIncludedFiles) {
        const seeded = await ctx.deps.seedIncludedFiles(pool.record.repoRoot, slot.path).then(
          (result) => failureOf(result),
          (error: unknown) => messageOf(error),
        )
        if (seeded !== null)
          ctx.log(`${slot.path}: could not copy the .worktreeinclude files (${tail(seeded)}); leasing anyway`)
      }
      // Locked BEFORE the branch exists: from the moment the slot is on an
      // agent's branch, nothing else may remove it.
      const locked = await lockAgentWorktree(pool.record.repoRoot, slot.path, owner, ctx.git)
      if (!locked.ok) ctx.log(`${slot.path}: could not lock (${tail(locked.message)}); leasing anyway`)
      const switched = await ctx.git(slot.path, ['switch', '--quiet', '-c', branch])
      if (!switched.ok) {
        await ctx.git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
        await ctx.withPool(pool, async () => {
          slot!.state = 'idle'
          slot!.op = null
          slot!.baseRef = base.ref
          slot!.baseSha = base.sha
          await ctx.persist(pool)
        })
        const exists = await branchExists(ctx, pool.record.repoRoot, branch)
        return {
          ok: false,
          reason: exists ? 'branch-exists' : 'error',
          message: switched.message ?? `Could not create ${branch}.`,
        }
      }
      await ctx.recordBranch(pool.record.repoRoot, branch)
      const leaseId = randomUUID()
      await ctx.withPool(pool, async () => {
        slot!.state = 'leased'
        slot!.op = null
        slot!.held = null
        slot!.error = notes.length ? notes.join('; ') : null
        slot!.baseRef = base.ref
        slot!.baseSha = base.sha
        slot!.lease = {
          leaseId,
          branch,
          owner,
          agentId: input.agentId ?? null,
          workspaceId: input.agentId ? (input.workspaceId ?? null) : null,
          leasedAt: ctx.now(),
          claimed: false,
        }
        slot!.lastUsedAt = ctx.now()
        slot!.uses += 1
        pool.record.lastLeaseAt = ctx.now()
        await ctx.persist(pool)
      })
      ctx.log(`${slot.path}: leased to ${owner} on ${branch} at ${base.ref} (${created ? 'new' : 'reused'})`)
      return {
        ok: true,
        leaseId,
        slotId: slot.id,
        repoRoot: pool.record.repoRoot,
        path: slot.path,
        branch,
        baseRef: base.ref,
        baseSha: base.sha,
        baseNote: base.note,
        lockReason: locked.ok ? agentWorktreeLockReason(owner) : null,
        created,
        elapsedMs: ctx.now() - started,
      }
    } catch (error) {
      await holdAfterFailure(ctx, pool, slot, messageOf(error))
      if (created) return { ok: false, reason: 'error', message: messageOf(error), base: await fetching }
    } finally {
      pool.busy.delete(slot.id)
    }
  }
  return { ok: false, reason: 'error', message: 'No pool worktree passed its checks.', base: await fetching }
}

/** What {@link catchUp} did with a leased slot. */
export type CatchUpOutcome =
  | { kind: 'moved'; ref: string; sha: string; note: string | null; repoRoot: string; path: string; branch: string }
  | { kind: 'current'; ref: string; sha: string; note: string | null }
  /** Someone has worked in it (a commit, an edit, another branch): it is theirs as it stands. */
  | { kind: 'worked-in' }
  | { kind: 'not-found' }
  | { kind: 'busy' }
  | { kind: 'failed'; message: string }

/**
 * Bring a leased slot nobody has worked in yet to the default branch as
 * origin has it now. A New chat leases its worktree while the person types
 * (utils/newChatWorktree.ts), and the person may type for minutes; the chat
 * must still start on the latest origin/main, never on the one the lease
 * fetched (owner ruling 2026-10-17).
 *
 * The fetch is the lease's own (`ensureBase`): one per `fetchFreshMs` serves
 * every caller. The move is `merge --ff-only` on the lease's branch, and only
 * while the slot is exactly as the lease left it — on that branch, at the base
 * it was cut from, nothing changed — so nothing anyone did is ever moved. A
 * submodule checkout follows the move, as on a lease.
 */
export async function catchUp(ctx: PoolContext, leaseId: string): Promise<CatchUpOutcome> {
  const found = findLease(ctx, leaseId)
  if (!found) return { kind: 'not-found' }
  const { pool, slot } = found
  if (!(await ctx.ready(pool))) return { kind: 'busy' }
  const local = await localBase(ctx, pool)
  if (!local) return { kind: 'failed', message: 'The repository has no default branch to catch up to.' }
  const base = await ensureBase(ctx, pool, local)
  const taken = await ctx.withPool(pool, async () => {
    if (slot.state !== 'leased' || slot.lease?.leaseId !== leaseId || pool.busy.has(slot.id)) return false
    pool.busy.add(slot.id)
    return true
  })
  if (!taken) return { kind: 'busy' }
  try {
    const status = await readSlotStatus(ctx.git, slot.path)
    if (!status.ok) return { kind: 'failed', message: status.message }
    const { oid, branch, changedPaths } = status.status
    if (branch !== slot.lease?.branch || oid !== slot.baseSha || changedPaths > 0) return { kind: 'worked-in' }
    if (oid === base.sha) return { kind: 'current', ref: base.ref, sha: base.sha, note: base.note }
    const merged = await ctx.git(slot.path, ['merge', '--ff-only', '--quiet', base.sha])
    if (!merged.ok) return { kind: 'failed', message: merged.message ?? `Could not fast-forward to ${base.ref}.` }
    if (await hasFile(slot.path, '.gitmodules')) {
      const modules = await ctx.git(slot.path, ['submodule', 'update', '--init', '--recursive'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      })
      if (!modules.ok) ctx.log(`${slot.path}: submodules after catching up: ${tail(modules.message)}`)
    }
    await ctx.withPool(pool, async () => {
      slot.baseRef = base.ref
      slot.baseSha = base.sha
      await ctx.persist(pool)
    })
    ctx.log(`${slot.path}: caught up to ${base.ref} at ${base.sha.slice(0, 12)}`)
    return {
      kind: 'moved',
      ref: base.ref,
      sha: base.sha,
      note: base.note,
      repoRoot: pool.record.repoRoot,
      path: slot.path,
      branch,
    }
  } finally {
    pool.busy.delete(slot.id)
  }
}

/**
 * Give a returned slot back to the chat it was returned from, on the
 * chat's own branch, at the path the chat records: a settled chat reopened
 * after the cleanup handed its worktree back, or a chat whose slot was given
 * back while it sat idle (pool-idle.ts), opened or sent to again (git.ts
 * `restoreGitWorktree`). The slot is still on disk with everything the chat
 * left in it, ignored files included, so only the branch is checked out
 * again. A parked slot removed to make room left its path reserved for the
 * chat, and a slot is made there again on the chat's branch
 * ({@link recreateAtReservedPath}): the chat's records and its CLI's
 * sessions name that path, so the chat comes back to it, not to another.
 *
 * Only an idle slot can be reclaimed. One leased to another agent since, or
 * held with someone's changes, is refused with the reason; a branch that no
 * longer exists is refused for good.
 */
export async function reclaim(
  ctx: PoolContext,
  input: {
    path: string
    branch: string
    owner: string
    copyIncludedFiles?: boolean
  },
): Promise<{ ok: true } | { ok: false; message: string; definitive?: true } | null> {
  await ctx.load()
  const pool = [...ctx.pools.values()].find(
    (candidate) =>
      candidate.record.slots.some((slot) => comparablePath(slot.path) === comparablePath(input.path)) ||
      reservationAt(candidate, input.path) !== undefined,
  )
  if (!pool) return null
  if (!(await ctx.ready(pool))) {
    return { ok: false, message: 'Another SprintEngine Studio is using this repository’s worktree pool.' }
  }
  const branch = input.branch
  const began = await ctx.withPool(pool, async () => {
    const slot = pool.record.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(input.path))
    if (!slot) {
      const reserved = reservationAt(pool, input.path)
      return reserved?.branch === branch ? { kind: 'reserved' as const } : { kind: 'gone' as const }
    }
    if (slot.state === 'leased' && slot.lease?.branch === branch) return { kind: 'done' as const, slot }
    if (slot.state !== 'idle' || pool.busy.has(slot.id)) return { kind: 'refused' as const, other: slot }
    pool.busy.add(slot.id)
    slot.state = 'leasing'
    slot.op = { kind: 'lease', startedAt: ctx.now(), pid: process.pid }
    await ctx.persist(pool)
    return { kind: 'began' as const, slot }
  })
  if (began.kind === 'gone') return null
  if (began.kind === 'reserved') return recreateAtReservedPath(ctx, pool, input)
  if (began.kind === 'done') {
    // The record says it is already this chat's; the tree is asked too. A
    // record can be stale (another profile shares the container, a person
    // switched branches in it), and a chat opened on a worktree on some
    // other branch would work on someone else's checkout.
    const status = await readSlotStatus(ctx.git, began.slot.path)
    if (status.ok && status.status.branch === branch) return { ok: true }
    return {
      ok: false,
      message: status.ok
        ? `The worktree this chat used at ${input.path} is on ${status.status.branch ?? 'a detached HEAD'} now, not ${branch}.`
        : `Could not read the worktree this chat used at ${input.path}: ${status.message}`,
    }
  }
  if (began.kind === 'refused') {
    const other = began.other
    // Held with the chat's own branch still checked out (a return that found
    // its work uncommitted): that is this chat's worktree, as it left it, and
    // the chat opens on it so the work can be committed or discarded there.
    // It is leased to the chat again, so the Worktree manager no longer offers
    // to discard or return a folder the open chat works in, and the chat's
    // own return later holds it again if the work is still uncommitted.
    if (other.state === 'held' && other.held?.branch === branch) {
      const taken = await ctx.withPool(pool, async () => {
        if (other.state !== 'held' || other.held?.branch !== branch || pool.busy.has(other.id)) return false
        pool.busy.add(other.id)
        return true
      })
      if (taken) {
        try {
          const status = await readSlotStatus(ctx.git, other.path)
          if (status.ok && status.status.branch === branch) {
            await ctx.git(pool.record.repoRoot, ['worktree', 'unlock', other.path])
            const locked = await lockAgentWorktree(pool.record.repoRoot, other.path, input.owner, ctx.git)
            if (!locked.ok) ctx.log(`${other.path}: could not lock (${tail(locked.message)}); reclaiming anyway`)
            await ctx.withPool(pool, async () => {
              other.state = 'leased'
              other.op = null
              other.held = null
              other.error = null
              other.lease = {
                leaseId: randomUUID(),
                branch,
                owner: input.owner,
                agentId: null,
                workspaceId: null,
                leasedAt: ctx.now(),
                claimed: false,
              }
              other.lastUsedAt = ctx.now()
              await ctx.persist(pool)
            })
            ctx.log(`${other.path}: held work given back to its chat on ${branch}`)
            return { ok: true }
          }
        } finally {
          pool.busy.delete(other.id)
        }
      }
    }
    return {
      ok: false,
      message:
        other.state === 'held'
          ? `The worktree this chat used is held in the worktree pool with changes in it. Commit, stash or discard them in the Worktree manager, then open the chat again.`
          : `The worktree this chat used at ${input.path} has since been given to another agent${other.lease ? ` (${other.lease.branch})` : ''}.`,
    }
  }
  const slot = began.slot
  const putBack = async (): Promise<void> => {
    await ctx.withPool(pool, async () => {
      slot.state = 'idle'
      slot.op = null
      await ctx.persist(pool)
    })
  }
  try {
    if (!(await branchExists(ctx, pool.record.repoRoot, branch))) {
      await putBack()
      return {
        ok: false,
        definitive: true,
        message: `Branch "${branch}" no longer exists, so the worktree cannot be recreated.`,
      }
    }
    const gitDir = await readSlotGitDir(ctx.git, slot.path)
    const operation = gitDir ? await operationInProgress(gitDir) : null
    const status = await readSlotStatus(ctx.git, slot.path)
    if (!gitDir || operation || !status.ok || status.status.changedPaths > 0 || status.status.branch !== null) {
      await hold(
        ctx,
        pool,
        slot,
        !status.ok || !gitDir ? 'error' : operation ? 'operation' : status.status.branch ? 'unexpected-head' : 'dirty',
        'found while giving it back to its chat',
        status.ok ? { changedPaths: status.status.changedPaths, branch: status.status.branch } : {},
      )
      return {
        ok: false,
        message: 'The worktree this chat used changed while it was in the pool; it is held in the Worktree manager.',
      }
    }
    // Commits made on the idle slot's detached HEAD since the pool left it
    // are on no branch: switching away would leave them to the reflog, which
    // the slot's eventual removal takes with it. Held, as eviction holds them.
    const from = status.status.oid
    if (from && slot.baseSha && from !== slot.baseSha && !(await commitIsReachable(ctx.git, slot.path, from))) {
      await hold(ctx, pool, slot, 'unexpected-head', 'found while giving it back to its chat: commits no branch has')
      return {
        ok: false,
        message: 'The worktree this chat used changed while it was in the pool; it is held in the Worktree manager.',
      }
    }
    // Another agent may have used the slot since, and left ignored files
    // (its build output, an `.env`) where the chat's branch tracks a file:
    // `switch` would overwrite them without a word, as a reset would.
    const tip = await revParseCommit(ctx.git, pool.record.repoRoot, `refs/heads/${branch}`)
    if (from && tip && from !== tip) {
      const inTheWay = await ignoredFilesInTheWay(ctx.git, slot.path, from, tip)
      if (inTheWay === null || inTheWay.length > 0) {
        await putBack()
        return {
          ok: false,
          message:
            inTheWay === null
              ? 'Could not check the worktree this chat used for ignored files its branch would overwrite.'
              : `The worktree this chat used has ignored files its branch would overwrite (${inTheWay.slice(0, 3).join(', ')}). Clear its ignored files in Settings ▸ Worktrees, then open the chat again.`,
        }
      }
    }
    const locked = await lockAgentWorktree(pool.record.repoRoot, slot.path, input.owner, ctx.git)
    if (!locked.ok) ctx.log(`${slot.path}: could not lock (${tail(locked.message)}); reclaiming anyway`)
    const switched = await ctx.git(slot.path, ['switch', '--quiet', branch])
    if (!switched.ok) {
      await ctx.git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
      await putBack()
      return { ok: false, message: switched.message ?? `Could not check out ${branch} again.` }
    }
    await ctx.withPool(pool, async () => {
      slot.state = 'leased'
      slot.op = null
      slot.parked = null
      slot.lease = {
        leaseId: randomUUID(),
        branch,
        owner: input.owner,
        agentId: null,
        workspaceId: null,
        leasedAt: ctx.now(),
        claimed: false,
      }
      slot.lastUsedAt = ctx.now()
      await ctx.persist(pool)
    })
    ctx.log(`${slot.path}: given back to its chat on ${branch}`)
    return { ok: true }
  } catch (error) {
    await holdAfterFailure(ctx, pool, slot, messageOf(error))
    return { ok: false, message: messageOf(error) }
  } finally {
    pool.busy.delete(slot.id)
  }
}

/**
 * Make a slot again at a path reserved for its chat, on the chat's branch:
 * the chat's parked slot was removed to make room, and the chat is back. As
 * a fresh worktree is made (`.worktreeinclude` copied, submodules and LFS
 * brought along, locked before anyone works in it), and leased to the chat
 * as `reclaim` leases a parked slot.
 *
 * It needs a place in the pool like any lease, and makes room the same way.
 * Null when the pool is off or has no room: the caller then puts a plain
 * worktree at the path (git.ts), as a lease past the limit gets one, and the
 * chat is just as whole. The reservation is dropped once a slot stands there.
 */
async function recreateAtReservedPath(
  ctx: PoolContext,
  pool: PoolRuntime,
  input: { path: string; branch: string; owner: string; copyIncludedFiles?: boolean },
): Promise<{ ok: true } | { ok: false; message: string; definitive?: true } | null> {
  const { enabled, maxSlots } = await ctx.getSettings()
  if (!enabled || (await pathExists(input.path))) return null
  const branch = input.branch
  if (!(await branchExists(ctx, pool.record.repoRoot, branch))) {
    return {
      ok: false,
      definitive: true,
      message: `Branch "${branch}" no longer exists, so the worktree cannot be recreated.`,
    }
  }
  const id = input.path.split(/[\\/]/u).filter(Boolean).pop() ?? input.path
  const claim = async (): Promise<SlotRecord | 'full' | 'taken'> =>
    ctx.withPool(pool, async () => {
      if (
        pool.record.slots.some((slot) => slot.id === id || comparablePath(slot.path) === comparablePath(input.path))
      ) {
        return 'taken' as const
      }
      if (pool.record.slots.length >= Math.min(maxSlots, POOL_MAX_SLOTS)) return 'full' as const
      const created: SlotRecord = {
        id,
        path: input.path,
        state: 'creating',
        baseRef: null,
        baseSha: null,
        error: null,
        lease: null,
        held: null,
        lastUsedAt: null,
        createdAt: ctx.now(),
        op: { kind: 'create', startedAt: ctx.now(), pid: process.pid },
        uses: 0,
        lastBranch: null,
        size: null,
        kept: null,
        parked: null,
      }
      pool.record.slots.push(created)
      pool.busy.add(created.id)
      await ctx.persist(pool)
      return created
    })
  let slot = await claim()
  if (slot === 'full' && (await makeRoom(ctx, pool)).ok) slot = await claim()
  if (slot === 'full' || slot === 'taken') return null
  const made = slot
  try {
    const checkoutConfig = await parallelCheckoutConfig(ctx.git, pool.record.repoRoot)
    const added = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
      ctx.git(pool.record.repoRoot, [...checkoutConfig, 'worktree', 'add', '--quiet', made.path, branch]),
    )
    if (!added.ok) {
      await ctx.withPool(pool, async () => {
        pool.record.slots = pool.record.slots.filter((candidate) => candidate !== made)
        await ctx.persist(pool)
      })
      return { ok: false, message: added.message ?? `Could not check out ${branch} again.` }
    }
    await writeSlotMarker(ctx.git, made.path).catch((error: unknown) =>
      ctx.log(`${made.path}: could not mark it as a slot (${messageOf(error)})`),
    )
    // Locked BEFORE anything else runs in it, as a lease locks its slot.
    const locked = await lockAgentWorktree(pool.record.repoRoot, made.path, input.owner, ctx.git)
    if (!locked.ok) ctx.log(`${made.path}: could not lock (${tail(locked.message)}); reclaiming anyway`)
    const notes: string[] = []
    if (await hasFile(made.path, '.gitmodules')) {
      const modules = await ctx.git(made.path, ['submodule', 'update', '--init', '--recursive'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      })
      if (!modules.ok) notes.push(`submodules: ${tail(modules.message)}`)
    }
    if (await usesLfs(made.path)) {
      const lfs = await ctx.git(made.path, ['lfs', 'pull'], { timeoutMs: GIT_NETWORK_TIMEOUT_MS })
      if (!lfs.ok) notes.push(`lfs: ${tail(lfs.message)}`)
    }
    if (input.copyIncludedFiles && ctx.deps.seedIncludedFiles) {
      const seeded = await ctx.deps.seedIncludedFiles(pool.record.repoRoot, made.path).then(
        (result) => failureOf(result),
        (error: unknown) => messageOf(error),
      )
      if (seeded !== null) ctx.log(`${made.path}: could not copy the .worktreeinclude files (${tail(seeded)})`)
    }
    const head = await revParseCommit(ctx.git, made.path, 'HEAD')
    await ctx.withPool(pool, async () => {
      made.state = 'leased'
      made.op = null
      made.error = notes.length ? notes.join('; ') : null
      made.baseRef = pool.record.defaultRef
      made.baseSha = head
      made.lease = {
        leaseId: randomUUID(),
        branch,
        owner: input.owner,
        agentId: null,
        workspaceId: null,
        leasedAt: ctx.now(),
        claimed: false,
      }
      made.lastUsedAt = ctx.now()
      made.uses = 1
      pool.record.reservedPaths = pool.record.reservedPaths.filter(
        (entry) => comparablePath(entry.path) !== comparablePath(made.path),
      )
      await ctx.persist(pool)
    })
    ctx.log(`${made.path}: made again for its chat on ${branch}`)
    return { ok: true }
  } catch (error) {
    await holdAfterFailure(ctx, pool, made, messageOf(error))
    return { ok: false, message: messageOf(error) }
  } finally {
    pool.busy.delete(made.id)
  }
}
