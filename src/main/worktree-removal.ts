import { lstat, readFile, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { comparablePath } from '../shared/host-paths'
import { errorMessage } from '../shared/errors'
import type { GitCommandResult } from './git'
import { gitRunsInWsl } from './git-run'
import { toFilesystemPath } from './git-utils'

/**
 * `git worktree remove`, without letting Git for Windows delete through a
 * junction.
 *
 * Git for Windows before 2.54 follows NTFS junctions while it deletes a
 * worktree, and deletes what they point at. pnpm and the dependency installer
 * link `node_modules` folders with junctions, often to the main checkout's own
 * `node_modules`, so one removal could empty a folder outside the worktree.
 * Studio runs whichever git is on PATH, so it cannot count on a fixed one.
 *
 * On Windows, then, git never deletes the files. This makes the checks `git
 * worktree remove` makes before it deletes anything (builtin/worktree.c),
 * worded as git words its refusals, deletes the folder itself without ever
 * following a link, and then has git drop its record of the now-missing
 * worktree. Git on macOS and Linux only unlinks a symlink, so there, and for a
 * repository whose git runs inside WSL, git removes the worktree as before.
 */

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

/** Git's refusal (its messages are pinned to English, git-run.ts). */
export const SUBMODULE_REFUSAL = 'working trees containing submodules cannot be moved or removed'

type EntryKind = { isSymbolicLink(): boolean; isDirectory(): boolean }

/** The file system calls the deletion makes; tests replace them. */
export type TreeFs = {
  lstat: (path: string) => Promise<EntryKind>
  readdir: (path: string) => Promise<Array<EntryKind & { name: string }>>
  unlink: (path: string) => Promise<void>
  rmdir: (path: string) => Promise<void>
  /** Removes what is left once no link remains. */
  rm: (path: string) => Promise<void>
}

const nodeTreeFs: TreeFs = {
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  unlink: (path) => unlink(path),
  rmdir: (path) => rmdir(path),
  // Retried, as Windows briefly refuses a file a scanner or indexer has open.
  rm: (path) => rm(path, { recursive: true, force: true, maxRetries: 3 }),
}

export type WorktreeRemoveOptions = {
  force?: boolean
  /** The host's own otherwise; tests take the Windows path anywhere. */
  platform?: NodeJS.Platform
  fs?: TreeFs
}

/**
 * Removes the linked worktree at `worktreePath`, as `git worktree remove
 * [--force]` run in `repoRoot` would, and answers the way git does: a refusal
 * is a failed result with git's own message, so callers that read it (the
 * submodule refusal, worktree-submodule-removal.ts) read it either way.
 * Call it inside `withWorktreeRegistryLock`.
 */
export async function removeLinkedWorktree(
  repoRoot: string,
  worktreePath: string,
  runGit: RunGit,
  options: WorktreeRemoveOptions = {},
): Promise<GitCommandResult> {
  const force = options.force === true
  const gitFile = join(worktreePath, '.git')
  // A folder with no `.git` file here is not one this machine can see, or is
  // already gone; git alone then decides, and deletes nothing that exists.
  const windows =
    (options.platform ?? process.platform) === 'win32' &&
    !gitRunsInWsl(repoRoot) &&
    (await lstat(toFilesystemPath(gitFile)).then(
      (info) => info.isFile(),
      () => false,
    ))
  if (!windows) return runGit(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath])

  const notAWorktree = refusal(`'${worktreePath}' is not a working tree`)
  // A worktree folder that is itself a link is not deleted through.
  const root = await lstat(toFilesystemPath(worktreePath)).catch(() => null)
  if (!root?.isDirectory()) return notAWorktree

  // A registered worktree of this repository: its `.git` file names an admin
  // folder under the repository's `worktrees/`, whose `gitdir` names it back.
  const admin = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir'])
  if (!admin.ok || !admin.stdout.trim()) return notAWorktree
  const adminDir = resolve(worktreePath, admin.stdout.trim())
  const common = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return common
  const commonDir = resolve(repoRoot, common.stdout.trim())
  const gitdir = (await readFile(toFilesystemPath(join(adminDir, 'gitdir')), 'utf8').catch(() => '')).trim()
  if (
    !gitdir ||
    !(await samePath(resolve(adminDir, gitdir), gitFile)) ||
    !(await samePath(dirname(adminDir), join(commonDir, 'worktrees')))
  ) {
    return notAWorktree
  }

  // Git counts the lock file's existence as the lock, and Studio never passes
  // the second `--force` that overrides one. Anything but a confirmed absence
  // refuses.
  const lock = await readFile(toFilesystemPath(join(adminDir, 'locked')), 'utf8').then(
    (text) => text.trim(),
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : ''),
  )
  if (lock !== null) {
    return refusal(
      lock
        ? `cannot remove a locked working tree, lock reason: ${lock}\nuse 'remove -f -f' to override or unlock first`
        : "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first",
    )
  }

  if (!force) {
    // Bound to the worktree as git binds its own check, so a `core.worktree`
    // setting cannot point the check at another folder.
    const bound = [`--git-dir=${adminDir}`, `--work-tree=${worktreePath}`]
    // A path that cannot be read counts as present, so a doubt refuses.
    const present = (path: string) =>
      lstat(toFilesystemPath(path)).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
      )
    if (await present(join(adminDir, 'modules'))) return refusal(SUBMODULE_REFUSAL)
    const index = await runGit(worktreePath, [...bound, 'ls-files', '--stage', '-z'])
    if (!index.ok) return index
    for (const entry of index.stdout.split('\0')) {
      if (!entry.startsWith('160000 ')) continue
      if (await present(join(worktreePath, entry.slice(entry.indexOf('\t') + 1), '.git'))) {
        return refusal(SUBMODULE_REFUSAL)
      }
    }
    // Untracked files are always counted: git's own check honours
    // `status.showUntrackedFiles=no`, and would delete them.
    const status = await runGit(worktreePath, [
      ...bound,
      'status',
      '--porcelain',
      '--ignore-submodules=none',
      '--untracked-files=normal',
    ])
    if (!status.ok) return status
    if (status.stdout !== '') {
      return refusal(`'${worktreePath}' contains modified or untracked files, use --force to delete it`)
    }
  }

  const gitFileText = await readFile(toFilesystemPath(gitFile), 'utf8').catch(() => null)
  if (gitFileText === null) return notAWorktree
  try {
    await removeTreeWithoutFollowingLinks(toFilesystemPath(worktreePath), options.fs)
  } catch (error) {
    // A file held open stops the delete partway. Putting `.git` back, when
    // that works, leaves a worktree git still knows, which a retry can finish.
    await writeFile(toFilesystemPath(gitFile), gitFileText).catch(() => {})
    return refusal(`failed to delete '${worktreePath}': ${errorMessage(error)}`)
  }
  // The folder is gone, so git only drops its record of the worktree.
  return runGit(repoRoot, ['worktree', 'remove', '--force', '--force', worktreePath])
}

/**
 * Deletes the folder at `root` without ever deleting through a link. Every
 * symlink and junction in it is unlinked first, never descended into, and only
 * then is the rest removed. A folder is looked at again just before it is
 * descended into, so one listed as a folder is walked only while it still is
 * one.
 */
export async function removeTreeWithoutFollowingLinks(root: string, fs: TreeFs = nodeTreeFs): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    for (const entry of await fs.readdir(dir)) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        await unlinkLink(path, fs)
      } else if (entry.isDirectory()) {
        const info = await fs.lstat(path)
        if (info.isSymbolicLink()) await unlinkLink(path, fs)
        else if (info.isDirectory()) pending.push(path)
      }
    }
  }
  await fs.rm(root)
}

async function unlinkLink(path: string, fs: TreeFs): Promise<void> {
  // `unlink` removes a junction itself; `rmdir` is the fallback for a
  // directory link `unlink` will not take. Neither touches the target.
  await fs.unlink(path).catch((error: unknown) => fs.rmdir(path).catch(() => Promise.reject(error)))
}

/** Git's own refusal, worded as it prints one. */
function refusal(message: string): GitCommandResult {
  return { ok: false, stdout: '', stderr: `fatal: ${message}`, message: `fatal: ${message}` }
}

/** Whether two paths name one file, compared as Windows compares names. */
async function samePath(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    realpath(toFilesystemPath(left)).catch(() => null),
    realpath(toFilesystemPath(right)).catch(() => null),
  ])
  return a !== null && b !== null && comparablePath(a).toLowerCase() === comparablePath(b).toLowerCase()
}
