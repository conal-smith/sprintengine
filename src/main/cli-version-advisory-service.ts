// The app-wide CLI version check, per machine: this one, and each WSL
// distribution turned on in Settings ▸ Machines. IPC (a Settings re-check), the
// poller and an install or update the app ran all come through here, so they
// share the npm cache and the enabled flag the Settings switch mirrors into
// main.
//
// Two different questions, asked at two different rates:
//
//   Which CLIs are installed, at which version   detection: a process per
//                                                installed CLI here, one helper
//                                                request per WSL machine
//   What is the newest release of each of those   one registry GET per package
//
// Detection runs at startup (`detectCliMachines`), again only when the person
// presses Re-check (`detect: true`), and for one CLI after the app installed or
// updated it (`noteCliDetected`). The hourly poll asks only the second
// question: it compares the installed versions detection last found
// (`knownCliAvailability`) against the registry, so it starts no process, never
// starts a stopped WSL distribution, and never asks about a CLI that is not
// installed.
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  AgentCli,
  AgentCliAvailabilityMap,
  CliDetectResult,
  CliRuntimeSettings,
  CliVersionAdvisoriesInput,
  CliVersionAdvisoriesResult,
  CliVersionAdvisory,
  CliVersionHostAdvisories,
  PluginDetectAvailabilityInput,
} from '../shared/electron-api'
import { isWslHostId, LOCAL_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { AgentLaunchSettings } from '../shared/launch-settings'
import type { PluginManifest } from '../shared/plugin-manifest'
import { detectAgentCliAvailability, knownCliAvailability, recordCliDetection } from './cli-availability'
import { fetchNpmLatestVersion, outdatedClis, resolveCliVersionAdvisories } from './cli-version-advisory'
import { getPluginManifest, listPluginRegistryEntries } from './plugin-registry-instance'
import { broadcastToAllWindows } from './window-broadcast'

const CLI_VERSION_ADVISORIES_CHANGED_CHANNEL = 'cli-version:advisories-changed'

/** One machine whose CLIs are checked, with each CLI's command on it. */
export type CliMachine = {
  hostId: ExecutionHostId
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
}

/**
 * The machines Settings ▸ Agents lists, from main's launch settings: this one
 * with the commands on `cliRuntimes`, then on Windows each WSL distribution
 * turned on, with that machine's own command overrides — the same runtimes the
 * Agents tab probes a machine with, so both read the same detection answers.
 * Read from settings alone: listing distributions would start `wsl.exe`.
 */
export function cliMachinesFromLaunchSettings(
  settings: Pick<AgentLaunchSettings, 'cliRuntimes' | 'hosts'>,
  platform: NodeJS.Platform,
  cliIds: readonly string[],
): CliMachine[] {
  const machines: CliMachine[] = [{ hostId: LOCAL_HOST_ID, cliRuntimes: { ...settings.cliRuntimes } }]
  if (platform !== 'win32') return machines
  for (const [id, host] of Object.entries(settings.hosts)) {
    if (!isWslHostId(id) || !host || host.enabled !== true) continue
    machines.push({
      hostId: id,
      cliRuntimes: Object.fromEntries(cliIds.map((cli) => [cli, { command: host.cliCommands[cli] ?? '', hostId: id }])),
    })
  }
  return machines
}

export type CliVersionAdvisoryBroadcast = (result: CliVersionAdvisoriesResult) => void

export type CliVersionServiceDeps = {
  machines: () => CliMachine[]
  /** Detection, which probes (cached until invalidated; `force` re-probes). */
  detect: (input: PluginDetectAvailabilityInput) => Promise<AgentCliAvailabilityMap>
  /** What detection last found, without probing. */
  known: (input: Pick<PluginDetectAvailabilityInput, 'cliRuntimes'>) => AgentCliAvailabilityMap
  record: (runtime: Partial<CliRuntimeSettings> | undefined, detected: CliDetectResult) => void
  getManifest: (cli: string) => PluginManifest | null | undefined
  fetchLatest: (packageName: string, force: boolean) => Promise<string | null>
  noticesPath: () => string
  broadcast: CliVersionAdvisoryBroadcast
}

// The (machine, cli, latestVersion) triples this install has already announced
// with a toast, on disk so a restart does not repeat them.
const CLI_UPDATE_NOTICES_FILENAME = 'cli-update-notices.json'

const defaultBroadcast: CliVersionAdvisoryBroadcast = (result) =>
  broadcastToAllWindows(CLI_VERSION_ADVISORIES_CHANGED_CHANNEL, result)

function defaultDeps(): CliVersionServiceDeps {
  return {
    machines: () => [{ hostId: LOCAL_HOST_ID, cliRuntimes: {} }],
    detect: (input) => detectAgentCliAvailability(input),
    known: (input) => knownCliAvailability(input),
    record: (runtime, detected) => recordCliDetection(runtime, detected),
    getManifest: (cli) => getPluginManifest(cli),
    fetchLatest: (pkg, force) => fetchNpmLatestVersion(pkg, { force }),
    noticesPath: () => join(app.getPath('userData'), CLI_UPDATE_NOTICES_FILENAME),
    broadcast: defaultBroadcast,
  }
}

let deps: CliVersionServiceDeps | null = null
// The Settings switch lives in the renderer, which mirrors it here once a
// window is up. Until then it is unknown, and a read that is not forced waits
// for it: startup detection usually finishes first, and comparing then would
// ask the registry for someone who turned checks off, and announce updates to
// a window that has not subscribed yet — spending the toast for good.
let enabled: boolean | null = null
let readWaitingForSwitch = false
let lastSignature: string | null = null
let announced: Promise<Set<string>> | null = null
let scheduledRead: ReturnType<typeof setTimeout> | null = null

function current(): CliVersionServiceDeps {
  if (!deps) deps = defaultDeps()
  return deps
}

/**
 * Installed once by app-services with the machines its launch settings name;
 * tests stand in for any part.
 */
export function configureCliVersionService(overrides: Partial<CliVersionServiceDeps>): void {
  deps = { ...current(), ...overrides }
}

/** Test seam: every piece of module state back to how a fresh process has it. */
export function resetCliVersionService(): void {
  deps = null
  enabled = null
  readWaitingForSwitch = false
  lastSignature = null
  announced = null
  if (scheduledRead) clearTimeout(scheduledRead)
  scheduledRead = null
}

/** The machines from the running app's launch settings, for app-services. */
export function launchSettingsCliMachines(settings: () => Pick<AgentLaunchSettings, 'cliRuntimes' | 'hosts'>) {
  return (): CliMachine[] =>
    cliMachinesFromLaunchSettings(
      settings(),
      process.platform,
      listPluginRegistryEntries().map((entry) => entry.id),
    )
}

// One load, shared: two reads arriving together (startup, a window's first
// read, a row's detection) must record into the same set, or the second
// replaces the first and a version is announced twice.
function loadAnnounced(): Promise<Set<string>> {
  if (!announced) {
    const path = current().noticesPath()
    announced = readFile(path, 'utf8')
      .then((text) => {
        const parsed = JSON.parse(text) as unknown
        return new Set(
          Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [],
        )
      })
      .catch(() => new Set<string>())
  }
  return announced
}

async function saveAnnounced(set: Set<string>): Promise<void> {
  try {
    const path = current().noticesPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify([...set].sort(), null, 2)}\n`, 'utf8')
  } catch {
    // Losing the file only means one repeated toast after a restart.
  }
}

// This machine's entries keep the spelling they had before other machines were
// checked, so an install that already announced a version does not again.
export function announcedKey(advisory: Pick<CliVersionAdvisory, 'cli' | 'hostId' | 'latestVersion'>): string {
  const pair = `${advisory.cli}@${advisory.latestVersion ?? ''}`
  return advisory.hostId === LOCAL_HOST_ID ? pair : `${advisory.hostId}|${pair}`
}

// Outdated CLIs not yet announced at this version; records them as announced.
async function takeNewlyOutdated(advisories: CliVersionHostAdvisories): Promise<CliVersionAdvisory[]> {
  const seen = await loadAnnounced()
  const fresh = Object.values(advisories)
    .flatMap((map) => (map ? outdatedClis(map) : []))
    .filter((advisory) => !seen.has(announcedKey(advisory)))
  if (fresh.length > 0) {
    for (const advisory of fresh) seen.add(announcedKey(advisory))
    await saveAnnounced(seen)
  }
  return fresh
}

export function setCliVersionChecksEnabled(next: boolean): boolean {
  enabled = next
  if (next && readWaitingForSwitch) {
    readWaitingForSwitch = false
    void readCliVersionAdvisories()
  }
  return enabled
}

const SCHEDULED_READ_DELAY_MS = 1_000

/**
 * Compare again soon, without detecting: what detection knows about a machine
 * changed (a CLI found, gone, or at a new version), or the machines themselves
 * did (a distribution turned on or off). Several changes in a burst — one
 * machine's CLIs answering one by one — are one read.
 */
export function scheduleCliVersionRead(): void {
  if (scheduledRead) clearTimeout(scheduledRead)
  scheduledRead = setTimeout(() => {
    scheduledRead = null
    void readCliVersionAdvisories()
  }, SCHEDULED_READ_DELAY_MS)
  scheduledRead.unref?.()
}

// Two reads with the same signature are the same answer for every window: which
// version each machine has of each CLI, and where that stands.
function advisoriesSignature(advisories: CliVersionHostAdvisories): string {
  return Object.values(advisories)
    .flatMap((map) => Object.values(map ?? {}))
    .map((entry) =>
      [entry!.hostId, entry!.cli, entry!.status, entry!.currentVersion ?? '', entry!.latestVersion ?? ''].join('\t'),
    )
    .sort()
    .join('\n')
}

/**
 * Detect every CLI on the machines named (all of them by default). Startup runs
 * this once — this machine while the splash is up, WSL machines after the
 * window is shown — and Re-check runs it with `force`. It may start a WSL
 * distribution's helper; nothing else in the version check does. Resolves to
 * how many machines it asked.
 */
export async function detectCliMachines(
  options: { force?: boolean; which?: 'all' | 'local' | 'wsl' } = {},
): Promise<number> {
  const which = options.which ?? 'all'
  const machines = current()
    .machines()
    .filter((machine) =>
      which === 'all' ? true : which === 'local' ? machine.hostId === LOCAL_HOST_ID : machine.hostId !== LOCAL_HOST_ID,
    )
  await Promise.all(
    machines.map((machine) =>
      current()
        .detect({ cliRuntimes: machine.cliRuntimes, ...(options.force ? { force: true } : {}) })
        .catch(() => undefined),
    ),
  )
  return machines.length
}

export async function readCliVersionAdvisories(
  input: CliVersionAdvisoriesInput = {},
  options: { broadcast?: CliVersionAdvisoryBroadcast; notify?: boolean } = {},
): Promise<CliVersionAdvisoriesResult> {
  try {
    if (input.detect) await detectCliMachines({ force: true })
    if (enabled !== true && !input.force) {
      if (enabled === null) readWaitingForSwitch = true
      return { ok: true, advisories: {}, checkedAt: new Date().toISOString() }
    }
    const service = current()
    const force = input.force === true
    // A package two machines both have is asked about once per read.
    const latest = new Map<string, Promise<string | null>>()
    const fetchLatest = (pkg: string): Promise<string | null> => {
      let pending = latest.get(pkg)
      if (!pending) {
        pending = service.fetchLatest(pkg, force)
        latest.set(pkg, pending)
      }
      return pending
    }
    const advisories: CliVersionHostAdvisories = {}
    await Promise.all(
      service.machines().map(async (machine) => {
        const availability = service.known({ cliRuntimes: machine.cliRuntimes })
        // Not detected yet (startup has not reached it, or its helper would
        // not start): nothing to compare, and nothing is probed to find out.
        if (Object.keys(availability).length === 0) return
        advisories[machine.hostId] = await resolveCliVersionAdvisories(availability, {
          hostId: machine.hostId,
          getManifest: service.getManifest,
          fetchLatest,
          force,
        })
      }),
    )
    const newlyOutdated = await takeNewlyOutdated(advisories)
    const result: CliVersionAdvisoriesResult = {
      ok: true,
      advisories,
      checkedAt: new Date().toISOString(),
      ...(newlyOutdated.length > 0 ? { newlyOutdated } : {}),
    }
    const signature = advisoriesSignature(advisories)
    const changed = newlyOutdated.length > 0 || lastSignature !== signature
    lastSignature = signature
    if (changed && options.notify !== false) (options.broadcast ?? service.broadcast)(result)
    return result
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * An install or update the app ran has detected its CLI again: that answer
 * replaces the old one for that CLI on that machine, and the advisories are
 * compared again from it — no other CLI, and no other machine, is probed — so
 * the update badge clears as soon as the new version is in.
 */
export async function noteCliDetected(
  runtime: Partial<CliRuntimeSettings> | undefined,
  detected: CliDetectResult,
): Promise<void> {
  current().record(runtime, detected)
  await readCliVersionAdvisories()
}

/** One CLI an Update everything runs: where, with which command, from which version to which. */
export type CliUpdateTarget = {
  hostId: ExecutionHostId
  cli: AgentCli
  runtime: Partial<CliRuntimeSettings> | undefined
  currentVersion: string | null
  latestVersion: string | null
}

/**
 * Every CLI behind its published version on a machine Settings lists, that
 * has an updater to run: what Update everything updates. Asked of the
 * registry afresh (the person is about to act on it), and compared from what
 * detection last found on each machine. Nobody is told of what it finds: the
 * badges already say it, and a toast offering an update being run would be
 * noise.
 */
export async function outdatedCliTargets(): Promise<
  { ok: true; targets: CliUpdateTarget[] } | { ok: false; message: string }
> {
  const read = await readCliVersionAdvisories({ force: true }, { notify: false })
  if (!read.ok) return read
  const targets: CliUpdateTarget[] = []
  for (const machine of current().machines()) {
    for (const advisory of outdatedClis(read.advisories[machine.hostId] ?? {})) {
      if (!advisory.updateCommand) continue
      targets.push({
        hostId: machine.hostId,
        cli: advisory.cli,
        runtime: machine.cliRuntimes[advisory.cli],
        currentVersion: advisory.currentVersion,
        latestVersion: advisory.latestVersion,
      })
    }
  }
  return { ok: true, targets }
}
