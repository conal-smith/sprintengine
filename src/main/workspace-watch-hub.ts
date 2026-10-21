import { watch as fsWatch, type FSWatcher, type WatchListener } from 'fs'
import type { FileWatchEvent } from '../shared/ipc/filesystem'
import { runGitCommand } from './git-run'

/**
 * One OS watcher per watched root, shared by every caller that watches it.
 *
 * The renderer's file tree, the git status hook, the backlog scan and module
 * file watches all watched the same workspace root, each with its own recursive
 * `fs.watch` — so one `npm install` was delivered to main four times over, and
 * every one of those raw events reset a timer on main's event loop. Here the
 * root is watched once and the events are fanned out.
 *
 * Two things happen before anything leaves main:
 *
 * 1. **Churn nobody renders is dropped.** `.git/` (the gitdir watcher in
 *    git-repo-watch.ts reads that, precisely), `node_modules/`, the
 *    `.sprintengine/` sidecar an older build wrote, and build output. An install or a build inside a
 *    watched checkout is thousands of events that would otherwise each wake the
 *    file tree and the git status reader.
 * 2. **A burst becomes a SET of paths, not `path: null`.** The previous
 *    coalescing collapsed any two events inside the window to "something
 *    changed", and the two consumers read that null in opposite ways: the file
 *    tree refreshed on it (so `node_modules` churn refreshed the tree) and the
 *    git status hook ignored it (so a real edit that arrived in the same burst
 *    as anything else was silently dropped). With the paths kept, each consumer
 *    decides on what actually changed.
 *
 * A subscriber that needs the dropped directories (a module watching a file
 * under `node_modules/`) asks for `includeIgnored`, and still shares the one
 * watcher.
 */

/** Anywhere in the path: nothing under these is ever rendered from a watch. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.sprintengine', '__pycache__', '.vite', '.next', '.turbo'])
/**
 * Only at the root of the watch: the conventional build output directories. A
 * `build/` deep in a source tree is as likely to be source as output, so it is
 * left alone there. Even at the top, a file git tracks is never dropped (this
 * repository keeps its macOS entitlements in `build/`), nor is a folder that
 * holds one: only what git does not track there is build output.
 */
export const BUILD_OUTPUT_TOP_LEVEL = ['out', 'dist', 'build', 'coverage'] as const
const BUILD_OUTPUT_TOP_LEVEL_SET = new Set<string>(BUILD_OUTPUT_TOP_LEVEL)

/**
 * `isTracked` answers for a path under a top-level build directory (slashes
 * forward). The default, nothing tracked, is for a root that is not a
 * repository.
 */
export function isIgnoredWatchPath(relativePath: string, isTracked: (path: string) => boolean = () => false): boolean {
  const segments = relativePath.split(/[/\\]+/).filter(Boolean)
  if (segments.length === 0) return false
  if (segments.length > 1 && BUILD_OUTPUT_TOP_LEVEL_SET.has(segments[0]) && !isTracked(segments.join('/'))) {
    return true
  }
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment))
}

/**
 * The tracked files under `root`'s top-level build directories, and every
 * folder that leads to one, in one `ls-files`. Not a repository, or git
 * failing, answers "none": the directories are then treated as the output they
 * conventionally are.
 */
async function trackedUnderBuildDirs(root: string): Promise<Set<string>> {
  const result = await runGitCommand(root, ['ls-files', '-z', '--', ...BUILD_OUTPUT_TOP_LEVEL])
  const tracked = new Set<string>()
  if (!result.ok) return tracked
  for (const path of result.stdout.split('\0')) {
    const segments = path.split('/').filter(Boolean)
    for (let depth = 2; depth <= segments.length; depth += 1) tracked.add(segments.slice(0, depth).join('/'))
  }
  return tracked
}

/** How long a root's answer is trusted before it is asked again. */
const BUILD_DIR_CLASSIFICATION_TTL_MS = 5 * 60_000

/** Past this many distinct paths in one window a burst is reported as "many". */
export const WATCH_BATCH_PATH_LIMIT = 256
export const WATCH_COALESCE_MS = 100

type Subscriber = {
  listener: (event: FileWatchEvent) => void
  includeIgnored: boolean
  pending: Set<string>
  pendingRename: boolean
  pendingOverflow: boolean
  timer: NodeJS.Timeout | null
}

type RootWatch = {
  watcher: FSWatcher
  subscribers: Set<Subscriber>
  /** Tracked paths under the top-level build directories; null until git has answered. */
  tracked: Set<string> | null
  trackedAt: number
  classifying: boolean
}

export type WatchSubscription = { close(): void }

export type WatchHub = {
  /**
   * Starts (or joins) the watch on `root`. Throws what `fs.watch` throws — a
   * missing path in particular — so the caller can tell "cannot watch" apart.
   */
  subscribe(
    root: string,
    listener: (event: FileWatchEvent) => void,
    options?: { includeIgnored?: boolean },
  ): WatchSubscription
  /** How many OS watchers are open. For tests and diagnostics. */
  watcherCount(): number
}

type WatchFn = (path: string, options: { recursive: boolean }, listener: WatchListener<string>) => FSWatcher

export function createWatchHub(
  deps: {
    watch?: WatchFn
    platform?: NodeJS.Platform
    coalesceMs?: number
    setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout
    clearTimer?: (timer: NodeJS.Timeout) => void
    /** The tracked paths (and their folders) under a root's top-level build directories. */
    trackedBuildPaths?: (root: string) => Promise<Set<string>>
    now?: () => number
  } = {},
): WatchHub {
  const trackedBuildPaths = deps.trackedBuildPaths ?? trackedUnderBuildDirs
  const now = deps.now ?? Date.now
  const watch: WatchFn = deps.watch ?? ((path, options, listener) => fsWatch(path, options, listener))
  const platform = deps.platform ?? process.platform
  const coalesceMs = deps.coalesceMs ?? WATCH_COALESCE_MS
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((timer: NodeJS.Timeout) => clearTimeout(timer))
  const roots = new Map<string, RootWatch>()

  const keyOf = (root: string): string => root.replace(/\\/g, '/').replace(/\/+$/u, '')

  const flush = (subscriber: Subscriber): void => {
    subscriber.timer = null
    const paths = subscriber.pendingOverflow ? [] : [...subscriber.pending]
    const event: FileWatchEvent = {
      eventType: subscriber.pendingRename ? 'rename' : 'change',
      path: paths[0] ?? null,
      paths,
      ...(subscriber.pendingOverflow ? { overflow: true } : {}),
    }
    subscriber.pending = new Set()
    subscriber.pendingRename = false
    subscriber.pendingOverflow = false
    try {
      subscriber.listener(event)
    } catch (error) {
      console.warn('[watch-hub] listener threw', error)
    }
  }

  /**
   * Whether a path under a top-level build directory is tracked. Git is asked
   * the first time an event lands in one of them, and again after the TTL or
   * when the index moves (`git add` / `git rm` rewrite `.git/index`). Until the
   * first answer arrives everything counts as tracked, so no edit is lost to
   * the wait; a refresh keeps using the previous answer meanwhile.
   */
  const trackedLookup = (entry: RootWatch, root: string, filename: string): ((path: string) => boolean) => {
    const segments = filename.split(/[/\\]+/)
    if (segments.length === 2 && segments[0] === '.git' && segments[1] === 'index') entry.trackedAt = 0
    if (!BUILD_OUTPUT_TOP_LEVEL_SET.has(segments[0] ?? '')) return () => true
    const stale = entry.tracked === null || now() - entry.trackedAt > BUILD_DIR_CLASSIFICATION_TTL_MS
    if (stale && !entry.classifying) {
      entry.classifying = true
      void trackedBuildPaths(root)
        .catch(() => new Set<string>())
        .then((tracked) => {
          entry.classifying = false
          entry.tracked = tracked
          entry.trackedAt = now()
        })
    }
    const tracked = entry.tracked
    return tracked ? (path) => tracked.has(path) : () => true
  }

  const deliver = (entry: RootWatch, root: string, eventType: string, filename: string | null): void => {
    const ignored = filename !== null && isIgnoredWatchPath(filename, trackedLookup(entry, root, filename))
    for (const subscriber of entry.subscribers) {
      if (ignored && !subscriber.includeIgnored) continue
      if (filename === null || subscriber.pending.size >= WATCH_BATCH_PATH_LIMIT) {
        // No name from the OS, or too many names to be worth sending: the
        // consumer is told "re-read", which every consumer already handles.
        subscriber.pendingOverflow = true
      } else {
        subscriber.pending.add(filename)
      }
      if (eventType === 'rename') subscriber.pendingRename = true
      // Armed once per window and never re-armed per event: a burst of ten
      // thousand events costs one timer, not ten thousand resets of one.
      if (!subscriber.timer) subscriber.timer = setTimer(() => flush(subscriber), coalesceMs)
    }
  }

  const open = (root: string): RootWatch => {
    const entry: RootWatch = {
      watcher: null as unknown as FSWatcher,
      subscribers: new Set(),
      tracked: null,
      trackedAt: 0,
      classifying: false,
    }
    const listener: WatchListener<string> = (eventType, filename) => {
      deliver(entry, root, eventType, typeof filename === 'string' && filename ? filename : null)
    }
    const recursive = platform === 'win32' || platform === 'darwin'
    try {
      entry.watcher = watch(root, { recursive }, listener)
    } catch (error) {
      if (!recursive || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      entry.watcher = watch(root, { recursive: false }, listener)
    }
    // An FSWatcher that errors (the root deleted, a network mount dropping)
    // emits 'error', which with no listener would throw on main. The watch is
    // over; subscribers keep their subscription objects and simply hear no
    // more, the same as the single-watcher code before this.
    entry.watcher.on('error', () => {
      try {
        entry.watcher.close()
      } catch {
        // Already closed.
      }
      if (roots.get(keyOf(root)) === entry) roots.delete(keyOf(root))
    })
    return entry
  }

  return {
    subscribe(root, listener, options = {}) {
      const key = keyOf(root)
      let entry = roots.get(key)
      if (!entry) {
        entry = open(root)
        roots.set(key, entry)
      }
      const subscriber: Subscriber = {
        listener,
        includeIgnored: options.includeIgnored === true,
        pending: new Set(),
        pendingRename: false,
        pendingOverflow: false,
        timer: null,
      }
      entry.subscribers.add(subscriber)
      const owner = entry
      let closed = false
      return {
        close() {
          if (closed) return
          closed = true
          if (subscriber.timer) clearTimer(subscriber.timer)
          owner.subscribers.delete(subscriber)
          if (owner.subscribers.size === 0) {
            try {
              owner.watcher.close()
            } catch {
              // Already closed.
            }
            if (roots.get(key) === owner) roots.delete(key)
          }
        },
      }
    },
    watcherCount: () => roots.size,
  }
}

let sharedHub: WatchHub | null = null

/** The process-wide hub. Main's file watch IPC and the quick-open cache share it. */
export function getWatchHub(): WatchHub {
  sharedHub ??= createWatchHub()
  return sharedHub
}
