import type {
  AgentCli,
  AgentCliAvailabilityMap,
  CliAvailability,
  CliDetectResult,
  CliRuntimeSettings,
  PluginDetectAvailabilityInput,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { detectCli, detectCliBatch, invalidateLoginShellPath, resolveInstallPlatform } from './cli-runtime-install'
import { userShellProbeSupported } from './login-shell-path'
import { LOCAL_HOST_ID, isWslHostId, type ExecutionHostId } from '../shared/execution-host'
import { listPluginRegistryEntries } from './plugin-registry-instance'

// Binary detection starts a process per installed CLI (its `--version`) on macOS
// and Linux, after one login shell per app session has said what PATH the
// person has; on Windows it is one process per target (see `detectCliBatch`),
// and on a WSL machine one request to its helper. None of that is worth
// repeating to learn nothing, so detection runs at startup, when the person
// presses Re-check in Settings ▸ Agents (`force`), and for one CLI after an
// install or update the app ran, or when that CLI's own row asks
// (`recordCliDetection`) — and at no other time.
//
// Every definitive probe is therefore held until something says it is stale,
// keyed by the exact (cli, command, machine) it ran against: a forced refresh,
// an install, a WSL helper reporting that a PATH directory changed. Window
// focus and visibility refresh the pickers in every window, model discovery
// and text generation ask as well, and all of them read this answer rather than
// starting a process. The hourly version check does not even do that much: it
// reads the last answer each machine gave (`knownCliAvailability`) and asks
// only the package registry.
//
// "Not installed" is the one answer that goes stale in a way nobody can see: a
// CLI updated in a terminal is absent for a moment, and one installed from a
// terminal arrives with no event. Held for good, the CLI would stay out of
// every picker until Re-check, so that answer goes stale, while a CLI that is
// there stays cached. On macOS and Linux looking for an absent CLI starts no
// process, so two minutes costs nothing; on Windows it starts a PowerShell or a
// `wsl.exe` for each machine, so it waits longer. A launch of a CLI believed
// missing looks again before refusing too (see `preflightAgentCliLaunch`).
const DEFAULT_CACHE_TTL_MS = Number.POSITIVE_INFINITY
const NOT_INSTALLED_TTL_MS = (process.platform === 'win32' ? 15 : 2) * 60 * 1000

const KEY_SEP = '\0'

type CacheEntry = { availability: CliAvailability; expiresAt: number }

function heldFor(availability: CliAvailability, ttlMs: number): number {
  return availability.installed ? ttlMs : Math.min(ttlMs, NOT_INSTALLED_TTL_MS)
}

const cache = new Map<string, CacheEntry>()

// The last definitive answer per key, kept when the cache entry is invalidated.
// The cache decides whether a caller's read probes; this is what the version
// check compares against the registry, and it must not forget a machine's
// installed versions only because a PATH directory there changed. A probe
// replaces it; nothing else does.
const known = new Map<string, CliAvailability>()

// Bumped per (cli, machine) each time `recordCliDetection` writes an answer. A
// probe that started before it — a Re-check still running when an update from
// a toast finishes — answers for the binary as it was, and must not write that
// over the newer one.
const recorded = new Map<string, number>()

function recordedGeneration(cli: AgentCli, hostId: ExecutionHostId): number {
  return recorded.get(`${cli}${KEY_SEP}${hostId}`) ?? 0
}

// Told when what detection knows about a machine's CLIs changed — a CLI found,
// gone, or at another version — however that detection came about: startup,
// Re-check, a WSL list opened for the first time, a row's own check. The
// version service compares again then, so a badge follows the answer without
// waiting for the hourly check.
const knownListeners = new Set<(hostId: ExecutionHostId) => void>()

export function subscribeKnownCliAvailability(listener: (hostId: ExecutionHostId) => void): () => void {
  knownListeners.add(listener)
  return () => knownListeners.delete(listener)
}

function setKnown(key: string, hostId: ExecutionHostId, availability: CliAvailability): void {
  const previous = known.get(key)
  known.set(key, availability)
  if (
    previous &&
    previous.installed === availability.installed &&
    previous.version === availability.version &&
    previous.resolvedPath === availability.resolvedPath
  ) {
    return
  }
  for (const listener of knownListeners) {
    try {
      listener(hostId)
    } catch {
      // A listener's failure is its own.
    }
  }
}

// Probes still running, keyed like the cache. A probe is a process start per CLI
// — on Windows a `powershell.exe` or `wsl.exe`, each of which takes a second or
// more to boot — and the callers are
// many and uncoordinated: window focus and visibility both refresh the pickers
// in every window, and boot discovery, model discovery and the version advisory
// all ask as well. Without this, each of those arriving before the first probe
// has answered started its own, and a burst of focus changes stacked them up.
const inFlight = new Map<string, Promise<CliDetectResult>>()

function cacheKey(cli: AgentCli, command: string, hostId: ExecutionHostId): string {
  return [cli, command, hostId].join(KEY_SEP)
}

function hostIdOf(runtime: Partial<CliRuntimeSettings> | undefined): ExecutionHostId {
  const hostId = runtime?.hostId
  return isWslHostId(hostId) ? hostId : LOCAL_HOST_ID
}

function normalizeCommand(runtime: Partial<CliRuntimeSettings> | undefined): string {
  return typeof runtime?.command === 'string' ? runtime.command.trim() : ''
}

// Drop cached availability for a CLI (every command and machine) or, with no
// argument, the whole cache. Called after a successful install so the next
// probe re-detects instead of returning a stale "not installed".
export function invalidateCliAvailability(cli?: AgentCli): void {
  // An install is what adds a directory to the person's shell config, so the
  // login-shell PATH is asked again as well.
  invalidateLoginShellPath()
  // A probe already running was started before whatever made the caller
  // invalidate, so its answer is as stale as the cache entry: forget it too.
  if (!cli) {
    cache.clear()
    inFlight.clear()
    return
  }
  const prefix = `${cli}${KEY_SEP}`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(prefix)) inFlight.delete(key)
  }
}

// Drop cached availability for everything on one machine: a WSL helper saw a
// PATH directory change there (a CLI installed or removed from a terminal).
export function invalidateCliAvailabilityOnHost(hostId: ExecutionHostId): void {
  const suffix = `${KEY_SEP}${hostId}`
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key)
  }
}

// What a detection of one CLI on one machine found outside a full refresh —
// after an install or update the app ran, or a row's own Re-check: its answer
// replaces every earlier one for that CLI on that machine (whatever command it
// was asked under), so the row, the pickers and the version check see the new
// version without a re-scan of every CLI. Other machines keep theirs: a CLI
// installed here says nothing about a distribution. A result that could not
// decide (`error`) only drops the old answers, so the next read looks again.
export function recordCliDetection(
  runtime: Partial<CliRuntimeSettings> | undefined,
  detected: CliDetectResult,
  deps: { now?: () => number; ttlMs?: number } = {},
): void {
  const hostId = hostIdOf(runtime)
  recorded.set(`${detected.cli}${KEY_SEP}${hostId}`, recordedGeneration(detected.cli, hostId) + 1)
  const prefix = `${detected.cli}${KEY_SEP}`
  const suffix = `${KEY_SEP}${hostId}`
  for (const map of [cache, inFlight]) {
    for (const key of [...map.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) map.delete(key)
    }
  }
  if (detected.error !== null) return
  const key = cacheKey(detected.cli, normalizeCommand(runtime), hostId)
  const availability: CliAvailability = {
    cli: detected.cli,
    installed: detected.installed,
    resolvedPath: detected.resolvedPath,
    version: detected.version,
  }
  const now = deps.now ?? Date.now
  cache.set(key, { availability, expiresAt: now() + heldFor(availability, deps.ttlMs ?? DEFAULT_CACHE_TTL_MS) })
  setKnown(key, hostId, availability)
}

// The last answer detection gave for each registered CLI under these runtimes,
// WITHOUT probing: a CLI never detected under its current command is simply
// absent. The hourly version check reads this, so it starts no process on any
// machine, and never starts a stopped WSL distribution.
export function knownCliAvailability(
  input?: Pick<PluginDetectAvailabilityInput, 'cliRuntimes'>,
  deps: Pick<DetectAgentCliAvailabilityDeps, 'listEntries'> = {},
): AgentCliAvailabilityMap {
  const listEntries = deps.listEntries ?? listPluginRegistryEntries
  const runtimes = input?.cliRuntimes ?? {}
  const result: AgentCliAvailabilityMap = {}
  for (const entry of listEntries()) {
    const runtime = runtimes[entry.id]
    const answer = known.get(cacheKey(entry.id, normalizeCommand(runtime), hostIdOf(runtime)))
    if (answer) result[entry.id] = answer
  }
  return result
}

// Test seam: reset module state between cases.
export function clearCliAvailabilityCache(): void {
  cache.clear()
  known.clear()
  recorded.clear()
  inFlight.clear()
  maxConcurrentProbes = DEFAULT_MAX_CONCURRENT_PROBES
}

// Test seam: the Windows probe limit, asserted from any platform.
export function setMaxConcurrentCliProbes(limit: number): void {
  maxConcurrentProbes = limit
}

// How many probes run at once. On Windows each is a `powershell.exe` (or a
// `wsl.exe` login shell) that costs tens of megabytes and a second or more of
// CPU to start, and the registry holds around ten CLIs: all of them at once is
// a spike of process starts every time the cache runs out, arriving on window
// focus — the moment the person is about to type. A few at a time spreads that
// out; the answer is for background pickers, so it can afford to arrive later.
// POSIX probes are a directory walk and one `--version` each, sharing one
// login-shell PATH, and stay unbounded.
const DEFAULT_MAX_CONCURRENT_PROBES = process.platform === 'win32' ? 3 : Number.POSITIVE_INFINITY
let maxConcurrentProbes = DEFAULT_MAX_CONCURRENT_PROBES

let runningProbes = 0
const probeQueue: Array<() => void> = []

async function withProbeSlot<T>(run: () => Promise<T>): Promise<T> {
  // A finished probe hands its slot straight to the next waiter rather than
  // freeing it, so a caller arriving in between cannot take it as well.
  if (runningProbes >= maxConcurrentProbes) await new Promise<void>((resolve) => probeQueue.push(resolve))
  else runningProbes += 1
  try {
    return await run()
  } finally {
    const next = probeQueue.shift()
    if (next) next()
    else runningProbes -= 1
  }
}

// One probe per key at a time. A `force` caller (right after an install) must
// not be handed a probe that started before the install finished, so it starts
// its own — and becomes the one later callers join.
function probeOnce(key: string, force: boolean, run: () => Promise<CliDetectResult>): Promise<CliDetectResult> {
  const running = force ? undefined : inFlight.get(key)
  if (running) return running
  return trackInFlight(key, withProbeSlot(run))
}

// Registers a probe as the one in flight for `key` until it settles.
function trackInFlight(key: string, running: Promise<CliDetectResult>): Promise<CliDetectResult> {
  const probe = running.finally(() => {
    if (inFlight.get(key) === probe) inFlight.delete(key)
  })
  inFlight.set(key, probe)
  return probe
}

export type DetectAgentCliAvailabilityDeps = {
  listEntries?: () => PluginRegistryListEntry[]
  detect?: (
    cli: AgentCli,
    runtime?: Partial<CliRuntimeSettings>,
    options?: { force?: boolean },
  ) => Promise<CliDetectResult>
  // Probes many CLIs of one target in one process. Used on Windows, where each
  // probe process costs a second or more; a caller that injects only `detect`
  // (a test) keeps the per-CLI path.
  detectBatch?: (
    requests: Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>,
    options?: { force?: boolean },
  ) => Promise<CliDetectResult[]>
  platform?: NodeJS.Platform
  now?: () => number
  ttlMs?: number
}

function probeFailure(
  cli: AgentCli,
  runtime: Partial<CliRuntimeSettings> | undefined,
  error: unknown,
): CliDetectResult {
  return {
    cli,
    binary: normalizeCommand(runtime) || cli,
    installed: false,
    version: null,
    resolvedPath: null,
    hostId: hostIdOf(runtime),
    error: error instanceof Error ? error.message : String(error),
  }
}

// Probe every registered agent CLI and report which binaries are actually
// installed. Honors per-CLI command overrides, and the machine each names,
// forwarded by the renderer so detection matches the launch path. Probes run concurrently;
// only successful probes (no error) are cached.
//
// On Windows the cache misses are grouped by machine — each WSL distribution,
// and this PC natively — and each group is ONE probe process, however
// many CLIs it holds. Each CLI's key is still registered as in flight, so a
// caller arriving while the batch runs joins it rather than starting another.
export async function detectAgentCliAvailability(
  input?: PluginDetectAvailabilityInput,
  deps: DetectAgentCliAvailabilityDeps = {},
): Promise<AgentCliAvailabilityMap> {
  const listEntries = deps.listEntries ?? listPluginRegistryEntries
  const detect =
    deps.detect ??
    ((cli: AgentCli, runtime?: Partial<CliRuntimeSettings>, options?: { force?: boolean }) =>
      detectCli(cli, runtime, undefined, options))
  const platform = deps.platform ?? process.platform
  const detectBatch =
    platform === 'win32'
      ? (deps.detectBatch ?? (deps.detect ? undefined : (requests, options) => detectCliBatch(requests, options)))
      : undefined
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DEFAULT_CACHE_TTL_MS
  const runtimes = input?.cliRuntimes ?? {}
  const force = input?.force ?? false

  const entries = listEntries()
  const result: AgentCliAvailabilityMap = {}
  // A forced refresh is "look again, something changed": the PATH is part of
  // what may have. Dropped once, before any probe starts, so every probe in
  // this refresh shares the one shell that answers it.
  if (force) invalidateLoginShellPath()

  const record = (
    cli: AgentCli,
    key: string,
    detected: CliDetectResult,
    hostId: ExecutionHostId,
    generation: number,
  ): void => {
    // Something newer was recorded for this CLI on this machine while the
    // probe ran: serve that, and keep it.
    if (recordedGeneration(cli, hostId) !== generation) {
      const newer = cache.get(key)?.availability
      if (newer) result[cli] = newer
      return
    }
    // A transient probe failure (shell spawn error, not a clean "not found")
    // reports installed:false, which the renderer cannot distinguish from a
    // real absence. Treating it as "not installed" would wrongly HIDE an
    // actually-installed CLI from deployment pickers. So on error we omit the
    // CLI from the map entirely — the renderer treats a missing entry as
    // "unknown" and keeps it visible — and skip the cache so the next refresh
    // re-probes. Only a definitive probe (error === null) decides installed.
    if (detected.error !== null) return
    const availability: CliAvailability = {
      cli,
      installed: detected.installed,
      resolvedPath: detected.resolvedPath,
      version: detected.version,
    }
    result[cli] = availability
    cache.set(key, { availability, expiresAt: now() + heldFor(availability, ttlMs) })
    setKnown(key, hostId, availability)
  }

  const tasks: Promise<void>[] = []
  const batches = new Map<
    string,
    Array<{
      cli: AgentCli
      runtime?: Partial<CliRuntimeSettings>
      key: string
      hostId: ExecutionHostId
      generation: number
    }>
  >()
  for (const entry of entries) {
    const cli = entry.id
    const runtime = runtimes[cli]
    const command = normalizeCommand(runtime)
    const hostId = hostIdOf(runtime)
    const key = cacheKey(cli, command, hostId)
    const generation = recordedGeneration(cli, hostId)

    if (!force) {
      const cached = cache.get(key)
      if (cached && cached.expiresAt > now()) {
        result[cli] = cached.availability
        continue
      }
      const running = inFlight.get(key)
      if (running) {
        tasks.push(running.then((detected) => record(cli, key, detected, hostId, generation)))
        continue
      }
    }

    if (detectBatch) {
      const group = hostId
      const members = batches.get(group) ?? []
      members.push({ cli, ...(runtime ? { runtime } : {}), key, hostId, generation })
      batches.set(group, members)
      continue
    }

    tasks.push(
      probeOnce(key, force, () => detect(cli, runtime, force ? { force: true } : undefined)).then((detected) =>
        record(cli, key, detected, hostId, generation),
      ),
    )
  }

  for (const members of batches.values()) {
    const batch = withProbeSlot(() =>
      detectBatch!(
        members.map(({ cli, runtime }) => ({ cli, runtime })),
        force ? { force: true } : undefined,
      ),
    )
    for (const member of members) {
      const probe = batch
        .then(
          (results) =>
            results.find((detected) => detected.cli === member.cli) ??
            probeFailure(member.cli, member.runtime, 'The batch returned no answer for this CLI.'),
        )
        .catch((error: unknown) => probeFailure(member.cli, member.runtime, error))
      trackInFlight(member.key, probe)
      tasks.push(probe.then((detected) => record(member.cli, member.key, detected, member.hostId, member.generation)))
    }
  }

  await Promise.all(tasks)
  return result
}

// Exit code reported for a spawn refused because its agent CLI binary could not
// be resolved. 127 is the shell's own "command not found", and the in-script
// guard exits with it too, so both halves of the failure read alike.
const AGENT_CLI_NOT_FOUND_EXIT = 127

// What the launch path learned about an agent CLI's binary before spawning it.
// `unknown` is a real answer, not a soft failure: the probe could not decide, so
// the launch proceeds exactly as it did before this pre-flight existed.
export type AgentCliLaunchPreflight =
  { status: 'resolved'; binaryPath: string } | { status: 'unknown' } | { status: 'missing'; message: string }

// Resolves the binary a launch should execute, and refuses the launch when the
// CLI is definitively absent.
//
// Why the launch cannot just render the manifest binary name: availability is
// looked up on the PATH the user's own interactive shell reports (`$SHELL -ilc`,
// which sources ~/.zshrc) while agents launch in a non-interactive login shell
// that does not. A CLI whose PATH entry lives only in ~/.zshrc — the common
// fresh-Mac nvm/installer setup — is therefore detected as installed and then
// invisible at launch. Executing the probe's own absolute `resolvedPath` closes
// that gap.
//
// The verdict rides `detectAgentCliAvailability`'s cache (invalidated after an
// install), so repeat spawns do not re-probe; only this CLI is probed on a
// cache miss, or when the cache says it is missing.
export async function preflightAgentCliLaunch(
  input: {
    cli: AgentCli
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
    platform?: NodeJS.Platform
    shell?: string
  },
  deps: DetectAgentCliAvailabilityDeps = {},
): Promise<AgentCliLaunchPreflight> {
  const listEntries = deps.listEntries ?? listPluginRegistryEntries
  const runtime = input.cliRuntimes?.[input.cli]
  const target = resolveInstallPlatform(input.platform ?? process.platform, runtime?.hostId)
  // Without the user's own shell to ask for a PATH (Windows, WSL, fish, no
  // $SHELL) an "absent" verdict only means a plain `bash -lc` could not see the
  // binary — not that it is missing. Blocking on that would refuse launches that
  // work today, so those setups keep their existing behaviour.
  if (!userShellProbeSupported(target, input.shell ?? process.env.SHELL)) return { status: 'unknown' }

  const entry = listEntries().find((candidate) => candidate.id === input.cli)
  if (!entry) return { status: 'unknown' }

  const onlyThis = { ...deps, listEntries: () => [entry] }
  let availability = await detectAgentCliAvailability({ cliRuntimes: input.cliRuntimes }, onlyThis)
  // The cache holds an answer until Re-check, so "not installed" may be from
  // before the person installed it in a terminal. Refusing a launch is worth
  // one probe of this CLI to be sure; a found CLI launches from the cache.
  if (availability[input.cli]?.installed === false) {
    availability = await detectAgentCliAvailability({ cliRuntimes: input.cliRuntimes, force: true }, onlyThis)
  }
  const detected = availability[input.cli]
  // Absent from the map means the probe errored (see above) — never a verdict.
  if (!detected) return { status: 'unknown' }
  if (!detected.installed) {
    return {
      status: 'missing',
      message:
        `${entry.displayName} is not installed on this machine, so nothing was started. ` +
        'Install it from Settings → Agents, or set its command there.',
    }
  }
  // The probe only reports an absolute executable path, so a resolved path is
  // spawnable as-is; an installed CLI with no path still launches by name,
  // exactly as before.
  const binaryPath = detected.resolvedPath?.trim()
  if (!binaryPath || !binaryPath.startsWith('/')) return { status: 'unknown' }
  return { status: 'resolved', binaryPath }
}

// The spawn IPC's failure value for a refused launch. Lives beside the verdict
// so the shape the renderer receives is asserted where the verdict is produced;
// `terminal-runtime` returns exactly this.
export function agentCliLaunchFailureResult(
  preflight: AgentCliLaunchPreflight,
  sessionId: string,
): TerminalSpawnResult | null {
  if (preflight.status !== 'missing') return null
  return { ok: false, sessionId, message: preflight.message, exitCode: AGENT_CLI_NOT_FOUND_EXIT }
}
