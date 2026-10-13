import { app, BrowserWindow, shell } from 'electron'
import type { AppUpdater, CancellationToken } from 'electron-updater'
import type {
  AppUpdateChannelSetting,
  AppUpdateCheckResult,
  AppUpdateInstallOutcome,
  AppUpdateState,
  AppUpdateStatus,
  AppUpdateTrack,
  DiagnosticLogEntry,
  DiagnosticLogInput,
  SplashProgress,
} from '../shared/electron-api'
import { currentSplashWindow } from './splash-window'
import { channelForVersion, resolveUpdateTrack, type UpdateChannelStore } from './update-channel-store'
import { installOutcomeFromNote, type UpdateInstallNote, type UpdateInstallNoteStore } from './update-install-note'
import { updateInstallProgress, type ShutdownLegReport } from './update-install-progress'
import {
  canWriteDirectory,
  launchInstallerElevated,
  nsisCommandLineTail,
  nsisUpdateArgs,
  readMachineInstallLocation,
  resolveWindowsInstallTarget,
  spawnInstallerVerbatim,
  windowHandleToDecimal,
  type ElevatedLaunchResult,
  type WindowsInstallTarget,
} from './windows-update-install'
import { broadcastToAllWindows } from './window-broadcast'

type WriteDiagnosticLog = (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>

/** The small window that shows the update's progress from the click until the installer takes over. */
export type UpdateProgressWindow = {
  show(progress: SplashProgress): void
  update(progress: SplashProgress): void
}

/**
 * What the install path needs from the machine. Everything here has a real
 * default; tests replace it to drive the Windows path from any platform.
 */
export type UpdateInstallPlatform = {
  platform: NodeJS.Platform
  pid: number
  /** Where the running app is installed, and whether updating it needs an administrator. */
  resolveWindowsTarget(): Promise<WindowsInstallTarget>
  /** Start the installer as the signed-in user, with exactly these arguments. */
  spawnInstaller(installerPath: string, args: readonly string[]): Promise<number>
  /** Start the installer elevated; resolves once the UAC prompt is answered. */
  launchElevated(options: {
    installerPath: string
    args: readonly string[]
    parentWindowHandle: string | null
  }): Promise<ElevatedLaunchResult>
  /** The window the UAC prompt belongs to, as a decimal HWND. */
  parentWindowHandle(): string | null
  /** Hide the app's windows once the progress window is up: from here the app is leaving. */
  hideAppWindows(): void
  quitApp(): void
  relaunchApp(): void
  /** Run once as the app quits, with its exit code (Electron's `quit` event). */
  onAppQuit(handler: (exitCode: number) => void): void
}

type UpdateServiceOptions = {
  writeDiagnosticLog: WriteDiagnosticLog
  /** The person's saved channel and download preference. Without one, the build's version decides. */
  channelStore?: Pick<UpdateChannelStore, 'get' | 'set'> &
    Partial<Pick<UpdateChannelStore, 'getAutoDownload' | 'setAutoDownload'>>
  /** The note an update leaves for the next start. */
  installNotes?: Pick<UpdateInstallNoteStore, 'write' | 'consume'>
  progressWindow?: UpdateProgressWindow
  installPlatform?: Partial<UpdateInstallPlatform>
}

type UpdateInfoLike = {
  version?: string
  releaseName?: string | null
  releaseNotes?: string | Array<{ version?: string | null; note?: string | null }> | null
  releaseDate?: string | null
}

type DownloadProgressLike = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

// The public releases repo, named once in package.json `build.publish` and
// checked against it at build time. See src/shared/releases-repo.ts.
import { RELEASES_URL } from '../shared/releases-repo'

type UpdaterModule = { autoUpdater: AppUpdater; CancellationToken: typeof CancellationToken }

let updaterModule: Promise<UpdaterModule> | null = null

/**
 * electron-updater, loaded the first time something asks for it. Requiring it
 * costs tens of milliseconds, and at module scope that was paid on the path to
 * `ready` by every launch — dev builds included, which never check at all. The
 * first check runs after the window is up, so that is where the cost now lands.
 */
function loadUpdaterModule(): Promise<UpdaterModule> {
  updaterModule ??= Promise.resolve().then(() => {
    // `require`, not `import()`: the package is CommonJS and defines
    // `autoUpdater` with a getter, which an ES import exposes only on
    // `default` — the named binding would come back undefined.
    const loaded = require('electron-updater') as typeof import('electron-updater')
    return { autoUpdater: loaded.autoUpdater, CancellationToken: loaded.CancellationToken }
  })
  return updaterModule
}

function getAppVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'
}

function isAppPackaged(): boolean {
  return app.isPackaged === true
}

/**
 * Point electron-updater at one train.
 *
 * `channel` names the manifests it downloads (`nightly-mac.yml`,
 * `latest-mac.yml`) and, with `allowPrerelease`, which feed entries it will
 * consider: a nightly build takes the first `-nightly.` tag, a stable build
 * asks /releases/latest and never sees a prerelease.
 *
 * Setting `channel` also turns `allowDowngrade` on as a side effect, so it is
 * always set explicitly afterwards. It is on for one case only: a nightly
 * install that switched to stable. Its own version (0.6.0-nightly.…) sorts
 * above the latest stable (0.5.2) until the next promotion, and without the
 * downgrade it would be offered nothing at all.
 */
function applyUpdaterChannel(autoUpdater: AppUpdater, track: AppUpdateTrack, version: string): void {
  autoUpdater.allowPrerelease = track === 'nightly'
  autoUpdater.channel = track === 'nightly' ? 'nightly' : 'latest'
  autoUpdater.allowDowngrade = track === 'stable' && channelForVersion(version) === 'nightly'
}

/**
 * The downloaded installer's path. electron-updater keeps it on its base
 * updater (`BaseUpdater.installerPath`, the downloaded file); it is not part of
 * the typed surface, so it is read defensively.
 */
function downloadedInstallerPath(autoUpdater: AppUpdater): string | null {
  const value: unknown = (autoUpdater as unknown as { installerPath?: unknown }).installerPath
  return typeof value === 'string' && value !== '' ? value : null
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

const STALE_DOWNLOAD_MESSAGE = 'The download was stopped because the update channel changed.'

function getStatusMessage(status: AppUpdateStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking for updates.'
    case 'available':
      return 'Update available.'
    case 'downloading':
      return 'Downloading update.'
    case 'downloaded':
      return 'Update ready to install.'
    case 'installing':
      return 'Installing update.'
    case 'not_available':
      return 'SprintEngine is up to date.'
    case 'error':
      return 'Update check failed.'
    default:
      return 'No update check is running.'
  }
}

function normalizeReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.trim() || null
  if (!Array.isArray(notes)) return null
  const joined = notes
    .map((entry) => [entry.version, entry.note].filter(Boolean).join('\n'))
    .join('\n\n')
    .trim()
  return joined || null
}

/** Download progress is logged at these marks, not on every event. */
const LOGGED_PROGRESS_MARKS = [25, 50, 75]

function defaultInstallPlatform(): UpdateInstallPlatform {
  return {
    platform: process.platform,
    pid: process.pid,
    resolveWindowsTarget: () =>
      resolveWindowsInstallTarget({
        execPath: process.execPath,
        readMachineInstallLocation,
        canWrite: canWriteDirectory,
      }),
    spawnInstaller: spawnInstallerVerbatim,
    launchElevated: launchInstallerElevated,
    parentWindowHandle: () => {
      const win =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible())
      if (!win || win.isDestroyed()) return null
      try {
        return windowHandleToDecimal(win.getNativeWindowHandle())
      } catch {
        return null
      }
    },
    hideAppWindows: () => {
      // The progress window is up before this runs, and stays.
      const progress = currentSplashWindow()
      for (const win of BrowserWindow.getAllWindows()) {
        if (win !== progress && !win.isDestroyed() && win.isVisible()) win.hide()
      }
    },
    quitApp: () => app.quit(),
    relaunchApp: () => {
      app.relaunch()
      app.exit(0)
    },
    onAppQuit: (handler) => {
      app.once('quit', (_event: unknown, exitCode: number) => handler(exitCode))
    },
  }
}

// An updater error's message is its top line; what went wrong underneath (a
// DNS failure, a TLS error, a 403 from the feed) is in its code and its cause,
// which the diagnostics log never saw. The summary is one bounded line, with
// no stacks, and with addresses and credentials taken out of each message,
// because an HTTP error appends the request and its headers after the first line.
function redactUpdateMessage(message: string): string {
  return (message.split(/[\r\n]/, 1)[0] ?? '')
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted credential]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi, '[redacted header]')
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted credential]',
    )
    .slice(0, 512)
}

function summarizeUpdateCause(cause: unknown, depth: number): string {
  if (depth >= 3) return '[truncated cause]'
  if (typeof cause === 'string') return redactUpdateMessage(cause)
  if (typeof cause !== 'object' || cause === null) return typeof cause
  const error = cause as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error'
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? ` [${error.code}]` : ''
  const message = typeof error.message === 'string' ? `: ${redactUpdateMessage(error.message)}` : ''
  const nested = error.cause === undefined ? '' : `; caused by ${summarizeUpdateCause(error.cause, depth + 1)}`
  return `${name}${code}${message}${nested}`
}

/** "Error [ERR_UPDATER_…]: …; caused by Error [ENOTFOUND]: …", at most 1 KB. */
export function describeUpdateError(error: unknown): string {
  try {
    return summarizeUpdateCause(error, 0).slice(0, 1024)
  } catch {
    return 'Error'
  }
}

export class SprintEngineUpdateService {
  private readonly writeDiagnosticLog: WriteDiagnosticLog
  private readonly channelStore: UpdateServiceOptions['channelStore']
  private readonly installNotes: UpdateServiceOptions['installNotes']
  private readonly progressWindow: UpdateProgressWindow | null
  private readonly platform: UpdateInstallPlatform
  private state: AppUpdateState
  private track: AppUpdateTrack
  /**
   * The download this service started and has not seen finish. `stale` is set
   * when the channel changes under it: its file belongs to the old channel, so
   * nothing it reports (progress, completion) may reach the state, and it is
   * cancelled so the new channel can start its own.
   */
  private download: {
    token: CancellationToken
    stale: boolean
    /** Resolves once electron-updater has let go of this download, however it ended. */
    settled: Promise<void>
    settle: () => void
  } | null = null
  /** The loaded and configured updater; null until the first check or download needs it. */
  private updater: UpdaterModule | null = null
  private updaterLoading: Promise<UpdaterModule> | null = null
  /** The app's own ordered shutdown, run before the installer takes over. */
  private prepareForInstall: ((report?: (leg: ShutdownLegReport) => void) => Promise<void>) | null = null
  /** Set once "Restart to update" has begun, so a second click is not a second shutdown. */
  private installing: Promise<AppUpdateCheckResult> | null = null
  /** Where this Windows installation is, once asked; null on other platforms. */
  private windowsTarget: Promise<WindowsInstallTarget | null> | null = null
  /** The same, once known: the quit handler cannot wait for a promise. */
  private resolvedWindowsTarget: WindowsInstallTarget | null = null
  /** The download-progress marks already logged for the download under way. */
  private loggedProgressMarks = new Set<number>()
  private installAtQuitRegistered = false
  /** Restart to update has started an installer, or tried to: the quit that follows starts no other. */
  private installAttempted = false

  constructor({
    writeDiagnosticLog,
    channelStore,
    installNotes,
    progressWindow,
    installPlatform,
  }: UpdateServiceOptions) {
    this.writeDiagnosticLog = writeDiagnosticLog
    this.channelStore = channelStore
    this.installNotes = installNotes
    this.progressWindow = progressWindow ?? null
    this.platform = { ...defaultInstallPlatform(), ...installPlatform }
    const appVersion = getAppVersion()
    this.track = resolveUpdateTrack(appVersion, channelStore?.get() ?? null)
    this.state = {
      status: 'idle',
      version: appVersion,
      channel: isAppPackaged() ? this.track : 'dev',
      buildChannel: channelForVersion(appVersion),
      packaged: isAppPackaged(),
      updateVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseNotesUrl: RELEASES_URL,
      downloaded: false,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null,
      autoDownload: channelStore?.getAutoDownload?.() ?? false,
      installRequiresAdmin: false,
      installOutcome: this.readInstallOutcome(appVersion),
    }
  }

  /** The previous update's note, read once and deleted; what it says about this version. */
  private readInstallOutcome(appVersion: string): AppUpdateInstallOutcome | null {
    let note: UpdateInstallNote | null = null
    try {
      note = this.installNotes?.consume() ?? null
    } catch {
      note = null
    }
    if (!note) return null
    const outcome = installOutcomeFromNote(note, appVersion, Date.now())
    if (outcome) {
      this.logStep(
        outcome.kind === 'updated' ? 'info' : 'warning',
        outcome.kind === 'updated' ? `Updated to ${outcome.version}` : `Update to ${outcome.version} did not install`,
        outcome.message ?? `SprintEngine Studio ${outcome.fromVersion} was replaced by ${outcome.version}.`,
        note,
      )
    }
    return outcome
  }

  /**
   * The updater, loaded and configured on first use. Everything the
   * constructor used to set on it is set here instead, from the service's
   * state at that moment, so a channel chosen before the first check is the
   * one the first check follows.
   */
  private loadUpdater(): Promise<UpdaterModule> {
    this.updaterLoading ??= loadUpdaterModule().then(async (loaded) => {
      const { autoUpdater } = loaded
      // Updates download when this service says so: when the person presses
      // Download, or at once when they turned automatic download on. A
      // download electron-updater started itself would carry a cancellation
      // token this service never sees, and a channel switch could not stop it.
      autoUpdater.autoDownload = false
      applyUpdaterChannel(autoUpdater, this.track, getAppVersion())
      await this.resolveWindowsTarget()
      autoUpdater.autoInstallOnAppQuit = this.electronUpdaterInstallsAtQuit()
      if (typeof autoUpdater.on === 'function') {
        this.registerAutoUpdaterEvents(autoUpdater)
      }
      this.updater = loaded
      return loaded
    })
    return this.updaterLoading
  }

  /**
   * Whether electron-updater's own install-at-quit is on. Never on Windows:
   * electron-updater would start the installer without the installation
   * folder (it cannot pass a folder with a space in it unquoted), so the
   * update would go wherever the registry points rather than into the running
   * installation. This service starts that installer itself instead
   * (`registerInstallAtQuit`). On macOS and Linux it stays electron-updater's.
   */
  private electronUpdaterInstallsAtQuit(): boolean {
    return this.platform.platform !== 'win32'
  }

  /** Windows only: where the running app is installed, asked once. */
  private resolveWindowsTarget(): Promise<WindowsInstallTarget | null> {
    if (this.platform.platform !== 'win32' || !isAppPackaged()) return Promise.resolve(null)
    this.windowsTarget ??= this.platform
      .resolveWindowsTarget()
      .then((target) => {
        this.resolvedWindowsTarget = target
        this.logStep('info', 'Installation found', `SprintEngine Studio runs from ${target.installDir}.`, target)
        if (target.requiresAdmin !== this.state.installRequiresAdmin) {
          this.updateState({ installRequiresAdmin: target.requiresAdmin })
        }
        return target
      })
      .catch((error: unknown) => {
        this.logStep('warning', 'Installation not found', error instanceof Error ? error.message : String(error))
        return null
      })
    return this.windowsTarget
  }

  getState(): AppUpdateState {
    return {
      ...this.state,
      progress: this.state.progress ? { ...this.state.progress } : null,
      installOutcome: this.state.installOutcome ? { ...this.state.installOutcome } : null,
    }
  }

  getChannel(): AppUpdateChannelSetting {
    return { channel: this.track, chosen: (this.channelStore?.get() ?? null) !== null }
  }

  /** Download updates as soon as a check finds them, or wait for Download. */
  setAutoDownload(enabled: boolean): AppUpdateState {
    this.channelStore?.setAutoDownload?.(enabled)
    this.updateState({ autoDownload: enabled })
    // Turned on with an update already waiting: fetch it now, as a check would have.
    if (enabled && this.state.status === 'available' && !this.download) void this.downloadUpdate()
    return this.getState()
  }

  /** The renderer has told the person how the last update went. */
  dismissInstallOutcome(): AppUpdateState {
    if (this.state.installOutcome) this.updateState({ installOutcome: null })
    return this.getState()
  }

  /**
   * Follow another train from now on, and look at it straight away.
   *
   * Whatever the old channel found is forgotten: an update offered or even
   * downloaded from nightly is not what a person who just picked stable wants
   * installed, so the state goes back to idle before the check, and a
   * download already on disk stops being installed at quit until the new
   * channel downloads one of its own. (On macOS, Squirrel may already have
   * staged it; that is the one case this cannot take back.)
   */
  async setChannel(track: AppUpdateTrack): Promise<AppUpdateCheckResult> {
    // The install under way is this channel's update, and the app is already
    // on its way out; switching now would change nothing but the saved choice.
    if (this.installing) {
      return { ok: false, state: this.getState(), message: 'An update is being installed.' }
    }
    this.channelStore?.set(track)
    this.track = track
    // An updater not loaded yet picks the new track up when it loads; nothing
    // can have been downloaded or started without it.
    const updater = this.updater?.autoUpdater
    if (updater) {
      applyUpdaterChannel(updater, track, getAppVersion())
      if (this.state.downloaded) updater.autoInstallOnAppQuit = false
    }
    // A download still running is the old channel's too. Left alone it would
    // finish after the reset below and mark itself ready to install at quit.
    if (this.download) {
      this.download.stale = true
      this.download.token.cancel()
    }
    this.updateState({
      status: 'idle',
      channel: isAppPackaged() ? track : 'dev',
      updateVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseNotesUrl: RELEASES_URL,
      downloaded: false,
      progress: null,
      errorMessage: null,
    })
    if (!isAppPackaged()) {
      return { ok: true, state: this.getState(), message: getStatusMessage('idle') }
    }
    return this.checkForUpdates(true)
  }

  async checkForUpdates(isManual = true): Promise<AppUpdateCheckResult> {
    if (!isAppPackaged()) {
      this.updateState({
        status: 'error',
        errorMessage: 'Update checks are only available in packaged builds.',
        lastCheckedAt: new Date().toISOString(),
      })
      return { ok: false, state: this.getState(), message: this.state.errorMessage ?? getStatusMessage('error') }
    }

    // A download under way, or one waiting for a restart, already answers the
    // question. Asking the feed again would announce the same version as
    // merely available -- electron-updater emits update-available on every
    // check -- so the state would drop back from ready-to-install, and the
    // hourly poller would do that to a waiting update all day.
    if (this.state.downloaded || this.installing || (this.download && !this.download.stale)) {
      return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
    }

    this.updateState({
      status: 'checking',
      errorMessage: null,
      progress: null,
      lastCheckedAt: new Date().toISOString(),
    })
    if (isManual) this.logStep('info', 'Checking for updates', `Channel ${this.track}, version ${getAppVersion()}.`)

    try {
      const { autoUpdater } = await this.loadUpdater()
      const result = await autoUpdater.checkForUpdates()
      if (this.state.status === 'available') {
        this.logStep(
          'info',
          'Update available',
          `SprintEngine Studio ${this.state.updateVersion ?? 'update'} is available.`,
          { autoDownload: this.state.autoDownload },
        )
        // Only when the person asked for updates to download on their own
        // (owner ruling 2026-09-24): otherwise the update is offered, and
        // downloads when they press Download. Not awaited -- a check answers
        // in a second and a download takes minutes; its progress and its
        // outcome arrive as state.
        if (this.state.autoDownload) void this.downloadUpdate()
      }
      if (!result?.updateInfo) {
        return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
      }

      const info = result.updateInfo as UpdateInfoLike
      return {
        ok: true,
        state: this.getState(),
        message:
          info.version && info.version !== getAppVersion()
            ? `SprintEngine ${info.version} is available.`
            : getStatusMessage(this.state.status),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to check for updates.'
      this.updateState({
        status: 'error',
        errorMessage: message,
        lastCheckedAt: new Date().toISOString(),
      })
      await this.logUpdateError('Update check failed', message, isManual, error)
      return { ok: false, state: this.getState(), message }
    }
  }

  async downloadUpdate(): Promise<AppUpdateCheckResult> {
    if (!isAppPackaged()) {
      const message = 'Update downloads are only available in packaged builds.'
      this.updateState({ status: 'error', errorMessage: message })
      return { ok: false, state: this.getState(), message }
    }

    // A download the old channel started, and setChannel cancelled, holds
    // electron-updater's one download slot until it settles; a call made
    // before then would be handed that dying promise instead of a download
    // of its own.
    const updater = await this.loadUpdater()
    while (this.download?.stale) await this.download.settled
    // electron-updater hands a second call the download already running, so
    // only the call that starts one owns its token.
    const download = this.download ?? this.beginDownload(updater)
    const { autoUpdater } = updater
    try {
      this.updateState({ status: 'downloading', errorMessage: null })
      await autoUpdater.downloadUpdate(download.token)
      if (download.stale) {
        return { ok: false, state: this.getState(), message: STALE_DOWNLOAD_MESSAGE }
      }
      return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
    } catch (error) {
      if (download.stale) {
        return { ok: false, state: this.getState(), message: STALE_DOWNLOAD_MESSAGE }
      }
      const message = error instanceof Error ? error.message : 'Unable to download update.'
      this.updateState({ status: 'error', errorMessage: message })
      await this.logUpdateError('Update download failed', message, true, error)
      return { ok: false, state: this.getState(), message }
    } finally {
      if (this.download === download) this.download = null
      download.settle()
    }
  }

  private beginDownload(updater: UpdaterModule): NonNullable<SprintEngineUpdateService['download']> {
    let settle: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const download = { token: new updater.CancellationToken(), stale: false, settled, settle }
    this.download = download
    this.loggedProgressMarks = new Set()
    this.logStep(
      'info',
      'Downloading update',
      `Downloading SprintEngine Studio ${this.state.updateVersion ?? ''}.`.trim(),
    )
    return download
  }

  /**
   * What runs before the installer is started: the app lifecycle's ordered,
   * time-bounded shutdown. Registered by the lifecycle, which owns it. It
   * reports each leg as it finishes, which drives the progress window.
   */
  setPrepareForInstall(prepare: (report?: (leg: ShutdownLegReport) => void) => Promise<void>): void {
    this.prepareForInstall = prepare
  }

  quitAndInstall(): Promise<AppUpdateCheckResult> {
    if (this.installing) return this.installing
    const autoUpdater = this.updater?.autoUpdater
    // `downloaded` is only ever set by the loaded updater's own event, so the
    // second half is belt and braces.
    if (!this.state.downloaded || !autoUpdater) {
      return Promise.resolve({
        ok: false,
        state: this.getState(),
        message: 'No downloaded update is ready to install.',
      })
    }
    this.installing = this.install(autoUpdater)
    return this.installing
  }

  /**
   * "Restart to update", from the click to the hand-over.
   *
   * 1. Say so at once (status `installing`), so the renderer's toast and the
   *    Settings row show the press went through.
   * 2. On Windows, find the installation. If it needs an administrator, ask
   *    for one now, while nothing has been shut down: a refusal leaves the app
   *    running on its current version, with a message, instead of quitting.
   * 3. The progress window, then the ordered shutdown, each leg advancing it.
   * 4. The note for the next start, then the installer. On Windows the app
   *    starts it itself, non-silent so its progress banner shows, with the
   *    installation folder as `/D=`, and quits; the installer waits for this
   *    process to exit and restarts the app when it is done. On macOS and
   *    Linux, electron-updater's own quitAndInstall, as before.
   */
  private async install(autoUpdater: AppUpdater): Promise<AppUpdateCheckResult> {
    const fromVersion = getAppVersion()
    const toVersion = this.state.updateVersion
    this.updateState({ status: 'installing', errorMessage: null })
    this.logStep('info', 'Restart to update', `Installing ${toVersion ?? 'the update'} over ${fromVersion}.`, {
      platform: this.platform.platform,
    })
    // Let the state reach the renderer before anything slower starts.
    await yieldToEventLoop()

    const isWindows = this.platform.platform === 'win32'
    let installerPath: string | null = null
    let target: WindowsInstallTarget | null = null
    let installerArgs: string[] | null = null
    let installerStarted = false

    if (isWindows) {
      installerPath = downloadedInstallerPath(autoUpdater)
      target = await this.resolveWindowsTarget()
      if (!installerPath || !target) {
        return this.installNotStarted(
          installerPath
            ? 'Could not tell where SprintEngine Studio is installed, so the update was not installed.'
            : 'The downloaded update could not be found. Check for updates to download it again.',
        )
      }
      try {
        installerArgs = nsisUpdateArgs({
          installDir: target.installDir,
          silent: false,
          forceRun: true,
          waitForPid: this.platform.pid,
        })
      } catch (error) {
        return this.installNotStarted(error instanceof Error ? error.message : String(error))
      }

      if (target.requiresAdmin) {
        this.logStep(
          'info',
          'Asking for administrator permission',
          `Installing into ${target.installDir} needs an administrator.`,
          { installerPath, args: nsisCommandLineTail(installerArgs), perMachine: target.perMachine },
        )
        const elevated = await this.platform.launchElevated({
          installerPath,
          args: installerArgs,
          parentWindowHandle: this.platform.parentWindowHandle(),
        })
        if (elevated.outcome === 'declined') {
          return this.installNotStarted(
            `Windows did not get administrator permission, so the update was not installed. SprintEngine Studio is still on ${fromVersion}.`,
          )
        }
        if (elevated.outcome === 'failed') return this.installNotStarted(elevated.message)
        // The installer is running, and waits for this process to exit.
        installerStarted = true
        this.logStep('info', 'Installer started as administrator', 'It waits for SprintEngine Studio to close.')
      }
    }

    // From here the app is leaving. The progress window first, so the person
    // sees each step, then the app's own windows go.
    this.progressWindow?.show(updateInstallProgress({ stage: 'preparing' }))
    this.platform.hideAppWindows()
    const shutdownStarted = Date.now()
    try {
      await this.prepareForInstall?.((leg) => {
        this.progressWindow?.update(updateInstallProgress({ stage: 'saving', done: leg.done, total: leg.total }))
        this.logStep(
          leg.failed ? 'warning' : 'info',
          `Shutdown: ${leg.name}`,
          `${leg.done}/${leg.total} in ${leg.durationMs} ms${leg.failed ? ', failed' : ''}.`,
        )
      })
    } catch (error) {
      void this.writeDiagnosticLog({
        level: 'warning',
        source: 'update',
        title: 'Shutdown before update failed',
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    }
    this.logStep('info', 'Shutdown finished', `The app's shutdown took ${Date.now() - shutdownStarted} ms.`)

    // A channel switch cannot land during an install (setChannel refuses), but
    // should the download have been dropped all the same, restart the app as
    // it is rather than leave a window over services that are already down.
    if (!this.state.downloaded) {
      this.installing = null
      this.platform.relaunchApp()
      return { ok: false, state: this.getState(), message: 'No downloaded update is ready to install.' }
    }

    this.progressWindow?.update(updateInstallProgress({ stage: 'starting-installer' }))
    const note: UpdateInstallNote = {
      fromVersion,
      toVersion: toVersion ?? '',
      startedAt: new Date().toISOString(),
      platform: this.platform.platform,
      installDir: target?.installDir ?? null,
      requiresAdmin: target?.requiresAdmin ?? false,
    }
    this.writeInstallNote(note)

    if (!isWindows) {
      this.progressWindow?.update(
        updateInstallProgress({ stage: 'handing-over', platform: this.platform.platform, version: toVersion }),
      )
      this.logStep('info', 'Handing over to the updater', 'Quitting so the update can install.')
      // Silent, then relaunch. macOS ignores both: Squirrel swaps the bundle
      // and relaunches on its own. The AppImage updater swaps the file.
      autoUpdater.quitAndInstall(true, true)
      return { ok: true, state: this.getState(), message: 'Restarting to install update.' }
    }

    // Windows: the app starts the installer, so electron-updater's own
    // install-at-quit must not start a second one as the app exits.
    autoUpdater.autoInstallOnAppQuit = false
    this.installAttempted = true
    if (!installerStarted && installerPath && installerArgs) {
      this.logStep('info', 'Starting the installer', `${installerPath} ${nsisCommandLineTail(installerArgs)}`)
      try {
        const pid = await this.platform.spawnInstaller(installerPath, installerArgs)
        this.logStep('info', 'Installer started', `The installer is running (pid ${pid}).`)
      } catch (error) {
        const message = `The installer could not be started: ${error instanceof Error ? error.message : String(error)}`
        this.logStep('error', 'Installer did not start', message)
        // The services are down; come back on the current version, and let
        // the next start say why.
        this.writeInstallNote({ ...note, failureReason: message })
        this.installing = null
        this.platform.relaunchApp()
        return { ok: false, state: this.getState(), message }
      }
    }
    this.progressWindow?.update(updateInstallProgress({ stage: 'handing-over', platform: 'win32', version: toVersion }))
    this.logStep('info', 'Handing over to the installer', 'Quitting; the installer restarts SprintEngine Studio.')
    this.platform.quitApp()
    return { ok: true, state: this.getState(), message: 'Restarting to install update.' }
  }

  /**
   * The install stopped before anything was shut down: the app stays as it
   * was, the update stays downloaded, and the person is told why.
   */
  private installNotStarted(message: string): AppUpdateCheckResult {
    this.installing = null
    this.updateState({ status: 'downloaded', errorMessage: message })
    this.logStep('warning', 'Update not installed', message)
    return { ok: false, state: this.getState(), message }
  }

  private writeInstallNote(note: UpdateInstallNote): void {
    try {
      this.installNotes?.write(note)
    } catch (error) {
      this.logStep('warning', 'Update note not written', error instanceof Error ? error.message : String(error))
    }
  }

  async openReleaseNotes(): Promise<{ opened: true; url: string }> {
    const url = this.state.releaseNotesUrl || RELEASES_URL
    await shell.openExternal(url)
    return { opened: true, url }
  }

  /**
   * Later, then quitting: the downloaded update installs as the app exits,
   * silently, and the next start says how it went. On macOS and Linux that is
   * electron-updater's own quit handler, and this only leaves the note. On
   * Windows this starts the installer itself, into the running installation
   * (`/D=`), as Restart to update does, but silent and without restarting the
   * app. An installation that needs an administrator does not install at
   * quit: the UAC prompt would come up after the app had gone, with nothing on
   * screen to say what it was for. Restart to update asks instead, and the
   * ready toast says so.
   */
  private registerInstallAtQuit(autoUpdater: AppUpdater): void {
    if (this.installAtQuitRegistered) return
    this.installAtQuitRegistered = true
    this.platform.onAppQuit((exitCode) => {
      // `installAttempted` too: the relaunch after an installer that would not
      // start exits through `app.exit`, which still emits `quit`, and must not
      // start a silent installer behind the app it is relaunching.
      if (this.installing || this.installAttempted || !this.state.downloaded || exitCode !== 0) return
      const note: UpdateInstallNote = {
        fromVersion: getAppVersion(),
        toVersion: this.state.updateVersion ?? '',
        startedAt: new Date().toISOString(),
        platform: this.platform.platform,
        installDir: null,
        requiresAdmin: false,
      }
      if (this.platform.platform !== 'win32') {
        if (autoUpdater.autoInstallOnAppQuit) this.writeInstallNote(note)
        return
      }
      const installerPath = downloadedInstallerPath(autoUpdater)
      const target = this.resolvedWindowsTarget
      if (!installerPath || !target || target.requiresAdmin) {
        this.logStep(
          'info',
          'Update not installed at quit',
          !installerPath
            ? 'The downloaded installer could not be found.'
            : !target
              ? 'Where SprintEngine Studio is installed could not be found.'
              : 'Installing needs an administrator; Restart to update asks for one.',
        )
        return
      }
      let args: string[]
      try {
        args = nsisUpdateArgs({
          installDir: target.installDir,
          silent: true,
          forceRun: false,
          waitForPid: this.platform.pid,
        })
      } catch {
        return
      }
      this.writeInstallNote({ ...note, installDir: target.installDir })
      // The spawn itself is synchronous: the process is about to go.
      void this.platform.spawnInstaller(installerPath, args).catch(() => undefined)
    })
  }

  private registerAutoUpdaterEvents(autoUpdater: AppUpdater): void {
    autoUpdater.on('checking-for-update', () => {
      this.updateState({ status: 'checking', errorMessage: null, lastCheckedAt: new Date().toISOString() })
    })

    autoUpdater.on('update-available', (info: UpdateInfoLike) => {
      this.updateState({
        status: 'available',
        updateVersion: info.version ?? null,
        releaseName: info.releaseName ?? null,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseNotesUrl: info.version ? `${RELEASES_URL}/tag/v${info.version}` : RELEASES_URL,
        downloaded: false,
        progress: null,
        errorMessage: null,
      })
    })

    autoUpdater.on('update-not-available', () => {
      this.updateState({
        status: 'not_available',
        updateVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseNotesUrl: RELEASES_URL,
        downloaded: false,
        progress: null,
        errorMessage: null,
        lastCheckedAt: new Date().toISOString(),
      })
    })

    autoUpdater.on('download-progress', (progress: DownloadProgressLike) => {
      if (this.download?.stale) return
      const percent = typeof progress.percent === 'number' ? progress.percent : 0
      this.updateState({
        status: 'downloading',
        progress: {
          percent,
          transferred: typeof progress.transferred === 'number' ? progress.transferred : 0,
          total: typeof progress.total === 'number' ? progress.total : 0,
          bytesPerSecond: typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : 0,
        },
      })
      for (const mark of LOGGED_PROGRESS_MARKS) {
        if (percent >= mark && !this.loggedProgressMarks.has(mark)) {
          this.loggedProgressMarks.add(mark)
          this.logStep('info', 'Download progress', `${mark}% of ${progress.total ?? 0} bytes.`)
        }
      }
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfoLike) => {
      if (this.download?.stale) {
        // The old channel's file, finished before the cancel reached it.
        autoUpdater.autoInstallOnAppQuit = false
        return
      }
      // electron-updater emits this only after the file's sha512 matched the
      // feed and, on Windows, its signature was checked against the publisher.
      autoUpdater.autoInstallOnAppQuit = this.electronUpdaterInstallsAtQuit()
      this.registerInstallAtQuit(autoUpdater)
      this.logStep(
        'info',
        'Update downloaded',
        `SprintEngine Studio ${info.version ?? ''} downloaded and verified.`.trim(),
      )
      this.updateState({
        status: 'downloaded',
        updateVersion: info.version ?? this.state.updateVersion,
        releaseName: info.releaseName ?? this.state.releaseName,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? this.state.releaseNotes,
        releaseNotesUrl: info.version ? `${RELEASES_URL}/tag/v${info.version}` : this.state.releaseNotesUrl,
        downloaded: true,
        progress: null,
        errorMessage: null,
      })
    })

    autoUpdater.on('error', (error: Error) => {
      const message = error.message || 'Updater failed.'
      // An install under way owns the state until it hands over or says why not.
      if (this.state.status !== 'installing') this.updateState({ status: 'error', errorMessage: message })
      void this.logUpdateError('Updater error', message, false, error)
    })
  }

  private updateState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch }
    broadcastToAllWindows('update:state-changed', this.getState())
  }

  /** One line in the diagnostics log per updater step, so the next failure can be read back. */
  private logStep(level: DiagnosticLogInput['level'], title: string, message: string, details?: unknown): void {
    void this.writeDiagnosticLog({
      level,
      source: 'update',
      title,
      message,
      ...(details === undefined ? {} : { details: JSON.stringify(details) }),
    }).catch(() => undefined)
  }

  private async logUpdateError(title: string, message: string, manual: boolean, error: unknown): Promise<void> {
    try {
      await this.writeDiagnosticLog({
        level: 'error',
        source: 'update',
        title,
        message,
        details: JSON.stringify({
          manual,
          version: this.state.version,
          channel: this.state.channel,
          packaged: this.state.packaged,
          updateVersion: this.state.updateVersion,
          lastCheckedAt: this.state.lastCheckedAt,
          cause: describeUpdateError(error),
        }),
      })
    } catch {
      // Diagnostics must not make update failure handling worse.
    }
  }
}
