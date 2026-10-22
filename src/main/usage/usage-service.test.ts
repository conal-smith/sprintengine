import assert from 'node:assert/strict'
import { workspaceStorePath } from '../workspace-store'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { createUsageService, studioDirs, type UsageScanRunner, type UsageServiceDeps } from './usage-service'
import type { UsageCacheEntry } from './usage-scan'

let dir: string
const HOUR = 3_600_000
const H0 = Date.UTC(2026, 9, 8, 9)

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'se-usage-service-')))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const entry = (sessionId: string, input: number, fp = '1'): UsageCacheEntry => ({
  key: `claude-code:${sessionId}`,
  src: 'claude-code',
  fp,
  sessionId,
  cwd: null,
  repoRoot: null,
  title: null,
  providerId: 'claude-agent',
  buckets: [[H0, 'm', '', input, 0, 0, 0, 1, 0]],
})

function service(runScan: UsageScanRunner, overrides: Partial<UsageServiceDeps> = {}) {
  return createUsageService({
    dataDir: () => dir,
    getWorkspaces: () => [],
    getModulePermissions: (moduleId) => (moduleId === 'insights' ? ['usage:read'] : []),
    homeDir: () => join(dir, 'home'),
    env: () => ({}),
    runScan,
    ...overrides,
  })
}

test('usage:read is required, and a malformed query is refused before any scan', async () => {
  let scans = 0
  const usage = service(async () => {
    scans += 1
    return { sources: [], groups: 0, changed: 0, removed: [] }
  })
  const denied = await usage.registry.query('board', { from: 0, to: 1 })
  assert.equal(denied.ok ? null : denied.code, 'permission_missing')
  assert.throws(() => usage.registry.onChanged('board', () => {}), /"usage:read"/)
  for (const query of [
    { from: 10, to: 5 },
    { from: Number.NaN, to: 5 },
    { from: 0, to: 5, groupBy: ['week'] },
  ]) {
    const result = await usage.registry.query('insights', query as never)
    assert.equal(result.ok ? null : result.code, 'invalid_input', JSON.stringify(query))
  }
  assert.equal(scans, 0)
  await usage.dispose()
})

test('the first query waits for a scan; the cache is kept and the next run reads only what changed', async () => {
  const previousSeen: Array<Record<string, string>> = []
  const runScan: UsageScanRunner = async (_roots, previous, onEntry) => {
    previousSeen.push(previous)
    if (!previous['claude-code:s1']) onEntry(entry('s1', 10))
    return { sources: [{ id: 'claude-code', found: 1, error: null }], groups: 1, changed: 1, removed: [] }
  }
  const first = service(runScan)
  const result = await first.registry.query('insights', { from: H0, to: H0 + HOUR })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.rows[0]?.tokens.input, 10)
  assert.ok(typeof result.scannedAt === 'number')
  assert.deepEqual(result.sources, [{ id: 'claude-code', found: 1, error: null }])
  const cache = JSON.parse(await readFile(join(dir, 'usage', 'scan-cache.json'), 'utf8')) as { entries: unknown[] }
  assert.equal(cache.entries.length, 1)
  await first.dispose()

  // A new run starts from the cache: the scan is told what it already has.
  const second = service(runScan)
  const again = await second.registry.query('insights', { from: H0, to: H0 + HOUR })
  assert.equal(again.ok && again.rows[0]?.tokens.input, 10)
  assert.deepEqual(previousSeen.at(-1), { 'claude-code:s1': '1' })
  await second.dispose()
})

test('a scan that changes the numbers tells listeners; a removed session leaves the totals', async () => {
  let round = 0
  const usage = service(async (_roots, _previous, onEntry) => {
    round += 1
    if (round === 1) onEntry(entry('s1', 10))
    return { sources: [], groups: 1, changed: round === 1 ? 1 : 0, removed: round === 3 ? ['claude-code:s1'] : [] }
  })
  let heard = 0
  const off = usage.registry.onChanged('insights', () => {
    heard += 1
  })
  await usage.refresh()
  assert.equal(heard, 1)
  await usage.refresh() // nothing changed
  assert.equal(heard, 1)
  await usage.refresh() // s1 removed
  assert.equal(heard, 2)
  const result = await usage.registry.query('insights', { from: H0, to: H0 + HOUR })
  assert.deepEqual(result.ok ? result.rows : null, [])
  off()
  await usage.dispose()
})

test('concurrent queries share one scan', async () => {
  let scans = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const usage = service(async (_roots, _previous, onEntry) => {
    scans += 1
    await gate
    onEntry(entry('s1', 5))
    return { sources: [], groups: 1, changed: 1, removed: [] }
  })
  const pending = Promise.all([
    usage.registry.query('insights', { from: H0, to: H0 + HOUR }),
    usage.registry.query('insights', { from: H0, to: H0 + HOUR }),
  ])
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  const [a, b] = await pending
  assert.equal(scans, 1)
  assert.equal(a.ok && a.rows[0]?.tokens.input, 5)
  assert.equal(b.ok && b.rows[0]?.tokens.input, 5)
  await usage.dispose()
})

test('without an injected runner the inline scan reads real logs', async () => {
  const projects = join(dir, 'home', '.claude', 'projects', '-repo')
  await mkdir(projects, { recursive: true })
  const sid = 'bbbbbbbb-2222-3333-4444-555555555555'
  await writeFile(
    join(projects, `${sid}.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      requestId: 'r',
      timestamp: new Date(H0 + 60_000).toISOString(),
      message: { id: 'm', model: 'claude-opus-4-1', usage: { input_tokens: 3, output_tokens: 4 } },
    })}\n`,
  )
  const usage = createUsageService({
    dataDir: () => dir,
    getWorkspaces: () => [],
    getModulePermissions: () => ['usage:read'],
    homeDir: () => join(dir, 'home'),
    env: () => ({}),
    workerPath: join(dir, 'no-such-worker.js'),
  })
  const result = await usage.registry.query('insights', { from: H0, to: H0 + HOUR, groupBy: ['session', 'model'] })
  assert.deepEqual(result.ok ? result.rows : result, [
    {
      model: 'claude-opus-4-1',
      sessionId: sid,
      chatTitle: null,
      tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      requests: 1,
      reportedCostUsd: null,
    },
  ])
  await usage.dispose()
})

test('Studio transcripts are read from the project’s store, which a chat in a worktree writes to as well', () => {
  const dirs = studioDirs([
    {
      id: 'ws-1',
      folderPath: '/Users/dev/acme',
      agents: {
        chat: {
          name: 'Chat',
          runtimeKind: 'conversation',
          execution: { mode: 'worktree', worktreeId: 'w', cwd: '/Users/dev/.sprintengine-worktrees/acme/chat-1' },
        },
        term: {
          name: 'Term',
          runtimeKind: 'terminal',
          execution: { mode: 'worktree', worktreeId: 'x', cwd: '/Users/dev/ignored' },
        },
      },
    },
    { id: 'ws-2', folderPath: null },
    { id: 'ws-3', folderPath: 'ssh://build-box/home/dev/acme' },
  ])
  // One folder, listed with the worktree the chat runs in, where its usage was spent.
  assert.deepEqual(
    dirs.map((entry) => [entry.workspaceId, entry.root, entry.dir]),
    [
      [
        'ws-1',
        '/Users/dev/.sprintengine-worktrees/acme/chat-1',
        workspaceStorePath('/Users/dev/acme', 'conversations', 'ws-1'),
      ],
    ],
  )
})

test('a paired desktop is answered at once while the first read runs, and waits for it only when it asks to', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const usage = service(async (_roots, _previous, onEntry) => {
    await gate
    onEntry(entry('s1', 5))
    return { sources: [], groups: 1, changed: 1, removed: [] }
  })
  const cold = await usage.peerRows({ from: H0, to: H0 + HOUR })
  assert.equal(cold.scanning, true)
  assert.deepEqual(cold.rows, [], 'nothing read yet, and nothing waited for')
  const waiting = usage.peerRows({ from: H0, to: H0 + HOUR, wait: true })
  release()
  const settled = await waiting
  assert.equal(settled.scanning, false)
  assert.equal(settled.rows[0]?.tokens.input, 5)
  assert.equal(settled.rows[0]?.day, String(H0), 'by the hour, as the dashboard prices them')
  await usage.dispose()
})
