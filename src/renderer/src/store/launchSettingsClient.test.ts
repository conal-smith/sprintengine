/**
 * The renderer half of main's ownership of the agent-launch settings, on the
 * first boot after the change: this profile's localStorage still holds the
 * five launch fields and main has no record yet.
 *
 * The store is loaded against a fake window and a fake main. The suite checks
 * that the boot reads main and offers the old values exactly once, that the
 * envelope is stripped, that main's broadcast lands in the store, that every
 * setter round-trips through main, and that nothing launch-shaped is written
 * to localStorage again. The client's ordering rules are covered on their own
 * at the end, without the store.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { AgentLaunchSettingsRecord } from '../../../shared/launch-settings'
import type { McpServerConfig } from '../types/workspace'
import { createFakeLaunchSettingsMain, installFakeWindow, settleIpc } from './launchSettingsFakeMain.test-helper'
import { createLaunchSettingsClient } from './launchSettingsClient'
import { LAUNCH_SETTINGS_KEYS } from './launchSettingsReadModel'

const { APP_SETTINGS_STORAGE_KEY, WORKSPACE_STORE_VERSION } = await import('./slices/persistenceSlice')

const legacyAppSettings = {
  cliRuntimes: {
    codex: { command: '/Users/dev/bin/codex' },
    'claude-code': { command: 'claude', useWsl: true, models: ['opus-custom'] },
  },
  mcp: { syncEnabled: true, servers: {} },
  projectKnowledgeRoots: { '/Users/dev/repo': 'docs' },
  lastSelectedCli: 'codex',
  // Written before the two-mode change: it reaches main as `none`.
  lastAgentSpawnPermissionPreset: 'manual',
  keepRunningInBackground: true,
}

const fakeMain = createFakeLaunchSettingsMain()
const stored = installFakeWindow(fakeMain.api, {
  [APP_SETTINGS_STORAGE_KEY]: JSON.stringify({
    state: { appSettings: legacyAppSettings, sidebarCollapsed: true },
    version: WORKSPACE_STORE_VERSION,
  }),
})

// Loaded AFTER the fake window: the store hydrates and boots the client as it
// is imported.
const { useWorkspaceStore, launchSettingsReady } = await import('./workspaceStore')

function persistedAppSettings(): Record<string, unknown> {
  const raw = stored.get(APP_SETTINGS_STORAGE_KEY)
  assert.ok(raw, 'the settings envelope exists')
  return (JSON.parse(raw) as { state: { appSettings: Record<string, unknown> } }).state.appSettings
}

function assertEnvelopeCarriesNoLaunchFields(context: string): void {
  const appSettings = persistedAppSettings()
  for (const key of LAUNCH_SETTINGS_KEYS) {
    assert.equal(Object.hasOwn(appSettings, key), false, `${context}: the envelope must not carry ${key}`)
  }
}

function storeLaunchFields() {
  const { appSettings } = useWorkspaceStore.getState()
  return {
    cliRuntimes: appSettings.cliRuntimes,
    mcp: appSettings.mcp,
    projectKnowledgeRoots: appSettings.projectKnowledgeRoots,
    lastSelectedCli: appSettings.lastSelectedCli,
    lastAgentSpawnPermissionPreset: appSettings.lastAgentSpawnPermissionPreset,
  }
}

function mainRecord(): AgentLaunchSettingsRecord {
  const record = fakeMain.record()
  assert.ok(record, 'main holds a record')
  return record
}

function server(id: string): McpServerConfig {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'npx',
    args: [],
    enabled: true,
    clients: ['claude-code'],
    scope: 'user',
    source: 'custom',
    riskLevel: 'low',
  } as McpServerConfig
}

test('boot reads main, offers the localStorage values once, and adopts main record', async () => {
  await launchSettingsReady
  await settleIpc()
  assert.equal(fakeMain.calls.get, 1, 'main is read once at boot')
  assert.equal(fakeMain.calls.migrate.length, 1, 'the old values are offered exactly once')
  const offer = fakeMain.calls.migrate[0]
  assert.ok(offer)
  assert.deepEqual(Object.keys(offer).sort(), [...LAUNCH_SETTINGS_KEYS].sort(), 'the offer carries every launch input')
  assert.equal(offer.lastSelectedCli, 'codex')
  assert.equal(offer.lastAgentSpawnPermissionPreset, 'manual', 'a stored Manual is offered as itself')
  assert.equal(offer.cliRuntimes.codex?.command, '/Users/dev/bin/codex')
  assert.deepEqual(offer.cliRuntimes['claude-code']?.models, ['opus-custom'])
  assert.equal(offer.mcp.syncEnabled, true)

  const record = mainRecord()
  assert.equal(record.revision, 1)
  assert.equal(record.settings.lastSelectedCli, 'codex')
  const fields = storeLaunchFields()
  assert.equal(fields.lastSelectedCli, 'codex')
  assert.equal(fields.lastAgentSpawnPermissionPreset, 'manual')
  assert.equal(fields.cliRuntimes.codex?.command, '/Users/dev/bin/codex')
  // The retired per-CLI WSL switch a legacy copy still carries does not ride
  // into main: a WSL distribution is a machine with its own settings now.
  assert.equal('useWsl' in (fields.cliRuntimes['claude-code'] ?? {}), false)
  assert.deepEqual(fields.cliRuntimes['claude-code']?.models, ['opus-custom'])
})

test('once main holds a record the envelope is stripped of the launch fields and nothing else', () => {
  assertEnvelopeCarriesNoLaunchFields('after migration')
  assert.equal(persistedAppSettings().keepRunningInBackground, true, 'the settings this window owns stay')
  assert.equal(useWorkspaceStore.getState().appSettings.keepRunningInBackground, true)
})

test('a change main broadcasts lands in the store, and a stale one does not', async () => {
  const pushed = fakeMain.externalUpdate({ lastSelectedCli: 'gemini' })
  await settleIpc()
  assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'gemini')
  assert.equal(fakeMain.calls.update.length, 0, 'adopting a broadcast writes nothing back to main')

  // A late echo of an older revision never re-asserts its value.
  const stale = structuredClone(pushed)
  stale.revision = pushed.revision - 1
  stale.settings.lastSelectedCli = 'stale-cli'
  fakeMain.broadcast(stale)
  await settleIpc()
  assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'gemini')
})

test('every launch setter round-trips through main, and main answer is what the store holds', async () => {
  const state = () => useWorkspaceStore.getState()
  const before = fakeMain.calls.update.length

  state().setCliRuntime('codex', { command: '/Users/dev/.local/bin/codex' })
  state().setCliRuntime('grok', { models: ['grok-5'] })
  state().setMcpSyncEnabled(false)
  state().upsertMcpServer(server('docs'))
  state().upsertMcpServer(server('search'))
  state().refreshMcpServersFromSource([{ ...server('docs'), name: 'Docs (refreshed)' }])
  state().removeMcpServer('search')
  state().setLastSelectedCli('claude-code')
  state().setLastAgentSpawnPermissionPreset('bypass')
  state().setProjectKnowledgeRoot('/Users/dev/other', 'notes')
  state().setProjectKnowledgeRoot('/Users/dev/repo', null)
  state().setHostSettings('wsl:Ubuntu', { enabled: true, cliCommands: { codex: '/home/dev/bin/codex' }, env: {} })
  state().setCliPermissionPreset('codex', 'none')
  await settleIpc()

  assert.equal(fakeMain.calls.update.length - before, 13, 'one patch per setter call')
  const patches = fakeMain.calls.update.slice(before)
  assert.deepEqual(patches[0], {
    cliRuntimes: { codex: { command: '/Users/dev/.local/bin/codex' } },
  })
  assert.deepEqual(patches[1], { cliRuntimes: { grok: { command: '', models: ['grok-5'] } } })
  assert.deepEqual(patches[2], { mcp: { syncEnabled: false } })
  assert.deepEqual(patches[6], { mcp: { syncEnabled: true, servers: { search: null } } })
  assert.deepEqual(patches[7], { lastSelectedCli: 'claude-code' })
  assert.deepEqual(patches[8], { lastAgentSpawnPermissionPreset: 'bypass' })
  assert.deepEqual(patches[10], { projectKnowledgeRoots: { '/Users/dev/repo': null } })
  assert.deepEqual(patches[11], {
    hosts: { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/home/dev/bin/codex' }, env: {} } },
  })
  assert.deepEqual(
    patches[12],
    { cliPermissionPresets: { codex: 'none' }, cliPermissionModes: { codex: null } },
    'only the CLI that changed, its own mode going with its preset',
  )

  const settings = mainRecord().settings
  assert.equal(settings.cliRuntimes.codex?.command, '/Users/dev/.local/bin/codex')
  assert.deepEqual(settings.cliRuntimes.grok, { command: '', models: ['grok-5'] })
  assert.deepEqual(settings.hosts['wsl:Ubuntu']?.cliCommands, { codex: '/home/dev/bin/codex' })
  assert.equal(useWorkspaceStore.getState().appSettings.hosts?.['wsl:Ubuntu']?.enabled, true)
  assert.deepEqual(settings.cliRuntimes['claude-code']?.models, ['opus-custom'], 'untouched CLIs keep their entry')
  assert.equal(settings.mcp.syncEnabled, true, 'removing a server turns sync back on, as it always did')
  assert.deepEqual(Object.keys(settings.mcp.servers), ['docs'])
  assert.equal(settings.mcp.servers.docs?.name, 'Docs (refreshed)')
  assert.equal(settings.lastSelectedCli, 'claude-code')
  assert.equal(settings.lastAgentSpawnPermissionPreset, 'bypass')
  assert.deepEqual(settings.cliPermissionPresets, { codex: 'none' })
  assert.deepEqual(useWorkspaceStore.getState().appSettings.cliPermissionPresets, { codex: 'none' })
  assert.deepEqual(settings.projectKnowledgeRoots, { '/Users/dev/other': 'notes' })

  // The store is main's record read through the hydration normalizers.
  const fields = storeLaunchFields()
  assert.equal(fields.cliRuntimes.codex?.command, settings.cliRuntimes.codex?.command)
  assert.deepEqual(fields.cliRuntimes.grok, settings.cliRuntimes.grok)
  assert.deepEqual(Object.keys(fields.mcp.servers), ['docs'])
  assert.equal(fields.mcp.syncEnabled, true)
  assert.equal(fields.lastSelectedCli, 'claude-code')
  assert.equal(fields.lastAgentSpawnPermissionPreset, 'bypass')
  assert.deepEqual(fields.projectKnowledgeRoots, settings.projectKnowledgeRoots)

  assertEnvelopeCarriesNoLaunchFields('after every launch setter')
})

test('a setter main never answers is replaced by main record once the call settles', async () => {
  fakeMain.failNextUpdate()
  useWorkspaceStore.getState().setLastSelectedCli('codex')
  assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex', 'applied at once')
  await settleIpc()
  assert.equal(mainRecord().settings.lastSelectedCli, 'claude-code')
  assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'claude-code', 'main answer wins')
})

test('store writes that touch no launch setting send nothing to main', async () => {
  const before = fakeMain.calls.update.length
  useWorkspaceStore.getState().setSidebarCollapsed(false)
  useWorkspaceStore.getState().setKeepRunningInBackground(false)
  await settleIpc()
  assert.equal(fakeMain.calls.update.length, before)
  assert.equal(fakeMain.calls.migrate.length, 1, 'the migration is never offered again')
  assertEnvelopeCarriesNoLaunchFields('after an unrelated settings write')
})

// The client on its own: ordering between optimistic writes, answers and
// broadcasts, with no store behind it.
test('client: nothing is adopted while an update is in flight, then the newest record is', async () => {
  const main = createFakeLaunchSettingsMain({
    cliRuntimes: {},
    hosts: {},
    machineMarks: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
    lastSelectedCli: 'codex',
    lastAgentSpawnPermissionPreset: null,
    cliPermissionPresets: {},
    cliPermissionModes: {},
    projectUsage: {},
    worktreeBranchPrefix: null,
    autoCompactChats: null,
  })
  const applied: Array<string | null> = []
  const client = createLaunchSettingsClient()
  await client.start({
    api: main.api,
    apply: (settings) => applied.push(settings.lastSelectedCli),
    legacyOffer: () => ({
      cliRuntimes: {},
      hosts: {},
      machineMarks: {},
      mcp: { syncEnabled: false, servers: {} },
      projectKnowledgeRoots: {},
      lastSelectedCli: 'ignored',
      lastAgentSpawnPermissionPreset: null,
      cliPermissionPresets: {},
      cliPermissionModes: {},
      projectUsage: {},
      worktreeBranchPrefix: null,
      autoCompactChats: null,
    }),
    onLegacySettled: () => applied.push('settled'),
  })
  await settleIpc()
  assert.equal(main.calls.migrate.length, 0, 'main already holds a record, so nothing is offered')
  assert.deepEqual(applied, ['settled', 'codex'], 'the legacy copy is released and main record adopted')

  client.update({ lastSelectedCli: 'gemini' })
  client.update({ lastSelectedCli: 'grok' })
  main.externalUpdate({ lastAgentSpawnPermissionPreset: 'bypass' })
  assert.deepEqual(applied, ['settled', 'codex'], 'a broadcast waits for this window updates to settle')
  await settleIpc()
  assert.deepEqual(applied, ['settled', 'codex', 'grok'], 'one adoption, of the newest record')
  client.stop()
})

test('client: with no bridge, updates are local only and ready resolves at once', async () => {
  const client = createLaunchSettingsClient()
  await client.start({
    api: null,
    apply: () => assert.fail('nothing to adopt'),
    legacyOffer: () => null,
    onLegacySettled: () => assert.fail('nothing to settle'),
  })
  client.update({ lastSelectedCli: 'codex' })
  await client.ready
})

test('client: a main that does not answer the boot read leaves the legacy values in place', async () => {
  const applied: Array<string | null> = []
  let settled = false
  const client = createLaunchSettingsClient()
  const legacy = {
    cliRuntimes: {},
    hosts: {},
    machineMarks: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
    lastSelectedCli: 'codex',
    lastAgentSpawnPermissionPreset: null,
    cliPermissionPresets: {},
    cliPermissionModes: {},
    projectUsage: {},
    worktreeBranchPrefix: null,
    autoCompactChats: null,
  }
  const warn = console.warn
  console.warn = () => undefined
  try {
    await client.start({
      api: {
        ...createFakeLaunchSettingsMain().api,
        launchSettingsGet: () => Promise.reject(new Error('no main')),
      },
      apply: (settings) => applied.push(settings.lastSelectedCli),
      legacyOffer: () => legacy,
      onLegacySettled: () => {
        settled = true
      },
    })
  } finally {
    console.warn = warn
  }
  assert.deepEqual(applied, ['codex'])
  assert.equal(settled, false, 'the localStorage copy is kept for the next boot offer')
})
