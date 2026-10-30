import { isAbsolute, resolve } from 'path'
import type { GitFileStatus, GitRepoOperation, GitStatusEntry, GitStatusSnapshot } from './git'
import { pathExists, runGit, toAbsolutePath } from './git-utils'
import { branchNameFromHeadRef, HEAD_BRANCH_REF_ARGS } from './git-head-branch'
import type { GitRowSummary } from '../shared/electron-api'

type GitStatusCode = {
  index: string
  worktree: string
}

function isConflictStatus({ index, worktree }: GitStatusCode): boolean {
  return index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')
}

function toFileStatus(code: GitStatusCode): GitFileStatus {
  if (code.index === '?' && code.worktree === '?') return 'new'
  if (isConflictStatus(code)) return 'conflicted'
  if (code.index === 'R' || code.worktree === 'R') return 'renamed'
  if (code.index === 'A' || code.worktree === 'A') return 'new'
  if (code.index === 'D' || code.worktree === 'D') return 'deleted'
  return 'modified'
}

function parseStatusEntry(repoRoot: string, code: GitStatusCode, relativePath: string): GitStatusEntry {
  return {
    path: toAbsolutePath(repoRoot, relativePath),
    relativePath,
    status: toFileStatus(code),
    staged: code.index !== ' ' && code.index !== '?',
    unstaged: code.index === '?' || code.worktree !== ' ',
  }
}

// Marker paths that flag a multi-step operation parked in the repo, in
// precedence order: a conflicted rebase can leave merge-ish files around, so
// the rebase directories are checked first. Classify by statting the markers,
// not by parsing porcelain. `rebase-apply` is
// also created by a parked `git am` — git distinguishes the two by the
// `applying` file inside it, and an am session is not ours to continue/abort,
// so it must report no operation.
const OPERATION_MARKERS: { operation: GitRepoOperation; marker: string; notMarker?: string }[] = [
  { operation: 'rebase', marker: 'rebase-merge' },
  { operation: 'rebase', marker: 'rebase-apply', notMarker: 'rebase-apply/applying' },
  { operation: 'cherry-pick', marker: 'CHERRY_PICK_HEAD' },
  { operation: 'revert', marker: 'REVERT_HEAD' },
  { operation: 'merge', marker: 'MERGE_HEAD' },
]

// getGitStatus is the watch-driven hot path, so the `--git-path` resolution
// (one git spawn) runs once per repo root; the resolved marker paths are
// stable for a checkout's lifetime.
const markerPathsCache = new Map<string, string[]>()

async function resolveOperationMarkerPaths(repoRoot: string): Promise<string[]> {
  const cached = markerPathsCache.get(repoRoot)
  if (cached) return cached

  // `--git-path` resolves per-worktree paths (`.git` may be a file pointing at
  // the shared git dir), one output line per flag in argument order.
  const markers = OPERATION_MARKERS.flatMap(({ marker, notMarker }) => (notMarker ? [marker, notMarker] : [marker]))
  const stdout = await runGit(repoRoot, ['rev-parse', ...markers.flatMap((marker) => ['--git-path', marker])])
  const paths = stdout
    .split('\n')
    .slice(0, markers.length)
    .map((line) => (isAbsolute(line.trim()) ? line.trim() : resolve(repoRoot, line.trim())))
  markerPathsCache.set(repoRoot, paths)
  return paths
}

/** Which merge/rebase/cherry-pick/revert operation is parked in the repo, if any. */
export async function getGitOperationInProgress(repoRoot: string): Promise<GitRepoOperation | null> {
  try {
    const paths = await resolveOperationMarkerPaths(repoRoot)
    const exists = await Promise.all(paths.map((markerPath) => pathExists(markerPath)))

    let pathIndex = 0
    for (const { operation, notMarker } of OPERATION_MARKERS) {
      const markerHit = exists[pathIndex]
      const notMarkerHit = notMarker ? exists[pathIndex + 1] : false
      pathIndex += notMarker ? 2 : 1
      if (markerHit && !notMarkerHit) return operation
      if (markerHit && notMarkerHit) return null
    }
  } catch {
    // A repo we cannot inspect reports no operation rather than failing status.
  }
  return null
}

/**
 * The sidebar row's one-line git story (remote-sessions-ux /
 * two-line-session-rows): branch plus working-tree ±lines against HEAD.
 *
 * Deliberately tiny — two git subprocesses, no file list — because the
 * sidebar polls it once per visible workspace on a slow cadence, where the
 * full porcelain status would be waste. Anything unreadable (not a repo, no
 * HEAD yet, git missing) reports the quiet shape rather than throwing: a row
 * simply shows no git facts.
 */
export type { GitRowSummary } from '../shared/electron-api'

export async function getGitRowSummary(repoRoot: string): Promise<GitRowSummary> {
  let branch: string | null = null
  let isRepo = true
  try {
    // symbolic-ref, not rev-parse: it names the branch even on an unborn HEAD
    // (fresh init, nothing committed) and fails on a detached checkout — both
    // exactly what the row wants shown.
    branch = branchNameFromHeadRef(await runGit(repoRoot, [...HEAD_BRANCH_REF_ARGS]))
  } catch {
    branch = null
    try {
      await runGit(repoRoot, ['rev-parse', '--git-dir'])
    } catch {
      isRepo = false
    }
  }
  if (!isRepo) return { branch: null, additions: 0, deletions: 0 }
  try {
    // Staged + unstaged against HEAD in one number pair. Untracked files are
    // invisible to `diff` — accepted: the row summarises edits, not inventory.
    // `diff-index`, which never writes the index, where `git diff` rewrites it
    // for a file whose stat data alone moved (git-branch-span.ts, `diffFlags`);
    // `-M` because it finds no renames unless asked, and `git diff` does.
    // `--` ends the revisions: a file named HEAD in the checkout otherwise makes
    // `HEAD` ambiguous and the read fails.
    const stat = await runGit(repoRoot, ['diff-index', '--shortstat', '-M', 'HEAD', '--'])
    const additions = Number(/([0-9]+) insertion/.exec(stat)?.[1] ?? 0)
    const deletions = Number(/([0-9]+) deletion/.exec(stat)?.[1] ?? 0)
    return { branch, additions, deletions }
  } catch {
    // An unborn HEAD (fresh init) has nothing to diff against.
    return { branch, additions: 0, deletions: 0 }
  }
}

export async function getGitStatus(repoRoot: string): Promise<GitStatusSnapshot> {
  const [stdout, operation] = await Promise.all([
    runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    getGitOperationInProgress(repoRoot),
  ])
  const records = stdout.split('\0').filter(Boolean)
  const files: Record<string, GitStatusEntry> = {}

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue

    const code = { index: record[0] ?? ' ', worktree: record[1] ?? ' ' }
    const relativePath = record.slice(3)
    const entry = parseStatusEntry(repoRoot, code, relativePath)
    files[entry.path] = entry

    if (code.index === 'R' || code.worktree === 'R') {
      const originalPath = records[index + 1]
      if (originalPath) {
        const deletedEntry = parseStatusEntry(repoRoot, { index: 'D', worktree: ' ' }, originalPath)
        files[deletedEntry.path] = deletedEntry
        index += 1
      }
    }
  }

  return {
    repoRoot,
    files,
    operation,
    updatedAt: Date.now(),
  }
}
