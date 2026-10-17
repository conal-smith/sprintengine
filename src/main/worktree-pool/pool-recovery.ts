import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { basename, dirname } from 'path'
import { comparablePath } from '../../shared/host-paths'
import { pathInside } from '../agent-worktree-keep-checks'
import type { GitWorktreeEntry } from '../git'
import { pathExists } from '../git-utils'
import { parseGitWorktreePorcelain, runGitWorktreeListPorcelain } from '../git-worktree-list'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import type { SlotRecord } from './pool-store'
import { hasSlotMarker } from './slot-git'
import { type PoolContext, type PoolRuntime, tail, messageOf } from './pool-context'
import { forgetRegistration } from './pool-slot-steps'
import { returnSlot } from './pool-return'
import { evictSlot } from './pool-eviction'

/** Crash recovery (worktree-pool-service.ts): finishing or holding what a previous run left mid-step. */

const SLOT_NAME = /^pool-(\d{2,})$/u

// ── Recovery ─────────────────────────────────────────────────────────────

/**
 * Put a pool loaded from disk back into a state the service can drive. The
 * rule for each interrupted step is the least destructive one that finishes
 * it: a lease or a return is redone as a return (which only ever detaches a
 * clean tree), a reset is resumed only over its own half-done work by the
 * next lease, and anything the pool cannot account for is held.
 */
export async function recoverPool(ctx: PoolContext, pool: PoolRuntime): Promise<void> {
  const record = pool.record
  const listed = await runGitWorktreeListPorcelain(ctx.git, record.repoRoot)
  if (!listed.ok) throw new Error(`git worktree list failed: ${tail(listed.message) ?? 'no reason given'}`)
  const registered = new Map<string, GitWorktreeEntry>()
  for (const entry of parseGitWorktreePorcelain(listed.stdout)) registered.set(comparablePath(entry.path), entry)

  const goneFromDisk: string[] = []
  const survivors: SlotRecord[] = []
  const toReturn: SlotRecord[] = []
  const toEvict: SlotRecord[] = []
  for (const slot of record.slots) {
    // Recovery can run again after this process lost and regained the lock;
    // a slot it is itself working on right now is not a dead run's.
    if (pool.busy.has(slot.id)) {
      survivors.push(slot)
      continue
    }
    const entry = registered.get(comparablePath(slot.path))
    const onDisk = await pathExists(slot.path)
    if (!entry || !onDisk) {
      // Gone from git or from disk. A half-made slot of our own is cleared
      // away; anything else was removed by someone, and is forgotten.
      if (slot.op?.kind === 'create' && onDisk && !entry && pathInside(slot.path, pool.containerPath)) {
        await rm(slot.path, { recursive: true, force: true }).catch(() => {})
      }
      if (entry && !onDisk) goneFromDisk.push(slot.path)
      ctx.log(`${slot.path}: dropped from the pool (${entry ? 'missing on disk' : 'not a registered worktree'})`)
      continue
    }
    if (slot.op?.kind === 'create') {
      // `worktree add` was cut short. The slot was never leased, so nothing in
      // it is anyone's work, and a half-checked-out tree would otherwise read
      // as dirty and be held for ever. It is removed and made again later.
      const removed = await withWorktreeRegistryLock(record.repoRoot, () =>
        ctx.git(record.repoRoot, ['worktree', 'remove', '--force', slot.path]),
      )
      if (removed.ok) {
        ctx.log(`${slot.path}: removed a slot whose creation was interrupted`)
        continue
      }
    }
    survivors.push(slot)
    // Recovery finishes before this process starts any step of its own
    // (every entry point goes through `ready`), so any op here is a previous
    // run's.
    const op = slot.op
    if (op) {
      switch (op.kind) {
        case 'reset':
          // Left on the slot: the next lease's reset resumes over its own
          // half-done work and nothing else (resetSlot).
          slot.state = 'idle'
          break
        case 'create':
        case 'lease':
        case 'return':
          slot.state = 'returning'
          slot.op = null
          toReturn.push(slot)
          break
        case 'evict':
          slot.state = 'evicting'
          slot.op = null
          toEvict.push(slot)
          break
        default:
          slot.state = 'held'
          slot.held = {
            reason: 'recovery',
            detail: 'the app stopped during an action on this slot',
            changedPaths: null,
            branch: entry.branch,
            since: ctx.now(),
          }
          slot.op = null
      }
      continue
    }
    if (slot.state === 'creating' || slot.state === 'leasing' || slot.state === 'returning') {
      slot.state = 'returning'
      toReturn.push(slot)
    } else if (slot.state === 'evicting') {
      toEvict.push(slot)
    }
  }
  for (const path of goneFromDisk) await forgetRegistration(ctx, pool, path)

  // `pool-NN` worktrees in our container with no record: the record was lost.
  // A leased-looking one is adopted as leased (the next sweep decides), and
  // anything else as held. None is ever reset on this evidence alone.
  const known = new Set(survivors.map((slot) => comparablePath(slot.path)))
  const released = new Set(record.releasedPaths.map(comparablePath))
  for (const [key, entry] of registered) {
    if (known.has(key) || released.has(key)) continue
    if (comparablePath(dirname(entry.path)) !== comparablePath(pool.containerPath)) continue
    const name = basename(entry.path)
    if (!SLOT_NAME.test(name)) continue
    // A worktree merely NAMED like a slot (an agent or a person called it
    // `pool-01`) is not the pool's to adopt: only one the pool marked is.
    if (!(await hasSlotMarker(ctx.git, entry.path))) continue
    // Another Studio profile's lease: the container is shared, the records
    // are not. Adopting it would have this profile return (detach, unlock)
    // a worktree a chat of that profile is working in.
    if (entry.agentLock === 'other-profile') continue
    const leased = entry.branch !== null && entry.locked && !(entry.lockedReason ?? '').startsWith('held: ')
    survivors.push({
      id: name,
      path: entry.path,
      state: leased ? 'leased' : 'held',
      baseRef: null,
      baseSha: null,
      error: null,
      lease: leased
        ? {
            leaseId: randomUUID(),
            branch: entry.branch!,
            owner: entry.branch!,
            agentId: null,
            workspaceId: null,
            leasedAt: ctx.now(),
            claimed: false,
          }
        : null,
      held: leased
        ? null
        : {
            reason: 'recovery',
            detail: 'found in the pool container without a record',
            changedPaths: null,
            branch: entry.branch,
            since: ctx.now(),
          },
      lastUsedAt: null,
      createdAt: ctx.now(),
      op: null,
      uses: 0,
      lastBranch: null,
      size: null,
      kept: null,
    })
    ctx.log(`${entry.path}: adopted into the pool (${leased ? 'leased' : 'held'})`)
  }
  await ctx.withPool(pool, async () => {
    record.slots = survivors
    await ctx.persist(pool)
  })
  // Finished in the background: a lease waiting on recovery needs the
  // records settled, not these slots.
  void ctx
    .track(
      (async () => {
        // Quitting stops between slots: the rest stay as recorded, and the
        // next start's recovery resumes them.
        for (const slot of toReturn) if (!ctx.stopped) await returnSlot(ctx, pool, slot, true)
        for (const slot of toEvict) if (!ctx.stopped) await evictSlot(ctx, pool, slot, 'resumed')
      })(),
    )
    .catch((error: unknown) => ctx.log(`${record.repoRoot}: resuming after recovery failed: ${messageOf(error)}`))
}
