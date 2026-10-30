import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AppUpdateState } from '../../../../shared/electron-api'
import { appUpdateInstallConfirmation, appUpdateRailView } from './appUpdateRail'

// The rail's update glyph (owner ruling 2026-10-30): quiet with nothing to
// take, lit while a release waits, and one press walks it forward.

function state(patch: Partial<AppUpdateState>): AppUpdateState {
  return {
    status: 'idle',
    version: '0.5.2',
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
    ...patch,
  }
}

const view = (patch: Partial<AppUpdateState>) => appUpdateRailView(state(patch))

test('no glyph before main answers, or in a build that follows no train', () => {
  assert.equal(appUpdateRailView(null), null)
  assert.equal(view({ packaged: false, status: 'available', updateVersion: '0.7.0' }), null)
})

test('with nothing to take it is quiet, and a press checks', () => {
  assert.deepEqual(view({}), { phase: 'idle', action: 'check', lit: false, percent: null, label: 'Check for updates' })
  assert.equal(view({ status: 'not_available' })?.label, 'SprintEngine Studio is up to date. Click to check again.')
  assert.equal(view({ status: 'error', errorMessage: 'offline' })?.action, 'check')
  assert.deepEqual(view({ status: 'checking' }), {
    phase: 'checking',
    action: 'none',
    lit: false,
    percent: null,
    label: 'Checking for updates…',
  })
})

test('a found release lights it, and a press downloads', () => {
  assert.deepEqual(view({ status: 'available', updateVersion: '0.7.0' }), {
    phase: 'available',
    action: 'download',
    lit: true,
    percent: null,
    label: 'SprintEngine Studio 0.7.0 is available. Click to download.',
  })
  // The hourly re-check of the same offer does not darken it.
  assert.equal(view({ status: 'checking', updateVersion: '0.7.0' })?.phase, 'available')
  // A download that failed is the same offer, pressed again.
  assert.deepEqual(
    view({ status: 'error', updateVersion: '0.7.0', errorMessage: 'socket hang up' })?.action,
    'download',
  )
})

test('downloading draws the share that has arrived, and a press does nothing', () => {
  const downloading = view({
    status: 'downloading',
    updateVersion: '0.7.0',
    progress: { percent: 41.6, transferred: 1, total: 1, bytesPerSecond: 1 },
  })
  assert.equal(downloading?.action, 'none')
  assert.equal(downloading?.lit, true)
  assert.equal(downloading?.percent, 41)
  assert.equal(downloading?.label, 'Downloading 0.7.0 (41%)')
  assert.equal(view({ status: 'downloading', progress: null })?.percent, 0)
})

test('a downloaded release asks to restart, including after a refused restart', () => {
  assert.deepEqual(view({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' }), {
    phase: 'ready',
    action: 'install',
    lit: true,
    percent: null,
    label: 'SprintEngine Studio 0.7.0 is downloaded. Restart to install it.',
  })
  assert.equal(view({ status: 'checking', downloaded: true, updateVersion: '0.7.0' })?.action, 'install')
  assert.equal(view({ status: 'installing', downloaded: true, updateVersion: '0.7.0' })?.action, 'none')
})

test('the restart is asked first, and says Windows will ask when it will', () => {
  assert.deepEqual(appUpdateInstallConfirmation({ updateVersion: '0.7.0', installRequiresAdmin: false }), {
    title: 'Install SprintEngine Studio 0.7.0?',
    body: 'SprintEngine Studio quits and reopens on the new version. Agents that are still working are interrupted.',
    confirmLabel: 'Restart to update',
  })
  assert.match(
    appUpdateInstallConfirmation({ updateVersion: null, installRequiresAdmin: true }).body,
    /Windows will ask for administrator permission\.$/,
  )
})
