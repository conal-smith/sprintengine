// The missing primitive: the pull requests on a branch, and a pull request's
// state (epic `pull-request-marks`, decisions 3, 8a, 8c, 9). Nothing else in the
// app could resolve a branch to a pull request number — the whole review system
// is URL-keyed — and nothing read `isDraft` or `mergedAt` at all.
//
// THROUGH `gh`, NEVER REST (decision 11). One runner, `main/github/gh.ts`: gh's
// own credential store is the single auth source, and GitHub Enterprise Server
// comes free because the checkout's remote decides which host is asked.
//
// TWO DIFFERENT ANSWERS. "This branch has no pull request" and "I could not ask"
// are not the same fact and this module never conflates them: a read either
// SETTLES (and its list, empty or not, is the truth) or it does not (and every
// caller must leave what it already knew alone). `repository-identity.ts` set
// this precedent for repository remotes; a mark that flickered off because a
// laptop was offline for one probe would be worse than no mark at all.
//
// NO GIT-ANCESTRY FALLBACK, EVER (decision 8c). It is tempting to answer "is it
// merged?" with `git merge-base --is-ancestor`, and it is wrong: a rebase, a
// force push or a squash merge leaves none of the branch's commits on main, so
// the check would call a landed pull request open for ever. State comes from
// GitHub or stays as last read. That is the whole rule.
//
// FORKS. `gh pr list --head` matches on BRANCH NAME only — it is not
// owner-qualified — so a pull request opened from a fork whose branch shares the
// name is indistinguishable from one opened on the origin repository. We do not
// attempt an owner-qualified head (it would need the fork's owner, which the
// local checkout does not know for a branch it did not push). For the sidebar's
// purpose — "this conversation's branch has these pull requests" — the branch
// name is the key the person is thinking in.

import { pullRequestRepository, type BranchPullRequest, type PullRequestState } from '../../shared/git/pull-request'
import { canonicalPullRequestUrl, parsePullRequestUrl } from '../../shared/git/pr-url'
import { isRecord } from '../../shared/records'
import { sharedGhRunner, type GhRunner } from './gh'

/** Why a read could not be made. Never a statement about the pull requests themselves. */
export type PullRequestReadFailure =
  /** The `gh` binary is not installed (the runner's `found: false`). */
  | 'gh-missing'
  /** `gh` ran and failed: not authenticated, no remote, rate limited, offline. */
  | 'gh-failed'
  /** `gh` answered with something that is not the JSON we asked for. */
  | 'bad-output'
  /** The question itself was unaskable: an empty/flag-shaped branch, an unparseable URL. */
  | 'bad-request'
  /** `gh` did not answer inside {@link GH_READ_TIMEOUT_MS}. */
  | 'timeout'
  /**
   * GitHub said to slow down: the API rate limit (or its secondary limit) is
   * spent. A wait, not a fault, so a watch that counts its failed reads does
   * not count this one.
   */
  | 'rate-limited'

export type BranchPullRequestsRead =
  { settled: true; pullRequests: BranchPullRequest[] } | { settled: false; reason: PullRequestReadFailure }

/**
 * What a state re-read learned. `stateAt` is the moment GitHub was asked, and
 * `headRefName` is the branch the pull request is FROM — the only way a pull
 * request the record knows by its URL alone (an agent opened it, and the
 * record heard the URL) learns which branch it belongs to (decision 10). Null
 * when GitHub did not say.
 */
export type PullRequestStateRead =
  | {
      settled: true
      state: PullRequestState
      isDraft: boolean
      stateAt: number
      headRefName: string | null
      /**
       * The pull request's title and the moment GitHub says it was opened. A
       * pull request recorded from the URL an agent's call printed knows
       * neither, and this read is what names it (decision 10). Null when
       * GitHub did not say.
       */
      title?: string | null
      openedAt?: number | null
      number?: number | null
      /** When it merged or closed; absent while open, or when GitHub did not say. */
      endedAt?: number
    }
  | { settled: false; reason: PullRequestReadFailure }

/**
 * How long one `gh` call may take before the read is "could not ask". The child
 * is KILLED at the bound (the runner passes it to `execFile`'s own
 * timeout/killSignal), so a hover behind a laptop that is off the network
 * neither hangs nor leaves a `gh` — or a whole `$SHELL -ilc` — running behind
 * it. Generous, because a cold `gh` on a large repository is genuinely slow and
 * a needless unsettled answer costs a retry.
 */
export const GH_READ_TIMEOUT_MS = 15_000

export type BranchPullRequestDeps = {
  gh?: GhRunner
  now?: () => number
  timeoutMs?: number
}

/** The fields the list read asks `gh` for — one place, so the parser cannot drift from the query. */
const LIST_FIELDS = 'number,url,title,state,isDraft,createdAt,mergedAt,closedAt,headRefOid'
// `title` and `createdAt` are here for a pull request the record knows by its
// URL alone (an agent's call printed it): every menu row, the peek's bold
// title line and the spoken label would read empty without them (decision 10).
const VIEW_FIELDS = 'number,title,state,isDraft,createdAt,mergedAt,closedAt,headRefName'

/**
 * Every pull request whose head is `branch`, as GitHub knows them — open, merged
 * and closed alike (decision 6 keeps the earlier ones; nothing is dropped).
 * Run inside `gitRoot`, so the remote of THAT checkout picks the host and repo:
 * a linked worktree answers for its own repository without being told which.
 */
export async function listBranchPullRequests(
  input: { gitRoot: string; branch: string },
  deps: BranchPullRequestDeps = {},
): Promise<BranchPullRequestsRead> {
  const gitRoot = input.gitRoot?.trim()
  const branch = input.branch?.trim()
  // A leading dash would be read by `gh` as a flag, and an empty branch would
  // list the whole repository's pull requests. Neither is a question we asked.
  if (!gitRoot || !branch || branch.startsWith('-')) return { settled: false, reason: 'bad-request' }

  const result = await runGh(
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', LIST_FIELDS],
    { cwd: gitRoot },
    deps,
  )
  if (!result.ok) return { settled: false, reason: result.reason }

  const rows = parseJsonDocument(result.stdout)
  if (!Array.isArray(rows)) return { settled: false, reason: 'bad-output' }

  const now = (deps.now ?? Date.now)()
  const pullRequests: BranchPullRequest[] = []
  for (const row of rows) {
    const pullRequest = toBranchPullRequest(row, now)
    // A row we cannot key (no parseable URL) or cannot state (an unknown state
    // word) is skipped rather than guessed at. The read still settled: the rows
    // we DID understand are the truth about this branch.
    if (pullRequest) pullRequests.push(pullRequest)
  }
  pullRequests.sort((a, b) => b.openedAt - a.openedAt || b.number - a.number)
  return { settled: true, pullRequests }
}

/**
 * One pull request's state, by URL. The refresh path: the watch calls it on its
 * backoff, hover calls it when the reading has gone stale. Unsettled leaves the
 * caller's last reading standing (decision 3).
 */
export async function readPullRequestState(
  url: string,
  deps: BranchPullRequestDeps = {},
): Promise<PullRequestStateRead> {
  const parsed = parsePullRequestUrl(url?.trim() ?? '')
  // Not a pull request URL we can name — including a Bitbucket one, which `gh`
  // could not answer for either. Unsettled, so nothing recorded is overwritten.
  if (!parsed || 'unsupported' in parsed) return { settled: false, reason: 'bad-request' }

  const result = await runGh(['pr', 'view', canonicalPullRequestUrl(parsed), '--json', VIEW_FIELDS], {}, deps)
  if (!result.ok) return { settled: false, reason: result.reason }

  const json = parseJsonDocument(result.stdout)
  if (!isRecord(json)) return { settled: false, reason: 'bad-output' }
  const state = readState(json)
  if (!state) return { settled: false, reason: 'bad-output' }
  const title = typeof json.title === 'string' && json.title.length > 0 ? json.title : null
  return {
    settled: true,
    state,
    isDraft: json.isDraft === true && state === 'open',
    stateAt: (deps.now ?? Date.now)(),
    headRefName: typeof json.headRefName === 'string' && json.headRefName.length > 0 ? json.headRefName : null,
    title,
    openedAt: parseTimestamp(json.createdAt),
    number: typeof json.number === 'number' && Number.isInteger(json.number) && json.number > 0 ? json.number : null,
    ...optionalEndedAt(readEndedAt(json, state)),
  }
}

export type GhOutcome = { ok: true; stdout: string } | { ok: false; reason: PullRequestReadFailure; stderr?: string }

/** What `gh` prints on stderr when GitHub's API rate limit, or its secondary limit, refused a call. */
const RATE_LIMITED = /\brate limit|\bAPI rate\b|abuse detection/i

/**
 * One `gh` call, bounded, answered as "here is what it printed" or "it could
 * not be asked, and why". Shared with the watch's read
 * (`pull-request-watch-read.ts`), so both say the same about the same failure.
 */
export async function runGh(
  args: string[],
  options: { cwd?: string },
  deps: BranchPullRequestDeps,
): Promise<GhOutcome> {
  const gh = deps.gh ?? sharedGhRunner()
  const timeoutMs = deps.timeoutMs ?? GH_READ_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const TIMED_OUT = Symbol('timed-out')
  try {
    // The bound is handed to the runner, which kills the child with it. The race
    // below stays as the backstop for a runner that ignores it (a test's fake,
    // an injected one) — stopping waiting is the weaker half of the guarantee.
    const raced = await Promise.race([
      gh.run(args, { ...options, timeoutMs }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (raced === TIMED_OUT) return { ok: false, reason: 'timeout' }
    if (!raced.found) return { ok: false, reason: 'gh-missing' }
    // A killed child is a read that did not happen, never an empty answer.
    if (raced.timedOut) return { ok: false, reason: 'timeout' }
    // `gh pr list` exits 0 with `[]` for a branch with no pull requests, so a
    // non-zero exit is always a failure to ask — never "there are none".
    if (raced.code !== 0)
      return { ok: false, reason: RATE_LIMITED.test(raced.stderr) ? 'rate-limited' : 'gh-failed', stderr: raced.stderr }
    return { ok: true, stdout: raced.stdout }
  } catch {
    // The runner does not throw, but a caller-supplied one might: an exception
    // is a read that did not happen, not an empty list.
    return { ok: false, reason: 'gh-failed' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The JSON document in `gh`'s stdout — which is not always ALL of it. The
 * runner used to reach a Homebrew or nvm `gh` through `$SHELL -ilc 'gh …'`,
 * and an interactive login shell prints whatever the user's rc files print
 * ("Now using node v22.…") on the same stdout; a `gh` wrapper script or an
 * injected runner can still do the same, and feeding that to `JSON.parse`
 * made every read permanently 'bad-output'.
 *
 * So: the whole output first (the direct-spawn case, unchanged), then the first
 * `[`- or `{`-anchored document that parses, matched to its own closing bracket
 * with strings and escapes respected, and finally the last line that parses on
 * its own. Only an array or an object is ever returned — a banner line that
 * happens to be a bare number is not the answer we asked for.
 */
export function parseJsonDocument(stdout: string): unknown {
  const whole = parseJsonValue(stdout)
  if (whole !== undefined) return whole
  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]
    if (char !== '[' && char !== '{') continue
    const end = matchingBracket(stdout, index)
    if (end === -1) continue
    const parsed = parseJsonValue(stdout.slice(index, end + 1))
    if (parsed !== undefined) return parsed
  }
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonValue(lines[index])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function parseJsonValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    // `gh --json` answers with an array or an object and nothing else.
    return Array.isArray(parsed) || isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The index of the bracket closing the one at `start`, or -1. Strings and their escapes are skipped. */
function matchingBracket(text: string, start: number): number {
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * `gh`'s row → the app's shape. `state` is GitHub's own word; a draft is an OPEN
 * pull request with `isDraft` set and never a fourth state (decision 1).
 * `mergedAt` wins over the state word: a merged pull request is closed too, and
 * some GitHub payloads say so in that order.
 */
function toBranchPullRequest(row: unknown, now: number): BranchPullRequest | null {
  if (!isRecord(row)) return null
  const parsed = typeof row.url === 'string' ? parsePullRequestUrl(row.url) : null
  if (!parsed || 'unsupported' in parsed) return null
  const state = readState(row)
  if (!state) return null
  const number =
    typeof row.number === 'number' && Number.isInteger(row.number) && row.number > 0 ? row.number : parsed.number
  const repository = pullRequestRepository(row.url as string)
  if (!repository) return null
  return {
    // GHES hosts pass through untouched: the canonical form only strips the
    // paste's incidental cruft, it never rewrites the host.
    url: canonicalPullRequestUrl(parsed),
    // The repository the pull request is in, keyed the way every clone of it is.
    repoKey: repository.repoKey,
    repoName: repository.repoName,
    number,
    title: typeof row.title === 'string' ? row.title : '',
    state,
    isDraft: row.isDraft === true && state === 'open',
    openedAt: parseTimestamp(row.createdAt) ?? 0,
    stateAt: now,
    ...optionalEndedAt(readEndedAt(row, state)),
    // The commit the head was at: what a merged pull request carried, so the
    // chat's "Create PR" can tell new work from work already landed.
    ...(typeof row.headRefOid === 'string' && /^[0-9a-f]{7,64}$/i.test(row.headRefOid)
      ? { headRefOid: row.headRefOid }
      : {}),
  }
}

/** When a pull request that is no longer open ended: its merge, else its close. */
export function readEndedAt(row: Record<string, unknown>, state: PullRequestState): number | null {
  if (state === 'open') return null
  return (state === 'merged' ? parseTimestamp(row.mergedAt) : null) ?? parseTimestamp(row.closedAt)
}

function optionalEndedAt(endedAt: number | null): { endedAt?: number } {
  return endedAt === null ? {} : { endedAt }
}

export function readState(row: Record<string, unknown>): PullRequestState | null {
  if (parseTimestamp(row.mergedAt) !== null) return 'merged'
  const raw = typeof row.state === 'string' ? row.state.toUpperCase() : ''
  if (raw === 'MERGED') return 'merged'
  if (raw === 'CLOSED') return 'closed'
  if (raw === 'OPEN') return 'open'
  // A state word we do not recognise is not a state we may write down.
  return null
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}
