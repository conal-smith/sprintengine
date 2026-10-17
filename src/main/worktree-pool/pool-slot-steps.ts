import type { WorktreePoolHeldReason } from '../../shared/ipc/worktree-pool'
import { comparablePath } from '../../shared/host-paths'
import { agentWorktreeLockOwner } from '../agent-worktree-lock'
import { pathExists } from '../git-utils'
import { parseGitWorktreePorcelain, runGitWorktreeListPorcelain } from '../git-worktree-list'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import type { SlotRecord } from './pool-store'
import { type PoolContext, type PoolRuntime, messageOf } from './pool-context'

/**
 * Steps on one slot that leasing, returning, evicting and recovery all take:
 * holding it for a person, and forgetting one gone from disk.
 */

// ── Holding a slot ────────────────────────────────────────────────────────

/**
 * The lock git has on a worktree: its reason (empty when none was given),
 * null when it is not locked, undefined when the listing could not be read.
 */
export async function lockReasonOf(
  ctx: PoolContext,
  pool: PoolRuntime,
  path: string,
): Promise<string | null | undefined> {
  const listed = await runGitWorktreeListPorcelain(ctx.git, pool.record.repoRoot)
  if (!listed.ok) return undefined
  const entry = parseGitWorktreePorcelain(listed.stdout).find(
    (candidate) => comparablePath(candidate.path) === comparablePath(path),
  )
  return entry?.locked ? (entry.lockedReason ?? '') : null
}

/**
 * Whether a lock is this pool's to lift: its own hold, or this profile's
 * agent lock. Slots live in a container every Studio profile shares, and
 * another profile's agent lock (or a person's) means someone else is using
 * the worktree, whatever this profile's record says.
 */
export function isOurLock(reason: string): boolean {
  return reason.startsWith('held: ') || agentWorktreeLockOwner(reason) === 'this-profile'
}

/** Lift a slot's lock when it is ours ({@link isOurLock}); anyone else's stays. */
export async function unlockIfOurs(ctx: PoolContext, pool: PoolRuntime, path: string): Promise<void> {
  const lock = await lockReasonOf(ctx, pool, path)
  if (lock !== null && lock !== undefined && isOurLock(lock)) {
    await ctx.git(pool.record.repoRoot, ['worktree', 'unlock', path])
  }
}

/**
 * Park a slot for a person to decide. The slot is (re)locked with the reason,
 * so the Worktree manager, the Git pane and git itself all see it is not to
 * be touched, and the agent worktree cleanup skips it. A lock that is not
 * ours (another profile's, a person's) is left as it is.
 */
export async function hold(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  reason: WorktreePoolHeldReason,
  detail: string | null,
  extra: { changedPaths?: number | null; branch?: string | null } = {},
): Promise<void> {
  const branch = extra.branch ?? slot.lease?.branch ?? slot.held?.branch ?? null
  const lock = await lockReasonOf(ctx, pool, slot.path)
  if (lock === null || (lock !== undefined && isOurLock(lock))) {
    if (lock !== null) await ctx.git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
    await ctx.git(pool.record.repoRoot, ['worktree', 'lock', '--reason', `held: ${reason}`, slot.path])
  }
  await ctx.withPool(pool, async () => {
    slot.state = 'held'
    slot.held = { reason, detail, changedPaths: extra.changedPaths ?? null, branch, since: ctx.now() }
    slot.lease = null
    slot.op = null
    if (reason === 'error' || reason === 'recovery') slot.error = detail
    await ctx.persist(pool)
  })
  ctx.log(`${slot.path}: held (${reason}${detail ? `: ${detail}` : ''})`)
}

/**
 * {@link hold} from a `catch`: a step already failed, and a hold that fails
 * too (its record could not be written) is logged rather than thrown over
 * the failure being handled.
 */
export async function holdAfterFailure(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  detail: string,
  extra: { branch?: string | null } = {},
): Promise<void> {
  await hold(ctx, pool, slot, 'error', detail, extra).catch((error: unknown) =>
    ctx.log(`${slot.path}: could not hold after "${detail}": ${messageOf(error)}`),
  )
}

/**
 * Clear git's record of one slot whose folder is gone. `remove --force`
 * takes a registered worktree with no folder, and only that one: a `prune`
 * would forget every missing worktree of the repository, a person's own
 * on an unmounted volume included. A locked entry is refused, as `prune`
 * refuses it.
 */
export function forgetRegistration(ctx: PoolContext, pool: PoolRuntime, path: string): Promise<unknown> {
  return withWorktreeRegistryLock(pool.record.repoRoot, () =>
    ctx.git(pool.record.repoRoot, ['worktree', 'remove', '--force', path]),
  )
}

/**
 * Forget idle and held slots someone deleted from outside (a file manager,
 * `git worktree remove` in a terminal), and git's record of them. A leased
 * one's absence is its owner's business.
 */
export async function forgetSlotsGoneFromDisk(ctx: PoolContext, pool: PoolRuntime): Promise<void> {
  const gone: SlotRecord[] = []
  for (const slot of pool.record.slots) {
    if ((slot.state === 'idle' || slot.state === 'held') && !pool.busy.has(slot.id)) {
      if (!(await pathExists(slot.path))) gone.push(slot)
    }
  }
  if (gone.length === 0) return
  for (const slot of gone) {
    // A held slot is locked by the pool itself, and git never removes a locked worktree.
    if (slot.state === 'held') await unlockIfOurs(ctx, pool, slot.path)
    await forgetRegistration(ctx, pool, slot.path)
  }
  await ctx.withPool(pool, async () => {
    pool.record.slots = pool.record.slots.filter((slot) => !gone.includes(slot))
    await ctx.persist(pool)
  })
  for (const slot of gone) ctx.log(`${slot.path}: gone from disk; dropped from the pool`)
}
