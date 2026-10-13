import type { WorktreePoolActionResult } from '../../shared/ipc/worktree-pool'
import { worktreeBranchName } from '../../shared/worktree-branch'
import type { SlotRecord } from './pool-store'
import { operationInProgress, readSlotGitDir, readSlotStatus, removeSlotMarker } from './slot-git'
import { type PoolContext, type PoolRuntime, messageOf } from './pool-context'
import { unlockIfOurs } from './pool-slot-steps'
import { returnSlot } from './pool-return'

/** What a person can do with a held slot (worktree-pool-service.ts): commit, stash, discard or keep its work. */

// ── Held-slot actions ────────────────────────────────────────────────────

export async function heldAction(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  action: 'commit' | 'stash' | 'discard' | 'keep',
  message: string | undefined,
): Promise<WorktreePoolActionResult> {
  if (slot.state !== 'held') return { ok: false, message: 'That worktree is not held.' }
  if (await ctx.somethingRunsIn(slot.path)) {
    return { ok: false, message: 'A terminal is still open in that worktree. Close it first.' }
  }
  const began = await ctx.withPool(pool, async () => {
    if (pool.busy.has(slot.id) || slot.state !== 'held') return false
    pool.busy.add(slot.id)
    slot.op = { kind: 'held-action', startedAt: ctx.now(), pid: process.pid }
    await ctx.persist(pool)
    return true
  })
  if (!began) return { ok: false, message: 'That worktree is busy.' }
  let outcome: WorktreePoolActionResult = { ok: true, message: null }
  try {
    const gitDir = await readSlotGitDir(ctx.git, slot.path)
    const operation = gitDir ? await operationInProgress(gitDir) : null
    if (action === 'keep') {
      await unlockIfOurs(ctx, pool, slot.path)
      // No longer the pool's: nothing may ever adopt it back.
      await removeSlotMarker(ctx.git, slot.path).catch((error: unknown) =>
        ctx.log(`${slot.path}: could not remove its slot mark (${messageOf(error)})`),
      )
      await ctx.withPool(pool, async () => {
        pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
        pool.record.releasedPaths.push(slot.path)
        await ctx.persist(pool)
      })
      ctx.log(`${slot.path}: kept as an ordinary worktree`)
      return { ok: true, message: 'Kept as an ordinary worktree. It is no longer part of the pool.' }
    }
    if (action === 'commit' || action === 'stash') {
      if (operation) {
        outcome = { ok: false, message: `A ${operation} is in progress. Finish it in a terminal, or discard.` }
        return outcome
      }
      const status = await readSlotStatus(ctx.git, slot.path)
      if (!status.ok) return (outcome = { ok: false, message: status.message })
      if (action === 'commit') {
        if (status.status.branch === null && status.status.oid) {
          const name = `${slot.held?.branch ?? worktreeBranchName(ctx.branchPrefix(), slot.id)}-held-${status.status.oid.slice(0, 7)}`
          const onBranch = await ctx.git(slot.path, ['switch', '--quiet', '-c', name])
          if (!onBranch.ok) return (outcome = { ok: false, message: onBranch.message ?? 'Could not create a branch.' })
        }
        const added = await ctx.git(slot.path, ['add', '--all'])
        if (!added.ok) return (outcome = { ok: false, message: added.message ?? 'git add failed.' })
        const committed = await ctx.git(slot.path, [
          'commit',
          '--quiet',
          '-m',
          message?.trim() || 'Work left in a pooled worktree',
        ])
        if (!committed.ok) return (outcome = { ok: false, message: committed.message ?? 'git commit failed.' })
      } else {
        const stashed = await ctx.git(slot.path, [
          'stash',
          'push',
          '--include-untracked',
          '-m',
          `worktree pool ${slot.id}: ${slot.held?.branch ?? 'held changes'}`,
        ])
        if (!stashed.ok) return (outcome = { ok: false, message: stashed.message ?? 'git stash failed.' })
      }
    } else if (action === 'discard') {
      if (operation) {
        const abort =
          operation === 'bisect' ? ['bisect', 'reset'] : [operation === 'revert' ? 'revert' : operation, '--abort']
        const aborted = await ctx.git(slot.path, abort)
        if (!aborted.ok)
          return (outcome = { ok: false, message: aborted.message ?? `Could not abort the ${operation}.` })
      }
      const reset = await ctx.git(slot.path, ['reset', '--hard', '--quiet', 'HEAD'])
      if (!reset.ok) return (outcome = { ok: false, message: reset.message ?? 'git reset failed.' })
      const cleaned = await ctx.git(slot.path, ['clean', '-fd', '--quiet'])
      if (!cleaned.ok) return (outcome = { ok: false, message: cleaned.message ?? 'git clean failed.' })
    }
  } finally {
    await ctx.withPool(pool, async () => {
      if (pool.record.slots.includes(slot)) {
        slot.op = null
        await ctx.persist(pool)
      }
    })
    pool.busy.delete(slot.id)
  }
  if (outcome.ok && pool.record.slots.includes(slot)) {
    const returned = await returnSlot(ctx, pool, slot)
    if (returned !== 'returned') {
      const after = ctx.slotById(pool, slot.id)
      return { ok: true, message: `Done, but the worktree is still held (${after?.held?.reason ?? returned}).` }
    }
    return { ok: true, message: 'Returned to the pool.' }
  }
  return outcome
}
