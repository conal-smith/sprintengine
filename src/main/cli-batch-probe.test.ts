// On Windows, CLI detection asks about every native CLI in ONE PowerShell, and
// about each WSL machine's CLIs in one request to that machine's helper. These
// cases pin the parse of what the PowerShell prints and the process count.

import type { ExecutionHostId } from '../shared/execution-host'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, test } from 'vitest'

import type { AgentCli, CliDetectResult, CliRuntimeSettings } from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { clearCliAvailabilityCache, detectAgentCliAvailability } from './cli-availability'
import { buildBatchProbeDescriptor, detectCli, detectCliBatch, parseBatchProbeOutput } from './cli-runtime-install'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import type { RunOutcome, SpawnDescriptor } from './process-run'

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-cli-batch-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})

afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

beforeEach(() => clearCliAvailabilityCache())

// What a batch printed for four CLIs, with a banner in front and Windows line
// endings: found with a version, not found, found but silent past its own
// deadline, and one the shell never reached.
const BATCH_FIXTURE = [
  'Windows PowerShell',
  '@@SPRINTENGINE_CLI 0',
  'SPRINTENGINE_PATH:/home/dev/.local/bin/claude',
  '2.1.4 (Claude Code)',
  '@@SPRINTENGINE_CLI 1',
  '@@SPRINTENGINE_NOT_FOUND',
  '@@SPRINTENGINE_CLI 2',
  'SPRINTENGINE_PATH:/usr/local/bin/codex',
  '@@SPRINTENGINE_TIMED_OUT',
  '@@SPRINTENGINE_CLI 9',
  'stray output from an index nobody asked for',
  '',
].join('\r\n')

test('a batch parse reads found, missing, silent and unanswered CLIs apart', () => {
  const answers = parseBatchProbeOutput(BATCH_FIXTURE, 4)
  assert.deepEqual(answers[0], {
    installed: true,
    version: '2.1.4 (Claude Code)',
    resolvedPath: '/home/dev/.local/bin/claude',
  })
  assert.deepEqual(answers[1], { installed: false, version: null, resolvedPath: null })
  assert.deepEqual(answers[2], { installed: true, version: null, resolvedPath: '/usr/local/bin/codex' })
  assert.ok('error' in answers[3], 'no block is an error, never "not installed"')
})

test('a batch parse of garbage answers nothing', () => {
  const answers = parseBatchProbeOutput('wsl: Failed to start the distribution\r\n@@SPRINTENGINE_CLI x\r\n', 2)
  assert.equal(answers.length, 2)
  for (const answer of answers) assert.ok('error' in answer)
})

test('a PowerShell batch reads the same way', () => {
  const stdout = [
    '@@SPRINTENGINE_CLI 0',
    'SPRINTENGINE_PATH:C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1',
    '2.1.4 (Claude Code)',
    '',
    '@@SPRINTENGINE_CLI 1',
    '@@SPRINTENGINE_NOT_FOUND',
  ].join('\r\n')
  const [claude, codex] = parseBatchProbeOutput(stdout, 2)
  assert.deepEqual(claude, {
    installed: true,
    version: '2.1.4 (Claude Code)',
    resolvedPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1',
  })
  assert.deepEqual(codex, { installed: false, version: null, resolvedPath: null })
})

test('the native batch is one encoded PowerShell command', () => {
  const desc = buildBatchProbeDescriptor({
    requests: [
      { binary: 'claude', versionArgs: ['--version'] },
      { binary: "it's", versionArgs: [] },
    ],
  })
  assert.equal(desc.file, 'powershell.exe')
  const script = Buffer.from(desc.args.at(-1) ?? '', 'base64').toString('utf16le')
  assert.match(script, /@\{ b = 'claude'; a = @\('--version'\) \}/u)
  assert.match(script, /@\{ b = 'it''s'; a = @\(\) \}/u, 'single quotes are doubled for PowerShell')
})

function outcome(stdout: string, code = 0): RunOutcome {
  return { code, stdout, stderr: '', timedOut: false }
}

test('detectCliBatch starts one process per machine, whatever the CLI count', async () => {
  const runs: SpawnDescriptor[] = []
  const asked: Array<{ hostId: ExecutionHostId; clis: AgentCli[] }> = []
  const results = await detectCliBatch(
    [
      { cli: 'claude-code', runtime: { hostId: 'wsl:Debian' } },
      { cli: 'codex', runtime: { hostId: 'wsl:Debian' } },
      { cli: 'opencode', runtime: { hostId: 'wsl:Ubuntu' } },
      { cli: 'cursor', runtime: {} },
    ],
    {
      platform: 'win32',
      env: {},
      run: async (desc) => {
        runs.push(desc)
        return outcome('@@SPRINTENGINE_CLI 0\n@@SPRINTENGINE_NOT_FOUND\n')
      },
      detectOnHost: async (hostId, group) => {
        asked.push({ hostId, clis: group.map((request) => request.cli) })
        return group.map((request) => found(request.cli, hostId))
      },
    },
  )
  assert.equal(runs.length, 1, 'one PowerShell for the native CLI')
  assert.equal(runs[0].file, 'powershell.exe')
  assert.deepEqual(
    asked.sort((a, b) => a.hostId.localeCompare(b.hostId)),
    [
      { hostId: 'wsl:Debian', clis: ['claude-code', 'codex'] },
      { hostId: 'wsl:Ubuntu', clis: ['opencode'] },
    ],
    'each WSL machine is asked once, through its own helper',
  )
  assert.deepEqual(
    results.map((result) => [result.cli, result.hostId, result.installed]),
    [
      ['claude-code', 'wsl:Debian', true],
      ['codex', 'wsl:Debian', true],
      ['opencode', 'wsl:Ubuntu', true],
      ['cursor', 'local', false],
    ],
  )
})

test('force reaches each WSL machine’s helper, and a plain read does not ask for it', async () => {
  const forced: boolean[] = []
  const deps = {
    platform: 'win32' as NodeJS.Platform,
    env: {},
    detectOnHost: async (
      hostId: ExecutionHostId,
      group: ReadonlyArray<{ cli: AgentCli }>,
      options: { force: boolean },
    ) => {
      forced.push(options.force)
      return group.map((request) => found(request.cli, hostId))
    },
  }
  await detectCliBatch([{ cli: 'codex', runtime: { hostId: 'wsl:Ubuntu' } }], deps)
  await detectCliBatch([{ cli: 'codex', runtime: { hostId: 'wsl:Ubuntu' } }], { ...deps, force: true })
  assert.deepEqual(forced, [false, true])
})

test('a WSL machine whose helper could not answer reports every CLI there as unanswered', async () => {
  const results = await detectCliBatch(
    [
      { cli: 'claude-code', runtime: { hostId: 'wsl:Ubuntu' } },
      { cli: 'codex', runtime: { hostId: 'wsl:Ubuntu' } },
    ],
    {
      platform: 'win32',
      env: {},
      detectOnHost: async () => {
        throw new Error("Couldn't set up WSL: no network to download Node.js")
      },
    },
  )
  for (const result of results) {
    assert.equal(result.installed, false)
    assert.match(result.error ?? '', /no network to download Node\.js/u, 'an error, never "not installed"')
  }
})

test("the native batch runs Grok's `--version` with its self-updater off, and only a batch with Grok in it", async () => {
  const envs: NodeJS.ProcessEnv[] = []
  const env = { PATH: 'C:\\Windows\\System32' }
  const deps = {
    platform: 'win32' as NodeJS.Platform,
    env,
    run: async (_desc: SpawnDescriptor, runEnv: NodeJS.ProcessEnv) => {
      envs.push(runEnv)
      return outcome('')
    },
  }
  await detectCliBatch([{ cli: 'cursor' }, { cli: 'grok' }], deps)
  await detectCliBatch([{ cli: 'cursor' }], deps)
  assert.equal(envs[0]?.GROK_DISABLE_AUTOUPDATER, '1')
  assert.equal(envs[0]?.PATH, 'C:\\Windows\\System32')
  assert.equal(envs[1]?.GROK_DISABLE_AUTOUPDATER, undefined)
  assert.deepEqual(env, { PATH: 'C:\\Windows\\System32' }, "the caller's environment is left as it was")
})

test.skipIf(process.platform === 'win32')(
  "Grok's `--version` on this machine runs with its self-updater off, whatever the caller's environment says",
  async () => {
    const grok = join(temp, 'grok')
    writeFileSync(grok, '#!/bin/sh\necho "grok 1.0.$GROK_DISABLE_AUTOUPDATER"\n')
    chmodSync(grok, 0o755)
    const env = { PATH: process.env.PATH, GROK_DISABLE_AUTOUPDATER: '0' }
    const result = await detectCli('grok', { command: grok }, env)
    assert.equal(result.version, 'grok 1.0.1')
    assert.equal(env.GROK_DISABLE_AUTOUPDATER, '0')
  },
)

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

function found(cli: AgentCli, hostId: ExecutionHostId): CliDetectResult {
  return {
    cli,
    binary: cli,
    installed: true,
    version: '1.0.0',
    resolvedPath: `/usr/bin/${cli}`,
    hostId,
    error: null,
  }
}

test('availability on Windows batches the cache misses and shares the batch with callers who arrive during it', async () => {
  const batches: Array<Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>> = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const deps = {
    platform: 'win32' as const,
    listEntries: () => ['claude-code', 'codex', 'cursor'].map(entry),
    detect: async () => {
      throw new Error('the per-CLI probe must not run on Windows')
    },
    detectBatch: async (requests: Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>) => {
      batches.push(requests)
      await gate
      return requests.map((request) => found(request.cli, request.runtime?.hostId ?? 'local'))
    },
  }
  const input = {
    cliRuntimes: { 'claude-code': { hostId: 'wsl:Ubuntu' as const }, codex: { hostId: 'wsl:Ubuntu' as const } },
  }
  const first = detectAgentCliAvailability(input, deps)
  const second = detectAgentCliAvailability(input, deps)
  await Promise.resolve()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(batches.length, 2, 'one batch for the WSL CLIs and one for the native one, shared by both callers')
  assert.deepEqual(batches.map((batch) => batch.map((request) => request.cli).sort()).sort(), [
    ['claude-code', 'codex'],
    ['cursor'],
  ])
  assert.deepEqual(Object.keys(a).sort(), ['claude-code', 'codex', 'cursor'])
  assert.deepEqual(b, a)

  // Cached now: a third caller starts nothing.
  await detectAgentCliAvailability(input, deps)
  assert.equal(batches.length, 2)
})
