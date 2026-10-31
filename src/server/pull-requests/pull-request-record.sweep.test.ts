// The record's sweeps: one batched fingerprint question per sweep, a full read
// only when a fingerprint moved (or every half hour), and the quota's pause.
// What the watch says is `pull-request-watch.test.ts`'s; here it is only
// shown to be said on time.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { PullRequestStateRead } from '../../main/github/branch-pull-request'
import type { GitHubQuotaReading } from '../../main/github/github-quota'
import type { FingerprintBatchRead } from '../../main/github/pull-request-fingerprint'
import type { PullRequestWatchRead } from '../../main/github/pull-request-watch-read'
import { WATCH_NO_CHECKS_AFTER_MS } from './pull-request-watch'
import {
  createPullRequestRecord,
  WATCH_FULL_REREAD_MS,
  type PullRequestRecordOptions,
  type PullRequestWatchNewsEvent,
} from './pull-request-record'

const NOW = Date.parse('2026-10-11T10:00:00.000Z')
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const PR = 'https://github.com/acme/app/pull/234'
const prs = (count: number) =>
  Array.from({ length: count }, (_, index) => `https://github.com/acme/app/pull/${300 + index}`)
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

type StateRead = Extract<PullRequestStateRead, { settled: true }>

function clockOf() {
  let seq = 1
  let nowMs = NOW
  const pending = new Map<number, { handler: () => void; dueAt: number }>()
  return {
    setTimeout: (handler: () => void, ms: number): unknown => {
      const id = seq++
      pending.set(id, { handler, dueAt: nowMs + ms })
      return id
    },
    clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    dueIn: () => Math.min(...[...pending.values()].map((timer) => timer.dueAt - nowMs)),
    fireDue() {
      for (const [id, timer] of [...pending])
        if (timer.dueAt <= nowMs) {
          pending.delete(id)
          timer.handler()
        }
    },
    advance: (ms: number) => void (nowMs += ms),
    nowMs: () => nowMs,
  }
}

async function setUp(extra: Partial<PullRequestRecordOptions> = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-sweep-'))
  const clock = clockOf()
  const stateReads: string[] = []
  const watchReads: Array<{ url: string; at: number }> = []
  const fingerprintCalls: string[][] = []
  const news: PullRequestWatchNewsEvent[] = []
  const opened = (overrides: Partial<StateRead> = {}): StateRead => ({
    settled: true,
    state: 'open',
    isDraft: false,
    stateAt: clock.nowMs(),
    headRefName: 'feat/ship',
    title: 'feat: ship it',
    openedAt: NOW - 60_000,
    number: 234,
    ...overrides,
  })
  let watchRead = (): PullRequestWatchRead => ({
    ...opened(),
    title: 'feat: ship it',
    openedAt: NOW - 60_000,
    number: 234,
    headSha: HEAD,
    baseRefName: 'main',
    author: 'acme',
    checks: [{ name: 'Build', workflow: 'CI', status: 'pending', outcome: 'IN_PROGRESS', url: null }],
    requiredChecks: null,
    reviewDecision: 'review-required',
    remarks: [],
    mergeState: 'blocked',
    mergeable: 'mergeable',
    autoMerge: false,
  })
  // URL → its fingerprint and state, as the next batch answers them.
  const fingerprintOf = new Map<string, { fingerprint: string; state?: Partial<StateRead> }>()
  let batchAnswer: ((urls: string[]) => FingerprintBatchRead) | null = null
  let quota: GitHubQuotaReading | null = null
  const options: PullRequestRecordOptions = {
    userDataDir,
    reads: {
      readPullRequestState: async (url) => {
        stateReads.push(url)
        return opened()
      },
      readPullRequestWatch: async (url) => {
        watchReads.push({ url, at: clock.nowMs() })
        return watchRead()
      },
      readRateLimitReset: async () => null,
      readPullRequestFingerprints: async (batch) => {
        fingerprintCalls.push(batch.urls)
        if (batchAnswer) return batchAnswer(batch.urls)
        return {
          settled: true,
          quota,
          pullRequests: new Map(
            batch.urls.map((url) => {
              const known = fingerprintOf.get(url) ?? { fingerprint: 'v1' }
              return [url, { settled: true, fingerprint: known.fingerprint, state: opened(known.state) }]
            }),
          ),
        }
      },
    },
    onWatchNews: (event) => news.push(event),
    now: clock.nowMs,
    timers: clock,
    random: () => 0.5,
    logWarning: () => undefined,
    ...extra,
  }
  const record = createPullRequestRecord(options)
  return {
    record,
    clock,
    stateReads,
    watchReads,
    fingerprintCalls,
    fingerprintOf,
    news,
    setQuota: (next: GitHubQuotaReading | null) => void (quota = next),
    answerBatch: (answer: typeof batchAnswer) => void (batchAnswer = answer),
    answerWatch: (read: () => PullRequestWatchRead) => void (watchRead = read),
    async probe() {
      clock.advance(clock.dueIn())
      clock.fireDue()
      await record.flush()
    },
  }
}

test('one fingerprint call per sweep covers every open pull request, and answers their state', async () => {
  const urls = prs(5)
  const { record, probe, stateReads, fingerprintCalls, fingerprintOf } = await setUp()
  for (const url of urls) await record.noteOpened(CHAT, { url })
  await record.flush()
  const recorded = stateReads.length
  assert.equal(recorded, urls.length, 'each is read once when it is recorded')

  await probe()
  assert.equal(fingerprintCalls.length, 1)
  assert.deepEqual([...fingerprintCalls[0]!].sort(), [...urls].sort())
  assert.equal(stateReads.length, recorded, 'the fingerprint was the state read')

  // One merges: the fingerprint says so, and its timer goes.
  fingerprintOf.set(urls[2]!, { fingerprint: 'merged', state: { state: 'merged', endedAt: NOW } })
  await probe()
  assert.equal(fingerprintCalls.length, 2)
  assert.equal(record.forWorkspace(CHAT.workspaceId).find((entry) => entry.url === urls[2])?.state, 'merged')
  assert.ok(!record.watchedUrls().includes(urls[2]!))
  assert.equal(stateReads.length, recorded)
  record.dispose()
})

test('a watched pull request is read in full only when its fingerprint moves', async () => {
  const { record, probe, watchReads, fingerprintCalls, fingerprintOf } = await setUp()
  await record.watch(CHAT, { url: PR })
  await record.flush()
  assert.equal(watchReads.length, 1, 'the watch’s first read')

  // No fingerprint yet to compare with: read in full, and remember it.
  await probe()
  assert.equal(watchReads.length, 2)
  for (let index = 0; index < 5; index += 1) await probe()
  assert.equal(fingerprintCalls.length, 6)
  assert.equal(watchReads.length, 2, 'unchanged: no full read')

  fingerprintOf.set(PR, { fingerprint: 'v2' })
  await probe()
  assert.equal(watchReads.length, 3, 'moved: read in full')
  await probe()
  assert.equal(watchReads.length, 3)
  record.dispose()
})

test('a watched pull request is read in full every half hour, its fingerprint unmoved or not', async () => {
  const { record, probe, clock, watchReads } = await setUp()
  await record.watch(CHAT, { url: PR })
  await record.flush()
  await probe()
  const since = watchReads.at(-1)!.at
  while (clock.nowMs() < since + 2 * WATCH_FULL_REREAD_MS + 60_000) await probe()
  const gaps = watchReads.slice(2).map((read, index) => read.at - watchReads[index + 1]!.at)
  assert.equal(gaps.length, 2, JSON.stringify(gaps))
  for (const gap of gaps) {
    assert.ok(gap >= WATCH_FULL_REREAD_MS && gap < WATCH_FULL_REREAD_MS + 3 * 60_000, `reread after ${gap}ms`)
  }
  record.dispose()
})

test('a held fingerprint still evaluates the last read as of now, so a head with no checks is told on time', async () => {
  const { record, probe, clock, news, answerWatch, watchReads } = await setUp()
  answerWatch(() => ({
    settled: true,
    state: 'open',
    isDraft: false,
    stateAt: clock.nowMs(),
    headRefName: 'feat/ship',
    title: 'feat: ship it',
    openedAt: NOW - 60_000,
    number: 234,
    headSha: HEAD,
    baseRefName: 'main',
    author: 'acme',
    checks: [],
    requiredChecks: null,
    reviewDecision: null,
    remarks: [],
    mergeState: 'clean',
    mergeable: 'mergeable',
    autoMerge: false,
  }))
  await record.watch(CHAT, { url: PR })
  await record.flush()
  await probe()
  const fullReads = watchReads.length
  while (news.length === 0 && clock.nowMs() < NOW + WATCH_NO_CHECKS_AFTER_MS + 10 * 60_000) await probe()
  assert.deepEqual(
    news.map((event) => event.wake.news.map((item) => item.kind)),
    [['no-checks']],
  )
  assert.ok(clock.nowMs() - NOW < WATCH_NO_CHECKS_AFTER_MS + 3 * 60_000, 'told within a sweep of when it was due')
  assert.equal(watchReads.length, fullReads, 'from the read already taken')
  record.dispose()
})

test('a sweep that reaches the quota’s reserve pauses the watch until the reset, then it resumes', async () => {
  const { record, probe, clock, fingerprintCalls, setQuota } = await setUp()
  for (const url of prs(3)) await record.noteOpened(CHAT, { url })
  await record.flush()
  const resetAt = NOW + 20 * 60_000
  setQuota({ resource: 'graphql', limit: 5000, remaining: 499, resetAt })
  await probe()
  const paused = fingerprintCalls.length
  while (clock.nowMs() < resetAt - 60_000) await probe()
  record.refreshOutstanding()
  await record.flush()
  assert.equal(fingerprintCalls.length, paused, 'nothing asked inside the reserve, a window’s return included')

  setQuota({ resource: 'graphql', limit: 5000, remaining: 5000, resetAt: resetAt + 60 * 60_000 })
  while (clock.nowMs() < resetAt + 3 * 60_000) await probe()
  assert.ok(fingerprintCalls.length > paused, 'sweeps resume once the quota is back')
  record.dispose()
})

test('a batch that could not be asked falls back to each pull request’s own read', async () => {
  const { record, probe, watchReads, stateReads, answerBatch } = await setUp()
  const [other] = prs(1)
  await record.watch(CHAT, { url: PR })
  await record.noteOpened(CHAT, { url: other! })
  await record.flush()
  const before = { watch: watchReads.length, state: stateReads.length }
  answerBatch(() => ({ settled: false, reason: 'timeout' }))
  await probe()
  assert.deepEqual(
    { watch: watchReads.length, state: stateReads.length },
    { watch: before.watch + 1, state: before.state + 1 },
  )

  // One pull request the answer left out is read on its own; the rest are not.
  answerBatch((urls) => ({
    settled: true,
    quota: null,
    pullRequests: new Map(urls.map((url) => [url, { settled: false, reason: 'gh-failed' } as const])),
  }))
  await probe()
  assert.equal(stateReads.length, before.state + 2)
  record.dispose()
})
