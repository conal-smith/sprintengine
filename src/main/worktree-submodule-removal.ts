import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { hiddenEditPaths, ignoredPathsAtRisk, type IgnoredFilesOptions } from './agent-worktree-keep-checks'
import type { GitCommandResult } from './git'
import { toFilesystemPath } from './git-utils'
import { removeLinkedWorktree, SUBMODULE_REFUSAL } from './worktree-removal'

/**
 * Removing a worktree whose submodules are checked out.
 *
 * Studio checks out every submodule in a new agent worktree and pool slot (git
 * leaves them empty folders otherwise), and plain `git worktree remove` refuses
 * every such worktree, clean or not: "working trees containing submodules
 * cannot be moved or removed". Only `--force` removes one, and `--force` also
 * skips git's own last cleanliness check and deletes each submodule's
 * repository (kept in the worktree's admin folder, not the main checkout's)
 * with everything in it. So the force comes only after this module has looked
 * at every submodule the way the callers look at the worktree itself, and found
 * nothing that exists nowhere else:
 *
 * - no commit, branch, stash or reflog entry that no remote-tracking branch
 *   holds, in any submodule repository on disk, a deinitialized one included;
 * - no uncommitted or untracked change, no edit hidden from `git status`, and
 *   no ignored file that may be someone's work (agent-worktree-keep-checks.ts);
 * - no file in a submodule folder that is not checked out, which neither
 *   `status` nor `foreach` sees;
 * - and then, once more, the worktree's own `git status`, the check `--force`
 *   switches off.
 *
 * Anything it cannot read keeps the worktree. The checks and the removal run
 * back to back inside the caller's registry lock; they still cannot be made
 * atomic, which is why the files are read last.
 */

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

/** How many folders of stored submodule repositories are walked before giving up and keeping. */
const MAX_WALKED_DIRS = 10_000

export function refusedForSubmodules(result: GitCommandResult): boolean {
  return !result.ok && `${result.message ?? ''}\n${result.stderr}`.includes(SUBMODULE_REFUSAL)
}

/** Why a worktree's submodules keep it. */
export type SubmoduleWork = {
  kind: 'uncommitted' | 'unpushed' | 'hidden-edits' | 'ignored-files' | 'unreadable'
  detail: string
  /** For `uncommitted`, `hidden-edits` and `ignored-files`: how many paths. */
  paths?: number
}

export type WorktreeRemoval =
  | { outcome: 'removed'; forced: boolean }
  | { outcome: 'failed'; result: GitCommandResult }
  | { outcome: 'kept'; why: SubmoduleWork }

/**
 * `git worktree remove` without `--force`, and with it only when git refused
 * for the submodules alone and {@link submoduleWorkAtRisk} finds nothing to
 * lose. Call it inside `withWorktreeRegistryLock`.
 */
export async function removeWorktreeKeepingSubmoduleWork(
  repoRoot: string,
  worktreePath: string,
  runGit: RunGit,
  options: IgnoredFilesOptions = {},
): Promise<WorktreeRemoval> {
  const plain = await removeLinkedWorktree(repoRoot, worktreePath, runGit)
  if (plain.ok) return { outcome: 'removed', forced: false }
  if (!refusedForSubmodules(plain)) return { outcome: 'failed', result: plain }
  const atRisk = await submoduleWorkAtRisk(repoRoot, worktreePath, runGit, options)
  if (atRisk) return { outcome: 'kept', why: atRisk }
  // What git checks itself before a plain removal, and skips under --force:
  // a tracked edit or a new file written since the caller's own status read.
  const status = await runGit(worktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ])
  if (!status.ok) return { outcome: 'kept', why: unreadable(status, 'could not read its status') }
  const changed = status.stdout.split('\0').filter(Boolean).length
  if (changed > 0) {
    return { outcome: 'kept', why: { kind: 'uncommitted', detail: `${changed} changed path(s)`, paths: changed } }
  }
  const forced = await removeLinkedWorktree(repoRoot, worktreePath, runGit, { force: true })
  return forced.ok ? { outcome: 'removed', forced: true } : { outcome: 'failed', result: forced }
}

function unreadable(result: GitCommandResult, what: string): SubmoduleWork {
  const reason = (result.message ?? result.stderr).trim().split(/\r?\n/).at(-1)
  return { kind: 'unreadable', detail: reason ? `${what}: ${reason}` : what }
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown
}

async function lstatOrNull(path: string) {
  return lstat(toFilesystemPath(path)).catch(() => null)
}

/**
 * What `git worktree remove --force` would destroy in the worktree's
 * submodules that exists nowhere else, or null when there is nothing.
 * `repoRoot` is the main checkout: a submodule's ignored file is compared with
 * the main checkout's own submodule's copy, as the worktree's are with the main
 * checkout's (`.worktreeinclude`).
 */
export async function submoduleWorkAtRisk(
  repoRoot: string,
  worktreePath: string,
  runGit: RunGit,
  options: IgnoredFilesOptions = {},
): Promise<SubmoduleWork | null> {
  const admin = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir'])
  if (!admin.ok || !admin.stdout.trim()) return unreadable(admin, 'could not find its git folder')

  // Every checked-out submodule, nested ones included, relative to the worktree.
  const foreach = await runGit(worktreePath, [
    'submodule',
    'foreach',
    '--recursive',
    '--quiet',
    'printf "%s\\0" "$displaypath"',
  ])
  if (!foreach.ok) return unreadable(foreach, 'could not list its submodules')
  const populated = foreach.stdout.split('\0').filter(Boolean)

  // The repositories `--force` deletes: each checked-out submodule's, and
  // every one stored in the admin folder, deinitialized ones too, whose
  // branches and stashes no `status` would ever show.
  const gitDirs: string[] = []
  for (const sub of populated) {
    const dir = await runGit(join(worktreePath, sub), ['rev-parse', '--absolute-git-dir'])
    if (!dir.ok || !dir.stdout.trim()) return unreadable(dir, `could not find the git folder of submodule ${sub}`)
    gitDirs.push(dir.stdout.trim())
  }
  const pending = [join(admin.stdout.trim(), 'modules')]
  let walked = 0
  while (pending.length > 0) {
    const dir = pending.pop()!
    const info = await lstatOrNull(dir)
    if (!info) continue
    if (!info.isDirectory()) return { kind: 'unreadable', detail: `could not inspect a stored submodule at ${dir}` }
    walked += 1
    if (walked > MAX_WALKED_DIRS) return { kind: 'unreadable', detail: 'too many stored submodule folders to inspect' }
    if (await lstatOrNull(join(dir, 'HEAD'))) {
      gitDirs.push(dir)
      pending.push(join(dir, 'modules'))
    } else {
      // A submodule named `libs/core` is stored as `modules/libs/core`.
      const names = await readdir(toFilesystemPath(dir)).catch(() => null)
      if (names === null) return { kind: 'unreadable', detail: `could not read ${dir}` }
      for (const name of names) pending.push(join(dir, name))
    }
  }
  const seen = new Set<string>()
  for (const dir of gitDirs) {
    const key = await realpath(toFilesystemPath(dir)).catch(() => dir)
    if (seen.has(key)) continue
    seen.add(key)
    // `=` forms keep the subcommand where git-run.ts looks for it. The work
    // tree is named only so a deinitialized repository's `core.worktree`,
    // pointing at an emptied folder, is never consulted.
    const unpushed = await runGit(worktreePath, [
      `--git-dir=${dir}`,
      `--work-tree=${worktreePath}`,
      'rev-list',
      '--max-count=1',
      'HEAD',
      '--all',
      '--reflog',
      '--not',
      '--remotes',
    ])
    if (!unpushed.ok) return unreadable(unpushed, `could not read the history of the submodule stored at ${dir}`)
    if (unpushed.stdout.trim()) {
      return { kind: 'unpushed', detail: `a submodule has commits no remote-tracking branch holds (${dir})` }
    }
  }

  // The files last, closest to the removal.
  for (const sub of populated) {
    const path = join(worktreePath, sub)
    const status = await runGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!status.ok) return unreadable(status, `could not read the status of submodule ${sub}`)
    const changed = status.stdout.split('\0').filter(Boolean).length
    if (changed > 0) {
      return { kind: 'uncommitted', detail: `submodule ${sub}: ${changed} changed path(s)`, paths: changed }
    }
    const hidden = await hiddenEditPaths(path, runGit)
    if (!hidden.ok) return { kind: 'unreadable', detail: `submodule ${sub}: ${hidden.message}` }
    if (hidden.paths.length > 0) {
      return { kind: 'hidden-edits', detail: `submodule ${sub}: ${listed(hidden.paths)}`, paths: hidden.paths.length }
    }
    const ignored = await ignoredPathsAtRisk(join(repoRoot, sub), path, runGit, options)
    if (!ignored.ok) return { kind: 'unreadable', detail: `submodule ${sub}: ${ignored.message}` }
    if (ignored.paths.length > 0) {
      return {
        kind: 'ignored-files',
        detail: `submodule ${sub}: ${listed(ignored.paths)}`,
        paths: ignored.paths.length,
      }
    }
  }

  // A submodule folder that is not checked out is invisible to `status` and
  // `foreach` alike, and `--force` deletes whatever was put in it.
  const checkedOut = new Set(populated)
  for (const repo of ['', ...populated]) {
    const index = await runGit(repo ? join(worktreePath, repo) : worktreePath, ['ls-files', '--stage', '-z'])
    if (!index.ok) return unreadable(index, 'could not read its index')
    for (const entry of index.stdout.split('\0')) {
      if (!entry.startsWith('160000 ')) continue
      const sub = `${repo ? `${repo}/` : ''}${entry.slice(entry.indexOf('\t') + 1)}`
      if (checkedOut.has(sub)) continue
      const path = join(worktreePath, sub)
      const info = await lstatOrNull(path)
      if (!info) continue
      const names = info.isDirectory() ? await readdir(toFilesystemPath(path)).catch(() => null) : null
      if (names === null || names.length > 0) {
        return { kind: 'uncommitted', detail: `files in submodule folder ${sub}, which is not checked out`, paths: 1 }
      }
    }
  }
  return null
}
