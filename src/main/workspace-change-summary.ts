import { readFile } from 'fs/promises'
import { join } from 'path'

import {
  countFileStatuses,
  diffFlags,
  parseNameStatusZ,
  parseNumstatZ,
  readBranchSpan,
  scopeOfSpan,
  type BranchSpan,
} from './git-branch-span'
import { getGitRowSummary } from './git-status'
import { runGitCommand } from './git-utils'
import type { WorkspaceChangeSummary } from '../shared/electron-api'

/**
 * What a workspace's row reports as changed
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The reading is the branch the agent's checkout is on:
 * `merge-base(HEAD, <trunk>) → working tree`. Whatever the person already had
 * committed on the trunk sits on both sides of that base and never enters the
 * number, and a pull, a merge or a commit landing under the agent moves HEAD and
 * the base together, so ordinary repo movement is invisible here by
 * construction. A turn's checkpoints only approximate that: they set aside
 * commits older than the turn when HEAD moved during it, so a commit someone
 * else makes in the same checkout while the turn runs still reads as the turn's.
 *
 * `scope` is the honesty contract, not a debug field. It says how much the
 * caller is entitled to claim, and the row's tooltip and spoken label are
 * derived from it:
 *
 * - `worktree` — a LINKED worktree, so nothing else writes into this checkout.
 *   The numbers are this chat's work.
 * - `branch`   — a shared checkout on a branch that is NOT the trunk, carrying
 *   commits the trunk does not. The numbers are the BRANCH's work, which may
 *   include commits a person or another chat made on it.
 * - `folder`   — a shared checkout with no branch work to attribute: on the
 *   trunk itself, detached, or with no trunk to compare against. All that can
 *   honestly be said is what is uncommitted.
 *
 * The rule this file exists to enforce, inherited from the reading it replaced
 * and restored after a review found it missing: **never report a confident zero
 * for a span we could not read.** The row draws nothing for zeros, so an
 * unreadable span reported as zero would silently claim "this agent changed
 * nothing" about work it merely failed to measure.
 */
export async function getWorkspaceChangeSummary(
  input: { checkoutPath: string },
  deps: { summaries?: CheckoutSummaryShare } = {},
): Promise<WorkspaceChangeSummary> {
  return (deps.summaries ?? defaultCheckoutSummaries).read(input.checkoutPath)
}

/**
 * The pure half: a span becomes a summary. Separated so the scope rule — the one
 * thing a reviewer needs to check — tests without a repo.
 */
export function summaryFromSpan(span: BranchSpan | null, untracked: readonly string[] = []): WorkspaceChangeSummary {
  if (!span) {
    return { branch: null, additions: 0, deletions: 0, changedFiles: 0, scope: 'folder' }
  }
  // A file the agent just created is "1 file added" to the person reading the
  // row, so untracked work counts here even though `git diff` cannot see it. The
  // paths are de-duplicated against the span's own files for the case that would
  // otherwise double-count: a file deleted on the branch and re-created on disk
  // is one path, one file.
  const known = new Set(span.stat.files.map((file) => file.path))
  const added = untracked.filter((path) => !known.has(path)).length
  return {
    branch: span.branch,
    // LINE counts stay git's tracked diff — the diff surfaces read them, and a
    // file git has never seen has no diff to report.
    additions: span.stat.additions,
    deletions: span.stat.deletions,
    changedFiles: span.stat.changedFiles + added,
    // The shared rule, not a local copy — the step strip renders the same span
    // and must say the same thing about it.
    scope: scopeOfSpan(span),
    // Absent rather than zeros when the status pass failed: the line draws
    // nothing for a breakdown it does not have, and must not be told the branch
    // touched no files when it merely could not be asked.
    ...(span.stat.counts ? { files: { ...span.stat.counts, added: span.stat.counts.added + added } } : {}),
  }
}

/**
 * One reading for one checkout: the branch span, or the folder's own numbers
 * when the span could not be measured.
 *
 * The fallback is deliberately the FOLDER reading rather than zeros. A locked
 * index, a bare repo or a corrupt object makes `git diff <base>` fail, and the
 * quiet, unattributed folder number is the honest thing to show there — the same
 * degrade the checkpoint reading made for an unresolvable ref.
 */
async function readCheckoutSummary(checkoutPath: string): Promise<WorkspaceChangeSummary> {
  const span = await readBranchSpan(checkoutPath)
  // Not a repository at all (or the path is gone): no span, and no git spawned
  // for an uncommitted reading that cannot exist either.
  if (!span) return summaryFromSpan(span)

  // ONE listing, read beside the uncommitted diff rather than after it, and
  // shared by both readings: the span counts these files as added, and the
  // uncommitted reading counts them AND reads their lines.
  const listing = listUntracked(checkoutPath)
  const uncommitted = await readUncommitted(checkoutPath, listing)
  const base = span.readable ? summaryFromSpan(span, (await listing) ?? []) : await folderFallback(checkoutPath, span)
  // Absent, never zeros: a reading we could not take must not tell the line
  // "nothing is uncommitted here", which for a landed branch is the whole
  // number it draws.
  return uncommitted ? { ...base, uncommitted } : base
}

async function folderFallback(checkoutPath: string, span: BranchSpan): Promise<WorkspaceChangeSummary> {
  const folder = await getGitRowSummary(checkoutPath)
  return {
    branch: span.branch ?? folder.branch,
    additions: folder.additions,
    deletions: folder.deletions,
    changedFiles: 0,
    scope: 'folder',
  }
}

/** An untracked file bigger than this is counted as a file with no lines. */
const UNTRACKED_COUNT_LIMIT_BYTES = 1_000_000
/**
 * How many untracked files are opened to count their lines. A build output
 * directory someone forgot to ignore is thousands of files; listing them is one
 * cheap git call, but reading them all is thousands of file opens on main's
 * event loop, once per checkout per sweep. Past the cap the files are still
 * COUNTED — `changedFiles` stays honest — and simply contribute no lines.
 */
const UNTRACKED_COUNT_MAX_FILES = 500
/** How many of those reads are open at once (macOS's default fd limit is low). */
const UNTRACKED_COUNT_BATCH = 16

type UncommittedReading = NonNullable<WorkspaceChangeSummary['uncommitted']>

/**
 * Every file git has never seen, repo-root-relative.
 *
 * Untracked files are structurally invisible to `diff` — git has no content to
 * compare — yet a file an agent just created is exactly the work both readings
 * exist to show. `--full-name` for the same reason the diffs carry
 * `--no-relative`: a workspace opened on a SUBDIRECTORY must answer about the
 * whole repo, in paths the diff halves agree with.
 *
 * Null means the listing itself failed; the callers then leave untracked work
 * out rather than guessing at it.
 */
async function listUntracked(cwd: string): Promise<string[] | null> {
  // Never rejects: the promise is handed to two callers and one of them (an
  // unreadable span) may never await it, where a rejection would surface as an
  // unhandled one in main.
  const listed = await runGitCommand(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])
  if (!listed.ok) return null
  return listed.stdout.split('\0').filter((path) => path.length > 0)
}

/**
 * The checkout's UNCOMMITTED changes alone: index + worktree against HEAD, plus
 * untracked files as additions. What the sidebar line shows once its branch has
 * landed by SQUASH — where the merge base never moves, so the span keeps
 * reporting work that is already on the trunk (decision 2 of the plan).
 *
 * **Why this is not `diffBranchSelection(cwd, { kind: 'uncommitted' })`**, which
 * produces exactly this shape and is the reading the changed-files panel draws:
 * that path re-runs `readBranchFacts` — the whole trunk-resolution chain, on the
 * order of twenty git spawns — for one fact (is HEAD unborn?) that this caller
 * does not need. `readBranchFacts` exists precisely because paying for a span to
 * get facts was measured as ~137ms of waste per refresh; paying for facts to get
 * a diff is the same mistake mirrored. What IS reused is `parseNumstatZ`, the
 * one tested `-z` framing (a rename emits three NUL-terminated fields, not one),
 * so the two readings cannot disagree about what a diff says.
 *
 * `getGitRowSummary` was the other candidate and does not fit: it reports no
 * `changedFiles`, no untracked files, and re-reads the branch name we already
 * have.
 *
 * Three cheap git calls in flight together — the numstat and the name-status
 * halves of ONE diff, and the untracked listing the span reading shares — and a
 * fourth only when there is untracked work to place; all inside
 * `readCheckoutSummary`, so the per-checkout share still means ten rows on one
 * checkout cost one reading between them.
 *
 * Null means unreadable — a bare repo, an unborn HEAD, a locked index — and the
 * caller leaves the field ABSENT rather than reporting zeros.
 */
async function readUncommitted(
  cwd: string,
  /**
   * The untracked listing, handed over as a PROMISE so it overlaps the two diffs
   * below instead of following them — and so one listing serves both this
   * reading and the span's.
   */
  untracked: Promise<string[] | null>,
): Promise<UncommittedReading | null> {
  // Literally the span's own flags (`diffFlags`), not a copy of them:
  // `--no-relative` because a workspace can be opened on a SUBDIRECTORY of its
  // repo, where the user's `diff.relative=true` would both under-count and hand
  // back paths that no other surface here agrees with, and `--find-renames` so a
  // moved file is one `updated` rather than a removed plus an added.
  const [diff, nameStatus] = await Promise.all([
    runGitCommand(cwd, [...diffFlags('--numstat'), 'HEAD', '--']),
    // The status half of the same diff, asked beside it rather than after it:
    // two spawns that overlap cost one spawn's latency.
    runGitCommand(cwd, [...diffFlags('--name-status'), 'HEAD', '--']),
  ])
  // Includes the unborn HEAD, where `git diff HEAD` has nothing to resolve. The
  // span already reports that repo's staged work against the empty tree, and a
  // branch with no commit at all cannot have landed, so the field is simply
  // absent there rather than costing a second resolution to fake.
  if (!diff.ok) return null

  const tracked = parseNumstatZ(diff.stdout)
  const reading: UncommittedReading = {
    additions: tracked.additions,
    deletions: tracked.deletions,
    changedFiles: tracked.changedFiles,
  }
  // Driven by the numstat file list, so the breakdown sums to `changedFiles`
  // whatever the status pass says — including a file that is staged-deleted AND
  // back on disk untracked, which git reports once as `D` and which the
  // untracked listing below then skips.
  if (nameStatus.ok) {
    reading.files = countFileStatuses(tracked.files, parseNameStatusZ(nameStatus.stdout))
  }

  const listed = await untracked
  if (!listed) return reading
  const known = new Set(tracked.files.map((file) => file.path))
  const paths = listed.filter((path) => !known.has(path))
  if (paths.length === 0) return reading
  reading.changedFiles += paths.length
  // A file git has never seen is an added file — the only status it can have —
  // and counting it here is what keeps the breakdown summing to `changedFiles`
  // now that the count includes untracked work.
  if (reading.files) reading.files.added += paths.length

  // `--full-name` paths are repo-root-relative, so reading them off disk starts
  // at the toplevel and not at a cwd that may be a subdirectory. Asked only when
  // there is something to read.
  const toplevel = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
  const root = (toplevel.ok && toplevel.stdout.trim()) || cwd

  const counted = paths.slice(0, UNTRACKED_COUNT_MAX_FILES)
  for (let index = 0; index < counted.length; index += UNTRACKED_COUNT_BATCH) {
    const batch = counted.slice(index, index + UNTRACKED_COUNT_BATCH)
    const lines = await Promise.all(batch.map((path) => countLines(join(root, path))))
    for (const count of lines) reading.additions += count
  }
  return reading
}

/**
 * A new file's lines. Capped, and zero for anything binary or unreadable: a
 * binary blob is one changed file carrying no lines, which is what `git diff`
 * itself says about one. Line endings are irrelevant — splitting on `\n` counts
 * a CRLF file the same way git does.
 */
async function countLines(absolutePath: string): Promise<number> {
  try {
    const buffer = await readFile(absolutePath)
    if (buffer.byteLength > UNTRACKED_COUNT_LIMIT_BYTES) return 0
    // A NUL byte near the start is git's own binary heuristic.
    if (buffer.subarray(0, 8000).includes(0)) return 0
    const text = buffer.toString('utf8')
    if (text.length === 0) return 0
    const lines = text.split('\n').length
    return text.endsWith('\n') ? lines - 1 : lines
  } catch {
    // A symlink to nowhere, a file deleted between the listing and the read, a
    // permission we do not have: no lines, still a file.
    return 0
  }
}

/**
 * One read per CHECKOUT per sweep, shared by every row that resolves to it.
 *
 * This is the per-folder dedupe that `workspace-scoped-row-diff` deleted,
 * deliberately restored and re-keyed (epic decision 7). Removing it was correct
 * under the checkpoint model, where ten chats on one repo genuinely had ten
 * different answers and sharing one would have been the bug the epic existed to
 * fix. Under the branch model two chats sharing a checkout genuinely have the
 * SAME answer — that is the premise of the design — so one read serving both is
 * correct, and the alternative is ten identical `git diff` runs a minute.
 *
 * It caches the SUMMARY, not the span: a span carries the whole per-file list,
 * which nothing here reads and which would then be retained per checkout for the
 * life of the process. Expired entries are dropped on the next read rather than
 * left in the map, so what is retained is bounded by the checkouts currently
 * being polled and not by every checkout ever polled.
 *
 * A read is shared while in flight and held for `holdMs` after it settles, which
 * covers a sweep's serial tail at the poll's concurrency of four; the next sweep
 * always gets a fresh read. The hold is measured from settle rather than start on
 * purpose — a slow read on a large repo must not expire while the rows queued
 * behind it are still arriving.
 *
 * A rejected read is forgotten immediately, so a transient failure never pins an
 * error onto every row of the checkout for the hold window.
 */
export type CheckoutSummaryShare = {
  read: (checkoutPath: string) => Promise<WorkspaceChangeSummary>
  /**
   * Forget a SETTLED reading, so the next read is fresh. Called when the
   * checkout's git files moved (git-repo-watch.ts): the views are told to
   * re-read at that moment, and being served the hold's copy of the reading
   * they were told is stale would make the event buy nothing. An in-flight read
   * is kept — it started after the change or it is about to be replaced.
   */
  invalidate: (checkoutPath: string) => void
}

/**
 * Twenty-two and a half seconds, halved from forty-five (owner, 2026-09-10)
 * when the sidebar's sweep halved to thirty. It was raised from fifteen to
 * forty-five on 2026-09-05 because the share was then read from the network as
 * well as the sidebar, and a short hold meant every one of those asks re-ran
 * the whole branch-span chain (about twenty git spawns per checkout, each spawn
 * a synchronous step on main's event loop).
 *
 * The number is not free and it is not arbitrary. It was sized to stay UNDER
 * the sidebar's thirty-second sweep, or every other sweep would have been
 * served the reading it was run to replace. The sidebar no longer sweeps on a
 * clock: it re-reads a checkout when git-repo-watch.ts reports it changed, and
 * that report drops the held reading first (`invalidate`), so the hold now
 * only ever serves readers asking about a checkout that has NOT changed — the
 * Remote band, the phone, two windows showing one checkout.
 */
const CHECKOUT_SUMMARY_HOLD_MS = 22_500
/**
 * How many checkouts are read at once, across every caller of the share. The
 * sidebar queued its own reads four wide; the network path fanned out to every
 * distinct checkout at once, which on a sixteen-checkout registry was sixteen
 * git chains spawning in parallel on the event loop. One queue for both.
 */
const CHECKOUT_SUMMARY_CONCURRENCY = 4
/**
 * How long an in-flight read is shared before a newcomer starts its own. A
 * `git diff` hung on a spun-down volume must not pin every row of that checkout,
 * in every window, for the life of main — this keeps that worst case per read
 * rather than per checkout.
 */
const CHECKOUT_SUMMARY_IN_FLIGHT_MAX_MS = 60_000

export function createCheckoutSummaryShare(
  read: (checkoutPath: string) => Promise<WorkspaceChangeSummary>,
  options: { holdMs?: number; inFlightMaxMs?: number; concurrency?: number; now?: () => number } = {},
): CheckoutSummaryShare {
  const holdMs = options.holdMs ?? CHECKOUT_SUMMARY_HOLD_MS
  const inFlightMaxMs = options.inFlightMaxMs ?? CHECKOUT_SUMMARY_IN_FLIGHT_MAX_MS
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? CHECKOUT_SUMMARY_CONCURRENCY))
  const now = options.now ?? Date.now
  type Entry = {
    promise: Promise<WorkspaceChangeSummary>
    startedAt: number
    settledAt: number | null
  }
  const reads = new Map<string, Entry>()

  // The one queue every reader shares: a read past the concurrency waits for
  // a slot rather than spawning beside the others. Waiting reads are still
  // shared by key, so a checkout asked for twice while queued is read once.
  let running = 0
  const waiting: Array<() => void> = []
  function acquire(): Promise<void> {
    if (running < concurrency) {
      running += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiting.push(resolve))
  }
  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
  async function limitedRead(checkoutPath: string): Promise<WorkspaceChangeSummary> {
    await acquire()
    try {
      return await read(checkoutPath)
    } finally {
      release()
    }
  }

  function shareable(entry: Entry, at: number): boolean {
    return entry.settledAt === null ? at - entry.startedAt < inFlightMaxMs : at - entry.settledAt < holdMs
  }

  // Rows on one checkout arrive with whatever path their workspace stores;
  // a trailing slash or a Windows separator must not split the share.
  const keyOf = (checkoutPath: string): string => checkoutPath.replace(/\\/g, '/').replace(/\/+$/u, '')

  return {
    invalidate(checkoutPath) {
      const key = keyOf(checkoutPath)
      const entry = reads.get(key)
      if (entry && entry.settledAt !== null) reads.delete(key)
    },
    read(checkoutPath) {
      const key = keyOf(checkoutPath)
      const at = now()
      // Opportunistic prune: the map is small (one entry per polled checkout),
      // so this costs nothing and keeps a closed workspace's entry from being
      // retained until the process ends.
      for (const [existingKey, entry] of reads) {
        if (!shareable(entry, at)) reads.delete(existingKey)
      }
      const existing = reads.get(key)
      if (existing) return existing.promise

      const entry: Entry = { promise: limitedRead(checkoutPath), startedAt: at, settledAt: null }
      entry.promise.then(
        () => {
          entry.settledAt = now()
        },
        () => {
          if (reads.get(key) === entry) reads.delete(key)
        },
      )
      reads.set(key, entry)
      return entry.promise
    },
  }
}

const defaultCheckoutSummaries = createCheckoutSummaryShare(readCheckoutSummary)

/** Drop the held reading for a checkout whose git files just moved. */
export function invalidateCheckoutSummary(checkoutPath: string): void {
  defaultCheckoutSummaries.invalidate(checkoutPath)
}
