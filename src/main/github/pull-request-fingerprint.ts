// The watch's cheap question: has anything about these pull requests changed?
// One `gh api graphql` call asks it of many pull requests at once, each an
// aliased `pullRequest` under its repository's alias, and answers a
// FINGERPRINT per pull request: everything the full read
// (`pull-request-watch-read.ts`) would notice, reduced to what moves when it
// changes.
//
// - state, merged, closed and draft, title, head and base branch, and the
//   head commit;
// - mergeable, the merge state and the review decision, and auto-merge;
// - how many comments, reviews and review threads there are, and when the
//   latest of each was last updated (comments ordered by update, so an edit
//   to an old one moves it; a thread by its last comment and whether it is
//   resolved);
// - the head's check rollup: its state and its counts by state.
//
// The record compares a fingerprint with the last one and reads in full only
// when it moved (`pull-request-record.ts`), so a watched pull request that is
// sitting still costs a share of one call per sweep instead of two or three
// subprocesses of its own.
//
// Its fields include every one the plain state read asks for, named the same,
// so the fingerprint answers that read too (`parseStateView`): a pull request
// nobody asked to have watched needs no second call at all.
//
// The answer carries the GraphQL `rateLimit`, which costs nothing, for the
// quota tracker (`github-quota.ts`).

import { parsePullRequestUrl } from '../../shared/git/pr-url'
import { isRecord } from '../../shared/records'
import {
  parseJsonDocument,
  parseStateView,
  runGh,
  type BranchPullRequestDeps,
  type PullRequestReadFailure,
  type PullRequestStateRead,
} from './branch-pull-request'
import { quotaFromGraphQl, type GitHubQuotaReading } from './github-quota'

/**
 * The most pull requests one query asks about. Each brings at most a hundred
 * or so nodes, so twenty stay far inside GitHub's node limit and a query's
 * cost stays at a point or two, and a host that is slow to answer one is not
 * asked to answer for the whole record in one go.
 */
export const FINGERPRINT_PULL_REQUESTS_PER_QUERY = 20

/** How many of a pull request's latest reviews and review threads the fingerprint looks at. */
const FINGERPRINT_RECENT = 50

const FINGERPRINT_FIELDS = [
  'number title state isDraft createdAt mergedAt closedAt headRefName baseRefName headRefOid',
  'mergeable mergeStateStatus reviewDecision autoMergeRequest{enabledAt}',
  'comments(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{updatedAt}}',
  `reviews(last:${FINGERPRINT_RECENT}){totalCount nodes{state updatedAt}}`,
  `reviewThreads(last:${FINGERPRINT_RECENT}){totalCount nodes{isResolved comments(last:1){totalCount nodes{updatedAt}}}}`,
  'commits(last:1){nodes{commit{oid statusCheckRollup{state contexts{totalCount checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}',
].join(' ')

/** One batch: pull requests on one host, at most {@link FINGERPRINT_PULL_REQUESTS_PER_QUERY}. */
export type FingerprintBatch = { host: string; urls: string[] }

export type PullRequestFingerprint =
  | {
      settled: true
      /** Equal for two answers about a pull request exactly when nothing the watch reads changed. */
      fingerprint: string
      /** The plain state read the same fields answer. */
      state: Extract<PullRequestStateRead, { settled: true }>
    }
  | { settled: false; reason: PullRequestReadFailure }

export type FingerprintBatchRead =
  | {
      settled: true
      /** Per pull request in the batch. One the answer did not cover (gone, no access) is unsettled on its own. */
      pullRequests: Map<string, PullRequestFingerprint>
      quota: GitHubQuotaReading | null
    }
  | { settled: false; reason: PullRequestReadFailure }

/**
 * The URLs as batches: grouped by host (with its port, which `gh --hostname`
 * needs), in order, each at most `size` long. A URL that is not a GitHub pull
 * request is left out.
 */
export function planFingerprintBatches(
  urls: Iterable<string>,
  size = FINGERPRINT_PULL_REQUESTS_PER_QUERY,
): FingerprintBatch[] {
  const byHost = new Map<string, string[]>()
  for (const url of urls) {
    const parsed = parsePullRequestUrl(url)
    if (!parsed || 'unsupported' in parsed) continue
    const host = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host
    const list = byHost.get(host) ?? []
    if (!list.includes(url)) list.push(url)
    byHost.set(host, list)
  }
  const batches: FingerprintBatch[] = []
  for (const [host, list] of byHost) {
    for (let start = 0; start < list.length; start += Math.max(1, size)) {
      batches.push({ host, urls: list.slice(start, start + Math.max(1, size)) })
    }
  }
  return batches
}

/** The query for one batch, and which alias pair answers for which URL. Exported for the test. */
export function buildFingerprintQuery(urls: readonly string[]): {
  query: string
  aliases: Map<string, { repo: string; pullRequest: string }>
} {
  const repos = new Map<string, { owner: string; name: string; alias: string; numbers: Map<number, string> }>()
  const aliases = new Map<string, { repo: string; pullRequest: string }>()
  for (const url of urls) {
    const parsed = parsePullRequestUrl(url)
    if (!parsed || 'unsupported' in parsed) continue
    const repoKey = `${parsed.owner}/${parsed.repo}`.toLowerCase()
    let repo = repos.get(repoKey)
    if (!repo) {
      repo = { owner: parsed.owner, name: parsed.repo, alias: `r${repos.size}`, numbers: new Map() }
      repos.set(repoKey, repo)
    }
    let alias = repo.numbers.get(parsed.number)
    if (!alias) {
      alias = `p${parsed.number}`
      repo.numbers.set(parsed.number, alias)
    }
    aliases.set(url, { repo: repo.alias, pullRequest: alias })
  }
  const selections = [...repos.values()].map(
    (repo) =>
      `${repo.alias}:repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}){${[
        ...repo.numbers,
      ]
        .map(([number, alias]) => `${alias}:pullRequest(number:${number}){...F}`)
        .join(' ')}}`,
  )
  const query = `query{rateLimit{limit remaining resetAt} ${selections.join(' ')}} fragment F on PullRequest{${FINGERPRINT_FIELDS}}`
  return { query, aliases }
}

/** One batch's fingerprints, in one call. */
export async function readPullRequestFingerprints(
  batch: FingerprintBatch,
  deps: BranchPullRequestDeps = {},
): Promise<FingerprintBatchRead> {
  const { query, aliases } = buildFingerprintQuery(batch.urls)
  if (aliases.size === 0) return { settled: false, reason: 'bad-request' }
  const outcome = await runGh(['api', 'graphql', '--hostname', batch.host, '-f', `query=${query}`], {}, deps)
  // gh exits non-zero when the answer carries errors, which it does beside
  // its data when one pull request of the batch is gone; the rest still count.
  const json = parseJsonDocument(outcome.ok ? outcome.stdout : (outcome.stdout ?? ''))
  const data = isRecord(json) && isRecord(json.data) ? json.data : null
  if (!data) return { settled: false, reason: outcome.ok ? 'bad-output' : outcome.reason }
  return parseFingerprintAnswer(data, aliases, (deps.now ?? Date.now)())
}

/** The answer's `data` → each URL's fingerprint. Exported for the test. */
export function parseFingerprintAnswer(
  data: Record<string, unknown>,
  aliases: ReadonlyMap<string, { repo: string; pullRequest: string }>,
  now: number,
): Extract<FingerprintBatchRead, { settled: true }> {
  const pullRequests = new Map<string, PullRequestFingerprint>()
  for (const [url, alias] of aliases) {
    const repo = data[alias.repo]
    const node = isRecord(repo) ? repo[alias.pullRequest] : null
    if (!isRecord(node)) {
      pullRequests.set(url, { settled: false, reason: 'gh-failed' })
      continue
    }
    const state = parseStateView(node, now)
    if (!state.settled) {
      pullRequests.set(url, state)
      continue
    }
    pullRequests.set(url, { settled: true, fingerprint: stableJson(node), state })
  }
  return { settled: true, pullRequests, quota: quotaFromGraphQl(data.rateLimit) }
}

/** JSON with every object's keys sorted, so one answer always prints the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
