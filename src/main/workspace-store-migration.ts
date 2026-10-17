import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, type Stats } from 'node:fs'
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  utimes,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { SIDECAR_DIR_NAME } from '../shared/workspace-sidecar'
import { worktreeContainerPath } from '../shared/worktree-paths'
import { runGitCommand } from './git-run'
import { ensureWorkspaceStore, migrateWorkspaceStoreInBackground, setWorkspaceStoreMigrator } from './workspace-store'
import { distroOfUncPath } from '../shared/host-paths'
import { isMachinePath } from '../shared/machine-paths'

// The one-time move of an older build's per-project state out of the project
// (`<checkout>/.sprintengine/`) into the project's store in the person's home
// (workspace-store.ts), from the project's own checkout and from every
// worktree of it: the ones git has registered, and every folder in the
// project's worktree container, where the pool's slots and the agents'
// worktrees are.
//
// Safe to run again, and to run after a run that stopped part way: a file is
// copied to a temporary name in the store and renamed into place before its
// source goes, and a source the store already holds the same bytes of is
// dropped, so nothing is ever in two minds about which copy is real. A lock in
// the store keeps two Studio processes (the desktop and a server, two
// profiles) from moving the same project at once, and a journal there records
// what each run did.
//
// What the move does not touch stays where it is, and is said in the log:
// - a file git tracks: it is the project's, committed on purpose;
// - a link, anywhere: it is never followed, so nothing outside the folder is
//   read or removed through it;
// - a folder the move does not know (`hooks/`, `studio-plugin/`, a person's
//   own): other parts of the app own those, or a person put them there.
//
// When two copies of one file differ, the move keeps both where it cannot
// tell one from the other as obsolete. Per kind:
// - a chat's transcript (and its tool output and receipts), which two
//   checkouts can both hold when a chat moved between them: the larger stays
//   under its name (the newer when they are the same size), the other beside
//   it as `<name>.conflict-<hash>`. Not `….conflict-<hash>.jsonl`: the thread
//   index lists every `.jsonl` as an agent of the chat;
// - config (the backlog's, a module's): the project's own checkout wins over
//   a worktree's and over the store's copy, which is kept aside the same way
//   (a module lists every `<key>.json`, so not `<key>.conflict-<hash>.json`);
// - a cache (the backlog's links, the thread index): the store's copy stays,
//   since a cache is rebuilt from the world;
// - anything else (captures, recordings, the retired automations and review
//   folders): both kept, the source as `<stem>.conflict-<hash><ext>`.
//
// The two retired folders go under `legacy/` in the store: nothing reads them
// (shared/workspace-mode.ts retired both modes), but they were the person's,
// and deleting them is not this move's call.
//
// Afterwards the `.gitignore` files that are exactly `*` (the ones older
// builds wrote so their folders ignored themselves) go, every folder left
// empty goes, bottom up, and so does `.sprintengine` once it is empty.

type Policy = 'transcripts' | 'config' | 'cache' | 'keep-both'

type Area = { to: readonly string[]; policy: (relative: readonly string[]) => Policy }

/** The folders the move knows, by their name in `.sprintengine/`, and where each goes in the store. */
const AREAS: Record<string, Area> = {
  conversations: {
    to: ['conversations'],
    policy: (relative) => (relative.at(-1) === 'index.json' && relative.length === 2 ? 'cache' : 'transcripts'),
  },
  backlog: {
    to: ['backlog'],
    policy: (relative) =>
      relative[0] === 'cache'
        ? 'cache'
        : relative.length === 1 && (relative[0] === 'config.json' || relative[0] === 'items.json')
          ? 'config'
          : 'keep-both',
  },
  browser: { to: ['browser'], policy: () => 'keep-both' },
  modules: { to: ['modules'], policy: () => 'config' },
  automations: { to: ['legacy', 'automations'], policy: () => 'keep-both' },
  review: { to: ['legacy', 'review'], policy: () => 'keep-both' },
  // The knowledge-activity hook's per-session trace, which the knowledge graph
  // replays; the hook now writes it into the store (memory-activity.ts).
  'knowledge-trace': { to: ['knowledge-trace'], policy: () => 'keep-both' },
}

/**
 * Where a path an older build kept in `.sprintengine/` (`browser/x.png`, its
 * parts) is in the store, or null for a folder the move does not take. A
 * client that learned the old path from an older Studio still finds the file.
 */
export function storePathOfLegacy(parts: readonly string[]): string[] | null {
  const [first, ...rest] = parts
  const area = first !== undefined && Object.hasOwn(AREAS, first) ? AREAS[first] : undefined
  return area ? [...area.to, ...rest] : null
}

/** What an older build's self-ignoring folders held, and nothing else. */
const IGNORE_STUB = '*\n'

const LOCK_FILE = '.migrate.lock'
const JOURNAL_FILE = '.migrate.journal'
/** A lock older than this is a run that died without its `finally`. */
const STALE_LOCK_MS = 30 * 60 * 1000
/** The suffix a copy has in the store until it is complete and verified. */
const PARTIAL = '.migrating-'

export type WorkspaceStoreMigrationReport = {
  store: string
  /** The `.sprintengine` folders the move read from. */
  sources: string[]
  moved: number
  /** Sources dropped because the store already held them (or a newer config, or a cache). */
  dropped: number
  /** Files kept beside another copy under a `.conflict-` name. */
  conflicts: string[]
  /** Paths left in place: tracked, links, and folders the move does not know. */
  left: string[]
  /** Set when the move did not run: another process holds the store's lock. */
  skipped?: 'locked'
}

export type WorkspaceStoreMigrationDeps = {
  /**
   * The paths under `.sprintengine/` git tracks in a checkout, relative to
   * it and `/`-separated (`.sprintengine/backlog/config.json`); null when git
   * cannot say.
   */
  trackedFiles?: (checkout: string) => Promise<Set<string> | null>
  log?: (message: string) => void
  now?: () => number
  /** The rename the move tries first; a test makes it refuse, as a move across disks does. */
  rename?: (from: string, to: string) => Promise<void>
}

async function gitTrackedFiles(checkout: string): Promise<Set<string> | null> {
  const listed = await runGitCommand(checkout, ['ls-files', '-z', '--', SIDECAR_DIR_NAME])
  if (!listed.ok) return null
  return new Set(listed.stdout.split('\0').filter(Boolean))
}

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * The project's checkout first, then every worktree of it: those listed in
 * its git directory's `worktrees/` (each `gitdir` names the worktree's
 * `.git`), and every folder in its worktree container. Only ones with a real
 * `.sprintengine` folder count.
 */
async function checkoutsOf(project: string): Promise<string[]> {
  const found = [project]
  const worktrees = join(project, '.git', 'worktrees')
  for (const name of await readdir(worktrees).catch(() => [] as string[])) {
    const pointer = await readFile(join(worktrees, name, 'gitdir'), 'utf8').catch(() => null)
    if (pointer?.trim()) found.push(dirname(resolve(worktrees, name, pointer.trim())))
  }
  const container = worktreeContainerPath(project)
  for (const entry of await readdir(container, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) found.push(join(container, entry.name))
  }
  const unique: string[] = []
  for (const checkout of found) {
    if (unique.includes(checkout)) continue
    const sidecar = await lstatOrNull(join(checkout, SIDECAR_DIR_NAME)).catch(() => null)
    if (sidecar?.isDirectory()) unique.push(checkout)
  }
  return unique
}

type Lock = { release(): Promise<void> }

async function takeLock(store: string, now: () => number): Promise<Lock | null> {
  const path = join(store, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: now() }))
      await handle.close()
      return { release: () => unlink(path).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!(await lockIsStale(path, now))) return null
    await unlink(path).catch(() => undefined)
  }
  return null
}

/** A lock its process left: that process is gone from this machine, or it is older than any run takes. */
async function lockIsStale(path: string, now: () => number): Promise<boolean> {
  let holder: { pid?: unknown; host?: unknown; startedAt?: unknown }
  try {
    holder = JSON.parse(await readFile(path, 'utf8')) as typeof holder
  } catch {
    // Unreadable: a run that died between making the file and writing it, or a
    // run writing it this moment. Its age decides.
    const info = await lstatOrNull(path)
    return !info || now() - info.mtimeMs > STALE_LOCK_MS
  }
  if (typeof holder.startedAt === 'number' && now() - holder.startedAt > STALE_LOCK_MS) return true
  if (holder.host !== hostname() || typeof holder.pid !== 'number') return false
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

type Run = {
  store: string
  report: WorkspaceStoreMigrationReport
  journal: string[]
  deps: Required<Pick<WorkspaceStoreMigrationDeps, 'now' | 'rename'>> & Pick<WorkspaceStoreMigrationDeps, 'log'>
}

function note(run: Run, op: string, from: string, to?: string): void {
  run.journal.push(JSON.stringify({ at: run.deps.now(), op, from, ...(to ? { to } : {}) }))
}

function leave(run: Run, path: string, why: string): void {
  run.report.left.push(path)
  note(run, 'leave', path)
  run.deps.log?.(`${path}: left in place (${why})`)
}

async function sameBytes(a: Stats, aPath: string, b: Stats, bPath: string): Promise<boolean> {
  return a.size === b.size && (await sha256Of(aPath)) === (await sha256Of(bPath))
}

/**
 * Moves one file to a name in the store nothing holds yet: a rename where the
 * two are on one disk, else a copy to a temporary name, checked byte for byte,
 * renamed into place, and only then the source removed.
 */
async function moveFile(run: Run, from: string, info: Stats, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await run.deps.rename(from, to)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  const partial = `${to}${PARTIAL}${randomUUID().slice(0, 8)}`
  try {
    await copyFile(from, partial, constants.COPYFILE_EXCL)
    await utimes(partial, info.atime, info.mtime)
    const copied = await lstat(partial)
    if (!(await sameBytes(info, from, copied, partial))) throw new Error(`${from} did not copy whole.`)
    await rename(partial, to)
  } catch (error) {
    await unlink(partial).catch(() => undefined)
    throw error
  }
  await unlink(from)
}

/** `name.ext` → `name.conflict-<hash>.ext`, or `name.conflict-<hash>` appended where the extension is read (`.jsonl`). */
function conflictName(path: string, hash: string, keepExtension: boolean): string {
  const tag = `conflict-${hash.slice(0, 8)}`
  if (!keepExtension) return `${path}.${tag}`
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? `${path.slice(0, dot)}.${tag}${path.slice(dot)}` : `${path}.${tag}`
}

async function moveAside(run: Run, from: string, info: Stats, to: string, keepExtension: boolean): Promise<void> {
  const target = conflictName(to, await sha256Of(from), keepExtension)
  if (await lstatOrNull(target)) {
    await unlink(from)
    run.report.dropped += 1
    note(run, 'drop', from, target)
    return
  }
  await moveFile(run, from, info, target)
  run.report.conflicts.push(target)
  note(run, 'conflict', from, target)
}

async function placeFile(
  run: Run,
  from: string,
  info: Stats,
  to: string,
  policy: Policy,
  fromProject: boolean,
): Promise<void> {
  const existing = await lstatOrNull(to)
  if (!existing) {
    await moveFile(run, from, info, to)
    run.report.moved += 1
    note(run, 'move', from, to)
    return
  }
  if (!existing.isFile()) {
    leave(run, from, `${to} is not a file`)
    return
  }
  if ((await sameBytes(info, from, existing, to)) || policy === 'cache' || (policy === 'config' && !fromProject)) {
    await unlink(from)
    run.report.dropped += 1
    note(run, 'drop', from, to)
    return
  }
  if (policy === 'config') {
    // The project's own checkout wins: the store's copy goes aside, not away,
    // under a name nothing reads as a key.
    await moveAside(run, to, existing, to, false)
    await moveFile(run, from, info, to)
    run.report.moved += 1
    note(run, 'move', from, to)
    return
  }
  if (policy === 'transcripts') {
    const sourceWins = info.size > existing.size || (info.size === existing.size && info.mtimeMs > existing.mtimeMs)
    if (sourceWins) {
      await moveAside(run, to, existing, to, false)
      await moveFile(run, from, info, to)
      run.report.moved += 1
      note(run, 'move', from, to)
    } else {
      await moveAside(run, from, info, to, false)
    }
    return
  }
  await moveAside(run, from, info, to, true)
}

/** A folder holding nothing but an older build's `*` ignore file, which goes with it. */
async function removeIfEmpty(run: Run, dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null)
  if (!entries) return false
  if (entries.length === 1 && entries[0] === '.gitignore') {
    const stub = join(dir, '.gitignore')
    const info = await lstatOrNull(stub)
    if (!info?.isFile() || (await readFile(stub, 'utf8').catch(() => null)) !== IGNORE_STUB) return false
    await unlink(stub)
    note(run, 'drop', stub)
  } else if (entries.length > 0) {
    return false
  }
  await rmdir(dir).catch(() => undefined)
  return true
}

async function moveTree(
  run: Run,
  tracked: Set<string>,
  from: string,
  relative: readonly string[],
  area: Area,
  fromProject: boolean,
): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(from, entry.name)
    const rel = [...relative, entry.name]
    const info = await lstatOrNull(path)
    if (!info) continue
    if (info.isSymbolicLink()) {
      leave(run, path, 'a link')
      continue
    }
    if (info.isDirectory()) {
      await moveTree(run, tracked, path, rel, area, fromProject)
      continue
    }
    if (!info.isFile()) {
      leave(run, path, 'not a file')
      continue
    }
    if (tracked.has([SIDECAR_DIR_NAME, ...rel].join('/'))) {
      leave(run, path, 'git tracks it')
      continue
    }
    if (entry.name === '.gitignore') {
      // The stubs go with their folder below; a person's own ignore file stays.
      if ((await readFile(path, 'utf8').catch(() => null)) !== IGNORE_STUB) leave(run, path, 'an ignore file')
      continue
    }
    try {
      await placeFile(
        run,
        path,
        info,
        join(run.store, ...area.to, ...rel.slice(1)),
        area.policy(rel.slice(1)),
        fromProject,
      )
    } catch (error) {
      leave(run, path, `could not be moved: ${(error as Error).message}`)
    }
  }
  await removeIfEmpty(run, from)
}

async function moveCheckout(
  run: Run,
  checkout: string,
  fromProject: boolean,
  trackedFiles: (checkout: string) => Promise<Set<string> | null>,
): Promise<void> {
  const sidecar = join(checkout, SIDECAR_DIR_NAME)
  let tracked = await trackedFiles(checkout)
  if (!tracked) {
    // Git could not list what it tracks. In a repository that could be
    // anything, so nothing moves; a folder that is no repository tracks nothing.
    if (await lstatOrNull(join(checkout, '.git'))) {
      leave(run, sidecar, 'git could not say which of its files it tracks')
      return
    }
    tracked = new Set()
  }
  for (const entry of await readdir(sidecar, { withFileTypes: true }).catch(() => [])) {
    const path = join(sidecar, entry.name)
    const area = Object.hasOwn(AREAS, entry.name) ? AREAS[entry.name] : undefined
    if (entry.name === '.gitignore') continue
    if (!area || !entry.isDirectory()) {
      leave(run, path, area ? 'not a folder' : 'not something the store keeps')
      continue
    }
    await moveTree(run, tracked, path, [entry.name], area, fromProject)
  }
  if (await removeIfEmpty(run, sidecar)) note(run, 'remove', sidecar)
  else if ((await readdir(sidecar).catch(() => [])).length > 0)
    run.deps.log?.(`${sidecar}: kept, it still holds what the move left`)
}

/**
 * Moves a project's in-project state into its store. `project` is the main
 * checkout (`workspaceStoreProject`). Never throws for one file: what cannot
 * be moved is left and reported.
 */
export async function migrateWorkspaceStore(
  project: string,
  deps: WorkspaceStoreMigrationDeps = {},
): Promise<WorkspaceStoreMigrationReport> {
  const store = ensureWorkspaceStore(project)
  const report: WorkspaceStoreMigrationReport = { store, sources: [], moved: 0, dropped: 0, conflicts: [], left: [] }
  const checkouts = await checkoutsOf(project)
  if (checkouts.length === 0) return report
  const now = deps.now ?? Date.now
  const lock = await takeLock(store, now)
  if (!lock) return { ...report, skipped: 'locked' }
  const run: Run = { store, report, journal: [], deps: { now, rename: deps.rename ?? rename, log: deps.log } }
  try {
    await sweepPartials(store)
    for (const checkout of checkouts) {
      // Noted in the store's manifest, so a person reading it can tell which
      // folders it was reached from.
      if (checkout !== project) ensureWorkspaceStore(checkout)
      report.sources.push(join(checkout, SIDECAR_DIR_NAME))
      await moveCheckout(run, checkout, checkout === project, deps.trackedFiles ?? gitTrackedFiles)
    }
  } finally {
    if (run.journal.length > 0) {
      await appendFile(join(store, JOURNAL_FILE), `${run.journal.join('\n')}\n`, 'utf8').catch(() => undefined)
    }
    await lock.release()
  }
  if (report.moved + report.dropped + report.conflicts.length > 0) {
    deps.log?.(
      `${project}: moved ${report.moved} file(s) into ${store}, dropped ${report.dropped} duplicate(s)` +
        (report.conflicts.length ? `, kept ${report.conflicts.length} differing copy(ies) beside the originals` : ''),
    )
  }
  return report
}

/** Copies a run that stopped part way left in the store under a temporary name. */
async function sweepPartials(store: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.includes(PARTIAL)) await unlink(path).catch(() => undefined)
    }
  }
  await walk(store)
}

/**
 * Installs the move for this process: it runs the first time a folder with an
 * older build's `.sprintengine/` reaches a store (workspace-store.ts).
 */
export function installWorkspaceStoreMigration(deps: WorkspaceStoreMigrationDeps = {}): void {
  setWorkspaceStoreMigrator((project) => migrateWorkspaceStore(project, deps))
}

/**
 * `installWorkspaceStoreMigration`, and the move started on the next turn of
 * the loop, in the background, for every project in `folders()` (the
 * registry's). A folder on an SSH machine is that machine's server's to move,
 * and so, from Windows, is a folder inside a WSL distribution: the server
 * there moves it on its own disk rather than this process across the share.
 */
export function startWorkspaceStoreMigration(
  folders: () => readonly (string | null | undefined)[],
  deps: WorkspaceStoreMigrationDeps = {},
): void {
  installWorkspaceStoreMigration(deps)
  setImmediate(() => {
    for (const folder of new Set(folders())) {
      if (!folder?.trim() || isMachinePath(folder)) continue
      if (process.platform === 'win32' && distroOfUncPath(folder)) continue
      void migrateWorkspaceStoreInBackground(folder)
    }
  })
}
