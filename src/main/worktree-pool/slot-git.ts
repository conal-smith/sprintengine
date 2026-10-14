import { lstat, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { GitCommandResult } from '../git'
import { runGitCommand, type GitRunOptions } from '../git-run'
import { branchNamespaceParents } from '../../shared/worktree-branch'

/**
 * The git a pool slot needs, and nothing a slot does not. Every call goes
 * through the shared runner (git-run.ts): reads carry a deadline and never take
 * `index.lock`, writes carry none and are never killed part-way, and nothing
 * can prompt.
 */

export type SlotGitRunner = (cwd: string, args: string[], options?: GitRunOptions) => Promise<GitCommandResult>

export const defaultSlotGitRunner: SlotGitRunner = (cwd, args, options) => runGitCommand(cwd, args, undefined, options)

export type SlotStatus = {
  /** The commit HEAD names; null for a repository with no commits yet. */
  oid: string | null
  /** The branch checked out, or null when HEAD is detached. */
  branch: string | null
  /** Changed, staged, unmerged and untracked paths. Ignored files never count. */
  changedPaths: number
  /** The tracked paths among them (changed, staged or unmerged). */
  trackedPaths: string[]
  /** How many of them are untracked. */
  untracked: number
  /** The untracked paths themselves. */
  untrackedPaths: string[]
}

// Fields before the path in each porcelain v2 record kind.
const PATH_FIELD: Record<string, number> = { '1': 8, '2': 9, u: 10 }

function pathOf(record: string, kind: string): string {
  let index = 0
  for (let field = 0; field < PATH_FIELD[kind]; field += 1) index = record.indexOf(' ', index) + 1
  return record.slice(index)
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. One process answers the three
 * questions every pool step asks — which commit, which branch, is it clean —
 * where separate `rev-parse`, `symbolic-ref` and `status` calls would be three.
 */
export function parseSlotStatus(stdout: string): SlotStatus {
  const records = stdout.split('\0')
  let oid: string | null = null
  let branch: string | null = null
  let changedPaths = 0
  let untracked = 0
  const trackedPaths: string[] = []
  const untrackedPaths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length).trim()
      oid = /^[0-9a-f]{40,64}$/iu.test(value) ? value : null
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('#')) continue
    const kind = record[0]
    if (kind === '?') {
      changedPaths += 1
      untracked += 1
      untrackedPaths.push(record.slice(2))
    } else if (kind === '1' || kind === 'u') {
      changedPaths += 1
      trackedPaths.push(pathOf(record, kind))
    } else if (kind === '2') {
      changedPaths += 1
      trackedPaths.push(pathOf(record, kind))
      // A rename or copy carries its original path as the next record.
      index += 1
      if (records[index]) trackedPaths.push(records[index])
    }
  }
  return { oid, branch, changedPaths, trackedPaths, untracked, untrackedPaths }
}

export async function readSlotStatus(
  run: SlotGitRunner,
  slotPath: string,
): Promise<{ ok: true; status: SlotStatus } | { ok: false; message: string }> {
  const result = await run(slotPath, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  if (!result.ok) return { ok: false, message: result.message ?? 'git status failed' }
  return { ok: true, status: parseSlotStatus(result.stdout) }
}

/** The slot's own gitdir (`<common>/worktrees/<name>`), where its HEAD, index and locks live. */
export async function readSlotGitDir(run: SlotGitRunner, slotPath: string): Promise<string | null> {
  const result = await run(slotPath, ['rev-parse', '--absolute-git-dir'])
  const value = result.ok ? result.stdout.trim() : ''
  return value || null
}

/**
 * A file the pool leaves in each slot's own gitdir (never in the tree, so no
 * status sees it). It is the evidence that a `pool-NN` worktree is the pool's:
 * a person or an agent can name a worktree `pool-01` too, and only a marked
 * one is ever adopted back into a pool whose record was lost.
 */
const SLOT_MARKER = 'sprintengine-pool-slot'

export async function writeSlotMarker(run: SlotGitRunner, slotPath: string): Promise<void> {
  const gitDir = await readSlotGitDir(run, slotPath)
  if (gitDir) await writeFile(join(gitDir, SLOT_MARKER), 'This worktree is a pool slot of SprintEngine Studio.\n')
}

export async function removeSlotMarker(run: SlotGitRunner, slotPath: string): Promise<void> {
  const gitDir = await readSlotGitDir(run, slotPath)
  if (gitDir) await rm(join(gitDir, SLOT_MARKER), { force: true })
}

export async function hasSlotMarker(run: SlotGitRunner, slotPath: string): Promise<boolean> {
  const gitDir = await readSlotGitDir(run, slotPath)
  if (!gitDir) return false
  return stat(join(gitDir, SLOT_MARKER)).then(
    () => true,
    () => false,
  )
}

const OPERATION_MARKERS: Array<[string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

/** The multi-step operation parked in a slot, if any. A slot mid-rebase is never recycled. */
export async function operationInProgress(gitDir: string): Promise<string | null> {
  for (const [marker, name] of OPERATION_MARKERS) {
    if (
      await stat(join(gitDir, marker)).then(
        () => true,
        () => false,
      )
    )
      return name
  }
  return null
}

/** Minutes after which an `index.lock` nobody is using is treated as debris. */
export const STALE_INDEX_LOCK_MS = 10 * 60_000

export type IndexLockVerdict = 'none' | 'removed' | 'busy'

/**
 * A slot's `index.lock` is left behind when git is killed mid-write. It blocks
 * every later write in that slot until someone deletes it. The pool deletes one
 * only when BOTH hold: it is older than {@link STALE_INDEX_LOCK_MS}, and the
 * caller has established that nothing of ours runs in the slot (no live
 * terminal, no operation of our own in flight). A younger one is `busy`: some
 * git is probably mid-write right now, and the step is retried later.
 */
export async function clearStaleIndexLock(
  gitDir: string,
  nothingRunsHere: boolean,
  now: number = Date.now(),
  /** The lock is known to be a dead run's own (crash recovery): its age does not matter. */
  ownedByDeadRun = false,
): Promise<IndexLockVerdict> {
  const lockPath = join(gitDir, 'index.lock')
  const info = await stat(lockPath).catch(() => null)
  if (!info) return 'none'
  if (!nothingRunsHere) return 'busy'
  if (!ownedByDeadRun && now - info.mtimeMs < STALE_INDEX_LOCK_MS) return 'busy'
  await rm(lockPath, { force: true })
  return 'removed'
}

/**
 * The branch the pool refreshes to: `origin/HEAD`'s target, else `origin/main`
 * or `origin/master`, else a local `main` or `master`. Null when none exists,
 * and then the pool cannot refresh anything.
 */
export async function resolvePoolBaseRef(run: SlotGitRunner, repoRoot: string): Promise<string | null> {
  const originHead = await run(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const named = originHead.ok ? originHead.stdout.trim().replace(/^refs\/remotes\//u, '') : ''
  const candidates = [...(named ? [named] : []), 'origin/main', 'origin/master', 'main', 'master']
  for (const candidate of candidates) {
    const verified = await run(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (verified.ok && verified.stdout.trim()) return candidate
  }
  return null
}

export async function revParseCommit(run: SlotGitRunner, cwd: string, ref: string): Promise<string | null> {
  const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const value = result.ok ? result.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/iu.test(value) ? value : null
}

// The repository's `checkout.workers`, by repository root: read once per run.
const checkoutWorkersByRepo = new Map<string, Promise<string>>()

/**
 * `-c checkout.workers=<n>` for a git that writes a whole working tree
 * (`worktree add`, `read-tree -u`). Unset, git checks a tree out one file at a
 * time; with it, git writes files on as many workers as the machine has cores
 * (0), and a large tree lands several times faster. A value the person set
 * themselves is kept. Read once per repository and remembered for the run, so
 * only the first checkout in a repository pays for the read; a read that
 * failed is not remembered. A git older than 2.32 ignores the key.
 */
export async function parallelCheckoutConfig(run: SlotGitRunner, repoRoot: string): Promise<string[]> {
  let workers = checkoutWorkersByRepo.get(repoRoot)
  if (!workers) {
    workers = run(repoRoot, ['config', '--get', 'checkout.workers']).then(
      (result) => {
        const value = result.stdout.trim()
        // Unset answers exit 1 with nothing on stderr; anything else is a failed read.
        if (!result.ok && result.stderr.trim()) checkoutWorkersByRepo.delete(repoRoot)
        return result.ok && /^-?\d+[kmg]?$/iu.test(value) ? value : '0'
      },
      () => {
        checkoutWorkersByRepo.delete(repoRoot)
        return '0'
      },
    )
    checkoutWorkersByRepo.set(repoRoot, workers)
  }
  return ['-c', `checkout.workers=${await workers}`]
}

/**
 * How long a lease waits for its fetch. The fetch sits on the launch path of a
 * new chat, so a slow or unreachable remote must not hold the chat up: past
 * this the lease goes ahead on what `origin/<default>` already says.
 */
export const LEASE_FETCH_TIMEOUT_MS = 10_000

/**
 * Bring `origin/<branch>` up to date, once. Only the one branch the pool bases
 * on is fetched, without tags: a base to fork from, not a pull. Nor does it
 * start git's automatic gc, which a fetch otherwise may: this one sits on the
 * launch path of a new chat, and a gc it set off would hold the repository
 * and slow the git calls that follow. `--no-auto-gc` is git 2.23, the
 * release that brought the `switch` every lease runs.
 */
export async function fetchBase(
  run: SlotGitRunner,
  repoRoot: string,
  baseRef: string,
  timeoutMs: number = LEASE_FETCH_TIMEOUT_MS,
): Promise<GitCommandResult> {
  const match = /^([^/]+)\/(.+)$/u.exec(baseRef)
  if (!match) return { ok: true, stdout: '', stderr: '', message: null }
  const [, remote, branch] = match
  return run(
    repoRoot,
    ['fetch', '--no-tags', '--no-auto-gc', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { timeoutMs },
  )
}

/** Whether `oid` is on some local branch or remote-tracking ref (so detaching from it loses nothing). */
export async function commitIsReachable(run: SlotGitRunner, cwd: string, oid: string): Promise<boolean> {
  const result = await run(cwd, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    `--contains=${oid}`,
    'refs/heads',
    'refs/remotes',
  ])
  // Unreadable is "not reachable": the caller then keeps the commit on a branch.
  return result.ok && result.stdout.trim().length > 0
}

/**
 * Files that belong to one agent's run and must not reach the next agent
 * leased the same slot: the app's managed MCP config, which every launch
 * writes into its worktree (a connector launch's carries that connector's
 * server, and its credentials), and a CLI's local permission approvals.
 * Removed on a clean return, and only while git does not track them. Because
 * the app writes them itself, they alone never make a return read as dirty
 * (see {@link isPerAgentFile}); excluding them in the repository's shared
 * exclude file instead would hide a person's own untracked `.mcp.json` in
 * their main checkout too.
 */
export const PER_AGENT_IGNORED_FILES = ['.mcp.json', '.codex/config.toml', '.claude/settings.local.json'] as const

export function isPerAgentFile(path: string): boolean {
  return (PER_AGENT_IGNORED_FILES as readonly string[]).includes(path)
}

export async function removePerAgentFiles(run: SlotGitRunner, slotPath: string): Promise<string[]> {
  const tracked = await run(slotPath, ['ls-files', '-z', '--', ...PER_AGENT_IGNORED_FILES.map((p) => `:(literal)${p}`)])
  if (!tracked.ok) return []
  const trackedSet = new Set(tracked.stdout.split('\0').filter(Boolean))
  const removed: string[] = []
  for (const relative of PER_AGENT_IGNORED_FILES) {
    if (trackedSet.has(relative)) continue
    const full = join(slotPath, ...relative.split('/'))
    const present = await stat(full).then(
      (info) => info.isFile(),
      () => false,
    )
    if (!present) continue
    await rm(full, { force: true })
    removed.push(relative)
  }
  return removed
}

/**
 * Ignored files sitting where the move from `fromSha` to `toSha` adds a
 * tracked file. `read-tree --reset -u` would overwrite them without a word, and
 * `status` never shows them, so they are looked for explicitly; the caller
 * holds the slot rather than lose them.
 */
export async function ignoredFilesInTheWay(
  run: SlotGitRunner,
  slotPath: string,
  fromSha: string,
  toSha: string,
): Promise<string[] | null> {
  const added = await run(slotPath, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', fromSha, toSha])
  if (!added.ok) return null
  const addedPaths = added.stdout.split('\0').filter(Boolean)
  // An ignored FILE where the new tree needs a directory (`cache` when the
  // base adds `cache/x`) is replaced just as silently, so every parent of an
  // added path that exists here as something other than a directory is
  // checked too.
  const parents = new Set<string>()
  for (const path of addedPaths) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) parents.add(parts.slice(0, depth).join('/'))
  }
  const blocking: string[] = []
  for (const parent of parents) {
    const info = await lstat(join(slotPath, ...parent.split('/'))).catch(() => null)
    if (info && !info.isDirectory()) blocking.push(parent)
  }
  const paths = [...addedPaths, ...blocking]
  const found: string[] = []
  for (let start = 0; start < paths.length; start += 200) {
    const chunk = paths.slice(start, start + 200).map((path) => `:(literal)${path}`)
    const ignored = await run(slotPath, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...chunk,
    ])
    if (!ignored.ok) return null
    found.push(...ignored.stdout.split('\0').filter(Boolean))
  }
  return found
}

/**
 * The ignored files and folders in a slot (a wholly ignored folder named once,
 * with a trailing `/`), under the ignore rules its tree has now.
 */
export async function ignoredPaths(run: SlotGitRunner, slotPath: string): Promise<string[] | null> {
  const result = await run(slotPath, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  return result.ok ? result.stdout.split('\0').filter(Boolean) : null
}

/** What `git clean -fd` would remove from a slot, without removing anything. */
export async function cleanWouldRemove(run: SlotGitRunner, slotPath: string): Promise<string[] | null> {
  const result = await run(slotPath, ['-c', 'core.quotePath=false', 'clean', '-fdn'])
  if (!result.ok) return null
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('Would remove '))
    .map((line) => line.slice('Would remove '.length))
}

/**
 * Whether `path` (a file, or a folder ending in `/`) is, holds or lies inside
 * one of `ignored` ({@link ignoredPaths}).
 */
export function amongIgnored(path: string, ignored: readonly string[]): boolean {
  return ignored.some(
    (entry) =>
      entry === path ||
      (entry.endsWith('/') && path.startsWith(entry)) ||
      (path.endsWith('/') && entry.startsWith(path)),
  )
}

/** Every path that differs between two commits. */
export async function pathsBetween(
  run: SlotGitRunner,
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<Set<string> | null> {
  const result = await run(cwd, ['diff', '--name-only', '-z', '--no-renames', fromSha, toSha])
  if (!result.ok) return null
  return new Set(result.stdout.split('\0').filter(Boolean))
}

export async function hasFile(slotPath: string, name: string): Promise<boolean> {
  return stat(join(slotPath, name)).then(
    () => true,
    () => false,
  )
}

/** Whether the tree at `slotPath` routes any file through LFS. */
export async function usesLfs(slotPath: string): Promise<boolean> {
  const text = await readFile(join(slotPath, '.gitattributes'), 'utf8').catch(() => '')
  return /filter=lfs\b/u.test(text)
}

/**
 * The ref a new agent worktree forks from when it does not come from a pool
 * slot: the same `origin/<default>` a lease would use, fetched once with the
 * lease's deadline. Null when the repository has no default branch at all.
 */
export async function resolveAgentForkBase(run: SlotGitRunner, repoRoot: string): Promise<string | null> {
  const ref = await resolvePoolBaseRef(run, repoRoot)
  if (!ref) return null
  if (ref.includes('/')) await fetchBase(run, repoRoot, ref)
  return ref
}

/**
 * Said when a branch stands where a worktree branch would go: `agent` in the
 * way of `agent/<name>`, or `jane` in the way of `jane/wip/<name>`. Git keeps
 * `agent/<name>` as a file under a folder `agent`, and a branch named `agent`
 * is a file by that name, so it refuses each one ("cannot lock ref …
 * 'refs/heads/agent' exists"). Studio says so before it tries rather than
 * naming the branch something else: the prefix is the person's choice, and a
 * branch under another one is not what they asked for.
 */
export function branchBlockedMessage(blocker: string): string {
  return `A branch named “${blocker}” in this repository blocks Studio’s ${blocker}/… branches. Rename it (git branch -m ${blocker} <new-name>), or choose another branch prefix in Settings ▸ Worktrees, to start chats in a worktree.`
}

/**
 * The existing branch that stops git making `branch`, one of its parents
 * (`branchNamespaceParents`), or null when none does. One `rev-parse` per
 * parent, the shortest first: a branch under the default prefix asks one.
 */
export async function branchBlockedBy(run: SlotGitRunner, repoRoot: string, branch: string): Promise<string | null> {
  for (const parent of branchNamespaceParents(branch)) {
    const found = await run(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${parent}`])
    if (found.ok && found.stdout.trim().length > 0) return parent
  }
  return null
}
