/**
 * Resolve an observed cwd into the checkout that contains it.
 *
 * The cwd comes from an agent's lifecycle hooks — it says where the session
 * IS, not what kind of checkout that is. Git answers the second question, in
 * one `rev-parse` (it is asked at every agent turn end, so each extra process
 * start is paid many times a minute across a fleet):
 *
 *   - `--show-toplevel`                   → the work tree root (realpath-resolved)
 *   - `--git-common-dir` vs
 *     `--absolute-git-dir`                → a linked worktree has its own git
 *                                           dir apart from the common one
 *   - the common dir's parent             → the PRIMARY checkout the worktree
 *                                           belongs to (`<root>/.git` ⇒ root)
 *   - the git dir's HEAD file             → the branch (null when detached)
 *
 * A directory already answered is not asked again until its HEAD file changes.
 *
 * Three outcomes, kept distinct because a consumer renders them differently:
 *   1. a checkout (facts, `gitRoot` set) — primary or linked worktree;
 *   2. not a checkout (`gitRoot` null) — a plain folder, a removed worktree, a
 *      bare repo's directory, the inside of a `.git` dir;
 *   3. null — git could not answer at all (binary missing, a path this host
 *      cannot run git in such as a WSL path reported to a Windows main). The
 *      caller leaves the observation unresolved and falls back to launch
 *      intent rather than reading "folder" into a tooling failure.
 */
import { readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type { ObservedCheckout } from '../shared/observed-checkout'
import { pathExists, runGitCommand } from './git-utils'
import { branchNameFromHeadRef, HEAD_BRANCH_REF_ARGS } from './git-head-branch'
import { isWindowsPath, isWslDriveMountPath, wslToWindowsPath } from '../shared/host-paths'

export type ResolvedCheckoutFacts = Pick<
  ObservedCheckout,
  'gitRoot' | 'repoRoot' | 'branch' | 'isLinkedWorktree' | 'missing'
>

export type ObservedCheckoutResolver = (cwd: string) => Promise<ResolvedCheckoutFacts | null>

export const NOT_A_CHECKOUT: ResolvedCheckoutFacts = Object.freeze({
  gitRoot: null,
  repoRoot: null,
  branch: null,
  isLinkedWorktree: false,
})

/** The observed directory is gone (a pruned worktree): not a checkout, and not a folder either. */
export const MISSING_DIRECTORY: ResolvedCheckoutFacts = Object.freeze({ ...NOT_A_CHECKOUT, missing: true })

// Git's own vocabulary for "there is no repository / work tree here" — every
// other failure is git not answering, which must not be read as a plain folder.
const NOT_A_REPO_PATTERNS = [
  /not a git repository/i,
  /must be run in a work tree/i,
  /cannot be used without a working tree/i,
  /this operation must be run in a work tree/i,
  // A cwd that is a file, or vanished between the stat and the spawn: git
  // could not even enter it, which says "no checkout here", not "git broke".
  /cannot change to/i,
  /not a directory/i,
]

// The app process may inherit GIT_DIR / GIT_WORK_TREE from the shell that
// launched it (a dev workflow); with those set, git answers for THAT repo from
// any directory and every folder would resolve as a checkout. Clear them: the
// question here is always "what does this directory contain?".
const CLEAN_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
}

function saysNotARepo(stderr: string, message: string | null): boolean {
  const text = `${stderr}\n${message ?? ''}`
  return NOT_A_REPO_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * The common git dir from a `rev-parse … --git-common-dir` answer, absolute.
 * Older git (< 2.31) does not know `--path-format=absolute` — and rev-parse
 * ECHOES an unknown flag to stdout with exit 0 rather than failing, so the
 * "fallback on failure" shape is dead code: the echoed flag must be detected
 * as the signal. A relative answer is relative to the cwd git was run in
 * (`../.git` from a subdirectory). Exported for its unit test.
 */
export function parseCommonGitDir(stdout: string, cwd: string): string | null {
  const value = firstLine(stdout)
  if (!value || value.startsWith('--')) return null
  return isAbsolute(value) ? value : resolve(cwd, value)
}

// git prints paths forward-slashed on every platform; a Windows toplevel comes
// back as `C:/…`. Keep git's own form (it is realpath-resolved); the one
// comparison the renderer makes against it (the workspace's worktree root)
// normalizes separators and case on its side.
function firstLine(stdout: string): string {
  return stdout.split(/\r?\n/)[0]?.trim() ?? ''
}

/**
 * The path THIS host can run git in for a reported cwd, or null when it
 * cannot. A CLI launched through WSL reports Linux paths to a Windows main:
 * `/mnt/<drive>/…` is the Windows drive seen from inside WSL and translates
 * back; any other Linux-absolute path lives inside the WSL filesystem, which
 * git on the Windows side cannot open — that is "unresolved", never "folder".
 * The mirror case (a Windows-form path reaching a POSIX main) is likewise
 * unanswerable. Exported for its unit test; the platform is injectable.
 */
export function hostCwdForResolution(cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  const windowsForm = isWindowsPath(cwd)
  if (platform === 'win32') {
    if (windowsForm) return cwd
    if (isWslDriveMountPath(cwd)) return wslToWindowsPath(cwd, { separator: '/' })
    return null
  }
  return windowsForm ? null : cwd
}

export async function resolveCheckoutForCwd(reportedCwd: string): Promise<ResolvedCheckoutFacts | null> {
  const hostCwd = hostCwdForResolution(reportedCwd)
  if (!hostCwd) return null

  // A vanished directory (a pruned worktree) is reported as missing — the git
  // call would only fail with a chdir error that says nothing about repos, and
  // the tab must be able to show "removed" rather than a plain folder.
  if (!(await pathExists(hostCwd))) return MISSING_DIRECTORY
  // Canonical, because git's `--absolute-git-dir` answer is realpath-resolved
  // while an old git's relative `--git-common-dir` is resolved against THIS
  // path: through a symlinked cwd the two would name the same dir twice and
  // read as a linked worktree.
  const cwd = await realpath(hostCwd).catch(() => hostCwd)

  // The answer only moves when HEAD does (a checkout, a branch switch, a
  // detach): the toplevel and both git dirs are fixed for the life of a
  // checkout. So a directory already answered is re-asked only when its HEAD
  // file's identity changed, which on a turn end that touched no branch is one
  // stat and no git at all.
  const remembered = checkoutMemo.get(cwd)
  if (remembered) {
    const headIdentity = await readHeadIdentity(remembered.headPath)
    if (headIdentity !== null && headIdentity === remembered.headIdentity) {
      rememberCheckout(cwd, remembered)
      return remembered.facts
    }
  }

  const answer = await readCheckoutFacts(cwd)
  if (answer && answer.headPath) {
    const headIdentity = await readHeadIdentity(answer.headPath)
    if (headIdentity !== null) rememberCheckout(cwd, { facts: answer.facts, headPath: answer.headPath, headIdentity })
  } else {
    checkoutMemo.delete(cwd)
  }
  return answer?.facts ?? null
}

/**
 * Everything but the branch in ONE git call. The flags answer in the order
 * they are given, one per line:
 *
 *   1. the work tree root (git's realpath of it)
 *   2. this checkout's own git dir
 *   3. the common git dir — absolute on git ≥ 2.31; an older git echoes the
 *      unknown `--path-format` flag as a line of its own first (see
 *      parseCommonGitDir) and then answers relative to the cwd.
 *
 * The branch is read from the HEAD file rather than from a second git: that
 * file is what we stat to know whether to ask again, and it says `ref:
 * refs/heads/<name>` on a branch (unborn included) and a bare object id when
 * detached. Only an unrecognisable HEAD (a reftable repository keeps a
 * placeholder there) falls back to asking git.
 */
async function readCheckoutFacts(
  cwd: string,
): Promise<{ facts: ResolvedCheckoutFacts; headPath: string | null } | null> {
  const parsed = await runGitCommand(
    cwd,
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    CLEAN_GIT_ENV,
  )
  if (!parsed.ok) return saysNotARepo(parsed.stderr, parsed.message) ? { facts: NOT_A_CHECKOUT, headPath: null } : null
  const lines = parsed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  // An old git echoes the unknown flag first; drop it and keep reading.
  const echoed = lines[0]?.startsWith('--') ?? false
  const [gitRoot = '', ownGitDir = '', commonAnswer = ''] = echoed ? lines.slice(1) : lines
  if (!gitRoot) return { facts: NOT_A_CHECKOUT, headPath: null }
  const commonGitDir = (echoed ? parseCommonGitDir(commonAnswer, cwd) : commonAnswer) ?? ''

  const isLinkedWorktree = Boolean(ownGitDir && commonGitDir && resolve(ownGitDir) !== resolve(commonGitDir))
  // The primary checkout owns the common git dir as `<root>/.git`; anything
  // else (a bare repository, an unusual GIT_DIR layout) has no primary work
  // tree to point at.
  const repoRoot =
    commonGitDir && basename(commonGitDir) === '.git' ? dirname(commonGitDir) : isLinkedWorktree ? null : gitRoot

  const headPath = ownGitDir ? join(ownGitDir, 'HEAD') : null
  let branch = headPath ? branchFromHeadFile(await readFile(headPath, 'utf8').catch(() => null)) : undefined
  if (branch === undefined) {
    const head = await runGitCommand(cwd, [...HEAD_BRANCH_REF_ARGS], CLEAN_GIT_ENV)
    branch = head.ok ? branchNameFromHeadRef(head.stdout) : null
  }

  return { facts: { gitRoot, repoRoot, branch, isLinkedWorktree }, headPath }
}

/**
 * The branch a HEAD file names: the name on a branch, null when detached, and
 * undefined when the file cannot be read or says something this does not
 * recognise, which sends the caller to git. Exported for its unit test.
 */
export function branchFromHeadFile(content: string | null): string | null | undefined {
  if (content === null) return undefined
  const text = content.trim()
  const ref = text.match(/^ref:\s*refs\/heads\/(.+)$/)
  if (ref) return ref[1] === '.invalid' ? undefined : ref[1]
  if (/^[0-9a-f]{40,64}$/i.test(text)) return null
  return undefined
}

type CheckoutMemoEntry = { facts: ResolvedCheckoutFacts; headPath: string; headIdentity: string }

// Bounded like the runtime's own cache: one entry per directory an agent has
// been observed in, oldest dropped first.
const CHECKOUT_MEMO_LIMIT = 128
const checkoutMemo = new Map<string, CheckoutMemoEntry>()

function rememberCheckout(cwd: string, entry: CheckoutMemoEntry): void {
  checkoutMemo.delete(cwd)
  checkoutMemo.set(cwd, entry)
  while (checkoutMemo.size > CHECKOUT_MEMO_LIMIT) {
    const oldest = checkoutMemo.keys().next().value
    if (oldest === undefined) break
    checkoutMemo.delete(oldest)
  }
}

/**
 * HEAD's identity on disk: inode, size and nanosecond mtime. Git rewrites HEAD
 * through a lock file and a rename, so every switch lands a new inode even
 * where the clock's granularity would hide the mtime moving. Null when the
 * file cannot be read, which forces a fresh answer.
 */
async function readHeadIdentity(headPath: string): Promise<string | null> {
  try {
    const info = await stat(headPath, { bigint: true })
    return `${info.ino}:${info.size}:${info.mtimeNs}`
  } catch {
    return null
  }
}

/** Forgets every remembered answer. For tests. */
export function clearCheckoutResolveMemo(): void {
  checkoutMemo.clear()
}
