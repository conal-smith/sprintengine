// Reading a skill or plugin repository over git instead of the GitHub API.
//
// The git-transport ruling (owner, 2026-09-08): GitHub's REST limit is what
// capped the linked-plugin follow at 20 repositories an hour for a machine
// without a token, and git's own protocol is not counted by it at all. So this
// reader answers the same three questions `github-tree.ts` did, over the git
// CLI, with no REST call anywhere:
//
//   head   → `git ls-remote`, one round trip, no clone;
//   tree   → a bare partial clone (`--filter=blob:none`) fetched at the pinned
//            commit, listed with `git ls-tree -r -t`;
//   file   → `git cat-file --batch-check` then `-p`, whose blob the promisor
//            remote fetches lazily on first read — which is the point of the
//            filter: a 200-plugin marketplace scan downloads trees, not
//            contents.
//
// Everything it returns is shaped like the API listing (mode `040000` for a
// directory, `type` one of blob/tree/commit) because `scanSkillTree` reads those
// fields and must not be able to tell the two transports apart. The one field it
// cannot answer is `size`, which is optional and display-only — see the note at
// the `ls-tree` call for why asking git for it costs three and a half minutes a
// repository.
//
// Which commands are "network" commands is a security boundary, not a
// performance one: `ls-remote`, `fetch` AND both halves of the `cat-file` read
// talk to the host, because in a `blob:none` clone a `cat-file` of an unfetched
// blob is a fetch wearing a local command's clothes. They all carry the same
// credential config, the same longer timeout, and the same semaphore.

import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { access, lstat, mkdir, readdir, rm, utimes } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import {
  DEFAULT_SKILL_MAX_FILE_BYTES,
  DEFAULT_SKILL_MAX_LISTING_BYTES,
  DEFAULT_SKILL_MAX_TREE_ENTRIES,
} from './github-tree'
import { isSkillRepoSegment, splitSkillRepo, type SkillRepoLocation, type SkillRepoSsh } from '../../shared/skill-repo'
import { withGitExecutable } from '../git-executable'
import { explicitGitDir, GIT_SAFETY_CONFIG } from '../git-run'
import type { SkillRepoReader } from './repo-reader'
import type { SkillTreeEntry } from './scan'

const DEFAULT_HOST = 'github.com'
// Sixteen, not eight: every `cat-file` now waits in this line too (it can fetch
// a blob), so a marketplace read holds a slot for its file reads as well as for
// its fetches. Git processes are cheap; the host's own limits are the ceiling.
const DEFAULT_CONCURRENCY = 16
const NETWORK_TIMEOUT_MS = 60_000
const LOCAL_TIMEOUT_MS = 15_000
/** Listings kept in memory. Losing one costs a local `ls-tree`, so the bound is small. */
const MAX_CACHED_TREES = 64

/** Why a git read failed, for the copy that decides between "retry" and "give up". */
export type GitRepoReadErrorKind = 'offline' | 'unreadable' | 'timeout' | 'rate-limited'

export class GitRepoReadError extends Error {
  constructor(
    readonly kind: GitRepoReadErrorKind,
    message: string,
    /** What git said on stderr, kept for the log; never shown raw to a user. */
    readonly stderr = '',
  ) {
    super(message)
    this.name = 'GitRepoReadError'
  }
}

export type GitRunOptions = {
  cwd?: string
  /**
   * The bare clone the command works in, named to git with `--git-dir`: the
   * app's git does not take a bare repository it only finds from its working
   * directory (`safe.bareRepository=explicit`, git-run.ts).
   */
  gitDir?: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Written to the child's stdin and closed. Only `cat-file --batch-check` uses it. */
  stdin?: string
}
export type GitRunResult = { stdout: Buffer; stderr: string }
/** Runs `git` with these args and resolves its stdout, or rejects when git exits non-zero. */
export type RunGit = (args: string[], options: GitRunOptions) => Promise<GitRunResult>

export type GitRepoReaderOptions = {
  /** Directory the per-repository clones live under (the integrator passes `<userData>/skill-repos`). */
  cacheDir: string
  /**
   * Host a bare `owner/name` lives on; default 'github.com'. A repository on
   * any other host names it — `host/owner/name` — and is read from there.
   */
  host?: string
  /**
   * Resolved GitHub token or ''. Sent ONLY to the default host, never to a
   * repository on any other. Used ONLY as an `Authorization: Bearer` header
   * passed to git through `GIT_CONFIG_*` in the environment — never in argv,
   * where `ps` would show it, and never written into the clone's config or the
   * remote URL, so a token that is later revoked or rotated leaves nothing
   * behind on disk to leak or to go stale.
   */
  resolveToken?: () => Promise<string>
  /**
   * A token for a host other than the default one — a company's self-hosted
   * GitHub — or '' when there is none. The integrator answers from the GitHub
   * CLI's sign-in for that host. With a token the read carries it the same way
   * the default host's is carried; without one the person's own git credential
   * helper answers, exactly as it does for a `git clone` in their terminal.
   */
  resolveHostToken?: (host: string) => Promise<string>
  /** How many git processes may talk to the network at once; default 16. */
  concurrency?: number
  /** Per-command timeout for anything that reaches the host, ms; default 60_000. */
  networkTimeoutMs?: number
  /** Per-command timeout for a command that only touches the clone, ms; default 15_000. */
  localTimeoutMs?: number
  /** @deprecated Sets both timeouts. Prefer `networkTimeoutMs` / `localTimeoutMs`. */
  timeoutMs?: number
  /** Injected in tests: runs `git` with these args in this cwd and returns stdout. */
  runGit?: RunGit
  /**
   * TEST ONLY. Builds the clone URL for a repository. The suite points this at a
   * fixture repository on disk so the whole reader can be exercised with the real
   * git binary and no network; production always uses `https://<host>/<owner>/<name>.git`.
   */
  remoteUrl?: (repo: string) => string
}

// ── Names, paths and URLs ────────────────────────────────────────────────────

// The pattern `parseSkillRepoRef` accepts, minus the three shapes that are fine
// in a URL but are not a directory name: `.`, `..`, and a leading dash. A repo
// name reaches here from a marketplace manifest we did not write, and it becomes
// both a path segment under the cache directory and a URL path segment, so it is
// checked before either is built rather than after.
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
// A host directory in the cache: the host, and for an ssh clone the user and
// port it was reached with (see `ParsedRepo.cacheSegments`).
const CACHE_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*(?:\+ssh-[A-Za-z0-9._-]+)?$/

type ParsedRepo = {
  host: string
  owner: string
  name: string
  ssh?: SkillRepoSsh
  /** What `git clone` is handed. */
  remote: string
  /**
   * The clone's directory under the cache, as `[hostDir, ownerDir, name.git]`.
   * A nested owner is joined with `+` — a character no host allows in a path
   * segment — so the layout stays three levels deep for the sweep; an ssh
   * repository gets a host directory of its own, because its clone's remote
   * is a different address from the https one.
   */
  cacheSegments: [string, string, string]
}

/**
 * `owner/name` on the reader's own host, or any other `repo` shape
 * (`src/shared/skill-repo.ts`): `host/path/name` over https, or
 * `ssh://user@host[:port]/path/name`. Every segment is checked by the same
 * rules the source's `repo` was written with, so the directory and the URL it
 * becomes are never anything stranger than a dotted hostname and plain names.
 */
function parseRepo(repo: string, defaultHost: string): ParsedRepo {
  const trimmed = repo.trim().replace(/\.git$/, '')
  const segments = trimmed.split('/')
  const location: SkillRepoLocation | null =
    segments.length === 2 && !trimmed.includes('://')
      ? segments.every(isSkillRepoSegment)
        ? { host: defaultHost, owner: segments[0], name: segments[1] }
        : null
      : splitSkillRepo(trimmed)
  if (!location) throw refused(repo)
  const host = checkedHost(location.host)
  const path = `${location.owner}/${location.name}.git`
  const ssh = location.ssh
  const remote = ssh ? `ssh://${ssh.user}@${host}${ssh.port ? `:${ssh.port}` : ''}/${path}` : `https://${host}/${path}`
  const hostDir = ssh ? `${host}+ssh-${ssh.user}${ssh.port ? `-${ssh.port}` : ''}` : host
  return {
    host,
    owner: location.owner,
    name: location.name,
    ...(ssh ? { ssh } : {}),
    remote,
    cacheSegments: [hostDir, location.owner.split('/').join('+'), `${location.name}.git`],
  }
}

function refused(repo: string): GitRepoReadError {
  return new GitRepoReadError('unreadable', `"${repo}" is not a repository address this app can read.`)
}

function checkedHost(host: string): string {
  if (!HOST_PATTERN.test(host) || host === '..') {
    throw new GitRepoReadError('unreadable', `"${host}" is not a valid git host.`)
  }
  return host
}

/** Where a repository's clone lives, so the integrator can report disk usage later. */
export function gitRepoCacheDir(cacheDir: string, host: string, repo: string): string {
  return join(cacheDir, ...parseRepo(repo, checkedHost(host)).cacheSegments)
}

// ── Running git ──────────────────────────────────────────────────────────────

// Nothing may ever prompt: an Electron main process has no terminal to answer a
// credential question on, so a repository that asks would hang the scan instead
// of failing it. GIT_TERMINAL_PROMPT and GIT_ASKPASS close git's own doors,
// GCM_INTERACTIVE closes Git Credential Manager's, and an emptied
// `credential.helper` (set through GIT_CONFIG_* below) stops the macOS keychain
// helper from opening a dialog. GIT_ASKPASS is EMPTY rather than `echo`: `echo`
// is a program that succeeds and answers every prompt with the prompt's own
// text, so git would take "Password for 'https://…':" as a password and spend a
// round trip being rejected. Empty leaves git with no askpass at all, and with
// GIT_TERMINAL_PROMPT=0 it fails on the spot instead. LC_ALL=C pins the messages
// this file classifies on.
function gitEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    // ssh's own askpass, which OpenSSH would otherwise run for a passphrase or
    // an unknown host key whenever a display is set, even with no terminal.
    SSH_ASKPASS_REQUIRE: 'never',
    LC_ALL: 'C',
    ...overrides,
  }
}

class GitProcessError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut: boolean,
    readonly overflow: boolean,
  ) {
    super(message)
    this.name = 'GitProcessError'
  }
}

/**
 * The default runner. Three things it does that `execFile` would not:
 *
 *   - it spawns into its own process group, because a `cat-file` that lazily
 *     fetches a blob has a `git fetch` GRANDCHILD, and killing only the child on
 *     a timeout leaves that grandchild holding the network and the clone's
 *     lockfiles until it finishes on its own;
 *   - it caps stdout at the listing ceiling itself (one `ls-tree` of a
 *     200k-entry repository is by far the largest thing git hands back here —
 *     the same ceiling the API reader gives its tree call);
 *   - it never reports Node's own error message, which spells out the whole
 *     argv. Nothing secret is passed in argv any more, and this is the second
 *     lock on that door: a failure with an empty stderr says only the exit code.
 */
export function defaultRunGit(args: string[], options: GitRunOptions): Promise<GitRunResult> {
  // On Windows, the real git.exe rather than Git for Windows' launcher (see
  // git-executable.ts) — which also makes the child killed below git itself,
  // not a launcher whose git would outlive it.
  const env = gitEnv(options.env)
  const argv = [...GIT_SAFETY_CONFIG, ...(options.gitDir ? [explicitGitDir(options.gitDir)] : []), ...args]
  return withGitExecutable(env, (file) => startGit(file, argv, env, options))
}

function startGit(file: string, args: string[], env: NodeJS.ProcessEnv, options: GitRunOptions): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    // Windows has no process groups to detach into; there the child alone is
    // what we can kill, and `windowsHide` keeps a console from flashing up.
    const grouped = process.platform !== 'win32'
    const child = spawn(file, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      detached: grouped,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrText = ''
    let overflow = false
    let timedOut = false
    let settled = false

    const stop = (): void => {
      try {
        if (grouped && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // The group may already be gone, or the platform may not have one.
        try {
          child.kill('SIGKILL')
        } catch {
          // Already reaped.
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    timer.unref?.()

    const settle = (body: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      body()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > DEFAULT_SKILL_MAX_LISTING_BYTES) {
        overflow = true
        stop()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Enough to classify on; a repository cannot make us hold its whole log.
      if (stderrText.length < 64 * 1024) stderrText += chunk.toString('utf8')
    })
    // A closed stdin on a command that wanted none is normal, and its EPIPE is
    // not a failure of the read.
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin ?? '')

    child.on('error', (error) => settle(() => reject(error)))
    // `close`, not `exit`: it fires once stdout and stderr have both ended, so
    // the bytes below are all of them.
    child.on('close', (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(new GitProcessError('git took too long and was stopped.', stderrText, true, false))
          return
        }
        if (overflow) {
          reject(new GitProcessError('git produced more output than this reader accepts.', stderrText, false, true))
          return
        }
        if (code === 0) {
          resolve({ stdout: Buffer.concat(chunks), stderr: stderrText })
          return
        }
        const killed = code === null
        const detail = killed ? `git was stopped by ${signal ?? 'a signal'}` : `git exited with code ${code}`
        reject(new GitProcessError(stderrText.trim() || detail, stderrText, killed, false))
      })
    })
  })
}

/** True when a `git` the app can run is on PATH. The transport choice hangs on this. */
export async function isGitAvailable(runGit: RunGit = defaultRunGit): Promise<boolean> {
  try {
    await runGit(['--version'], { timeoutMs: LOCAL_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

// A host that is refusing us for a minute — a 429, a 5xx, GitHub's secondary
// rate limit — is not the same answer as a repository that is gone, and it is
// checked FIRST because "returned error: 429" would otherwise be swallowed by
// the generic `[45]\d\d` refusal below and told to give up forever.
const GIT_RATE_LIMITED = /returned error: 429|too many requests|rate limit|returned error: 5\d\d/i
// A refusal that will read the same way in an hour — the repository is gone,
// private, or behind SSO — must never be reported as "offline", or the caller
// retries forever. Checked before "offline", because git wraps several of these
// in the same "unable to access" line that a genuinely unreachable host produces.
const GIT_REFUSAL =
  /not found|returned error: [45]\d\d|authentication failed|access denied|permission denied|does not appear to be a git repository|invalid username or password/i
const GIT_OFFLINE =
  /could not resolve host|could not resolve proxy|unable to access|connection refused|connection reset|network is unreachable|temporary failure in name resolution|failed to connect|operation timed out|could not read from remote repository|ssl/i

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  return line ?? ''
}

// What git says when a host wanted credentials and nothing supplied them: no
// token, no helper holding one, every prompt closed — or, over ssh, no key the
// host accepts, or a host key this machine has never been told to trust.
const GIT_NEEDS_SIGN_IN =
  /terminal prompts disabled|could not read username|could not read password|authentication failed|invalid username or password|permission denied \(publickey|host key verification failed/i

/**
 * `other` describes a repository that is not a github.com one read over https:
 * which host, the address git was given, whether it went over ssh and whether
 * a token went with it. A read there that failed for want of a sign-in is the
 * one failure whose fix is not on this machine's screen, so it names the fix —
 * and a token that WAS sent and refused is a different fix from having none.
 * A missing sign-in is never "offline", whatever wording git wrapped it in:
 * ssh's refusals end in "Could not read from remote repository", which on its
 * own reads as a network failure and would be retried forever.
 */
function classify(
  error: unknown,
  what: string,
  other: { host: string; remote: string; ssh: boolean; tokenSent: boolean } | null = null,
): GitRepoReadError {
  if (error instanceof GitRepoReadError) return error
  const failed = classifyGitFailure(error, what)
  if (!other || failed.kind === 'timeout' || !GIT_NEEDS_SIGN_IN.test(failed.stderr || failed.message)) {
    return failed
  }
  const text = failed.stderr || failed.message
  const message = other.ssh
    ? /host key verification failed/i.test(text)
      ? `This machine has not been told to trust ${other.host}'s ssh host key. Run \`git ls-remote ${other.remote}\` ` +
        `in a terminal once and accept it, then try again.`
      : `${other.host} refused this machine's ssh key. Make sure \`git ls-remote ${other.remote}\` works in a ` +
        `terminal — the key loaded in your ssh agent — then try again.`
    : other.tokenSent
      ? `${other.host} refused the GitHub CLI's sign-in for it. It may lack the repo scope or single sign-on ` +
        `authorization for this organization; \`gh auth refresh --hostname ${other.host} --scopes repo\` renews it.`
      : `${other.host} asked for a sign-in. Make sure \`git ls-remote ${other.remote}\` works in a terminal ` +
        `(on a GitHub host, \`gh auth login --hostname ${other.host}\` is enough), then try again.`
  return new GitRepoReadError('unreadable', message, failed.stderr)
}

function classifyGitFailure(error: unknown, what: string): GitRepoReadError {
  const detail = error as
    { stderr?: unknown; message?: unknown; timedOut?: unknown; overflow?: unknown; killed?: unknown } | undefined
  const stderr = typeof detail?.stderr === 'string' ? detail.stderr : ''
  const message = typeof detail?.message === 'string' ? detail.message : String(error)
  const text = `${stderr}\n${message}`
  if (detail?.overflow === true) {
    return new GitRepoReadError(
      'unreadable',
      `This repository's file listing is larger than ${DEFAULT_SKILL_MAX_LISTING_BYTES} bytes.`,
      stderr,
    )
  }
  if (detail?.timedOut === true || detail?.killed === true || /ETIMEDOUT/i.test(text)) {
    return new GitRepoReadError('timeout', `${what} took too long and was stopped.`, stderr)
  }
  if (GIT_RATE_LIMITED.test(text)) {
    return new GitRepoReadError('rate-limited', `The git host is refusing requests for now. ${firstLine(text)}`, stderr)
  }
  if (!GIT_REFUSAL.test(text) && GIT_OFFLINE.test(text)) {
    return new GitRepoReadError('offline', `Could not reach the git host. ${firstLine(text)}`, stderr)
  }
  return new GitRepoReadError('unreadable', `${what} failed. ${firstLine(text)}`, stderr)
}

// ── Waiting in line ──────────────────────────────────────────────────────────

type Release = () => void

/** A plain counting semaphore: `limit` git processes may be on the network at once. */
function createSemaphore(limit: number): { acquire: () => Promise<Release> } {
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<Release> =>
    new Promise<Release>((resolve) => {
      const grant = (): void => {
        active += 1
        resolve(() => {
          active -= 1
          waiting.shift()?.()
        })
      }
      if (active < limit) grant()
      else waiting.push(grant)
    })
  return { acquire }
}

/**
 * One in-flight PREPARATION per clone directory. Two callers asking for the same
 * repository at the same time — which is exactly what the linked-plugin follow
 * does — would otherwise run two `git fetch`es into one directory and race over
 * its lockfiles.
 *
 * It covers `ensureClone`/`ensureCommit` and nothing else. Reads that follow —
 * `ls-tree`, `cat-file`, and the promisor fetch a `cat-file` may trigger — run
 * outside it, because they are safe to run at once against one object store and
 * holding the lock across them serialised the eight `SKILL.md` reads of a single
 * repository into a queue.
 *
 * The lock is IN-PROCESS. Two copies of the app over one cache directory hold no
 * lock against each other and rely on git's own lockfiles (`shallow.lock`,
 * `packed-refs.lock`, and the per-object write being an atomic rename) to keep
 * the clone consistent; the cost of losing that race is a retried command, not a
 * corrupt repository.
 */
function createRepoLocks(): <T>(key: string, body: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, body: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(body, body)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

// ── The cache on disk ────────────────────────────────────────────────────────

/**
 * Stamps a clone as used just now. The sweep below reads this, and nothing else
 * does — a clone's own mtime moves for reasons that have nothing to do with a
 * caller wanting the repository.
 */
export async function touchGitRepoCache(cloneDir: string): Promise<void> {
  const now = new Date()
  try {
    await utimes(cloneDir, now, now)
  } catch {
    // The clone may have been swept between the read and the stamp; the next
    // read will make it again.
  }
}

/**
 * Removes clone directories nothing has read for `olderThanMs`, and reports what
 * went and how many bytes remain. The integrator calls it at startup: a bare
 * partial clone is small, but a marketplace follow makes one per linked
 * repository and nothing else ever deletes them.
 *
 * It only ever removes a path of exactly the shape this file writes —
 * `<cacheDir>/<host>/<owner>/<name>.git` (a nested owner joined with `+`, an
 * ssh host carrying `+ssh-<user>[-<port>]`), each segment a name this file would
 * have accepted, every level a real directory rather than a symlink. Anything
 * else under the cache directory is left alone rather than guessed about.
 */
export async function sweepGitRepoCache(
  cacheDir: string,
  olderThanMs: number,
): Promise<{ removed: string[]; keptBytes?: number }> {
  const removed: string[] = []
  let keptBytes = 0
  const cutoff = Date.now() - Math.max(0, olderThanMs)

  const realDirectories = async (parent: string): Promise<string[]> => {
    try {
      const entries = await readdir(parent, { withFileTypes: true })
      // `isDirectory` on a Dirent is an lstat: a symlink to a directory reads as
      // a symlink here, which is what keeps the sweep inside the cache.
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  for (const host of await realDirectories(cacheDir)) {
    if (!CACHE_HOST_PATTERN.test(host) || host === '..') continue
    const hostDir = join(cacheDir, host)
    for (const owner of await realDirectories(hostDir)) {
      if (!owner.split('+').every(isCacheSegment)) continue
      const ownerDir = join(hostDir, owner)
      for (const entry of await realDirectories(ownerDir)) {
        if (!entry.endsWith('.git') || !isCacheSegment(entry.slice(0, -4))) continue
        const clone = join(ownerDir, entry)
        const info = await lstat(clone).catch(() => null)
        if (!info || !info.isDirectory()) continue
        if (info.mtimeMs < cutoff) {
          await rm(clone, { recursive: true, force: true })
          removed.push(clone)
        } else {
          keptBytes += await directoryBytes(clone)
        }
      }
    }
  }
  return { removed, keptBytes }
}

function isCacheSegment(segment: string): boolean {
  return REPO_NAME_PATTERN.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-')
}

/** Bytes under a directory, following nothing. A bare partial clone is a handful of packs. */
async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        const info = await lstat(path).catch(() => null)
        if (info) total += info.size
      }
    }
  }
  return total
}

// ── The reader ───────────────────────────────────────────────────────────────

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
// Never a leading `-`: a ref is an argument to git, and must not read as an option.
const REF_PATTERN = /^(?!-)[A-Za-z0-9._/-]+$/
// A ref that is already a commit SHA — SHA-1 or SHA-256. The API's
// `commits/{ref}` endpoint accepts one, so a source may well be pinned by one,
// and asking `ls-remote` about it is a round trip that can only answer nothing.
const SHA_AS_REF = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i
// `<mode> SP <type> SP <sha> TAB <path>`, one NUL-terminated record per entry.
// `-z` is what makes this parseable: without it git quotes any path with a
// non-ASCII byte in it, and a skill repository full of emoji filenames would
// come back mangled.
const LS_TREE_ENTRY = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]*)$/
// `cat-file --batch-check` answers one of these two lines per request.
const BATCH_CHECK_OK = /^([0-9a-f]{40,64}) (blob|tree|commit|tag) (\d+)$/
// A server that ignored `--filter` has just sent the WHOLE repository, and every
// later read of it is a full clone too. Nothing about that is recoverable by
// retrying, so the host is written off for the rest of the process.
const NO_PARTIAL_CLONE = /filtering not recognized by server, ignoring/i
// A server that will not serve a commit by SHA unless a branch or tag points at
// it. A pinned marketplace entry cannot be read from such a host at all.
const UNADVERTISED = /not our ref|server does not allow request for unadvertised object/i

export function createGitRepoReader(options: GitRepoReaderOptions): SkillRepoReader {
  const host = checkedHost(options.host ?? DEFAULT_HOST)
  const runGit = options.runGit ?? defaultRunGit
  const network = createSemaphore(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY))
  const withRepoLock = createRepoLocks()
  const networkTimeoutMs = options.networkTimeoutMs ?? options.timeoutMs ?? NETWORK_TIMEOUT_MS
  const localTimeoutMs = options.localTimeoutMs ?? options.timeoutMs ?? LOCAL_TIMEOUT_MS
  // A commit is immutable, so both of these are correct for as long as the clone
  // holding it is: the listing never changes, and a commit already in the clone
  // never leaves it — unless the directory itself goes, which `ensureClone`
  // notices and both of these are then dropped for.
  const trees = new Map<string, readonly SkillTreeEntry[]>()
  const present = new Set<string>()
  // Clone directories this process has already written the config of. M4: the
  // config, not `access(HEAD)`, is what says a clone is usable.
  const prepared = new Set<string>()
  // Hosts that answered a `--filter` fetch by sending everything.
  const noPartialClone = new Set<string>()

  const parse = (repo: string): ParsedRepo => parseRepo(repo, host)

  const remoteUrl = (repo: string): string => {
    const parsed = parse(repo)
    return options.remoteUrl ? options.remoteUrl(repo) : parsed.remote
  }

  // Keyed off the PARSED name, so `acme/widgets` and `acme/widgets.git` — which
  // already share one directory — share one cache entry as well.
  const repoKey = (parsed: ParsedRepo): string => parsed.cacheSegments.join('/')
  const cloneDir = (parsed: ParsedRepo): string => join(options.cacheDir, ...parsed.cacheSegments)

  /**
   * The environment every network command carries. The token goes here and NOT
   * in argv, where `ps` on a shared machine would show it and where Node would
   * print it back in the message of a failed spawn. The header is scoped to the
   * host's URL, so a redirect to anywhere else drops it rather than forwarding
   * it. Git passes these variables on to the children it spawns itself, which is
   * how the promisor `fetch` behind a `cat-file` ends up authenticated too
   * (verified against git 2.50; the mechanism is git ≥ 2.31).
   *
   * Another host — a company's self-hosted GitHub — never sees the default
   * host's token. Its own, when the integrator has one, goes as Basic
   * credentials, which every GitHub Enterprise Server release accepts over git
   * where Bearer is not promised. Without one the person's credential helper is
   * LEFT IN PLACE: an internal repository is private by definition, and the
   * helper that answers their own `git clone` of it is the sign-in they already
   * have. It cannot prompt — GIT_TERMINAL_PROMPT, GIT_ASKPASS and
   * GCM_INTERACTIVE are closed in `gitEnv`, and `credential.interactive=false`
   * is the same request in the form every helper that honours one reads — so
   * a helper with nothing stored fails the read, and `classify` says how to
   * sign in. A helper that raises its own OS dialog regardless (a locked
   * keychain) is the one thing this cannot close; `gh auth login` for the host
   * takes the helper out of the read altogether.
   */
  const networkEnv = async (parsed: ParsedRepo): Promise<NodeJS.ProcessEnv> => {
    // Over ssh the person's own keys and agent answer, exactly as for their own
    // `git clone`; there is no http header to add and no helper involved.
    // `gitEnv` closes ssh's prompts (and the child has no terminal to prompt
    // on), so a key that needs a passphrase nobody loaded fails the read.
    if (parsed.ssh) return {}
    const repoHost = parsed.host
    if (repoHost !== host) {
      const hostToken = (await options.resolveHostToken?.(repoHost).catch(() => ''))?.trim() ?? ''
      if (!hostToken) {
        return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.interactive', GIT_CONFIG_VALUE_0: 'false' }
      }
      const basic = Buffer.from(`x-access-token:${hostToken}`, 'utf8').toString('base64')
      return {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: `http.https://${repoHost}/.extraHeader`,
        GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
      }
    }
    const token = (await options.resolveToken?.())?.trim() ?? ''
    if (!token) {
      return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }
    }
    return {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: `http.https://${host}/.extraHeader`,
      GIT_CONFIG_VALUE_1: `Authorization: Bearer ${token}`,
    }
  }

  const runNetwork = async (
    parsed: ParsedRepo,
    args: string[],
    cwd: string | undefined,
    what: string,
    stdin?: string,
  ): Promise<GitRunResult> => {
    const env = await networkEnv(parsed)
    const release = await network.acquire()
    try {
      return await runGit(args, { ...inClone(cwd), timeoutMs: networkTimeoutMs, env, stdin })
    } catch (error) {
      const other =
        parsed.host === host && !parsed.ssh
          ? null
          : {
              host: parsed.host,
              remote: parsed.remote,
              ssh: parsed.ssh !== undefined,
              tokenSent: env.GIT_CONFIG_KEY_1 !== undefined,
            }
      throw classify(error, what, other)
    } finally {
      release()
    }
  }

  // Every command but two runs inside one of the bare clones under the cache
  // directory; those two (`init --bare` and `ls-remote`) run in a folder that
  // is not a repository, and are left to find none.
  // A clone is `<cacheDir>/<host>/<owner>/<name>.git`, three levels down.
  const isCloneDir = (cwd: string): boolean => {
    const segments = relative(options.cacheDir, cwd).split(/[\\/]/u)
    return segments.length === 3 && segments.every((segment) => segment !== '' && segment !== '..')
  }
  const inClone = (cwd: string | undefined): Pick<GitRunOptions, 'cwd' | 'gitDir'> =>
    cwd === undefined || !isCloneDir(cwd) ? { cwd } : { cwd, gitDir: cwd }

  const runLocal = async (args: string[], cwd: string, what: string): Promise<GitRunResult> => {
    try {
      return await runGit(args, { ...inClone(cwd), timeoutMs: localTimeoutMs })
    } catch (error) {
      throw classify(error, what)
    }
  }

  const checkedSha = (repo: string, sha: string): string => {
    const value = sha.trim().toLowerCase()
    if (!SHA_PATTERN.test(value)) {
      throw new GitRepoReadError('unreadable', `"${sha}" is not a commit SHA for ${repo}.`)
    }
    return value
  }

  /** Everything remembered about a repository, dropped when its directory is not there any more. */
  const forget = (key: string): void => {
    for (const remembered of [...present]) if (remembered.startsWith(`${key}@`)) present.delete(remembered)
    for (const remembered of [...trees.keys()]) if (remembered.startsWith(`${key}@`)) trees.delete(remembered)
  }

  const rememberTree = (key: string, entries: readonly SkillTreeEntry[]): void => {
    trees.delete(key)
    trees.set(key, entries)
    while (trees.size > MAX_CACHED_TREES) {
      const oldest = trees.keys().next().value
      if (oldest === undefined) break
      trees.delete(oldest)
    }
  }

  const recallTree = (key: string): readonly SkillTreeEntry[] | undefined => {
    const entries = trees.get(key)
    if (!entries) return undefined
    // Re-inserted so the bound above evicts the least recently used, not the
    // first one read.
    trees.delete(key)
    trees.set(key, entries)
    return entries
  }

  /** Is this directory a clone we can fetch into — i.e. does its config name the remote? */
  const hasRemote = async (dir: string): Promise<boolean> => {
    try {
      const { stdout } = await runGit(['config', '--get', 'remote.origin.url'], {
        ...inClone(dir),
        timeoutMs: localTimeoutMs,
      })
      return stdout.toString('utf8').trim().length > 0
    } catch {
      return false
    }
  }

  /**
   * The bare, blob-filtered clone. Readiness is the REMOTE, not `HEAD`: a crash
   * between `init --bare` and the remote config used to leave a directory with a
   * HEAD and no origin, which every later fetch failed on with "'origin' does not
   * appear to be a git repository" and which no amount of retrying fixed. Every
   * step below is idempotent — `init --bare` on an existing bare repository is a
   * no-op, and `config <key> <value>` overwrites where `remote add` would refuse
   * — so a half-written clone is simply finished.
   */
  const ensureClone = async (repo: string, parsed: ParsedRepo): Promise<{ dir: string; recreated: boolean }> => {
    const dir = cloneDir(parsed)
    // A directory this process already prepared needs only to still be there;
    // one it has not seen is asked properly.
    const ready = prepared.has(dir) ? await exists(join(dir, 'config')) : await hasRemote(dir)
    if (ready) {
      prepared.add(dir)
      return { dir, recreated: false }
    }
    const what = `Preparing a clone of ${repo}`
    await mkdir(dirname(dir), { recursive: true })
    // `init --bare` + the `remote.origin.*` keys is byte-for-byte the config
    // `git clone --bare --filter=blob:none` writes, and it is the config alone
    // that arms the promisor: a later `cat-file` of a blob we never fetched goes
    // and gets it. Building it by hand is what lets the first fetch be of a bare
    // commit SHA rather than of a branch we would then have to guess.
    await runLocal(['init', '--bare', '-q', dir], dirname(dir), what)
    await runLocal(['config', 'remote.origin.url', remoteUrl(repo)], dir, what)
    await runLocal(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], dir, what)
    await runLocal(['config', 'remote.origin.promisor', 'true'], dir, what)
    await runLocal(['config', 'remote.origin.partialclonefilter', 'blob:none'], dir, what)
    prepared.add(dir)
    return { dir, recreated: true }
  }

  // GIT_NO_LAZY_FETCH is the whole point of this call. A promisor remote makes
  // `cat-file -e` on a missing object go and fetch it — one object, one round
  // trip — so without it "is the commit here?" quietly becomes "fetch the commit
  // alone", and the `ls-tree` after it then drags every directory down one at a
  // time. Git below 2.45 does not know the variable and falls back to that
  // behaviour: still correct, just slower, and only until the answer is cached.
  const hasCommit = async (dir: string, sha: string): Promise<boolean> => {
    try {
      await runGit(['cat-file', '-e', `${sha}^{commit}`], {
        ...inClone(dir),
        timeoutMs: localTimeoutMs,
        env: { GIT_NO_LAZY_FETCH: '1' },
      })
      return true
    } catch {
      return false
    }
  }

  /** What a fetch said about itself. Two of git's warnings mean "this host cannot serve us". */
  const checkFetchOutput = (repo: string, repoHost: string, text: string): void => {
    if (NO_PARTIAL_CLONE.test(text)) {
      noPartialClone.add(repoHost)
      throw new GitRepoReadError(
        'unreadable',
        `${repoHost} does not support partial clone, so reading ${repo} would download the whole repository.`,
        text,
      )
    }
    if (UNADVERTISED.test(text)) {
      throw new GitRepoReadError(
        'unreadable',
        `${repoHost} will not serve ${repo} at a commit no branch or tag points at.`,
        text,
      )
    }
  }

  /**
   * The clone, holding that commit. Held under the repository's lock, so two
   * callers wanting the same commit produce one fetch and the second finds it
   * already there. Nothing after this — listing, reading a file, the promisor
   * fetch a read may trigger — holds the lock.
   */
  const ensureCommit = async (repo: string, parsed: ParsedRepo, sha: string): Promise<string> => {
    const key = `${repoKey(parsed)}@${sha}`
    const { dir, recreated } = await ensureClone(repo, parsed)
    // A cache directory deleted from under us is an empty clone wearing the old
    // name: what we remembered about it was true of the directory that is gone.
    if (recreated) forget(repoKey(parsed))
    else if (present.has(key)) return dir
    if (await hasCommit(dir, sha)) {
      present.add(key)
      return dir
    }
    if (noPartialClone.has(parsed.host)) {
      throw new GitRepoReadError(
        'unreadable',
        `${parsed.host} does not support partial clone, so reading ${repo} would download the whole repository.`,
      )
    }
    // GitHub serves an unadvertised commit by full SHA (`uploadpack.allowAnySHA1InWant`),
    // which is what keeps a pinned marketplace entry to a single fetch of exactly
    // the commit it names — no branch guessing, no history we will not read.
    let fetched: GitRunResult
    try {
      fetched = await runNetwork(
        parsed,
        ['fetch', '--filter=blob:none', '--no-tags', '--quiet', 'origin', sha],
        dir,
        `Fetching ${repo} at ${sha.slice(0, 7)}`,
      )
    } catch (error) {
      // A fetch that failed BECAUSE the host cannot serve us this way says so on
      // stderr; that reads better than "fetching failed" and never retries.
      if (error instanceof GitRepoReadError) checkFetchOutput(repo, parsed.host, error.stderr)
      throw error
    }
    checkFetchOutput(repo, parsed.host, fetched.stderr)
    if (!(await hasCommit(dir, sha))) {
      throw new GitRepoReadError('unreadable', `${repo} does not contain the commit ${sha}.`)
    }
    present.add(key)
    return dir
  }

  const parseListing = (repo: string, stdout: Buffer): SkillTreeEntry[] => {
    const records = stdout.toString('utf8').split('\0')
    const entries: SkillTreeEntry[] = []
    for (const record of records) {
      if (record.length === 0) continue
      const match = LS_TREE_ENTRY.exec(record)
      if (!match) continue
      const [, mode, type, sha, path] = match
      // No `size`: see the note on `ls-tree` below. `SkillTreeEntry.size` is
      // optional and only ever displayed, so an entry without one is complete
      // for every decision the scanners make.
      entries.push({ path, mode, type, sha })
      if (entries.length > DEFAULT_SKILL_MAX_TREE_ENTRIES) {
        throw new GitRepoReadError(
          'unreadable',
          `${repo} lists more than ${DEFAULT_SKILL_MAX_TREE_ENTRIES} files, which is too large to scan.`,
        )
      }
    }
    return entries
  }

  return {
    async resolveCommit(repo: string, ref: string): Promise<string> {
      const parsed = parse(repo)
      const url = remoteUrl(repo)
      const wanted = ref.trim()
      // A ref that IS a commit resolves to itself. The API accepted a SHA here,
      // so a pinned source may carry one, and `ls-remote` has nothing to say
      // about a commit no ref points at — it would answer "no branch or tag".
      if (SHA_AS_REF.test(wanted)) return wanted.toLowerCase()
      if (wanted !== '' && !REF_PATTERN.test(wanted)) {
        throw new GitRepoReadError('unreadable', `"${ref}" is not a valid ref for ${repo}.`)
      }
      // Ask for every shape the one name could be in a single round trip, then
      // pick in the order the API's `commits/{ref}` endpoint resolves them: a
      // branch, then a tag, then a literal ref name. An annotated tag's `^{}`
      // line carries the commit the tag points at, which is what a scan pins to —
      // the tag object's own SHA is not a commit and would fail every later read.
      const patterns =
        wanted === '' ? ['HEAD'] : [`refs/heads/${wanted}`, `refs/tags/${wanted}`, `refs/tags/${wanted}^{}`, wanted]
      await mkdir(options.cacheDir, { recursive: true })
      const { stdout } = await runNetwork(
        parsed,
        ['ls-remote', url, ...patterns],
        options.cacheDir,
        `Reading the current commit of ${repo}`,
      )
      const found = new Map<string, string>()
      for (const line of stdout.toString('utf8').split('\n')) {
        const [sha, name] = line.split('\t')
        if (!sha || !name) continue
        if (/^[0-9a-f]{40}$/.test(sha.trim())) found.set(name.trim(), sha.trim())
      }
      const order =
        wanted === '' ? ['HEAD'] : [`refs/heads/${wanted}`, `refs/tags/${wanted}^{}`, `refs/tags/${wanted}`, wanted]
      for (const name of order) {
        const sha = found.get(name)
        if (sha) return sha
      }
      throw new GitRepoReadError(
        'unreadable',
        wanted === '' ? `${repo} has no default branch to read.` : `${repo} has no branch or tag named "${wanted}".`,
      )
    },

    async readTree(repo: string, sha: string): Promise<readonly SkillTreeEntry[]> {
      const parsed = parse(repo)
      const commit = checkedSha(repo, sha)
      const key = `${repoKey(parsed)}@${commit}`
      const cached = recallTree(key)
      if (cached) return cached
      const dir = await withRepoLock(cloneDir(parsed), () => ensureCommit(repo, parsed, commit))
      const already = recallTree(key)
      if (already) return already
      // `-t` puts the directories in the listing: the API's recursive tree
      // returns them as `type: 'tree'`, and the scanners read that.
      //
      // What is deliberately NOT here is `-l`. `ls-tree --long` prints each
      // blob's size, and a blob's size is only knowable from the blob — so in
      // a `blob:none` clone git lazily fetches every file in the repository,
      // one round trip each, to print a column. Measured against
      // anthropics/claude-plugins-official: 3 minutes 31 seconds with `-l`,
      // 17 milliseconds without. Nothing in git's protocol offers a size
      // without the bytes, so the git transport lists sizeless blobs and the
      // API transport keeps its sizes. Only the file-list display reads
      // `size`; every scan decision is made from paths, modes and SHAs.
      //
      // Local, and it stays local: every object it names is already here, and
      // GIT_NO_LAZY_FETCH makes sure a damaged clone says so instead of pulling
      // the repository down one tree at a time.
      const { stdout } = await runLocal(
        ['ls-tree', '-r', '-t', '-z', commit],
        dir,
        `Listing ${repo} at ${commit.slice(0, 7)}`,
      )
      const entries = parseListing(repo, stdout)
      rememberTree(key, entries)
      await touchGitRepoCache(dir)
      return entries
    },

    async readFile(repo: string, sha: string, path: string): Promise<Buffer | null> {
      const parsed = parse(repo)
      const commit = checkedSha(repo, sha)
      // A newline is refused as well as a NUL: `--batch-check` below takes one
      // request per LINE, so a path with a newline in it would be asked as two
      // and answered "missing" — a wrong answer where an error is honest.
      if (path.length === 0 || /[\0\r\n]/.test(path) || path.startsWith('/')) {
        throw new GitRepoReadError('unreadable', `"${path}" is not a path in ${repo}.`)
      }
      const dir = await withRepoLock(cloneDir(parsed), () => ensureCommit(repo, parsed, commit))
      const target = `${commit}:${path}`
      const what = `Reading ${path} from ${repo}`
      // One `--batch-check` answers all three questions at once: is the path
      // there, is it a file, and how big is it. `cat-file -s` answered only the
      // last, which is why a request for a DIRECTORY used to come back as the
      // bytes of its listing. It is a network command because in a `blob:none`
      // clone this is what pulls the blob in from the promisor — so unlike the
      // API reader's `content-length` the size refusal lands after git has the
      // bytes; git's protocol has no way to ask a size without asking for the
      // object.
      let checked: GitRunResult
      try {
        checked = await runNetwork(parsed, ['cat-file', '--batch-check'], dir, what, `${target}\n`)
      } catch (error) {
        // A path that is not in this tree is an answer, not a failure — the
        // scanners ask for files they are not sure exist. A promisor fetch that
        // FAILED wears the same words, and is a failure.
        if (error instanceof GitRepoReadError && isMissingPath(error.stderr, error.message)) return null
        throw error
      }
      const line = firstLine(checked.stdout.toString('utf8'))
      if (line.endsWith(' missing') || line === '') return null
      const match = BATCH_CHECK_OK.exec(line)
      if (!match) {
        throw new GitRepoReadError('unreadable', `${what} failed. git answered "${line}".`, checked.stderr)
      }
      const [, oid, type, size] = match
      if (type !== 'blob') {
        throw new GitRepoReadError('unreadable', `"${path}" in ${repo} is a ${type}, not a file.`)
      }
      const bytes = Number.parseInt(size, 10)
      if (Number.isFinite(bytes) && bytes > DEFAULT_SKILL_MAX_FILE_BYTES) {
        throw new GitRepoReadError(
          'unreadable',
          `A file in this repository is larger than ${DEFAULT_SKILL_MAX_FILE_BYTES} bytes.`,
        )
      }
      // By the object id, so this reads the blob `--batch-check` just measured
      // and cannot land on a different path. The blob is local by now, but the
      // call keeps the network settings anyway: it is the same object store and
      // the same promisor, and one of them being reachable is the read working.
      const { stdout } = await runNetwork(parsed, ['cat-file', '-p', oid], dir, what)
      await touchGitRepoCache(dir)
      return stdout
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// git says one of these when the rev exists but the path in it does not.
const MISSING_PATH = /does not exist in|exists on disk, but not in|not a valid object name|unknown revision or path/i
// …and says the FIRST of them when a promisor fetch failed on the way to
// answering, which is not "there is no such path" at all. A read that says both
// is a failed read: the file may well be there and we simply could not get it.
const FETCH_FAILED = /promisor|could not read from remote|unable to access|connection|resolve host/i

function isMissingPath(stderr: string, message: string): boolean {
  const text = `${stderr}\n${message}`
  return MISSING_PATH.test(text) && !FETCH_FAILED.test(text)
}
