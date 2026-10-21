import { changesAlreadyIn } from '../agent-worktree-cleanup'
import {
  hiddenEditPaths,
  ignoredPathsAtRisk,
  insideAny,
  isChatTranscriptPath,
  pathSpellings,
  worktreeLastUsedAt,
} from '../agent-worktree-keep-checks'
import { UNCLAIMED_LEASE_MS, type SlotKeeper, type SlotRecord } from './pool-store'
import { isPerAgentFile, operationInProgress, readSlotGitDir, readSlotStatus, resolvePoolBaseRef } from './slot-git'
import type { PoolContext, PoolRuntime } from './pool-context'
import { isOurLock, lockReasonOf } from './pool-slot-steps'
import { evictSlot } from './pool-eviction'
import { returnSlot } from './pool-return'

/**
 * Giving back a leased slot whose chat still exists (worktree-pool-service.ts).
 *
 * A chat is only deleted when it settles, and its slot used to stay leased
 * until then: a pool of twelve could be twelve finished chats sitting in the
 * sidebar, every one clean and merged, and the thirteenth lease was refused.
 * A slot is now given back while its chat lives when nothing in it is only
 * there and nobody is using it: the tree is clean (by the same rules a return
 * and an eviction apply), its commits are on a remote, no turn, background
 * agent or terminal runs in it, its chat is not on screen, and it has gone
 * untouched for a while. The cleanup's sweep waits the person's idle period
 * (`idleReturnMinutes`); a lease that finds the pool full waits only
 * {@link ON_DEMAND_IDLE_MS}, and says why each slot it could not take is held.
 *
 * Given back is not given away. The slot is detached and left on disk as it
 * was, with its branch, and kept for its chat (`parked`): no lease reuses it
 * as it stands, because the chat's records, and the sessions its CLI keys by
 * folder (Claude Code's transcripts under `~/.claude/projects/<folder>`, a
 * Codex thread's cwd), name that path. Opening or sending to the chat checks
 * its branch out there again (`reclaim`, through git.ts `restoreGitWorktree`,
 * which the chat view and main's conversation runtime both ask before an
 * agent runs). A lease that needs the room removes a parked slot, by every
 * rule an eviction keeps, and keeps its path free for the chat
 * (`reservedPaths`), whose return makes a slot there again: the chat comes
 * back to the same folder, without the installed dependencies.
 *
 * Only a slot its chat can be brought back to is given back: one whose
 * folder IS the chat's (a worktree chat), on the branch that chat records.
 * An agent working in it from a chat in another folder has no way back, and
 * keeps it. A slot an agent leased for itself (`worktree.lease`) goes while
 * the agent's chat is idle and not on screen, and is removed outright rather
 * than parked: the agent finds its folder gone, not a detached tree it might
 * write to, and leases again.
 */

/**
 * The least time a slot must have gone untouched before a lease that finds the
 * pool full takes it: a chat finished ten minutes ago is someone's next step,
 * whatever the idle period says.
 */
export const ON_DEMAND_IDLE_MS = 10 * 60_000

/** A chat on record, as the pool weighs a slot it works in (worktree-services.ts builds them from the registry). */
export type PoolChat = {
  workspaceId: string
  /** The chat's own folder; a worktree chat's is its worktree. */
  folderPath: string | null
  /** The branch its worktree is on, for a chat in a worktree of its own; null for any other. */
  branch: string | null
  /** Every other folder its records name: its agents' working directories, its worktree entries. */
  otherPaths: string[]
  /** A window shows it now. */
  open: boolean
  /** When anything last happened in it: a message, a finished turn, terminal output, a visit. */
  lastActiveAt: number | null
}

/** What the slots of one pass are weighed against: read once, spelled every way a path can be. */
export type IdleFacts = {
  /** Null when the chats on record could not be read: then no slot a chat may hold is given back. */
  chats: Array<{ chat: PoolChat; folder: string[] | null; others: string[][] }> | null
  /** Where a chat's session works now: a running turn, or a live child (its background agents and monitors with it). */
  sessions: string[][]
  /** Every other live path: terminals and the checkouts they observe. */
  live: string[][]
}

export async function readIdleFacts(ctx: PoolContext): Promise<IdleFacts> {
  const spelled = (paths: readonly string[]): Promise<string[][]> =>
    Promise.all(paths.filter(Boolean).map((path) => pathSpellings(path)))
  let chats: readonly PoolChat[] | null = null
  try {
    chats = ctx.deps.chats?.() ?? null
  } catch {
    chats = null
  }
  return {
    chats: chats
      ? await Promise.all(
          chats.map(async (chat) => ({
            chat,
            folder: chat.folderPath ? await pathSpellings(chat.folderPath) : null,
            others: await spelled(chat.otherPaths),
          })),
        )
      : null,
    sessions: await spelled((await ctx.deps.liveSessionPaths?.()) ?? []),
    live: await spelled((await ctx.deps.livePaths?.()) ?? []),
  }
}

export type IdleVerdict = { ok: true; keeper: SlotKeeper } | { ok: false; reason: string }

/** `12 minutes`, `3 hours`, `2 days`. */
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hours`
  return `${Math.round(hours / 24)} days`
}

/**
 * Whether HEAD holds nothing that exists only here: some remote-tracking ref
 * has it, or the default branch the pool forks from does (by ancestry, or by
 * content for a squash-merged pull request whose remote branch was deleted).
 */
async function workIsElsewhere(ctx: PoolContext, pool: PoolRuntime, slot: SlotRecord, oid: string): Promise<boolean> {
  const remote = await ctx.git(slot.path, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    `--contains=${oid}`,
    'refs/remotes',
  ])
  if (remote.ok && remote.stdout.trim()) return true
  const base = (await resolvePoolBaseRef(ctx.git, pool.record.repoRoot)) ?? pool.record.defaultRef
  if (!base) return false
  const ancestor = await ctx.git(slot.path, ['merge-base', '--is-ancestor', oid, base])
  if (ancestor.ok) return true
  return changesAlreadyIn(slot.path, base, oid, ctx.git)
}

/**
 * Whether a leased slot can be given back now, and to whom it is then kept;
 * otherwise the first reason it stays, worded to follow the slot's name in a
 * list ("app-03 (agent/fix-login): 2 uncommitted changes"). The cheap
 * questions are asked first: git runs only for a slot nothing else keeps.
 * Reads only; the caller gives it back ({@link giveBack}).
 */
export async function judgeIdle(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  facts: IdleFacts,
  idleMs: number,
): Promise<IdleVerdict> {
  const lease = slot.lease
  if (slot.state !== 'leased' || !lease || pool.busy.has(slot.id)) return { ok: false, reason: 'busy' }
  const no = (reason: string): IdleVerdict => ({ ok: false, reason })
  const slotSpellings = await pathSpellings(slot.path)
  const inSlot = (spellings: readonly string[]): boolean => insideAny(spellings, slotSpellings)
  if (facts.sessions.some(inSlot)) return no('a turn or a background agent is running in it')
  if (facts.live.some(inSlot)) return no('a terminal is open in it')
  if (!facts.chats) return no('the chats on record could not be read')

  // The chats whose records name a folder in it, and, for a slot an agent
  // leased itself, that agent's chat, which works from its own folder.
  const chats = facts.chats.filter(({ folder, others }) => (folder !== null && inSlot(folder)) || others.some(inSlot))
  const agentChat =
    lease.agentId !== null && lease.workspaceId !== null
      ? facts.chats.find(({ chat }) => chat.workspaceId === lease.workspaceId)
      : undefined
  if (lease.agentId !== null && lease.workspaceId === null) {
    return no('leased by an agent whose chat was not recorded')
  }
  for (const { chat, folder } of chats) {
    // Brought back only as a worktree chat is: its folder, on its branch.
    const ownFolder = folder !== null && inSlot(folder) && insideAny(slotSpellings, folder)
    if (!ownFolder) return no('an agent of a chat in another folder works in it')
    if (chat.branch === null) return no('a chat is opened on it as a folder, not as its worktree')
    if (chat.branch !== lease.branch) return no(`its chat records ${chat.branch}, not ${lease.branch}`)
  }
  if (chats.some(({ chat }) => chat.open) || agentChat?.chat.open) return no('its chat is open on screen')
  if (agentChat?.folder && facts.sessions.some((session) => insideAny(session, agentChat.folder!))) {
    return no('its agent’s chat has a turn running')
  }
  const now = ctx.now()
  if (!lease.claimed && now - lease.leasedAt < UNCLAIMED_LEASE_MS) return no('leased moments ago')
  const touched = Math.max(
    lease.leasedAt,
    slot.lastUsedAt ?? 0,
    agentChat?.chat.lastActiveAt ?? 0,
    ...chats.map(({ chat }) => chat.lastActiveAt ?? 0),
  )
  if (now - touched < idleMs) return no(`used ${span(now - touched)} ago`)
  const gitUsedAt = await worktreeLastUsedAt(slot.path, ctx.git)
  if (gitUsedAt !== null && now - gitUsedAt < idleMs) return no(`git used it ${span(now - gitUsedAt)} ago`)

  // Everything a return and an eviction check, asked before either runs.
  const lock = await lockReasonOf(ctx, pool, slot.path)
  if (lock === undefined) return no('its lock could not be read')
  if (lock !== null && !isOurLock(lock)) return no(`locked by someone else (${lock || 'no reason given'})`)
  const gitDir = await readSlotGitDir(ctx.git, slot.path)
  if (!gitDir) return no('it is no longer a git worktree')
  const operation = await operationInProgress(gitDir)
  if (operation) return no(`a ${operation} is in progress`)
  const status = await readSlotStatus(ctx.git, slot.path)
  if (!status.ok) return no(`git status failed: ${status.message}`)
  const changes =
    status.status.changedPaths - status.status.untrackedPaths.filter((path) => isPerAgentFile(path)).length
  if (changes > 0) return no(`${changes} uncommitted change${changes === 1 ? '' : 's'}`)
  if (status.status.branch !== lease.branch) {
    return no(`it is on ${status.status.branch ?? 'a detached HEAD'}, not ${lease.branch}`)
  }
  const oid = status.status.oid
  if (!oid || !(await workIsElsewhere(ctx, pool, slot, oid))) return no('it has commits not pushed')
  const hidden = await hiddenEditPaths(slot.path, ctx.git)
  if (!hidden.ok) return no(hidden.message)
  if (hidden.paths.length > 0) return no(`edits hidden from git status: ${hidden.paths.slice(0, 3).join(', ')}`)
  const ignored = await ignoredPathsAtRisk(pool.record.repoRoot, slot.path, ctx.git, {
    knownWorkspaceIds: ctx.deps.knownWorkspaceIds ?? null,
  })
  if (!ignored.ok) return no(`its ignored files could not be checked (${ignored.message})`)
  if (ignored.paths.length > 0) {
    const files = ignored.paths.filter((path) => !isChatTranscriptPath(path))
    return no(
      files.length > 0
        ? `ignored files that may be someone’s work: ${files.slice(0, 3).join(', ')}`
        : 'it holds the history of a chat that is not settled',
    )
  }
  return {
    ok: true,
    keeper: { branch: lease.branch, agentId: lease.agentId, workspaceId: lease.workspaceId, since: now },
  }
}

/**
 * Give a slot {@link judgeIdle} cleared back, kept for its keeper. A chat's
 * slot stays on disk, parked; one an agent leased for itself, or any slot when
 * `evict` asks, is removed too, its path kept free for whoever it was kept
 * for. 'returned' once it is no longer leased; otherwise why not, as the
 * return said (the return checks everything again, and something may have
 * moved since the judgement).
 */
export async function giveBack(
  ctx: PoolContext,
  pool: PoolRuntime,
  slot: SlotRecord,
  keeper: SlotKeeper,
  options: { evict?: boolean; why: string },
): Promise<'returned' | 'held' | 'postponed' | 'skipped'> {
  const outcome = await returnSlot(ctx, pool, slot, false, keeper)
  if (outcome !== 'returned') return outcome
  ctx.log(`${slot.path}: given back while its ${keeper.agentId ? 'agent' : 'chat'} still exists (${options.why})`)
  try {
    ctx.deps.onGivenBack?.({ repoRoot: pool.record.repoRoot, path: slot.path, branch: keeper.branch })
  } catch (error) {
    ctx.log(`${slot.path}: telling the chat its worktree was given back failed: ${String(error)}`)
  }
  if ((options.evict || keeper.agentId !== null) && pool.record.slots.includes(slot)) {
    await evictSlot(ctx, pool, slot, options.why)
  }
  return 'returned'
}

/** `app-03 (agent/fix-login)`: a slot as a list of reasons names it. */
function label(slot: SlotRecord): string {
  const branch = slot.lease?.branch ?? slot.parked?.branch ?? slot.held?.branch ?? null
  return branch ? `${slot.id} (${branch})` : slot.id
}

/** Why a slot no lease could take is where it is, for the refusal that lists them. */
function standing(slot: SlotRecord): string {
  if (slot.state === 'held') {
    const held = slot.held
    if (held?.reason === 'dirty') {
      return `held with ${held.changedPaths ? `${held.changedPaths} changes` : 'changes'} for you to commit, stash or discard`
    }
    return `held for you to look at (${held?.detail ?? held?.reason ?? 'no reason given'})`
  }
  if (slot.state === 'idle') return 'a terminal is open in it'
  return `busy (${slot.state})`
}

/**
 * Free one place in a full pool, for a lease (or a chat coming back) that
 * needs it: a parked slot is removed, its path kept for its chat; failing
 * that, a leased slot nothing uses is given back and removed the same way.
 * Never one that holds anything only it has (every eviction rule applies),
 * nor one in use. Otherwise every slot with the reason it is held, so the
 * refusal says what the person could free.
 */
export async function makeRoom(
  ctx: PoolContext,
  pool: PoolRuntime,
): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
  const reasons = new Map<string, string>()
  const why = 'to make room for a new lease'
  const parked = pool.record.slots
    .filter((slot) => slot.state === 'idle' && slot.parked && !pool.busy.has(slot.id))
    .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))
  for (const slot of parked) {
    if (ctx.stopped) break
    const name = label(slot)
    const evicted = await evictSlot(ctx, pool, slot, why)
    if (evicted === true) return { ok: true }
    reasons.set(slot.id, `${name}: ${evicted}`)
  }
  const { idleReturnMinutes } = await ctx.getSettings()
  const idleMs = Math.min(idleReturnMinutes * 60_000, ON_DEMAND_IDLE_MS)
  const leased = pool.record.slots
    .filter((slot) => slot.state === 'leased' && slot.lease)
    .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))
  let facts: IdleFacts | null = null
  for (const slot of leased) {
    if (ctx.stopped) break
    const name = label(slot)
    facts ??= await readIdleFacts(ctx)
    const verdict = await judgeIdle(ctx, pool, slot, facts, idleMs)
    if (!verdict.ok) {
      reasons.set(slot.id, `${name}: ${verdict.reason}`)
      continue
    }
    const outcome = await giveBack(ctx, pool, slot, verdict.keeper, { evict: true, why })
    if (outcome === 'returned' && !pool.record.slots.includes(slot)) return { ok: true }
    reasons.set(
      slot.id,
      `${name}: ${outcome === 'returned' ? (slot.kept ?? 'it could not be removed') : outcome === 'held' ? 'it changed, and is held now' : 'busy'}`,
    )
  }
  for (const slot of pool.record.slots) {
    if (!reasons.has(slot.id)) reasons.set(slot.id, `${label(slot)}: ${standing(slot)}`)
  }
  return { ok: false, reasons: [...reasons.values()] }
}
