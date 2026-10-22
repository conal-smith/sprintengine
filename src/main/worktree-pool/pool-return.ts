import { agentLeaseKey, type WorktreePoolHeldReason } from '../../shared/ipc/worktree-pool'
import { worktreeBranchName } from '../../shared/worktree-branch'
import { insideAny, pathSpellings } from '../agent-worktree-keep-checks'
import { UNCLAIMED_LEASE_MS, type ReservedPath, type SlotKeeper, type SlotLease, type SlotRecord } from './pool-store'
import {
  clearStaleIndexLock,
  commitIsReachable,
  isPerAgentFile,
  operationInProgress,
  readSlotGitDir,
  readSlotStatus,
  removePerAgentFiles,
} from './slot-git'
import { type PoolContext, type PoolRuntime, tail, messageOf } from './pool-context'
import type { WorktreePoolSweepEntry, WorktreePoolReturnInput } from './worktree-pool-service'
import { lockReasonOf, isOurLock, hold, holdAfterFailure, forgetSlotsGoneFromDisk } from './pool-slot-steps'
import { evictOverLimit, measureSlot, enforceDiskLimit } from './pool-eviction'
import { giveBack, judgeIdle, readIdleFacts, type IdleFacts } from './pool-idle'

/** Returning a slot (worktree-pool-service.ts): one lease at a time, or every leased slot nothing uses any more. */

export function findLease(ctx: PoolContext, leaseId: string): { pool: PoolRuntime; slot: SlotRecord } | null {
  for (const pool of ctx.pools.values()) {
    const slot = pool.record.slots.find((candidate) => candidate.lease?.leaseId === leaseId)
    if (slot) return { pool, slot }
  }
  return null
}

// ── Returning ────────────────────────────────────────────────────────────

/**
 * Take a slot back from its owner (or re-check a held one). Clean: detached,
 * unlocked, idle again — it is moved to the default branch by the next lease,
 * not now. Anything else: held. The result says which.
 *
 * `park`: the owner still exists, and the slot is given back because it sat
 * clean and unused (pool-idle.ts), so it is kept for them. Written down before
 * the first git step, so a return the app stopped in finishes kept for them
 * too. Anything found that would hold a slot instead puts it back as it was,
 * leased: its owner is still there to deal with it, and no person need.
 */
export async function returnSlot(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  recovering = false,
  park: SlotKeeper | null = null,
): Promise<'returned' | 'held' | 'postponed' | 'skipped'> {
  const began = await ctx.withPool(pool, async () => {
    if (pool.busy.has(slot.id)) return null
    const from = slot.state
    if (!(from === 'leased' || from === 'held' || from === 'returning' || (recovering && from === 'leasing'))) {
      return null
    }
    if (park && from !== 'leased') return null
    pool.busy.add(slot.id)
    slot.state = 'returning'
    slot.op = { kind: 'return', startedAt: ctx.now(), pid: process.pid }
    if (park) slot.parked = park
    await ctx.persist(pool)
    return { from, lease: slot.lease, held: slot.held }
  })
  if (!began) return 'skipped'
  const branch = began.lease?.branch ?? began.held?.branch ?? null
  const putBack = async (): Promise<'postponed'> => {
    await ctx.withPool(pool, async () => {
      slot.state = began.from === 'leasing' ? 'returning' : began.from
      slot.op = null
      if (park) slot.parked = null
      await ctx.persist(pool)
    })
    return 'postponed'
  }
  /** Held for a person; or, given back while its owner exists, left with them as it was. */
  const holdUnlessParking = async (
    reason: WorktreePoolHeldReason,
    detail: string | null,
    extra: { changedPaths?: number | null; branch?: string | null },
  ): Promise<'held' | 'postponed'> => {
    if (park) return putBack()
    await hold(ctx, pool, slot, reason, detail, extra)
    return 'held'
  }
  try {
    // The agent's terminal (or anyone's) is still in there: put it back as
    // it was, and the next sweep asks again.
    if (await ctx.somethingRunsIn(slot.path)) return await putBack()
    // Locked by another Studio profile (which adopted or leased it) or by a
    // person: theirs, whatever this profile's record says. Held for a person
    // to sort out, with their lock left on it; unreadable, asked again later.
    const lock = await lockReasonOf(ctx, pool, slot.path)
    if (lock === undefined) return await putBack()
    if (lock !== null && !isOurLock(lock)) {
      return await holdUnlessParking('error', `locked by someone else (${lock || 'no reason given'})`, { branch })
    }
    const gitDir = await readSlotGitDir(ctx.git, slot.path)
    if (!gitDir) return await holdUnlessParking('error', 'the slot is no longer a git worktree', { branch })
    const operation = await operationInProgress(gitDir)
    if (operation) return await holdUnlessParking('operation', `a ${operation} is in progress`, { branch })
    if ((await clearStaleIndexLock(gitDir, true, ctx.now())) === 'busy') return await putBack()
    const status = await readSlotStatus(ctx.git, slot.path)
    if (!status.ok) return await holdUnlessParking('error', `status failed: ${status.message}`, { branch })
    // The MCP config every agent launch writes into its worktree is the
    // app's, not the agent's work, and is removed below; nothing else counts
    // as clean.
    const ownFiles = status.status.untrackedPaths.filter(isPerAgentFile).length
    const agentChanges = status.status.changedPaths - ownFiles
    if (agentChanges > 0) {
      return await holdUnlessParking('dirty', null, {
        changedPaths: agentChanges,
        branch: status.status.branch ?? branch,
      })
    }
    // Kept for a chat that comes back to its branch: the slot must be on it,
    // or the chat would come back to whatever this is. That is the branch the
    // tree is on, which its agent may have moved to from the lease's.
    if (park && status.status.branch !== park.branch) return await putBack()
    const kept = status.status.branch ?? branch
    const oid = status.status.oid
    // Detaching is free when HEAD is on a branch (the branch keeps it) or at
    // a commit some ref already reaches. A detached HEAD with commits of its
    // own gets a branch first, or those commits would be reachable only from
    // the reflog once the slot is reset.
    if (status.status.branch === null && oid && oid !== slot.baseSha) {
      if (!(await commitIsReachable(ctx.git, slot.path, oid))) {
        const rescue = `${branch ?? worktreeBranchName(ctx.branchPrefix(), slot.id)}-rescued-${oid.slice(0, 7)}`
        const created = await ctx.git(slot.path, ['branch', rescue, oid])
        if (!created.ok) {
          await hold(ctx, pool, slot, 'error', `could not keep detached commits: ${tail(created.message)}`, {
            branch,
          })
          return 'held'
        }
        await ctx.recordBranch(pool.record.repoRoot, rescue)
        ctx.log(`${slot.path}: kept detached commit ${oid.slice(0, 7)} on ${rescue}`)
      }
    }
    if (status.status.branch !== null) {
      const detached = await ctx.git(slot.path, ['switch', '--quiet', '--detach'])
      if (!detached.ok) {
        await hold(ctx, pool, slot, 'error', `could not detach: ${tail(detached.message)}`, { branch })
        return 'held'
      }
    }
    const cleared = await removePerAgentFiles(ctx.git, slot.path)
    if (cleared.length > 0) ctx.log(`${slot.path}: removed the last agent's ${cleared.join(', ')}`)
    await ctx.git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
    await ctx.withPool(pool, async () => {
      slot.state = 'idle'
      // Where the slot is now: the next lease holds it if anything moves it.
      slot.baseSha = oid
      if (kept) slot.lastBranch = kept
      slot.lease = null
      slot.held = null
      slot.op = null
      slot.error = null
      slot.kept = null
      slot.lastUsedAt = ctx.now()
      await ctx.persist(pool)
    })
    ctx.log(`${slot.path}: returned clean${kept ? ` (${kept} kept)` : ''}`)
  } catch (error) {
    await holdAfterFailure(ctx, pool, slot, messageOf(error), { branch })
    return 'held'
  } finally {
    pool.busy.delete(slot.id)
  }
  await evictOverLimit(ctx, pool)
  // A slot comes back bigger than it left (the agent installed, built); with
  // a disk limit set, that is when the pool learns it went over.
  if ((await ctx.getSettings()).diskLimitGb !== null && pool.record.slots.includes(slot)) {
    await measureSlot(ctx, pool, slot)
    await enforceDiskLimit(ctx)
  }
  return 'returned'
}

/** Whether the agent that leased a slot through MCP is still in the app's records. */
function agentStillHeld(lease: Pick<SlotLease, 'agentId' | 'workspaceId'>, input: WorktreePoolReturnInput): boolean {
  if (lease.agentId === null) return false
  if (lease.workspaceId !== null) {
    return input.agentKeys == null || input.agentKeys.has(agentLeaseKey(lease.workspaceId, lease.agentId))
  }
  // A lease recorded before leases named their chat: the id alone.
  return input.agentIds == null || input.agentIds.has(lease.agentId)
}

/**
 * Whether whoever a parked slot (or a reserved path) is kept for is still in
 * the app's records: the chat whose folder it is, or the agent that leased
 * it. Unknown keeps it.
 */
async function keeperStillHeld(
  keeper: SlotKeeper,
  path: string,
  protectedSpellings: readonly string[][],
  input: WorktreePoolReturnInput,
): Promise<boolean> {
  if (keeper.agentId !== null) return agentStillHeld(keeper, input)
  const spellings = await pathSpellings(path)
  return protectedSpellings.some((each) => insideAny(each, spellings))
}

/**
 * Let a slot kept for a chat (or agent) go to anyone once they are gone (the
 * chat settled or was deleted): it is an idle slot like any other again. A
 * reserved path is forgotten the same way.
 */
async function forgetGoneKeepers(
  ctx: PoolContext,
  pool: PoolRuntime,
  protectedSpellings: readonly string[][],
  input: WorktreePoolReturnInput,
): Promise<void> {
  const released: SlotRecord[] = []
  for (const slot of pool.record.slots) {
    if (slot.state !== 'idle' || !slot.parked || pool.busy.has(slot.id)) continue
    if (!(await keeperStillHeld(slot.parked, slot.path, protectedSpellings, input))) released.push(slot)
  }
  const forgotten: ReservedPath[] = []
  for (const reserved of pool.record.reservedPaths) {
    if (!(await keeperStillHeld(reserved, reserved.path, protectedSpellings, input))) forgotten.push(reserved)
  }
  if (released.length === 0 && forgotten.length === 0) return
  await ctx.withPool(pool, async () => {
    for (const slot of released) if (slot.state === 'idle') slot.parked = null
    pool.record.reservedPaths = pool.record.reservedPaths.filter((entry) => !forgotten.includes(entry))
    await ctx.persist(pool)
  })
  for (const slot of released) {
    ctx.log(`${slot.path}: no longer kept for ${slot.lastBranch ?? 'its chat'}; its chat is gone`)
  }
}

/**
 * Return every leased slot of a repository that nothing uses any more, and
 * give back the ones in use only on the records' say-so that have sat clean
 * and untouched for the idle period (pool-idle.ts). Asked by the agent
 * worktree cleanup, which already knows every path the app's records use; the
 * pool has no sweep of its own.
 *
 * A slot is in use while a protected path or a live terminal sits in it, or
 * while the agent that leased it through MCP still exists. A lease never seen
 * in use is left alone for {@link UNCLAIMED_LEASE_MS}: the chat it was made
 * for may not be recorded yet. One in use only because its chat or agent
 * still exists is given back, kept for them, when `judgeIdle` finds nothing
 * in it that is only there and nobody using it for `idleReturnMinutes`.
 */
export async function returnUnused(
  ctx: PoolContext,
  input: WorktreePoolReturnInput,
): Promise<WorktreePoolSweepEntry[]> {
  const pool = await ctx.poolFor(input.repoRoot, false)
  if (!pool || !(await ctx.ready(pool))) return []
  await forgetSlotsGoneFromDisk(ctx, pool)
  const protectedSpellings = await Promise.all(
    [...input.protectedPaths, ...((await ctx.deps.livePaths?.()) ?? [])]
      .filter(Boolean)
      .map((path) => pathSpellings(path)),
  )
  if (!input.dryRun) await forgetGoneKeepers(ctx, pool, protectedSpellings, input)
  const { idleReturnMinutes } = await ctx.getSettings()
  const givenBackHow = `clean, pushed and unused for ${idleReturnMinutes} minutes; its branch is kept for it`
  // Read once, at the first slot in use that needs them.
  let facts: IdleFacts | null = null
  const entries: WorktreePoolSweepEntry[] = []
  for (const slot of [...pool.record.slots]) {
    // Quitting: the slots not reached yet are the next start's sweep's.
    if (ctx.stopped) break
    if (slot.state === 'returning' && !pool.busy.has(slot.id)) {
      // A return a previous sweep postponed, or the app stopped in.
      const outcome = await returnSlot(ctx, pool, slot, true)
      if (outcome !== 'skipped') entries.push({ path: slot.path, branch: null, verdict: outcome })
      continue
    }
    if (slot.state !== 'leased' || !slot.lease) continue
    const lease = slot.lease
    const base = { path: slot.path, branch: lease.branch }
    const slotSpellings = await pathSpellings(slot.path)
    const inUse =
      protectedSpellings.some((spellings) => insideAny(spellings, slotSpellings)) || agentStillHeld(lease, input)
    if (inUse) {
      if (!lease.claimed && !input.dryRun) {
        await ctx.withPool(pool, async () => {
          if (slot.lease === lease) lease.claimed = true
          await ctx.persist(pool)
        })
      }
      facts ??= await readIdleFacts(ctx)
      const verdict = await judgeIdle(ctx, pool, slot, facts, idleReturnMinutes * 60_000)
      if (!verdict.ok) {
        entries.push({ ...base, verdict: 'in-use', detail: verdict.reason })
        continue
      }
      if (input.dryRun) {
        entries.push({ ...base, verdict: 'returned', detail: givenBackHow })
        continue
      }
      const outcome = await giveBack(ctx, pool, slot, verdict.keeper, { why: 'unused for the idle period' })
      const after = ctx.slotById(pool, slot.id)
      entries.push(
        outcome === 'returned'
          ? { ...base, verdict: 'returned', detail: givenBackHow }
          : outcome === 'held'
            ? { ...base, verdict: 'held', detail: after?.held?.detail ?? after?.held?.reason }
            : {
                ...base,
                verdict: 'in-use',
                detail: outcome === 'skipped' ? 'busy' : 'it changed while it was checked',
              },
      )
      continue
    }
    if (!lease.claimed && ctx.now() - lease.leasedAt < UNCLAIMED_LEASE_MS) {
      entries.push({ ...base, verdict: 'unclaimed', detail: 'leased recently; not recorded in use yet' })
      continue
    }
    if (input.dryRun) {
      entries.push({ ...base, verdict: 'returned' })
      continue
    }
    const outcome = await returnSlot(ctx, pool, slot)
    if (outcome === 'skipped') continue
    const after = ctx.slotById(pool, slot.id)
    entries.push({
      ...base,
      verdict: outcome,
      detail: outcome === 'held' ? (after?.held?.detail ?? after?.held?.reason) : undefined,
    })
  }
  // A sweep that returned nothing still ages the ready slots: one unused for
  // a day goes now, not at the next return, which may never come.
  if (!input.dryRun && !ctx.stopped) await evictOverLimit(ctx, pool)
  return entries
}

/**
 * Give a lease back at once: a launch that failed after its lease, or an
 * agent done with its worktree. `postponed`: something still runs in it, and
 * the cleanup returns it later; `busy`: another step holds the slot.
 */
export async function release(
  ctx: PoolContext,
  leaseId: string,
): Promise<'returned' | 'held' | 'postponed' | 'busy' | 'not-found'> {
  const found = findLease(ctx, leaseId)
  if (!found) return 'not-found'
  // Only while this instance still holds the pool: one that lost the lock
  // (another Studio judged it stale) must not move a slot that is now
  // someone else's.
  if (!(await ctx.ready(found.pool))) return 'busy'
  const outcome = await returnSlot(ctx, found.pool, found.slot)
  return outcome === 'skipped' ? 'busy' : outcome
}
