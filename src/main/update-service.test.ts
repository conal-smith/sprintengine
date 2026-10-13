import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { AppUpdateTrack } from '../shared/electron-api'
import { standIn } from '../../tests/stand-in'

// The two things the service configures and reads: Electron's app identity and
// electron-updater's singleton. The updater stand-in copies the one side effect
// that matters here -- setting `channel` turns `allowDowngrade` on -- so a
// service that forgets to set it back fails this suite rather than offering
// every stable install a downgrade.
const hoisted = vi.hoisted(() => {
  const app = { version: '0.5.2', packaged: true }
  // How many times the updater module was loaded; it is loaded lazily, on the
  // first check, rather than when the service is built.
  const loads = { count: 0 }
  class CancellationToken {
    cancelled = false
    cancel() {
      this.cancelled = true
    }
  }
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    _channel: null as string | null,
    get channel(): string | null {
      return this._channel
    },
    set channel(value: string | null) {
      this._channel = value
      this.allowDowngrade = true
    },
    checks: [] as Array<{ channel: string | null; allowPrerelease: boolean; allowDowngrade: boolean }>,
    listeners: new Map<string, (...args: unknown[]) => void>(),
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, listener)
      return this
    },
    // A download the test finishes (or fails) by hand, as the network would.
    downloads: [] as Array<{ token: CancellationToken; finish: () => void; fail: (error: Error) => void }>,
    downloadUpdate(token: CancellationToken) {
      return new Promise<string[]>((resolve, reject) => {
        this.downloads.push({ token, finish: () => resolve([]), fail: reject })
      })
    },
    // The version the feed offers; null means the build is already current.
    offered: null as string | null,
    async checkForUpdates() {
      this.checks.push({
        channel: this._channel,
        allowPrerelease: this.allowPrerelease,
        allowDowngrade: this.allowDowngrade,
      })
      if (this.offered) {
        this.listeners.get('update-available')?.({ version: this.offered })
        return { updateInfo: { version: this.offered } }
      }
      this.listeners.get('update-not-available')?.({})
      return { updateInfo: { version: app.version } }
    },
    installs: [] as Array<{ isSilent: boolean; isForceRunAfter: boolean }>,
    quitAndInstall(isSilent: boolean, isForceRunAfter: boolean) {
      this.installs.push({ isSilent, isForceRunAfter })
    },
    // BaseUpdater's getter for the downloaded file.
    installerPath:
      'C:\\Users\\dev\\AppData\\Local\\sprintengine-studio-updater\\pending\\SprintEngine-Studio-0.7.0-win-x64.exe' as
        string | null,
  }
  return { app, updater, CancellationToken, loads }
})

vi.mock('electron', () => ({
  app: {
    getVersion: () => hoisted.app.version,
    get isPackaged() {
      return hoisted.app.packaged
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: async () => undefined },
}))
// Stood in at `require`, which is how the service loads it (lazily, on the
// first check). Reading `autoUpdater` is what counts as a load.
standIn({
  'electron-updater': {
    get autoUpdater() {
      hoisted.loads.count += 1
      return hoisted.updater
    },
    CancellationToken: hoisted.CancellationToken,
  },
})

const { SprintEngineUpdateService, describeUpdateError } = await import('./update-service')
type ServiceOptions = ConstructorParameters<typeof SprintEngineUpdateService>[0]
type UpdateInstallPlatform = import('./update-service').UpdateInstallPlatform

function memoryStore(initial: AppUpdateTrack | null = null, autoDownload = false) {
  let value = initial
  let download = autoDownload
  const writes: AppUpdateTrack[] = []
  return {
    writes,
    get: () => value,
    set: (next: AppUpdateTrack) => {
      value = next
      writes.push(next)
    },
    getAutoDownload: () => download,
    setAutoDownload: (next: boolean) => {
      download = next
    },
  }
}

/** Automatic download on: the check starts the download, as before the preference existed. */
function autoStore() {
  return memoryStore(null, true)
}

// Every step of the install path, in the order it happened.
let steps: string[] = []
let quitHandlers: Array<(exitCode: number) => void> = []
let diagnostics: Array<{ level: string; title: string; details?: string }> = []

/** A machine the install path runs on, recording what it was asked to do. */
function fakePlatform(overrides: Partial<UpdateInstallPlatform> = {}): Partial<UpdateInstallPlatform> {
  return {
    platform: 'darwin',
    pid: 4242,
    resolveWindowsTarget: async () => ({
      installDir: 'C:\\Users\\dev\\AppData\\Local\\Programs\\sprintengine-studio',
      perMachine: false,
      writable: true,
      requiresAdmin: false,
    }),
    spawnInstaller: async (installerPath, args) => {
      steps.push(`spawn ${installerPath} ${args.join(' ')}`)
      return 99
    },
    launchElevated: async ({ args }) => {
      steps.push(`elevate ${args.join(' ')}`)
      return { outcome: 'started' }
    },
    parentWindowHandle: () => '1234',
    hideAppWindows: () => steps.push('hide windows'),
    quitApp: () => steps.push('quit'),
    relaunchApp: () => steps.push('relaunch'),
    onAppQuit: (handler) => {
      quitHandlers.push(handler)
    },
    ...overrides,
  }
}

function service(store: ReturnType<typeof memoryStore> = memoryStore(), extra: Partial<ServiceOptions> = {}) {
  return new SprintEngineUpdateService({
    writeDiagnosticLog: async (input) => {
      diagnostics.push({ level: input.level, title: input.title, details: input.details })
      return {} as never
    },
    channelStore: store,
    installPlatform: fakePlatform(),
    progressWindow: {
      show: (progress) => steps.push(`progress show ${progress.status}`),
      update: (progress) => steps.push(`progress ${progress.status} ${progress.progress.toFixed(2)}`),
    },
    ...extra,
  })
}

/**
 * A service whose updater has been loaded and configured, which happens on the
 * first check. The check is forgotten again, so a test sees only its own.
 */
async function readyService(store = memoryStore()) {
  const s = service(store)
  await s.checkForUpdates(false)
  hoisted.updater.checks = []
  return s
}

/** The configuration the updater had when it was last asked for an update. */
function lastCheck() {
  return hoisted.updater.checks.at(-1)
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  steps = []
  quitHandlers = []
  diagnostics = []
  hoisted.app.version = '0.5.2'
  hoisted.app.packaged = true
  Object.assign(hoisted.updater, {
    _channel: null,
    allowPrerelease: false,
    allowDowngrade: false,
    checks: [],
    downloads: [],
    offered: null,
    installs: [],
    autoInstallOnAppQuit: false,
    installerPath:
      'C:\\Users\\dev\\AppData\\Local\\sprintengine-studio-updater\\pending\\SprintEngine-Studio-0.7.0-win-x64.exe',
  })
  hoisted.updater.listeners.clear()
})

test('electron-updater is not loaded until the first check needs it', async () => {
  // First in the file on purpose: the module is loaded once per suite.
  const s = service()
  assert.equal(s.getState().channel, 'stable')
  assert.equal(hoisted.loads.count, 0, 'building the service loads nothing')
  await s.checkForUpdates(false)
  assert.equal(hoisted.loads.count, 1, 'the first check loads it')
})

test('a stable build follows latest, sees no prerelease and is never offered a downgrade', async () => {
  const s = service()
  assert.equal(s.getState().channel, 'stable')
  assert.deepEqual(s.getChannel(), { channel: 'stable', chosen: false })
  await s.checkForUpdates(false)
  assert.deepEqual(lastCheck(), { channel: 'latest', allowPrerelease: false, allowDowngrade: false })
})

test('a nightly build follows nightly', async () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const s = service()
  assert.equal(s.getState().channel, 'nightly')
  await s.checkForUpdates(false)
  assert.deepEqual(lastCheck(), { channel: 'nightly', allowPrerelease: true, allowDowngrade: false })
})

test('a saved choice overrides the version at startup', async () => {
  const s = service(memoryStore('nightly'))
  assert.equal(s.getState().channel, 'nightly')
  assert.deepEqual(s.getChannel(), { channel: 'nightly', chosen: true })
  await s.checkForUpdates(false)
  assert.equal(lastCheck()?.allowPrerelease, true)

  hoisted.app.version = '0.6.0-nightly.20260923.41'
  await service(memoryStore('stable')).checkForUpdates(false)
  // Its own version sorts above the latest stable until the next promotion.
  assert.deepEqual(lastCheck(), { channel: 'latest', allowPrerelease: false, allowDowngrade: true })
})

test('a channel chosen before the first check is the one the first check follows', async () => {
  const s = service()
  await s.setChannel('nightly')
  assert.deepEqual(hoisted.updater.checks, [{ channel: 'nightly', allowPrerelease: true, allowDowngrade: false }])
})

test('switching channel saves it, re-points the updater, and checks the new channel', async () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const store = memoryStore()
  const s = service(store)
  const result = await s.setChannel('stable')
  assert.deepEqual(store.writes, ['stable'])
  assert.equal(result.ok, true)
  assert.equal(result.state.channel, 'stable')
  assert.equal(result.state.status, 'not_available')
  assert.deepEqual(hoisted.updater.checks, [{ channel: 'latest', allowPrerelease: false, allowDowngrade: true }])
  assert.deepEqual(s.getChannel(), { channel: 'stable', chosen: true })

  await s.setChannel('nightly')
  assert.deepEqual(hoisted.updater.checks.at(-1), { channel: 'nightly', allowPrerelease: true, allowDowngrade: false })
})

test('the build channel is what the version was cut for, whatever the updater follows', async () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const s = service(memoryStore('stable'))
  // A nightly build that follows stable is still a nightly until stable
  // installs over it: the Nightly chip and the splash plate key off this.
  assert.equal(s.getState().buildChannel, 'nightly')
  assert.equal(s.getState().channel, 'stable')
  await s.setChannel('nightly')
  assert.equal(s.getState().buildChannel, 'nightly')

  hoisted.app.version = '0.5.2'
  const stable = service(memoryStore('nightly'))
  assert.equal(stable.getState().buildChannel, 'stable')
  assert.equal(stable.getState().channel, 'nightly')

  // Unpackaged builds follow no channel, but still know what they were cut for.
  hoisted.app.packaged = false
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const dev = service()
  assert.equal(dev.getState().channel, 'dev')
  assert.equal(dev.getState().buildChannel, 'nightly')
})

test('an update found on the old channel is forgotten when the channel changes', async () => {
  const s = await readyService()
  hoisted.updater.listeners.get('update-downloaded')?.({ version: '0.5.3' })
  assert.equal(s.getState().downloaded, true)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, true)
  // A check that fires no event, so what is asserted is the reset itself.
  const check = hoisted.updater.checkForUpdates
  hoisted.updater.checkForUpdates = async () => ({ updateInfo: { version: '0.5.2' } }) as never
  try {
    await s.setChannel('nightly')
  } finally {
    hoisted.updater.checkForUpdates = check
  }
  assert.equal(s.getState().downloaded, false)
  assert.equal(s.getState().updateVersion, null)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false)
})

test('a download still running on the old channel is cancelled and never becomes the update to install', async () => {
  const s = await readyService()
  hoisted.updater.listeners.get('update-available')?.({ version: '0.5.3' })
  const pending = s.downloadUpdate()
  await settle()
  const running = hoisted.updater.downloads[0]
  assert.ok(running, 'the service started a download')
  const check = hoisted.updater.checkForUpdates
  hoisted.updater.checkForUpdates = async () => ({ updateInfo: { version: '0.5.2' } }) as never
  try {
    await s.setChannel('nightly')
  } finally {
    hoisted.updater.checkForUpdates = check
  }
  assert.equal(running.token.cancelled, true, 'the old channel download is cancelled')

  // It finished anyway, before the cancel reached it.
  hoisted.updater.listeners.get('download-progress')?.({ percent: 100, transferred: 1, total: 1, bytesPerSecond: 1 })
  hoisted.updater.listeners.get('update-downloaded')?.({ version: '0.5.3' })
  running.finish()
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(s.getState().downloaded, false, 'nothing from the old channel is ready to install')
  assert.notEqual(s.getState().status, 'downloading', 'the old download no longer drives the state')
  assert.equal(s.getState().progress, null)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false)

  // The next download is the new channel's own, and completes normally.
  hoisted.updater.listeners.get('update-available')?.({ version: '0.6.0-nightly.20260923.41' })
  const next = s.downloadUpdate()
  await settle()
  hoisted.updater.listeners.get('update-downloaded')?.({ version: '0.6.0-nightly.20260923.41' })
  hoisted.updater.downloads[1]?.finish()
  assert.equal((await next).ok, true)
  assert.equal(s.getState().downloaded, true)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, true)
})

test('an unpackaged build reports dev and does not check when the channel changes', async () => {
  hoisted.app.packaged = false
  const store = memoryStore()
  const s = service(store)
  assert.equal(s.getState().channel, 'dev')
  const result = await s.setChannel('nightly')
  assert.equal(result.state.channel, 'dev')
  assert.deepEqual(s.getChannel(), { channel: 'nightly', chosen: true })
  assert.deepEqual(store.writes, ['nightly'])
})

// What electron-updater emits as a download runs and lands.
function progress(percent: number) {
  hoisted.updater.listeners.get('download-progress')?.({ percent, transferred: percent, total: 100, bytesPerSecond: 1 })
}
function downloaded(version: string) {
  hoisted.updater.listeners.get('update-downloaded')?.({ version })
}

test('with automatic download on, a check that finds an update downloads it, reporting progress', async () => {
  const s = service(autoStore())
  hoisted.updater.offered = '0.5.3'
  const result = await s.checkForUpdates(false)
  assert.equal(result.ok, true)
  assert.equal(hoisted.updater.downloads.length, 1, 'the download started without being asked')
  assert.equal(s.getState().status, 'downloading')
  assert.equal(s.getState().updateVersion, '0.5.3')

  progress(40)
  assert.equal(s.getState().status, 'downloading')
  assert.equal(s.getState().progress?.percent, 40)

  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()
  assert.equal(s.getState().status, 'downloaded')
  assert.equal(s.getState().downloaded, true)
  assert.equal(s.getState().progress, null)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, true, 'Later still installs it at the next quit')
})

test('a check that finds nothing downloads nothing', async () => {
  const s = service()
  await s.checkForUpdates(false)
  assert.equal(s.getState().status, 'not_available')
  assert.equal(hoisted.updater.downloads.length, 0)
})

test('checks while an update downloads or waits for a restart leave it alone', async () => {
  const s = service(autoStore())
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  assert.equal(hoisted.updater.checks.length, 1)

  // The poller comes round mid-download: no second check, no second download.
  await s.checkForUpdates(false)
  assert.equal(hoisted.updater.checks.length, 1)
  assert.equal(hoisted.updater.downloads.length, 1)
  assert.equal(s.getState().status, 'downloading')

  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()

  // And again once it is ready: the feed would call it merely available.
  const result = await s.checkForUpdates(true)
  assert.equal(result.ok, true)
  assert.equal(hoisted.updater.checks.length, 1)
  assert.equal(s.getState().status, 'downloaded')
  assert.equal(s.getState().downloaded, true)
})

test('a background download that fails reports the error and the next check tries again', async () => {
  const s = service(autoStore())
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  hoisted.updater.downloads[0]?.fail(new Error('socket hang up'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(s.getState().status, 'error')
  assert.equal(s.getState().errorMessage, 'socket hang up')
  assert.equal(s.getState().downloaded, false)

  await s.checkForUpdates(false)
  assert.equal(hoisted.updater.checks.length, 2)
  assert.equal(hoisted.updater.downloads.length, 2)
  assert.equal(s.getState().status, 'downloading')
})

test('on macOS, restart to update hands over to electron-updater silently, and only once an update is ready', async () => {
  const s = service(autoStore())
  const early = await s.quitAndInstall()
  assert.equal(early.ok, false)
  assert.deepEqual(hoisted.updater.installs, [])

  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()

  const result = await s.quitAndInstall()
  assert.equal(result.ok, true)
  // Silent: the Windows installer runs with /S and shows no wizard.
  assert.deepEqual(hoisted.updater.installs, [{ isSilent: true, isForceRunAfter: true }])
})

test('restart to update runs the app’s shutdown before the installer starts, once', async () => {
  const s = service(autoStore())
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()

  const order: string[] = []
  let finishShutdown: () => void = () => undefined
  s.setPrepareForInstall(async () => {
    order.push('shutdown:start')
    await new Promise<void>((resolve) => {
      finishShutdown = resolve
    })
    order.push('shutdown:done')
  })
  const first = s.quitAndInstall()
  const second = s.quitAndInstall()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(hoisted.updater.installs, [], 'the installer waits for the shutdown')
  assert.deepEqual(order, ['shutdown:start'], 'a second click does not start a second shutdown')
  finishShutdown()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.deepEqual(order, ['shutdown:start', 'shutdown:done'])
  assert.deepEqual(hoisted.updater.installs, [{ isSilent: true, isForceRunAfter: true }], 'installed once')
})

test('a channel switch mid-download fetches the new channel only after the old download lets go', async () => {
  const s = service(autoStore())
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  const old = hoisted.updater.downloads[0]
  assert.ok(old)

  hoisted.updater.offered = '0.6.0-nightly.20260923.41'
  const switched = await s.setChannel('nightly')
  assert.equal(switched.ok, true)
  assert.equal(old.token.cancelled, true)
  assert.equal(hoisted.updater.checks.length, 2, 'the new channel was checked')
  assert.equal(hoisted.updater.downloads.length, 1, 'its download waits for the old one to settle')

  old.fail(new Error('cancelled'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hoisted.updater.downloads.length, 2, 'then starts with a token of its own')
  const next = hoisted.updater.downloads[1]
  assert.ok(next)
  assert.notEqual(next.token, old.token)
  assert.equal(s.getState().status, 'downloading')
  assert.equal(s.getState().updateVersion, '0.6.0-nightly.20260923.41')

  downloaded('0.6.0-nightly.20260923.41')
  next.finish()
  await Promise.resolve()
  assert.equal(s.getState().downloaded, true)
  assert.equal(s.getState().updateVersion, '0.6.0-nightly.20260923.41')
})

test('without automatic download, a check offers the update and downloads nothing', async () => {
  const s = service()
  hoisted.updater.offered = '0.5.3'
  const result = await s.checkForUpdates(false)
  assert.equal(result.ok, true)
  assert.equal(s.getState().status, 'available')
  assert.equal(s.getState().autoDownload, false)
  assert.equal(hoisted.updater.downloads.length, 0, 'nothing downloads until the person asks')

  // Turning it on with the update waiting fetches it, as a check would have.
  const store = memoryStore()
  const later = service(store)
  await later.checkForUpdates(false)
  assert.equal(hoisted.updater.downloads.length, 0)
  const state = later.setAutoDownload(true)
  assert.equal(state.autoDownload, true)
  assert.equal(store.getAutoDownload(), true, 'the choice is saved')
  await settle()
  assert.equal(hoisted.updater.downloads.length, 1)
})

const WIN_PER_USER = 'C:\\Users\\dev\\AppData\\Local\\Programs\\sprintengine-studio'
const WIN_PROGRAM_FILES = 'C:\\Program Files\\SprintEngine Studio'
const INSTALLER =
  'C:\\Users\\dev\\AppData\\Local\\sprintengine-studio-updater\\pending\\SprintEngine-Studio-0.7.0-win-x64.exe'

function notes() {
  const written: Array<Record<string, unknown>> = []
  let pending: Record<string, unknown> | null = null
  return {
    written,
    seed(note: Record<string, unknown>) {
      pending = note
    },
    write(note: Record<string, unknown>) {
      steps.push(note.failureReason ? 'note (failed)' : 'note')
      written.push(note)
    },
    consume() {
      const note = pending
      pending = null
      return note as never
    },
  }
}

type WindowsTarget = { installDir: string; perMachine: boolean; requiresAdmin: boolean }

/** A Windows install with 0.7.0 downloaded and a two-leg shutdown that reports each leg. */
async function windowsReady(options: { target?: WindowsTarget; platform?: Partial<UpdateInstallPlatform> } = {}) {
  const installNotes = notes()
  const target = options.target ?? { installDir: WIN_PER_USER, perMachine: false, requiresAdmin: false }
  const s = service(autoStore(), {
    installNotes: installNotes as never,
    installPlatform: fakePlatform({
      platform: 'win32',
      resolveWindowsTarget: async () => ({ ...target, writable: !target.requiresAdmin }),
      ...options.platform,
    }),
  })
  s.setPrepareForInstall(async (report) => {
    steps.push('shutdown')
    report?.({ name: 'terminals', done: 1, total: 2, durationMs: 12, failed: false })
    report?.({ name: 'telemetry', done: 2, total: 2, durationMs: 3, failed: false })
  })
  hoisted.updater.offered = '0.7.0'
  await s.checkForUpdates(false)
  downloaded('0.7.0')
  hoisted.updater.downloads[0]?.finish()
  await settle()
  steps = []
  return { s, installNotes }
}

test('Windows, per user: the app starts the installer into its own folder, after the shutdown, and quits', async () => {
  const { s, installNotes } = await windowsReady()
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false, 'electron-updater never installs at quit on Windows')
  const result = await s.quitAndInstall()
  assert.equal(result.ok, true)
  assert.deepEqual(steps, [
    'progress show Getting ready to update…',
    'hide windows',
    'shutdown',
    'progress Saving your work… 0.45',
    'progress Saving your work… 0.85',
    'progress Starting the installer… 0.92',
    'note',
    // Non-silent, so the installer's progress banner shows; /D= last and unquoted.
    `spawn ${INSTALLER} --updated --force-run --wait-for-pid=4242 /D=${WIN_PER_USER}`,
    'progress Installing SprintEngine Studio 0.7.0… 1.00',
    'quit',
  ])
  assert.deepEqual(hoisted.updater.installs, [], 'electron-updater does not start a second installer')
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false, 'nor does its install at quit')
  quitHandlers.forEach((handler) => handler(0))
  assert.equal(steps.filter((step) => step.startsWith('spawn')).length, 1, 'the quit after it starts no second one')
  assert.deepEqual(installNotes.written[0], {
    fromVersion: '0.5.2',
    toVersion: '0.7.0',
    startedAt: installNotes.written[0]?.startedAt,
    platform: 'win32',
    installDir: WIN_PER_USER,
    requiresAdmin: false,
  })
  const titles = diagnostics.map((entry) => entry.title)
  for (const title of [
    'Restart to update',
    'Shutdown: terminals',
    'Shutdown: telemetry',
    'Starting the installer',
    'Handing over to the installer',
  ]) {
    assert.ok(titles.includes(title), `the diagnostics log has "${title}"`)
  }
})

test('Windows, all users: the installer is started elevated before anything shuts down, and waits for the app', async () => {
  const { s } = await windowsReady({ target: { installDir: WIN_PROGRAM_FILES, perMachine: true, requiresAdmin: true } })
  assert.equal(s.getState().installRequiresAdmin, true)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false, 'no UAC prompt after the app has gone')
  const result = await s.quitAndInstall()
  assert.equal(result.ok, true)
  assert.deepEqual(steps, [
    `elevate --updated --force-run --wait-for-pid=4242 /D=${WIN_PROGRAM_FILES}`,
    'progress show Getting ready to update…',
    'hide windows',
    'shutdown',
    'progress Saving your work… 0.45',
    'progress Saving your work… 0.85',
    'progress Starting the installer… 0.92',
    'note',
    'progress Installing SprintEngine Studio 0.7.0… 1.00',
    'quit',
  ])
})

test('Windows, all users: a declined prompt leaves the app running on its version, and says so', async () => {
  let asked = 0
  const { s } = await windowsReady({
    target: { installDir: WIN_PROGRAM_FILES, perMachine: true, requiresAdmin: true },
    platform: {
      launchElevated: async () => {
        asked += 1
        steps.push('elevate')
        return { outcome: 'declined' }
      },
    },
  })
  const result = await s.quitAndInstall()
  assert.equal(result.ok, false)
  assert.match(result.message, /did not get administrator permission.*still on 0\.5\.2/)
  assert.deepEqual(steps, ['elevate'], 'no progress window, no shutdown, no quit')
  assert.equal(s.getState().status, 'downloaded', 'the update is still ready')
  assert.equal(s.getState().downloaded, true)
  assert.equal(s.getState().errorMessage, result.message)
  // Pressing again asks again.
  await s.quitAndInstall()
  assert.equal(asked, 2)
})

test('Windows: an installer that will not start brings the app back, with the reason for the next start', async () => {
  const { s, installNotes } = await windowsReady({
    platform: {
      spawnInstaller: async () => {
        throw new Error('EACCES')
      },
    },
  })
  const result = await s.quitAndInstall()
  assert.equal(result.ok, false)
  assert.equal(steps.at(-1), 'relaunch')
  assert.ok(!steps.includes('quit'))
  assert.match(String(installNotes.written.at(-1)?.failureReason), /could not be started: EACCES/)
  // The relaunch exits through app.exit, which still emits quit: no silent
  // installer behind the app coming back, and the reason is kept.
  const notesBefore = installNotes.written.length
  quitHandlers.forEach((handler) => handler(0))
  assert.equal(steps.filter((step) => step.startsWith('spawn')).length, 0)
  assert.equal(installNotes.written.length, notesBefore)
})

test('an install under way cannot be moved to another channel', async () => {
  const { s } = await windowsReady()
  let release: () => void = () => undefined
  s.setPrepareForInstall(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const installing = s.quitAndInstall()
  await settle()
  assert.equal(s.getState().status, 'installing')
  const switched = await s.setChannel('nightly')
  assert.equal(switched.ok, false)
  assert.equal(s.getChannel().channel, 'stable')
  release()
  assert.equal((await installing).ok, true)
})

test('the start after an update reports how it went, once', () => {
  const installNotes = notes()
  hoisted.app.version = '0.7.0'
  installNotes.seed({
    fromVersion: '0.5.2',
    toVersion: '0.7.0',
    startedAt: new Date().toISOString(),
    platform: 'win32',
    installDir: WIN_PER_USER,
    requiresAdmin: false,
  })
  const s = service(memoryStore(), { installNotes: installNotes as never })
  assert.deepEqual(s.getState().installOutcome, {
    kind: 'updated',
    version: '0.7.0',
    fromVersion: '0.5.2',
    message: null,
  })
  assert.ok(diagnostics.some((entry) => entry.title === 'Updated to 0.7.0'))
  assert.equal(s.dismissInstallOutcome().installOutcome, null)
  // Consumed: a second service (a second start) hears nothing.
  assert.equal(service(memoryStore(), { installNotes: installNotes as never }).getState().installOutcome, null)
})

test('Windows, per user: Later then quit installs silently into the running installation', async () => {
  const { installNotes } = await windowsReady()
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false, 'not electron-updater, which cannot pass the folder')
  assert.equal(quitHandlers.length, 1)
  quitHandlers[0]?.(0)
  assert.deepEqual(steps, ['note', `spawn ${INSTALLER} --updated /S --wait-for-pid=4242 /D=${WIN_PER_USER}`])
  assert.equal(installNotes.written[0]?.installDir, WIN_PER_USER)
  // A quit with an error code installs nothing.
  steps = []
  const other = await windowsReady()
  steps = []
  quitHandlers.at(-1)?.(1)
  assert.deepEqual(steps, [])
  assert.equal(other.installNotes.written.length, 0)
})

test('Windows, all users: Later then quit installs nothing, rather than raise UAC after the app has gone', async () => {
  const { installNotes } = await windowsReady({
    target: { installDir: WIN_PROGRAM_FILES, perMachine: true, requiresAdmin: true },
  })
  quitHandlers.forEach((handler) => handler(0))
  assert.deepEqual(steps, [])
  assert.equal(installNotes.written.length, 0)
})

test('a failed download is logged with its code and what caused it', async () => {
  const s = service(autoStore())
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
  hoisted.updater.downloads[0]?.fail(
    Object.assign(new Error('Cannot download update', { cause }), { code: 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' }),
  )
  await settle()
  const entry = diagnostics.find((d) => d.title === 'Update download failed')
  assert.equal(
    JSON.parse(entry?.details ?? '{}').cause,
    'Error [ERR_UPDATER_ZIP_FILE_NOT_FOUND]: Cannot download update; caused by Error [ENOTFOUND]: getaddrinfo ENOTFOUND github.com',
  )
})

test('an updater error summary leaves out addresses, credentials and everything after the first line', () => {
  const error = new Error(
    'HttpError: 403 Forbidden https://github.com/acme/app/releases/download/v1/latest-mac.yml?token=abc\nHeaders: {"set-cookie":"x"}',
  )
  assert.equal(describeUpdateError(error), 'Error: HttpError: 403 Forbidden [redacted URL]')
  assert.equal(
    describeUpdateError(new Error('proxy said Authorization: Bearer abc.def')),
    'Error: proxy said [redacted header]',
  )
  assert.equal(
    describeUpdateError(new Error('refused api_key=sk-123 for feed')),
    'Error: refused [redacted credential] for feed',
  )
})

test('an updater error summary is bounded however deep or long its causes are', () => {
  let error: Error = new Error('x'.repeat(5000))
  for (let level = 0; level < 10; level += 1) error = new Error(`level ${level}`, { cause: error })
  const summary = describeUpdateError(error)
  assert.ok(summary.length <= 1024)
  assert.ok(summary.endsWith('[truncated cause]'))
  assert.equal(describeUpdateError('plain words'), 'plain words')
  assert.equal(describeUpdateError(undefined), 'undefined')
})
