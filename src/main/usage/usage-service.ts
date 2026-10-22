import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { conversationWorkingRoot, type AgentState } from '../../shared/agent-state'
import type { UsageReportRequest, UsageReportResult } from '../../shared/usage-report'
import type {
  ModuleUsageRegistry,
  UsageGroupBy,
  UsageQuery,
  UsageQueryResult,
  UsageSource,
} from '../../shared/modules/activity-service'
import { resolveClaudeConfigDir } from '../claude-config-dir'
import { codexHomeDir } from '../conversation-import/codex-sessions'
import { conversationStorageSegment } from '../conversation-index'
import { workspaceStorePath } from '../workspace-store'
import { aggregateUsage, type UsageSpeedRow } from './usage-aggregate'
import { createPricingStore, type PricingStore, type UsagePricing } from './usage-pricing'
import { buildUsageReport } from './usage-report'
import {
  runUsageScan,
  type UsageCacheEntry,
  type UsageScanResult,
  type UsageScanRoots,
  type UsageStudioDir,
} from './usage-scan'

// Token usage of every agent session on this machine, for modules
// (SDK `getUsageService`, permission `usage:read`) and for the app's own
// usage dashboard (`report`, priced; usage-report.ts).
//
// Reading is lazy and incremental. Nothing happens at startup: the first query
// loads the cache this service keeps in the app's data folder and scans, and a
// scan reads only the session logs whose size or modified time moved since
// the cache was written. The scan runs on a worker thread, so a cold read of
// gigabytes of logs never blocks the process; where no worker can start (a
// test, a build without the worker's file) it runs inline, yielding between
// chunks. Later queries answer from memory at once and scan again in the
// background when the last scan is older than `staleMs`; while any module
// listens for changes, a scan also runs every `pollMs`.

export type UsageServiceWorkspace = {
  id: string
  folderPath?: string | null
  agents?: Record<string, Pick<AgentState, 'name' | 'runtimeKind' | 'execution'> | undefined>
}

export type UsageScanRunner = (
  roots: UsageScanRoots,
  previous: Record<string, string>,
  onEntry: (entry: UsageCacheEntry) => void,
) => Promise<UsageScanResult>

export type UsageServiceDeps = {
  /** The app's per-user data folder; the cache lives in `usage/` under it. */
  dataDir: () => string
  /** Open workspaces with their agents, read fresh on each scan and query. */
  getWorkspaces: () => readonly UsageServiceWorkspace[]
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  homeDir?: () => string
  env?: () => NodeJS.ProcessEnv
  /** The built worker file. Absent or missing on disk, scans run inline. */
  workerPath?: string | null
  /** Overrides how a scan runs (tests). */
  runScan?: UsageScanRunner
  /** Overrides where prices come from (tests); defaults to the live list kept under `usage/`. */
  pricing?: PricingStore
  now?: () => number
  staleMs?: number
  pollMs?: number
}

/** This machine's rows for a window, grouped as the dashboard prices them (`aggregateUsage` by hour, provider, model, session and speed). */
export type UsageLocalRows = {
  rows: UsageSpeedRow[]
  scannedAt: number | null
  sources: UsageSource[]
}

export type UsageService = {
  registry: ModuleUsageRegistry
  /** The dashboard's priced report over a window; `refresh` scans now and fetches prices again. */
  report(request: UsageReportRequest): Promise<UsageReportResult>
  /** This machine's rows over a window and the price list, for a report that adds other machines' rows to them. */
  localRows(request: {
    from: number
    to: number
    refresh?: boolean
  }): Promise<UsageLocalRows & { pricing: UsagePricing }>
  /**
   * This machine's rows for a paired desktop's dashboard (`usage.report`).
   * Never waits for a read of the logs unless `wait` says to, and then for
   * `waitMs` at most: a machine that has not read its logs this run answers
   * from its cache with `scanning`, starting the read, and the desktop asks
   * again with `wait`. `refresh` starts a read now.
   */
  peerRows(request: {
    from: number
    to: number
    refresh?: boolean
    wait?: boolean
  }): Promise<UsageLocalRows & { scanning: boolean }>
  /** Scan now (or join the scan running) and resolve when it is done. */
  refresh(): Promise<void>
  dispose(): Promise<void>
}

// 2: buckets carry the speed a premium tier billed at, so every log is read again.
const CACHE_VERSION = 2
/** How long a paired desktop's `wait` holds its answer for a read of the logs, at most. */
const PEER_WAIT_MS = 45_000
const GROUP_BY: ReadonlySet<UsageGroupBy> = new Set(['day', 'model', 'workspace', 'session', 'provider'])

type CacheFile = { version: number; scannedAt: number | null; entries: UsageCacheEntry[] }

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? 30_000
  const pollMs = deps.pollMs ?? 120_000
  const entries = new Map<string, UsageCacheEntry>()
  const listeners = new Set<{ moduleId: string; listener: () => void }>()
  let loaded: Promise<void> | null = null
  let scannedAt: number | null = null
  let scannedThisRun = false
  let sources: UsageSource[] = []
  let running: Promise<void> | null = null
  let again = false
  let disposed = false
  let poll: ReturnType<typeof setInterval> | null = null
  let activeWorker: Worker | null = null

  const cachePath = (): string => join(deps.dataDir(), 'usage', 'scan-cache.json')
  const pricing =
    deps.pricing ?? createPricingStore({ cacheFile: () => join(deps.dataDir(), 'usage', 'model-prices.json') })

  function load(): Promise<void> {
    loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as Partial<CacheFile>
        if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return
        for (const entry of parsed.entries) if (entry && typeof entry.key === 'string') entries.set(entry.key, entry)
        scannedAt = typeof parsed.scannedAt === 'number' ? parsed.scannedAt : null
      } catch {
        // No cache yet, or one this version cannot read: the first scan reads everything.
      }
    })()
    return loaded
  }

  async function save(): Promise<void> {
    const path = cachePath()
    const file: CacheFile = { version: CACHE_VERSION, scannedAt, entries: [...entries.values()] }
    try {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(file), 'utf8')
      await rename(temporary, path)
    } catch (error) {
      // The cache is a speed-up; failing to keep it costs the next run a full read.
      console.warn('[usage] could not write the scan cache:', error)
    }
  }

  function roots(): UsageScanRoots {
    const home = deps.homeDir?.() ?? homedir()
    const env = deps.env?.() ?? process.env
    return {
      claudeProjects: join(resolveClaudeConfigDir(home, env), 'projects'),
      codexHome: codexHomeDir(home, env),
      opencodeData: opencodeDataDir(home, env),
      geminiHome: join(home, '.gemini'),
      grokHome: env.GROK_HOME?.trim() || join(home, '.grok'),
      studioDirs: studioDirs(deps.getWorkspaces()),
    }
  }

  const runScan: UsageScanRunner =
    deps.runScan ??
    ((scanRoots, previous, onEntry) => {
      const path = deps.workerPath
      if (path && existsSync(path)) {
        return runInWorker(path, scanRoots, previous, onEntry, (worker) => {
          activeWorker = worker
        }).catch(() => runUsageScan(scanRoots, previous, { onEntry, yieldEveryBytes: 2 << 20 }))
      }
      return runUsageScan(scanRoots, previous, { onEntry, yieldEveryBytes: 2 << 20, shouldStop: () => disposed })
    })

  async function scanOnce(): Promise<void> {
    await load()
    const previous: Record<string, string> = {}
    for (const [key, entry] of entries) previous[key] = entry.fp
    let changed = 0
    const result = await runScan(roots(), previous, (entry) => {
      entries.set(entry.key, entry)
      changed += 1
    })
    for (const key of result.removed) {
      if (entries.delete(key)) changed += 1
    }
    sources = result.sources.map(({ id, found, error }) => ({ id, found, error }))
    scannedAt = now()
    scannedThisRun = true
    if (changed > 0 || !existsSync(cachePath())) await save()
    if (changed > 0) notify()
  }

  function scan(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await scanOnce()
        } while (again && !disposed)
      } catch (error) {
        console.warn('[usage] scan failed:', error)
      } finally {
        running = null
      }
    })()
    return running
  }

  function notify(): void {
    for (const { moduleId, listener } of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error(`[usage] onChanged listener from module "${moduleId}" threw:`, error)
      }
    }
  }

  function permitted(moduleId: string): boolean {
    return deps.getModulePermissions(moduleId)?.includes('usage:read') ?? false
  }

  function chatTitle(workspaceId: string, agentId: string): string | null {
    const agent = deps.getWorkspaces().find((workspace) => workspace.id === workspaceId)?.agents?.[agentId]
    return agent?.name?.trim() || null
  }

  async function query(moduleId: string, input: UsageQuery): Promise<UsageQueryResult> {
    if (!permitted(moduleId)) {
      return {
        ok: false,
        code: 'permission_missing',
        message: `Module "${moduleId}" does not declare the "usage:read" permission, so it cannot read token usage.`,
      }
    }
    const invalid = invalidQuery(input)
    if (invalid) return { ok: false, code: 'invalid_input', message: invalid }
    if (disposed) return { ok: false, code: 'unavailable', message: 'The app is shutting down.' }
    await ready()
    return {
      ok: true,
      rows: aggregateUsage(entries.values(), input, { workspaces: workspaceRefs(), chatTitle }),
      scannedAt,
      sources: sources.map((source) => ({ ...source })),
    }
  }

  /**
   * The first read of a run waits for a scan, so it never answers from a
   * cache that may be days old; later ones answer at once and start a scan in
   * the background when the last is stale. A read joins a scan already running
   * rather than queueing another; `fresh` waits for one that starts now.
   */
  async function ready(fresh = false): Promise<void> {
    await load()
    if (fresh) await scan()
    else if (!scannedThisRun) await (running ?? scan())
    else if (!running && (scannedAt === null || now() - scannedAt > staleMs)) void scan()
  }

  const workspaceRefs = () =>
    deps.getWorkspaces().map((workspace) => ({ id: workspace.id, folderPath: workspace.folderPath ?? null }))

  // Grouped by the hour (as the day key) so the window buckets into its own
  // days, and by speed so a premium tier is priced at its own rate.
  const pricedRows = (from: number, to: number): UsageLocalRows => ({
    rows: aggregateUsage(
      entries.values(),
      { from, to, groupBy: ['day', 'provider', 'model', 'session'] },
      { workspaces: workspaceRefs(), chatTitle, dayOf: String, bySpeed: true },
    ),
    scannedAt,
    sources: sources.map((source) => ({ ...source })),
  })

  async function localRows(request: {
    from: number
    to: number
    refresh?: boolean
  }): Promise<UsageLocalRows & { pricing: UsagePricing }> {
    const refresh = request.refresh === true
    // The price list is fetched while the logs are read, not after.
    const [prices] = await Promise.all([pricing.get({ force: refresh }), ready(refresh)])
    return { ...pricedRows(request.from, request.to), pricing: prices }
  }

  async function report(request: UsageReportRequest): Promise<UsageReportResult> {
    const invalid = invalidWindow(request)
    if (invalid) return { ok: false, message: invalid }
    if (disposed) return { ok: false, message: 'The app is shutting down.' }
    const { rows, pricing: prices } = await localRows(request)
    const { from, to } = request
    return {
      ok: true,
      report: buildUsageReport({ rows, from, to, scannedAt, sources, pricing: prices }),
    }
  }

  async function peerRows(request: {
    from: number
    to: number
    refresh?: boolean
    wait?: boolean
  }): Promise<UsageLocalRows & { scanning: boolean }> {
    await load()
    let pending: Promise<void> | null = null
    if (request.refresh) pending = scan()
    else if (!scannedThisRun) pending = running ?? scan()
    else if (!running && (scannedAt === null || now() - scannedAt > staleMs)) void scan()
    if (pending && request.wait) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PEER_WAIT_MS)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
    }
    // Still reading: the first read of this run has not finished, or the one
    // `refresh` asked for has not.
    const scanning = !scannedThisRun || (request.refresh === true && running !== null)
    return { ...pricedRows(request.from, request.to), scanning }
  }

  function onChanged(moduleId: string, listener: () => void): () => void {
    if (!permitted(moduleId)) {
      throw new Error(
        `Module "${moduleId}" does not declare the "usage:read" permission, so it cannot watch token usage.`,
      )
    }
    const entry = { moduleId, listener }
    listeners.add(entry)
    if (!poll && !disposed) {
      poll = setInterval(() => void scan(), pollMs)
      poll.unref?.()
    }
    return () => {
      listeners.delete(entry)
      if (listeners.size === 0 && poll) {
        clearInterval(poll)
        poll = null
      }
    }
  }

  return {
    registry: { query, onChanged },
    report,
    localRows,
    peerRows,
    refresh: scan,
    async dispose() {
      disposed = true
      if (poll) clearInterval(poll)
      poll = null
      listeners.clear()
      const worker = activeWorker
      activeWorker = null
      if (worker) await worker.terminate().catch(() => undefined)
    },
  }
}

const shared = new Map<string, { service: UsageService; permissions: Set<UsageServiceDeps['getModulePermissions']> }>()

/**
 * The one usage service of this process for a data folder. The module host
 * (for modules) and the dashboard's IPC each ask for it, and share one scan,
 * one cache file and one worker rather than reading every log twice. The
 * first caller's deps build it; each caller adds how it resolves a module's
 * permissions, and a module holds `usage:read` if any of them says so.
 */
export function sharedUsageService(deps: UsageServiceDeps): UsageService {
  const key = deps.dataDir()
  const known = shared.get(key)
  if (known) {
    known.permissions.add(deps.getModulePermissions)
    return known.service
  }
  const permissions = new Set<UsageServiceDeps['getModulePermissions']>([deps.getModulePermissions])
  const service = createUsageService({
    ...deps,
    getModulePermissions: (moduleId) => {
      for (const resolve of permissions) {
        const granted = resolve(moduleId)
        if (granted) return granted
      }
      return undefined
    },
  })
  const dispose = service.dispose
  const entry = {
    service: {
      ...service,
      dispose: () => {
        shared.delete(key)
        return dispose()
      },
    },
    permissions,
  }
  shared.set(key, entry)
  return entry.service
}

/**
 * The app's own usage service, for the dashboard's IPC and for the gateway's
 * `usage.report`, whichever asks first: the worker is built beside main's
 * entry (electron.vite.config.ts), and where it is not there (the server
 * built on its own), the scan runs inline. It grants no module anything.
 */
export function appUsageService(deps: Pick<UsageServiceDeps, 'dataDir' | 'getWorkspaces'>): UsageService {
  return sharedUsageService({
    dataDir: deps.dataDir,
    getWorkspaces: deps.getWorkspaces,
    getModulePermissions: () => undefined,
    workerPath: join(__dirname, 'usage-scan-worker.js'),
  })
}

/** Why a report's window cannot be read, or null when it can. */
export function invalidWindow(request: { from?: unknown; to?: unknown } | null | undefined): string | null {
  const from = request?.from
  const to = request?.to
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !(to > from)) {
    return 'A usage report needs a window: "from" before "to", in epoch ms.'
  }
  return null
}

/** OpenCode's data folder: under `$XDG_DATA_HOME` when set, as OpenCode itself resolves it on every platform. */
export function opencodeDataDir(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  return xdg ? join(xdg, 'opencode') : join(home, '.local', 'share', 'opencode')
}

/**
 * Where each open workspace keeps its chat transcripts: its project's store,
 * which a chat working in a worktree of the project writes to as well. The
 * root a folder is listed with is where its chat runs, the worktree when one
 * of its agents runs in one, since that is the folder its usage was spent in.
 */
export function studioDirs(workspaces: readonly UsageServiceWorkspace[]): UsageStudioDir[] {
  const dirs = new Map<string, UsageStudioDir>()
  for (const workspace of workspaces) {
    const folder = workspace.folderPath?.trim() ? workspace.folderPath : null
    const roots = new Set<string>(folder ? [folder] : [])
    for (const agent of Object.values(workspace.agents ?? {})) {
      if (!agent || agent.runtimeKind !== 'conversation') continue
      const root = conversationWorkingRoot(agent, folder)
      if (root) roots.add(root)
    }
    for (const root of roots) {
      let dir: string
      try {
        dir = workspaceStorePath(root, 'conversations', conversationStorageSegment(workspace.id))
      } catch {
        // A folder on an SSH machine: its chats' usage is that machine's.
        continue
      }
      dirs.set(dir, { dir, workspaceId: workspace.id, root })
    }
  }
  return [...dirs.values()]
}

function invalidQuery(input: UsageQuery): string | null {
  if (!input || typeof input !== 'object') return 'A query is required.'
  if (typeof input.from !== 'number' || !Number.isFinite(input.from)) return '"from" must be a time in epoch ms.'
  if (typeof input.to !== 'number' || !Number.isFinite(input.to)) return '"to" must be a time in epoch ms.'
  if (input.to <= input.from) return '"to" must be after "from".'
  if (input.groupBy !== undefined) {
    if (!Array.isArray(input.groupBy)) return '"groupBy" must be a list.'
    const unknown = input.groupBy.find((dimension) => !GROUP_BY.has(dimension))
    if (unknown !== undefined) return `"${String(unknown)}" is not a usage dimension.`
  }
  return null
}

function runInWorker(
  path: string,
  roots: UsageScanRoots,
  previous: Record<string, string>,
  onEntry: (entry: UsageCacheEntry) => void,
  track: (worker: Worker | null) => void,
): Promise<UsageScanResult> {
  return new Promise<UsageScanResult>((resolve, reject) => {
    const worker = new Worker(path)
    worker.unref()
    track(worker)
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      track(null)
      outcome()
      void worker.terminate().catch(() => undefined)
    }
    worker.on(
      'message',
      (
        message:
          | { type: 'entry'; entry: UsageCacheEntry }
          | { type: 'done'; result: UsageScanResult }
          | { type: 'error'; message: string },
      ) => {
        if (message.type === 'entry') onEntry(message.entry)
        else if (message.type === 'done') finish(() => resolve(message.result))
        else finish(() => reject(new Error(message.message)))
      },
    )
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => finish(() => reject(new Error(`The usage scan worker stopped (exit code ${code}).`))))
    worker.postMessage({ type: 'scan', roots, previous })
  })
}
