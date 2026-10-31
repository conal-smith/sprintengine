// The watch's batched question: many pull requests in one GraphQL call, and
// a fingerprint per pull request that moves exactly when what it reads does.
import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { GhResult, GhRunner } from './gh'
import {
  buildFingerprintQuery,
  FINGERPRINT_PULL_REQUESTS_PER_QUERY,
  parseFingerprintAnswer,
  planFingerprintBatches,
  readPullRequestFingerprints,
} from './pull-request-fingerprint'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const pr = (repo: string, number: number, host = 'github.com') => `https://${host}/acme/${repo}/pull/${number}`

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'feat: ship it',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-10-11T09:00:00Z',
    mergedAt: null,
    closedAt: null,
    headRefName: 'feat/ship',
    baseRefName: 'main',
    headRefOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    autoMergeRequest: null,
    comments: { totalCount: 1, nodes: [{ updatedAt: '2026-10-11T09:30:00Z' }] },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            statusCheckRollup: {
              state: 'PENDING',
              contexts: {
                totalCount: 2,
                checkRunCountsByState: [
                  { state: 'IN_PROGRESS', count: 1 },
                  { state: 'SUCCESS', count: 1 },
                ],
                statusContextCountsByState: [],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  }
}

test('pull requests are batched by host, in order, at most a query’s worth each', () => {
  const many = Array.from({ length: FINGERPRINT_PULL_REQUESTS_PER_QUERY + 3 }, (_, index) => pr('app', index + 1))
  const enterprise = pr('app', 7, 'github.acme.dev')
  const batches = planFingerprintBatches([
    ...many,
    enterprise,
    many[0]!,
    'https://bitbucket.org/acme/app/pull-requests/1',
  ])
  assert.deepEqual(
    batches.map((batch) => [batch.host, batch.urls.length]),
    [
      ['github.com', FINGERPRINT_PULL_REQUESTS_PER_QUERY],
      ['github.com', 3],
      ['github.acme.dev', 1],
    ],
  )
  assert.deepEqual(batches[0]!.urls, many.slice(0, FINGERPRINT_PULL_REQUESTS_PER_QUERY))
  assert.deepEqual(
    planFingerprintBatches(['https://github.acme.dev:8443/acme/app/pull/3']).map((batch) => batch.host),
    ['github.acme.dev:8443'],
    'the port is kept: gh needs it to reach the host',
  )
})

test('one query covers every pull request in a batch, one alias per repository and pull request', () => {
  const urls = [pr('app', 12), pr('app', 13), pr('docs', 4)]
  const { query, aliases } = buildFingerprintQuery(urls)
  assert.equal(query.match(/:repository\(/g)?.length, 2)
  assert.equal(query.match(/:pullRequest\(/g)?.length, 3)
  assert.match(query, /rateLimit\{limit remaining resetAt\}/)
  assert.match(query, /r0:repository\(owner:"acme",name:"app"\)\{p12:pullRequest\(number:12\)/)
  assert.deepEqual(aliases.get(pr('docs', 4)), { repo: 'r1', pullRequest: 'p4' })
})

test('a fingerprint is the same for the same answer, and moves when anything it reads moves', () => {
  const url = pr('app', 12)
  const aliases = new Map([[url, { repo: 'r0', pullRequest: 'p12' }]])
  const fingerprintOf = (pullRequest: Record<string, unknown>) => {
    const answered = parseFingerprintAnswer({ r0: { p12: pullRequest } }, aliases, NOW).pullRequests.get(url)
    assert.ok(answered?.settled)
    return answered.fingerprint
  }
  const base = fingerprintOf(node())
  // Key order is GitHub's business, not a change.
  assert.equal(fingerprintOf(Object.fromEntries(Object.entries(node()).reverse())), base)
  for (const moved of [
    { headRefOid: 'b'.repeat(40) },
    { mergeStateStatus: 'BEHIND' },
    { reviewDecision: 'APPROVED' },
    { comments: { totalCount: 1, nodes: [{ updatedAt: '2026-10-11T09:45:00Z' }] } },
    { reviews: { totalCount: 1, nodes: [{ state: 'COMMENTED', updatedAt: '2026-10-11T09:45:00Z' }] } },
    { reviewThreads: { totalCount: 1, nodes: [{ isResolved: false, comments: { totalCount: 1, nodes: [] } }] } },
    { state: 'MERGED', mergedAt: '2026-10-11T09:50:00Z' },
  ]) {
    assert.notEqual(fingerprintOf(node(moved)), base, JSON.stringify(moved))
  }
})

test('the fingerprint answers the state read, and a pull request the answer left out is unsettled alone', () => {
  const kept = pr('app', 12)
  const gone = pr('app', 99)
  const read = parseFingerprintAnswer(
    {
      rateLimit: { limit: 5000, remaining: 4321, resetAt: '2026-10-11T10:30:00Z' },
      r0: { p12: node({ state: 'MERGED', mergedAt: '2026-10-11T09:50:00Z' }), p99: null },
    },
    new Map([
      [kept, { repo: 'r0', pullRequest: 'p12' }],
      [gone, { repo: 'r0', pullRequest: 'p99' }],
    ]),
    NOW,
  )
  const answered = read.pullRequests.get(kept)
  assert.ok(answered?.settled)
  assert.equal(answered.state.state, 'merged')
  assert.equal(answered.state.endedAt, Date.parse('2026-10-11T09:50:00Z'))
  assert.equal(answered.state.title, 'feat: ship it')
  assert.equal(answered.state.stateAt, NOW)
  assert.deepEqual(read.pullRequests.get(gone), { settled: false, reason: 'gh-failed' })
  assert.deepEqual(read.quota, {
    resource: 'graphql',
    limit: 5000,
    remaining: 4321,
    resetAt: Date.parse('2026-10-11T10:30:00Z'),
  })
})

test('a batch is one gh call, and an answer carrying errors beside its data still counts', async () => {
  const calls: string[][] = []
  const answer: Partial<GhResult> = {
    code: 1,
    stderr: 'gh: Could not resolve to a PullRequest with the number of 99.',
    stdout: JSON.stringify({ data: { r0: { p12: node(), p99: null } }, errors: [{ type: 'NOT_FOUND' }] }),
  }
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push(args)
      return { found: true, code: 0, stdout: '', stderr: '', ...answer }
    },
  }
  const read = await readPullRequestFingerprints(
    { host: 'github.com', urls: [pr('app', 12), pr('app', 99)] },
    { gh, now: () => NOW },
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com'])
  assert.ok(read.settled)
  assert.equal(read.pullRequests.get(pr('app', 12))?.settled, true)
  assert.equal(read.pullRequests.get(pr('app', 99))?.settled, false)

  answer.stdout = ''
  answer.stderr = 'API rate limit exceeded for user'
  assert.deepEqual(await readPullRequestFingerprints({ host: 'github.com', urls: [pr('app', 12)] }, { gh }), {
    settled: false,
    reason: 'rate-limited',
  })
})
