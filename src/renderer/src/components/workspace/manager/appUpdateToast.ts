// The app update's toasts. The update itself lives on the rail's update glyph
// (owner ruling 2026-10-30, AppUpdateRailButton): a release that is found
// lights the glyph rather than raising a toast, and the download's progress is
// the ring the glyph draws. A toast is left for what a press leads to:
//
//   downloaded   "Update downloaded"     Release notes   (once per version; it
//                                                         says where to restart from)
//   installing   "Installing update"     Restart to update, busy (the press went through)
//   refused      "Update not installed"  Later · Restart to update, and why
//   failed       "The update did not download", and why (the glyph is the retry)
//
// and, at the start after an update, "Updated to X" or "Update to X did not
// install".
//
// Dismissing the downloaded toast, or Later on a refused restart, is the person
// saying "not now" to this version at this step, so it clears the update's
// badge on Settings ▸ General (owner ruling 2026-09-25).

import type { AppUpdateInstallOutcome, AppUpdateState } from '../../../../../shared/electron-api'
import { publishDiagnosticSync } from '../../../utils/diagnostics'
import { updateReadyNotice } from '../../../utils/feedNotifications'
import { appUpdateKey, type AppUpdateStage } from '../../../utils/settingsUpdateBadges'
import { useNotificationStore } from '../../../store/notificationStore'
import { showToast, useToastStore } from '../../../store/toastStore'

export const APP_UPDATE_TOAST_ID = 'app-update:ready'
// How the last update went: its own toast, so it never replaces another the
// start-up check raised in the same breath.
export const APP_UPDATE_OUTCOME_TOAST_ID = 'app-update:outcome'

const APP_NAME = 'SprintEngine Studio'

type Phase = 'ready' | 'installing' | 'refused'

// Which step the toast is showing, when it is showing one.
let phase: Phase | null = null
// Installing needs an administrator (main's `installRequiresAdmin`), so the
// installing toast says Windows will ask.
let installNeedsAdmin = false
// A download is announced once per version per window, however it arrived.
const announcedVersions = new Set<string>()
// The version the ready toast is about, for a refused restart's Later.
let readyVersion: string | null = null

function dismiss(): void {
  phase = null
  useToastStore.getState().dismissToast(APP_UPDATE_TOAST_ID)
}

/** Record "not now" for this version at this step: its Settings badge clears. */
function dismissUpdate(version: string | null, stage: AppUpdateStage): () => void {
  return () => useNotificationStore.getState().dismissUpdate(appUpdateKey(version, stage))
}

/** Later: "not now", and the toast goes. */
function later(version: string | null, stage: AppUpdateStage) {
  const notNow = dismissUpdate(version, stage)
  return {
    id: 'later',
    label: 'Later',
    run: () => {
      notNow()
      dismiss()
    },
  }
}

/** Resolves after the browser has painted what was just rendered. */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/**
 * Download the offered update: the rail glyph's press, and the consent to
 * download (owner ruling 2026-09-24: nothing downloads until asked, unless
 * automatic download is on). Progress is the glyph's ring; only a failure
 * speaks, and the glyph stays lit to try again.
 */
export async function downloadAppUpdate(version: string | null): Promise<void> {
  const api = window.api
  if (typeof api.updateDownload !== 'function') return
  try {
    const result = await api.updateDownload()
    if (result.ok) return
    showDownloadFailed(version, result.message)
  } catch (error) {
    showDownloadFailed(version, error instanceof Error ? error.message : String(error))
  }
}

function showDownloadFailed(version: string | null, message: string): void {
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'warn',
    title: 'The update did not download',
    description: message,
    onDismissPressed: dismissUpdate(version, 'offer'),
  })
}

function restartAction(busy: boolean) {
  return {
    id: 'restart',
    label: busy ? 'Restarting…' : 'Restart to update',
    primary: true,
    busy,
    run: () => {
      if (!busy) void restartToUpdateFromToast({ installRequiresAdmin: installNeedsAdmin })
    },
  }
}

/**
 * The download landed: say so once, and say where to restart from. It times
 * out like any other news — the lit glyph keeps saying it is ready, and the
 * update installs at the next quit anyway (unless it needs an administrator).
 */
export function showAppUpdateReadyToast(state: Pick<AppUpdateState, 'updateVersion'> & Partial<AppUpdateState>): void {
  installNeedsAdmin = state.installRequiresAdmin === true
  const notice = updateReadyNotice(APP_NAME, state.updateVersion, installNeedsAdmin)
  publishDiagnosticSync({
    level: 'info',
    source: 'update',
    title: notice.title,
    message: notice.description,
    navigationTarget: { kind: 'settings', ref: 'general' },
  })
  phase = 'ready'
  readyVersion = state.updateVersion
  const opensNotes = Boolean(state.releaseNotesUrl) && typeof window.api?.updateOpenReleaseNotes === 'function'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'good',
    title: 'Update downloaded',
    description: state.updateVersion
      ? `${APP_NAME} ${state.updateVersion} is ready. Restart from the update button on the rail to install it.`
      : 'Restart from the update button on the rail to install it.',
    onDismissPressed: dismissUpdate(state.updateVersion, 'ready'),
    actions: opensNotes
      ? [
          {
            id: 'release-notes',
            label: 'Release notes',
            run: () => {
              void window.api.updateOpenReleaseNotes().catch(() => undefined)
            },
          },
        ]
      : undefined,
  })
}

/**
 * Restart to update. The toast says so BEFORE main is asked (owner ruling
 * 2026-09-24: the press must show at once), and main is only asked once that
 * has been painted: main's shutdown runs next, and the progress window takes
 * over from this toast.
 */
export async function restartToUpdateFromToast(
  state: Partial<Pick<AppUpdateState, 'installRequiresAdmin'>> = {},
): Promise<void> {
  const api = window.api
  if (typeof api.updateQuitAndInstall !== 'function') return
  if (state.installRequiresAdmin !== undefined) installNeedsAdmin = state.installRequiresAdmin
  phase = 'installing'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'neutral',
    title: 'Installing update',
    description: installNeedsAdmin
      ? 'Windows will ask for administrator permission, then Studio restarts.'
      : 'Studio will restart in a moment…',
    autoDismissMs: false,
    actions: [restartAction(true)],
  })
  await nextPaint()
  try {
    const result = await api.updateQuitAndInstall()
    if (result.ok) return
    showRestartRefused(result.message)
  } catch (error) {
    showRestartRefused(error instanceof Error ? error.message : String(error))
  }
}

function showRestartRefused(message: string): void {
  phase = 'refused'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'warn',
    title: 'Update not installed',
    description: message,
    onDismissPressed: dismissUpdate(readyVersion, 'ready'),
    actions: [later(readyVersion, 'ready'), restartAction(false)],
  })
}

/** How the last update went, once, at the start after it. */
export function showAppUpdateOutcomeToast(outcome: AppUpdateInstallOutcome): void {
  const title =
    outcome.kind === 'updated'
      ? `Updated to ${APP_NAME} ${outcome.version}`
      : `Update to ${outcome.version} did not install`
  const description =
    outcome.kind === 'updated'
      ? `${APP_NAME} was updated from ${outcome.fromVersion}.`
      : (outcome.message ?? `${APP_NAME} is still on ${outcome.fromVersion}.`)
  publishDiagnosticSync({
    level: outcome.kind === 'updated' ? 'info' : 'warning',
    source: 'update',
    title,
    message: description,
    navigationTarget: { kind: 'settings', ref: 'general' },
  })
  showToast({
    id: APP_UPDATE_OUTCOME_TOAST_ID,
    tone: outcome.kind === 'updated' ? 'good' : 'warn',
    title,
    description,
  })
}

/**
 * The toasts, driven by main's update state. Called on every state push. Only
 * the download landing is announced; a found update and its progress are the
 * rail glyph's to show.
 */
export function createAppUpdateToastDriver(): (state: AppUpdateState) => void {
  let last: AppUpdateState['status'] | null = null
  return (state) => {
    // Not while an install is being asked for or was just refused: main puts a
    // refused install back to `downloaded` before its answer reaches the
    // toast, and that is not a fresh download.
    if (state.status === 'downloaded' && last !== 'downloaded' && phase !== 'refused' && phase !== 'installing') {
      const key = state.updateVersion ?? ''
      if (!announcedVersions.has(key)) {
        announcedVersions.add(key)
        showAppUpdateReadyToast(state)
      }
    }
    last = state.status
  }
}

/** For tests: forget which versions were announced and what the toast shows. */
export function resetAppUpdateToastForTests(): void {
  phase = null
  installNeedsAdmin = false
  readyVersion = null
  announcedVersions.clear()
}
