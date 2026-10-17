// Asks each installed agent CLI which models it accepts, and decides when a CLI
// needs asking at all. The rules it implements are in docs/model-discovery-plan.md:
//
// - A CLI that is not installed, or has no probe, is skipped and keeps whatever
//   catalog it had.
// - A catalog is fresh for 24 hours, and only while the CLI's detected version
//   is the one that produced it: an update re-probes at once. `force` (Settings
//   "Refresh") ignores both.
// - A failed probe changes nothing. It writes no cache and returns plain words
//   for the Settings line; the last good catalog stays where it is.
// - `firstSeenAt` is carried forward by id from the previous catalog, so "New"
//   means new on this machine. A CLI's first-ever catalog carries none, or a
//   fresh install would light up every model it lists.
//
// The gating reads a cache kept here in main, under userData, rather than only
// the renderer's persisted copy: a renderer reload must not re-probe every CLI,
// and the boot pass runs before any renderer has sent its copy.
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { studioPlatform } from '../../server/platform/platform'
import type { AgentCliAvailabilityMap, CliRuntimeSettings } from '../../shared/electron-api'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { DiscoveredCliModel, DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import type {
  CliModelDiscoveryEntry,
  CliModelDiscoveryInput,
  CliModelDiscoveryResult,
} from '../../shared/ipc/cli-model-discovery'
import { detectAgentCliAvailability } from '../cli-availability'
import { cliProbeEnv } from '../cli-probe-env'
import { runCliCommand } from '../cli-runtime-install'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import { CLI_MODEL_PROBES } from './probes'
import { CliModelProbeError, type ArgvRunOutcome, type CliModelProbe } from './probe-types'

export const MODEL_DISCOVERY_TIMEOUT_MS = 20_000
export const MODEL_CATALOG_FRESH_FOR_MS = 24 * 60 * 60 * 1000
const CACHE_FILE_NAME = 'model-discovery-cache.json'
const CACHE_FILE_VERSION = 1
// Room past the probe's own deadline for it to tear its child down and report,
// before the service stops waiting on it regardless.
const SERVICE_GUARD_GRACE_MS = 5_000

type Catalogs = Record<string, DiscoveredCliModelCatalog>
type CliRuntimes = CliModelDiscoveryInput['cliRuntimes']

export type ModelDiscoveryCache = {
  read: () => Promise<Catalogs>
  // Serialized, so two passes that overlap cannot write over each other.
  update: (apply: (catalogs: Catalogs) => Catalogs) => Promise<void>
}

type RegisteredCli = { id: string; displayName: string; binary: string }

export type CliModelDiscoveryDeps = {
  listClis?: () => RegisteredCli[]
  probes?: Readonly<Record<string, CliModelProbe>>
  detect?: (clis: RegisteredCli[], cliRuntimes: CliRuntimes) => Promise<AgentCliAvailabilityMap>
  runArgv?: (input: {
    binary: string
    args: string[]
    hostId?: ExecutionHostId
    timeoutMs: number
    setEnv?: Readonly<Record<string, string>>
  }) => Promise<ArgvRunOutcome>
  cache?: ModelDiscoveryCache
  now?: () => number
  timeoutMs?: number
  freshForMs?: number
}

function isCatalog(value: unknown): value is DiscoveredCliModelCatalog {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DiscoveredCliModelCatalog>
  return (
    Array.isArray(candidate.models) &&
    candidate.models.every((model) => typeof model?.id === 'string' && model.id.length > 0) &&
    typeof candidate.fetchedAt === 'string' &&
    (candidate.source === 'argv-probe' || candidate.source === 'agent-sdk')
  )
}

// The file is app-owned; an entry that does not carry the recorded shape is
// dropped, which only costs one extra probe.
function parseCacheFile(raw: string): Catalogs {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return {}
  const catalogs = (parsed as { catalogs?: unknown }).catalogs
  if (!catalogs || typeof catalogs !== 'object') return {}
  return Object.fromEntries(
    Object.entries(catalogs).filter((entry): entry is [string, DiscoveredCliModelCatalog] => isCatalog(entry[1])),
  )
}

export function createFileModelDiscoveryCache(resolvePath: () => string): ModelDiscoveryCache {
  let current: Promise<Catalogs> | null = null
  let queue: Promise<void> = Promise.resolve()
  const load = (): Promise<Catalogs> => {
    current ??= readFile(resolvePath(), 'utf8')
      .then(parseCacheFile)
      .catch(() => ({}))
    return current
  }
  return {
    read: async () => ({ ...(await load()) }),
    update: (apply) => {
      const run = queue.then(async () => {
        const next = apply({ ...(await load()) })
        current = Promise.resolve(next)
        const path = resolvePath()
        const temp = `${path}.${process.pid}.tmp`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temp, `${JSON.stringify({ version: CACHE_FILE_VERSION, catalogs: next }, null, 2)}\n`, 'utf8')
        await rename(temp, path)
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}

let defaultCache: ModelDiscoveryCache | null = null

function defaultModelDiscoveryCache(): ModelDiscoveryCache {
  defaultCache ??= createFileModelDiscoveryCache(() => join(studioPlatform().paths.dataDir(), CACHE_FILE_NAME))
  return defaultCache
}

/**
 * What each CLI last reported, from main's own cache: the list a paired
 * device's model picker is built from, where there is no renderer copy to ask.
 */
export function readDiscoveredCliModelCatalogs(): Promise<Catalogs> {
  return defaultModelDiscoveryCache().read()
}

function defaultListClis(): RegisteredCli[] {
  return listPluginRegistryEntries().map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    binary: entry.binary,
  }))
}

// Rides detection's own cache, so the pass after boot detection reuses its
// answer instead of probing every CLI again.
function defaultDetect(clis: RegisteredCli[], cliRuntimes: CliRuntimes): Promise<AgentCliAvailabilityMap> {
  const ids = new Set(clis.map((cli) => cli.id))
  return detectAgentCliAvailability(
    { cliRuntimes },
    { listEntries: () => listPluginRegistryEntries().filter((entry) => ids.has(entry.id)) },
  )
}

// The time each id was first listed on this machine, carried forward by id.
// `baselines` in priority order (the renderer's copy, then main's cache); with
// none at all this is the CLI's first-ever catalog and no row is dated. A
// baseline with no rows is no baseline: the picker never showed it (an empty
// list reads as the seed), so nothing in the answer after it is news.
export function carryFirstSeenAt(
  models: readonly DiscoveredCliModel[],
  baselines: ReadonlyArray<DiscoveredCliModelCatalog | undefined>,
  nowIso: string,
): DiscoveredCliModel[] {
  const known = baselines.filter(
    (catalog): catalog is DiscoveredCliModelCatalog => Boolean(catalog) && (catalog?.models.length ?? 0) > 0,
  )
  const undated = models.map(({ firstSeenAt: _ignored, ...row }) => row)
  if (known.length === 0) return undated
  return undated.map((row) => {
    for (const catalog of known) {
      const previous = catalog.models.find((model) => model.id === row.id)
      if (previous) return previous.firstSeenAt ? { ...row, firstSeenAt: previous.firstSeenAt } : row
    }
    return { ...row, firstSeenAt: nowIso }
  })
}

function isFresh(
  catalog: DiscoveredCliModelCatalog | undefined,
  version: string | null,
  now: number,
  freshForMs: number,
): catalog is DiscoveredCliModelCatalog {
  if (!catalog) return false
  const age = now - Date.parse(catalog.fetchedAt)
  if (!Number.isFinite(age) || age < 0 || age >= freshForMs) return false
  return (catalog.cliVersion ?? null) === (version ?? null)
}

type ProbeOutcome = { ok: true; models: DiscoveredCliModel[] } | { ok: false; error: string }

// One probe per (cli, binary, WSL) at a time: the boot pass and a renderer
// refresh that overlap share the answer rather than starting the CLI twice.
const inFlight = new Map<string, Promise<ProbeOutcome>>()

function describeError(error: unknown, displayName: string): string {
  if (error instanceof CliModelProbeError) return error.message
  const detail = error instanceof Error ? error.message : String(error)
  return `${displayName} models could not be listed: ${detail}`
}

function runProbe(probe: CliModelProbe, context: Parameters<CliModelProbe['run']>[0]): Promise<ProbeOutcome> {
  const key = [context.cli, context.binary, context.hostId ?? 'local'].join('\u0000')
  const existing = inFlight.get(key)
  if (existing) return existing
  let guard: ReturnType<typeof setTimeout> | undefined
  const outcome = Promise.race([
    Promise.resolve()
      .then(() => probe.run(context))
      .then((models): ProbeOutcome => ({ ok: true, models })),
    new Promise<ProbeOutcome>((resolve) => {
      guard = setTimeout(
        () =>
          resolve({
            ok: false,
            error: `${context.displayName} did not list its models within ${Math.round(context.timeoutMs / 1000)} s.`,
          }),
        context.timeoutMs + SERVICE_GUARD_GRACE_MS,
      )
    }),
  ])
    .catch((error): ProbeOutcome => ({ ok: false, error: describeError(error, context.displayName) }))
    .finally(() => {
      if (guard) clearTimeout(guard)
      inFlight.delete(key)
    })
  inFlight.set(key, outcome)
  return outcome
}

export async function discoverCliModels(
  input: CliModelDiscoveryInput = {},
  deps: CliModelDiscoveryDeps = {},
): Promise<CliModelDiscoveryResult> {
  const now = deps.now ?? Date.now
  const startedAt = new Date(now()).toISOString()
  const finish = (entries: CliModelDiscoveryEntry[]): CliModelDiscoveryResult => ({
    entries,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
  })
  let registered: RegisteredCli[]
  try {
    registered = (deps.listClis ?? defaultListClis)()
  } catch {
    return finish([])
  }
  const wanted = input.clis ? new Set(input.clis) : null
  const clis = registered.filter((cli) => !wanted || wanted.has(cli.id))
  const probes = deps.probes ?? CLI_MODEL_PROBES
  const probed = clis.filter((cli) => probes[cli.id])
  const cliRuntimes = input.cliRuntimes ?? {}
  // The renderer's copy is only trusted in the shape main writes.
  const previous: Catalogs = Object.fromEntries(
    Object.entries(input.previous ?? {}).filter((entry): entry is [string, DiscoveredCliModelCatalog] =>
      isCatalog(entry[1]),
    ),
  )
  const cache = deps.cache ?? defaultModelDiscoveryCache()
  const timeoutMs = deps.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS
  const freshForMs = deps.freshForMs ?? MODEL_CATALOG_FRESH_FOR_MS
  const runArgv = deps.runArgv ?? runCliCommand

  let availability: AgentCliAvailabilityMap | null = null
  if (probed.length > 0) {
    try {
      availability = await (deps.detect ?? defaultDetect)(probed, cliRuntimes)
    } catch {
      availability = null
    }
  }
  const cached = await cache.read().catch((): Catalogs => ({}))
  const written: Catalogs = {}

  const entries = await Promise.all(
    clis.map(async (cli): Promise<CliModelDiscoveryEntry> => {
      const probe = probes[cli.id]
      if (!probe) return { cli: cli.id, catalog: null, skipped: 'no-probe' }
      const detected = availability?.[cli.id]
      if (!detected) {
        return {
          cli: cli.id,
          catalog: null,
          error: `Could not tell whether ${cli.displayName} is installed, so its models were not checked.`,
        }
      }
      if (!detected.installed) return { cli: cli.id, catalog: null, skipped: 'not-installed' }

      const own = cached[cli.id]
      const theirs = previous[cli.id]
      if (!input.force && isFresh(own ?? theirs, detected.version, now(), freshForMs)) {
        // Fresh by main's record. When the renderer holds something else (it
        // missed the broadcast, or its copy was cleared), hand main's copy over;
        // otherwise there is nothing to store.
        const handOver = own && own.fetchedAt !== theirs?.fetchedAt ? own : null
        return { cli: cli.id, catalog: handOver, skipped: 'fresh' }
      }

      const runtime: Partial<CliRuntimeSettings> | undefined = cliRuntimes[cli.id]
      const hostId = runtime?.hostId
      const command = typeof runtime?.command === 'string' ? runtime.command.trim() : ''
      const binary = detected.resolvedPath?.trim() || command || cli.binary
      const outcome = await runProbe(probe, {
        cli: cli.id,
        displayName: cli.displayName,
        binary,
        ...(hostId ? { hostId } : {}),
        timeoutMs,
        runArgv: (args) =>
          runArgv({ binary, args, ...(hostId ? { hostId } : {}), timeoutMs, setEnv: cliProbeEnv(cli.id) }),
      })
      if (!outcome.ok) return { cli: cli.id, catalog: null, error: outcome.error }
      // Every probe lists at least one model when it works, and the picker reads
      // an empty list as no answer and falls back to the seed. Storing one would
      // throw away the last good list, which rule 3 keeps; it would also leave an
      // empty baseline that dates every row of the next answer as new.
      if (outcome.models.length === 0) {
        return { cli: cli.id, catalog: null, error: `${cli.displayName} listed no models.` }
      }
      const fetchedAt = new Date(now()).toISOString()
      const catalog: DiscoveredCliModelCatalog = {
        models: carryFirstSeenAt(outcome.models, [theirs, own], fetchedAt),
        fetchedAt,
        source: probe.source,
      }
      if (detected.version) catalog.cliVersion = detected.version
      written[cli.id] = catalog
      return { cli: cli.id, catalog }
    }),
  )

  if (Object.keys(written).length > 0) {
    // A cache that cannot be written costs a re-probe next time, nothing more;
    // the answer still goes back to the renderer.
    await cache.update((catalogs) => ({ ...catalogs, ...written })).catch(() => undefined)
  }
  return finish(entries)
}
