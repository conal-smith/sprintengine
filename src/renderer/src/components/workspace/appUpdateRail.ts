// The app update's glyph on the rail (owner ruling 2026-10-30): the update
// lives at the rail's foot instead of arriving as a toast. The glyph is there
// in every packaged build, quiet while there is nothing to take, and lights up
// in the accent once a release is waiting. One press walks it forward:
//
//   idle         Check for updates        press → check now
//   checking     spinning                 —
//   available    download arrow, lit      press → download (the consent)
//   downloading  ring filling with %      —
//   ready        restart arrow, lit       press → confirm, then restart into it
//   installing   spinning                 —
//
// A download that failed stays `available`, so the same press tries again.
// Toasts are left for what the press leads to: "Update downloaded" when it
// lands, and a warning when something refused (appUpdateToast.ts).
//
// Pure: the component that reads the store is AppUpdateRailButton.

import type { AppUpdateState } from '../../../../shared/electron-api'

export type AppUpdateRailPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing'

export type AppUpdateRailAction = 'check' | 'download' | 'install' | 'none'

export type AppUpdateRailView = {
  phase: AppUpdateRailPhase
  action: AppUpdateRailAction
  /** In the accent: a release is waiting on the person. */
  lit: boolean
  /** 0–100 while downloading, else null. */
  percent: number | null
  /** The tooltip, and the accessible name. */
  label: string
}

const APP_NAME = 'SprintEngine Studio'

function named(version: string | null): string {
  return version ? `${APP_NAME} ${version}` : `The ${APP_NAME} update`
}

/**
 * What the glyph shows and what pressing it does, from update-service's own
 * state. Null when there is no glyph at all: before main has answered, and in
 * an unpackaged build, which follows no release train.
 */
export function appUpdateRailView(state: AppUpdateState | null): AppUpdateRailView | null {
  if (!state || !state.packaged) return null
  const version = state.updateVersion

  if (state.status === 'installing') {
    return { phase: 'installing', action: 'none', lit: true, percent: null, label: 'Installing update…' }
  }
  // Main puts a refused install back to `downloaded`, so this is also the retry.
  if (state.downloaded || state.status === 'downloaded') {
    return {
      phase: 'ready',
      action: 'install',
      lit: true,
      percent: null,
      label: `${named(version)} is downloaded. Restart to install it.`,
    }
  }
  if (state.status === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.floor(state.progress?.percent ?? 0)))
    return {
      phase: 'downloading',
      action: 'none',
      lit: true,
      percent,
      label: version ? `Downloading ${version} (${percent}%)` : `Downloading update (${percent}%)`,
    }
  }
  if (state.status === 'error' && version) {
    return {
      phase: 'available',
      action: 'download',
      lit: true,
      percent: null,
      label: `${named(version)} did not download. Click to try again.`,
    }
  }
  // The hourly re-check of an update already found is still the same offer:
  // the glyph does not go dark for the length of the check.
  if (state.status === 'available' || (state.status === 'checking' && version)) {
    return {
      phase: 'available',
      action: 'download',
      lit: true,
      percent: null,
      label: `${named(version)} is available. Click to download.`,
    }
  }
  if (state.status === 'checking') {
    return { phase: 'checking', action: 'none', lit: false, percent: null, label: 'Checking for updates…' }
  }
  if (state.status === 'error') {
    return {
      phase: 'idle',
      action: 'check',
      lit: false,
      percent: null,
      label: 'The update check failed. Click to try again.',
    }
  }
  if (state.status === 'not_available') {
    return {
      phase: 'idle',
      action: 'check',
      lit: false,
      percent: null,
      label: `${APP_NAME} is up to date. Click to check again.`,
    }
  }
  return { phase: 'idle', action: 'check', lit: false, percent: null, label: 'Check for updates' }
}

/** The question the ready glyph asks before it restarts the app. */
export function appUpdateInstallConfirmation(state: Pick<AppUpdateState, 'updateVersion' | 'installRequiresAdmin'>): {
  title: string
  body: string
  confirmLabel: string
} {
  const admin = state.installRequiresAdmin ? ' Windows will ask for administrator permission.' : ''
  return {
    title: state.updateVersion ? `Install ${APP_NAME} ${state.updateVersion}?` : 'Install the update?',
    body: `${APP_NAME} quits and reopens on the new version. Agents that are still working are interrupted.${admin}`,
    confirmLabel: 'Restart to update',
  }
}
