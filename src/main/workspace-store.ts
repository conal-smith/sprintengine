import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { distroOfUncPath, toWslPath, wslToWindowsPath } from '../shared/host-paths'
import { isMachinePath } from '../shared/machine-paths'
import { slugify } from '../shared/paths'
import { projectlessChatsRootOf } from '../shared/projectless-chats'
import { SIDECAR_DIR_NAME } from '../shared/workspace-sidecar'
import { repoRootFromWorktreePath } from '../shared/worktree-paths'

// Where Studio keeps what it knows about a project: the chats' transcripts and
// tool output, the backlog's config and link cache, the browser pane's
// captures, downloads and recordings, and module storage. All of it lives in
// the person's home, `~/.sprintengine/workspaces/<slug>-<hash>/`, and none of
// it in the project's folder (owner ruling 2026-10-16): a folder Studio wrote
// into was one the person had to teach git to ignore, and a clone without that
// rule showed the app's state as changes. Older builds kept it in
// `<project>/.sprintengine/`; workspace-store-migration.ts moves it out once.
//
// One store per PROJECT, not per checkout: a chat in a pool or agent worktree
// keeps its history in the project's store, so removing the worktree no
// longer takes the history with it, and every checkout of a project reads one
// backlog config. Chat ids are unique on their own, so transcripts from
// different checkouts share one `conversations/` folder without colliding.
//
// Synchronous on purpose: a browser download's save path has to be answered
// inside Electron's `will-download` handler, and a transcript's path is asked
// for on every append. Finding a worktree's project reads two small files and
// never runs git.

/** The store's path below the home folder, segment by segment. */
export const WORKSPACE_STORES_SEGMENTS = ['.sprintengine', 'workspaces'] as const

/** What a store says about itself, so a person browsing the folder can tell which project it is. */
export const WORKSPACE_STORE_MANIFEST = 'workspace.json'

/**
 * The home folder the stores (and the project-less chats' folders) are kept
 * under. `SPRINTENGINE_STORE_HOME` moves it: the test setup points it at a
 * temporary folder, so no suite writes into the home of whoever runs it.
 */
export function studioStoreHome(): string {
  return process.env.SPRINTENGINE_STORE_HOME?.trim() || homedir()
}

/** `<home>/.sprintengine/workspaces`. */
export function workspaceStoresRoot(home: string = studioStoreHome()): string {
  return join(home, ...WORKSPACE_STORES_SEGMENTS)
}

/** Forward slashes, so a key reads the same whichever separator spelled the path. */
function forward(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The path as the file system spells it, where it exists; resolved lexically where it does not. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The checkout a worktree was cut from, found the way git itself finds it:
 * a worktree's `.git` is a file naming its git directory, whose `commondir`
 * names the repository's own `.git`, which sits in the main checkout. A
 * submodule's `.git` file names a git directory with no `commondir`, and is a
 * project of its own. A bare repository's worktrees have no main checkout, so
 * the repository directory itself stands for the project.
 *
 * A worktree whose folder is gone (removed by the pool, or by hand) still
 * answers, from the container layout every Studio worktree is made in
 * (`<parent>/.sprintengine-worktrees/<repo>/<slug>`), so its history is found
 * in the same store it was written to.
 */
export function projectRootOf(root: string): string {
  const gitPath = join(root, '.git')
  let info
  try {
    info = lstatSync(gitPath)
  } catch {
    return containerProjectOf(root) ?? root
  }
  if (!info.isFile()) return root
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitPath, 'utf8'))
    if (!pointer) return root
    const gitDir = resolve(root, pointer[1])
    let common: string
    try {
      common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
    } catch {
      return root
    }
    return basename(common) === '.git' ? dirname(common) : common
  } catch {
    return containerProjectOf(root) ?? root
  }
}

/** The project a path in a worktree container names, peeled through nested containers; null outside one. */
function containerProjectOf(root: string): string | null {
  let current: string | null = null
  for (let next = repoRootFromWorktreePath(root), depth = 0; next && depth < 8; depth += 1) {
    current = next
    next = repoRootFromWorktreePath(next)
  }
  return current
}

type Resolved = { project: string; store: string }

/**
 * A distribution's project, seen from Windows as `\\wsl.localhost\<distro>\…`.
 * Its store has to be the one the Studio server inside the distribution uses
 * for the same project, where its chats run: in the distribution's home, keyed
 * by the Linux path. The distribution is not asked (that is asynchronous, and
 * a synchronous read of the share holds main while it answers): the home is
 * the one the project sits under, `/home/<user>` or `/root`, which is where a
 * distribution's projects are. A project anywhere else keeps its store in this
 * computer's home; its chats, run inside the distribution, keep theirs there.
 */
function resolveWslShare(root: string, distro: string): Resolved {
  const linux = toWslPath(root)
  const project = containerProjectOf(linux) ?? linux
  const home = /^(\/home\/[^/]+|\/root)(?:\/|$)/u.exec(project)?.[1]
  const key = storeKey(project)
  if (!home) return { project: root, store: join(workspaceStoresRoot(), key) }
  return {
    project: wslToWindowsPath(project, { distro }),
    store: wslToWindowsPath(`${home}/${WORKSPACE_STORES_SEGMENTS.join('/')}/${key}`, { distro }),
  }
}

/** `<slug>-<hash16>`: readable in a file browser, and unique to the project's canonical path. */
function storeKey(canonicalProject: string): string {
  const spelled = forward(canonicalProject)
  const hash = createHash('sha256').update(spelled).digest('hex').slice(0, 16)
  const slug = slugify(spelled.split('/').filter(Boolean).at(-1)).slice(0, 40) || 'project'
  return `${slug}-${hash}`
}

const resolved = new Map<string, Resolved>()
const MAX_RESOLVED = 1024

function resolveStore(root: string): Resolved {
  // Keyed by the home too, so a test that moves it between cases is answered afresh.
  const cacheKey = `${studioStoreHome()}\0${root}`
  const known = resolved.get(cacheKey)
  if (known) return known
  if (!root.trim() || isMachinePath(root) || !isAbsolute(root)) {
    throw new Error(`A workspace store is kept for a folder on this computer, not for ${JSON.stringify(root)}.`)
  }
  const distro = process.platform === 'win32' ? distroOfUncPath(root) : null
  let answer: Resolved
  if (distro) {
    answer = resolveWslShare(root, distro)
  } else {
    // A chat started without a project runs in a folder of its own under the
    // "No project" root, which plays the project (projectless-chats.ts): they
    // share its one store rather than each making one.
    const project = canonical(projectlessChatsRootOf(root) ?? projectRootOf(resolve(root)))
    answer = { project, store: join(workspaceStoresRoot(), storeKey(project)) }
  }
  if (resolved.size >= MAX_RESOLVED) resolved.clear()
  resolved.set(cacheKey, answer)
  return answer
}

/** The project a workspace or worktree root keeps its store for: its main checkout, canonical. */
export function workspaceStoreProject(root: string): string {
  return resolveStore(root).project
}

/** `~/.sprintengine/workspaces/<slug>-<hash16>` for a project folder or any worktree of it. Pure: nothing is made. */
export function workspaceStoreRoot(root: string): string {
  return resolveStore(root).store
}

/** An absolute path inside a workspace's store. */
export function workspaceStorePath(root: string, ...segments: string[]): string {
  return join(workspaceStoreRoot(root), ...segments)
}

/** The store a path lies in, when it lies in one: `<stores>/<key>` for anything at or below it. */
export function storeRootContaining(path: string): string | null {
  const stores = workspaceStoresRoot()
  const rel = relative(stores, resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return join(stores, rel.split(sep)[0])
}

// --- Making a store, and its one-time move ---------------------------------

type StoreManifest = { schemaVersion: 1; projectRoot: string; aliases: string[] }

const ensured = new Set<string>()
const MAX_ALIASES = 64

/**
 * Records the folder a store was reached from beside the project it is kept
 * for. Written once per folder per run; a manifest that will not parse is
 * replaced, since nothing reads it but a person.
 */
function noteAlias(store: string, project: string, alias: string): void {
  const file = join(store, WORKSPACE_STORE_MANIFEST)
  let manifest: StoreManifest = { schemaVersion: 1, projectRoot: project, aliases: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreManifest>
    if (Array.isArray(parsed.aliases)) {
      manifest = { ...manifest, aliases: parsed.aliases.filter((entry) => typeof entry === 'string') }
    }
  } catch {
    // Missing or unreadable: written afresh below.
  }
  const aliases = new Set(manifest.aliases)
  if (alias !== project) aliases.add(alias)
  const next: StoreManifest = { ...manifest, aliases: [...aliases].slice(-MAX_ALIASES) }
  const text = `${JSON.stringify(next, null, 2)}\n`
  try {
    if (readFileSync(file, 'utf8') === text) return
  } catch {
    // Not there yet.
  }
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
}

type Migrator = (projectRoot: string) => Promise<unknown>

let migrator: Migrator | null = null
const migrations = new Map<string, Promise<void>>()

/**
 * Installs what moves an older build's in-project state into a store. Main
 * and the Studio server install it at startup; a test that does not is never
 * surprised by a move it did not ask for.
 */
export function setWorkspaceStoreMigrator(next: Migrator | null): void {
  migrator = next
}

/**
 * Runs the one-time move for a project, unless one is already running for
 * its store, which gathers every checkout's folder the same way. The promise
 * never rejects: a move that fails leaves its sources where they were, to be
 * tried again next run.
 */
export function migrateWorkspaceStoreInBackground(root: string): Promise<void> {
  const run = migrator
  if (!run) return Promise.resolve()
  let target: Resolved
  try {
    target = resolveStore(root)
  } catch {
    return Promise.resolve()
  }
  const running = migrations.get(target.store)
  if (running) return running
  // Entered before the move starts, so the move's own first look at the
  // store (which notes its checkouts there) finds it running, not a store
  // with an older build's folder still to move.
  let release!: () => void
  const settled = new Promise<void>((resolve) => (release = resolve))
  migrations.set(target.store, settled)
  void Promise.resolve()
    .then(() => run(target.project))
    .catch(() => undefined)
    .finally(() => {
      if (migrations.get(target.store) === settled) migrations.delete(target.store)
      release()
    })
  return settled
}

/**
 * Makes a workspace's store and returns its root. The first time a folder is
 * seen this run, the store's manifest notes it, and if the folder (or its
 * project) still has an older build's `.sprintengine/`, the move starts.
 */
export function ensureWorkspaceStore(root: string): string {
  const target = resolveStore(root)
  const seen = `${target.store}\0${root}`
  if (ensured.has(seen)) return target.store
  mkdirSync(target.store, { recursive: true })
  try {
    noteAlias(target.store, target.project, root)
  } catch {
    // The manifest is for a person reading the folder; the store works without it.
  }
  ensured.add(seen)
  if (migrator && (existsSync(join(root, SIDECAR_DIR_NAME)) || existsSync(join(target.project, SIDECAR_DIR_NAME)))) {
    void migrateWorkspaceStoreInBackground(root)
  }
  return target.store
}

/** Settles once no move into this store is running. */
export function workspaceStoreSettled(store: string): Promise<void> {
  return migrations.get(store) ?? Promise.resolve()
}

/**
 * The store, made, with any move into it finished: what a reader or writer
 * awaits before it touches a file there, so the first read after an upgrade
 * sees the history the move brings in rather than an empty folder, and the
 * first write never races the move for the same transcript.
 */
export async function workspaceStoreReady(root: string): Promise<string> {
  const store = storeRootContaining(root) ?? ensureWorkspaceStore(root)
  await workspaceStoreSettled(store)
  return store
}

/** Makes `<store>/<segments…>` and returns it. */
export async function ensureWorkspaceStoreDir(root: string, ...segments: string[]): Promise<string> {
  const dir = join(await workspaceStoreReady(root), ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * `ensureWorkspaceStoreDir` for a caller that has to answer before it
 * returns: Electron takes a download's save path only inside its
 * `will-download` handler. A new file never races the move, so it does not
 * wait for one.
 */
export function ensureWorkspaceStoreDirSync(root: string, ...segments: string[]): string {
  const dir = join(ensureWorkspaceStore(root), ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The root a conversation file is confined to. A chat's own files — its
 * transcript, tool output, receipts, the thread index — are in its
 * workspace's store; a path there is confined to the store (made, with any
 * move into it finished, first). Any other path is confined to the root as
 * given, which is how a caller that keeps its files in the folder itself, and
 * every test written before the store, still reads them.
 */
export async function conversationConfinementRoot(root: string, path: string): Promise<string> {
  const containing = storeRootContaining(path)
  if (!containing) return root
  if (storeRootContaining(root) === containing) return workspaceStoreReady(root)
  try {
    if (workspaceStoreRoot(root) !== containing) return root
  } catch {
    return root
  }
  return workspaceStoreReady(root)
}
