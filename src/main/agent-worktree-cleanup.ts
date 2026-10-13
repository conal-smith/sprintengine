import type {
  AgentWorktreeCleanupEntry,
  AgentWorktreeCleanupInput,
  AgentWorktreeCleanupReport,
} from '../shared/ipc/git'
import { isStudioBranch, studioBranchPrefixes } from '../shared/worktree-branch'
import { repoRootFromWorktreePath } from '../shared/worktree-paths'
import type { GitCommandResult, GitWorktreeEntry } from './git'
import { normalizeComparablePath, pathExists, runGitCommand } from './git-utils'
import { listGitWorktrees } from './git-worktree-list'
import { resolveRepoRoot } from './git-worktree-validation'
import { lockAgentWorktree, relockWorktree } from './agent-worktree-lock'
import { worktreeBranchPrefix } from './worktree-branch-prefix'
import { withWorktreeRegistryLock } from './worktree-registry-lock'
import type { WorktreePoolReturnInput, WorktreePoolSweepEntry } from './worktree-pool/worktree-pool-service'
import {
  adminDirWrittenAt,
  hiddenEditPaths,
  ignoredPathsAtRisk,
  insideAny,
  pathInside,
  pathSpellings,
  worktreeLastUsedAt,
} from './agent-worktree-keep-checks'

/**
 * Removes the agent worktrees nobody needs any more, and nothing else.
 *
 * Agent worktrees used to be created and never removed: every agent spawned
 * "with a worktree" left a checkout (and usually a gigabyte of dependencies)
 * behind for good. This is the sweep that reclaims them, and it is built to be
 * safe to run unattended, which means every rule below errs towards keeping.
 *
 * A worktree is removed only when ALL of these hold:
 *
 * 1. **It is an agent worktree.** It lives in the app's own worktree container
 *    (`.sprintengine-worktrees`) and is on one of Studio's branches: under the
 *    person's branch prefix or under `agent/`, the prefix there was before it
 *    could be chosen (`isStudioBranch`). With no prefix a branch says nothing
 *    about who made it, so a worktree on any other branch is an agent's only
 *    when it carries this profile's agent lock, which only Studio places, as
 *    it makes one. Every other worktree goes by the stricter rules for other
 *    worktrees below.
 * 2. **Nothing uses it.** No path the caller protects — every workspace's
 *    folder and worktree, every agent still holding one — and no live terminal
 *    session sits in it. Paths are compared with symlinks resolved on both
 *    sides (git records a worktree's resolved path; the app records whatever
 *    was opened), and case-folded on macOS and Windows. The caller's list is
 *    read per repository, after the listing, so it is never older than what it
 *    is checked against.
 * 3. **No other owner has locked it.** Every agent worktree is locked as it is
 *    created (agent-worktree-lock.ts), which is what protects it from another
 *    Studio profile's sweep, and from this one's between reading its records
 *    and listing the repository. A lock this profile placed is released here
 *    once the path is no longer protected (it is unlocked right before the
 *    removal, and locked again if the removal does not go through). Another
 *    profile's lock, or one a person placed, keeps the worktree. An unattended
 *    sweep (`ownedOnly`) goes further and takes nothing this profile did not
 *    lock: an unlocked agent worktree may belong to another profile on an
 *    older build, so only a person's cleanup from the Worktree manager decides
 *    on it. One this profile uses and finds unlocked, it locks.
 * 4. **It is registered and present.** A missing or prunable one is reported
 *    and left for `worktree prune`, which the person runs.
 * 5. **Git has not touched it for an hour.** Its admin directory
 *    (`<common>/worktrees/<name>`) was last written more than an hour ago: a
 *    new worktree is clean and has no commits, so without this it would
 *    qualify the moment it exists, before any owner is recorded.
 * 6. **It is clean.** `git status` reports nothing, untracked files included.
 * 7. **Its work is on the default branch** (`origin/HEAD`, else `origin/main`
 *    or `origin/master`; with no remote, the local `main` or `master`). Either
 *    its HEAD has no commit the default branch lacks (a branch that never got
 *    a commit has none by definition), or — for a squash-merged branch, whose
 *    commits are not on the trunk by hash — merging it into the default
 *    branch would produce the default branch's own tree, so its changes are
 *    already there (`changesAlreadyIn`). On a git too old for that test the
 *    ancestry rule alone decides, and a squash-merged branch is kept.
 *    An agent worktree nothing uses is taken unmerged too (owner ruling
 *    2026-10-08: a settled chat counts as deleted): its commits stay on its
 *    branch, which the branch cleanup below never deletes while unmerged,
 *    exactly as a pool slot's do when the pool takes it back.
 * 8. **Nothing git does not show would be lost.** No tracked file is hidden
 *    from `status` by `--assume-unchanged` or `--skip-worktree`, and every
 *    ignored file is either rebuildable output (dependencies, build output,
 *    caches) or a `.worktreeinclude` copy still identical to the source
 *    checkout's (agent-worktree-keep-checks.ts). An edited `.env`, notes in an
 *    ignored folder, a `*.local` scratch file: each keeps the worktree.
 *
 * The removal itself is `git worktree remove` WITHOUT `--force`, so git checks
 * cleanliness again at the moment of removal: anything written between the
 * check above and the removal makes git refuse, and the sweep reports the
 * refusal. The branch itself is kept by the removal.
 *
 * **Every other worktree of the repository** (owner ruling 2026-10-08): one
 * made by hand, by an agent CLI on its own (`.claude/worktrees/…`), in the
 * Worktree manager, or by an automation run that never finished. They used to
 * be left alone for good, and a busy repository gathered dozens of them, each
 * a full checkout. Such a worktree goes by rules 2 and 4 to 8 like an agent
 * worktree, with these differences:
 *
 * - **Any lock keeps it.** Nothing here locked it, so nobody here may lift it.
 * - **It was last used more than a day ago** (`OTHER_WORKTREE_MIN_IDLE_MS`),
 *   by its index and HEAD (`worktreeLastUsedAt`), on top of rule 5. A person
 *   who just merged a branch may still be reading it.
 * - **Unmerged work goes too, after a week unused**
 *   (`UNMERGED_WORKTREE_MIN_IDLE_MS`), when its HEAD is on a branch, or on a
 *   commit some branch or remote branch holds. Removing a worktree never
 *   deletes its branch (this sweep deletes only Studio's merged branches), so
 *   every commit stays where it was and the branch can be checked out again;
 *   what a removal could lose (uncommitted, hidden and ignored work) keeps it
 *   by rules 6 and 8 as before. A detached HEAD on commits no ref holds is kept.
 * - **It is never locked for being in use.** Being found in use keeps it.
 *
 * It is taken unattended too: the lock rule in 3 exists to tell one Studio
 * profile's agent worktrees from another's, and no profile owns these. The
 * main checkout, and any worktree it sits inside, is never one.
 *
 * **Worktree pool slots** (worktree-pool/) are never removed here. The pool
 * owns them: a slot nobody uses is handed back to it, which detaches it and
 * keeps its ignored files for the next agent, or holds it when it still has
 * work in it. The pool's own rules decide (`returnUnused`); this sweep only
 * supplies what the app's records use, and reports what the pool did.
 *
 * **Merged agent branches** are deleted afterwards (owner ruling 2026-10-05):
 * one of Studio's branches (under the person's prefix or `agent/`; never one
 * with no prefix, since nothing records which of those Studio made) that no
 * worktree has checked out, that no record of the
 * app's names (`keepBranches`: a chat is restored from its branch), and whose
 * work is on the default branch by rule 7 holds nothing anyone still needs.
 * Git itself refuses to delete a branch some worktree has checked out at that
 * moment. A caller that names no records deletes nothing.
 *
 * Every decision is logged, removals and keeps alike.
 */

export type AgentWorktreeCleanupDeps = {
  runGit?: (cwd: string, args: string[]) => Promise<GitCommandResult>
  listWorktrees?: (repoRoot: string) => Promise<GitWorktreeEntry[] | null>
  resolveRoot?: (repoRoot: string) => Promise<string | null>
  exists?: (path: string) => Promise<boolean>
  /** Working directories of the live terminal sessions and chat sessions, which are never removed from under. */
  livePaths?: () => string[] | Promise<string[]>
  /** When git last wrote the worktree's admin directory, in ms since the epoch; null when unknown. */
  lastWrittenAt?: (worktreePath: string) => Promise<number | null>
  /** When the worktree was last used (its index or HEAD moved), in ms since the epoch; null when unknown. */
  lastUsedAt?: (worktreePath: string) => Promise<number | null>
  /** The worktree pool, which takes back its own slots instead of the sweep removing them. */
  pool?: {
    /** Reads the pool's records; nothing is known to be a slot before it settles. */
    load(): Promise<void>
    ownsPath(path: string): boolean
    returnUnused(input: WorktreePoolReturnInput): Promise<WorktreePoolSweepEntry[]>
  } | null
  now?: () => number
  log?: (line: string) => void
  /**
   * The ids of every chat on record that is not settled, or null when
   * unknown: a worktree holding one's history is kept (agent-worktree-keep-checks.ts).
   * A settled chat counts as deleted, and its history keeps nothing.
   */
  knownWorkspaceIds?: () => Iterable<string> | null
  /** The person's worktree branch prefix; the process's own (`worktree-branch-prefix.ts`) unless given. */
  branchPrefix?: () => string
}

const DEFAULT_REF_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']
/** How long git must have left a worktree alone before the sweep may take it. */
export const AGENT_WORKTREE_MIN_IDLE_MS = 60 * 60_000
/** How long a worktree the app did not make must have gone unused before the sweep may take it. */
const OTHER_WORKTREE_MIN_IDLE_MS = 24 * 60 * 60_000
/** How long such a worktree holding work the default branch lacks must have gone unused. */
const UNMERGED_WORKTREE_MIN_IDLE_MS = 7 * 24 * 60 * 60_000

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown
}

async function resolveDefaultRef(
  repoRoot: string,
  runGit: NonNullable<AgentWorktreeCleanupDeps['runGit']>,
): Promise<string | null> {
  const originHead = await runGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const named = originHead.ok ? originHead.stdout.trim().replace(/^refs\/remotes\//, '') : ''
  for (const candidate of named ? [named, ...DEFAULT_REF_CANDIDATES] : DEFAULT_REF_CANDIDATES) {
    const verified = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (verified.ok && verified.stdout.trim()) return candidate
  }
  return null
}

/** Some local or remote branch holds `head`, so removing a detached worktree loses none of its commits. */
async function headOnSomeRef(
  cwd: string,
  head: string,
  runGit: NonNullable<AgentWorktreeCleanupDeps['runGit']>,
): Promise<boolean> {
  const refs = await runGit(cwd, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    `--contains=${head}`,
    'refs/heads',
    'refs/remotes',
  ])
  return refs.ok && refs.stdout.trim().length > 0
}

/**
 * Whether merging `head` into `defaultRef` would change nothing — that is,
 * every change on the branch is already on the default branch, however it got
 * there (a squash merge, a rebase-and-merge, a cherry-pick).
 *
 * `git merge-tree --write-tree` performs the merge in memory and prints the
 * resulting tree without touching a ref, the index or a working tree. If that
 * tree is the default branch's own tree, removing the worktree loses nothing
 * the default branch does not already hold.
 *
 * Anything short of a clean answer is "not merged": a conflict (exit 1), an
 * unreadable result, or a git older than 2.38 that does not know
 * `--write-tree` (it fails with a usage error). The caller then keeps the
 * ancestry rule's verdict, which only ever keeps more.
 */
export async function changesAlreadyIn(
  cwd: string,
  defaultRef: string,
  head: string,
  runGit: NonNullable<AgentWorktreeCleanupDeps['runGit']>,
): Promise<boolean> {
  const merged = await runGit(cwd, ['merge-tree', '--write-tree', defaultRef, head])
  if (!merged.ok) return false
  const mergedTree = merged.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  if (!/^[0-9a-f]{40,64}$/i.test(mergedTree)) return false
  const defaultTree = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${defaultRef}^{tree}`])
  if (!defaultTree.ok) return false
  return defaultTree.stdout.trim() === mergedTree
}

export async function cleanupAgentWorktrees(
  input: AgentWorktreeCleanupInput,
  deps: AgentWorktreeCleanupDeps = {},
): Promise<AgentWorktreeCleanupReport> {
  const runGit = deps.runGit ?? ((cwd: string, args: string[]) => runGitCommand(cwd, args))
  const log = deps.log ?? ((line: string) => console.info(`[worktree-cleanup] ${line}`))
  const exists = deps.exists ?? pathExists
  const dryRun = input.dryRun === true
  const empty = (repoRoot: string, defaultRef: string | null = null): AgentWorktreeCleanupReport => ({
    repoRoot,
    defaultRef,
    entries: [],
    dryRun,
  })

  const root = deps.resolveRoot
    ? await deps.resolveRoot(input.repoRoot)
    : await resolveRepoRoot(input.repoRoot).then((result) => (result.ok ? result.data : null))
  if (!root) return empty(input.repoRoot)

  const worktrees = deps.listWorktrees
    ? await deps.listWorktrees(root)
    : await listGitWorktrees(root, { resolvedRoot: true }).then((result) => (result.ok ? result.data.worktrees : null))
  if (!worktrees) return empty(root)

  const pool = deps.pool ?? null
  // A slot the pool's records were not yet read for would look like any other
  // agent worktree here, and be removed from under its lease.
  await pool?.load()
  // Read once per sweep, so every decision in it goes by the same prefix.
  const branchPrefix = (deps.branchPrefix ?? worktreeBranchPrefix)()
  const isAgentWorktree = (worktree: GitWorktreeEntry): boolean =>
    repoRootFromWorktreePath(worktree.path) !== null &&
    (isStudioBranch(worktree.branch, branchPrefix) || worktree.agentLock === 'this-profile')
  // Git lists the main working tree first, whichever checkout asked: a sweep
  // run from a workspace opened on a worktree still never takes the main one.
  const candidates = worktrees.filter(
    (worktree, index) =>
      index > 0 && !worktree.bare && !pathInside(root, worktree.path) && !pool?.ownsPath(worktree.path),
  )

  const defaultRef = await resolveDefaultRef(root, runGit)
  const lastWrittenAt = deps.lastWrittenAt ?? ((path: string) => adminDirWrittenAt(path, runGit))
  const lastUsedAt = deps.lastUsedAt ?? ((path: string) => worktreeLastUsedAt(path, runGit))
  const now = deps.now ?? Date.now
  // Read after the listing, so a worktree listed above was either created
  // before these were read (and is in them if it is used) or is too new to
  // pass the idle rule. Each spelled with and without symlinks resolved.
  const protectedSpellings = await Promise.all(
    [...input.protectedPaths, ...((await deps.livePaths?.()) ?? [])].filter(Boolean).map((path) => pathSpellings(path)),
  )
  const entries: AgentWorktreeCleanupEntry[] = []
  const record = (entry: AgentWorktreeCleanupEntry): void => {
    entries.push(entry)
    const facts = [
      entry.uniqueCommits !== undefined ? `${entry.uniqueCommits} commit(s) not on ${defaultRef}` : null,
      entry.changedPaths !== undefined ? `${entry.changedPaths} changed path(s)` : null,
      entry.detail ?? null,
    ].filter(Boolean)
    log(
      `${dryRun && entry.verdict === 'removed' ? 'would remove' : entry.verdict === 'removed' ? 'removed' : `kept (${entry.verdict})`} ${entry.path} [${entry.branch ?? 'detached'}]${facts.length ? ` — ${facts.join('; ')}` : ''}`,
    )
  }

  for (const worktree of candidates) {
    const base = { path: worktree.path, branch: worktree.branch }
    const agent = isAgentWorktree(worktree)
    // Something sits IN it. A protected path that merely contains it (a
    // workspace opened on a parent folder) does not use it.
    const worktreeSpellings = await pathSpellings(worktree.path)
    if (protectedSpellings.some((spellings) => insideAny(spellings, worktreeSpellings))) {
      // A worktree this profile uses that carries no lock (made before
      // creation locked them, or its lock failed) is locked now, so that it is
      // protected from other profiles and can be released like any other.
      if (agent && !worktree.locked && !dryRun) {
        await lockAgentWorktree(root, worktree.path, worktree.branch ?? 'adopted', runGit)
      }
      record({ ...base, verdict: 'in-use' })
      continue
    }
    // This profile's own in-use lock on a path its records no longer use is a
    // released one; every other lock is somebody else's to lift.
    const ownLock = agent && worktree.locked && worktree.agentLock === 'this-profile'
    if (worktree.locked && !ownLock) {
      record({ ...base, verdict: 'locked', detail: worktree.lockedReason ?? undefined })
      continue
    }
    // Unattended, only a worktree this profile locked and released is taken.
    // An unlocked one may belong to another profile running an older build, or
    // to anything outside the app, and nothing on disk says which: it is left
    // for a person to judge from the Worktree manager's cleanup report.
    if (agent && input.ownedOnly === true && !ownLock) {
      record({ ...base, verdict: 'not-owned', detail: 'not locked by this profile; left to a manual cleanup' })
      continue
    }
    if (worktree.prunable || !(await exists(worktree.path))) {
      record({ ...base, verdict: 'missing' })
      continue
    }
    const writtenAt = await lastWrittenAt(worktree.path)
    if (writtenAt === null) {
      record({ ...base, verdict: 'error', detail: 'could not read when git last used it' })
      continue
    }
    if (now() - writtenAt < AGENT_WORKTREE_MIN_IDLE_MS) {
      record({ ...base, verdict: 'recent', detail: 'git used it within the last hour' })
      continue
    }
    let otherUsedAt: number | null = null
    if (!agent) {
      const usedAt = await lastUsedAt(worktree.path)
      otherUsedAt = usedAt
      if (usedAt === null) {
        record({ ...base, verdict: 'error', detail: 'could not read when it was last used' })
        continue
      }
      if (now() - usedAt < OTHER_WORKTREE_MIN_IDLE_MS) {
        record({ ...base, verdict: 'recent', detail: 'used within the last day' })
        continue
      }
    }
    const status = await runGit(worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!status.ok) {
      record({ ...base, verdict: 'error', detail: status.message ?? 'git status failed' })
      continue
    }
    const changedPaths = status.stdout.split('\0').filter(Boolean).length
    if (changedPaths > 0) {
      record({ ...base, verdict: 'dirty', changedPaths })
      continue
    }
    if (!defaultRef) {
      record({ ...base, verdict: 'no-default-branch' })
      continue
    }
    const head = worktree.head ?? 'HEAD'
    const unique = await runGit(worktree.path, ['rev-list', '--count', `${defaultRef}..${head}`])
    const uniqueCommits = unique.ok ? Number.parseInt(unique.stdout.trim(), 10) : Number.NaN
    if (!Number.isFinite(uniqueCommits)) {
      record({ ...base, verdict: 'error', detail: unique.message ?? 'could not count commits' })
      continue
    }
    // Commits the default branch lacks by hash may still be there by content:
    // a squash merge lands the same changes as one new commit.
    const mergedByContent = uniqueCommits > 0 && (await changesAlreadyIn(worktree.path, defaultRef, head, runGit))
    if (uniqueCommits > 0 && !mergedByContent) {
      // The commits outlive the worktree on its branch. An agent worktree
      // nothing uses any more (its chat settled or was deleted) goes now, as a
      // pool slot does; another worktree once it has gone unused for a week,
      // and never with commits only its detached HEAD holds.
      const idleLongEnough = otherUsedAt !== null && now() - otherUsedAt >= UNMERGED_WORKTREE_MIN_IDLE_MS
      const kept = agent
        ? !worktree.branch
        : !idleLongEnough || !(worktree.branch || (await headOnSomeRef(worktree.path, head, runGit)))
      if (kept) {
        record({ ...base, verdict: 'unmerged', uniqueCommits })
        continue
      }
    }
    // What `status` cannot see and `worktree remove` would still delete.
    const hidden = await hiddenEditPaths(worktree.path, runGit)
    if (!hidden.ok) {
      record({ ...base, verdict: 'error', detail: hidden.message })
      continue
    }
    if (hidden.paths.length > 0) {
      record({ ...base, verdict: 'hidden-edits', changedPaths: hidden.paths.length, detail: listed(hidden.paths) })
      continue
    }
    const ignored = await ignoredPathsAtRisk(root, worktree.path, runGit, {
      knownWorkspaceIds: deps.knownWorkspaceIds ?? null,
    })
    if (!ignored.ok) {
      record({ ...base, verdict: 'error', detail: ignored.message })
      continue
    }
    if (ignored.paths.length > 0) {
      record({ ...base, verdict: 'ignored-files', changedPaths: ignored.paths.length, detail: listed(ignored.paths) })
      continue
    }
    const how = mergedByContent
      ? 'changes already on the default branch (squash-merged)'
      : uniqueCommits > 0
        ? `unused for a week; its ${uniqueCommits} commit(s) stay on ${worktree.branch ?? 'the branches that hold them'}`
        : undefined
    if (dryRun) {
      record({ ...base, verdict: 'removed', detail: how })
      continue
    }
    // The checks above take a while on a big worktree: a terminal opened in it
    // meanwhile, or a chat's session started there, is asked about once more,
    // the last thing before it goes.
    const liveNow = await Promise.all(
      ((await deps.livePaths?.()) ?? []).filter(Boolean).map((path) => pathSpellings(path)),
    )
    if (liveNow.some((spellings) => insideAny(spellings, worktreeSpellings))) {
      record({ ...base, verdict: 'in-use' })
      continue
    }
    if (ownLock) {
      const unlocked = await runGit(root, ['worktree', 'unlock', worktree.path])
      if (!unlocked.ok) {
        record({ ...base, verdict: 'error', detail: unlocked.message ?? 'git worktree unlock failed' })
        continue
      }
    }
    // No --force: git re-checks cleanliness itself at the moment of removal.
    const removed = await withWorktreeRegistryLock(root, () => runGit(root, ['worktree', 'remove', worktree.path]))
    if (!removed.ok && ownLock) await relockWorktree(root, worktree.path, worktree.lockedReason, runGit)
    record(
      removed.ok
        ? { ...base, verdict: 'removed', detail: how }
        : { ...base, verdict: 'error', detail: removed.message ?? 'git worktree remove failed' },
    )
  }

  if (pool) {
    // Read again now: a chat's session or a terminal that started in a slot
    // while the worktrees above were checked keeps that slot.
    const swept = await pool.returnUnused({
      repoRoot: root,
      protectedPaths: [...input.protectedPaths, ...((await deps.livePaths?.()) ?? [])],
      agentIds: input.agentIds ? new Set(input.agentIds) : null,
      agentKeys: input.agentKeys ? new Set(input.agentKeys) : null,
      dryRun,
    })
    for (const entry of swept) record(poolEntry(entry))
  }

  const deletedBranches =
    defaultRef && input.keepBranches
      ? await deleteMergedAgentBranches(
          root,
          defaultRef,
          branchPrefix,
          new Set(input.keepBranches),
          dryRun,
          runGit,
          log,
        )
      : []
  return { repoRoot: root, defaultRef, entries, deletedBranches, dryRun }
}

function poolEntry(entry: WorktreePoolSweepEntry): AgentWorktreeCleanupEntry {
  const base = { path: entry.path, branch: entry.branch }
  switch (entry.verdict) {
    case 'returned':
      return { ...base, verdict: 'returned', detail: 'given back to the worktree pool' }
    case 'held':
      return { ...base, verdict: 'held', detail: entry.detail }
    case 'unclaimed':
      return { ...base, verdict: 'recent', detail: entry.detail }
    case 'postponed':
      return { ...base, verdict: 'in-use', detail: 'something still runs in it' }
    case 'in-use':
      return { ...base, verdict: 'in-use', detail: 'worktree pool slot' }
  }
}

/**
 * Delete every one of Studio's branches (`studioBranchPrefixes`: the person's
 * prefix and `agent/`) whose work is already on the default branch and that no
 * worktree has checked out. "On the default branch" is rule 7: no
 * commit the default branch lacks, or changes the default branch already holds
 * by content (a squash merge). Only `git branch -D` can delete a squash-merged
 * branch, so the merge test is ours; git still refuses, by itself, a branch a
 * worktree has checked out by the time the delete runs (a lease that just made
 * it), and that refusal is simply logged.
 */
async function deleteMergedAgentBranches(
  root: string,
  defaultRef: string,
  branchPrefix: string,
  keep: ReadonlySet<string>,
  dryRun: boolean,
  runGit: NonNullable<AgentWorktreeCleanupDeps['runGit']>,
  log: (line: string) => void,
): Promise<string[]> {
  const branches = await runGit(root, [
    'for-each-ref',
    '--format=%(refname:short)%00%(worktreepath)',
    ...studioBranchPrefixes(branchPrefix).map((namespace) => `refs/heads/${namespace}`),
  ])
  if (!branches.ok) return []
  const deleted: string[] = []
  for (const line of branches.stdout.split(/\r?\n/)) {
    const [branch, worktreePath] = line.split('\0')
    // Asked again of each name git lists: the patterns are git's, the rule is ours.
    if (!branch || !isStudioBranch(branch, branchPrefix) || worktreePath || keep.has(branch)) continue
    const unique = await runGit(root, ['rev-list', '--count', `${defaultRef}..refs/heads/${branch}`])
    const uniqueCommits = unique.ok ? Number.parseInt(unique.stdout.trim(), 10) : Number.NaN
    if (!Number.isFinite(uniqueCommits)) continue
    if (uniqueCommits > 0 && !(await changesAlreadyIn(root, defaultRef, `refs/heads/${branch}`, runGit))) continue
    if (dryRun) {
      deleted.push(branch)
      continue
    }
    const removed = await runGit(root, ['branch', '-D', '--quiet', branch])
    if (removed.ok) {
      deleted.push(branch)
      log(`deleted branch ${branch} — its work is on ${defaultRef}`)
    } else {
      log(`kept branch ${branch} — ${removed.message ?? 'git branch -D failed'}`)
    }
  }
  return deleted
}

/**
 * One sweep per repository at a time. Two windows asking together, or a
 * release arriving while a scheduled sweep runs, share the one in flight
 * rather than racing each other's `worktree remove`.
 */
const inFlight = new Map<string, Promise<AgentWorktreeCleanupReport>>()

export function cleanupAgentWorktreesOnce(
  input: AgentWorktreeCleanupInput,
  deps: AgentWorktreeCleanupDeps = {},
): Promise<AgentWorktreeCleanupReport> {
  const key = `${normalizeComparablePath(input.repoRoot)}\0${input.dryRun === true}\0${input.ownedOnly === true}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const run = cleanupAgentWorktrees(input, deps).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}
