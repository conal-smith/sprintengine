import { createHash, randomUUID } from 'node:crypto'
import { watch as watchDirectory } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import {
  STUDIO_MAX_FILE_BYTES,
  isStudioRelativePath,
  isStudioWritableFile,
  type StudioFileConflict,
  type StudioFileEntry,
  type StudioFileRoot,
  type StudioFileStat,
  type StudioFileWritten,
} from '../../../packages/studio-protocol/src/public'

// The server's files under a workspace's roots, for the `files.*` methods:
// read, list, write, remove and watch, by a root and a relative path. The
// root is resolved here, never named by the client, and what a path names
// must stay inside it with symbolic links followed: a link out of the root is
// refused as if the path did not exist there.
//
// A write is atomic (a temp file beside the target, then a rename, so a
// reader never sees half a board) and conditional: `ifMatch` is the SHA-256 of
// the bytes the client last read, null to create only. Writes under one root
// are queued, so the check and the rename are one step to every other writer
// through here. The queue is the root's, not the path's: on a disk that folds
// case, or through a linked folder, two spellings name one file, and a queue
// per spelling would let both pass the same check. In this version only a
// board (`*.excalidraw`) is written.

export type StudioFileFailure = {
  ok: false
  code: 'not_found' | 'invalid_params' | 'too_large' | 'unavailable'
  message: string
}

export type StudioFiles = {
  roots(workspaceId: string): { workspace: boolean; boards: boolean; store: boolean }
  stat(root: StudioFileRoot, path: string): Promise<{ ok: true; stat: StudioFileStat } | StudioFileFailure>
  list(root: StudioFileRoot, path: string): Promise<{ ok: true; entries: StudioFileEntry[] } | StudioFileFailure>
  read(
    root: StudioFileRoot,
    path: string,
  ): Promise<{ ok: true; text: string; hash: string; size: number; mtimeMs: number } | StudioFileFailure>
  write(
    root: StudioFileRoot,
    path: string,
    bytes: Buffer,
    ifMatch: string | null,
  ): Promise<StudioFileWritten | StudioFileConflict | StudioFileFailure>
  remove(
    root: StudioFileRoot,
    path: string,
    ifMatch: string | null,
  ): Promise<{ ok: true; removed: boolean } | StudioFileConflict | StudioFileFailure>
  /**
   * Hear the names that change in one directory, debounced. Returns the
   * unsubscriber. `onEnded` hears a watch that stopped by itself (its folder
   * went, the watcher failed), so the client can be told rather than left
   * following a folder that no longer reports.
   */
  watch(
    root: StudioFileRoot,
    path: string,
    listener: (names: string[]) => void,
    onEnded?: () => void,
  ): Promise<{ ok: true; dispose(): void } | StudioFileFailure>
}

export type StudioFilesOptions = {
  /** A workspace's root on this disk, or null when it has none here. Read on every call. */
  resolveRoot(root: StudioFileRoot): string | null
  /**
   * Where a path that names nothing under its root now is, or null: what an
   * older Studio kept in a project's `.sprintengine/` lives in the project's
   * store. Asked only by the reads (`stat`, `list`, `read`, `watch`), and only
   * when the path names nothing where it was asked for, so a file still there
   * is read from there.
   */
  moved?(root: StudioFileRoot, path: string): { root: StudioFileRoot; path: string } | null
  /** How long a burst of changes is gathered before one push. */
  watchDebounceMs?: number
}

const WATCH_DEBOUNCE_MS = 150

const ROOT_NAMES: Record<StudioFileRoot['kind'], string> = {
  workspace: 'folder',
  boards: 'board store',
  store: 'store',
}

const notFound = (message = 'There is no such file here.'): StudioFileFailure => ({
  ok: false,
  code: 'not_found',
  message,
})

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function missing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function inside(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

export function createStudioFiles(options: StudioFilesOptions): StudioFiles {
  const queues = new Map<string, Promise<unknown>>()

  /** One root's writes, one at a time. */
  function serialised<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return run
  }

  /**
   * Where a path lands under its root, refused when its spelling or the links
   * it passes through would take it outside. `existing` is the deepest part of
   * it that exists now, resolved, which is what the check is made on.
   */
  /**
   * The root on this disk, or null. A root that is not an absolute path, such
   * as a folder on an SSH machine spelled `ssh://…`, would otherwise be read
   * relative to this process's working directory.
   */
  function rootHere(root: StudioFileRoot): string | null {
    const base = options.resolveRoot(root)
    return base && isAbsolute(base) ? base : null
  }

  async function locate(
    root: StudioFileRoot,
    path: string,
  ): Promise<{ ok: true; base: string; target: string } | StudioFileFailure> {
    if (!isStudioRelativePath(path))
      return { ok: false, code: 'invalid_params', message: 'That path is not relative to its root.' }
    const base = rootHere(root)
    if (!base) return notFound(`Workspace ${root.workspaceId} has no ${ROOT_NAMES[root.kind]} here.`)
    const target = path === '' ? base : join(base, ...path.split('/'))
    let realBase: string
    try {
      realBase = await realpath(base)
    } catch (error) {
      // A board store nobody has written to yet: nothing in it to escape to.
      if (missing(error)) return { ok: true, base, target }
      throw error
    }
    // The deepest part of the path that exists, with its links followed, must
    // stay under the root; what does not exist yet is created inside it.
    let probe = target
    for (;;) {
      try {
        const real = await realpath(probe)
        if (!inside(realBase, real)) return notFound('That path leaves its root.')
        break
      } catch (error) {
        if (!missing(error)) throw error
        const parent = dirname(probe)
        if (parent === probe || !inside(base, parent)) break
        probe = parent
      }
    }
    return { ok: true, base, target }
  }

  /** `locate` for a read, which follows a path that names nothing where asked to where it now is. */
  async function locateForReading(
    root: StudioFileRoot,
    path: string,
  ): Promise<{ ok: true; base: string; target: string } | StudioFileFailure> {
    const located = await locate(root, path)
    const moved = options.moved?.(root, path)
    if (!moved || (located.ok && (await exists(located.target)))) return located
    const there = await locate(moved.root, moved.path)
    return there.ok || !located.ok ? there : located
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await stat(target)
      return true
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }

  async function currentHash(target: string): Promise<string | null> {
    try {
      return sha256(await readFile(target))
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  /** The queue a root's writes share: its real path where it exists. */
  async function queueKey(base: string): Promise<string> {
    return realpath(base).catch(() => base)
  }

  const folderRefused: StudioFileFailure = {
    ok: false,
    code: 'invalid_params',
    message: 'That path is a folder, not a board.',
  }

  async function isFolder(target: string): Promise<boolean> {
    try {
      return (await stat(target)).isDirectory()
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }

  return {
    roots(workspaceId) {
      return {
        workspace: rootHere({ kind: 'workspace', workspaceId }) !== null,
        boards: rootHere({ kind: 'boards', workspaceId }) !== null,
        store: rootHere({ kind: 'store', workspaceId }) !== null,
      }
    },

    async stat(root, path) {
      const located = await locateForReading(root, path)
      if (!located.ok) return located
      try {
        const info = await stat(located.target)
        const kind = info.isDirectory() ? 'directory' : 'file'
        return {
          ok: true,
          stat: {
            kind,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ...(kind === 'file' && info.size <= STUDIO_MAX_FILE_BYTES
              ? { hash: sha256(await readFile(located.target)) }
              : {}),
          },
        }
      } catch (error) {
        if (missing(error)) return notFound()
        throw error
      }
    },

    async list(root, path) {
      const located = await locateForReading(root, path)
      if (!located.ok) return located
      try {
        const entries = await readdir(located.target, { withFileTypes: true })
        // A link is neither: the listing does not follow one out of the root.
        return {
          ok: true,
          entries: entries.flatMap((entry): StudioFileEntry[] =>
            entry.isDirectory()
              ? [{ name: entry.name, kind: 'directory' }]
              : entry.isFile()
                ? [{ name: entry.name, kind: 'file' }]
                : [],
          ),
        }
      } catch (error) {
        if (missing(error)) return notFound('There is no such folder here.')
        throw error
      }
    },

    async read(root, path) {
      const located = await locateForReading(root, path)
      if (!located.ok) return located
      try {
        // The link's target, not the link: `locate` has checked where it lands.
        const info = await stat(located.target)
        if (info.isDirectory()) return { ok: false, code: 'invalid_params', message: 'That path is a folder.' }
        if (info.size > STUDIO_MAX_FILE_BYTES)
          return {
            ok: false,
            code: 'too_large',
            message: `A file read here may be at most ${STUDIO_MAX_FILE_BYTES / (1024 * 1024)} MB.`,
          }
        const bytes = await readFile(located.target)
        const after = await stat(located.target)
        return {
          ok: true,
          text: bytes.toString('utf8'),
          hash: sha256(bytes),
          size: bytes.length,
          mtimeMs: after.mtimeMs,
        }
      } catch (error) {
        if (missing(error)) return notFound()
        throw error
      }
    },

    async write(root, path, bytes, ifMatch) {
      if (!isStudioWritableFile(path))
        return { ok: false, code: 'invalid_params', message: 'Only a board (*.excalidraw) may be written.' }
      if (bytes.length > STUDIO_MAX_FILE_BYTES)
        return {
          ok: false,
          code: 'too_large',
          message: `A file may be at most ${STUDIO_MAX_FILE_BYTES / (1024 * 1024)} MB.`,
        }
      const located = await locate(root, path)
      if (!located.ok) return located
      const target = located.target
      return serialised(
        await queueKey(located.base),
        async (): Promise<StudioFileWritten | StudioFileConflict | StudioFileFailure> => {
          if (await isFolder(target)) return folderRefused
          const found = await currentHash(target)
          if (found !== ifMatch) return { ok: false, code: 'conflict', currentHash: found }
          await mkdir(dirname(target), { recursive: true })
          // Created through a link that now points out: checked again on what exists now.
          const again = await locate(root, path)
          if (!again.ok) return again
          const temp = `${target}.${randomUUID()}.tmp`
          try {
            await writeFile(temp, bytes)
            await rename(temp, target)
          } catch (error) {
            await unlink(temp).catch(() => undefined)
            throw error
          }
          const info = await stat(target)
          return { ok: true, hash: sha256(bytes), size: bytes.length, mtimeMs: info.mtimeMs }
        },
      )
    },

    async remove(root, path, ifMatch) {
      if (!isStudioWritableFile(path))
        return { ok: false, code: 'invalid_params', message: 'Only a board (*.excalidraw) may be removed.' }
      const located = await locate(root, path)
      if (!located.ok) return located
      const target = located.target
      return serialised(await queueKey(located.base), async () => {
        if (await isFolder(target)) return folderRefused
        const found = await currentHash(target)
        if (found === null) return { ok: true as const, removed: false }
        if (found !== ifMatch) return { ok: false as const, code: 'conflict' as const, currentHash: found }
        await unlink(target)
        return { ok: true as const, removed: true }
      })
    },

    async watch(root, path, listener, onEnded) {
      const located = await locateForReading(root, path)
      if (!located.ok) return located
      const debounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS
      const pending = new Set<string>()
      let timer: ReturnType<typeof setTimeout> | null = null
      let closed = false
      const flush = () => {
        timer = null
        if (closed || pending.size === 0) return
        const names = [...pending]
        pending.clear()
        try {
          listener(names)
        } catch {
          // A listener's failure is its own.
        }
      }
      let watcher: ReturnType<typeof watchDirectory>
      try {
        watcher = watchDirectory(located.target, { persistent: false }, (_event, filename) => {
          if (closed) return
          // A watcher that cannot name the entry names the directory itself.
          pending.add(typeof filename === 'string' ? filename : '')
          if (!timer) {
            timer = setTimeout(flush, debounceMs)
            timer.unref?.()
          }
        })
      } catch (error) {
        if (missing(error)) return notFound('There is no such folder here.')
        throw error
      }
      // A folder removed under it ends the watch rather than taking the process down.
      watcher.on('error', () => {
        watcher.close()
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        try {
          onEnded?.()
        } catch {
          // A listener's failure is its own.
        }
      })
      return {
        ok: true,
        dispose() {
          closed = true
          if (timer) clearTimeout(timer)
          watcher.close()
        },
      }
    },
  }
}
