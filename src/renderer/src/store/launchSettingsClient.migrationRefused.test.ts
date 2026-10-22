/**
 * The upgrade boot of a second window: its localStorage still holds the launch
 * fields, and it read main before the first window's migration landed, so it
 * offers them too. Main refuses, the refusal carries main's record, that record
 * is what the store shows, and the stale copy leaves localStorage.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createFakeLaunchSettingsMain, installFakeWindow, settleIpc } from './launchSettingsFakeMain.test-helper'
import { LAUNCH_SETTINGS_KEYS } from './launchSettingsReadModel'

const { APP_SETTINGS_STORAGE_KEY, WORKSPACE_STORE_VERSION } = await import('./slices/persistenceSlice')

const fakeMain = createFakeLaunchSettingsMain({
  cliRuntimes: { codex: { command: 'codex' } },
  hosts: {},
  machineMarks: {},
  mcp: { syncEnabled: false, servers: {} },
  projectKnowledgeRoots: {},
  lastSelectedCli: 'claude-code',
  lastAgentSpawnPermissionPreset: 'none',
  cliPermissionPresets: {},
  cliPermissionModes: {},
  projectUsage: {},
  worktreeBranchPrefix: null,
  autoCompactChats: null,
})
// This window read main while it still had no record.
const racingApi = {
  ...fakeMain.api,
  launchSettingsGet: async () => {
    const snapshot = await fakeMain.api.launchSettingsGet()
    return { ...snapshot, record: null }
  },
}
const stored = installFakeWindow(racingApi, {
  [APP_SETTINGS_STORAGE_KEY]: JSON.stringify({
    state: {
      appSettings: {
        cliRuntimes: { codex: { command: '/Users/dev/stale/codex' } },
        lastSelectedCli: 'codex',
        lastAgentSpawnPermissionPreset: 'bypass',
        telemetryEnabled: false,
      },
    },
    version: WORKSPACE_STORE_VERSION,
  }),
})

const { useWorkspaceStore, launchSettingsReady } = await import('./workspaceStore')

test('an offer onto an existing record is refused and main values win', async () => {
  await launchSettingsReady
  await settleIpc()
  assert.equal(fakeMain.calls.migrate.length, 1, 'the window offered its values once')
  assert.equal(fakeMain.calls.migrate[0]?.lastSelectedCli, 'codex')
  assert.equal(fakeMain.record()?.revision, 1, 'main refused it: its record is untouched')

  const { appSettings } = useWorkspaceStore.getState()
  assert.equal(appSettings.lastSelectedCli, 'claude-code')
  assert.equal(appSettings.lastAgentSpawnPermissionPreset, 'none')
  assert.deepEqual(appSettings.cliRuntimes.codex, { command: 'codex' })
  assert.equal(appSettings.telemetryEnabled, false, 'settings the window owns hydrate as before')
})

test('the stale launch fields leave localStorage, the rest of the envelope stays', () => {
  const raw = stored.get(APP_SETTINGS_STORAGE_KEY)
  assert.ok(raw)
  const appSettings = (JSON.parse(raw) as { state: { appSettings: Record<string, unknown> } }).state.appSettings
  for (const key of LAUNCH_SETTINGS_KEYS) assert.equal(Object.hasOwn(appSettings, key), false, key)
  assert.equal(appSettings.telemetryEnabled, false)
})
