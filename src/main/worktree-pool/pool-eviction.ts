import { createHash } from 'crypto'
import type { WorktreePoolActionResult } from '../../shared/ipc/worktree-pool'
import { hiddenEditPaths, ignoredPathsAtRisk, isChatTranscriptPath } from '../agent-worktree-keep-checks'
import { pathExists } from '../git-utils'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import { MEASURE_CONCURRENCY } from './disk-usage'
import type { SlotRecord } from './pool-store'
import { commitIsReachable, readSlotStatus } from './slot-git'
import { type PoolContext, type PoolRuntime, tail } from './pool-context'
import { hold, forgetRegistration, reservePath } from './pool-slot-steps'

/** Evicting idle slots (worktree-pool-service.ts), and measuring them against the disk limit. */

// ── Evicting ─────────────────────────────────────────────────────────────

/**
 * Remove an idle slot from disk and from the pool. True when it is gone;
 * otherwise why not, worded for the person who asked (Settings): the slot is
 * left idle, or held when it turned out to hold work.
 *
 * `keptKey`: an automatic eviction's verdict key for the slot; a slot kept
 * for its ignored files is remembered under it (`keptVerdicts`).
 */
export async function evictSlot(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  why: string,
  keptKey: string | null = null,
): Promise<true | string> {
  const putBack = async (kept: string | null = slot.kept): Promise<void> => {
    await ctx.withPool(pool, async () => {
      slot.state = 'idle'
      slot.op = null
      slot.kept = kept
      await ctx.persist(pool)
    })
  }
  const began = await ctx.withPool(pool, async () => {
    if (pool.busy.has(slot.id) || (slot.state !== 'idle' && slot.state !== 'evicting')) return false
    pool.busy.add(slot.id)
    slot.state = 'evicting'
    slot.op = { kind: 'evict', startedAt: ctx.now(), pid: process.pid }
    await ctx.persist(pool)
    return true
  })
  if (!began) return 'Only a worktree that is ready to reuse can be removed.'
  try {
    if (await ctx.somethingRunsIn(slot.path)) {
      await putBack()
      return 'A terminal is open in it. Close it first.'
    }
    if (await pathExists(slot.path)) {
      const status = await readSlotStatus(ctx.git, slot.path)
      if (!status.ok || status.status.changedPaths > 0 || status.status.branch !== null) {
        await hold(
          ctx,
          pool,
          slot,
          status.ok && status.status.changedPaths > 0 ? 'dirty' : 'unexpected-head',
          'found while evicting',
          status.ok ? { changedPaths: status.status.changedPaths, branch: status.status.branch } : {},
        )
        return 'It changed since it came back to the pool, and is held there now.'
      }
      // Commits made on the idle slot's detached HEAD (a person in a
      // terminal there) are on no branch, and removing the worktree takes
      // its HEAD reflog with it: they would be lost. Where the pool left
      // it is the pool's to drop; anywhere else, unreachable, is held.
      const oid = status.status.oid
      if (oid && oid !== slot.baseSha && !(await commitIsReachable(ctx.git, slot.path, oid))) {
        await hold(ctx, pool, slot, 'unexpected-head', 'found while evicting: commits no branch has')
        return 'It holds commits no branch has, and is held in the pool now.'
      }
      // Tracked files hidden from `status` (`--assume-unchanged`,
      // `--skip-worktree`): neither the read above nor git's own check at
      // removal sees their edits, which would go with the folder.
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
        return 'It has edits git status does not show, and is held in the pool now.'
      }
      // Removing deletes the ignored files too, and the ones that may be
      // someone's work are kept as the agent worktree cleanup keeps them:
      // an edited `.env`, notes in an ignored folder (agent-worktree-keep-
      // checks.ts). The slot stays idle; clearing its ignored files, which a
      // person confirms, is the way to let them go.
      // What the app and the agent CLIs wrote there themselves (transcripts,
      // installed skills, the MCP config) and a linked `node_modules` are
      // not: Settings ▸ Worktrees shows why a slot stays.
      // The history of a chat that is not settled keeps its slot; a settled
      // chat counts as deleted (owner ruling 2026-10-08), so its history
      // goes with the slot and reopening it finds the slot gone.
      const ignored = await ignoredPathsAtRisk(pool.record.repoRoot, slot.path, ctx.git, {
        knownWorkspaceIds: ctx.deps.knownWorkspaceIds ?? null,
      })
      if (!ignored.ok || ignored.paths.length > 0) {
        if (!ignored.ok) {
          await putBack('could not check its ignored files')
          ctx.log(`${slot.path}: kept (could not check its ignored files: ${ignored.message})`)
          return 'Could not check its ignored files, so it is kept.'
        }
        const chats = ignored.paths.filter(isChatTranscriptPath).length
        const files = ignored.paths.filter((path) => !isChatTranscriptPath(path))
        const more = files.length > 3 ? ` and ${files.length - 3} more` : ''
        const listedPaths = `${files.slice(0, 3).join(', ')}${more}`
        const reasons = [
          chats > 0 ? `holds the history of ${chats === 1 ? 'a chat' : `${chats} chats`} not settled` : null,
          files.length > 0 ? `has ignored files that may be someone’s work: ${listedPaths}` : null,
        ].filter((reason): reason is string => reason !== null)
        await putBack(reasons.join('; '))
        if (keptKey !== null) pool.keptVerdicts.set(slot.id, keptKey)
        ctx.log(`${slot.path}: kept (${reasons.join('; ')})`)
        return files.length > 0
          ? `It has ignored files that may be someone’s work (${listedPaths}). Clear its ignored files first if they can go.`
          : 'It holds the history of a chat that is not settled. Settle or delete the chat to let it go.'
      }
      // No --force: git checks cleanliness again at the moment of removal.
      // Only a tree with submodules, which plain `remove` always refuses, is
      // forced — and only after the status above read it clean.
      let removed = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
        ctx.git(pool.record.repoRoot, ['worktree', 'remove', slot.path]),
      )
      if (!removed.ok && /submodule/iu.test(removed.message ?? '')) {
        removed = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
          ctx.git(pool.record.repoRoot, ['worktree', 'remove', '--force', slot.path]),
        )
      }
      if (!removed.ok) {
        await hold(ctx, pool, slot, 'error', `could not remove: ${tail(removed.message)}`)
        return `Git could not remove it: ${tail(removed.message) ?? 'unknown error'}`
      }
    } else {
      await forgetRegistration(ctx, pool, slot.path)
    }
    await ctx.withPool(pool, async () => {
      pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
      // Kept for a chat that still exists: its path stays free for it, and
      // its return makes a slot there again (`reclaim`).
      if (slot.parked) reservePath(pool, { ...slot.parked, path: slot.path })
      await ctx.persist(pool)
    })
    ctx.log(`${slot.path}: evicted (${why})${slot.parked ? `; its path is kept for ${slot.parked.branch}` : ''}`)
    return true
  } finally {
    pool.busy.delete(slot.id)
  }
}

/**
 * How long a slot may sit ready and unused before it goes, kept number or
 * not (owner ruling 2026-10-08): a pool is for the project being worked on
 * now, so one left alone for a day shrinks to nothing rather than holding a
 * gigabyte a slot for a project nobody has opened since. Counted from its
 * last lease or return.
 */
const IDLE_SLOT_EXPIRY_MS = 24 * 60 * 60_000

/**
 * Remove the least recently used idle slots beyond the kept number, beyond
 * what `maxSlots` leaves room for beside the slots in use, and every idle
 * slot unused for `IDLE_SLOT_EXPIRY_MS`.
 *
 * A slot parked for a chat is not a spare: no lease can take it as it
 * stands, so the kept number neither keeps nor removes it, and it counts
 * among the slots in use. It goes when it has been unused for a day, as any
 * idle slot does, or when the pool is turned off, its path kept for its chat
 * either way; a lease that finds the pool full may take it sooner
 * (pool-idle.ts `makeRoom`).
 */
export async function evictOverLimit(ctx: PoolContext, pool: PoolRuntime): Promise<void> {
  const { keepIdle, enabled, maxSlots } = await ctx.getSettings()
  const usedAt = (slot: SlotRecord): number => slot.lastUsedAt ?? slot.createdAt
  const idle = pool.record.slots
    .filter((slot) => slot.state === 'idle' && !pool.busy.has(slot.id))
    .sort((a, b) => usedAt(b) - usedAt(a))
  const spares = idle.filter((slot) => !slot.parked)
  const others = pool.record.slots.length - spares.length
  const limit = enabled ? Math.min(keepIdle, Math.max(0, maxSlots - others)) : 0
  const now = ctx.now()
  const chats = chatsKey(ctx)
  let index = 0
  for (const slot of idle) {
    const over = slot.parked ? !enabled : index++ >= limit
    if (!over && now - usedAt(slot) < IDLE_SLOT_EXPIRY_MS) continue
    if (ctx.stopped) return
    // Kept last time for the same reasons: every return and every settings
    // change would otherwise re-read each such slot's ignored files.
    const key = keptKey(slot, chats)
    if (pool.keptVerdicts.get(slot.id) === key) continue
    await evictSlot(ctx, pool, slot, over ? 'over the idle limit' : 'unused for a day', key)
  }
}

/** The chats on record, as one comparable string; a slot kept for one's history waits on this changing. */
function chatsKey(ctx: PoolContext): string {
  const ids = ctx.deps.knownWorkspaceIds?.()
  if (!ids) return 'unknown'
  return createHash('sha256')
    .update([...ids].sort().join('\0'))
    .digest('hex')
}

/**
 * What an automatic eviction's "kept" verdict on a slot rests on: when it
 * was last used (a lease and its return change what is in it) and which
 * chats are on record (one deleted lets its history go). Clearing the
 * slot's ignored files forgets the verdict outright.
 */
function keptKey(slot: SlotRecord, chats: string): string {
  return `${slot.lastUsedAt ?? slot.createdAt}\0${chats}`
}

// ── Disk ─────────────────────────────────────────────────────────────────

export async function measureSlot(ctx: PoolContext, pool: PoolRuntime, slot: SlotRecord): Promise<void> {
  if (!(await pathExists(slot.path))) return
  if (ctx.stopped) return
  const size = await ctx.measureSize(slot.path, ctx.stopping.signal).catch(() => null)
  if (!size || ctx.stopped) return
  await ctx.withPool(pool, async () => {
    if (!pool.record.slots.includes(slot)) return
    slot.size = size
    await ctx.persist(pool, { sizeOnly: true })
  })
}

/**
 * Measure every slot of every pool this instance drives (or of one
 * repository's), a few at a time, then hold the pools to the disk limit.
 * Settings ▸ Worktrees asks; nothing else measures in bulk.
 *
 * Only pools this instance already holds: opening Settings must not take
 * every repository's container lock (and with it, until quit, every other
 * Studio's use of those pools) just to read sizes. The rest show the sizes
 * their records last stored.
 */
export async function measure(ctx: PoolContext, repoRoot?: string): Promise<void> {
  await ctx.load()
  const target = repoRoot ? await ctx.poolFor(repoRoot, false) : null
  const targets = repoRoot ? (target ? [target] : []) : [...ctx.pools.values()]
  const queue: Array<{ pool: PoolRuntime; slot: SlotRecord }> = []
  for (const pool of targets) {
    if (pool.instance !== 'held' || !(await ctx.ready(pool))) continue
    for (const slot of pool.record.slots) {
      if (slot.state !== 'creating' && slot.state !== 'evicting') queue.push({ pool, slot })
    }
  }
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next && !ctx.stopped; next = queue.shift())
      await measureSlot(ctx, next.pool, next.slot)
  }
  await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, worker))
  await enforceDiskLimit(ctx)
}

/**
 * Remove idle slots, least recently used first across every pool, while all
 * of them together take more than the disk limit. Leased and held slots are
 * counted but never removed, so the pools may stay over the limit. A slot
 * never measured counts as nothing: the limit acts on what is known.
 */
export async function enforceDiskLimit(ctx: PoolContext): Promise<void> {
  const { diskLimitGb } = await ctx.getSettings()
  if (diskLimitGb === null || ctx.stopped) return
  const limit = diskLimitGb * 1024 ** 3
  const driven: PoolRuntime[] = []
  // Confirmed, not remembered: a pool whose lock went to another Studio is
  // that Studio's to evict from.
  for (const pool of ctx.pools.values()) if (pool.instance === 'held' && (await ctx.ready(pool))) driven.push(pool)
  let total = driven.reduce(
    (sum, pool) => sum + pool.record.slots.reduce((poolSum, slot) => poolSum + (slot.size?.bytes ?? 0), 0),
    0,
  )
  if (total <= limit) return
  const idle = driven
    .flatMap((pool) => pool.record.slots.map((slot) => ({ pool, slot })))
    .filter(({ pool, slot }) => slot.state === 'idle' && !pool.busy.has(slot.id))
    .sort((a, b) => (a.slot.lastUsedAt ?? a.slot.createdAt) - (b.slot.lastUsedAt ?? b.slot.createdAt))
  const chats = chatsKey(ctx)
  for (const { pool, slot } of idle) {
    if (total <= limit || ctx.stopped) break
    const bytes = slot.size?.bytes ?? 0
    const key = keptKey(slot, chats)
    if (pool.keptVerdicts.get(slot.id) === key) continue
    if ((await evictSlot(ctx, pool, slot, 'over the disk limit', key)) === true) total -= bytes
  }
}

/**
 * Delete an idle slot's ignored files (`git clean -fdX`): installed
 * dependencies, build output, caches. The slot stays in the pool, clean and
 * on its commit; the next agent in it installs from nothing.
 */
export async function clearIgnored(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
): Promise<WorktreePoolActionResult> {
  if (await ctx.somethingRunsIn(slot.path)) {
    return { ok: false, message: 'A terminal is open in that worktree. Close it first.' }
  }
  const began = await ctx.withPool(pool, async () => {
    if (pool.busy.has(slot.id) || slot.state !== 'idle') return false
    pool.busy.add(slot.id)
    return true
  })
  if (!began) return { ok: false, message: 'Only a worktree that is ready to reuse can be cleared.' }
  try {
    // Never the sidecar an older build wrote: until the store's one-time move
    // has taken it (workspace-store-migration.ts), it holds the history of
    // chats that ran here, which a settled chat reopened reads again. This
    // build writes nothing there. `-e` with a negation takes the folder out of
    // the ignored set for this run (a pathspec exclusion does not stop `clean`
    // removing an ignored folder).
    const cleaned = await ctx.git(slot.path, ['clean', '-fdX', '--quiet', '-e', '!/.sprintengine/'])
    if (!cleaned.ok) return { ok: false, message: cleaned.message ?? 'git clean failed.' }
    ctx.log(`${slot.path}: ignored files cleared`)
    await ctx.withPool(pool, async () => {
      slot.kept = null
      pool.keptVerdicts.delete(slot.id)
      await ctx.persist(pool)
    })
  } finally {
    pool.busy.delete(slot.id)
  }
  await measureSlot(ctx, pool, slot)
  return { ok: true, message: 'Cleared. The next agent in it runs the install from the start.' }
}
