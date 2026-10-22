/**
 * Main's launch settings store, the one owner of the agent-launch settings.
 * Real tmpdir, no Electron and no window: the headless read path the scheduler
 * and the boot-time discovery sweep take, the partial writes windows make, the
 * broadcast they follow, and the one-time migration from localStorage.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'vitest'
import type { McpServerConfig } from '../shared/agent-state'
import type { AgentLaunchSettings, AgentLaunchSettingsRecord } from '../shared/launch-settings'
import { effectiveAgentLaunchSettings, parseAgentLaunchSettingsRecord } from '../shared/launch-settings'
import { createAgentLaunchSettingsStore } from './launch-settings-store'

const FILE_NAME = 'agent-launch-settings.json'

function settings(overrides: Partial<AgentLaunchSettings> = {}): AgentLaunchSettings {
  return {
    cliRuntimes: { claude: { command: 'claude' } },
    hosts: {},
    machineMarks: {},
    mcp: { syncEnabled: true, servers: {} },
    projectKnowledgeRoots: { '/repo': 'knowledge' },
    lastSelectedCli: 'claude-code',
    // A migration offer from a profile written before the two-mode change.
    lastAgentSpawnPermissionPreset: 'auto' as never,
    cliPermissionPresets: {},
    cliPermissionModes: {},
    projectUsage: {},
    worktreeBranchPrefix: null,
    autoCompactChats: null,
    ...overrides,
  }
}

function server(id: string): McpServerConfig {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    clients: ['claude-code'],
    scope: 'user',
    source: 'custom',
    riskLevel: 'low',
  } as McpServerConfig
}

type Harness = {
  userDataDir: string
  filePath: string
  diagnostics: Array<{ title: string; details?: string }>
  create: () => ReturnType<typeof createAgentLaunchSettingsStore>
}

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-launch-settings-'))
  const diagnostics: Array<{ title: string; details?: string }> = []
  try {
    await body({
      userDataDir,
      filePath: join(userDataDir, FILE_NAME),
      diagnostics,
      // A fresh instance with the same userData dir is an app restart: no
      // in-memory state survives, only the file.
      create: () =>
        createAgentLaunchSettingsStore({
          resolveUserDataDir: () => userDataDir,
          logDiagnostic: (input) => diagnostics.push({ title: input.title, details: input.details }),
        }),
    })
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
}

// The acceptance case: main reads every launch input with zero windows, across
// a restart.
test('a migrated record is what main reads after a restart, with no window', async () => {
  await withHarness(async (harness) => {
    await harness.create().migrate(settings()).persisted

    const afterRestart = harness.create()
    const read = afterRestart.get()
    assert.equal(read.lastSelectedCli, 'claude-code')
    // A stored `auto` is read as itself, never widened to bypass.
    assert.equal(read.lastAgentSpawnPermissionPreset, 'auto')
    assert.equal(read.mcp.syncEnabled, true)
    assert.equal(read.cliRuntimes.claude?.command, 'claude')
    assert.equal(afterRestart.getRecord()?.revision, 1)
    assert.deepEqual(await afterRestart.getSnapshot(), {
      record: afterRestart.getRecord(),
      settings: read,
      persisted: true,
    })
  })
})

test('update writes only the fields its patch names', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    await store.migrate(
      settings({
        cliRuntimes: {
          claude: { command: 'claude' },
          codex: { command: 'codex', models: ['gpt-6'] },
        },
        mcp: { syncEnabled: false, servers: { keep: server('keep'), drop: server('drop') } },
        projectKnowledgeRoots: { '/repo': 'knowledge', '/other': 'notes' },
      }),
    ).persisted

    // One CLI's runtime: the other CLI is untouched. A window from before the
    // per-CLI WSL switch was retired may still send it; it is not stored.
    let result = store.update({ cliRuntimes: { claude: { command: '/opt/claude', useWsl: true } } }, 'ui')
    assert.equal(result.changed, true)
    assert.deepEqual(result.record.settings.cliRuntimes, {
      claude: { command: '/opt/claude' },
      codex: { command: 'codex', models: ['gpt-6'] },
    })

    // One machine's settings, replaced whole; an id that is not a machine,
    // and an environment name no shell can export, are dropped.
    result = store.update(
      {
        hosts: {
          'wsl:Ubuntu': {
            enabled: true,
            cliCommands: { codex: '/home/dev/bin/codex' },
            env: { A_B: '1', 'no-dash': 'x' },
          },
          'not-a-host': { enabled: true },
        },
      },
      'ui',
    )
    assert.deepEqual(result.record.settings.hosts, {
      'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/home/dev/bin/codex' }, env: { A_B: '1' } },
    })
    result = store.update(
      { hosts: { 'wsl:Ubuntu': { enabled: false, cliCommands: {}, env: {}, shell: 'zsh -l' } } },
      'ui',
    )
    assert.deepEqual(result.record.settings.hosts['wsl:Ubuntu'], {
      enabled: false,
      cliCommands: {},
      env: {},
      shell: 'zsh -l',
    })
    result = store.update({ hosts: { 'wsl:Ubuntu': null } }, 'ui')
    assert.deepEqual(result.record.settings.hosts, {})

    // One MCP field, then one server added and one removed by id.
    result = store.update({ mcp: { syncEnabled: true } }, 'ui')
    assert.equal(result.record.settings.mcp.syncEnabled, true)
    assert.deepEqual(Object.keys(result.record.settings.mcp.servers).sort(), ['drop', 'keep'])
    result = store.update({ mcp: { servers: { added: server('added'), drop: null } } }, 'ui')
    assert.deepEqual(Object.keys(result.record.settings.mcp.servers).sort(), ['added', 'keep'])
    assert.equal(result.record.settings.mcp.syncEnabled, true, 'a server patch leaves the switch alone')

    // One knowledge root set, one removed.
    result = store.update({ projectKnowledgeRoots: { '/repo': 'docs', '/other': null } }, 'ui')
    assert.deepEqual(result.record.settings.projectKnowledgeRoots, { '/repo': 'docs' })

    // The scalar fields, and `null` returning one to "never chosen".
    result = store.update({ lastSelectedCli: 'codex', lastAgentSpawnPermissionPreset: 'none' }, 'ui')
    assert.equal(result.record.settings.lastSelectedCli, 'codex')
    assert.equal(result.record.settings.lastAgentSpawnPermissionPreset, 'none')
    // A window built before the preset rename still sends `default`; it is
    // read as `manual`, what its label promised, rather than dropped.
    result = store.update({ lastAgentSpawnPermissionPreset: 'bypass' }, 'ui')
    result = store.update({ lastAgentSpawnPermissionPreset: 'default' as never }, 'ui')
    assert.equal(result.record.settings.lastAgentSpawnPermissionPreset, 'manual')
    result = store.update({ lastAgentSpawnPermissionPreset: null }, 'ui')
    assert.equal(result.record.settings.lastAgentSpawnPermissionPreset, null)
    assert.equal(result.record.settings.lastSelectedCli, 'codex')
    assert.equal(result.record.lastWrite.actor, 'ui')

    // Per-CLI presets are keyed like the runtimes: one CLI's write leaves the
    // others alone, so two windows setting two CLIs both land, and `null`
    // returns a CLI to the app-wide default.
    result = store.update({ cliPermissionPresets: { 'claude-code': 'bypass' } }, 'ui')
    result = store.update({ cliPermissionPresets: { codex: 'auto' } }, 'ui')
    assert.deepEqual(result.record.settings.cliPermissionPresets, { 'claude-code': 'bypass', codex: 'auto' })
    result = store.update({ cliPermissionPresets: { 'claude-code': null, gemini: 'everything' as never } }, 'ui')
    assert.deepEqual(result.record.settings.cliPermissionPresets, { codex: 'auto' }, 'an unknown preset is dropped')
    await result.persisted

    assert.deepEqual(harness.create().get(), result.record.settings, 'every partial write reached the file')
  })
})

test('an update is normalized fail-soft: a malformed field is dropped, not the patch', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    const result = store.update(
      {
        cliRuntimes: { claude: { useWsl: true }, codex: { command: 'codex', useWsl: 'yes' } },
        lastAgentSpawnPermissionPreset: 'everything',
        lastSelectedCli: 'codex',
        unknownField: true,
      },
      'ui',
    )
    assert.deepEqual(result.record.settings.cliRuntimes, { codex: { command: 'codex' } })
    assert.equal(result.record.settings.lastAgentSpawnPermissionPreset, null, 'an unknown preset is not written')
    assert.equal(result.record.settings.lastSelectedCli, 'codex')
    assert.equal(store.update('not a patch', 'ui').changed, false, 'a non-object patch changes nothing')
    await result.persisted
  })
})

test('a worktree branch prefix never chosen reads as agent; a chosen one is kept sanitized, empty included', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    assert.equal(store.get().worktreeBranchPrefix, null)
    assert.equal(effectiveAgentLaunchSettings(store.get()).worktreeBranchPrefix, 'agent')

    let result = store.update({ worktreeBranchPrefix: ' /my team//wip.lock/ ' }, 'ui')
    assert.equal(result.record.settings.worktreeBranchPrefix, 'my-team/wip')
    result = store.update({ worktreeBranchPrefix: '' }, 'ui')
    assert.equal(result.record.settings.worktreeBranchPrefix, '', 'no prefix is a choice, not never chosen')
    assert.equal(effectiveAgentLaunchSettings(result.record.settings).worktreeBranchPrefix, '')
    await result.persisted
    assert.equal(harness.create().get().worktreeBranchPrefix, '', 'and it survives a restart')

    assert.equal(store.update({ worktreeBranchPrefix: 42 }, 'ui').changed, false, 'a malformed prefix is dropped')
    result = store.update({ worktreeBranchPrefix: null }, 'ui')
    assert.equal(effectiveAgentLaunchSettings(result.record.settings).worktreeBranchPrefix, 'agent')
    await result.persisted
  })
})

// Every content change is a new revision; an update that changes nothing is not.
test('revisions count real changes only, and survive a restart', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    const first = store.update({ lastSelectedCli: 'claude-code' }, 'ui')
    assert.equal(first.record.revision, 1)
    assert.equal(first.changed, true)

    const repeat = store.update({ lastSelectedCli: 'claude-code' }, 'ui')
    assert.equal(repeat.changed, false)
    assert.equal(repeat.record.revision, 1, 'an update that changes nothing must not bump the revision')

    const changed = store.update({ lastSelectedCli: 'codex' }, 'ui')
    assert.equal(changed.record.revision, 2)
    await changed.persisted

    // A later writer never restarts the counter and re-uses a revision a
    // window already applied.
    const afterRestart = harness.create()
    assert.equal(afterRestart.getRecord()?.revision, 2)
    const third = afterRestart.update({ lastSelectedCli: 'claude-code' }, 'ui')
    assert.equal(third.record.revision, 3)
    // Every write is awaited before the harness tears its directory down: a
    // write still in flight would race the cleanup.
    await third.persisted
  })
})

test('subscribers hear every change, as the new record, and nothing else', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    const seen: AgentLaunchSettingsRecord[] = []
    const unsubscribe = store.subscribe((record) => seen.push(record))

    await store.migrate(settings()).persisted
    store.update({ lastSelectedCli: 'claude-code' }, 'ui') // no change
    store.migrate(settings({ lastSelectedCli: 'stale' })) // refused
    const changed = store.update({ lastSelectedCli: 'codex' }, 'ui')
    await changed.persisted

    assert.deepEqual(
      seen.map((record) => [record.revision, record.settings.lastSelectedCli]),
      [
        [1, 'claude-code'],
        [2, 'codex'],
      ],
    )
    assert.equal(seen[1], changed.record, 'the broadcast carries the record the write produced')

    unsubscribe()
    await store.update({ lastSelectedCli: 'gemini' }, 'ui').persisted
    assert.equal(seen.length, 2, 'an unsubscribed listener hears nothing')
  })
})

test('a throwing subscriber does not fail the write', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    store.subscribe(() => {
      throw new Error('window gone')
    })
    const result = store.update({ lastSelectedCli: 'codex' }, 'ui')
    assert.equal(result.changed, true)
    await result.persisted
    assert.equal(harness.create().get().lastSelectedCli, 'codex')
  })
})

// The write is atomic (tmp + rename) and leaves the target parseable.
test('a write leaves a parseable file and no temp file', async () => {
  await withHarness(async (harness) => {
    await harness.create().update({ lastSelectedCli: 'claude-code' }, 'ui').persisted
    const raw: unknown = JSON.parse(await readFile(harness.filePath, 'utf8'))
    const record = parseAgentLaunchSettingsRecord(raw)
    assert.ok(record, 'the persisted file parses as a current-schema record')
    assert.equal(record.settings.lastSelectedCli, 'claude-code')
    assert.deepEqual(await readdir(harness.userDataDir), [FILE_NAME], 'no temp file survives the write')
  })
})

// Migration seeds once and never overwrites main's own record — including
// across a restart, where a window's stale value must not win.
test('migration is accepted once, and refused whenever a record exists', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    const seeded = store.migrate(settings())
    assert.equal(seeded.changed, true)
    assert.equal(seeded.record.revision, 1)
    assert.equal(seeded.record.lastWrite.actor, 'system', 'a migration is not a user write')
    await seeded.persisted

    const again = store.migrate(settings({ lastSelectedCli: 'stale' }))
    assert.equal(again.changed, false)
    assert.equal(again.record, seeded.record, 'a refusal answers with the record main holds')

    const afterRestart = harness.create()
    const offeredAgain = afterRestart.migrate(settings({ lastSelectedCli: 'stale' }))
    assert.equal(offeredAgain.changed, false, 'migration is once per profile, not once per session')
    assert.equal(afterRestart.get().lastSelectedCli, 'claude-code')
  })
})

test('a record created by an update also refuses a later migration', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    await store.update({ lastSelectedCli: 'codex' }, 'ui').persisted
    const offer = store.migrate(settings({ lastSelectedCli: 'claude-code' }))
    assert.equal(offer.changed, false)
    assert.equal(store.get().lastSelectedCli, 'codex')
  })
})

// A fresh install (no file at all) reads sane defaults rather than throwing.
test('a fresh install reads empty defaults and has no record', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    const read = store.get()
    assert.equal(store.getRecord(), null)
    assert.deepEqual(await store.getSnapshot(), { record: null, settings: read, persisted: false })
    assert.equal(read.lastSelectedCli, null)
    assert.equal(read.lastAgentSpawnPermissionPreset, null)
    assert.deepEqual(read.cliRuntimes, {})
    assert.deepEqual(read.mcp, { syncEnabled: false, servers: {} })
  })
})

// The original file held bare settings with no revision: it still reads (no
// regression for a scheduler booting straight after the upgrade), a migration
// replaces it, and an update applies on top of it.
test('a legacy bare settings file reads, accepts a migration, and carries into an update', async () => {
  await withHarness(async (harness) => {
    const legacy = {
      cliRuntimes: { legacy: { command: 'legacy-cli' } },
      mcp: { syncEnabled: true, servers: {} },
      projectKnowledgeRoots: {},
    }
    await writeFile(harness.filePath, JSON.stringify(legacy), 'utf8')
    const store = harness.create()
    assert.equal(store.getRecord(), null, 'a bare settings file is readable but not authoritative')
    assert.equal(store.get().cliRuntimes.legacy?.command, 'legacy-cli')
    assert.equal((await store.getSnapshot()).settings.cliRuntimes.legacy?.command, 'legacy-cli')

    const upgraded = store.migrate(settings())
    assert.equal(upgraded.changed, true)
    assert.equal(upgraded.record.revision, 1)
    await upgraded.persisted
    assert.equal(harness.create().get().lastSelectedCli, 'claude-code')

    await writeFile(harness.filePath, JSON.stringify(legacy), 'utf8')
    const updated = harness.create().update({ lastSelectedCli: 'codex' }, 'ui')
    assert.equal(updated.record.settings.cliRuntimes.legacy?.command, 'legacy-cli', 'the legacy file is carried')
    assert.equal(updated.record.settings.lastSelectedCli, 'codex')
    await updated.persisted
  })
})

// A write failure is fail-soft: the in-memory value still serves reads and the
// failure is reported rather than swallowed.
test('an unwritable store keeps its in-memory values and reports the failure', async () => {
  await withHarness(async (harness) => {
    const store = createAgentLaunchSettingsStore({
      // A path whose parent is a FILE, so mkdir/write cannot succeed.
      resolveUserDataDir: () => join(harness.filePath, 'nested'),
      logDiagnostic: (input) => harness.diagnostics.push({ title: input.title, details: input.details }),
    })
    await writeFile(harness.filePath, 'not a directory', 'utf8')
    const result = store.update({ lastSelectedCli: 'claude-code' }, 'ui')
    assert.equal(await result.persisted, false, 'the write says it did not reach disk')
    assert.equal(store.get().lastSelectedCli, 'claude-code', 'in-memory values still apply')
    assert.equal(
      await store.update({ lastSelectedCli: 'claude-code' }, 'ui').persisted,
      false,
      'nor does a no-op on it',
    )
    assert.equal(await store.migrate({}).persisted, false, 'nor a refused migration answered with it')
    assert.equal((await store.getSnapshot()).persisted, false, 'nor the boot read')
    assert.equal(harness.diagnostics.length, 1)
    assert.equal(harness.diagnostics[0]?.title, 'Agent launch settings not persisted')
  })
})

test('every answer says whether its record is on disk', async () => {
  await withHarness(async (harness) => {
    const store = harness.create()
    assert.equal((await store.getSnapshot()).persisted, false, 'no record is nothing on disk')
    assert.equal(await store.migrate(settings()).persisted, true)
    assert.equal(await store.update({ lastSelectedCli: 'codex' }, 'ui').persisted, true)
    assert.equal(await store.update({ lastSelectedCli: 'codex' }, 'ui').persisted, true, 'a no-op on a saved record')
    assert.equal(await store.migrate(settings()).persisted, true, 'a refusal answered with a saved record')
    assert.equal((await harness.create().getSnapshot()).persisted, true, 'a record read back after a restart')
  })
})
