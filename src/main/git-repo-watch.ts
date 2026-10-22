import { createHash } from 'crypto'
import { watch as fsWatch, type FSWatcher } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { GitCheckoutChange, GitCheckoutChangeKind } from '../shared/ipc/git'
import { runGitCommand, withNeutralRepoPrograms } from './git-run'

/**
 * One main-side schedule for every git READ the views make, driven by the
 * repository's own files instead of by timers.
 *
 * The Git pane polled status, branches, stashes, the commit graph and the
 * worktree list every 10 s; the sidebar re-read every open checkout's branch
 * span every 30 s (about twenty git processes per checkout); the branch chip
 * asked every 20 s. With ten agent worktrees open that was hundreds of git
 * processes a minute on an idle machine. Almost every one of those answers can
 * only change when one of a handful of files in the git directory changes, so
 * this watches those files and tells the views which of their readings went
 * stale:
 *
 * - `worktree` — the index or HEAD of ONE checkout moved (a stage, a commit, a
 *   checkout, a merge or rebase starting or stopping). Status and the row's
 *   diff are stale; the graph and the branch list are not, unless `refs` is
 *   also set.
 * - `refs` — a ref moved: a branch or tag written under `refs/`, a
 *   `packed-refs` rewrite, a HEAD switch, or a worktree added or removed. The
 *   graph, branches, stashes and worktree list are stale, for every checkout of
 *   the repository, because they all share one ref store.
 *
 * What it watches, per repository, all non-recursive except `refs/`:
 *
 *   <common>/            HEAD, index, packed-refs, operation markers (primary)
 *   <common>/refs/       recursive: every loose ref
 *   <common>/reftable/   every ref, in a repository on the reftable backend
 *   <common>/worktrees/  a worktree registered or removed
 *   <gitdir>/            HEAD, index, operation markers (each linked worktree)
 *   <gitdir>/reftable/   a linked worktree's own HEAD, on the reftable backend
 *
 * A folder that is not there yet (`worktrees/` before the first linked
 * worktree, `reftable/` in a files-backend repository) is still counted, and
 * watched once the common dir reports it appearing.
 *
 * Edits to files in the WORKING tree are not visible here — git has not seen
 * them either until something stats them. Those reach the views through the
 * workspace watcher (useGitStatus), through an agent's turn ending in the
 * checkout (`noteActivity`, fed by the observed-checkout resolver), and through
 * the slow fallback below.
 *
 * Two rules keep it cheap:
 *
 * - **Nothing is sent while no window is focused.** Changes are held and
 *   delivered as one batch on focus, so a machine with the app in the
 *   background runs no view reads at all.
 * - **A slow fallback** (five minutes, focused only) for the changes no
 *   watcher can see: a working-tree edit nobody reported, a filesystem whose
 *   watch events do not arrive (network mounts). It takes one reading of each
 *   checkout (`readCheckoutState`) and marks stale only the ones whose reading
 *   moved since the last tick, rather than sending every view of every
 *   checkout back to git.
 *
 * A repository inside a WSL distribution is watched from inside it: a watch
 * Windows places on a `\\wsl.localhost` path is accepted but hears nothing,
 * so the caller's `watch` hands those directories to the distribution's
 * helper (git-repo-watch-ipc.ts), whose events arrive here the same way.
 *
 * Our own polling cannot wake it: it runs with `GIT_OPTIONAL_LOCKS=0`
 * (git-run.ts), so `git status` never rewrites the index it is watching, and
 * compares with the working tree through `git diff-index`, which never does.
 */

export type { GitCheckoutChange, GitCheckoutChangeKind }

/**
 * Five minutes: the top of the range. A checkout whose reading moved has its
 * sidebar row re-read (about twenty git processes), so this number is most of
 * the idle cost that remains. What it backs up is narrow: a ref written behind
 * a watcher's back, or a working-tree edit made outside any watched folder by
 * something that is not an agent (an agent's turn end is reported on its own).
 */
export const GIT_REPO_WATCH_FALLBACK_MS = 5 * 60_000
export const GIT_REPO_WATCH_DEBOUNCE_MS = 300

/** How a checkout path is spelled as a key, here and in the preload. */
export function checkoutKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

type GitDirs = { toplevel: string; gitDir: string; commonDir: string }

/**
 * The toplevel and both git directories for a checkout, in one `rev-parse`.
 * Null when the path is not a checkout (the caller simply watches nothing).
 */
export function resolveGitDirs(checkoutPath: string): Promise<GitDirs | null> {
  // The app's own read: an untrusted repository's programs stay off (git-run.ts).
  return withNeutralRepoPrograms(() => resolveGitDirsUnscoped(checkoutPath))
}

async function resolveGitDirsUnscoped(checkoutPath: string): Promise<GitDirs | null> {
  const result = await runGitCommand(checkoutPath, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
  ])
  if (!result.ok) return null
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  // A git older than 2.31 echoes the unknown flag and answers the common dir
  // relative to the cwd.
  const echoed = lines[0]?.startsWith('--') ?? false
  const [toplevel, gitDir, common] = echoed ? lines.slice(1) : lines
  if (!toplevel || !gitDir || !common) return null
  return { toplevel, gitDir, commonDir: isAbsolute(common) ? common : resolve(checkoutPath, common) }
}

/**
 * One git process that moves whenever anything the fallback stands in for
 * does: the branch, HEAD and upstream with its ahead/behind, and every
 * changed, staged or untracked path. Hashed, since only equality is asked of
 * it. Null when it could not be read, which counts as moved. A ref other than
 * the checkout's own branch and upstream, moved where no watcher sees it, is
 * not in it; that is left to the next view read anything else causes.
 */
export function readCheckoutState(checkoutPath: string): Promise<string | null> {
  // The app's own read: an untrusted repository's programs stay off (git-run.ts).
  return withNeutralRepoPrograms(() => readCheckoutStateUnscoped(checkoutPath))
}

async function readCheckoutStateUnscoped(checkoutPath: string): Promise<string | null> {
  const result = await runGitCommand(checkoutPath, ['status', '--porcelain=v2', '--branch', '-z'])
  if (!result.ok) return null
  return createHash('sha1').update(result.stdout).digest('hex')
}

// Files in a git directory whose change means the checkout's status moved.
const WORKTREE_FILES = new Set([
  'index',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'BISECT_LOG',
])

/** What a change to `filename` inside a git directory means, or null for noise. */
export function classifyGitDirEntry(filename: string | null, isCommonDir: boolean): GitCheckoutChangeKind[] | null {
  if (filename === null) return ['worktree', 'refs']
  const name = filename.endsWith('.lock') ? filename.slice(0, -'.lock'.length) : filename
  if (name === 'HEAD') return ['worktree', 'refs']
  if (WORKTREE_FILES.has(name)) return ['worktree']
  if (isCommonDir && (name === 'packed-refs' || name === 'worktrees' || name === 'refs' || name === 'reftable')) {
    return ['refs']
  }
  // FETCH_HEAD, ORIG_HEAD, COMMIT_EDITMSG, logs/, objects/, config, gc files:
  // none of them changes what a view shows (a fetch that moved a ref is seen
  // under refs/).
  return null
}

/** The part of `fs.FSWatcher` this module uses, so a watch run elsewhere (a WSL helper's) can stand in. */
export type GitDirWatcher = Pick<FSWatcher, 'close'> & {
  on?(event: 'error', listener: (error: Error) => void): unknown
}

export type WatchFn = (
  path: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => GitDirWatcher

type CheckoutRecord = {
  key: string
  refCount: number
  dirs: GitDirs | null
  resolving: Promise<void> | null
  /** The fallback's last reading; undefined before its first. */
  reading?: string | null
}

type DirWatch = { watcher: GitDirWatcher | null; users: number; recursive: boolean }

/** Folders of the common dir that can come and go while a checkout is watched. */
const LATE_COMMON_DIRS = new Set(['worktrees', 'reftable'])

export type GitRepoWatchDeps = {
  resolveDirs?: (checkoutPath: string) => Promise<GitDirs | null>
  readCheckout?: (checkoutPath: string) => Promise<string | null>
  watch?: WatchFn
  emit: (changes: GitCheckoutChange[]) => void
  debounceMs?: number
  fallbackMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  setRepeating?: (callback: () => void, ms: number) => unknown
  clearRepeating?: (timer: unknown) => void
}

export function createGitRepoWatch(deps: GitRepoWatchDeps) {
  const resolveDirs = deps.resolveDirs ?? resolveGitDirs
  const readCheckout = deps.readCheckout ?? readCheckoutState
  const watch: WatchFn =
    deps.watch ??
    ((path, options, listener) =>
      fsWatch(path, options, (event, filename) => listener(event, typeof filename === 'string' ? filename : null)))
  const debounceMs = deps.debounceMs ?? GIT_REPO_WATCH_DEBOUNCE_MS
  const fallbackMs = deps.fallbackMs ?? GIT_REPO_WATCH_FALLBACK_MS
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout))
  const setRepeating = deps.setRepeating ?? ((callback: () => void, ms: number) => setInterval(callback, ms))
  const clearRepeating = deps.clearRepeating ?? ((timer: unknown) => clearInterval(timer as NodeJS.Timeout))

  const checkouts = new Map<string, CheckoutRecord>()
  const dirWatches = new Map<string, DirWatch>()
  const pending = new Map<string, { kinds: Set<GitCheckoutChangeKind>; reason: GitCheckoutChange['reason'] }>()
  let flushTimer: unknown = null
  let focused = true
  let fallbackTimer: unknown = null
  let fallbackRunning = false

  const dirKey = (path: string): string => checkoutKey(path)

  const mark = (
    keys: Iterable<string>,
    kinds: readonly GitCheckoutChangeKind[],
    reason: GitCheckoutChange['reason'],
  ) => {
    let marked = false
    for (const key of keys) {
      if (!checkouts.has(key)) continue
      const entry = pending.get(key) ?? { kinds: new Set<GitCheckoutChangeKind>(), reason }
      for (const kind of kinds) entry.kinds.add(kind)
      // A gitdir reason outranks the others: it is the most specific.
      if (reason === 'gitdir') entry.reason = 'gitdir'
      pending.set(key, entry)
      marked = true
    }
    if (marked && focused && flushTimer === null) {
      // Armed once per window, never reset: a rebase touching HEAD a hundred
      // times is one delivery.
      flushTimer = setTimer(flush, debounceMs)
    }
  }

  const flush = (): void => {
    flushTimer = null
    if (!focused || pending.size === 0) return
    const changes: GitCheckoutChange[] = [...pending.entries()].map(([key, entry]) => ({
      checkoutKey: key,
      kinds: [...entry.kinds].sort(),
      reason: entry.reason,
    }))
    pending.clear()
    deps.emit(changes)
  }

  /** Every retained checkout whose git dirs match. */
  const checkoutsWhere = (predicate: (dirs: GitDirs) => boolean): string[] =>
    [...checkouts.values()].filter((record) => record.dirs && predicate(record.dirs)).map((record) => record.key)

  const onDirEvent = (dir: string, filename: string | null): void => {
    const key = dirKey(dir)
    const inRepo = (commonDir: string): string[] =>
      checkoutsWhere((dirs) => dirKey(dirs.commonDir) === dirKey(commonDir))

    // `refs/`, `reftable/` or `worktrees/`: the shared ref store, so every
    // checkout of the repository.
    for (const record of checkouts.values()) {
      const dirs = record.dirs
      if (!dirs) continue
      if (
        key === dirKey(join(dirs.commonDir, 'refs')) ||
        key === dirKey(join(dirs.commonDir, 'reftable')) ||
        key === dirKey(join(dirs.commonDir, 'worktrees'))
      ) {
        mark(inRepo(dirs.commonDir), ['refs'], 'gitdir')
        return
      }
      // A linked checkout's own reftable holds its HEAD, as its HEAD file
      // does under the files backend.
      if (dirKey(dirs.gitDir) !== dirKey(dirs.commonDir) && key === dirKey(join(dirs.gitDir, 'reftable'))) {
        mark(
          checkoutsWhere((other) => dirKey(other.gitDir) === dirKey(dirs.gitDir)),
          ['worktree', 'refs'],
          'gitdir',
        )
        return
      }
    }

    const isCommonDir = checkoutsWhere((dirs) => dirKey(dirs.commonDir) === key).length > 0
    // `worktrees/` appears with the first linked worktree and goes with the
    // last one pruned. A watch asked for while it was missing, or held on the
    // folder that went, is taken again now; otherwise registering or removing
    // a worktree would never be seen again. `reftable/` the same, for a
    // repository migrated to it while watched.
    if (isCommonDir) {
      if (filename !== null && LATE_COMMON_DIRS.has(filename)) rewatchDir(join(dir, filename))
      // No filename says nothing about which entry moved: only the missing
      // watches are retried.
      if (filename === null) for (const name of LATE_COMMON_DIRS) rewatchDir(join(dir, name), { onlyIfMissing: true })
    }
    const kinds = classifyGitDirEntry(filename, isCommonDir)
    if (!kinds) return
    // `packed-refs` and friends: repository-wide.
    if (isCommonDir && kinds.length === 1 && kinds[0] === 'refs') {
      mark(inRepo(dir), ['refs'], 'gitdir')
      return
    }
    // HEAD, index, an operation marker: the checkout that owns this git dir
    // (for the common dir, that is the primary checkout).
    mark(
      checkoutsWhere((dirs) => dirKey(dirs.gitDir) === key),
      kinds,
      'gitdir',
    )
  }

  const closeQuietly = (watcher: GitDirWatcher | null): void => {
    try {
      watcher?.close()
    } catch {
      // Already closed.
    }
  }

  /** A watcher on `dir`, or null when it is not there (no `worktrees/` yet) or not watchable. */
  const openWatcher = (dir: string, recursive: boolean): GitDirWatcher | null => {
    const key = dirKey(dir)
    let watcher: GitDirWatcher
    try {
      watcher = watch(dir, { recursive }, (_event, filename) => onDirEvent(dir, filename))
    } catch {
      if (!recursive) return null
      try {
        // A platform without recursive watching still sees the top of
        // `refs/` (`refs/stash`, a new namespace); the fallback covers a
        // branch written deeper.
        watcher = watch(dir, { recursive: false }, (_event, filename) => onDirEvent(dir, filename))
      } catch {
        return null
      }
    }
    watcher.on?.('error', () => {
      closeQuietly(watcher)
      // The users stay counted, so a later rewatch can take it again.
      const entry = dirWatches.get(key)
      if (entry?.watcher === watcher) entry.watcher = null
    })
    return watcher
  }

  // A folder's users are counted whether or not it could be watched, so one
  // that appears later is watched for exactly the checkouts that asked for it.
  const retainDir = (dir: string, recursive: boolean): void => {
    const key = dirKey(dir)
    const existing = dirWatches.get(key)
    if (existing) {
      existing.users += 1
      if (!existing.watcher) existing.watcher = openWatcher(dir, existing.recursive)
      return
    }
    dirWatches.set(key, { watcher: openWatcher(dir, recursive), users: 1, recursive })
  }

  const rewatchDir = (dir: string, options: { onlyIfMissing?: boolean } = {}): void => {
    const entry = dirWatches.get(dirKey(dir))
    if (!entry || (options.onlyIfMissing && entry.watcher)) return
    closeQuietly(entry.watcher)
    entry.watcher = openWatcher(dir, entry.recursive)
  }

  const releaseDir = (dir: string): void => {
    const key = dirKey(dir)
    const existing = dirWatches.get(key)
    if (!existing) return
    existing.users -= 1
    if (existing.users > 0) return
    closeQuietly(existing.watcher)
    dirWatches.delete(key)
  }

  const dirsToWatch = (dirs: GitDirs): Array<{ dir: string; recursive: boolean }> => {
    const list = [
      { dir: dirs.commonDir, recursive: false },
      { dir: join(dirs.commonDir, 'refs'), recursive: true },
      { dir: join(dirs.commonDir, 'reftable'), recursive: false },
      { dir: join(dirs.commonDir, 'worktrees'), recursive: false },
    ]
    if (dirKey(dirs.gitDir) !== dirKey(dirs.commonDir)) {
      list.push({ dir: dirs.gitDir, recursive: false }, { dir: join(dirs.gitDir, 'reftable'), recursive: false })
    }
    return list
  }

  // One checkout at a time: the point is to stay out of the way. A path that
  // is not a checkout has nothing to read and is marked as before, so a view
  // still notices it becoming one.
  const runFallback = async (): Promise<void> => {
    if (!focused || fallbackRunning) return
    fallbackRunning = true
    try {
      for (const record of [...checkouts.values()]) {
        if (checkouts.get(record.key) !== record) continue
        if (!record.dirs) {
          mark([record.key], ['worktree', 'refs'], 'fallback')
          continue
        }
        const reading = await readCheckout(record.dirs.toplevel).catch(() => null)
        if (checkouts.get(record.key) !== record) continue
        const moved = reading === null || reading !== record.reading
        record.reading = reading
        if (moved) mark([record.key], ['worktree', 'refs'], 'fallback')
      }
    } finally {
      fallbackRunning = false
    }
  }

  const ensureFallback = (): void => {
    if (checkouts.size > 0 && fallbackTimer === null) {
      fallbackTimer = setRepeating(() => void runFallback(), fallbackMs)
    } else if (checkouts.size === 0 && fallbackTimer !== null) {
      clearRepeating(fallbackTimer)
      fallbackTimer = null
    }
  }

  return {
    /**
     * Start (or join) watching a checkout. Resolves once its git dirs are
     * known and watched; a path that is not a checkout is retained but watches
     * nothing, and still hears the fallback and `noteActivity`.
     */
    async retain(checkoutPath: string): Promise<string> {
      const key = checkoutKey(checkoutPath)
      const existing = checkouts.get(key)
      if (existing) {
        existing.refCount += 1
        await existing.resolving
        return key
      }
      const record: CheckoutRecord = { key, refCount: 1, dirs: null, resolving: null }
      checkouts.set(key, record)
      ensureFallback()
      record.resolving = resolveDirs(checkoutPath)
        .catch(() => null)
        .then((dirs) => {
          record.resolving = null
          if (checkouts.get(key) !== record) return
          record.dirs = dirs
          if (dirs) for (const { dir, recursive } of dirsToWatch(dirs)) retainDir(dir, recursive)
        })
      await record.resolving
      return key
    },

    release(checkoutPath: string): void {
      const key = checkoutKey(checkoutPath)
      const record = checkouts.get(key)
      if (!record) return
      record.refCount -= 1
      if (record.refCount > 0) return
      checkouts.delete(key)
      pending.delete(key)
      if (record.dirs) for (const { dir } of dirsToWatch(record.dirs)) releaseDir(dir)
      ensureFallback()
    },

    /**
     * Something outside git's own files says a checkout's working tree moved —
     * an agent's turn ended in it. Matched by the retained key or by git's own
     * toplevel spelling of it (a symlinked path).
     */
    noteActivity(path: string): void {
      const key = checkoutKey(path)
      const keys = [...checkouts.values()]
        .filter((record) => record.key === key || (record.dirs && checkoutKey(record.dirs.toplevel) === key))
        .map((record) => record.key)
      mark(keys, ['worktree'], 'activity')
    },

    /** Mark checkouts stale by hand (after the app's own write, say). */
    invalidate(path: string, kinds: GitCheckoutChangeKind[] = ['worktree', 'refs']): void {
      mark([checkoutKey(path)], kinds, 'activity')
    },

    setFocused(next: boolean): void {
      if (focused === next) return
      focused = next
      if (focused && pending.size > 0 && flushTimer === null) flushTimer = setTimer(flush, 0)
      if (!focused && flushTimer !== null) {
        clearTimer(flushTimer)
        flushTimer = null
      }
    },

    isRetained(path: string): boolean {
      return checkouts.has(checkoutKey(path))
    },

    watchedDirCount(): number {
      let count = 0
      for (const entry of dirWatches.values()) if (entry.watcher) count += 1
      return count
    },

    dispose(): void {
      for (const entry of dirWatches.values()) closeQuietly(entry.watcher)
      dirWatches.clear()
      checkouts.clear()
      pending.clear()
      if (flushTimer !== null) clearTimer(flushTimer)
      flushTimer = null
      if (fallbackTimer !== null) clearRepeating(fallbackTimer)
      fallbackTimer = null
    },
  }
}

export type GitRepoWatch = ReturnType<typeof createGitRepoWatch>
