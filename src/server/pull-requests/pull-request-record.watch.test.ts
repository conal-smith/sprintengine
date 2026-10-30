import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { PullRequestStateRead } from '../../main/github/branch-pull-request'
import type { PullRequestWatchRead, WatchedCheck } from '../../main/github/pull-request-watch-read'
import {
  createPullRequestRecord,
  pullRequestStorePath,
  RATE_LIMIT_FALLBACK_HOLD_MS,
  RATE_LIMIT_MAX_HOLD_MS,
  WATCH_MAX_AGE_MS,
  type PullRequestRecordOptions,
  type PullRequestWatchNewsEvent,
} from './pull-request-record'

// The record's side of a watch: which read a watched pull request gets, what
// it keeps and stores, who is told, and when the watch ends. What counts as
// news is `pull-request-watch.test.ts`'s; here it is only carried.

const NOW = Date.parse('2026-10-11T10:00:00.000Z')
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const OTHER_CHAT = { workspaceId: 'ws-2', agentId: 'agent-9' }
const PR = 'https://github.com/acme/app/pull/234'
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

type WatchRead = Extract<PullRequestWatchRead, { settled: true }>

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
    advance: (ms: number) => void (nowMs += ms),
    dueIn: () => Math.min(...[...pending.values()].map((timer) => timer.dueAt - nowMs)),
    fireDue() {
      for (const [id, timer] of [...pending])
        if (timer.dueAt <= nowMs) {
          pending.delete(id)
          timer.handler()
        }
    },
    nowMs: () => nowMs,
  }
}

const opened = (overrides: Partial<Extract<PullRequestStateRead, { settled: true }>> = {}): PullRequestStateRead => ({
  settled: true,
  state: 'open',
  isDraft: false,
  stateAt: NOW,
  headRefName: 'feat/ship',
  title: 'feat: ship it',
  openedAt: NOW - 60_000,
  number: 234,
  ...overrides,
})

const check = (name: string, status: WatchedCheck['status']): WatchedCheck => ({
  name,
  workflow: 'CI',
  status,
  outcome: status === 'failed' ? 'FAILURE' : status === 'passed' ? 'SUCCESS' : 'IN_PROGRESS',
  url: null,
})

const watchRead = (overrides: Partial<WatchRead> = {}): WatchRead => ({
  ...(opened() as Extract<PullRequestStateRead, { settled: true }>),
  title: 'feat: ship it',
  openedAt: NOW - 60_000,
  number: 234,
  headSha: HEAD,
  baseRefName: 'main',
  author: 'acme',
  checks: [check('Build', 'pending')],
  requiredChecks: null,
  reviewDecision: 'review-required',
  remarks: [],
  mergeState: 'blocked',
  mergeable: 'mergeable',
  autoMerge: false,
  ...overrides,
})

async function setUp(extra: Partial<PullRequestRecordOptions> = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-watch-'))
  const clock = clockOf()
  const stateReads: string[] = []
  const watchReads: string[] = []
  const news: PullRequestWatchNewsEvent[] = []
  let nextWatchRead: PullRequestWatchRead = watchRead()
  const options: PullRequestRecordOptions = {
    userDataDir,
    reads: {
      readPullRequestState: async (url) => {
        stateReads.push(url)
        return opened()
      },
      readPullRequestWatch: async (url) => {
        watchReads.push(url)
        return nextWatchRead
      },
      readRateLimitReset: async () => null,
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
    news,
    userDataDir,
    options,
    answer: (read: PullRequestWatchRead) => void (nextWatchRead = read),
    /** Run the watch's next probe and let it land. */
    async probe() {
      clock.advance(clock.dueIn())
      clock.fireDue()
      await record.flush()
    },
  }
}

test('watching links the pull request to the asking chat, and reads it with the watch’s read', async () => {
  const { record, stateReads, watchReads } = await setUp()
  const outcome = await record.watch(CHAT, { url: `${PR}/checks` })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.alreadyWatching, false)
  await record.flush()
  assert.deepEqual(
    record.forConversation(CHAT).map((entry) => entry.url),
    [PR],
  )
  assert.ok(watchReads.includes(PR), 'the first read is taken at once')
  const [entry] = record.forConversation(CHAT)
  assert.equal(entry.watch?.waitingOn, 'checks')
  assert.equal(record.forWorkspace('ws-1')[0].watch?.waitingOn, 'checks', 'the row reads it too')
  assert.ok(stateReads.length <= 1, 'a watched pull request is not read twice per probe')
  const again = await record.watch(CHAT, { url: PR })
  assert.equal(again.ok && again.alreadyWatching, true)
  record.dispose()
})

test('another chat’s pull request, one on another forge, and one that landed are not watched', async () => {
  const { record } = await setUp()
  await record.noteOpened(OTHER_CHAT, { url: PR })
  const theirs = await record.watch(CHAT, { url: PR })
  assert.equal(!theirs.ok && theirs.code, 'opened_by_another_conversation')
  const forge = await record.watch(CHAT, { url: 'https://gitlab.com/acme/app/-/merge_requests/4' })
  assert.equal(!forge.ok && forge.code, 'not_github')
  record.dispose()

  const merged = await setUp({
    reads: { readPullRequestState: async () => opened({ state: 'merged', endedAt: NOW }) },
  })
  await merged.record.noteOpened(CHAT, { url: PR })
  await merged.record.flush()
  const landed = await merged.record.watch(CHAT, { url: PR })
  assert.equal(!landed.ok && landed.code, 'not_open')
  merged.record.dispose()
})

test('news goes to the chat that asked, with what the wake needs to say it', async () => {
  const { record, news, answer, probe } = await setUp()
  await record.watch(CHAT, { url: PR })
  await record.flush()
  assert.equal(news.length, 0, 'checks running is not news')
  answer(watchRead({ checks: [check('Build', 'failed')] }))
  await probe()
  assert.equal(news.length, 1)
  assert.deepEqual(news[0].conversation, CHAT)
  assert.equal(news[0].wake.number, 234)
  assert.equal(news[0].wake.repo, 'acme/app')
  assert.equal(news[0].wake.base, 'main')
  assert.deepEqual(
    news[0].wake.news.map((item) => item.kind),
    ['checks-failed'],
  )
  assert.equal(record.forConversation(CHAT)[0].watch?.waitingOn, 'checks-failed')
  record.dispose()
})

test('a merge is said and ends the watch, and its timer with it', async () => {
  const { record, news, answer, probe } = await setUp()
  await record.watch(CHAT, { url: PR })
  await record.flush()
  answer(watchRead({ state: 'merged', endedAt: NOW + 1 }))
  await probe()
  assert.deepEqual(
    news.map((event) => [event.wake.news.map((item) => item.kind), event.wake.stop]),
    [[['merged'], 'merged']],
  )
  const [entry] = record.forConversation(CHAT)
  assert.equal(entry.state, 'merged')
  assert.equal(entry.watch, undefined)
  assert.deepEqual(record.watchedUrls(), [])
  record.dispose()
})

test('eight failed reads end the watch and say so; a rate limit only waits', async () => {
  const { record, news, answer, probe, clock, watchReads } = await setUp()
  await record.watch(CHAT, { url: PR })
  await record.flush()
  answer({ settled: false, reason: 'rate-limited' })
  for (let index = 0; index < 10; index += 1) await probe()
  assert.equal(news.length, 0)
  assert.ok(record.watches().length === 1)
  // The probes inside the rate-limit hold read nothing; eight that do read end it.
  answer({ settled: false, reason: 'gh-failed' })
  const failingFrom = watchReads.length
  for (let index = 0; index < 40 && news.length === 0; index += 1) await probe()
  assert.equal(watchReads.length - failingFrom, 8)
  assert.ok(clock.nowMs() > NOW + RATE_LIMIT_FALLBACK_HOLD_MS)
  assert.deepEqual(
    news.map((event) => event.wake.stop),
    ['unreadable'],
  )
  assert.deepEqual(record.watches(), [])
  record.dispose()
})

test('an old pull request an agent watches keeps its timer, and the two-minute pace with no window in front', async () => {
  const { record, clock } = await setUp({
    reads: { readPullRequestState: async () => opened({ openedAt: NOW - WATCH_MAX_AGE_MS - 1 }) },
    focus: { isFocused: () => false, onFocusChange: () => () => undefined },
  })
  await record.noteOpened(CHAT, { url: PR })
  await record.flush()
  assert.deepEqual(record.watchedUrls(), [], 'too old to watch on its own')
  await record.watch(CHAT, { url: PR })
  await record.flush()
  assert.deepEqual(record.watchedUrls(), [PR])
  assert.ok(clock.dueIn() <= 2 * 60_000 * 1.2, `next probe in ${clock.dueIn()}ms`)
  record.dispose()
})

test('unwatching stops it for the chat that asked, and nobody else may', async () => {
  const { record, news, answer, probe } = await setUp()
  await record.watch(CHAT, { url: PR })
  await record.flush()
  assert.equal(record.unwatch(OTHER_CHAT, PR), false)
  assert.equal(record.unwatch(CHAT, `${PR}/files`), true)
  assert.equal(record.unwatch(CHAT, PR), false, 'already stopped')
  assert.equal(record.forConversation(CHAT)[0].watch, undefined)
  answer(watchRead({ checks: [check('Build', 'failed')] }))
  await probe()
  assert.equal(news.length, 0, 'nobody is told once it stopped')
  record.dispose()
})

test('a watch outlives a restart, stored on its pull request’s row', async () => {
  const first = await setUp()
  await first.record.watch(CHAT, { url: PR })
  await first.record.flush()
  first.record.dispose()
  const stored = JSON.parse(await readFile(pullRequestStorePath(first.userDataDir), 'utf8')) as {
    version: number
    pullRequests: Array<{ url: string; watch?: { startedAt: number; view: { waitingOn: string } } }>
  }
  assert.equal(stored.version, 2, 'an optional member, not a new file format')
  assert.equal(stored.pullRequests[0].watch?.startedAt, NOW)

  const reopened = createPullRequestRecord({ ...first.options, loadStoredOnStart: true })
  await reopened.whenLoaded()
  assert.deepEqual(reopened.watches(), [{ conversation: CHAT, url: PR }])
  assert.equal(reopened.forConversation(CHAT)[0].watch?.waitingOn, 'checks')
  assert.deepEqual(reopened.watchedUrls(), [PR])
  reopened.dispose()
})

test('watching a pull request again does not repeat what the ended watch already told the chat', async () => {
  const { record, news, answer, probe, clock } = await setUp()
  answer(watchRead({ checks: [check('Build', 'passed')] }))
  await record.watch(CHAT, { url: PR })
  await record.flush()
  assert.deepEqual(
    news.flatMap((event) => event.wake.news.map((item) => item.kind)),
    ['checks-passed'],
  )
  // The chat settles, which ends its watch; later the agent watches again.
  assert.equal(record.unwatch(CHAT, PR), true)
  clock.advance(3_600_000)
  const again = await record.watch(CHAT, { url: PR })
  assert.equal(again.ok && again.alreadyWatching, false)
  await record.flush()
  assert.equal(news.length, 1, 'the same head with the same checks is no news')
  // A push since is: its checks are told as on any new head.
  answer(watchRead({ headSha: 'ffff000011112222333344445555666677778888', checks: [check('Build', 'failed')] }))
  await probe()
  assert.deepEqual(
    news.slice(1).flatMap((event) => event.wake.news.map((item) => item.kind)),
    ['checks-failed'],
  )
  record.dispose()
})

// regression: a head no check runs on never woke the watch
test('a head no check reports on is told once, and neither watching again nor a restart tells it again', async () => {
  // Every read is taken at the record's own clock, as the real read is.
  let watchReads = 0
  const reads: PullRequestRecordOptions['reads'] = {
    readPullRequestState: async () => opened(),
    readPullRequestWatch: async (_url, deps) => {
      watchReads += 1
      return watchRead({ checks: [], stateAt: deps?.now?.() ?? NOW })
    },
  }
  const first = await setUp({ reads })
  const told = () => first.news.flatMap((event) => event.wake.news.map((item) => item.kind))
  const anHour = async (flush: () => Promise<void>) => {
    for (let probes = 0; probes < 30; probes += 1) {
      first.clock.advance(first.clock.dueIn())
      first.clock.fireDue()
      await flush()
    }
  }
  await first.record.watch(CHAT, { url: PR })
  await first.record.flush()
  await anHour(() => first.record.flush())
  assert.deepEqual(told(), ['no-checks'])

  // Watching it again carries on from what the ended watch told.
  assert.equal(first.record.unwatch(CHAT, PR), true)
  await first.record.watch(CHAT, { url: PR })
  await first.record.flush()
  await anHour(() => first.record.flush())
  assert.deepEqual(told(), ['no-checks'])

  // The wait is not stored: the watch on file is as an older build wrote it.
  first.record.dispose()
  const stored = JSON.parse(await readFile(pullRequestStorePath(first.userDataDir), 'utf8')) as {
    pullRequests: Array<{ watch?: Record<string, unknown> }>
  }
  assert.deepEqual(Object.keys(stored.pullRequests[0].watch ?? {}).sort(), [
    'behind',
    'commentWakes',
    'conflicting',
    'failedChecks',
    'failedReads',
    'headSha',
    'passedChecks',
    'primed',
    'remarks',
    'startedAt',
    'view',
  ])
  const reopened = createPullRequestRecord({ ...first.options, loadStoredOnStart: true })
  await reopened.whenLoaded()
  const readsBefore = watchReads
  await anHour(() => reopened.flush())
  assert.ok(watchReads - readsBefore >= 25, `read ${watchReads - readsBefore} times after the restart`)
  assert.deepEqual(told(), ['no-checks'], 'a restart does not tell the same head again')
  reopened.dispose()
})

test('a rate limit holds every read on its host until the quota resets', async () => {
  const resetIn = 20 * 60_000
  const lookups: string[] = []
  let clockNow = () => NOW
  const { record, watchReads, stateReads, answer, probe, clock } = await setUp({
    reads: {
      readPullRequestState: async (url) => {
        stateReads.push(url)
        return opened()
      },
      readPullRequestWatch: async (url) => {
        watchReads.push(url)
        return nextRead
      },
      readRateLimitReset: async (host) => {
        lookups.push(host)
        return clockNow() + resetIn
      },
    },
  })
  clockNow = clock.nowMs
  let nextRead: PullRequestWatchRead = watchRead()
  const OTHER = 'https://github.com/acme/app/pull/235'
  await record.watch(CHAT, { url: PR })
  await record.noteOpened(CHAT, { url: OTHER })
  await record.flush()
  const before = { watch: watchReads.length, state: stateReads.length }

  nextRead = { settled: false, reason: 'rate-limited' }
  answer(nextRead)
  await probe()
  assert.equal(watchReads.length, before.watch + 1, 'the read that was refused')
  assert.deepEqual(lookups, ['github.com'], 'asked once when the quota comes back')

  // Every probe until the reset is skipped, for this pull request and the other.
  const heldReads = { watch: watchReads.length, state: stateReads.length }
  while (clock.nowMs() < NOW + resetIn - 60_000) await probe()
  assert.deepEqual({ watch: watchReads.length, state: stateReads.length }, heldReads)
  record.refreshOutstanding()
  await record.flush()
  assert.deepEqual({ watch: watchReads.length, state: stateReads.length }, heldReads, 'a refresh waits too')

  nextRead = watchRead()
  while (clock.nowMs() < NOW + resetIn + 3 * 60_000) await probe()
  assert.ok(watchReads.length > heldReads.watch, 'reads resume once the quota is back')
  assert.ok(stateReads.length > heldReads.state)
  assert.ok(RATE_LIMIT_MAX_HOLD_MS >= resetIn)
  record.dispose()
})
