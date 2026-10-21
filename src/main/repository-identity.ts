import { getGitRepoRoot } from './git'
import { runGit } from './git-utils'
import {
  parseRemoteFetchUrls,
  pickPrimaryRemote,
  repositoryIdentityFromRemote,
  type RepositoryIdentity,
  type RepositoryIdentityRead,
} from '../shared/repository-identity'

// The main-side half of one-project-across-machines: which
// repository a folder is a clone of, as its primary remote names it.
//
// Read on demand and cached briefly, because the two readers — the sidebar's
// grouping and the gateway's `workspace.list` projection — both ask about
// every workspace folder at once, and a remote URL changes about never.
// Not a watcher: a person who edits `.git/config` sees the new identity on
// the next read after the hold lapses, which is soon enough for a grouping.

const HOLD_MS = 60_000
// A folder on a spun-down volume must not hang every `workspace.list` behind
// it: past this, the identity is "not known" and cached as such for the hold.
const READ_TIMEOUT_MS = 3_000
// A read that did not complete (timed out, git threw) is not "no remote":
// it is retried after a short pause rather than held for the full minute.
const RETRY_AFTER_FAILURE_MS = 10_000

// The cache keeps `settled` beside the identity, because a caller within the
// retry window must be told the same thing the read said: an unsettled null
// cached for ten seconds is still "could not ask", not "no remote".
type Held = { at: number; read: RepositoryIdentityRead }
const held = new Map<string, Held>()
const inFlight = new Map<string, Promise<RepositoryIdentityRead>>()

function keyOf(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/** The git calls the read makes, injectable so the outcomes can be tested. */
export type RepositoryIdentityReaders = {
  readRepoRoot: (folderPath: string) => Promise<string | null>
  readRemotes: (repoRoot: string) => Promise<string>
}

// A bare repository has no work tree, so `--show-toplevel` refuses it — both a
// bare clone and a container folder whose `.git` file points at `./.bare`, the
// layout people keep several worktrees under. Such a folder is still a clone of
// its remote and should group with that project's checkouts; `remote -v` reads
// fine from the folder itself, so the folder stands in as its root.
async function readBareRepoRoot(folderPath: string): Promise<string | null> {
  try {
    const stdout = await runGit(folderPath, ['rev-parse', '--is-bare-repository'])
    return stdout.trim() === 'true' ? folderPath : null
  } catch {
    return null
  }
}

const defaultReaders: RepositoryIdentityReaders = {
  readRepoRoot: async (folderPath) => (await getGitRepoRoot(folderPath)) ?? (await readBareRepoRoot(folderPath)),
  readRemotes: (repoRoot) => runGit(repoRoot, ['remote', '-v']),
}

/**
 * What a read of this folder's identity answers: the repository, and whether
 * the question was actually ANSWERED.
 *
 * Never throws. `{ identity: null, settled: true }` is a real answer — not a
 * repository, or one with no remote — while `settled: false` is "could not
 * ask": the read timed out on a spun-down volume, or git threw. Grouping treats
 * the two alike (either way the folder groups by its path), but anything that
 * WRITES an answer down must wait for `settled`; see `RepositoryIdentityRead`.
 */
export async function readRepositoryIdentityRead(
  folderPath: string,
  options: { now?: () => number; readers?: RepositoryIdentityReaders } = {},
): Promise<RepositoryIdentityRead> {
  const trimmed = folderPath.trim()
  // An empty path is not a folder anyone can ask about, and saying so is an
  // answer rather than a failure to reach one.
  if (!trimmed) return { identity: null, settled: true }
  const key = keyOf(trimmed)
  const now = options.now ?? Date.now
  const readers = options.readers ?? defaultReaders
  const cached = held.get(key)
  if (cached && now() - cached.at < HOLD_MS) return cached.read
  const pending = inFlight.get(key)
  if (pending) return pending
  const TIMED_OUT = Symbol('timed-out')
  const read = (async (): Promise<RepositoryIdentityRead> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      const answer = await Promise.race([
        (async () => {
          const root = await readers.readRepoRoot(trimmed)
          if (!root) return null
          const stdout = await readers.readRemotes(root)
          const primary = pickPrimaryRemote(parseRemoteFetchUrls(stdout))
          return primary ? repositoryIdentityFromRemote(primary.remoteUrl) : null
        })(),
        timeout,
      ])
      return answer === TIMED_OUT ? { identity: null, settled: false } : { identity: answer, settled: true }
    } catch {
      return { identity: null, settled: false }
    } finally {
      if (timer) clearTimeout(timer)
    }
  })()
  inFlight.set(key, read)
  try {
    const outcome = await read
    // A read that did not settle is dated into the past, so the hold lapses in
    // RETRY_AFTER_FAILURE_MS instead of a full minute and the next ask really
    // asks. The unsettled answer is still cached for that window: a hundred
    // folders on one sleeping volume must not each spend three seconds again.
    held.set(key, {
      at: outcome.settled ? now() : now() - HOLD_MS + RETRY_AFTER_FAILURE_MS,
      read: outcome,
    })
    return outcome
  } finally {
    inFlight.delete(key)
  }
}

/**
 * The repository a folder belongs to, or null: not a repository, no remote,
 * or git unavailable. Never throws — an identity that cannot be read is an
 * absent identity, and the folder groups by its path as it always has.
 *
 * The narrow form, for the readers that only group: the gateway's
 * `workspace.list` projection files a remote workspace under a repository or
 * under nothing, and has no use for the difference between "no remote" and
 * "could not ask". Anything that persists a decision wants
 * `readRepositoryIdentityRead` instead.
 */
export async function readRepositoryIdentity(
  folderPath: string,
  options: { now?: () => number; readers?: RepositoryIdentityReaders } = {},
): Promise<RepositoryIdentity | null> {
  return (await readRepositoryIdentityRead(folderPath, options)).identity
}
