import assert from 'node:assert/strict'
import { test } from 'vitest'

import { aggregateUsage } from './usage-aggregate'
import type { UsageBucket, UsageCacheEntry } from './usage-scan'

const HOUR = 3_600_000
const H0 = Date.UTC(2026, 9, 8, 9)
const day = (hour: number): string => new Date(hour).toISOString().slice(0, 10)

const bucket = (
  hour: number,
  model: string,
  link: string,
  tokens: [number, number, number, number],
  requests = 1,
  costUsd = 0,
): UsageBucket => [hour, model, link, ...tokens, requests, costUsd]

function cli(partial: Partial<UsageCacheEntry> & Pick<UsageCacheEntry, 'sessionId' | 'buckets'>): UsageCacheEntry {
  return {
    key: `claude-code:${partial.sessionId}`,
    src: 'claude-code',
    fp: '1',
    cwd: null,
    repoRoot: null,
    title: null,
    providerId: 'claude-agent',
    ...partial,
  }
}

function studio(
  agentId: string,
  links: string[],
  buckets: UsageBucket[],
  providerId = 'claude-agent',
  title: string | null = 'Release notes',
): UsageCacheEntry {
  return {
    key: `studio:${agentId}`,
    src: 'studio',
    fp: '1',
    sessionId: agentId,
    cwd: '/Users/dev/acme',
    repoRoot: null,
    title,
    providerId,
    studio: { workspaceId: 'ws-1', agentId, root: '/Users/dev/acme', links },
    buckets,
  }
}

const context = {
  workspaces: [
    { id: 'ws-1', folderPath: '/Users/dev/acme' },
    { id: 'ws-web', folderPath: '/Users/dev/acme/web' },
    { id: 'ws-none', folderPath: null },
  ],
  dayOf: day,
}

test('a Studio chat on Claude Code is counted from the CLI log once, under the chat', () => {
  const entries = [
    // The transcript says the same turn, with its own (smaller) usage and a cost.
    studio('agent-1', ['cli-1'], [bucket(H0, 'opus', 'cli-1', [10, 20, 0, 0], 1, 0.5)]),
    cli({
      sessionId: 'cli-1',
      cwd: '/tmp/elsewhere',
      buckets: [bucket(H0, 'claude-opus-4-1', '', [12, 25, 300, 40], 3)],
    }),
  ]
  const rows = aggregateUsage(entries, { from: H0, to: H0 + HOUR, groupBy: ['session'] }, context)
  assert.deepEqual(rows, [
    {
      sessionId: 'cli-1',
      agentId: 'agent-1',
      chatTitle: 'Release notes',
      tokens: { input: 12, output: 25, cacheRead: 300, cacheWrite: 40 },
      requests: 3,
      reportedCostUsd: null,
    },
  ])
  const byWorkspace = aggregateUsage(entries, { from: H0, to: H0 + HOUR, groupBy: ['workspace'] }, context)
  assert.deepEqual(
    byWorkspace.map((row) => [row.workspaceId, row.requests]),
    [['ws-1', 3]],
  )
})

test('turns whose CLI log is not here are counted from the transcript, with the reported cost', () => {
  const entries = [
    studio(
      'agent-2',
      ['gone-session'],
      [bucket(H0, 'auto', 'gone-session', [5, 6, 7, 8], 1, 0.2), bucket(H0, 'auto', '', [0, 0, 0, 0], 0, 0.1)],
      'cursor-agent',
    ),
  ]
  const rows = aggregateUsage(entries, { from: H0, to: H0 + HOUR, groupBy: ['provider', 'session'] }, context)
  assert.equal(rows.length, 2)
  const linked = rows.find((row) => row.sessionId === 'gone-session')!
  assert.deepEqual(linked.tokens, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 })
  assert.equal(linked.providerId, 'cursor-agent')
  assert.ok(Math.abs((linked.reportedCostUsd ?? 0) - 0.2) < 1e-9)
  const unlinked = rows.find((row) => row.sessionId === 'agent-2')!
  assert.equal(unlinked.requests, 0)
  assert.ok(Math.abs((unlinked.reportedCostUsd ?? 0) - 0.1) < 1e-9)
})

test('a terminal session is attributed by folder, deepest workspace first, worktrees via the repository', () => {
  const entries = [
    cli({ sessionId: 'a', cwd: '/Users/dev/acme/web/src', buckets: [bucket(H0, 'm', '', [1, 0, 0, 0])] }),
    cli({ sessionId: 'b', cwd: '/Users/dev/acme/api', buckets: [bucket(H0, 'm', '', [2, 0, 0, 0])] }),
    cli({
      sessionId: 'c',
      cwd: '/Users/dev/.pool/slot-3',
      repoRoot: '/Users/dev/acme',
      buckets: [bucket(H0, 'm', '', [4, 0, 0, 0])],
    }),
    cli({ sessionId: 'd', cwd: '/Users/dev/other', buckets: [bucket(H0, 'm', '', [8, 0, 0, 0])] }),
    cli({ sessionId: 'e', cwd: '/Users/dev/acme-old', buckets: [bucket(H0, 'm', '', [16, 0, 0, 0])] }),
  ]
  const rows = aggregateUsage(entries, { from: H0, to: H0 + HOUR, groupBy: ['workspace'] }, context)
  const byWorkspace = Object.fromEntries(rows.map((row) => [String(row.workspaceId), row.tokens.input]))
  assert.deepEqual(byWorkspace, { 'ws-web': 1, 'ws-1': 6, null: 24 })
})

test('the window is by hour, and day and model group the rest', () => {
  const entries = [
    cli({
      sessionId: 's',
      buckets: [
        bucket(H0 - HOUR, 'm1', '', [100, 0, 0, 0]),
        bucket(H0, 'm1', '', [1, 1, 0, 0]),
        bucket(H0 + HOUR, 'm2', '', [2, 2, 0, 0]),
        bucket(H0 + 24 * HOUR, 'm1', '', [4, 4, 0, 0]),
        bucket(H0 + 48 * HOUR, 'm1', '', [1000, 0, 0, 0]),
      ],
    }),
  ]
  const rows = aggregateUsage(entries, { from: H0, to: H0 + 48 * HOUR, groupBy: ['day', 'model'] }, context)
  assert.deepEqual(
    rows.map((row) => [row.day, row.model, row.tokens.input, row.requests]),
    [
      ['2026-10-08', 'm2', 2, 1],
      ['2026-10-08', 'm1', 1, 1],
      ['2026-10-09', 'm1', 4, 1],
    ],
  )
  const total = aggregateUsage(entries, { from: H0, to: H0 + 48 * HOUR }, context)
  assert.deepEqual(total, [
    { tokens: { input: 7, output: 7, cacheRead: 0, cacheWrite: 0 }, requests: 3, reportedCostUsd: null },
  ])
  assert.deepEqual(aggregateUsage([], { from: H0, to: H0 + HOUR }, context), [])
})

test('usage at a premium speed is a row of its own only when the speed is asked for', () => {
  const fast: UsageBucket = [H0, 'claude-opus-5-5', '', 10, 1, 0, 0, 1, 0, 'fast']
  const entries = [cli({ sessionId: 's-speed', buckets: [bucket(H0, 'claude-opus-5-5', '', [20, 2, 0, 0]), fast] })]
  const query = { from: H0, to: H0 + HOUR, groupBy: ['model' as const] }

  const merged = aggregateUsage(entries, query, context)
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0]!.tokens, { input: 30, output: 3, cacheRead: 0, cacheWrite: 0 })
  assert.equal('speed' in merged[0]!, false, 'a module never sees the speed')

  const split = aggregateUsage(entries, query, { ...context, bySpeed: true })
  assert.deepEqual(
    split.map((row) => [row.model, row.speed ?? 'standard', row.tokens.input]),
    [
      ['claude-opus-5-5', 'standard', 20],
      ['claude-opus-5-5', 'fast', 10],
    ],
  )
})
