import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import type { GhResult, GhRunner } from './gh'
import { checkKey, parseWatchView, readPullRequestWatch, WATCH_VIEW_FIELDS } from './pull-request-watch-read'

// A real `gh pr view --json` answer for a merged pull request, and its real
// `gh pr checks --required --json` answer (gh 2.95), trimmed: logins are
// `acme` and `dev`, the repository `acme/app`. The comments come from another
// pull request of the same repository, so the fixture has some.
const VIEW = readFileSync(join(__dirname, '__fixtures__', 'gh-pr-view-watch.json'), 'utf8')
const REQUIRED = readFileSync(join(__dirname, '__fixtures__', 'gh-pr-checks-required.json'), 'utf8')
const URL = 'https://github.com/acme/app/pull/233'
const NOW = Date.parse('2026-10-11T10:00:00Z')

function ghAnswering(answers: { view?: Partial<GhResult>; checks?: Partial<GhResult> }) {
  const calls: string[][] = []
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push(args)
      const answer = args[1] === 'checks' ? answers.checks : answers.view
      return { found: true, code: 0, stdout: '', stderr: '', ...answer }
    },
  }
  return { gh, calls }
}

/** The fixture, as an open pull request with its checks as given. */
function openView(rollup: unknown[], extra: Record<string, unknown> = {}): string {
  const json = JSON.parse(VIEW) as Record<string, unknown>
  return JSON.stringify({
    ...json,
    state: 'OPEN',
    mergedAt: null,
    closedAt: null,
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    statusCheckRollup: rollup,
    ...extra,
  })
}

const run = (name: string, status: string, conclusion: string, completedAt: string | null, workflow = 'CI') => ({
  __typename: 'CheckRun',
  name,
  workflowName: workflow,
  status,
  conclusion,
  startedAt: '2026-10-11T09:33:00Z',
  completedAt: completedAt ?? '0001-01-01T00:00:00Z',
  detailsUrl: `https://github.com/acme/app/actions/runs/1/job/${name.length}`,
})

test('the fields asked for are ones gh pr view --json lists', () => {
  // gh 2.95's list, as `gh pr view --json` prints it with no fields.
  const known = new Set(
    'additions assignees author autoMergeRequest baseRefName baseRefOid body changedFiles closed closedAt closingIssuesReferences comments commits createdAt deletions files fullDatabaseId headRefName headRefOid headRepository headRepositoryOwner id isCrossRepository isDraft labels latestReviews maintainerCanModify mergeCommit mergeStateStatus mergeable mergedAt mergedBy milestone number potentialMergeCommit projectCards projectItems reactionGroups reviewDecision reviewRequests reviews state statusCheckRollup title updatedAt url'.split(
      ' ',
    ),
  )
  for (const field of WATCH_VIEW_FIELDS.split(',')) assert.ok(known.has(field), field)
})

test('a real merged pull request reads as merged, with its checks, comments and auto-merge', () => {
  const read = parseWatchView(JSON.parse(VIEW) as Record<string, unknown>, NOW)
  assert.equal(read.settled, true)
  if (!read.settled) return
  assert.equal(read.state, 'merged')
  assert.equal(read.number, 233)
  assert.equal(read.headSha, '12b280c05d3ea1d89be864f1d1a35ab745c83128')
  assert.equal(read.baseRefName, 'main')
  assert.equal(read.author, 'acme')
  assert.equal(read.autoMerge, true)
  assert.equal(read.mergeable, 'unknown')
  assert.equal(read.mergeState, 'unknown')
  assert.equal(read.reviewDecision, null)
  assert.equal(read.checks.length, 9)
  // Skipped is not a failure: the preview build skipped on this pull request.
  assert.deepEqual(
    read.checks.filter((check) => check.status !== 'passed').map((check) => check.name),
    [],
  )
  assert.deepEqual(
    read.checks.find((check) => check.name === 'JS tests (ubuntu-latest)'),
    {
      name: 'JS tests (ubuntu-latest)',
      workflow: 'CI',
      status: 'passed',
      outcome: 'SUCCESS',
      url: 'https://github.com/acme/app/actions/runs/38128775673/job/114438626817',
    },
  )
  // The pull request's author wrote the first comment (the agent's own
  // account), and someone else the second.
  assert.deepEqual(
    read.remarks.map((remark) => [remark.author, remark.kind, remark.own]),
    [
      ['acme', 'comment', true],
      ['dev', 'comment', false],
    ],
  )
})

test('a watched read asks for the required checks, and keys them as the rollup does', async () => {
  const { gh, calls } = ghAnswering({
    view: { stdout: openView([run('Build (macos-latest)', 'IN_PROGRESS', '', null)]) },
    checks: { stdout: REQUIRED },
  })
  const read = await readPullRequestWatch(URL, { gh, now: () => NOW })
  assert.equal(read.settled, true)
  if (!read.settled) return
  assert.deepEqual(calls[0], ['pr', 'view', URL, '--json', WATCH_VIEW_FIELDS])
  assert.deepEqual(calls[1], ['pr', 'checks', URL, '--required', '--json', 'name,workflow'])
  assert.ok(read.requiredChecks?.includes(checkKey({ name: 'Build (macos-latest)', workflow: 'CI' })))
  assert.ok(
    read.requiredChecks?.includes(checkKey({ name: 'Conventional PR title', workflow: 'Conventional Commits' })),
  )
  assert.equal(read.requiredChecks?.length, 5)
})

test('a branch with no required checks is read as none required; any other failure as unknown', async () => {
  const none = ghAnswering({
    view: { stdout: openView([run('lint', 'COMPLETED', 'SUCCESS', '2026-10-11T09:40:00Z')]) },
    checks: { code: 1, stderr: "no required checks reported on the 'feat/x' branch" },
  })
  const noneRead = await readPullRequestWatch(URL, { gh: none.gh, now: () => NOW })
  assert.equal(noneRead.settled && noneRead.requiredChecks?.length, 0)
  const failing = ghAnswering({
    view: { stdout: openView([run('lint', 'COMPLETED', 'SUCCESS', '2026-10-11T09:40:00Z')]) },
    checks: { code: 1, stderr: 'HTTP 502' },
  })
  const unknownRead = await readPullRequestWatch(URL, { gh: failing.gh, now: () => NOW })
  assert.equal(unknownRead.settled && unknownRead.requiredChecks, null)
})

test('a check whose second run is still going is not passed; between finished runs the latest wins', () => {
  const read = parseWatchView(
    JSON.parse(
      openView([
        run('JS tests', 'COMPLETED', 'SUCCESS', '2026-10-11T09:40:00Z'),
        run('JS tests', 'IN_PROGRESS', '', null),
        run('Build', 'COMPLETED', 'FAILURE', '2026-10-11T09:35:00Z'),
        run('Build', 'COMPLETED', 'SUCCESS', '2026-10-11T09:45:00Z'),
        run('Lint', 'COMPLETED', 'SUCCESS', '2026-10-11T09:50:00Z'),
        run('Lint', 'COMPLETED', 'TIMED_OUT', '2026-10-11T09:30:00Z'),
      ]),
    ) as Record<string, unknown>,
    NOW,
  )
  assert.equal(read.settled, true)
  if (!read.settled) return
  assert.deepEqual(
    read.checks.map((check) => [check.name, check.status]),
    [
      ['JS tests', 'pending'],
      ['Build', 'passed'],
      ['Lint', 'passed'],
    ],
  )
})

test('commit statuses, odd conclusions and the merge state read as the watch needs them', () => {
  const read = parseWatchView(
    JSON.parse(
      openView(
        [
          { __typename: 'StatusContext', context: 'ci/circleci', state: 'ERROR', targetUrl: 'https://ci.example/1' },
          { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: null },
          run('Needs approval', 'COMPLETED', 'ACTION_REQUIRED', '2026-10-11T09:40:00Z'),
          run('Neutral', 'COMPLETED', 'NEUTRAL', '2026-10-11T09:40:00Z'),
        ],
        {
          mergeStateStatus: 'BEHIND',
          mergeable: 'CONFLICTING',
          reviewDecision: 'CHANGES_REQUESTED',
          autoMergeRequest: null,
        },
      ),
    ) as Record<string, unknown>,
    NOW,
  )
  assert.equal(read.settled, true)
  if (!read.settled) return
  assert.deepEqual(
    read.checks.map((check) => [check.name, check.status, check.outcome]),
    [
      ['ci/circleci', 'failed', 'ERROR'],
      ['deploy/preview', 'pending', 'PENDING'],
      ['Needs approval', 'failed', 'ACTION_REQUIRED'],
      ['Neutral', 'passed', 'NEUTRAL'],
    ],
  )
  assert.equal(read.mergeState, 'behind')
  assert.equal(read.mergeable, 'conflicting')
  assert.equal(read.reviewDecision, 'changes-requested')
  assert.equal(read.autoMerge, false)
})

test('reviews read with their verdicts; a pending draft and a dismissed review are left out', () => {
  const read = parseWatchView(
    JSON.parse(
      openView([], {
        reviews: [
          { id: 'R1', author: { login: 'dev' }, state: 'APPROVED', body: '', submittedAt: '2026-10-11T09:41:00Z' },
          { id: 'R2', author: { login: 'dev' }, state: 'PENDING', body: 'draft', submittedAt: null },
          { id: 'R3', author: { login: 'dev' }, state: 'DISMISSED', body: '', submittedAt: '2026-10-11T09:42:00Z' },
        ],
        latestReviews: [
          { id: 'R1', author: { login: 'dev' }, state: 'APPROVED', body: '', submittedAt: '2026-10-11T09:41:00Z' },
          {
            id: 'R4',
            author: { login: 'acme' },
            state: 'COMMENTED',
            body: 'own',
            submittedAt: '2026-10-11T09:43:00Z',
          },
        ],
        comments: [],
      }),
    ) as Record<string, unknown>,
    NOW,
  )
  assert.equal(read.settled, true)
  if (!read.settled) return
  assert.deepEqual(
    read.remarks.map((remark) => [remark.id, remark.verdict, remark.own, remark.url]),
    [
      ['R1', 'approved', false, URL],
      ['R4', 'commented', true, URL],
    ],
  )
})

test('a rate limit is its own reason, and a failure to ask is never an answer', async () => {
  const limited = ghAnswering({ view: { code: 1, stderr: 'GraphQL: API rate limit exceeded for user ID 1.' } })
  assert.deepEqual(await readPullRequestWatch(URL, { gh: limited.gh }), { settled: false, reason: 'rate-limited' })
  const failed = ghAnswering({ view: { code: 1, stderr: 'Could not resolve to a PullRequest' } })
  assert.deepEqual(await readPullRequestWatch(URL, { gh: failed.gh }), { settled: false, reason: 'gh-failed' })
  const garbled = ghAnswering({ view: { stdout: 'not json' } })
  assert.deepEqual(await readPullRequestWatch(URL, { gh: garbled.gh }), { settled: false, reason: 'bad-output' })
  assert.deepEqual(await readPullRequestWatch('not a url'), { settled: false, reason: 'bad-request' })
  // No checks: required checks are not asked about.
  const bare = ghAnswering({ view: { stdout: openView([]) } })
  await readPullRequestWatch(URL, { gh: bare.gh })
  assert.equal(bare.calls.length, 1)
})
