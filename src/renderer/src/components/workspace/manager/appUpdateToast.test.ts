import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateState } from '../../../../../shared/electron-api'
import { useNotificationStore } from '../../../store/notificationStore'
import { useToastStore } from '../../../store/toastStore'

const diagnostics = vi.hoisted(() => ({ published: [] as Array<{ title: string; source: string }> }))
vi.mock('../../../utils/diagnostics', () => ({
  publishDiagnosticSync: (input: { title: string; source: string }) => {
    diagnostics.published.push(input)
  },
}))

const {
  APP_UPDATE_OUTCOME_TOAST_ID,
  APP_UPDATE_TOAST_ID,
  createAppUpdateToastDriver,
  downloadAppUpdate,
  resetAppUpdateToastForTests,
  restartToUpdateFromToast,
  showAppUpdateOutcomeToast,
  showAppUpdateReadyToast,
} = await import('./appUpdateToast')

const anyGlobal = globalThis as unknown as { window?: unknown }
let installs = 0
let downloads = 0
let notesOpened = 0
let answer: () => Promise<AppUpdateCheckResult>
let downloadAnswer: () => Promise<AppUpdateCheckResult>
// What the toast looked like at the moment main was asked to install.
let toastWhenMainWasAsked: ReturnType<typeof toast>

function ok(message = 'Restarting to install update.'): Promise<AppUpdateCheckResult> {
  return Promise.resolve({ ok: true, state: {} as AppUpdateState, message })
}

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

beforeEach(() => {
  installs = 0
  downloads = 0
  notesOpened = 0
  answer = () => ok()
  downloadAnswer = () => ok('Update ready to install.')
  toastWhenMainWasAsked = undefined
  diagnostics.published.length = 0
  resetAppUpdateToastForTests()
  useToastStore.setState({ toasts: [] })
  anyGlobal.window = {
    api: {
      updateQuitAndInstall: () => {
        installs += 1
        toastWhenMainWasAsked = toast()
        return answer()
      },
      updateDownload: () => {
        downloads += 1
        return downloadAnswer()
      },
      updateOpenReleaseNotes: () => {
        notesOpened += 1
        return Promise.resolve({ opened: true, url: 'https://example.com/notes' })
      },
    },
  }
})

afterEach(() => {
  delete anyGlobal.window
})

function toast() {
  return useToastStore.getState().toasts.find((entry) => entry.id === APP_UPDATE_TOAST_ID)
}

function actions() {
  return toast()?.actions?.map(({ id, label, primary, busy }) => ({
    id,
    label,
    primary: primary === true,
    busy: busy === true,
  }))
}

function press(actionId: string): void {
  const action = toast()?.actions?.find((entry) => entry.id === actionId)
  assert.ok(action, `the toast offers ${actionId}`)
  action.run()
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// A found update and its download are the rail glyph's to show
// (AppUpdateRailButton, owner ruling 2026-10-30): no toast, no bell row.
test('a found update raises no toast, and its download runs quietly', () => {
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'checking' }))
  drive(state({ status: 'available', updateVersion: '0.7.0' }))
  assert.equal(toast(), undefined)
  drive(
    state({
      status: 'downloading',
      updateVersion: '0.7.0',
      progress: { percent: 41.6, transferred: 1, total: 1, bytesPerSecond: 1 },
    }),
  )
  assert.equal(toast(), undefined)
  assert.equal(downloads, 0, 'nothing downloads until the glyph is pressed')
  assert.deepEqual(diagnostics.published, [])
})

test('the download landing says so once, points at the rail, and files a bell row', () => {
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'downloading', updateVersion: '0.7.0' }))
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true }))
  assert.equal(toast()?.tone, 'good')
  assert.equal(toast()?.title, 'Update downloaded')
  assert.equal(
    toast()?.description,
    'SprintEngine Studio 0.7.0 is ready. Restart from the update button on the rail to install it.',
  )
  assert.notEqual(toast()?.autoDismissMs, false, 'the lit glyph keeps saying it; the toast is news')
  assert.deepEqual(
    diagnostics.published.map(({ title, source }) => ({ title, source })),
    [{ title: 'SprintEngine Studio 0.7.0 is ready', source: 'update' }],
  )

  // The hourly check comes and goes over the same download: not a second toast.
  useToastStore.setState({ toasts: [] })
  drive(state({ status: 'checking', updateVersion: '0.7.0', downloaded: true }))
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true }))
  assert.equal(toast(), undefined)
})

test('with automatic download on, the landing is announced the same way', () => {
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'available', updateVersion: '0.7.0', autoDownload: true }))
  drive(state({ status: 'downloading', updateVersion: '0.7.0', autoDownload: true }))
  assert.equal(toast(), undefined)
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true, autoDownload: true }))
  assert.equal(toast()?.title, 'Update downloaded')
})

test('the downloaded toast opens the release notes when there are some', () => {
  showAppUpdateReadyToast({ updateVersion: '0.7.0', releaseNotesUrl: null })
  assert.equal(actions(), undefined, 'no notes, no button')
  showAppUpdateReadyToast({ updateVersion: '0.7.0', releaseNotesUrl: 'https://example.com/notes' })
  assert.deepEqual(actions(), [{ id: 'release-notes', label: 'Release notes', primary: false, busy: false }])
  press('release-notes')
  assert.equal(notesOpened, 1)
  assert.equal(installs, 0)
})

test('a download that fails says why; the glyph is the retry', async () => {
  downloadAnswer = () => Promise.resolve({ ok: false, state: {} as AppUpdateState, message: 'socket hang up' })
  await downloadAppUpdate('0.7.0')
  assert.equal(downloads, 1)
  assert.equal(toast()?.tone, 'warn')
  assert.equal(toast()?.title, 'The update did not download')
  assert.equal(toast()?.description, 'socket hang up')
})

test('a download that works says nothing until it lands', async () => {
  await downloadAppUpdate('0.7.0')
  assert.equal(downloads, 1)
  assert.equal(toast(), undefined)
})

test('Restart to update shows the press at once, before main is asked, with the button busy', async () => {
  const restarting = restartToUpdateFromToast({ installRequiresAdmin: false })
  // Synchronously, before main has been asked anything.
  assert.equal(installs, 0)
  assert.equal(toast()?.title, 'Installing update')
  assert.equal(toast()?.description, 'Studio will restart in a moment…')
  assert.deepEqual(actions(), [{ id: 'restart', label: 'Restarting…', primary: true, busy: true }])
  // A second press on the busy button does nothing.
  press('restart')
  await restarting
  await settle()
  assert.equal(installs, 1)
  assert.equal(toastWhenMainWasAsked?.title, 'Installing update', 'main was asked only after the toast said so')
})

test('a restart main refuses turns into a warning that says why, and can be pressed again', async () => {
  answer = () =>
    Promise.resolve({
      ok: false,
      state: {} as AppUpdateState,
      message: 'Windows did not get administrator permission, so the update was not installed.',
    })
  void restartToUpdateFromToast({ installRequiresAdmin: true })
  assert.equal(toast()?.description, 'Windows will ask for administrator permission, then Studio restarts.')
  await settle()
  assert.equal(toast()?.tone, 'warn')
  assert.equal(toast()?.title, 'Update not installed')
  assert.equal(toast()?.description, 'Windows did not get administrator permission, so the update was not installed.')
  press('restart')
  await settle()
  assert.equal(installs, 2)
})

test('the start after an update says how it went', () => {
  const outcome = () => useToastStore.getState().toasts.find((entry) => entry.id === APP_UPDATE_OUTCOME_TOAST_ID)
  showAppUpdateOutcomeToast({ kind: 'updated', version: '0.7.0', fromVersion: '0.6.0', message: null })
  assert.equal(outcome()?.tone, 'good')
  assert.equal(outcome()?.title, 'Updated to SprintEngine Studio 0.7.0')
  showAppUpdateOutcomeToast({
    kind: 'failed',
    version: '0.7.0',
    fromVersion: '0.6.0',
    message: 'The installer did not finish, so SprintEngine Studio is still on 0.6.0.',
  })
  assert.equal(outcome()?.tone, 'warn')
  assert.equal(outcome()?.title, 'Update to 0.7.0 did not install')
  assert.equal(outcome()?.description, 'The installer did not finish, so SprintEngine Studio is still on 0.6.0.')
})

test('a refused install going back to downloaded is not announced again', async () => {
  answer = () => Promise.resolve({ ok: false, state: {} as AppUpdateState, message: 'Declined.' })
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true }))
  void restartToUpdateFromToast()
  // Main's state pushes arrive before its answer does.
  drive(state({ status: 'installing', updateVersion: '0.7.0', downloaded: true }))
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true, errorMessage: 'Declined.' }))
  assert.equal(toast()?.title, 'Installing update')
  await settle()
  assert.equal(toast()?.title, 'Update not installed')
  assert.equal(
    diagnostics.published.filter(({ title }) => title === 'SprintEngine Studio 0.7.0 is ready').length,
    1,
    'one bell row for the ready update, not one per refusal',
  )
})

// Dismissing the downloaded toast and Later on a refusal are "not now" for this
// version at this step, and clear its Settings badge (owner ruling 2026-09-25).
test('dismissing the downloaded toast, or Later on a refusal, says "not now" to ready', async () => {
  useNotificationStore.setState({ dismissedUpdates: [] })
  showAppUpdateReadyToast({ updateVersion: '0.7.0' })
  toast()?.onDismissPressed?.()
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, ['app@0.7.0:ready'])

  useNotificationStore.setState({ dismissedUpdates: [] })
  answer = () => Promise.resolve({ ok: false, state: {} as AppUpdateState, message: 'Declined.' })
  await restartToUpdateFromToast()
  press('later')
  assert.equal(toast(), undefined)
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, ['app@0.7.0:ready'])
})
