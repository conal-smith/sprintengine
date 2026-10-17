import { useEffect, useState, useSyncExternalStore } from 'react'
import { normalizePathKey } from '../hooks/useGitStatus'
import { isWatchEventIgnored, watchEventPaths } from '../../../shared/file-watch-event'
import type { FileWatchEvent } from '../../../shared/ipc/filesystem'
import { isPathOrChild } from './paths'
import {
  isIgnoredTreeWatchPath,
  joinTreePath,
  parentDirectoriesForPath,
  pathSeparatorFor,
  toTreeEntries,
  type FileTreeEntry,
} from './fileTreeEntries'

// The data side of a file tree, one per ROOT and shared by every view of that
// root in this window: the directory listings read so far, one watch on the
// root, a debounced re-read when the watch fires, the `git check-ignore`
// answers per folder, and the reveal that lists a file's ancestors.
//
// It used to live in the Files pane's component state, which meant a second
// tree (the editor window's) would have been a second copy of all of it — a
// second watcher on the same root, a second cache, and a second place for
// reveal to read more than it needs. What stays with each VIEW is what is
// genuinely the view's: which folders are open, what is selected, whether a
// rename is in progress. The model never learns any of that, so two views of
// one root can open different folders without either one's choice leaking.
//
// Ref-counted: `acquireFileTreeModel` hands out the model and a release; the
// watch starts with the first holder and stops with the last, and the cache
// goes with it. Views read it through `useSyncExternalStore`, the same way the
// editor buffers are read (utils/editorBuffers.ts).

export type FileTreeSnapshot = {
  readonly rootPath: string
  /** Null until the root has been listed once. */
  readonly rootEntries: FileTreeEntry[] | null
  /** Listings of every folder read so far, keyed by the folder's path. */
  readonly childrenByPath: Readonly<Record<string, FileTreeEntry[]>>
  /** Normalised paths (`normalizePathKey`) git ignores, for the folders checked so far. */
  readonly ignoredKeys: ReadonlySet<string>
  /** Why the root could not be listed, when it could not. */
  readonly rootError: string | null
}

export type FileTreeModelApi = {
  readdir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
  watchPath: (path: string, cb: (event: FileWatchEvent) => void) => Promise<() => Promise<void>>
  checkIgnored?: (repoRoot: string, relativePaths: string[]) => Promise<string[]>
}

export type FileTreeRevealHandle = {
  /** The ancestors the reveal opened, outermost first; null when cancelled or outside the root. */
  readonly done: Promise<string[] | null>
  cancel: () => void
}

export type FileTreeModel = {
  readonly rootPath: string
  getSnapshot: () => FileTreeSnapshot
  subscribe: (listener: () => void) => () => void
  isLoaded: (dirPath: string) => boolean
  /** Read a folder now, whether or not it is cached. */
  loadDirectory: (dirPath: string) => Promise<FileTreeEntry[]>
  /** Read a folder only if it has not been read; concurrent calls share one read. */
  ensureLoaded: (dirPath: string) => Promise<void>
  /**
   * Re-read folders. With no argument, every folder read so far. A folder that
   * can no longer be read is dropped from the cache (with everything under it);
   * the root failing is reported on the snapshot instead.
   */
  refresh: (dirPaths?: readonly string[]) => Promise<void>
  /**
   * List exactly the folders between the root and `filePath` that are not
   * listed yet — nothing else, and nothing below the file. Cancellable: a
   * cancelled reveal stops reading at the next folder.
   */
  reveal: (filePath: string) => FileTreeRevealHandle
  /** The repository the ignore checks are asked against; changing it re-checks every folder read. */
  setRepoRoot: (repoRoot: string | null) => void
  /** Forget every ignore answer and ask again for each folder read so far. */
  recheckIgnored: () => void
  /** A folder was renamed or moved: carry its listings to the new path. */
  remap: (fromPath: string, toPath: string) => void
  /** A folder is gone: drop its listing and everything under it. */
  forget: (path: string) => void
}

/** How long a burst of watch events is left to settle before the tree re-reads. */
export const FILE_TREE_WATCH_DEBOUNCE_MS = 150

// Above this many entries, a folder is first asked about as a whole. Git looks
// every path it is given up in the index, so asking about each child costs the
// folder's width times the repository's size — over a second for a wide build
// folder in a large checkout — while one question about the folder costs one
// lookup. Below it the per-child answer is already cheap, and the extra spawn a
// "not ignored" folder pays would cost more than it saves.
const WHOLE_FOLDER_IGNORE_CHECK_MIN_ENTRIES = 200

type Holder = { model: FileTreeModel; refs: number; dispose: () => void }

const registry = new Map<string, Holder>()

// The root as given, trailing separator trimmed. Not case-folded: two roots
// that differ only in case are two folders on a case-sensitive filesystem.
function modelKey(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/, '') || rootPath
}

function remapPrefix(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  const prefix = `${fromPath}${pathSeparatorFor(fromPath)}`
  return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : path
}

function toRepoRelative(repoRoot: string, absolutePath: string): string | null {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = absolutePath.replace(/\\/g, '/')
  if (!path.startsWith(`${root}/`)) return null
  return path.slice(root.length + 1)
}

// Whether git would read a relative path as the literal path it is. A leading
// `:` is pathspec magic and `*?[\` are pattern characters, so for those the
// folder's answer would be about something else.
function isLiteralGitPath(relative: string): boolean {
  return !relative.startsWith(':') && !/[*?[\\]/.test(relative)
}

function createFileTreeModel(rootPath: string, api: FileTreeModelApi): Holder {
  let snapshot: FileTreeSnapshot = {
    rootPath,
    rootEntries: null,
    childrenByPath: {},
    ignoredKeys: new Set(),
    rootError: null,
  }
  const listeners = new Set<() => void>()
  const inflight = new Map<string, Promise<FileTreeEntry[]>>()
  // Per folder: bumped when that folder's listing is invalidated (forget or
  // remap of it or an ancestor), so a read already on the wire for THAT folder
  // cannot resurrect what was just dropped — while a sibling's read, which
  // nothing invalidated, still lands.
  const generations = new Map<string, number>()
  const generationOf = (dirPath: string) => generations.get(dirPath) ?? 0
  const invalidateUnder = (path: string) => {
    for (const dirPath of new Set([...inflight.keys(), ...Object.keys(snapshot.childrenByPath), path])) {
      if (!isPathOrChild(dirPath, path)) continue
      generations.set(dirPath, generationOf(dirPath) + 1)
      inflight.delete(dirPath)
    }
  }
  let disposed = false

  let repoRoot: string | null = null
  let ignoreGeneration = 0
  const checkedDirectories = new Set<string>()

  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let pendingRefreshAll = false
  const pendingRefreshDirs = new Set<string>()
  let stopWatching: (() => Promise<void>) | null = null

  const emit = () => {
    for (const listener of [...listeners]) listener()
  }

  const setSnapshot = (next: Partial<FileTreeSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    emit()
  }

  const isLoaded = (dirPath: string) =>
    dirPath === rootPath ? snapshot.rootEntries !== null : snapshot.childrenByPath[dirPath] !== undefined

  const loadedDirectories = (): string[] => [
    ...(snapshot.rootEntries !== null ? [rootPath] : []),
    ...Object.keys(snapshot.childrenByPath),
  ]

  // One `check-ignore` per folder, when its listing lands: the whole listing is
  // in hand exactly once, which keeps this to a single spawn per folder the
  // person actually opens rather than one per row. A wide folder may cost a
  // second one, when asking about the folder as a whole first did not settle it.
  const checkIgnoredDirectory = (dirPath: string, entries: FileTreeEntry[]) => {
    if (!repoRoot || !api.checkIgnored || entries.length === 0) return
    if (checkedDirectories.has(dirPath)) return
    checkedDirectories.add(dirPath)
    const generation = ignoreGeneration
    const relativeByPath = new Map<string, string>()
    for (const entry of entries) {
      if (entry.gitDeleted) continue
      const relative = toRepoRelative(repoRoot, entry.path)
      // A path outside the repo has no ignore answer; leaving it out is what
      // makes it render at full strength rather than at random.
      if (relative) relativeByPath.set(relative, entry.path)
    }
    if (relativeByPath.size === 0) return
    // Everything under an ignored folder is ignored, so a folder opened inside
    // one is answered from its parent without asking git at all.
    if (snapshot.ignoredKeys.has(normalizePathKey(dirPath))) {
      const next = new Set(snapshot.ignoredKeys)
      for (const absolutePath of relativeByPath.values()) next.add(normalizePathKey(absolutePath))
      setSnapshot({ ignoredKeys: next })
      return
    }
    const root = repoRoot
    const checkIgnored = api.checkIgnored
    // Git calls a folder ignored only when nothing under it is tracked, so a
    // "yes" for the folder holds for every child in it. The repo root has no
    // relative path to ask about.
    const folderRelative =
      relativeByPath.size > WHOLE_FOLDER_IGNORE_CHECK_MIN_ENTRIES ? toRepoRelative(root, dirPath) : null
    const folderToAsk = folderRelative && isLiteralGitPath(folderRelative) ? folderRelative : null
    const ignoredChildren = async (): Promise<string[]> => {
      if (folderToAsk) {
        const folderIgnored = await checkIgnored(root, [folderToAsk])
        if (folderIgnored.includes(folderToAsk)) return [...relativeByPath.keys()]
        if (disposed || generation !== ignoreGeneration) return []
      }
      return checkIgnored(root, [...relativeByPath.keys()])
    }
    void ignoredChildren()
      .then((ignoredRelative) => {
        if (disposed || generation !== ignoreGeneration || ignoredRelative.length === 0) return
        const next = new Set(snapshot.ignoredKeys)
        for (const relative of ignoredRelative) {
          const absolutePath = relativeByPath.get(relative)
          if (absolutePath) next.add(normalizePathKey(absolutePath))
        }
        setSnapshot({ ignoredKeys: next })
      })
      .catch(() => {
        // "Nothing ignored here" is what the empty answer already says; let
        // the folder be asked again, since the failure may have been transient.
        checkedDirectories.delete(dirPath)
      })
  }

  const store = (dirPath: string, entries: FileTreeEntry[]) => {
    if (dirPath === rootPath) {
      setSnapshot({ rootEntries: entries, rootError: null })
    } else {
      setSnapshot({ childrenByPath: { ...snapshot.childrenByPath, [dirPath]: entries } })
    }
  }

  const loadDirectory = (dirPath: string): Promise<FileTreeEntry[]> => {
    const startedGeneration = generationOf(dirPath)
    const read = api.readdir(dirPath).then((raw) => {
      const entries = toTreeEntries(raw, dirPath)
      if (!disposed && startedGeneration === generationOf(dirPath)) {
        store(dirPath, entries)
        checkIgnoredDirectory(dirPath, entries)
      }
      return entries
    })
    const shared = read.finally(() => {
      if (inflight.get(dirPath) === shared) inflight.delete(dirPath)
    })
    inflight.set(dirPath, shared)
    return shared
  }

  const ensureLoaded = async (dirPath: string): Promise<void> => {
    if (isLoaded(dirPath)) return
    const pending = inflight.get(dirPath)
    if (pending) {
      await pending
      return
    }
    await loadDirectory(dirPath)
  }

  const forget = (path: string) => {
    invalidateUnder(path)
    const next: Record<string, FileTreeEntry[]> = {}
    let changed = false
    for (const [dirPath, entries] of Object.entries(snapshot.childrenByPath)) {
      if (isPathOrChild(dirPath, path)) {
        changed = true
        checkedDirectories.delete(dirPath)
        continue
      }
      next[dirPath] = entries
    }
    if (changed) setSnapshot({ childrenByPath: next })
  }

  const refresh = async (dirPaths?: readonly string[]): Promise<void> => {
    const targets = Array.from(new Set(dirPaths ?? loadedDirectories()))
    await Promise.all(
      targets.map(async (dirPath) => {
        try {
          await loadDirectory(dirPath)
        } catch (error) {
          if (disposed) return
          if (dirPath === rootPath) {
            setSnapshot({ rootError: error instanceof Error ? error.message : String(error) })
            return
          }
          forget(dirPath)
        }
      }),
    )
  }

  const flushWatchRefresh = () => {
    refreshTimer = null
    if (disposed) return
    const all = pendingRefreshAll
    const dirs = [...pendingRefreshDirs]
    pendingRefreshAll = false
    pendingRefreshDirs.clear()
    void refresh(all ? undefined : dirs)
  }

  // A watch event names root-relative paths. The folders to re-read are the
  // PARENTS of those paths (an entry appeared or left there) plus the paths
  // themselves when they are folders we hold (a folder that was replaced or
  // removed) — and only the ones already read: a change inside a folder nobody
  // has opened costs nothing. An event naming no paths re-reads what is held.
  const onWatchEvent = (event: FileWatchEvent) => {
    if (isWatchEventIgnored(event, isIgnoredTreeWatchPath)) return
    const paths = watchEventPaths(event)
    if (paths === null) {
      pendingRefreshAll = true
    } else {
      for (const relative of paths) {
        if (isIgnoredTreeWatchPath(relative)) continue
        const absolute = joinTreePath(rootPath, relative.replace(/^[\\/]+/, ''))
        const parents = [rootPath, ...parentDirectoriesForPath(rootPath, absolute)]
        const parent = parents[parents.length - 1] ?? rootPath
        if (isLoaded(parent)) pendingRefreshDirs.add(parent)
        if (absolute !== rootPath && isLoaded(absolute)) pendingRefreshDirs.add(absolute)
      }
      if (pendingRefreshDirs.size === 0 && !pendingRefreshAll) return
    }
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(flushWatchRefresh, FILE_TREE_WATCH_DEBOUNCE_MS)
  }

  void api
    .watchPath(rootPath, onWatchEvent)
    .then((cleanup) => {
      if (disposed) {
        void cleanup()
        return
      }
      stopWatching = cleanup
    })
    .catch(() => {
      // Some filesystems do not support watch events; the tree still reads,
      // and a manual refresh still works.
    })

  const reveal = (filePath: string): FileTreeRevealHandle => {
    let cancelled = false
    const done = (async () => {
      if (!isPathOrChild(filePath, rootPath) || filePath === rootPath) return null
      const ancestors = parentDirectoriesForPath(rootPath, filePath)
      await ensureLoaded(rootPath)
      for (const directory of ancestors) {
        if (cancelled || disposed) return null
        await ensureLoaded(directory)
      }
      if (cancelled || disposed) return null
      // A folder on the way that was dropped while the reveal ran (deleted,
      // renamed) is not listed: say so, rather than expand to nothing.
      return ancestors.every((directory) => isLoaded(directory)) ? ancestors : null
    })()
    return {
      done,
      cancel: () => {
        cancelled = true
      },
    }
  }

  const recheckIgnored = () => {
    ignoreGeneration += 1
    checkedDirectories.clear()
    if (snapshot.ignoredKeys.size > 0) setSnapshot({ ignoredKeys: new Set() })
    if (snapshot.rootEntries) checkIgnoredDirectory(rootPath, snapshot.rootEntries)
    for (const [dirPath, entries] of Object.entries(snapshot.childrenByPath)) checkIgnoredDirectory(dirPath, entries)
  }

  const model: FileTreeModel = {
    rootPath,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isLoaded,
    loadDirectory,
    ensureLoaded,
    refresh,
    reveal,
    setRepoRoot: (next) => {
      if (next === repoRoot) return
      repoRoot = next
      recheckIgnored()
    },
    recheckIgnored,
    remap: (fromPath, toPath) => {
      invalidateUnder(fromPath)
      invalidateUnder(toPath)
      const next: Record<string, FileTreeEntry[]> = {}
      for (const [dirPath, entries] of Object.entries(snapshot.childrenByPath)) {
        next[remapPrefix(dirPath, fromPath, toPath)] = entries.map((entry) => ({
          ...entry,
          path: remapPrefix(entry.path, fromPath, toPath),
          parentPath: remapPrefix(entry.parentPath, fromPath, toPath),
        }))
      }
      setSnapshot({ childrenByPath: next })
    },
    forget,
  }

  const dispose = () => {
    disposed = true
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
    listeners.clear()
    if (stopWatching) void stopWatching()
    stopWatching = null
  }

  return { model, refs: 0, dispose }
}

/**
 * Hold the tree model for a root. The first holder starts its watch; the last
 * `release` stops it and drops the cache. Release is idempotent.
 */
export function acquireFileTreeModel(
  rootPath: string,
  api: FileTreeModelApi = window.api,
): { model: FileTreeModel; release: () => void } {
  const key = modelKey(rootPath)
  let holder = registry.get(key)
  if (!holder) {
    holder = createFileTreeModel(rootPath, api)
    registry.set(key, holder)
  }
  holder.refs += 1
  const held = holder
  let released = false
  return {
    model: held.model,
    release: () => {
      if (released) return
      released = true
      held.refs -= 1
      if (held.refs > 0) return
      held.dispose()
      if (registry.get(key) === held) registry.delete(key)
    },
  }
}

/** How many roots currently have a live model. For tests and diagnostics. */
export function liveFileTreeModelCount(): number {
  return registry.size
}

const EMPTY_SNAPSHOT: FileTreeSnapshot = {
  rootPath: '',
  rootEntries: null,
  childrenByPath: {},
  ignoredKeys: new Set(),
  rootError: null,
}
const NO_SUBSCRIPTION = () => () => {}
const EMPTY_SNAPSHOT_GETTER = () => EMPTY_SNAPSHOT

/**
 * The model for a root, held for as long as the calling component is mounted
 * on that root, and its snapshot. Null root means no model and an empty
 * snapshot.
 */
export function useFileTreeModel(rootPath: string | null): {
  model: FileTreeModel | null
  snapshot: FileTreeSnapshot
} {
  const [model, setModel] = useState<FileTreeModel | null>(null)

  useEffect(() => {
    if (!rootPath) {
      setModel(null)
      return
    }
    const { model: acquired, release } = acquireFileTreeModel(rootPath)
    setModel(acquired)
    return () => {
      release()
    }
  }, [rootPath])

  // The model state lags the root by one commit; never hand out a model for a
  // root the caller has already moved off.
  const current = model && rootPath && modelKey(model.rootPath) === modelKey(rootPath) ? model : null
  const snapshot = useSyncExternalStore(
    current ? current.subscribe : NO_SUBSCRIPTION,
    current ? current.getSnapshot : EMPTY_SNAPSHOT_GETTER,
  )
  return { model: current, snapshot }
}
