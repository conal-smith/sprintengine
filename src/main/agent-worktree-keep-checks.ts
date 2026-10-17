import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { comparablePath } from '../shared/host-paths'
import { SKILL_HARNESS_DIR } from '../shared/skill-harnesses'
import { SIDECAR_DIR_NAME } from '../shared/workspace-sidecar'
import { conversationStorageSegment } from './conversation-index'
import type { GitCommandResult } from './git'
import { toFilesystemPath } from './git-utils'
import { SKILL_PROVENANCE_FILE } from './skills/install'
import { PER_AGENT_IGNORED_FILES } from './worktree-pool/slot-git'

/**
 * The on-disk checks the agent worktree cleanup (agent-worktree-cleanup.ts)
 * runs before it lets `git worktree remove` take a worktree: the ones `git
 * status` cannot answer, because what they look for is invisible to it.
 */

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

// --- Path identity -----------------------------------------------------------

/**
 * macOS and Windows filesystems are case-insensitive by default. Folding there
 * can only make two spellings of one folder match; on a case-sensitive volume
 * it can make two different folders match too, which keeps a worktree that
 * could have gone. Keeping is the side to err on.
 */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

function comparable(path: string): string {
  const value = comparablePath(path)
  return FOLD_CASE ? value.toLowerCase() : value
}

/**
 * The spellings one path can be compared under: as given, and with every
 * symlink resolved. Git records a worktree's path resolved (`/private/tmp/…`
 * for `/tmp/…`, `/Volumes/…` for a `~/code` link to it), while the app's
 * records keep whatever path the person opened. A path that does not exist
 * (a folder removed since) resolves through its nearest existing parent.
 */
export async function pathSpellings(path: string): Promise<string[]> {
  const spellings = new Set([comparable(path)])
  let current = toFilesystemPath(path)
  const rest: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(current)
      spellings.add(comparable(rest.length > 0 ? join(real, ...rest) : real))
      break
    } catch {
      const parent = dirname(current)
      if (parent === current) break
      rest.unshift(basename(current))
      current = parent
    }
  }
  return [...spellings]
}

/**
 * `child` is `parent` or inside it, as spelled: for two paths that come from
 * the same source (both git's), where resolving symlinks would buy nothing.
 */
export function pathInside(child: string, parent: string): boolean {
  return insideAny([comparable(child)], [comparable(parent)])
}

/** True when any spelling of `child` is `parent` or inside it. */
export function insideAny(childSpellings: readonly string[], parentSpellings: readonly string[]): boolean {
  return childSpellings.some((child) =>
    parentSpellings.some(
      (parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`),
    ),
  )
}

// --- Age ---------------------------------------------------------------------

/**
 * When git last wrote to the worktree's admin directory
 * (`<common>/worktrees/<name>`): its creation, and every index write, HEAD move
 * or commit made in it since. Null when it cannot be read.
 *
 * The cleanup keeps a worktree younger than an hour whatever else it finds. A
 * freshly created agent worktree is clean and has no commits of its own, so on
 * every other rule it qualifies at once; this is the window in which its owner
 * may not have been recorded anywhere yet (another profile, an MCP launch the
 * window has not heard of, a worktree created while a sweep was listing).
 */
export async function adminDirWrittenAt(worktreePath: string, runGit: RunGit): Promise<number | null> {
  const gitDir = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir'])
  const dir = gitDir.ok ? gitDir.stdout.trim() : ''
  if (!dir) return null
  try {
    // mtime, not birthtime: a directory's mtime moves every time an entry in
    // it is created or renamed (`index.lock` → `index` on each index write),
    // so it is the newest of "created" and "last used by git", and it is
    // reported the same way on every platform.
    return (await stat(toFilesystemPath(dir))).mtimeMs
  } catch {
    return null
  }
}

/**
 * When the worktree was last used: the newer of its index and its HEAD, each
 * as git last rewrote it. Null when neither can be read.
 *
 * Not the admin directory's own time ({@link adminDirWrittenAt}), and not the
 * reflog's: `git gc` runs `reflog expire --all` from any checkout of the
 * repository, which rewrites every worktree's `logs/HEAD` (and so its admin
 * directory) with nothing in it changed, so after a gc every worktree reads as
 * used a moment ago. The index moves with every stage, commit, checkout and
 * stat refresh made in the worktree, and HEAD with every switch, and gc
 * touches neither. The app's own reads take no optional locks (git-run.ts), so
 * looking at a worktree never counts as using it.
 */
export async function worktreeLastUsedAt(worktreePath: string, runGit: RunGit): Promise<number | null> {
  const gitDir = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir'])
  const dir = gitDir.ok ? gitDir.stdout.trim() : ''
  if (!dir) return null
  const times = await Promise.all(
    ['index', 'HEAD'].map((name) =>
      stat(toFilesystemPath(join(dir, name))).then(
        (stats) => stats.mtimeMs,
        () => null,
      ),
    ),
  )
  const known = times.filter((time): time is number => time !== null)
  return known.length > 0 ? Math.max(...known) : null
}

// --- Hidden edits ------------------------------------------------------------

/**
 * Tracked files whose edits `git status` does not show, and `git worktree
 * remove` (without `--force`) therefore does not see either: a lowercase tag
 * in `git ls-files -v` is `--assume-unchanged`, `S` is `--skip-worktree`.
 *
 * A skip-worktree entry with no file on disk is a sparse checkout leaving that
 * path out, which hides nothing, and is not counted.
 */
export async function hiddenEditPaths(
  worktreePath: string,
  runGit: RunGit,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const listed = await runGit(worktreePath, ['ls-files', '-v', '-z'])
  if (!listed.ok) return { ok: false, message: listed.message ?? 'git ls-files failed' }
  const paths: string[] = []
  for (const record of listed.stdout.split('\0')) {
    if (record.length < 3) continue
    const tag = record[0]
    const path = record.slice(2)
    if (/[a-z]/.test(tag)) {
      paths.push(path)
    } else if (tag === 'S') {
      const onDisk = await lstat(toFilesystemPath(join(worktreePath, path))).then(
        () => true,
        () => false,
      )
      if (onDisk) paths.push(path)
    }
  }
  return { ok: true, paths }
}

// --- Ignored files -----------------------------------------------------------

/**
 * Ignored folders that only ever hold what a command rebuilds: installed
 * dependencies, build and test output, tool caches. A folder with one of these
 * names that git ignores as a whole (at any depth, so a monorepo package's
 * `dist/` counts too) goes with the worktree; anything else ignored keeps it.
 */
const REBUILDABLE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.cache',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.hypothesis',
  '.nyc_output',
  '.angular',
  '.dart_tool',
])

/** Ignored files that are never anyone's work. */
const DISPOSABLE_FILES = new Set(['.DS_Store', 'Thumbs.db', '.eslintcache', '.stylelintcache'])

/**
 * Ignored file endings a tool writes and rewrites: build info, bytecode, logs,
 * and the tarball `npm pack` leaves behind.
 */
const DISPOSABLE_ENDINGS = ['.tsbuildinfo', '.pyc', '.pyo', '.log', '.tgz']

function isRebuildable(path: string): boolean {
  const directory = path.endsWith('/')
  const segments = path.split('/').filter(Boolean)
  const last = segments.at(-1) ?? ''
  if (!directory) return DISPOSABLE_FILES.has(last) || DISPOSABLE_ENDINGS.some((ending) => last.endsWith(ending))
  // `--ignored=matching` names a folder only when the folder itself is
  // ignored as a whole (`packages/a/dist/`). A file is named on its own when
  // its folder is NOT ignored, so a file under `build/` proves that `build/` is
  // a source folder (a tracked `build/entitlements.plist` beside an ignored
  // `build/dev.p12`), and the folder's name says nothing about the file.
  return REBUILDABLE_DIRS.has(last)
}

// --- What the app and the agent CLIs write ----------------------------------

/**
 * Where an older build kept a chat's transcripts, in the folder the chat
 * worked in. A chat's history now lives in its project's store in the
 * person's home (workspace-store.ts), which outlives every worktree; a
 * worktree only holds one until the store's one-time move has taken it.
 */
const CONVERSATIONS_DIR = 'conversations'

/** Whether a path `ignoredPathsAtRisk` returned is a chat's history rather than a file. */
export function isChatTranscriptPath(path: string): boolean {
  return path.startsWith(`${SIDECAR_DIR_NAME}/${CONVERSATIONS_DIR}/`)
}

/**
 * The ids of the chats a registry holds that are not settled, or null when it
 * holds none at all: an empty registry is as likely one that could not be read
 * as a machine with no chats, and read as "no chat owns these" it would delete
 * every history it found. A registry whose every chat is settled answers an
 * empty list, which it can only be once read.
 *
 * Settled chats are left out (owner ruling 2026-10-08: "settled chats are
 * effectively deleted"): the history one left in a worktree no longer keeps
 * that worktree, so a settled chat's folder is released like a deleted one's.
 */
export function chatIdsOnRecord(workspaces: ReadonlyArray<{ id: string; settledAt?: number | null }>): string[] | null {
  if (workspaces.length === 0) return null
  return workspaces.filter((workspace) => typeof workspace.settledAt !== 'number').map((workspace) => workspace.id)
}

export type IgnoredFilesOptions = {
  /**
   * The ids of every chat on record that is not settled; null when they
   * cannot be read. A transcript folder no chat on record owns is a leftover
   * and goes; without the list, every transcript keeps the worktree.
   */
  knownWorkspaceIds?: (() => Iterable<string> | null) | null
}

/**
 * The transcript folders an older build left in a worktree's sidecar
 * (`.sprintengine/conversations/<chat>/`) that belong to a chat still on
 * record. A settled chat's worktree is given back (to the pool, or removed by
 * the cleanup) while the chat stays, to be checked out again when it is
 * reopened (`chatWorktreeRestore.ts`); until the store's one-time move has
 * taken such a folder, removing the worktree would take the chat's history
 * with it. Once moved there is nothing here, and the history no longer keeps
 * the worktree.
 */
async function transcriptsOnRecord(worktreeRoot: string, options: IgnoredFilesOptions): Promise<string[]> {
  const directory = join(toFilesystemPath(worktreeRoot), SIDECAR_DIR_NAME, CONVERSATIONS_DIR)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return [`${SIDECAR_DIR_NAME}/${CONVERSATIONS_DIR}/`]
  }
  let known: Set<string> | null = null
  try {
    const ids = options.knownWorkspaceIds?.() ?? null
    known = ids ? new Set([...ids].map(conversationStorageSegment)) : null
  } catch {
    known = null
  }
  const kept: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || (known && !known.has(entry.name))) continue
    const files = await readdir(join(directory, entry.name)).catch(() => null)
    if (files === null || files.some((name) => name.endsWith('.jsonl'))) {
      kept.push(`${SIDECAR_DIR_NAME}/${CONVERSATIONS_DIR}/${entry.name}/`)
    }
  }
  return kept
}

/** The folders the app installs skills into, one per agent CLI (`.claude`, `.codex`, `.agents`, …). */
const HARNESS_DIRS = new Set(Object.values(SKILL_HARNESS_DIR))

/**
 * What OpenCode writes into its own `.opencode/` when it starts in a folder:
 * the package it installs its plugin API from, and a `.gitignore` for that.
 */
const OPENCODE_INSTALL = new Set(['node_modules', 'package.json', 'package-lock.json', 'bun.lock', '.gitignore'])

const MAX_WALKED_ENTRIES = 5_000

/**
 * Whether an ignored path is only what the app itself, or an agent CLI it
 * launched, wrote into the worktree:
 *
 * - the sidecar folder an older build wrote (`.sprintengine/`): tool output,
 *   captures and caches written for the chats that ran here, which the store's
 *   one-time move empties. Its transcripts are the one exception, checked on
 *   their own ({@link transcriptsOnRecord}).
 * - the per-agent files every launch writes (`.mcp.json`, the CLIs' local
 *   approvals), which the pool deletes on every return anyway.
 * - the skills the app installs into each CLI's folder (`.claude/skills/<id>`
 *   with its `.sprintengine-skill.json` beside `SKILL.md`), and what OpenCode
 *   installs into `.opencode/`.
 *
 * A harness folder is walked: a skill folder without the app's manifest, or
 * any other file in there, may be a person's own and keeps the worktree.
 */
async function isAppWritten(worktreeRoot: string, path: string): Promise<boolean> {
  const segments = path.split('/').filter(Boolean)
  const [top] = segments
  if (!top) return false
  if (top === SIDECAR_DIR_NAME) return true
  const bare = segments.join('/')
  if ((PER_AGENT_IGNORED_FILES as readonly string[]).includes(bare)) return true
  if (!HARNESS_DIRS.has(top)) return false
  const root = toFilesystemPath(worktreeRoot)
  let budget = MAX_WALKED_ENTRIES
  const walk = async (rel: string[]): Promise<boolean> => {
    budget -= 1
    if (budget < 0) return false
    const name = rel.at(-1) ?? ''
    if (rel.length === 2 && rel[0] === '.opencode' && OPENCODE_INSTALL.has(name)) return true
    if ((PER_AGENT_IGNORED_FILES as readonly string[]).includes(rel.join('/'))) return true
    if (DISPOSABLE_FILES.has(name)) return true
    const full = join(root, ...rel)
    let info
    try {
      info = await lstat(full)
    } catch {
      return false
    }
    // `<harness>/skills/<id>`: the app's copy when its manifest sits in it,
    // or a link (removing the worktree takes the link, never what it names).
    if (rel.length === 3 && rel[1] === 'skills') {
      if (info.isSymbolicLink()) return true
      return (
        info.isDirectory() &&
        (await lstat(join(full, SKILL_PROVENANCE_FILE)).then(
          (manifest) => manifest.isFile(),
          () => false,
        ))
      )
    }
    if (!info.isDirectory() || rel.length > 2) return false
    for (const child of await readdir(full)) {
      if (!(await walk([...rel, child]))) return false
    }
    return true
  }
  return walk(segments).catch(() => false)
}

/**
 * A dependency folder linked in rather than installed (`node_modules` ->
 * the main checkout's). Git lists a link as a file, without the trailing
 * slash; removing the worktree removes the link, never what it points at.
 */
async function isLinkedDependencyFolder(worktreeRoot: string, path: string): Promise<boolean> {
  if (path.endsWith('/')) return false
  const segments = path.split('/').filter(Boolean)
  if (!REBUILDABLE_DIRS.has(segments.at(-1) ?? '')) return false
  return lstat(join(toFilesystemPath(worktreeRoot), ...segments)).then(
    (info) => info.isSymbolicLink(),
    () => false,
  )
}

/** The repository's `.worktreeinclude` entries, the way worktree creation reads them. */
async function readIncludeEntries(repoRoot: string): Promise<string[]> {
  let text = ''
  try {
    text = await readFile(join(toFilesystemPath(repoRoot), '.worktreeinclude'), 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => !isAbsolute(line) && !line.split(/[\\/]/).includes('..') && !/[*?[\]{}]/.test(line))
    .map((line) =>
      line
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/\/+$/, ''),
    )
    .filter(Boolean)
}

function overlaps(path: string, entry: string): boolean {
  const a = path.replace(/\/+$/, '')
  return a === entry || a.startsWith(`${entry}/`) || entry.startsWith(`${a}/`)
}

const MAX_COMPARED_ENTRIES = 20_000
const MAX_COMPARED_BYTES = 256 * 1024 * 1024

/**
 * Whether everything at `rel` in the worktree is byte-for-byte what the
 * source checkout has at the same path. Only the worktree side is walked:
 * something the source has and the worktree lacks loses nothing. Everything
 * inside is compared, whatever its folder is called. Past the budget the
 * answer is "not the same", which keeps the worktree.
 */
async function sameAsSource(
  sourceRoot: string,
  worktreeRoot: string,
  rel: string,
  budget: { entries: number; bytes: number },
): Promise<boolean> {
  const walk = async (source: string, target: string): Promise<boolean> => {
    budget.entries -= 1
    if (budget.entries < 0) return false
    let info
    let sourceInfo
    try {
      info = await lstat(target)
      sourceInfo = await lstat(source)
    } catch {
      return false
    }
    if (info.isSymbolicLink()) {
      if (!sourceInfo.isSymbolicLink()) return false
      return (await readlink(target)) === (await readlink(source))
    }
    if (info.isDirectory()) {
      if (!sourceInfo.isDirectory()) return false
      for (const name of await readdir(target)) {
        // Only `.DS_Store`-style litter is skipped. A folder named `build` or
        // `node_modules` inside a copied folder is part of the copy, and an
        // edit in it is as much an edit as any other.
        if (DISPOSABLE_FILES.has(name)) continue
        if (!(await walk(join(source, name), join(target, name)))) return false
      }
      return true
    }
    if (!info.isFile() || !sourceInfo.isFile() || info.size !== sourceInfo.size) return false
    budget.bytes -= info.size
    if (budget.bytes < 0) return false
    return sameBytes(source, target, info.size)
  }
  const segments = rel.split('/').filter(Boolean)
  return walk(join(toFilesystemPath(sourceRoot), ...segments), join(toFilesystemPath(worktreeRoot), ...segments))
}

async function sameBytes(a: string, b: string, size: number): Promise<boolean> {
  const chunk = 1024 * 1024
  const [left, right] = await Promise.all([open(a, 'r'), open(b, 'r')])
  try {
    const bufferA = Buffer.alloc(Math.min(chunk, Math.max(size, 1)))
    const bufferB = Buffer.alloc(bufferA.length)
    for (let offset = 0; offset < size; offset += bufferA.length) {
      const [readA, readB] = await Promise.all([
        left.read(bufferA, 0, bufferA.length, offset),
        right.read(bufferB, 0, bufferB.length, offset),
      ])
      if (readA.bytesRead !== readB.bytesRead) return false
      if (!bufferA.subarray(0, readA.bytesRead).equals(bufferB.subarray(0, readB.bytesRead))) return false
      if (readA.bytesRead === 0) break
    }
    return true
  } finally {
    await Promise.all([left.close(), right.close()])
  }
}

/**
 * Ignored files `git worktree remove` would delete that may be someone's work.
 *
 * `git status --ignored=matching` names each ignored thing once: a folder that
 * is ignored as a whole (`node_modules/`), else the file. One is disposable
 * when it is rebuildable output (`REBUILDABLE_DIRS`, `DISPOSABLE_FILES`, or a
 * dependency folder linked in), when the app or an agent CLI it launched wrote
 * it ({@link isAppWritten}) and it is not the history of a chat that is not settled
 * ({@link transcriptsOnRecord}, returned as its folder), or when `.worktreeinclude` copied it in at
 * creation and it is still exactly the source checkout's copy. Everything else
 * — an edited `.env`, notes in an ignored folder, a `todo.local` — is
 * returned, and keeps the worktree.
 */
export async function ignoredPathsAtRisk(
  repoRoot: string,
  worktreePath: string,
  runGit: RunGit,
  options: IgnoredFilesOptions = {},
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  // `--untracked-files=normal` explicitly: a `status.showUntrackedFiles=no` in
  // the person's config makes git refuse `--ignored=matching` outright.
  const status = await runGit(worktreePath, [
    'status',
    '--ignored=matching',
    '--untracked-files=normal',
    '--porcelain=v1',
    '-z',
  ])
  if (!status.ok) return { ok: false, message: status.message ?? 'git status --ignored failed' }
  const ignored = status.stdout
    .split('\0')
    .filter((record) => record.startsWith('!! '))
    .map((record) => record.slice(3))
    .filter((path) => path && !isRebuildable(path))
  if (ignored.length === 0) return { ok: true, paths: [] }

  const includes = await readIncludeEntries(repoRoot)
  const budget = { entries: MAX_COMPARED_ENTRIES, bytes: MAX_COMPARED_BYTES }
  const atRisk: string[] = []
  // A chat's history in the sidecar is looked for once, whichever way git
  // names the ignored sidecar (whole, or file by file).
  if (ignored.some((path) => path.split('/')[0] === SIDECAR_DIR_NAME)) {
    atRisk.push(...(await transcriptsOnRecord(worktreePath, options)))
  }
  for (const path of ignored) {
    if (await isLinkedDependencyFolder(worktreePath, path)) continue
    if (await isAppWritten(worktreePath, path)) continue
    const copied = includes.some((entry) => overlaps(path, entry))
    if (copied && (await sameAsSource(repoRoot, worktreePath, path, budget).catch(() => false))) continue
    atRisk.push(path)
  }
  return { ok: true, paths: atRisk }
}
