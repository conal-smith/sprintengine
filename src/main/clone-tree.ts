import { constants } from 'fs'
import { copyFile, lstat, mkdir, readdir, readlink, symlink } from 'fs/promises'
import { join } from 'path'

/**
 * Copy a file or a directory tree, sharing blocks with the source wherever the
 * filesystem can.
 *
 * What `.worktreeinclude` names is usually heavy and rarely edited — a
 * dependency folder, a build cache, a local env file — and a new worktree that
 * gets a full byte copy of a gigabyte of `node_modules` pays seconds and the
 * gigabyte. `COPYFILE_FICLONE` asks for a copy-on-write clone: APFS clonefile,
 * a reflink on Btrfs or XFS, a block clone on a ReFS Dev Drive. The clone costs
 * a metadata write and no data until either side is changed. Where the
 * filesystem cannot clone, Node itself falls back to an ordinary copy under
 * the same flag, and an error from the clone attempt is retried as a plain
 * copy here as well, so the only outcome that differs by filesystem is speed.
 *
 * Symlinks are recreated as symlinks, not followed: a `node_modules/.bin` full
 * of links must stay links, and following one out of the tree would copy
 * whatever it points at. Anything that is neither a regular file, a directory
 * nor a symlink (a FIFO, a socket a dev server left behind) is not copied.
 * Nor is anything whose place in the destination is already taken by a link.
 */
export async function cloneTree(
  source: string,
  destination: string,
  deps: { copy?: (from: string, to: string, mode: number) => Promise<void> } = {},
): Promise<void> {
  const copy = deps.copy ?? ((from: string, to: string, mode: number) => copyFile(from, to, mode))
  // One limit across the whole walk, not per directory: nested fan-out would
  // multiply, and a dependency folder is tens of thousands of entries against a
  // descriptor limit that is low by default on macOS.
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<void> =>
    active < CLONE_CONCURRENCY
      ? ((active += 1), Promise.resolve())
      : new Promise<void>((resolve) => waiting.push(resolve))
  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }

  const cloneFile = async (from: string, to: string): Promise<void> => {
    await acquire()
    try {
      await copy(from, to, constants.COPYFILE_FICLONE)
    } catch (error) {
      // A filesystem that refuses the clone outright rather than falling back.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      await copy(from, to, 0)
    } finally {
      release()
    }
  }

  const walk = async (from: string, to: string): Promise<void> => {
    const info = await lstat(from)
    // A link already standing where a copy would go is left alone, never
    // written or descended through: the copy stays inside the destination.
    const existing = await lstat(to).catch(() => null)
    if (existing?.isSymbolicLink()) return
    if (info.isSymbolicLink()) {
      await symlink(await readlink(from), to).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      return
    }
    if (info.isFile()) {
      await cloneFile(from, to)
      return
    }
    // A FIFO, socket or device node is skipped. Opening a FIFO to copy it
    // blocks until something writes to the other end, which is never, and it
    // holds one of libuv's four threadpool threads while it waits.
    if (!info.isDirectory()) return
    await mkdir(to, { recursive: true })
    const children = await readdir(from)
    await Promise.all(children.map((name) => walk(join(from, name), join(to, name))))
  }

  await walk(source, destination)
}

const CLONE_CONCURRENCY = 32
