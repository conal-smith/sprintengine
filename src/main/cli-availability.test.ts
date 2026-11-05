import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentCli, CliDetectResult, CliRuntimeSettings } from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import {
  agentCliLaunchFailureResult,
  clearCliAvailabilityCache,
  detectAgentCliAvailability,
  invalidateCliAvailability,
  invalidateCliAvailabilityOnHost,
  knownCliAvailability,
  preflightAgentCliLaunch,
  recordCliDetection,
  setMaxConcurrentCliProbes,
} from './cli-availability'

function entry(id: string, displayName = id): PluginRegistryListEntry {
  return {
    id,
    displayName,
    source: 'bundled',
    version: 1,
    binary: id,
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
  }
}

function detected(cli: AgentCli, installed: boolean, error: string | null = null): CliDetectResult {
  return {
    cli,
    binary: cli,
    installed,
    version: installed ? '1.0.0' : null,
    resolvedPath: installed ? `/usr/bin/${cli}` : null,
    hostId: 'local',
    error,
  }
}

test('reports installed flag per registered CLI', async () => {
  clearCliAvailabilityCache()
  const result = await detectAgentCliAvailability(undefined, {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli) => detected(cli, cli === 'codex'),
    now: () => 1000,
  })
  assert.equal(result.codex.installed, true)
  assert.equal(result.codex.resolvedPath, '/usr/bin/codex')
  assert.equal(result['claude-code'].installed, false)
  assert.equal(result['claude-code'].resolvedPath, null)
})

test('caches a successful probe within the TTL window', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await detectAgentCliAvailability(undefined, deps)
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 1)
})

test('re-probes once the cache entry expires', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  let clock = 1000
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => clock,
    ttlMs: 100,
  }
  await detectAgentCliAvailability(undefined, deps)
  clock = 1200 // past the 100ms TTL
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 2)
})

// Detection runs at startup and on Re-check, and at no other time: focus and
// visibility refresh the pickers, and every one of those reads the answer
// startup found rather than re-running each CLI's `--version`.
test('the default cache holds an answer until something says it is stale', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  let clock = 1000
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => clock,
  }
  await detectAgentCliAvailability(undefined, deps)
  clock += 24 * 60 * 60_000
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 1, 'still the startup answer a day later')
  await detectAgentCliAvailability({ force: true }, deps)
  assert.equal(probes, 2, 'Re-check (force) probes again')
})

// The version check compares what detection last found, and must keep it when
// a WSL helper reports a PATH change there: that drops the probe cache so the
// next read looks again, not the installed versions the badges are built on.
test('knownCliAvailability reads the last answer without probing, and survives an invalidation', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const wsl: Partial<CliRuntimeSettings> = { command: '', hostId: 'wsl:Ubuntu' }
  const deps = {
    listEntries: () => [entry('codex'), entry('grok')],
    detect: async (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => {
      probes += 1
      return { ...detected(cli, cli === 'codex'), hostId: runtime?.hostId ?? 'local' }
    },
    now: () => 1000,
  }
  assert.deepEqual(knownCliAvailability({ cliRuntimes: { codex: wsl, grok: wsl } }, deps), {}, 'nothing yet')
  await detectAgentCliAvailability({ cliRuntimes: { codex: wsl, grok: wsl } }, deps)
  assert.equal(probes, 2)

  const known = knownCliAvailability({ cliRuntimes: { codex: wsl, grok: wsl } }, deps)
  assert.equal(known.codex?.installed, true)
  assert.equal(known.grok?.installed, false, 'a definitive absence is known too')
  assert.deepEqual(knownCliAvailability({ cliRuntimes: {} }, deps), {}, 'this machine was never asked')

  invalidateCliAvailabilityOnHost('wsl:Ubuntu')
  assert.equal(
    knownCliAvailability({ cliRuntimes: { codex: wsl, grok: wsl } }, deps).codex?.version,
    '1.0.0',
    'the installed version outlives the PATH change',
  )
  assert.equal(probes, 2, 'and reading it probed nothing')
})

// An install or update the app ran re-detects its one CLI; that answer replaces
// the old one so the row and the badge move without a re-scan.
test('recordCliDetection replaces one CLI’s answer on one machine', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex'), entry('opencode')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 1000,
  }
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.equal(probes, 2)
  recordCliDetection({ command: '' }, { ...detected('codex', true), version: '1.1.0' })
  const after = await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.equal(after.codex?.version, '1.1.0', 'the recorded version is served')
  assert.equal(after.opencode?.version, '1.0.0')
  assert.equal(probes, 2, 'and nothing was probed again')
  assert.equal(knownCliAvailability({ cliRuntimes: {} }, deps).codex?.version, '1.1.0')

  recordCliDetection({ command: '' }, detected('codex', false, 'the helper did not answer'))
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.equal(probes, 3, 'an undecided result drops the old answer so the next read looks again')

  // Another machine's answer for the same CLI is its own.
  const wsl = { codex: { command: '', hostId: 'wsl:Ubuntu' as const } }
  await detectAgentCliAvailability({ cliRuntimes: wsl }, deps)
  assert.equal(probes, 4, 'codex on the distribution; opencode is still this machine’s, held')
  recordCliDetection({ command: '' }, { ...detected('codex', true), version: '1.2.0' })
  await detectAgentCliAvailability({ cliRuntimes: wsl }, deps)
  assert.equal(probes, 4, 'recording this machine’s codex leaves the distribution’s answer held')
})

// A CLI installed from a terminal a moment ago can still read as missing, and
// would be refused. A launch looks again first.
test('pre-flight probes again before refusing a CLI the cache calls missing', async () => {
  clearCliAvailabilityCache()
  let installed = false
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return { ...detected(cli, installed), resolvedPath: installed ? `/usr/local/bin/${cli}` : null }
    },
    now: () => 1000,
  }
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  installed = true
  const result = await preflightAgentCliLaunch({ cli: 'codex', ...POSIX_SETUP }, deps)
  assert.deepEqual(result, { status: 'resolved', binaryPath: '/usr/local/bin/codex' })
  assert.equal(probes, 2, 'one more probe, for this CLI')
})

test('force bypasses the cache', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await detectAgentCliAvailability(undefined, deps)
  await detectAgentCliAvailability({ force: true }, deps)
  assert.equal(probes, 2)
})

test('omits an errored probe from the map and does not cache it', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli: AgentCli) => {
      probes += 1
      // codex probes cleanly (installed); claude-code's probe errors transiently.
      return cli === 'codex' ? detected(cli, true) : detected(cli, false, 'shell spawn failed')
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  const first = await detectAgentCliAvailability(undefined, deps)
  // An errored probe must NOT appear as installed:false — it is omitted so the
  // renderer treats it as unknown and keeps the CLI visible.
  assert.equal('claude-code' in first, false, 'errored CLI is absent from the map')
  assert.equal(first.codex.installed, true)
  // codex (clean) is cached; claude-code (errored) is not, so it re-probes.
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 3, 'codex cached (1 probe), claude-code re-probed (2 probes)')
})

test('concurrent callers share one probe per CLI instead of each starting one', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      await gate
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  // Focus and visibility arrive together, in more than one window.
  const pending = [
    detectAgentCliAvailability(undefined, deps),
    detectAgentCliAvailability(undefined, deps),
    detectAgentCliAvailability(undefined, deps),
  ]
  release()
  const results = await Promise.all(pending)
  assert.equal(probes, 1, 'one probe answered all three callers')
  for (const result of results) assert.equal(result.codex.installed, true)
})

test('a forced refresh does not join a probe that started before it', async () => {
  clearCliAvailabilityCache()
  const answers: boolean[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      // The first probe began before the install and answers "absent".
      const installed = probes > 1
      if (!installed) await gate
      answers.push(installed)
      return detected(cli, installed)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  const stale = detectAgentCliAvailability(undefined, deps)
  const forced = await detectAgentCliAvailability({ force: true }, deps)
  release()
  await stale
  assert.equal(probes, 2)
  assert.equal(forced.codex.installed, true, 'the forced caller saw its own fresh probe')
})

test('an errored probe is shared while it runs but still not cached', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, false, 'shell spawn failed')
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await Promise.all([detectAgentCliAvailability(undefined, deps), detectAgentCliAvailability(undefined, deps)])
  assert.equal(probes, 1)
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 2, 'the next refresh after it settled re-probes')
})

test('probes run a bounded number at a time and every CLI still gets an answer', async () => {
  clearCliAvailabilityCache()
  setMaxConcurrentCliProbes(2)
  let running = 0
  let peak = 0
  const clis = ['codex', 'claude-code', 'gemini', 'opencode', 'cursor']
  const deps = {
    listEntries: () => clis.map((id) => entry(id)),
    detect: async (cli: AgentCli) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  const result = await detectAgentCliAvailability(undefined, deps)
  clearCliAvailabilityCache()
  assert.equal(peak, 2)
  assert.deepEqual(Object.keys(result).sort(), [...clis].sort())
})

test('invalidateCliAvailability forces a re-probe for one CLI only', async () => {
  clearCliAvailabilityCache()
  const probes: Record<string, number> = { codex: 0, 'claude-code': 0 }
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli: AgentCli) => {
      probes[cli] += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await detectAgentCliAvailability(undefined, deps)
  invalidateCliAvailability('claude-code')
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes.codex, 1) // still cached
  assert.equal(probes['claude-code'], 2) // invalidated -> re-probed
})

test('keys the cache by command/WSL override so a changed override re-probes', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  const runtimes: Record<AgentCli, Partial<CliRuntimeSettings>> = { codex: { command: '/a/codex' } }
  await detectAgentCliAvailability({ cliRuntimes: runtimes }, deps)
  await detectAgentCliAvailability({ cliRuntimes: { codex: { command: '/b/codex' } } }, deps)
  assert.equal(probes, 2)
})

// The boot-discovery contract (see boot-discovery.ts). The splash pass probes
// with NO input; the renderer's first refreshCliAvailability probes with the
// profile's cliRuntimes. For every CLI the user has not given a custom command,
// both resolve to the same cache key, so the renderer reads the boot result
// instead of spawning a second login shell per CLI moments later. Break this and
// the splash makes launch slower, not faster.
test('a boot-style probe warms the cache for the renderer first refresh', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }

  // Boot discovery: no input at all.
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 2, 'boot probes each registered CLI once')

  // The renderer, moments later, with a settings object that carries no command
  // overrides — the shape a fresh profile has.
  await detectAgentCliAvailability({ cliRuntimes: { codex: {}, 'claude-code': {} } }, deps)
  assert.equal(probes, 2, 'the renderer refresh spawns nothing: every CLI hits the boot cache')
})

// The other half of the same contract: a CLI the user HAS pointed at a custom
// binary must re-probe, because a different command is a different question.
test('a CLI with a command override still re-probes after boot', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }

  await detectAgentCliAvailability(undefined, deps)
  await detectAgentCliAvailability({ cliRuntimes: { codex: { command: '/opt/custom/codex' } } }, deps)
  assert.equal(probes, 3, 'only the overridden CLI re-probes; the other still hits the boot cache')
})

// The launch pre-flight. A POSIX setup with a zsh/bash $SHELL is where
// the full probe chain runs (primary `bash -lc` + the interactive fallback), so
// it is the only setup whose verdict a launch may act on.
const POSIX_SETUP = { platform: 'darwin' as NodeJS.Platform, shell: '/bin/zsh' }

test('pre-flight hands the launch the probed absolute path', async () => {
  clearCliAvailabilityCache()
  const result = await preflightAgentCliLaunch(
    { cli: 'claude-code', ...POSIX_SETUP },
    {
      listEntries: () => [entry('codex'), entry('claude-code', 'Claude Code')],
      detect: async (cli) => ({ ...detected(cli, true), resolvedPath: '/Users/dev/.nvm/bin/claude' }),
      now: () => 1000,
    },
  )
  assert.deepEqual(result, { status: 'resolved', binaryPath: '/Users/dev/.nvm/bin/claude' })
})

// The whole point of the honest failure: no spawn, a message the person can act
// on, and the CLI named in it.
test('pre-flight refuses a launch whose binary is definitively absent', async () => {
  clearCliAvailabilityCache()
  const result = await preflightAgentCliLaunch(
    { cli: 'claude-code', ...POSIX_SETUP },
    {
      listEntries: () => [entry('claude-code', 'Claude Code')],
      detect: async (cli) => detected(cli, false),
      now: () => 1000,
    },
  )
  assert.equal(result.status, 'missing')
  const message = result.status === 'missing' ? result.message : ''
  assert.match(message, /Claude Code/, 'the message names the CLI')
  assert.match(message, /Settings/, 'the message says where to fix it')

  // The exact value the spawn IPC returns to the renderer.
  assert.deepEqual(agentCliLaunchFailureResult(result, 'session-7'), {
    ok: false,
    sessionId: 'session-7',
    message,
    exitCode: 127,
  })
  assert.equal(
    agentCliLaunchFailureResult({ status: 'unknown' }, 'session-7'),
    null,
    'an undecided probe is not a failure',
  )
})

// A probe that could not answer (transient shell failure — omitted from the map)
// must never read as "missing": that would refuse launches that work.
test('pre-flight stays undecided when the probe could not answer', async () => {
  clearCliAvailabilityCache()
  const errored = await preflightAgentCliLaunch(
    { cli: 'codex', ...POSIX_SETUP },
    {
      listEntries: () => [entry('codex')],
      detect: async (cli) => detected(cli, false, 'shell spawn failed'),
      now: () => 1000,
    },
  )
  assert.deepEqual(errored, { status: 'unknown' })

  // Installed, but the probe printed no path sentinel: launch by name as before.
  clearCliAvailabilityCache()
  const pathless = await preflightAgentCliLaunch(
    { cli: 'codex', ...POSIX_SETUP },
    {
      listEntries: () => [entry('codex')],
      detect: async (cli) => ({ ...detected(cli, true), resolvedPath: null }),
      now: () => 1000,
    },
  )
  assert.deepEqual(pathless, { status: 'unknown' })

  // An unregistered CLI has no probe to trust either.
  clearCliAvailabilityCache()
  const unregistered = await preflightAgentCliLaunch(
    { cli: 'not-a-plugin', ...POSIX_SETUP },
    { listEntries: () => [entry('codex')], detect: async (cli) => detected(cli, true), now: () => 1000 },
  )
  assert.deepEqual(unregistered, { status: 'unknown' })
})

// Without the interactive fallback probe (Windows, WSL, fish, no $SHELL) an
// "absent" verdict only means the primary probe could not see the binary.
// Blocking on it would refuse launches that work today.
test('pre-flight never blocks where the interactive fallback probe cannot run', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('claude-code', 'Claude Code')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, false)
    },
    now: () => 1000,
  }
  // An empty shell is "this machine exposes no $SHELL"; omitting the field means
  // "read the real one", which is the production default, not a case under test.
  for (const setup of [
    { platform: 'win32' as NodeJS.Platform, shell: '/bin/zsh' },
    { platform: 'darwin' as NodeJS.Platform, shell: '/opt/homebrew/bin/fish' },
    { platform: 'linux' as NodeJS.Platform, shell: '' },
  ]) {
    assert.deepEqual(
      await preflightAgentCliLaunch({ cli: 'claude-code', ...setup }, deps),
      { status: 'unknown' },
      `${setup.platform}/${setup.shell || 'no shell'} must keep its existing behaviour`,
    )
  }
  assert.equal(probes, 0, 'and it does not pay for a probe it could not act on')
})

// The `-ilc` fallback is slow on a heavy ~/.zshrc, so the pre-flight must ride
// the shared cache rather than probing on every spawn — and it must probe only
// the CLI being launched, not all nine.
test('pre-flight reuses the availability cache across repeat spawns', async () => {
  clearCliAvailabilityCache()
  const probed: AgentCli[] = []
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code', 'Claude Code'), entry('opencode')],
    detect: async (cli: AgentCli) => {
      probed.push(cli)
      return { ...detected(cli, true), resolvedPath: `/usr/local/bin/${cli}` }
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  for (let spawn = 0; spawn < 3; spawn += 1) {
    await preflightAgentCliLaunch({ cli: 'claude-code', ...POSIX_SETUP }, deps)
  }
  assert.deepEqual(probed, ['claude-code'], 'one probe, for the launching CLI only')

  // A renderer availability refresh shares that cache entry, and vice versa.
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.deepEqual(probed, ['claude-code', 'codex', 'opencode'], 'claude-code still served from the cache')
})

// The probe is keyed by the user's command override, so its resolved path is
// that override made absolute — the launch must get the override's path, not a
// path resolved for some other command.
test('pre-flight resolves against the command override', async () => {
  clearCliAvailabilityCache()
  const commands: (string | undefined)[] = []
  const result = await preflightAgentCliLaunch(
    {
      cli: 'claude-code',
      cliRuntimes: { 'claude-code': { command: 'claude-next' } },
      ...POSIX_SETUP,
    },
    {
      listEntries: () => [entry('claude-code', 'Claude Code')],
      detect: async (cli, runtime) => {
        commands.push(runtime?.command)
        return { ...detected(cli, true), resolvedPath: '/opt/homebrew/bin/claude-next' }
      },
      now: () => 1000,
    },
  )
  assert.deepEqual(commands, ['claude-next'])
  assert.deepEqual(result, { status: 'resolved', binaryPath: '/opt/homebrew/bin/claude-next' })
})

test('"not installed" goes stale in minutes, so an update in a terminal cannot hide a CLI until Re-check', async () => {
  clearCliAvailabilityCache()
  let installed = false
  let clock = 1000
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return { ...detected(cli, installed), resolvedPath: installed ? `/usr/local/bin/${cli}` : null }
    },
    now: () => clock,
  }
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.equal(probes, 1, 'held between the reads a burst of focus changes makes')

  installed = true
  clock += 2 * 60 * 1000 + 1
  const later = await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.equal(later.codex?.installed, true)

  // Found, it stays found: no process runs for it on every read.
  clock += 24 * 60 * 60 * 1000
  await detectAgentCliAvailability({ cliRuntimes: {} }, deps)
  assert.equal(probes, 2)
})
