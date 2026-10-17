import type { FileWatchEvent } from '../../../shared/ipc/filesystem'
import { watchEventPaths } from '../../../shared/file-watch-event'
import { basename, parentPath } from './paths'

/**
 * Hears when one open file changes on disk, for the editors that show it.
 *
 * The folder is watched rather than the file. An agent, a formatter or git
 * often writes a file by writing a sibling and renaming it over the original,
 * and a watch on the file itself follows the old inode and goes quiet after
 * the first such write. Watching the folder sees every one of them.
 *
 * One watch per folder however many tabs are open in it: ten files open from
 * `src/` cost one `watchPath`, which main in turn shares with anything else
 * watching that folder. The watch closes with the last tab that needed it.
 *
 * Where nothing can be watched — a folder on an SSH machine, whose files main
 * reads but does not watch, or a client with no `watchPath` at all — the
 * subscription is simply silent: the editor keeps working as it did before
 * there was a watch.
 */

export type FileDiskWatchApi = {
  watchPath?: (path: string, cb: (event: FileWatchEvent) => void) => Promise<() => Promise<void> | void>
}

/**
 * How long a file has to stay still before it is re-read. An agent's edit is
 * often several writes in a row (write, format, rewrite); this reads it once,
 * after the last one, on top of main's own 100ms coalescing.
 */
export const FILE_DISK_WATCH_DEBOUNCE_MS = 150

type Subscription = {
  name: string
  onChange: () => void
  timer: ReturnType<typeof setTimeout> | null
}

type FolderWatch = {
  subscriptions: Set<Subscription>
  stop: (() => Promise<void> | void) | null
  closed: boolean
}

export type FileDiskWatcher = {
  /** Calls `onChange` (debounced) whenever `filePath` may have changed on disk. Returns the unsubscribe. */
  watch(filePath: string, onChange: () => void): () => void
  /** How many folder watches are open. For tests. */
  folderCount(): number
}

function stopQuietly(stop: () => Promise<void> | void): void {
  try {
    void Promise.resolve(stop()).catch(() => {})
  } catch {
    // Already stopped.
  }
}

export function createFileDiskWatcher(
  getApi: () => FileDiskWatchApi | undefined,
  options: { debounceMs?: number } = {},
): FileDiskWatcher {
  const debounceMs = options.debounceMs ?? FILE_DISK_WATCH_DEBOUNCE_MS
  const folders = new Map<string, FolderWatch>()

  const schedule = (subscription: Subscription): void => {
    if (subscription.timer) clearTimeout(subscription.timer)
    subscription.timer = setTimeout(() => {
      subscription.timer = null
      subscription.onChange()
    }, debounceMs)
  }

  const deliver = (folder: FolderWatch, event: FileWatchEvent): void => {
    // Paths are relative to the watched folder. A burst too large to name, or
    // one the OS gave no names for, may have touched any file in it.
    const paths = watchEventPaths(event)
    const names = paths ? new Set(paths.map((path) => path.replace(/[\\/]+$/u, ''))) : null
    for (const subscription of folder.subscriptions) {
      if (names === null || names.has(subscription.name)) schedule(subscription)
    }
  }

  const open = (directory: string): FolderWatch => {
    const folder: FolderWatch = { subscriptions: new Set(), stop: null, closed: false }
    const api = getApi()
    if (typeof api?.watchPath !== 'function') return folder
    void Promise.resolve()
      .then(() => api.watchPath!(directory, (event) => deliver(folder, event)))
      .then((stop) => {
        if (folder.closed) {
          stopQuietly(stop)
          return
        }
        folder.stop = stop
      })
      .catch(() => {
        // No watch for this folder (a remote machine's, or one that is gone):
        // the tabs in it go on without one.
      })
    return folder
  }

  return {
    watch(filePath, onChange) {
      const directory = parentPath(filePath)
      let folder = folders.get(directory)
      if (!folder) {
        folder = open(directory)
        folders.set(directory, folder)
      }
      const subscription: Subscription = { name: basename(filePath), onChange, timer: null }
      folder.subscriptions.add(subscription)
      const owner = folder
      let done = false
      return () => {
        if (done) return
        done = true
        if (subscription.timer) clearTimeout(subscription.timer)
        owner.subscriptions.delete(subscription)
        if (owner.subscriptions.size > 0) return
        owner.closed = true
        if (folders.get(directory) === owner) folders.delete(directory)
        if (owner.stop) stopQuietly(owner.stop)
      }
    },
    folderCount: () => folders.size,
  }
}

const sharedWatcher = createFileDiskWatcher(() =>
  typeof window === 'undefined' ? undefined : (window.api as FileDiskWatchApi | undefined),
)

/** The window's one watcher: every editor tab in it shares the folder watches. */
export function watchFileOnDisk(filePath: string, onChange: () => void): () => void {
  return sharedWatcher.watch(filePath, onChange)
}
