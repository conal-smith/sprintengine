// The quota tracker: a reserve left for the agents, a pause until the reset
// once the watch reaches it, and a refusal's hold beside it.
import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createGitHubQuota, GITHUB_QUOTA_RESERVE_RATIO, quotaFromGraphQl, quotaFromHeaders } from './github-quota'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const RESET = NOW + 20 * 60_000

test('reads pause on a host once a quota is down to its reserve, and resume at its reset', () => {
  let nowMs = NOW
  const quota = createGitHubQuota({ now: () => nowMs })
  const reserve = 5000 * GITHUB_QUOTA_RESERVE_RATIO
  quota.note('github.com', { resource: 'graphql', limit: 5000, remaining: reserve + 1, resetAt: RESET })
  assert.equal(quota.pausedUntil('github.com'), null)
  quota.note('github.com', { resource: 'graphql', limit: 5000, remaining: reserve, resetAt: RESET })
  assert.equal(quota.pausedUntil('github.com'), RESET)
  assert.equal(quota.pausedUntil('github.acme.dev'), null, 'one host’s quota is not another’s')
  nowMs = RESET
  assert.equal(quota.pausedUntil('github.com'), null)
})

test('a refusal holds the host on its own, and the later of a hold and a reserve wins', () => {
  let nowMs = NOW
  const quota = createGitHubQuota({ now: () => nowMs })
  quota.hold('github.com', NOW + 5 * 60_000)
  assert.equal(quota.pausedUntil('github.com'), NOW + 5 * 60_000)
  quota.note('github.com', { resource: 'core', limit: 5000, remaining: 10, resetAt: RESET })
  assert.equal(quota.pausedUntil('github.com'), RESET)
  nowMs = RESET + 1
  assert.equal(quota.pausedUntil('github.com'), null)
})

test('a reset far off never pauses for longer than the longest window', () => {
  const quota = createGitHubQuota({ now: () => NOW })
  quota.note('github.com', { resource: 'graphql', limit: 5000, remaining: 0, resetAt: NOW + 24 * 60 * 60_000 })
  assert.equal(quota.pausedUntil('github.com'), NOW + 65 * 60_000)
})

test('quota readings come from REST headers and the GraphQL rateLimit field', () => {
  assert.deepEqual(
    quotaFromHeaders(
      new Map([
        ['x-ratelimit-limit', '5000'],
        ['x-ratelimit-remaining', '4994'],
        ['x-ratelimit-reset', '1793404939'],
        ['x-ratelimit-resource', 'core'],
      ]),
    ),
    { resource: 'core', limit: 5000, remaining: 4994, resetAt: 1_793_404_939_000 },
  )
  assert.equal(quotaFromHeaders(new Map([['x-ratelimit-remaining', '1']])), null, 'a host with limits off says none')
  assert.deepEqual(quotaFromGraphQl({ limit: 5000, remaining: 4895, resetAt: '2026-10-31T00:06:18Z' }), {
    resource: 'graphql',
    limit: 5000,
    remaining: 4895,
    resetAt: Date.parse('2026-10-31T00:06:18Z'),
  })
  assert.equal(quotaFromGraphQl(null), null)
})
