// The update badges Settings wears (owner ruling 2026-09-25): an agent CLI with
// a newer release, and a newer SprintEngine Studio, each point the person at the
// place that installs it — and they point there from wherever the person is.
//
//   Settings rail glyph   the CLI updates (the app's own has the rail's
//                         update glyph, owner ruling 2026-10-30)
//   Settings ▸ General    the app update
//   Settings ▸ Agents     the CLI updates
//   machine switcher      the CLI updates on that machine
//   a CLI's row           that CLI on that machine, beside its Update button
//
// One derivation feeds all five, so the glyph, the nav and the rows can never
// disagree about how many there are. A CLI behind on two machines is two
// updates: each is its own Update button, on its own machine's list. Every one
// is the kit's count badge, named ("2 updates available") so the number is
// never the only thing a screen reader or a person who does not see the accent
// gets.
//
// An update stops being counted when it is installed (the advisory stops saying
// `behind_latest`; the app state stops offering a version) or when the person
// dismisses it — pressing Dismiss or Later on its toast. A dismissal names one
// version (and, for the app, one step), so the next release badges again.
// Dismissing clears the badges and nothing else: the Update button and the
// version line stay, because the update is still there to take.
//
// Pure: the hook that reads the stores is `useSettingsUpdateBadges`.

import type { AppUpdateState, CliVersionAdvisory, CliVersionHostAdvisories } from '../../../shared/electron-api'
import { LOCAL_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { Tone } from '../components/ui/tokens'

export type SettingsUpdateBadge = {
  count: number
  tone: Tone
  /** The accessible name with the place in it: "Agents: 2 CLI updates available". */
  label: string
  /** What is counted, for a control that already names the place: "2 CLI updates available". */
  detail: string
}

// News, not trouble: the accent, the tone the rail gives plain news.
const UPDATE_TONE: Tone = 'accent'

/**
 * The dismissal key for one CLI's one release on one machine. This machine's
 * keeps the spelling it had before other machines were checked, so a version
 * already dismissed here stays dismissed.
 */
export function cliUpdateKey(advisory: Pick<CliVersionAdvisory, 'cli' | 'latestVersion' | 'hostId'>): string {
  const machine = advisory.hostId === LOCAL_HOST_ID ? '' : `${advisory.hostId}|`
  return `cli:${machine}${advisory.cli}@${advisory.latestVersion ?? ''}`
}

/**
 * Which question about an app release the person said "not now" to: the offer
 * to download it, or — once it is on disk — the offer to restart into it. A
 * later step is news of its own, so dismissing the offer does not silence
 * "ready to restart".
 */
export type AppUpdateStage = 'offer' | 'ready'

/** The dismissal key for one app release at one step. */
export function appUpdateKey(version: string | null, stage: AppUpdateStage): string {
  return `app@${version ?? ''}:${stage}`
}

/**
 * The CLIs with a newer release the person has not dismissed, on every machine
 * main checks — this one and each WSL distribution turned on.
 *
 * Only what the Agents rows would offer Update for: version checks on, the
 * advisory behind with a version to name, and the CLI detected on that machine
 * (a stale advisory for a CLI since removed must not count a row that shows no
 * Update).
 */
export function outstandingCliUpdates(input: {
  advisories: CliVersionHostAdvisories
  checkCliVersions: boolean
  installed: (hostId: ExecutionHostId, cli: string) => boolean
  dismissed: readonly string[]
}): CliVersionAdvisory[] {
  if (!input.checkCliVersions) return []
  const dismissed = new Set(input.dismissed)
  return Object.values(input.advisories)
    .flatMap((map) => Object.values(map ?? {}))
    .filter(
      (advisory): advisory is CliVersionAdvisory =>
        advisory !== undefined &&
        advisory.status === 'behind_latest' &&
        Boolean(advisory.latestVersion) &&
        input.installed(advisory.hostId, advisory.cli) &&
        !dismissed.has(cliUpdateKey(advisory)),
    )
}

/**
 * The step an app update is at, from update-service's own state, or null when
 * there is none waiting:
 *
 *   available → downloading          'offer'  (Download is the question)
 *   downloaded → installing          'ready'  (Restart to update is)
 *
 * A restart main refused goes back to `downloaded` with the reason, and stays
 * 'ready'. A download that failed leaves `error` with the version it was
 * fetching: the update is still there to take (the version row offers Download
 * again), so it stays 'offer'. A check that failed with nothing found is not
 * an update.
 */
function appUpdateStage(state: AppUpdateState | null): AppUpdateStage | null {
  if (!state || !state.packaged) return null
  if (state.downloaded || state.status === 'downloaded' || state.status === 'installing') return 'ready'
  if (state.status === 'available' || state.status === 'downloading') return 'offer'
  // The hourly re-check of an update already offered: still the same offer, so
  // the badge does not blink out for the length of the check.
  if (state.status === 'checking' && state.updateVersion) return 'offer'
  if (state.status === 'error' && state.updateVersion) return 'offer'
  return null
}

/**
 * The app release waiting to be installed, unless its current step was
 * dismissed. Read off update-service's own state (`update:state-changed`), so
 * it holds whichever way the update arrives — offered and downloaded when
 * asked, or downloaded on its own and ready — through every step to the
 * restart. After the restart the new build reports no update, and it clears.
 */
export function outstandingAppUpdate(input: {
  state: AppUpdateState | null
  dismissed: readonly string[]
}): { version: string | null; stage: AppUpdateStage } | null {
  const stage = appUpdateStage(input.state)
  if (!input.state || !stage) return null
  if (input.dismissed.includes(appUpdateKey(input.state.updateVersion, stage))) return null
  return { version: input.state.updateVersion, stage }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export type SettingsUpdateBadges = {
  rail: SettingsUpdateBadge | null
  general: SettingsUpdateBadge | null
  agents: SettingsUpdateBadge | null
  /** Per machine on the Agents switcher; a machine with none is absent. */
  machines: Readonly<Partial<Record<ExecutionHostId, SettingsUpdateBadge>>>
  /** Per machine, the CLIs whose rows on its list wear a badge beside Update. */
  clis: Readonly<Partial<Record<ExecutionHostId, ReadonlySet<string>>>>
}

export function settingsUpdateBadges(input: {
  cliUpdates: readonly CliVersionAdvisory[]
  appUpdate: { version: string | null; stage?: AppUpdateStage } | null
}): SettingsUpdateBadges {
  const cliCount = input.cliUpdates.length
  const cliDetailFor = (count: number): string => plural(count, 'CLI update available', 'CLI updates available')
  const cliDetail = cliDetailFor(cliCount)
  const agents: SettingsUpdateBadge | null =
    cliCount > 0 ? { count: cliCount, tone: UPDATE_TONE, label: `Agents: ${cliDetail}`, detail: cliDetail } : null
  const byMachine = new Map<ExecutionHostId, CliVersionAdvisory[]>()
  for (const advisory of input.cliUpdates) {
    byMachine.set(advisory.hostId, [...(byMachine.get(advisory.hostId) ?? []), advisory])
  }
  const machines: Partial<Record<ExecutionHostId, SettingsUpdateBadge>> = {}
  const clis: Partial<Record<ExecutionHostId, ReadonlySet<string>>> = {}
  for (const [hostId, updates] of byMachine) {
    const detail = cliDetailFor(updates.length)
    machines[hostId] = { count: updates.length, tone: UPDATE_TONE, label: `Agents: ${detail}`, detail }
    clis[hostId] = new Set(updates.map((advisory) => advisory.cli))
  }
  // Once it is on disk the news is that it is ready, which is what General's
  // version row is then asking about (Restart to update).
  const appDetail = input.appUpdate?.stage === 'ready' ? 'Update ready to install' : 'Update available'
  const general: SettingsUpdateBadge | null = input.appUpdate
    ? { count: 1, tone: UPDATE_TONE, label: `General: ${appDetail.toLowerCase()}`, detail: appDetail }
    : null
  // The gear counts the CLIs only: the app's own update lights the rail's
  // update glyph right beside it, and one release is not two pieces of news.
  const railDetail = plural(cliCount, 'update available', 'updates available')
  return {
    rail: cliCount > 0 ? { count: cliCount, tone: UPDATE_TONE, label: railDetail, detail: railDetail } : null,
    general,
    agents,
    machines,
    clis,
  }
}
