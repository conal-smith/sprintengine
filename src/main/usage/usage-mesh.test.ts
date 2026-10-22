import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { UsageReport, UsageReportRequest } from '../../shared/usage-report'
import type { UsageSpeedRow } from './usage-aggregate'
import {
  createUsageFleet,
  decodeUsageAnswer,
  encodeUsageAnswer,
  fleetRowsOf,
  mergeFleetRows,
  usageSessionHash,
  type FleetRow,
  type UsageFleetDeps,
  type UsagePeerOutcome,
  type UsageWireArgs,
} from './usage-mesh'
import { createPricing } from './usage-pricing'

const HOUR = 3_600_000
const H0 = Date.parse('2026-10-20T09:00:00.000Z')
const WINDOW = { from: H0 - 24 * HOUR, to: H0 + 24 * HOUR }

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'se-usage-mesh-')))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const pricing = createPricing(new Map([['m', { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 }]]), {
  source: 'live',
  fetchedAt: 5,
})

/** A row of this machine's, as the usage service groups them. */
const local = (sessionId: string, input: number, hour = H0, extra: Partial<UsageSpeedRow> = {}): UsageSpeedRow => ({
  day: String(hour),
  providerId: 'claude-agent',
  model: 'm',
  sessionId,
  chatTitle: 'Secret project',
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
  requests: 1,
  reportedCostUsd: null,
  ...extra,
})

/** What a paired machine answers for its own rows. */
const answerOf = (rows: UsageSpeedRow[], extra: { scannedAt?: number; scanning?: boolean } = {}) =>
  encodeUsageAnswer({
    rows: fleetRowsOf(rows),
    scannedAt: extra.scannedAt ?? H0,
    scanning: extra.scanning ?? false,
    sources: [{ id: 'claude-code', found: rows.length, error: null }],
  }) as unknown as Record<string, unknown>

type Peer = {
  id: string
  machineName: string
  answer: (args: UsageWireArgs) => UsagePeerOutcome | Promise<UsagePeerOutcome>
}

function fleet(localRows: UsageSpeedRow[], peers: Peer[], overrides: Partial<UsageFleetDeps> = {}) {
  const asked: Array<{ id: string; args: UsageWireArgs; timeoutMs: number }> = []
  const usage = createUsageFleet({
    service: { localRows: async () => ({ rows: localRows, scannedAt: H0, sources: [], pricing }) },
    dataDir: () => dir,
    peers: () => peers.map(({ id, machineName }) => ({ id, machineName })),
    askPeer: async (id, args, options) => {
      asked.push({ id, args, timeoutMs: options.timeoutMs })
      const peer = peers.find((candidate) => candidate.id === id)!
      return peer.answer(args)
    },
    localMachine: () => ({ label: 'studio-mac', kind: 'laptop', color: 'blue' }),
    pairedMachine: () => ({ kind: 'mini', color: 'teal' }),
    now: () => H0 + HOUR,
    ...overrides,
  })
  return {
    asked,
    async report(request: Partial<UsageReportRequest> = {}): Promise<UsageReport> {
      const result = await usage.report({ ...WINDOW, ...request })
      assert.ok(result.ok, result.ok ? '' : result.message)
      return result.report
    },
  }
}

const machine = (report: UsageReport, id: string) => report.machines.find((entry) => entry.id === id)!

test('the wire carries counts and a hash of each session, never its id, title or folder', () => {
  const answer = encodeUsageAnswer({
    rows: fleetRowsOf([local('session-uuid-1', 10), local('session-uuid-1', 5, H0 + HOUR)]),
    scannedAt: H0,
    scanning: false,
    sources: [{ id: 'claude-code', found: 1, error: "EACCES: open '/Users/someone/.claude/projects/x.jsonl'" }],
  })
  const wire = JSON.stringify(answer)
  assert.ok(!wire.includes('session-uuid-1'))
  assert.ok(!wire.includes('Secret project'))
  assert.ok(!wire.includes('/Users/someone'), 'a source error may name a file, so it is not sent as written')
  assert.deepEqual(answer.sessions, [usageSessionHash('claude-code', 'session-uuid-1')], 'interned once')
  assert.equal(answer.rows.length, 2)
  assert.equal(answer.rows[0]![1], 'claude-code', 'the agent, not the chat provider')

  const decoded = decodeUsageAnswer(answer as unknown as Record<string, unknown>)
  assert.equal(decoded?.rows.length, 2)
  assert.equal(decoded?.rows[1]?.input, 5)
  assert.equal(decodeUsageAnswer({ ...answer, version: 2 } as unknown as Record<string, unknown>), null)
  // A row this build cannot read is left out, not the answer.
  const odd = decodeUsageAnswer({ ...answer, rows: [...answer.rows, [H0, 'codex', 7, 'm', -1]] } as never)
  assert.equal(odd?.rows.length, 2)
})

test('a window too large for one answer is cut on an hour, and says where to go on from', () => {
  const rows = Array.from({ length: 6 }, (_, index) => local(`s${index}`, 1, H0 + Math.floor(index / 2) * HOUR))
  const answer = encodeUsageAnswer({
    rows: fleetRowsOf(rows),
    scannedAt: H0,
    scanning: false,
    sources: [],
    maxBytes: 250,
  })
  assert.equal(answer.nextFrom, H0 + HOUR)
  assert.deepEqual(
    answer.rows.map((row) => row[0]),
    [H0, H0],
    'the first hour whole, the second not begun',
  )
})

test('different sessions add up; one session on two machines counts once, the larger of each count', () => {
  const row = (session: string, input: number, extra: Partial<FleetRow> = {}): FleetRow => ({
    hour: H0,
    agent: 'claude-code',
    session,
    model: 'm',
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 1,
    costUsd: null,
    ...extra,
  })
  const merged = mergeFleetRows([
    { id: 'peer-old', local: false, scannedAt: 1, rows: [row('shared', 70), row('b', 5)] },
    { id: 'local', local: true, scannedAt: 2, rows: [row('a', 10), row('shared', 60, { requests: 3 })] },
    {
      id: 'peer-new',
      local: false,
      scannedAt: 9,
      rows: [row('c', 7, { agent: 'codex' }), row('shared', 1, { agent: 'codex' })],
    },
  ])
  const total = merged.rows.reduce((sum, entry) => sum + entry.input, 0)
  assert.equal(total, 10 + 5 + 70 + 7 + 1, 'a, b, c and codex’s own "shared" add up; claude’s "shared" once')
  const shared = merged.rows.find((entry) => entry.session === 'shared' && entry.agent === 'claude-code')!
  assert.equal(shared.input, 70)
  assert.equal(shared.requests, 3)
  assert.equal(shared.machine, 'local', 'counted on this machine, which has it')
  assert.equal(merged.sharedSessions, 1, 'the same id under another agent is another session')
})

test('a session two machines have is counted on the one that read its logs last when this one does not', () => {
  const row = {
    hour: H0,
    agent: 'codex',
    session: 's',
    model: 'm',
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 1,
    costUsd: null,
  }
  const merged = mergeFleetRows([
    { id: 'older', local: false, scannedAt: 1, rows: [row] },
    { id: 'newer', local: false, scannedAt: 5, rows: [row] },
  ])
  assert.deepEqual(
    merged.rows.map((entry) => entry.machine),
    ['newer'],
  )
})

test('this machine’s report never waits on another machine: the first answer asks none of them', async () => {
  const usage = fleet(
    [local('mine', 10)],
    [{ id: 'mini', machineName: 'mac-mini', answer: () => new Promise<never>(() => undefined) }],
  )
  const report = await usage.report()
  assert.equal(usage.asked.length, 0)
  assert.equal(report.totals.tokens.input, 10)
  assert.equal(machine(report, 'local').status, 'local')
  assert.equal(machine(report, 'mini').status, 'offline', 'not heard from yet')
  assert.equal(machine(report, 'mini').costUsd, 0)
})

test('the machines answer into one report, priced here, with a part each and the overlap counted once', async () => {
  const usage = fleet(
    [local('mine', 10), local('synced', 100)],
    [
      {
        id: 'mini',
        machineName: 'mac-mini',
        answer: () => ({ ok: true, value: answerOf([local('theirs', 20), local('synced', 90)]) }),
      },
    ],
  )
  const report = await usage.report({ peers: 'ask' })
  assert.equal(report.totals.tokens.input, 10 + 100 + 20)
  assert.equal(report.totals.costUsd, 130, 'priced with this machine’s list: $1 a token in')
  assert.equal(report.totals.sessions, 3)
  assert.equal(report.sharedSessions, 1)
  assert.deepEqual(
    report.machines.map((entry) => [entry.id, entry.status, entry.tokens, entry.sessions, entry.kind, entry.color]),
    [
      ['local', 'local', 110, 2, 'laptop', 'blue'],
      ['mini', 'ok', 20, 1, 'mini', 'teal'],
    ],
  )

  const onlyMini = await usage.report({ machines: ['mini'] })
  assert.equal(onlyMini.totals.tokens.input, 20 + 90, 'the machine filtered to counts its own copy of the overlap')
  assert.equal(onlyMini.sharedSessions, 0)
  assert.equal(onlyMini.machines.length, 2, 'every machine is listed whatever the filter')
})

test('a machine that is away is counted as it last answered, kept on disk with a version', async () => {
  let online = true
  const peers: Peer[] = [
    {
      id: 'mini',
      machineName: 'mac-mini',
      answer: () =>
        online
          ? { ok: true, value: answerOf([local('theirs', 20)]) }
          : { ok: false, status: 'offline', message: 'mac-mini did not answer.' },
    },
  ]
  await fleet([], peers).report({ peers: 'ask' })
  const kept = JSON.parse(await readFile(join(dir, 'usage', 'peer-usage.json'), 'utf8'))
  assert.equal(kept.version, 1)
  assert.ok(kept.machines.mini.fetchedAt > 0)

  // A new run: nothing asked yet, the kept figures count.
  online = false
  const restarted = fleet([], peers)
  const cached = await restarted.report()
  assert.equal(machine(cached, 'mini').status, 'cached')
  assert.equal(machine(cached, 'mini').fetchedAt, H0 + HOUR)
  assert.equal(cached.totals.tokens.input, 20)
  const away = await restarted.report({ peers: 'ask' })
  assert.equal(machine(away, 'mini').status, 'cached')
  assert.equal(machine(away, 'mini').detail, 'mac-mini did not answer.')
  assert.equal(away.totals.tokens.input, 20)

  // A machine that was never heard from counts nothing.
  const never = fleet([], [{ ...peers[0]!, id: 'tower', machineName: 'tower' }])
  const unheard = await never.report({ peers: 'ask' })
  assert.equal(machine(unheard, 'tower').status, 'offline')
  assert.equal(unheard.totals.tokens.input, 0)
})

test('a machine on an older Studio, a revoked pairing and a failing machine each say so, and count nothing', async () => {
  const usage = fleet(
    [],
    [
      {
        id: 'old',
        machineName: 'old-box',
        answer: () => ({ ok: false, status: 'unsupported', message: 'Update Studio on old-box to include its usage.' }),
      },
      {
        id: 'revoked',
        machineName: 'revoked',
        answer: () => ({ ok: false, status: 'unauthorized', message: 'Revoked.' }),
      },
      { id: 'broken', machineName: 'broken', answer: () => ({ ok: false, status: 'error', message: 'disk on fire' }) },
      { id: 'odd', machineName: 'odd', answer: () => ({ ok: true, value: { ok: true, version: 99 } }) },
    ],
  )
  const report = await usage.report({ peers: 'ask' })
  assert.deepEqual(
    report.machines.map((entry) => [entry.id, entry.status]),
    [
      ['local', 'local'],
      ['broken', 'error'],
      ['odd', 'error'],
      ['old', 'unsupported'],
      ['revoked', 'unauthorized'],
    ],
  )
  assert.equal(machine(report, 'broken').detail, 'disk on fire')
})

test('a machine still reading its logs is asked once more, and that ask waits for the read', async () => {
  let reads = 0
  const usage = fleet(
    [],
    [
      {
        id: 'cold',
        machineName: 'cold',
        answer: (args) => {
          reads += 1
          return args.wait
            ? { ok: true, value: answerOf([local('theirs', 50)]) }
            : { ok: true, value: answerOf([local('theirs', 5)], { scanning: true }) }
        },
      },
      { id: 'warm', machineName: 'warm', answer: () => ({ ok: true, value: answerOf([local('other', 1)]) }) },
    ],
    { askTimeoutMs: 10, awaitTimeoutMs: 99 },
  )
  const first = await usage.report({ peers: 'ask' })
  assert.equal(machine(first, 'cold').scanning, true)
  assert.equal(first.totals.tokens.input, 6, 'what it has so far is counted')
  const settled = await usage.report({ peers: 'await' })
  assert.equal(machine(settled, 'cold').scanning, false)
  assert.equal(settled.totals.tokens.input, 51)
  assert.equal(reads, 2)
  assert.deepEqual(
    usage.asked.map((entry) => [entry.id, entry.args.wait === true, entry.timeoutMs]),
    [
      ['cold', false, 10],
      ['warm', false, 10],
      ['cold', true, 99],
    ],
    'only the machine still reading is asked again',
  )
})

test('a machine whose answer comes in slices is asked on from where each slice ended', async () => {
  const rows = Array.from({ length: 4 }, (_, index) => local(`s${index}`, 1, H0 + index * HOUR))
  const usage = fleet(
    [],
    [
      {
        id: 'big',
        machineName: 'big',
        answer: (args) => {
          const encoded = encodeUsageAnswer({
            rows: fleetRowsOf(rows.filter((row) => Number(row.day) >= args.from)),
            scannedAt: H0,
            scanning: false,
            sources: [],
            maxBytes: 120,
          })
          return { ok: true, value: encoded as unknown as Record<string, unknown> }
        },
      },
    ],
  )
  const report = await usage.report({ peers: 'ask', refresh: true })
  assert.equal(report.totals.tokens.input, 4)
  assert.deepEqual(
    usage.asked.map((entry) => [entry.args.from, entry.args.refresh === true]),
    [
      [WINDOW.from, true],
      [H0 + HOUR, false],
      [H0 + 2 * HOUR, false],
      [H0 + 3 * HOUR, false],
    ],
  )
})
