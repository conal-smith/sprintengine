import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AppUpdateState, CliVersionAdvisory, CliVersionHostAdvisories } from '../../../shared/electron-api'
import {
  appUpdateKey,
  cliUpdateKey,
  outstandingAppUpdate,
  outstandingCliUpdates,
  settingsUpdateBadges,
} from './settingsUpdateBadges'

// The Settings update badges (owner ruling 2026-09-25): the rail's gear, the
// General and Agents nav items, the machine switcher and a CLI's row, all from
// one derivation. Each appears while an update is outstanding and clears when it
// is installed or dismissed.

function advisory(cli: string, over: Partial<CliVersionAdvisory> = {}): CliVersionAdvisory {
  return {
    cli: cli as CliVersionAdvisory['cli'],
    hostId: 'local',
    status: 'behind_latest',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateCommand: null,
    checkedAt: '2026-09-25T00:00:00.000Z',
    ...over,
  }
}

function appState(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: 'not_available',
    version: '0.6.0',
    channel: 'stable',
    buildChannel: 'stable',
    packaged: true,
    updateVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseNotesUrl: null,
    downloaded: false,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    autoDownload: false,
    installRequiresAdmin: false,
    installOutcome: null,
    ...over,
  }
}

const everyCliInstalled = (): boolean => true

test('a CLI update counts while it is behind, installed here, checked for and not dismissed', () => {
  const local = {
    codex: advisory('codex'),
    gemini: advisory('gemini', { status: 'current', latestVersion: '1.0.0' }),
    opencode: advisory('opencode', { status: 'unknown' }),
    cursor: advisory('cursor', { latestVersion: null }),
  }
  const advisories: CliVersionHostAdvisories = { local }
  const base = { advisories, checkCliVersions: true, installed: everyCliInstalled, dismissed: [] }
  assert.deepEqual(
    outstandingCliUpdates(base).map((entry) => entry.cli),
    ['codex'],
    'current, unknown and version-less advisories are not news',
  )
  assert.deepEqual(outstandingCliUpdates({ ...base, checkCliVersions: false }), [], 'checks off, nothing counted')
  assert.deepEqual(
    outstandingCliUpdates({ ...base, installed: (_host, cli) => cli !== 'codex' }),
    [],
    'a CLI no longer detected here offers no Update, so it wears no badge',
  )
  assert.deepEqual(
    outstandingCliUpdates({ ...base, dismissed: [cliUpdateKey(local.codex)] }),
    [],
    'a dismissed version is not counted',
  )
  assert.deepEqual(
    outstandingCliUpdates({
      ...base,
      advisories: { local: { codex: advisory('codex', { latestVersion: '1.2.0' }) } },
      dismissed: [cliUpdateKey(local.codex)],
    }).map((entry) => entry.latestVersion),
    ['1.2.0'],
    'a newer release than the dismissed one badges again',
  )
  assert.deepEqual(
    outstandingCliUpdates({ ...base, advisories: { local: { codex: advisory('codex', { status: 'current' }) } } }),
    [],
    'installed: the advisory stops saying behind, and the badge goes',
  )
})

test('a WSL machine’s CLI updates count on their own, and are dismissed on their own', () => {
  const wsl = advisory('codex', { hostId: 'wsl:Ubuntu', currentVersion: '0.9.0' })
  const advisories: CliVersionHostAdvisories = {
    local: { codex: advisory('codex'), gemini: advisory('gemini', { status: 'current' }) },
    'wsl:Ubuntu': { codex: wsl, gemini: advisory('gemini', { hostId: 'wsl:Ubuntu' }) },
  }
  const base = { advisories, checkCliVersions: true, installed: everyCliInstalled, dismissed: [] }
  assert.deepEqual(
    outstandingCliUpdates(base).map((entry) => `${entry.hostId}/${entry.cli}`),
    ['local/codex', 'wsl:Ubuntu/codex', 'wsl:Ubuntu/gemini'],
    'the same CLI behind on two machines is two updates',
  )
  assert.equal(cliUpdateKey(advisories.local!.codex!), 'cli:codex@1.1.0', 'this machine keeps the key it always had')
  assert.equal(cliUpdateKey(wsl), 'cli:wsl:Ubuntu|codex@1.1.0')
  assert.deepEqual(
    outstandingCliUpdates({ ...base, dismissed: [cliUpdateKey(wsl)] }).map((entry) => `${entry.hostId}/${entry.cli}`),
    ['local/codex', 'wsl:Ubuntu/gemini'],
    'dismissing the WSL notice leaves this machine’s update counted',
  )
  assert.deepEqual(
    outstandingCliUpdates({ ...base, installed: (host) => host === 'local' }).map((entry) => entry.hostId),
    ['local'],
    'installed is asked per machine',
  )

  const badges = settingsUpdateBadges({ cliUpdates: outstandingCliUpdates(base), appUpdate: null })
  assert.equal(badges.rail?.count, 3, 'the gear counts every machine')
  assert.equal(badges.agents?.count, 3, 'and so does Agents')
  assert.equal(badges.machines.local?.count, 1)
  assert.equal(badges.machines['wsl:Ubuntu']?.count, 2, 'the distribution’s segment wears its own count')
  assert.equal(badges.machines['wsl:Ubuntu']?.detail, '2 CLI updates available')
  assert.deepEqual([...(badges.clis.local ?? [])], ['codex'])
  assert.deepEqual([...(badges.clis['wsl:Ubuntu'] ?? [])], ['codex', 'gemini'], 'rows badge on their own machine')
})

test('the app update counts at every step to the restart, and clears when installed or dismissed', () => {
  assert.equal(outstandingAppUpdate({ state: null, dismissed: [] }), null, 'nothing known yet')
  assert.equal(outstandingAppUpdate({ state: appState(), dismissed: [] }), null, 'up to date')
  const steps: Array<[Partial<AppUpdateState>, 'offer' | 'ready']> = [
    [{ status: 'available' }, 'offer'],
    // The hourly re-check of an offered update keeps the badge.
    [{ status: 'checking' }, 'offer'],
    [{ status: 'downloading', progress: { percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 } }, 'offer'],
    [{ status: 'downloaded', downloaded: true }, 'ready'],
    [{ status: 'installing', downloaded: true }, 'ready'],
    // A restart main refused: back to downloaded, with the reason.
    [{ status: 'downloaded', downloaded: true, errorMessage: 'The installer did not start.' }, 'ready'],
    // A download that failed: the update is still there to take.
    [{ status: 'error', errorMessage: 'net::ERR_CONNECTION_RESET' }, 'offer'],
  ]
  for (const [over, stage] of steps) {
    assert.deepEqual(
      outstandingAppUpdate({ state: appState({ updateVersion: '0.7.0', ...over }), dismissed: [] }),
      { version: '0.7.0', stage },
      `${over.status}: counted, at the ${stage} step`,
    )
  }
  assert.equal(
    outstandingAppUpdate({ state: appState({ status: 'error', errorMessage: 'offline' }), dismissed: [] }),
    null,
    'a check that failed with nothing found is not an update',
  )
  assert.equal(
    outstandingAppUpdate({
      state: appState({ status: 'available', updateVersion: '0.7.0', packaged: false }),
      dismissed: [],
    }),
    null,
    'an unpackaged build installs nothing',
  )
  assert.equal(
    outstandingAppUpdate({ state: appState({ version: '0.7.0' }), dismissed: [] }),
    null,
    'installed: the new build reports nothing waiting',
  )

  // Dismissal names the version and the step.
  const offered = appState({ status: 'available', updateVersion: '0.7.0' })
  const ready = appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' })
  assert.equal(outstandingAppUpdate({ state: offered, dismissed: [appUpdateKey('0.7.0', 'offer')] }), null)
  assert.deepEqual(
    outstandingAppUpdate({ state: ready, dismissed: [appUpdateKey('0.7.0', 'offer')] }),
    { version: '0.7.0', stage: 'ready' },
    'waving off the offer does not silence "ready to restart"',
  )
  assert.equal(outstandingAppUpdate({ state: ready, dismissed: [appUpdateKey('0.7.0', 'ready')] }), null)
  assert.deepEqual(
    outstandingAppUpdate({
      state: appState({ status: 'available', updateVersion: '0.8.0' }),
      dismissed: [appUpdateKey('0.7.0', 'offer')],
    }),
    { version: '0.8.0', stage: 'offer' },
    'a newer release badges again',
  )
})

test('one derivation feeds the gear, General, Agents, the switcher and the rows', () => {
  const none = settingsUpdateBadges({ cliUpdates: [], appUpdate: null })
  assert.equal(none.rail, null, 'nothing waiting draws nothing — never a 0')
  assert.equal(none.general, null)
  assert.equal(none.agents, null)
  assert.deepEqual(none.machines, {})
  assert.deepEqual(none.clis, {})

  const cliOnly = settingsUpdateBadges({ cliUpdates: [advisory('codex'), advisory('gemini')], appUpdate: null })
  assert.deepEqual(cliOnly.agents, {
    count: 2,
    tone: 'accent',
    label: 'Agents: 2 CLI updates available',
    detail: '2 CLI updates available',
  })
  assert.equal(cliOnly.general, null, 'General only badges for the app')
  assert.deepEqual(cliOnly.machines, { local: cliOnly.agents }, 'this PC’s updates badge This PC only')
  assert.deepEqual([...(cliOnly.clis.local ?? [])], ['codex', 'gemini'])
  assert.equal(cliOnly.rail?.count, 2)
  assert.equal(cliOnly.rail?.label, '2 updates available')

  const both = settingsUpdateBadges({
    cliUpdates: [advisory('codex')],
    appUpdate: { version: '0.7.0', stage: 'offer' },
  })
  assert.deepEqual(both.general, {
    count: 1,
    tone: 'accent',
    label: 'General: update available',
    detail: 'Update available',
  })
  assert.equal(
    settingsUpdateBadges({ cliUpdates: [], appUpdate: { version: '0.7.0', stage: 'ready' } }).general?.detail,
    'Update ready to install',
    'once it is on disk, General says it is ready',
  )
  assert.equal(both.agents?.detail, '1 CLI update available')
  assert.equal(both.rail?.count, 1, 'the gear counts the CLIs; the app has its own glyph on the rail')

  const appOnly = settingsUpdateBadges({ cliUpdates: [], appUpdate: { version: '0.7.0' } })
  assert.equal(appOnly.rail, null, 'the app update lights the rail’s update glyph, not the gear')
  assert.equal(appOnly.general?.count, 1, 'General still says it')
  assert.equal(appOnly.agents, null)
})
