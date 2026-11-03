import { canonicalPath, insideAny, pathSpellings } from './agent-worktree-keep-checks'

/**
 * One lease per worktree path, within this process: the bridge between the
 * code that starts work in a folder and the code that changes what the folder
 * is.
 *
 * The pool and the agent worktree cleanup decide whether a tree is in use from
 * the live list (`liveWorkPaths`: live terminals, chats with a child or a turn
 * running). A turn, a session or a terminal is not on that list while it
 * starts up: a turn spends a hundred lines of awaits (skills, mentions, the
 * chat-folder guard) before its `activeTurnId` is set, and a terminal writes
 * its MCP config into the folder before it is attached. A return or a removal
 * that looked in that window found the folder idle and changed it under the
 * starter: a turn ran on a detached HEAD, or a terminal lost its `.mcp.json`.
 *
 * So a starter holds the path **shared** from its first step until it shows
 * up as live, and a step that changes what is at a path (return, reset,
 * eviction, clearing, a held slot's commit or discard, removal) holds it
 * **exclusive** and looks at the live list again once it has the hold.
 * Between them the two signals leave no gap: a starter is covered by its hold
 * until it is live, and from then on by the list.
 *
 * ## Rules that keep it free of deadlock
 *
 * 1. Only a shared acquire waits, and only on an exclusive hold. An exclusive
 *    acquire never waits (`tryExclusive` answers at once), so an exclusive
 *    holder is never waiting on anything in here and no cycle can form. That
 *    covers the pool making room in slot B while a lease works in slot A.
 * 2. Lock order: path hold, then the pool's mutex (`withPool`), then the
 *    worktree registry lock (worktree-registry-lock.ts). Nobody acquires a
 *    hold inside either. Git calls never take holds.
 * 3. Holds are taken at entry points only, and inner steps run under the hold
 *    they were called with: the chat-folder guard's restore runs under its
 *    turn's shared hold, which an exclusive acquire of its own would refuse.
 *    (A shared acquire inside a shared hold of the same path never waits —
 *    no exclusive can be held there — but entry points do not lean on that.)
 * 4. A shared acquire that is waiting blocks new exclusive ones, so background
 *    work cannot starve a turn start. An exclusive caller backs off: the pool
 *    postpones, the cleanup reports `in-use`, a person is told to try again.
 *    A refused exclusive acquire says which holds it met (`blockedBy`), so the
 *    refusal can name them and the pool can tell its own steps from a start.
 *
 * Every mutator goes through {@link holdIfIdle}: the exclusive hold, then the
 * live list read under it.
 *
 * A shared wait is bounded (`WORKTREE_SHARED_WAIT_MS`) and can be aborted
 * (stopping the chat, killing the terminal, quitting); it ends with the reason
 * of the hold it waited on. A hold taken with `refuseWaiters` (a lease
 * preparing an idle slot, after which the slot is someone else's) is not
 * waited for at all. Holds live in memory only and
 * die with the process, so none can be left stale by a crash; one held longer
 * than `staleAfterMs` is logged but never broken, because breaking it would
 * open the window again. Another Studio profile is kept off by git's own
 * worktree locks and the pool's instance lock, not by this.
 *
 * ## Keys and conflicts
 *
 * A path is filed under {@link canonicalPath}: one key for every alias,
 * symlinks resolved through the nearest existing ancestor. Conflicts are by
 * containment, as the live check decides "runs in": a shared hold meets an
 * exclusive one when it is at the exclusive one's path or inside it (a
 * terminal starting in `slot/src` keeps `slot` from being returned), and two
 * exclusive holds meet when either contains the other. Two shared holds never
 * meet.
 */

export type WorktreeHoldKind = 'shared' | 'exclusive'

export type WorktreeHold = {
  /** The canonical path the hold is filed under. */
  readonly key: string
  readonly kind: WorktreeHoldKind
  /** Gives the hold up. Idempotent: a second call does nothing. */
  release(): void
}

/** Who holds (or waits for) a path, for messages, diagnostics and tests. */
export type WorktreeHolder = {
  kind: WorktreeHoldKind
  reason: string
  /** Which part of the app took it, when it said (`WORKTREE_POOL_OWNER`). */
  owner: string | null
  since: number
  /** A shared acquire still waiting for an exclusive hold to end. */
  waiting: boolean
}

/** A shared acquire that ended without a hold, worded for the person who started it. */
export type WorktreeBusy = { busy: string }

/** An exclusive acquire refused, with the holds and waiting acquires it met (never empty). */
export type WorktreeBlocked = { blockedBy: WorktreeHolder[] }

export type WorktreeSharedOptions = {
  /** What the holder is doing, worded to finish "busy: …" (`a turn is starting in it`). */
  reason: string
  timeoutMs?: number
  signal?: AbortSignal
}

export type WorktreeExclusiveOptions = {
  owner?: string
  /**
   * Nothing should wait for this hold: a start that meets it is refused at
   * once with its reason. For a step after which the start would find the
   * tree given to someone else (a lease preparing an idle slot).
   */
  refuseWaiters?: boolean
}

export type WorktreeLeases = {
  /** Hold `path` shared, waiting for an exclusive hold on it to end; or why not. */
  acquireShared(path: string, options: WorktreeSharedOptions): Promise<WorktreeHold | WorktreeBusy>
  /** Hold `path` exclusive now, or say what it met. Never waits. */
  tryExclusive(
    path: string,
    reason: string,
    options?: WorktreeExclusiveOptions,
  ): Promise<WorktreeHold | WorktreeBlocked>
  /** Every hold and waiting acquire that meets `path` either way. */
  holders(path: string): Promise<WorktreeHolder[]>
}

/** How long a start waits for a return or removal to finish before it is refused (owner ruling 2026-11-03). */
export const WORKTREE_SHARED_WAIT_MS = 60_000
/** How long a hold may last before it is logged as one to look at. */
const STALE_HOLD_MS = 5 * 60_000

type Held = {
  key: string
  kind: WorktreeHoldKind
  reason: string
  owner: string | null
  refuseWaiters: boolean
  since: number
}
type Waiting = { key: string; reason: string; since: number; grant: () => void }

function holderOf(entry: Held | Waiting): WorktreeHolder {
  return 'kind' in entry
    ? { kind: entry.kind, reason: entry.reason, owner: entry.owner, since: entry.since, waiting: false }
    : { kind: 'shared', reason: entry.reason, owner: null, since: entry.since, waiting: true }
}

function inside(child: string, parent: string): boolean {
  return child === parent || (parent !== '' && child.startsWith(`${parent}/`))
}

export function createWorktreeLeases(
  options: {
    now?: () => number
    log?: (line: string) => void
    staleAfterMs?: number
    canonical?: (path: string) => Promise<string>
  } = {},
): WorktreeLeases {
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.warn(`[worktree-leases] ${line}`))
  const staleAfterMs = options.staleAfterMs ?? STALE_HOLD_MS
  const canonical = options.canonical ?? canonicalPath
  const held = new Set<Held>()
  const waiting = new Set<Waiting>()

  /** The exclusive hold a shared one at `key` would have to wait for. */
  function exclusiveOver(key: string): Held | undefined {
    for (const hold of held) if (hold.kind === 'exclusive' && inside(key, hold.key)) return hold
    return undefined
  }

  /** What an exclusive hold at `key` would meet, held or waiting. */
  function blockersOf(key: string): WorktreeHolder[] {
    const met: WorktreeHolder[] = []
    for (const hold of held) {
      const meets = hold.kind === 'shared' ? inside(hold.key, key) : inside(hold.key, key) || inside(key, hold.key)
      if (meets) met.push(holderOf(hold))
    }
    for (const entry of waiting) if (inside(entry.key, key)) met.push(holderOf(entry))
    return met
  }

  function grant(
    key: string,
    kind: WorktreeHoldKind,
    reason: string,
    options: WorktreeExclusiveOptions = {},
  ): WorktreeHold {
    const entry: Held = {
      key,
      kind,
      reason,
      owner: options.owner ?? null,
      refuseWaiters: options.refuseWaiters === true,
      since: now(),
    }
    held.add(entry)
    const stale = setTimeout(() => {
      if (held.has(entry)) log(`${key}: ${kind} hold (${reason}) held for over ${Math.round(staleAfterMs / 1000)} s`)
    }, staleAfterMs)
    stale.unref?.()
    let released = false
    return {
      key,
      kind,
      release() {
        if (released) return
        released = true
        clearTimeout(stale)
        held.delete(entry)
        // Only an exclusive hold ever kept anyone waiting.
        if (kind === 'exclusive') {
          for (const next of [...waiting]) if (!exclusiveOver(next.key)) next.grant()
        }
      },
    }
  }

  async function acquireShared(path: string, request: WorktreeSharedOptions): Promise<WorktreeHold | WorktreeBusy> {
    const { reason, signal } = request
    const timeoutMs = request.timeoutMs ?? WORKTREE_SHARED_WAIT_MS
    if (signal?.aborted) return { busy: 'Stopped before the worktree was free.' }
    const key = await canonical(path)
    if (signal?.aborted) return { busy: 'Stopped before the worktree was free.' }
    const over = exclusiveOver(key)
    if (!over) return grant(key, 'shared', reason)
    // No "try again": once that step is done the tree is someone else's.
    if (over.refuseWaiters) return { busy: `This worktree is not free: ${over.reason}.` }
    return new Promise((resolve) => {
      const settle = (): void => {
        waiting.delete(entry)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const busyWith = (): string => exclusiveOver(key)?.reason ?? 'another step'
      const entry: Waiting = {
        key,
        reason,
        since: now(),
        grant: () => {
          settle()
          resolve(grant(key, 'shared', reason))
        },
      }
      const timer = setTimeout(() => {
        const blocker = busyWith()
        settle()
        resolve({
          busy: `The worktree is still busy after ${Math.round(timeoutMs / 1000)} seconds (${blocker}). Try again in a moment.`,
        })
      }, timeoutMs)
      const onAbort = (): void => {
        const blocker = busyWith()
        settle()
        resolve({ busy: `Stopped waiting for the worktree (${blocker}).` })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.add(entry)
    })
  }

  async function tryExclusive(
    path: string,
    reason: string,
    options: WorktreeExclusiveOptions = {},
  ): Promise<WorktreeHold | WorktreeBlocked> {
    const key = await canonical(path)
    // Decided and granted in one synchronous step after the only await.
    const blockedBy = blockersOf(key)
    return blockedBy.length > 0 ? { blockedBy } : grant(key, 'exclusive', reason, options)
  }

  async function holders(path: string): Promise<WorktreeHolder[]> {
    const key = await canonical(path)
    const meets = (other: string): boolean => inside(other, key) || inside(key, other)
    return [...held, ...waiting].filter((entry) => meets(entry.key)).map(holderOf)
  }

  return { acquireShared, tryExclusive, holders }
}

/** The owner the worktree pool's own steps take their holds under. */
export const WORKTREE_POOL_OWNER = 'worktree-pool'

/** "This worktree is busy (a terminal is starting in it)": the first hold an exclusive acquire met. */
export function blockedMessage(blocked: WorktreeBlocked): string {
  return `This worktree is busy (${blocked.blockedBy[0]?.reason ?? 'another step'}). Try again in a moment.`
}

/**
 * Whether anything on the live list works inside `path`: a live terminal, the
 * checkout it observes, a chat with a child or a turn. Compared under every
 * spelling (agent-worktree-keep-checks.ts), so one opened through a symlink
 * is still inside.
 */
export async function liveInside(
  path: string,
  livePaths: (() => string[] | Promise<string[]>) | undefined,
): Promise<boolean> {
  const live = ((await livePaths?.()) ?? []).filter(Boolean)
  if (live.length === 0) return false
  const spellings = await pathSpellings(path)
  for (const each of live) if (insideAny(await pathSpellings(each), spellings)) return true
  return false
}

/**
 * The exclusive hold on `path` for a step that changes what is there, once
 * nothing runs in it. The live list is read under the hold, so a start that
 * came between the step's own look and the hold is seen either way: still
 * starting, it holds the path (`blockedBy`); started, it is on the list
 * (`live`). Every mutator goes through this.
 */
export async function holdIfIdle(
  leases: WorktreeLeases,
  path: string,
  reason: string,
  livePaths: (() => string[] | Promise<string[]>) | undefined,
  options: WorktreeExclusiveOptions = {},
): Promise<WorktreeHold | WorktreeBlocked | { live: true }> {
  const hold = await leases.tryExclusive(path, reason, options)
  if ('blockedBy' in hold) return hold
  let live: boolean
  try {
    live = await liveInside(path, livePaths)
  } catch (error) {
    hold.release()
    throw error
  }
  if (!live) return hold
  hold.release()
  return { live: true }
}

/** The process's own: every starter and mutator in main shares it. Tests make their own. */
export const worktreeLeases: WorktreeLeases = createWorktreeLeases()
