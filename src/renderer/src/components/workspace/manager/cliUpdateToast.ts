// The toast that offers to update an agent CLI, and running the update
// it offers.

import { useEffect } from 'react'

import type { CliVersionAdvisory } from '../../../../../shared/electron-api'
import { executionHostLabel, LOCAL_HOST_ID } from '../../../../../shared/execution-host'
import { useNotificationStore } from '../../../store/notificationStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { cliUpdateKey } from '../../../utils/settingsUpdateBadges'
import { cliUpdateNotice } from '../../../utils/feedNotifications'
import { publishDiagnosticSync } from '../../../utils/diagnostics'
import { useToastStore, showToast } from '../../../store/toastStore'
import { cliRuntimeOnMachine } from '../newWorkspace/cliRuntimeOptions'
import { hostPlatform } from '../../../clientCapabilities'
import { createCliOutputLatestLineReader, withLastOutputLine } from './cliUpdateProgress'

// The CLI-update toast (owner ruling 2026-09-04): the CLI's glyph,
// "Update available: Codex 0.153.3", and two buttons — Settings, and Update,
// which runs the same command the Settings row runs and reports in place.
// One of the two toasts with actions (the other is the app-update toast);
// main sends each (machine, cli, version) once. A WSL distribution's update
// names the machine, and is its own toast beside this machine's for the same
// CLI: they are two installs, updated separately.
// It leaves after a minute (owner ruling 2026-09-18): a notice nobody asked
// for should not sit in the corner until clicked, and the bell entry below
// and the Settings row still say the same thing once it has gone.
//
// Leaving on its own is not a dismissal: the update's badges (the Settings
// gear, Agents, the machine's segment and the row — owner ruling 2026-09-25)
// stay until the update is installed or the person presses the toast's
// Dismiss, which is them saying "not now" to this version on this machine.
export const CLI_UPDATE_TOAST_MS = 60_000

// How often, at most, the running update's toast takes a new output line:
// four a second reads as live without the toast flickering through every
// frame of a progress bar.
export const CLI_UPDATE_PROGRESS_INTERVAL_MS = 250

function toastId(advisory: Pick<CliVersionAdvisory, 'cli' | 'hostId'>): string {
  return advisory.hostId === LOCAL_HOST_ID
    ? `cli-update:${advisory.cli}`
    : `cli-update:${advisory.hostId}:${advisory.cli}`
}

function machineLabel(hostId: CliVersionAdvisory['hostId']): string | null {
  if (hostId === LOCAL_HOST_ID) return null
  return executionHostLabel(hostId, hostPlatform())
}

// First run holds them back. The toast region sits in the bottom-right
// corner and the onboarding cards are centred, so in a small window (900×600)
// two update offers landed on the import card's own buttons. Main sends an
// update once per version, so dropping it would lose it: it waits instead,
// and is offered the moment the card is answered. The bell entry is not
// held — it covers nothing.
let holds = 0
const heldAdvisories = new Map<string, CliVersionAdvisory>()
// What each update toast up now is offering, so a hold that begins while one
// is already showing can take it down and offer it again afterwards.
const offeredAdvisories = new Map<string, CliVersionAdvisory>()

/**
 * Keep CLI-update toasts out of the corner until the returned release is
 * called. Offers already showing are taken down and made again on release,
 * with a fresh minute. Holds nest: the last release shows them.
 */
export function holdCliUpdateToasts(): () => void {
  holds += 1
  const { toasts, dismissToast } = useToastStore.getState()
  for (const shown of toasts) {
    const advisory = offeredAdvisories.get(shown.id)
    // Only the offer itself: an update already running reports its progress
    // and its result in place, and that is the answer to a press.
    if (!advisory || !shown.actions?.some((action) => action.id === 'update')) continue
    heldAdvisories.set(shown.id, advisory)
    dismissToast(shown.id)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
    if (holds > 0) return
    const queued = [...heldAdvisories.values()]
    heldAdvisories.clear()
    for (const advisory of queued) presentCliUpdateToast(advisory)
  }
}

/** Hold CLI-update toasts while the calling surface is mounted. */
export function useHoldCliUpdateToasts(): void {
  useEffect(() => holdCliUpdateToasts(), [])
}

export function showCliUpdateToast(advisory: CliVersionAdvisory): void {
  const store = useWorkspaceStore.getState()
  const displayName = (cli: string): string =>
    store.pluginCatalogEntries.find((entry) => entry.id === cli)?.displayName ?? cli
  const notice = cliUpdateNotice(advisory, displayName, machineLabel(advisory.hostId))
  publishDiagnosticSync({
    level: 'info',
    source: 'cli',
    title: notice.title,
    message: advisory.currentVersion ? `Installed ${advisory.currentVersion}` : 'Installed version unknown',
    // The bell's Open lands on the machine the update is for (`agents@<host>`).
    navigationTarget: {
      kind: 'settings',
      ref: advisory.hostId === LOCAL_HOST_ID ? 'agents' : `agents@${advisory.hostId}`,
    },
  })
  if (holds > 0) heldAdvisories.set(toastId(advisory), advisory)
  else presentCliUpdateToast(advisory)
}

function presentCliUpdateToast(advisory: CliVersionAdvisory): void {
  const store = useWorkspaceStore.getState()
  const displayName = (cli: string): string =>
    store.pluginCatalogEntries.find((entry) => entry.id === cli)?.displayName ?? cli
  const name = displayName(advisory.cli)
  const machine = machineLabel(advisory.hostId)
  const notice = cliUpdateNotice(advisory, displayName, machine)
  const id = toastId(advisory)
  offeredAdvisories.set(id, advisory)
  const dismiss = (): void => useToastStore.getState().dismissToast(id)
  const dismissUpdate = (): void => useNotificationStore.getState().dismissUpdate(cliUpdateKey(advisory))
  showToast({
    id,
    tone: 'neutral',
    cli: advisory.cli,
    title: notice.title,
    autoDismissMs: CLI_UPDATE_TOAST_MS,
    onDismissPressed: dismissUpdate,
    actions: [
      {
        id: 'settings',
        label: 'Settings',
        run: () => {
          dismiss()
          // The Agents tab opens on the machine the update is for, even when
          // it last showed another one.
          useWorkspaceStore.getState().openSettingsOverlay({ initialTab: 'agents', agentsMachine: advisory.hostId })
        },
      },
      {
        id: 'update',
        label: 'Update',
        primary: true,
        run: () => {
          void runCliUpdateFromToast(advisory, machine ? `${name} (${machine})` : name, id)
        },
      },
    ],
  })
}

export async function runCliUpdateFromToast(
  advisory: Pick<CliVersionAdvisory, 'cli' | 'hostId' | 'currentVersion'>,
  name: string,
  id: string,
): Promise<void> {
  const api = window.api
  if (typeof api.cliUpdate !== 'function') return
  const { cli, hostId } = advisory
  const store = useWorkspaceStore.getState()
  const runtime = cliRuntimeOnMachine(cli, hostId, store.appSettings)
  const before = (hostId === LOCAL_HOST_ID ? store.cliAvailability[cli]?.version : advisory.currentVersion) ?? null
  const showUpdating = (description?: string): void => {
    showToast({ id, tone: 'neutral', cli, title: `Updating ${name}…`, description, autoDismissMs: false })
  }
  showUpdating()
  // The updater's newest line rides under the title while it runs: an npm
  // install can take a minute, and a bare "Updating…" for all of it reads as
  // stuck. Main streams the output on the channel installs use, the one the
  // Settings row's log reads too. Throttled, because an updater redrawing a
  // progress bar sends far more chunks than a toast can usefully show.
  const output = createCliOutputLatestLineReader()
  let shownLine = ''
  let lastShownAt = 0
  let progressTimer: ReturnType<typeof setTimeout> | null = null
  const showProgress = (): void => {
    progressTimer = null
    const line = output.latest()
    if (line === shownLine) return
    // A toast the person dismissed stays dismissed: re-showing the id would
    // put it back. The result still reports when the update settles.
    if (!useToastStore.getState().toasts.some((toast) => toast.id === id)) return
    shownLine = line
    lastShownAt = Date.now()
    showUpdating(line)
  }
  const unsubscribe =
    typeof api.onCliInstallOutput === 'function'
      ? api.onCliInstallOutput(
          cli,
          (chunk) => {
            output.push(chunk)
            if (progressTimer !== null) return
            progressTimer = setTimeout(
              showProgress,
              Math.max(0, lastShownAt + CLI_UPDATE_PROGRESS_INTERVAL_MS - Date.now()),
            )
          },
          hostId,
        )
      : () => undefined
  // A failure keeps the updater's last line, so the toast that says it did not
  // update also says where it stopped.
  const failure = (description: string): string => withLastOutputLine(description, output.latest())
  try {
    const result = await api.cliUpdate(cli, runtime)
    if (result.ok && result.version && result.version.trim() !== (before ?? '').trim()) {
      showToast({ id, tone: 'good', cli, title: `${name} updated to ${result.version.trim()}` })
    } else if (result.ok) {
      showToast({
        id,
        tone: 'warn',
        cli,
        title: `${name} did not update`,
        description: failure(
          `The update finished but the version is still ${before ?? 'the same'}. Settings › Agents has the command to run by hand.`,
        ),
      })
    } else {
      showToast({
        id,
        tone: 'warn',
        cli,
        title: `${name} did not update`,
        description: failure(result.error ?? 'The update did not finish.'),
      })
    }
  } catch (error) {
    showToast({
      id,
      tone: 'warn',
      cli,
      title: `${name} did not update`,
      description: failure(error instanceof Error ? error.message : String(error)),
    })
  } finally {
    if (progressTimer !== null) clearTimeout(progressTimer)
    unsubscribe()
  }
  // Main detected the CLI again when the update finished and recorded it, for
  // this CLI on this machine only, so these reads pick up the new version
  // without probing anything else.
  const after = useWorkspaceStore.getState()
  if (hostId === LOCAL_HOST_ID) await after.refreshCliAvailability({ cliRuntimes: after.appSettings.cliRuntimes })
  void after.refreshCliVersionAdvisories()
}
