// What a watched pull request looks like on GitHub right now: its state, its
// head, every check on that head, the reviews and comments on it, and whether
// it can merge. The watch (`src/server/pull-requests/pull-request-watch.ts`)
// compares one of these with what the agent was last told, and wakes the chat
// when something needs it.
//
// THROUGH `gh`, like every GitHub read the app makes (`gh.ts`). Two calls:
//
// - `gh pr view <url> --json …` for the pull request itself. The fields are
//   the ones `gh pr view --json` lists (gh 2.x); it answers the state read
//   too, so a watched pull request costs one view per probe, not two.
// - which checks the base branch requires. `statusCheckRollup` does not say,
//   and without it an advisory check that never finishes (a review bot) would
//   hold "all checks passed" back for ever. Given a `requiredChecks` reader,
//   the record's, it is asked first: conditional REST reads of the base
//   branch's protection and rulesets, kept per repository and base, which
//   cost no quota while the branch has not moved (`github-conditional.ts`).
//   Without one, or when it could not say, `gh pr checks <url> --required
//   --json …` answers. gh answers a branch with no required checks with an
//   error saying so, which is read as "none required"; any other failure
//   leaves it unknown, and the watch then waits on every check.
//
// A review left only as comments on lines has an empty body in `gh pr view`,
// which does not list those comments, so it would reach the agent as "X
// reviewed it" and nothing more. For such a review, written since the watch
// began and not cached yet, a third call (`gh api graphql`) reads its line
// comments: at most {@link MAX_INLINE_REVIEWS_PER_READ} reviews per read, each
// read once per run (`inlineCache`), so a long review conversation does not
// turn every probe into several calls.
//
// Nothing is guessed: a read that could not be made is unsettled, with the
// reason, and the caller leaves what it knew alone (`branch-pull-request.ts`
// sets that rule). A rate limit is its own reason, because it is a wait and
// not a fault.

import { canonicalPullRequestUrl, parsePullRequestUrl } from '../../shared/git/pr-url'
import type { PullRequestState } from '../../shared/git/pull-request'
import { isRecord } from '../../shared/records'
import type { RequiredChecksReader } from './github-conditional'
import {
  parseJsonDocument,
  parseTimestamp,
  readEndedAt,
  readState,
  runGh,
  type BranchPullRequestDeps,
  type GhOutcome,
  type PullRequestReadFailure,
} from './branch-pull-request'

/** The fields the watch asks `gh pr view` for — one place, so the parser cannot drift from the query. */
export const WATCH_VIEW_FIELDS = [
  'number',
  'url',
  'title',
  'state',
  'isDraft',
  'createdAt',
  'mergedAt',
  'closedAt',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'author',
  'statusCheckRollup',
  'reviewDecision',
  'reviews',
  'latestReviews',
  'comments',
  'mergeStateStatus',
  'mergeable',
  'autoMergeRequest',
].join(',')

const REQUIRED_CHECK_FIELDS = 'name,workflow'

/** The most inline-only reviews one read asks about; the rest wait for the next probe. */
export const MAX_INLINE_REVIEWS_PER_READ = 5
/** The line comments read per review, and the most text kept from them. */
const INLINE_COMMENTS_PER_REVIEW = 10
const MAX_INLINE_CHARS = 4000
/** The most reviews an inline cache remembers; the oldest go first. */
export const MAX_INLINE_CACHE_ENTRIES = 500

/** One check on the head, its runs folded into one (see `foldCheckRuns`). */
export type WatchedCheck = {
  name: string
  /** The workflow it runs in; empty for a commit status, which has none. */
  workflow: string
  status: 'pending' | 'passed' | 'failed'
  /** GitHub's own word for how it ended (`FAILURE`, `TIMED_OUT`, …), or its status while it runs. */
  outcome: string
  url: string | null
}

/** A comment or a review on the pull request, by anyone. */
export type WatchedRemark = {
  id: string
  kind: 'comment' | 'review'
  author: string
  body: string
  /** A review's verdict; absent on a comment. */
  verdict?: 'approved' | 'changes-requested' | 'commented'
  url: string | null
  /** When it was written, ms epoch; 0 when GitHub did not say. */
  at: number
  /** The account `gh` is signed in as wrote it: the agent itself. */
  own: boolean
  /**
   * A review's comments on lines, `path:line: text` each, for a review whose
   * own body is empty. Kept apart from `body`, so what counts as an edit is
   * unchanged by whether they could be read.
   */
  inline?: string
}

/** What a read may do beyond the pull request view. Absent, it reads no line comments. */
export type PullRequestWatchReadOptions = {
  /** Only reviews written after this (ms epoch) are worth their line comments: older ones are never news. */
  inlineSince?: number
  /** Review id → its line comments, read once per run and shared across reads. */
  inlineCache?: Map<string, string>
  /** Which checks a base branch requires, asked before `gh pr checks`; see the header. */
  requiredChecks?: RequiredChecksReader
}

export type PullRequestWatchRead =
  | {
      settled: true
      state: PullRequestState
      isDraft: boolean
      stateAt: number
      headRefName: string | null
      title: string | null
      openedAt: number | null
      number: number | null
      endedAt?: number
      headSha: string | null
      baseRefName: string | null
      /** Who opened it: the account the agent's own replies come from. */
      author: string | null
      checks: WatchedCheck[]
      /** The checks the base branch requires, by `workflow\0name`; [] for none; null when that could not be read. */
      requiredChecks: string[] | null
      reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null
      remarks: WatchedRemark[]
      /** GitHub's `mergeStateStatus`, lower-cased: `behind`, `dirty`, `blocked`, `clean`, `unstable`, … */
      mergeState: string
      mergeable: 'mergeable' | 'conflicting' | 'unknown'
      autoMerge: boolean
    }
  | { settled: false; reason: PullRequestReadFailure }

/** The key a check is known by across reads: its workflow and its name. */
export function checkKey(check: Pick<WatchedCheck, 'workflow' | 'name'>): string {
  return `${check.workflow}\0${check.name}`
}

/** One read of a watched pull request, by URL. */
export async function readPullRequestWatch(
  url: string,
  deps: BranchPullRequestDeps = {},
  options: PullRequestWatchReadOptions = {},
): Promise<PullRequestWatchRead> {
  const parsed = parsePullRequestUrl(url?.trim() ?? '')
  if (!parsed || 'unsupported' in parsed) return { settled: false, reason: 'bad-request' }
  const target = canonicalPullRequestUrl(parsed)

  const viewed = await runGh(['pr', 'view', target, '--json', WATCH_VIEW_FIELDS], {}, deps)
  if (!viewed.ok) return { settled: false, reason: viewed.reason }
  const json = parseJsonDocument(viewed.stdout)
  if (!isRecord(json)) return { settled: false, reason: 'bad-output' }
  const read = parseWatchView(json, (deps.now ?? Date.now)())
  if (!read.settled) return read
  // Which checks are required is only worth asking while there are checks, and
  // only for an open pull request.
  if (read.state === 'open' && read.checks.length > 0) {
    const names =
      options.requiredChecks && read.baseRefName
        ? await options.requiredChecks.read(
            {
              host: parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host,
              owner: parsed.owner,
              repo: parsed.repo,
              base: read.baseRefName,
            },
            deps,
          )
        : null
    if (names) {
      // A required check is named by its context alone: every check on the
      // head by that name is one of them, whichever workflow runs it.
      read.requiredChecks = read.checks.filter((check) => names.has(check.name)).map(checkKey)
    } else {
      const required = await runGh(['pr', 'checks', target, '--required', '--json', REQUIRED_CHECK_FIELDS], {}, deps)
      read.requiredChecks = parseRequiredChecks(required)
    }
  }
  if (options.inlineCache) await fillInlineComments(read.remarks, parsed.host, options.inlineCache, options, deps)
  return read
}

const REVIEW_NODE_ID = /^[A-Za-z0-9_-]{1,100}$/

/**
 * Line comments for the inline-only reviews among `remarks`, from the cache or
 * one bounded GraphQL call. A call that fails leaves those reviews as they
 * were (and uncached, so the next read asks again).
 */
async function fillInlineComments(
  remarks: WatchedRemark[],
  host: string,
  cache: Map<string, string>,
  options: PullRequestWatchReadOptions,
  deps: BranchPullRequestDeps,
): Promise<void> {
  const since = options.inlineSince ?? 0
  const wanted = remarks.filter(
    (remark) => remark.kind === 'review' && !remark.own && remark.body.trim() === '' && REVIEW_NODE_ID.test(remark.id),
  )
  const ask = wanted
    .filter((remark) => !cache.has(remark.id) && remark.at > since)
    .slice(0, MAX_INLINE_REVIEWS_PER_READ)
  if (ask.length > 0) {
    const query = `query{nodes(ids:[${ask.map((remark) => JSON.stringify(remark.id)).join(',')}]){... on PullRequestReview{id comments(first:${INLINE_COMMENTS_PER_REVIEW}){nodes{path line originalLine body}}}}}`
    const answered = await runGh(['api', 'graphql', '--hostname', host, '-f', `query=${query}`], {}, deps)
    if (answered.ok) {
      for (const [id, text] of parseInlineComments(parseJsonDocument(answered.stdout))) remember(cache, id, text)
    }
  }
  for (const remark of wanted) {
    const inline = cache.get(remark.id)
    if (inline) remark.inline = inline
  }
}

function remember(cache: Map<string, string>, id: string, text: string): void {
  cache.delete(id)
  cache.set(id, text)
  while (cache.size > MAX_INLINE_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** The GraphQL answer → review id and its line comments as text ('' for a review with none). Exported for the test. */
export function parseInlineComments(json: unknown): Array<[string, string]> {
  if (!isRecord(json) || !isRecord(json.data) || !Array.isArray(json.data.nodes)) return []
  const found: Array<[string, string]> = []
  for (const node of json.data.nodes) {
    if (!isRecord(node)) continue
    const id = nonEmpty(node.id)
    if (!id || !isRecord(node.comments) || !Array.isArray(node.comments.nodes)) continue
    const lines: string[] = []
    for (const comment of node.comments.nodes) {
      if (!isRecord(comment)) continue
      const body = nonEmpty(comment.body)
      if (!body) continue
      const path = nonEmpty(comment.path)
      const line =
        typeof comment.line === 'number'
          ? comment.line
          : typeof comment.originalLine === 'number'
            ? comment.originalLine
            : null
      const where = path ? `${path}${line === null ? '' : `:${line}`}: ` : ''
      lines.push(`${where}${body}`)
    }
    found.push([id, lines.join('\n').slice(0, MAX_INLINE_CHARS)])
  }
  return found
}

/** `gh pr view --json` → the watch's read. Exported for the fixture test. */
export function parseWatchView(json: Record<string, unknown>, now: number): PullRequestWatchRead {
  const state = readState(json)
  if (!state) return { settled: false, reason: 'bad-output' }
  const author = loginOf(json.author)
  const endedAt = readEndedAt(json, state)
  return {
    settled: true,
    state,
    isDraft: json.isDraft === true && state === 'open',
    stateAt: now,
    headRefName: nonEmpty(json.headRefName),
    title: nonEmpty(json.title),
    openedAt: parseTimestamp(json.createdAt),
    number: typeof json.number === 'number' && Number.isInteger(json.number) && json.number > 0 ? json.number : null,
    ...(endedAt === null ? {} : { endedAt }),
    headSha: typeof json.headRefOid === 'string' && /^[0-9a-f]{7,64}$/i.test(json.headRefOid) ? json.headRefOid : null,
    baseRefName: nonEmpty(json.baseRefName),
    author,
    checks: foldCheckRuns(Array.isArray(json.statusCheckRollup) ? json.statusCheckRollup : []),
    requiredChecks: null,
    reviewDecision: readReviewDecision(json.reviewDecision),
    remarks: readRemarks(json, author),
    mergeState: typeof json.mergeStateStatus === 'string' ? json.mergeStateStatus.toLowerCase() : 'unknown',
    mergeable:
      json.mergeable === 'MERGEABLE' ? 'mergeable' : json.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    autoMerge: isRecord(json.autoMergeRequest),
  }
}

/**
 * gh's answer about required checks: their keys, `[]` when the branch
 * requires none (gh says so as an error), null when it could not be read.
 */
function parseRequiredChecks(outcome: GhOutcome): string[] | null {
  if (!outcome.ok) return /no required checks/i.test(outcome.stderr ?? '') ? [] : null
  const rows = parseJsonDocument(outcome.stdout)
  if (!Array.isArray(rows)) return null
  const keys: string[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const name = nonEmpty(row.name)
    if (name) keys.push(checkKey({ name, workflow: nonEmpty(row.workflow) ?? '' }))
  }
  return keys
}

/** A run that has not finished sorts after every one that has: see `foldCheckRuns`. */
const STILL_RUNNING = Number.MAX_SAFE_INTEGER

/**
 * The rollup's runs, one check each. A check can appear more than once on one
 * head: a workflow that runs on both `push` and `pull_request`, or a rerun.
 * A run still going outranks any finished run of the same check, so a check
 * whose first run passed is not "passed" while its second run is still going;
 * between finished runs, the latest wins.
 */
function foldCheckRuns(rollup: unknown[]): WatchedCheck[] {
  const folded = new Map<string, { check: WatchedCheck; at: number }>()
  for (const raw of rollup) {
    if (!isRecord(raw)) continue
    const check = readCheck(raw)
    if (!check) continue
    const at =
      check.status === 'pending'
        ? STILL_RUNNING
        : (parseTimestamp(raw.completedAt) ?? parseTimestamp(raw.startedAt) ?? parseTimestamp(raw.createdAt) ?? 0)
    const key = checkKey(check)
    const known = folded.get(key)
    if (!known || at >= known.at) folded.set(key, { check, at })
  }
  return [...folded.values()].map((entry) => entry.check)
}

const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
// A finished run that needs someone (`ACTION_REQUIRED`) or never got going
// (`STARTUP_FAILURE`, `STALE`) is not green, and the agent hears about it.
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])

function readCheck(raw: Record<string, unknown>): WatchedCheck | null {
  if (raw.__typename === 'StatusContext' || (typeof raw.context === 'string' && raw.name === undefined)) {
    const name = nonEmpty(raw.context)
    if (!name) return null
    const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : ''
    return {
      name,
      workflow: '',
      status: state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'pending',
      outcome: state || 'PENDING',
      url: nonEmpty(raw.targetUrl),
    }
  }
  const name = nonEmpty(raw.name)
  if (!name) return null
  const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : ''
  const conclusion = typeof raw.conclusion === 'string' ? raw.conclusion.toUpperCase() : ''
  const finished = status === 'COMPLETED' && conclusion !== ''
  return {
    name,
    workflow: nonEmpty(raw.workflowName) ?? '',
    status: !finished
      ? 'pending'
      : PASSED_CONCLUSIONS.has(conclusion)
        ? 'passed'
        : FAILED_CONCLUSIONS.has(conclusion)
          ? 'failed'
          : 'pending',
    outcome: finished ? conclusion : status || 'QUEUED',
    url: nonEmpty(raw.detailsUrl),
  }
}

function readReviewDecision(value: unknown): Extract<PullRequestWatchRead, { settled: true }>['reviewDecision'] {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes-requested'
  if (value === 'REVIEW_REQUIRED') return 'review-required'
  return null
}

/**
 * Every comment and review, once each. `reviews` and `latestReviews` overlap
 * (the second is each reviewer's latest, and reaches past the first's page),
 * so they are folded by id. A review still pending is its author's draft and
 * not said yet; a dismissed one was taken back.
 */
function readRemarks(json: Record<string, unknown>, author: string | null): WatchedRemark[] {
  const own = (login: string, viewerDidAuthor: unknown) =>
    viewerDidAuthor === true || (author !== null && login.toLowerCase() === author.toLowerCase())
  const prUrl = nonEmpty(json.url)
  const remarks = new Map<string, WatchedRemark>()
  for (const raw of Array.isArray(json.comments) ? json.comments : []) {
    if (!isRecord(raw)) continue
    const id = nonEmpty(raw.id)
    if (!id) continue
    const login = loginOf(raw.author) ?? 'someone'
    remarks.set(id, {
      id,
      kind: 'comment',
      author: login,
      body: typeof raw.body === 'string' ? raw.body : '',
      url: nonEmpty(raw.url),
      at: parseTimestamp(raw.createdAt) ?? 0,
      own: own(login, raw.viewerDidAuthor),
    })
  }
  for (const list of [json.reviews, json.latestReviews]) {
    for (const raw of Array.isArray(list) ? list : []) {
      if (!isRecord(raw)) continue
      const id = nonEmpty(raw.id)
      const verdict =
        raw.state === 'APPROVED'
          ? 'approved'
          : raw.state === 'CHANGES_REQUESTED'
            ? 'changes-requested'
            : raw.state === 'COMMENTED'
              ? 'commented'
              : null
      if (!id || !verdict || remarks.has(id)) continue
      const login = loginOf(raw.author) ?? 'someone'
      remarks.set(id, {
        id,
        kind: 'review',
        author: login,
        body: typeof raw.body === 'string' ? raw.body : '',
        verdict,
        // A review carries no link of its own in gh's answer; the pull request's is where it is read.
        url: prUrl,
        at: parseTimestamp(raw.submittedAt) ?? 0,
        own: own(login, raw.viewerDidAuthor),
      })
    }
  }
  return [...remarks.values()].sort((a, b) => a.at - b.at)
}

function loginOf(value: unknown): string | null {
  return isRecord(value) ? nonEmpty(value.login) : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
