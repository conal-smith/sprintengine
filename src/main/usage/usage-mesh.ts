import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { UsageSource } from '../../shared/modules/activity-service'
import {
  LOCAL_USAGE_MACHINE_ID,
  usageAgentOf,
  usageTokenTotal,
  type UsageMachineStatus,
  type UsageReportMachine,
  type UsageReportRequest,
  type UsageReportResult,
} from '../../shared/usage-report'
import type { UsageSpeedRow } from './usage-aggregate'
import { buildUsageReport } from './usage-report'
import type { UsageSpeed } from './usage-scan'
import { invalidWindow, type UsageService } from './usage-service'

// The usage dashboard across the person's machines: this machine's rows, and
// what each Studio paired over the tailnet answers for its own over the
// `usage.report` gateway tool (`usage-report` capability). Each machine folds
// its own logs (usage-aggregate.ts) into rows of one hour of one model in one
// session; this desktop prices every row with its own price list, so one
// model costs the same whichever machine ran it, and passes a cost an agent
// reported for its own turns through as it is.
//
// What crosses the wire is counts, by hour, agent, model and speed, and a
// hash of each session's id. No title, folder, path, workspace or transcript:
// the person sees totals, so a total is all that is sent.
//
// Counting each request once:
// - different sessions add up, whichever machines they ran on;
// - one session found on two machines (a home folder synced between them, a
//   restored backup, a Windows folder WSL shares) is one session. Its rows
//   meet by agent, session, hour, model and speed, and the larger of each
//   count is kept, since both copies are the same log at different lengths.
//   The row is counted on this machine when it has it, else on the machine
//   that read its logs last.
// - a chat followed from another machine is cached under
//   `tailnet-remote-conversations/`, which no scan reads, so it is counted on
//   the machine it runs on and nowhere else.
//
// A machine never holds up the page: the dashboard asks for this machine's
// report with every other machine's last answer (`peers: 'cached'`), then
// for one that asks each machine now (`ask`), then, if any said it was still
// reading its logs, for one that waits for them (`await`). The last answer
// from each machine is kept on disk, so one that is away is counted as it
// last stood and says from when.

// ── The wire ─────────────────────────────────────────────────────────────────

/**
 * One row as `usage.report` sends it:
 * `[hourStartMs, agent, sessionIndex, model, input, output, cacheRead, cacheWrite, requests, reportedCostUsd, speed?]`.
 * `sessionIndex` points into the answer's `sessions`; `speed` is absent at standard speed.
 */
export type UsageWireRow = [
  hour: number,
  agent: string,
  session: number,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  requests: number,
  reportedCostUsd: number | null,
  speed?: UsageSpeed,
]

export type UsageWireArgs = { from: number; to: number; refresh?: boolean; wait?: boolean }

/** `usage.report`'s structured answer. */
export type UsageWireAnswer = {
  ok: true
  /** Bumped only with a change an older reader would misread; a new member is not one. */
  version: typeof USAGE_WIRE_VERSION
  scannedAt: number | null
  /** The figures predate a read of the logs that is running now; ask again with `wait`. */
  scanning: boolean
  sources: Array<{ id: string; found: number; error: string | null }>
  /** `usageSessionHash` of each session the rows name, each once. */
  sessions: string[]
  rows: UsageWireRow[]
  /**
   * Where the next slice starts when the window's rows did not fit in one
   * answer (the tailnet client reads 4 MB at most), else null. A slice always
   * ends on an hour, so no hour is split between two.
   */
  nextFrom: number | null
}

export const USAGE_WIRE_VERSION = 1
/** What one answer's rows may take, leaving the client's 4 MB for the envelope. */
const SLICE_BYTES = 3_000_000
const SPEEDS: ReadonlySet<string> = new Set<UsageSpeed>(['fast', 'ultrafast'])

/** A row as every machine's rows meet: the session by its hash, the agent rather than the provider. */
export type FleetRow = {
  hour: number
  agent: string
  session: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
  costUsd: number | null
  speed?: UsageSpeed
}

/**
 * A session's id as it crosses the wire. Hashed with its agent, so two
 * agents' sessions never meet by an id they happen to share, and truncated:
 * ninety-six bits tell sessions apart, and say nothing of the log.
 */
export function usageSessionHash(agent: string, sessionId: string): string {
  return createHash('sha256').update(`${agent}:${sessionId}`).digest('hex').slice(0, 24)
}

/** This machine's rows as every machine's meet. */
export function fleetRowsOf(rows: readonly UsageSpeedRow[]): FleetRow[] {
  const hashes = new Map<string, string>()
  return rows.flatMap((row) => {
    const hour = Number(row.day)
    if (!Number.isFinite(hour)) return []
    const agent = usageAgentOf(row.providerId ?? '')
    const id = `${agent}\u0000${row.sessionId ?? ''}`
    let session = hashes.get(id)
    if (session === undefined) {
      session = usageSessionHash(agent, row.sessionId ?? '')
      hashes.set(id, session)
    }
    return [
      {
        hour,
        agent,
        session,
        model: row.model ?? 'unknown',
        input: row.tokens.input,
        output: row.tokens.output,
        cacheRead: row.tokens.cacheRead,
        cacheWrite: row.tokens.cacheWrite,
        requests: row.requests,
        costUsd: row.reportedCostUsd,
        ...(row.speed ? { speed: row.speed } : {}),
      },
    ]
  })
}

/**
 * The answer to `usage.report`: the rows from the window's start, as many
 * whole hours as fit in one slice. A source's error is not sent as written,
 * since it may name a file on this disk.
 */
export function encodeUsageAnswer(input: {
  rows: readonly FleetRow[]
  scannedAt: number | null
  scanning: boolean
  sources: readonly UsageSource[]
  maxBytes?: number
}): UsageWireAnswer {
  const budget = input.maxBytes ?? SLICE_BYTES
  const sorted = [...input.rows].sort((a, b) => a.hour - b.hour)
  const sessions: string[] = []
  const index = new Map<string, number>()
  const rows: UsageWireRow[] = []
  let bytes = 0
  let nextFrom: number | null = null
  let start = 0
  while (start < sorted.length) {
    const hour = sorted[start]!.hour
    let end = start
    while (end < sorted.length && sorted[end]!.hour === hour) end += 1
    // An hour is sent whole or not at all; the first always goes, whatever it weighs.
    const fresh = new Set<string>()
    let weight = 0
    const encoded = sorted.slice(start, end).map((row) => {
      if (!index.has(row.session) && !fresh.has(row.session)) {
        fresh.add(row.session)
        weight += row.session.length + 3
      }
      const wire: UsageWireRow = [
        row.hour,
        row.agent,
        -1,
        row.model,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.requests,
        row.costUsd,
        ...(row.speed ? [row.speed] : []),
      ] as UsageWireRow
      weight += JSON.stringify(wire).length + 1
      return { wire, session: row.session }
    })
    if (rows.length > 0 && bytes + weight > budget) {
      nextFrom = hour
      break
    }
    for (const { wire, session } of encoded) {
      let at = index.get(session)
      if (at === undefined) {
        at = sessions.push(session) - 1
        index.set(session, at)
      }
      wire[2] = at
      rows.push(wire)
    }
    bytes += weight
    start = end
  }
  return {
    ok: true,
    version: USAGE_WIRE_VERSION,
    scannedAt: input.scannedAt,
    scanning: input.scanning,
    sources: input.sources.map((source) => ({
      id: source.id,
      found: source.found,
      error: source.error === null ? null : 'Could not be read on that machine.',
    })),
    sessions,
    rows,
    nextFrom,
  }
}

export type DecodedUsageAnswer = {
  scannedAt: number | null
  scanning: boolean
  rows: FleetRow[]
  nextFrom: number | null
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const MAX_ROWS = 250_000

/**
 * A paired machine's answer, read member by member: a row this build cannot
 * read is left out rather than failing the rest, and null is an answer that
 * is not one at all (another version's, or no rows list).
 */
export function decodeUsageAnswer(value: Record<string, unknown>): DecodedUsageAnswer | null {
  if (value.version !== USAGE_WIRE_VERSION || !Array.isArray(value.rows) || !Array.isArray(value.sessions)) return null
  const sessions = value.sessions.map((session) =>
    typeof session === 'string' && session.length > 0 && session.length <= 64 ? session : null,
  )
  const rows: FleetRow[] = []
  for (const entry of value.rows.slice(0, MAX_ROWS)) {
    if (!Array.isArray(entry)) continue
    const [hour, agent, at, model, input, output, cacheRead, cacheWrite, requests, cost, speed] = entry as unknown[]
    const session = Number.isInteger(at) ? sessions[at as number] : null
    if (typeof hour !== 'number' || !Number.isFinite(hour) || !session) continue
    if (typeof agent !== 'string' || !agent || agent.length > 64) continue
    if (typeof model !== 'string' || model.length > 200) continue
    if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite) || !count(requests)) continue
    if (cost !== null && !count(cost)) continue
    if (speed !== undefined && (typeof speed !== 'string' || !SPEEDS.has(speed))) continue
    rows.push({
      hour,
      agent,
      session,
      model: model || 'unknown',
      input,
      output,
      cacheRead,
      cacheWrite,
      requests,
      costUsd: cost,
      ...(speed ? { speed: speed as UsageSpeed } : {}),
    })
  }
  return {
    scannedAt: typeof value.scannedAt === 'number' && Number.isFinite(value.scannedAt) ? value.scannedAt : null,
    scanning: value.scanning === true,
    rows,
    nextFrom: typeof value.nextFrom === 'number' && Number.isFinite(value.nextFrom) ? value.nextFrom : null,
  }
}

// ── Counting each request once ───────────────────────────────────────────────

export type FleetMachineRows = {
  id: string
  /** This machine, whose copy of a session is the one counted when it has one. */
  local: boolean
  scannedAt: number | null
  rows: readonly FleetRow[]
}

export type MergedFleetRows = {
  /** Each row counted once, with the machine it is counted on. */
  rows: Array<FleetRow & { machine: string }>
  /** Sessions more than one machine had. */
  sharedSessions: number
}

const rowKey = (row: FleetRow): string => JSON.stringify([row.agent, row.session, row.hour, row.model, row.speed ?? ''])

/**
 * Every machine's rows, each counted once (see the top of this file). Within
 * one machine rows of one key add up, as two logs of the same hour would; a
 * key on two machines keeps the larger of each count.
 */
export function mergeFleetRows(machines: readonly FleetMachineRows[]): MergedFleetRows {
  const ordered = [...machines].sort(
    (a, b) => Number(b.local) - Number(a.local) || (b.scannedAt ?? -Infinity) - (a.scannedAt ?? -Infinity),
  )
  const merged = new Map<string, FleetRow & { machine: string }>()
  const seenOn = new Map<string, Set<string>>()
  for (const machine of ordered) {
    const own = new Map<string, FleetRow>()
    for (const row of machine.rows) {
      const key = rowKey(row)
      const known = own.get(key)
      if (!known) {
        own.set(key, { ...row })
        continue
      }
      known.input += row.input
      known.output += row.output
      known.cacheRead += row.cacheRead
      known.cacheWrite += row.cacheWrite
      known.requests += row.requests
      if (row.costUsd !== null) known.costUsd = (known.costUsd ?? 0) + row.costUsd
    }
    for (const [key, row] of own) {
      const session = `${row.agent}\u0000${row.session}`
      let machinesOf = seenOn.get(session)
      if (!machinesOf) seenOn.set(session, (machinesOf = new Set()))
      machinesOf.add(machine.id)
      const known = merged.get(key)
      if (!known) {
        merged.set(key, { ...row, machine: machine.id })
        continue
      }
      known.input = Math.max(known.input, row.input)
      known.output = Math.max(known.output, row.output)
      known.cacheRead = Math.max(known.cacheRead, row.cacheRead)
      known.cacheWrite = Math.max(known.cacheWrite, row.cacheWrite)
      known.requests = Math.max(known.requests, row.requests)
      if (row.costUsd !== null) known.costUsd = Math.max(known.costUsd ?? 0, row.costUsd)
    }
  }
  let sharedSessions = 0
  for (const machinesOf of seenOn.values()) if (machinesOf.size > 1) sharedSessions += 1
  return { rows: [...merged.values()], sharedSessions }
}

/** Rows as the report prices them, a session by its hash. */
function speedRowsOf(rows: readonly FleetRow[]): UsageSpeedRow[] {
  return rows.map((row) => ({
    day: String(row.hour),
    providerId: row.agent,
    model: row.model,
    sessionId: row.session,
    chatTitle: null,
    tokens: { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
    requests: row.requests,
    reportedCostUsd: row.costUsd,
    ...(row.speed ? { speed: row.speed } : {}),
  }))
}

// ── What each machine last answered ──────────────────────────────────────────

/** 1: rows as the wire sends them, per machine, by connection id. */
const PEER_CACHE_VERSION = 1
/** Rows older than the dashboard's longest range, and a little, are not kept. */
const KEEP_MS = 100 * 24 * 3_600_000

type PeerFigures = { fetchedAt: number; scannedAt: number | null; rows: FleetRow[] }

type PeerCacheFile = {
  version: number
  machines: Record<string, { fetchedAt: number; scannedAt: number | null; sessions: string[]; rows: UsageWireRow[] }>
}

/** A paired machine as the dashboard asks it, through the mesh (`TailnetMeshService.readUsage`). */
export type UsagePeerOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 'offline' | 'unsupported' | 'unauthorized' | 'error'; message: string }

export type UsagePeer = { id: string; machineName: string }

export type UsageMachineMark = { kind: UsageReportMachine['kind']; color: UsageReportMachine['color'] }

export type UsageFleetDeps = {
  service: Pick<UsageService, 'localRows'>
  /** The app's per-user data folder; the machines' last answers live in `usage/` under it. */
  dataDir: () => string
  /** The machines this desktop is paired to read; none where there is no mesh. */
  peers: () => readonly UsagePeer[]
  askPeer: (connectionId: string, args: UsageWireArgs, options: { timeoutMs: number }) => Promise<UsagePeerOutcome>
  /** This machine's name and mark, and a paired machine's, with the person's choices from Settings › Machines. */
  localMachine: () => UsageMachineMark & { label: string }
  pairedMachine: (machineName: string) => UsageMachineMark
  now?: () => number
  /** How long one slice may take: a machine asked now, and one asked to wait for its read. */
  askTimeoutMs?: number
  awaitTimeoutMs?: number
}

type PeerState = {
  /** What it answered this run, or null before it was asked. */
  status: UsageMachineStatus | null
  detail: string | null
  scanning: boolean
}

/** Slices one machine may answer in before the rest of the window is left for the next ask. */
const MAX_SLICES = 8

export type UsageFleet = {
  report(request: UsageReportRequest): Promise<UsageReportResult>
}

export function createUsageFleet(deps: UsageFleetDeps): UsageFleet {
  const now = deps.now ?? Date.now
  const askTimeoutMs = deps.askTimeoutMs ?? 10_000
  const awaitTimeoutMs = deps.awaitTimeoutMs ?? 60_000
  const figures = new Map<string, PeerFigures>()
  const states = new Map<string, PeerState>()
  let loaded: Promise<void> | null = null

  const cachePath = (): string => join(deps.dataDir(), 'usage', 'peer-usage.json')

  function load(): Promise<void> {
    loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as Partial<PeerCacheFile>
        if (parsed.version !== PEER_CACHE_VERSION || !parsed.machines || typeof parsed.machines !== 'object') return
        for (const [id, stored] of Object.entries(parsed.machines)) {
          if (!stored || typeof stored.fetchedAt !== 'number') continue
          const decoded = decodeUsageAnswer({
            version: USAGE_WIRE_VERSION,
            scannedAt: stored.scannedAt,
            sessions: stored.sessions,
            rows: stored.rows,
          })
          if (decoded)
            figures.set(id, { fetchedAt: stored.fetchedAt, scannedAt: decoded.scannedAt, rows: decoded.rows })
        }
      } catch {
        // Nothing kept yet, or a copy this version cannot read: each machine is asked afresh.
      }
    })()
    return loaded
  }

  async function save(): Promise<void> {
    const paired = new Set(deps.peers().map((peer) => peer.id))
    const file: PeerCacheFile = { version: PEER_CACHE_VERSION, machines: {} }
    for (const [id, kept] of figures) {
      // A machine since forgotten takes its figures with it.
      if (!paired.has(id)) continue
      const encoded = encodeUsageAnswer({
        rows: kept.rows,
        scannedAt: kept.scannedAt,
        scanning: false,
        sources: [],
        maxBytes: Number.POSITIVE_INFINITY,
      })
      file.machines[id] = {
        fetchedAt: kept.fetchedAt,
        scannedAt: kept.scannedAt,
        sessions: encoded.sessions,
        rows: encoded.rows,
      }
    }
    const path = cachePath()
    try {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(file), 'utf8')
      await rename(temporary, path)
    } catch (error) {
      // Kept to show a machine that is away; without it, one is shown with no figures.
      console.warn('[usage] could not keep the paired machines’ usage:', error)
    }
  }

  /** Ask one machine for a window, slice by slice, and keep what it answered. */
  async function ask(peer: UsagePeer, request: UsageReportRequest, wait: boolean): Promise<void> {
    const rows: FleetRow[] = []
    let scannedAt: number | null = null
    let scanning = false
    let from = request.from
    let first = true
    for (let slice = 0; slice < MAX_SLICES; slice += 1) {
      const outcome = await deps.askPeer(
        peer.id,
        {
          from,
          to: request.to,
          // Asked of the first slice only: the rest are read from the same scan.
          ...(first && request.refresh ? { refresh: true } : {}),
          ...(first && wait ? { wait: true } : {}),
        },
        { timeoutMs: first && wait ? awaitTimeoutMs : askTimeoutMs },
      )
      if (!outcome.ok) {
        // A machine that stops answering part way keeps what it last answered whole.
        const kept = figures.has(peer.id) && (outcome.status === 'offline' || outcome.status === 'error')
        states.set(peer.id, { status: kept ? 'cached' : outcome.status, detail: outcome.message, scanning: false })
        return
      }
      const decoded = decodeUsageAnswer(outcome.value)
      if (!decoded) {
        states.set(peer.id, {
          status: figures.has(peer.id) ? 'cached' : 'error',
          detail: `${peer.machineName} answered with usage this build cannot read. Update Studio on both machines.`,
          scanning: false,
        })
        return
      }
      rows.push(...decoded.rows)
      scannedAt = decoded.scannedAt
      scanning ||= decoded.scanning
      first = false
      if (decoded.nextFrom === null || !(decoded.nextFrom > from) || decoded.nextFrom >= request.to) {
        from = request.to
        break
      }
      from = decoded.nextFrom
    }
    // The window as far as it was answered replaces what was kept for it.
    const answeredTo = from
    const floor = now() - KEEP_MS
    const kept = (figures.get(peer.id)?.rows ?? []).filter(
      (row) => row.hour >= floor && (row.hour < request.from || row.hour >= answeredTo),
    )
    figures.set(peer.id, { fetchedAt: now(), scannedAt, rows: [...kept, ...rows] })
    states.set(peer.id, { status: 'ok', detail: null, scanning })
  }

  function machineOf(
    peer: UsagePeer,
  ): Omit<UsageReportMachine, 'costUsd' | 'tokens' | 'sessions'> & { counted: boolean } {
    const kept = figures.get(peer.id) ?? null
    const state = states.get(peer.id)
    // Not asked this run: what it answered last, if anything.
    const status: UsageMachineStatus = state?.status ?? (kept ? 'cached' : 'offline')
    return {
      id: peer.id,
      label: peer.machineName,
      ...deps.pairedMachine(peer.machineName),
      status,
      scanning: state?.scanning ?? false,
      scannedAt: kept?.scannedAt ?? null,
      fetchedAt: kept?.fetchedAt ?? null,
      detail: state?.detail ?? null,
      counted: (status === 'ok' || status === 'cached') && kept !== null,
    }
  }

  async function report(request: UsageReportRequest): Promise<UsageReportResult> {
    const invalid = invalidWindow(request)
    if (invalid) return { ok: false, message: invalid }
    const mode = request.peers ?? 'cached'
    const { from, to } = request
    const [local] = await Promise.all([
      deps.service.localRows({ from, to, refresh: mode === 'cached' && request.refresh === true }),
      load(),
    ])
    const peers = deps.peers()
    if (mode !== 'cached') {
      const asked = peers.filter((peer) => mode === 'ask' || states.get(peer.id)?.scanning === true)
      // Every machine at once: one that is away costs its own timeout, not the others'.
      await Promise.all(asked.map((peer) => ask(peer, request, mode === 'await')))
      if (asked.length > 0) await save()
    }

    const localMark = deps.localMachine()
    const machines = [
      {
        id: LOCAL_USAGE_MACHINE_ID,
        label: localMark.label,
        kind: localMark.kind,
        color: localMark.color,
        status: 'local' as const,
        scanning: false,
        scannedAt: local.scannedAt,
        fetchedAt: null,
        detail: null,
        counted: true,
      },
      ...peers.map(machineOf).sort((a, b) => a.label.localeCompare(b.label)),
    ]
    const inWindow = (row: FleetRow): boolean => row.hour >= from && row.hour < to
    const rowsOf = new Map<string, FleetMachineRows>()
    rowsOf.set(LOCAL_USAGE_MACHINE_ID, {
      id: LOCAL_USAGE_MACHINE_ID,
      local: true,
      scannedAt: local.scannedAt,
      rows: fleetRowsOf(local.rows),
    })
    for (const machine of machines) {
      if (machine.id === LOCAL_USAGE_MACHINE_ID || !machine.counted) continue
      const kept = figures.get(machine.id)
      if (kept)
        rowsOf.set(machine.id, {
          id: machine.id,
          local: false,
          scannedAt: kept.scannedAt,
          rows: kept.rows.filter(inWindow),
        })
    }

    // Each machine's part, with every machine counted; then the report, over
    // the machines asked for, so a session two of them had is counted on the
    // one of those it would be counted on anyway.
    const price = (rows: readonly FleetRow[]) =>
      buildUsageReport({
        rows: speedRowsOf(rows),
        from,
        to,
        scannedAt: local.scannedAt,
        sources: local.sources,
        pricing: local.pricing,
      })
    const everyone = mergeFleetRows([...rowsOf.values()])
    const parts: UsageReportMachine[] = machines.map(({ counted, ...machine }) => {
      if (!counted) return { ...machine, costUsd: 0, tokens: 0, sessions: 0 }
      const totals = price(everyone.rows.filter((row) => row.machine === machine.id)).totals
      return { ...machine, costUsd: totals.costUsd, tokens: usageTokenTotal(totals.tokens), sessions: totals.sessions }
    })
    const wanted = request.machines?.length ? new Set(request.machines) : null
    const chosen = wanted ? mergeFleetRows([...rowsOf.values()].filter((machine) => wanted.has(machine.id))) : everyone
    return {
      ok: true,
      report: buildUsageReport({
        rows: speedRowsOf(chosen.rows),
        from,
        to,
        scannedAt: local.scannedAt,
        sources: local.sources,
        pricing: local.pricing,
        machines: parts,
        sharedSessions: chosen.sharedSessions,
      }),
    }
  }

  return { report }
}
