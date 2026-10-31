import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { AgentCli, CliDetectResult, CliRuntimeSettings, CliVersionAdvisoriesResult } from '../shared/electron-api'
import type { PluginManifest, PluginRegistryListEntry } from '../shared/plugin-manifest'
import {
  clearCliAvailabilityCache,
  detectAgentCliAvailability,
  knownCliAvailability,
  recordCliDetection,
  subscribeKnownCliAvailability,
} from './cli-availability'
import {
  cliMachinesFromLaunchSettings,
  configureCliVersionService,
  detectCliMachines,
  noteCliDetected,
  outdatedCliTargets,
  readCliVersionAdvisories,
  resetCliVersionService,
  setCliVersionChecksEnabled,
  type CliMachine,
} from './cli-version-advisory-service'
import { createHostedFeedPoller, POLLER_FEED_INTERVAL_MS, POLLER_FIRST_TICK_MS } from './hosted-feed/poller'

// The version check asks two questions at two rates (owner ruling 2026-09-25):
// which CLIs are installed, at which version — once at startup and on Re-check
// only — and what the registry's newest is, hourly, for the installed ones
// only. Every machine the Agents tab lists gets both, WSL distributions
// included, and their answers roll up per machine.

const WSL = 'wsl:Ubuntu' as const

function entry(id: string): PluginRegistryListEntry {
  return {
    id,
    displayName: id,
    source: 'bundled',
    version: 1,
    binary: id,
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
  }
}

const ENTRIES = [entry('codex'), entry('claude-code'), entry('grok')]
const MANIFESTS: Record<string, Partial<PluginManifest>> = {
  codex: { binary: 'codex', package: { npm: '@openai/codex' } },
  'claude-code': { binary: 'claude', package: { npm: '@anthropic-ai/claude-code' } },
  grok: { binary: 'grok', package: { npm: '@vibe-kit/grok-cli' } },
}

// What each machine has installed. grok is on neither, so nothing may ever ask
// the registry about it.
const INSTALLED: Record<string, Partial<Record<string, string>>> = {
  local: { codex: '0.41.0', 'claude-code': '2.1.0' },
  [WSL]: { codex: '0.39.0' },
}

let dir: string
let probes: Array<{ cli: string; hostId: string }>
let fetched: string[]
let pushed: CliVersionAdvisoriesResult[]

function probe(cli: AgentCli, runtime?: Partial<CliRuntimeSettings>): Promise<CliDetectResult> {
  const hostId = runtime?.hostId ?? 'local'
  probes.push({ cli, hostId })
  const version = INSTALLED[hostId]?.[cli] ?? null
  return Promise.resolve({
    cli,
    binary: cli,
    installed: version !== null,
    version,
    resolvedPath: version ? `/home/dev/.local/bin/${cli}` : null,
    hostId,
    error: null,
  })
}

function configure(machines: CliMachine[]): void {
  configureCliVersionService({
    machines: () => machines,
    detect: (input) => detectAgentCliAvailability(input, { listEntries: () => ENTRIES, detect: probe }),
    known: (input) => knownCliAvailability(input, { listEntries: () => ENTRIES }),
    record: (runtime, detected) => recordCliDetection(runtime, detected),
    getManifest: (cli) => (MANIFESTS[cli] ? ({ id: cli, ...MANIFESTS[cli] } as PluginManifest) : null),
    fetchLatest: async (pkg) => {
      fetched.push(pkg)
      return pkg === '@openai/codex' ? '0.41.0' : '2.1.0'
    },
    noticesPath: () => join(dir, 'cli-update-notices.json'),
    broadcast: (result) => pushed.push(result),
  })
}

const BOTH: CliMachine[] = [
  { hostId: 'local', cliRuntimes: {} },
  {
    hostId: WSL,
    cliRuntimes: Object.fromEntries(ENTRIES.map(({ id }) => [id, { command: '', hostId: WSL }])),
  },
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-version-service-'))
  probes = []
  fetched = []
  pushed = []
  clearCliAvailabilityCache()
  resetCliVersionService()
  configure(BOTH)
  // A window has said checks are on, as the renderer does once it is up.
  setCliVersionChecksEnabled(true)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetCliVersionService()
  clearCliAvailabilityCache()
})

test('a read before any detection probes nothing and says nothing', async () => {
  const result = await readCliVersionAdvisories()
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.advisories, {})
  assert.deepEqual(probes, [], 'the version check never detects on its own')
  assert.deepEqual(fetched, [])
})

test('startup detection, then the registry: each machine gets its own advisories', async () => {
  assert.equal(await detectCliMachines(), 2)
  assert.equal(probes.length, 6, 'every CLI on both machines, once')

  const result = await readCliVersionAdvisories()
  assert.ok(result.ok)
  assert.equal(result.advisories.local?.codex?.status, 'current')
  assert.equal(result.advisories.local?.codex?.hostId, 'local')
  assert.equal(result.advisories[WSL]?.codex?.status, 'behind_latest', 'the same CLI is behind on the distribution')
  assert.equal(result.advisories[WSL]?.codex?.currentVersion, '0.39.0')
  assert.equal(result.advisories[WSL]?.codex?.hostId, WSL)
  assert.equal(result.advisories.local?.grok?.status, 'unknown', 'not installed is never behind')
  assert.deepEqual(
    [...fetched].sort(),
    ['@anthropic-ai/claude-code', '@openai/codex'],
    'a package two machines share is asked once; one no machine has is never asked',
  )
  assert.deepEqual(
    result.newlyOutdated?.map((advisory) => `${advisory.hostId}/${advisory.cli}`),
    [`${WSL}/codex`],
    'the WSL update is announced as its own notice',
  )
  assert.equal(pushed.length, 1, 'and every window is told')
  assert.equal(probes.length, 6, 'the read itself probed nothing')

  const again = await readCliVersionAdvisories()
  assert.equal(again.ok && again.newlyOutdated, undefined, 'announced once per machine and version')
  assert.equal(pushed.length, 1, 'an unchanged answer is not pushed again')
})

test('the hourly poll compares against the registry and never detects', async () => {
  await detectCliMachines()
  const startupProbes = probes.length

  type Timer = { at: number; handler: () => void }
  let now = 0
  const timers: Timer[] = []
  // Each tick's read is awaited before the clock moves on: it writes the
  // announced file, and a tick still writing reschedules nothing yet.
  let tick: Promise<unknown> = Promise.resolve()
  const poller = createHostedFeedPoller({
    checkUpdates: async () => undefined,
    refreshFeed: async () => undefined,
    refreshVersions: () => (tick = readCliVersionAdvisories()),
    setTimer: (handler, ms) => {
      const timer = { at: now + ms, handler }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as Timer)
      if (index !== -1) timers.splice(index, 1)
    },
    now: () => now,
    random: () => 0.5,
  })
  poller.start()
  const until = POLLER_FIRST_TICK_MS + 3 * POLLER_FEED_INTERVAL_MS + 1
  for (;;) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (!next || next.at > until) break
    timers.shift()
    now = next.at
    next.handler()
    await tick
    // The poller reschedules in the leg's `finally`, a few microtasks later.
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  poller.stop()

  assert.equal(probes.length, startupProbes, 'four version ticks, not one probe on any machine')
  assert.ok(fetched.length >= 8, 'every tick asked the registry about the installed CLIs')
  assert.ok(!fetched.includes('@vibe-kit/grok-cli'), 'and never about the one nobody has')
})

test('Re-check detects every machine again, forcing past the held answer', async () => {
  await detectCliMachines()
  probes = []
  INSTALLED.local!.grok = '1.0.0'
  try {
    const result = await readCliVersionAdvisories({ detect: true, force: true })
    assert.equal(probes.length, 6, 'every CLI on both machines again')
    assert.ok(result.ok)
    assert.equal(result.advisories.local?.grok?.currentVersion, '1.0.0', 'a CLI installed outside the app appears')
    assert.ok(fetched.includes('@vibe-kit/grok-cli'), 'and only now is its registry asked')
  } finally {
    delete INSTALLED.local!.grok
  }
})

test('an update the app ran refreshes that CLI on that machine only, and the badge clears', async () => {
  await detectCliMachines()
  const before = await readCliVersionAdvisories()
  assert.equal(before.ok && before.advisories[WSL]?.codex?.status, 'behind_latest')
  probes = []
  pushed = []

  await noteCliDetected(
    { command: '', hostId: WSL },
    {
      cli: 'codex',
      binary: 'codex',
      installed: true,
      version: '0.41.0',
      resolvedPath: '/home/dev/.local/bin/codex',
      hostId: WSL,
      error: null,
    },
  )
  assert.deepEqual(probes, [], 'no re-scan: the update’s own detection is the answer')
  assert.equal(pushed.length, 1, 'every window hears the new answer')
  const pushedResult = pushed[0]
  assert.ok(pushedResult.ok)
  assert.equal(pushedResult.advisories[WSL]?.codex?.status, 'current')
  assert.equal(pushedResult.advisories[WSL]?.codex?.currentVersion, '0.41.0')
  assert.equal(pushedResult.advisories.local?.codex?.currentVersion, '0.41.0', 'this machine’s codex is untouched')
})

test('with checks off a read answers nothing, unless forced', async () => {
  await detectCliMachines()
  setCliVersionChecksEnabled(false)
  const off = await readCliVersionAdvisories()
  assert.deepEqual(off.ok && off.advisories, {})
  assert.deepEqual(fetched, [])
  const forced = await readCliVersionAdvisories({ force: true })
  assert.ok(forced.ok && forced.advisories.local?.codex)
})

test('the machines are the ones Settings ▸ Agents lists, from the launch settings alone', () => {
  const settings = {
    cliRuntimes: { codex: { command: '/opt/codex' } },
    hosts: {
      [WSL]: { enabled: true, cliCommands: { codex: '/home/dev/bin/codex' }, env: {} },
      'wsl:Debian': { enabled: false, cliCommands: {}, env: {} },
    },
  }
  const onWindows = cliMachinesFromLaunchSettings(settings, 'win32', ['codex', 'grok'])
  assert.deepEqual(
    onWindows.map((machine) => machine.hostId),
    ['local', WSL],
    'a distribution that is off is not checked',
  )
  assert.deepEqual(onWindows[0].cliRuntimes, { codex: { command: '/opt/codex' } })
  assert.deepEqual(onWindows[1].cliRuntimes, {
    codex: { command: '/home/dev/bin/codex', hostId: WSL },
    grok: { command: '', hostId: WSL },
  })
  assert.deepEqual(
    cliMachinesFromLaunchSettings(settings, 'darwin', ['codex']).map((machine) => machine.hostId),
    ['local'],
    'only Windows has WSL machines',
  )
})

test('before a window says whether checks are on, a read waits for it instead of announcing', async () => {
  resetCliVersionService()
  configure(BOTH)
  await detectCliMachines()
  const early = await readCliVersionAdvisories()
  assert.deepEqual(early.ok && early.advisories, {}, 'nothing compared yet')
  assert.deepEqual(fetched, [], 'and no registry request for someone who may have turned checks off')
  assert.equal(pushed.length, 0)

  // The waiting read is fire-and-forget, and it reads and writes the announced
  // file, so the case waits for its broadcast rather than for a number of turns.
  const broadcastSeen = new Promise<CliVersionAdvisoriesResult>((resolve) => {
    configureCliVersionService({
      broadcast: (result) => {
        pushed.push(result)
        resolve(result)
      },
    })
  })
  setCliVersionChecksEnabled(true)
  const first = await broadcastSeen
  assert.equal(pushed.length, 1, 'the waiting read runs once the window has subscribed and said yes')
  assert.ok(first.ok)
  assert.deepEqual(
    first.newlyOutdated?.map((advisory) => `${advisory.hostId}/${advisory.cli}`),
    [`${WSL}/codex`],
    'and the toast is not spent before anyone can hear it',
  )
})

test('a window that says checks are off gets no comparison and no registry request', async () => {
  resetCliVersionService()
  configure(BOTH)
  await detectCliMachines()
  await readCliVersionAdvisories()
  // Off starts no read at all, so there is nothing to wait for: a read that
  // did start would ask the registry before its first await.
  setCliVersionChecksEnabled(false)
  await Promise.resolve()
  assert.deepEqual(fetched, [])
  assert.equal(pushed.length, 0)
})

test('two reads at once announce each update once', async () => {
  await detectCliMachines()
  const [a, b] = await Promise.all([readCliVersionAdvisories(), readCliVersionAdvisories()])
  const announcedCount = [a, b].reduce((sum, result) => sum + ((result.ok && result.newlyOutdated?.length) || 0), 0)
  assert.equal(announcedCount, 1)
})

test('detection learning something new about a machine is heard; the same answer again is not', async () => {
  const heard: string[] = []
  const unsubscribe = subscribeKnownCliAvailability((hostId) => heard.push(hostId))
  try {
    await detectCliMachines()
    assert.ok(heard.includes(WSL) && heard.includes('local'), 'startup detection is news for both machines')
    heard.length = 0
    await detectCliMachines({ force: true })
    assert.deepEqual(heard, [], 'an unchanged answer is not')
    recordCliDetection(
      { command: '', hostId: WSL },
      {
        cli: 'codex',
        binary: 'codex',
        installed: true,
        version: '0.41.0',
        resolvedPath: null,
        hostId: WSL,
        error: null,
      },
    )
    assert.deepEqual(heard, [WSL], 'a new version on the distribution is')
  } finally {
    unsubscribe()
  }
})

test('a probe that started before an update was recorded does not write the old version back', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  configureCliVersionService({
    detect: (input) =>
      detectAgentCliAvailability(input, {
        listEntries: () => ENTRIES,
        detect: async (cli, runtime) => {
          await gate
          return probe(cli, runtime)
        },
      }),
  })
  const recheck = detectCliMachines({ force: true })
  recordCliDetection(
    { command: '', hostId: WSL },
    { cli: 'codex', binary: 'codex', installed: true, version: '0.41.0', resolvedPath: null, hostId: WSL, error: null },
  )
  release()
  await recheck
  const known = knownCliAvailability(
    { cliRuntimes: { codex: { command: '', hostId: WSL } } },
    { listEntries: () => ENTRIES },
  )
  assert.equal(known.codex?.version, '0.41.0', 'the recorded update stands')
})

test("Update everything lists each machine's CLIs behind the registry, with the command it runs there", async () => {
  await detectCliMachines()
  const listed = await outdatedCliTargets()
  assert.ok(listed.ok)
  assert.deepEqual(
    listed.targets.map((target) => ({
      hostId: target.hostId,
      cli: target.cli,
      runtime: target.runtime,
      from: target.currentVersion,
      to: target.latestVersion,
    })),
    [{ hostId: WSL, cli: 'codex', runtime: { command: '', hostId: WSL }, from: '0.39.0', to: '0.41.0' }],
  )
  assert.deepEqual(pushed, [], 'the windows are not told: the badges already say it')
  assert.ok(fetched.includes('@openai/codex'), 'the registry is asked afresh')
})
