import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { toFilesystemPath } from './git-utils'

/**
 * What Git for Windows leaves behind after a `git worktree remove` it reports
 * as a success.
 *
 * It never descends into an NTFS junction, which is how pnpm and the
 * dependency installer link `node_modules` folders, and it leaves the junction
 * and every folder above it in place. The stub then stands where the worktree
 * was: recreating the worktree there fails with "Something else is at …"
 * (git.ts), and the pool cannot make a slot at that path again.
 *
 * So, on Windows only, and only after a removal git reported as done, what is
 * left is cleared without ever following a link: each symlink or junction is
 * unlinked (never what it points at), and each folder that is then empty is
 * removed with a plain `rmdir`, which fails on anything with content. A
 * regular file is never deleted: it was written after git removed the
 * worktree, so it, and every folder above it, stays.
 *
 * True when nothing is left at `path`.
 */

/** Entries walked before giving up; a stub holds a few dozen links at most. */
const MAX_WALKED_ENTRIES = 50_000

export async function removeWorktreeLeftovers(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32') return true
  const root = toFilesystemPath(path)
  if ((await lstat(root).catch(() => null)) === null) return true
  let budget = MAX_WALKED_ENTRIES
  const clear = async (target: string): Promise<boolean> => {
    budget -= 1
    if (budget < 0) return false
    const info = await lstat(target).catch(() => null)
    if (info === null) return true
    if (info.isSymbolicLink()) {
      // `unlink` removes a junction itself; `rmdir` is the fallback for a
      // directory link `unlink` will not take. Neither touches the target.
      return unlink(target).then(
        () => true,
        () =>
          rmdir(target).then(
            () => true,
            () => false,
          ),
      )
    }
    if (!info.isDirectory()) return false
    const names = await readdir(target).catch(() => null)
    if (names === null) return false
    let empty = true
    for (const name of names) {
      if (!(await clear(join(target, name)))) empty = false
    }
    if (!empty) return false
    // Fails on a folder something was written into since it was listed.
    return rmdir(target).then(
      () => true,
      () => false,
    )
  }
  return clear(root)
}
