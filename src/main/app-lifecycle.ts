import { app, BrowserWindow, ipcMain, Menu, net, powerMonitor } from 'electron'
import { createAppMenu, setChatWindowsForCloseChord } from './app-menu'
import { sweepRetiredCheckpoints } from './checkpoint-sweep'
import { createBootReveal } from './boot-reveal'
import { DEEP_LINK_SCHEMES } from '../shared/deep-link-scheme'
import { CHAT_LINK_OPEN_CHANNEL, chatLinkFromArgv, type ChatLink } from '../shared/deep-link'
import { createChatLinkRouter } from './chat-link-router'
import { registerChatLinkIpc, routeSecondLaunch } from './chat-link-ipc'
import { registerLinuxUrlHandler, systemLinuxUrlHandlerDeps } from './linux-url-handler'
import { BOOT_WORKSPACE_SYNC_BUDGET_MS, runBootDiscovery, settleWithin } from './boot-discovery'
import { discoverAndBroadcastCliModels } from './ipc/cli-model-discovery-ipc'
import { closeSplashWindow, createSplashWindow, sendSplashProgress } from './splash-window'
import {
  createMainWindow,
  isWorkspaceWindowWebContents,
  listWorkspaceWindows,
  markAppQuitInProgressForWindowClose,
  revealMainWindow,
  workspaceWindowIdOf,
} from './window-factory'
import { markStartup } from './startup-timeline'
import { createBackgroundPresence } from './background-presence'
import { buildElectronBackgroundMenu, createElectronBackgroundTray } from './background-tray-electron'
import { emptyBackgroundStatus, type BackgroundStatus } from '../shared/background-mode'
import { writeDiagnosticLog } from './diagnostics-service'
import { createMainThreadStallMonitor } from './main-thread-stall-monitor'
import { bindPollerToActivity, gateStallMonitorOnActivity, powerActivity } from './power-activity'
import { sendWindowHidden } from './ipc/window-ipc'
import type { SprintEngineUpdateService } from './update-service'
import { registerUnaskedQuits, type QuitConfirmation } from './quit-confirmation'
import type { ShutdownLegReport } from './update-install-progress'
import type { AgentPhaseEvent, AgentPhaseListener } from '../shared/agent-runtime'
import type { DesktopServerHost } from './server-supervisor/desktop-server-host'
import { createAgentAttention, isScriptSecondLaunch } from './agent-attention'
import type { AgentKeepAwake } from './agent-keep-awake'
import { createConversationAttentionListener } from './conversation-attention'
import type { ConversationEvent } from '../shared/conversation-runtime'
import { createHostedFeedPoller, type HostedFeedPoller } from './hosted-feed/poller'
import { isCanvasWorkerWindow } from './canvas/canvas-worker-window'
import { readHostedCardFeed } from './hosted-feed/card-feed-service'
import { readHostedSourcesFeed } from './hosted-feed/sources-feed-service'
import { detectCliMachines, readCliVersionAdvisories } from './cli-version-advisory-service'
import { hostRegistry } from './hosts/host-registry'
import { recordIntegrationWrite } from './integrations/ledger'
import { anyWindowFocused } from './window-broadcast'

type RegisterAppLifecycleOptions = {
  diagnosticsEnabled: boolean
  allowMultipleInstances?: boolean
  terminalRuntime: {
    shutdown(): Promise<void>
    // Agent turn ends and questions, which ask for the person through the
    // taskbar or dock (agent-attention.ts) and never by raising a window.
    registerAgentPhaseListener?(listener: AgentPhaseListener): () => void
  }
  /** Handed the one attention channel once it exists, for asks that are not a turn (a diff tour). */
  onAgentAttentionReady?(attention: { notify(key: string): void }): void
  /** Hears the same turn ends and questions, for the OS banner that names the chat (agent-notifications.ts). */
  agentNotifier?: { onAgentPhase(event: AgentPhaseEvent): void }
  /** Handed the chat-link router's opener once it exists, so a clicked banner can open its chat. */
  onChatLinksReady?(open: (link: ChatLink) => void): void
  // The chats, as every caller drives them (the core's conversation backend):
  // the attention channel follows their events.
  conversations?: {
    onEvent?(listener: (event: ConversationEvent) => void): () => void
  }
  // The conversation runtime's owner handle: quit must dispose its headless
  // child processes too — they live outside the PTY reaper's sight.
  conversationOwner?: {
    /** Buffered transcript text to disk, before the slower session stops. */
    flushTranscripts?(): Promise<void>
    shutdown(): Promise<void>
  }
  automationService?: {
    initialize(): Promise<unknown>
    shutdown(): Promise<void>
  }
  /**
   * The Studio RPC's owner socket, for applications paired with this app.
   * Started beside the gateway and stopped with it; nothing waits on it.
   */
  studioRpcService?: {
    start(): Promise<void>
    stop(): Promise<void>
  }
  // Always-on (no setting gate): the reporter socket must be listening before
  // any agent launches so the first lifecycle frame is captured.
  agentStateService?: {
    initialize(): Promise<void>
    shutdown(): Promise<void>
  }
  workspaceSyncService?: {
    /** Persist the debounced workspace registry write before the app exits. */
    flush(): Promise<void>
  }
  /**
   * Takes back out the hooks, MCP entries and launcher the app writes into
   * repositories and CLI configuration, which it writes again when next needed:
   * so deleting the app leaves none of them behind. Once no agent is running.
   */
  removeSessionIntegrations?: () => Promise<void>
  /**
   * Lets go of the data directory's run lock (src/server/core/data-dir.ts), so
   * a server started after the app quits finds it free rather than asking
   * whether the process that held it is still running. Last, after every leg
   * that writes into the directory.
   */
  releaseDataDir?: () => void
  // The Canvas pane's service: it holds a board mid-write (temp file, then a
  // rename), a directory watcher per open board, and a hidden worker window.
  // Quitting between those two fs calls would leave a stray temp file in the
  // person's project, so its own dispose waits for the write to land.
  canvasService?: {
    dispose(): Promise<void>
  }
  // The worktree pool: a lease or return in flight finishes its write, and
  // each pool's container lock is given up so another Studio can take the pool
  // over.
  worktreePool?: {
    shutdown(options?: { waitMs?: number }): Promise<void>
  }
  // The dependency installs agent worktrees are running (worktree-pool/
  // dependency-install.ts). Each runs detached, as a process group of its own,
  // so nothing would end it with the app: the quit stops every one.
  dependencyInstaller?: {
    shutdown(options?: { waitMs?: number }): Promise<void>
  }
  // Recordings of browser tabs an agent started: each is a file still being
  // written, so quit saves what was captured, with its length, before the
  // windows that encode them close.
  browserRecorder?: {
    stopAll(reason: 'app_quit'): Promise<void>
  }
  // The shell's own client of an out-of-process server, offering its
  // toolsets: closed before the server drains, so the server's goodbye is
  // not one it answers by reconnecting.
  desktopShell?: { stop(): void } | null
  // The composer's command lists: the last good one per CLI and folder waits
  // a moment before it is written, so quit writes what is still pending.
  conversationCommands?: {
    dispose(): Promise<void>
  }
  // The pull request record (epic `pull-request-marks`). In process the core
  // holds it here: a chained write per repository and a watch timer per open
  // pull request, so quit settles the writes — a lookup a last turn end started
  // is otherwise lost — and tears the timers down. Either way the shell's own
  // client for the terminals' marks closes here.
  pullRequestRecord?: {
    flush(): Promise<void>
    dispose(): void
  }
  // The local servers the agents linked, in process only (out of process the
  // server stops them in its own legs). The runs the Studio started itself
  // stop here: left running, nothing would be left to stop them from.
  localServers?: {
    flush(): Promise<void>
    dispose(): Promise<void>
  }
  // What Studio sends into chats on its own clock, in process only: a resume
  // once a usage limit resets, a message a person scheduled. Both stop before
  // the chats do; one due during the quit would start an agent on the way out.
  usageLimitResumes?: { dispose(): Promise<void> }
  scheduledMessages?: { dispose(): Promise<void> }
  // Who launched which agent, kept for after a restart. Written first, before
  // any session closes: the closes a quit makes are not parents going away.
  launchNotices?: { freeze(): Promise<void> }
  // Product telemetry. Given a shutdown leg of its own because everything above
  // it can emit a final event, and the buffer is in memory, so a quit that does
  // not drain it loses the whole session's tail.
  analytics?: {
    shutdown(): Promise<void>
  }
  // Capability-module kernel: runs module startup hooks on ready and shutdown
  // hooks on quit. Module-owned lifecycle runs here — the early begin phase
  // (runShutdownBegin, registration order) stops self-scheduled loops before
  // shared infrastructure tears down, and the late phase (runShutdown, reverse
  // registration order) drains in-flight work and stops kernel-owned sidecars.
  moduleKernel?: {
    runStartup(): Promise<void>
    runShutdownBegin(): Promise<void>
    runShutdown(): Promise<void>
  }
  // Settles once every asynchronous module registerMain has finished (or been
  // dropped), so startup hooks a module declared after an await still run.
  moduleLoadReady?: Promise<void>
  updateService: SprintEngineUpdateService
  handleAuthCallback(argv: string[]): void
  /**
   * The registry's windows, for a `sprintengine://chat/…` link: the one that
   * holds the chat, and the primary. Absent, a link opens in the focused window.
   */
  chatWindows?: {
    holderOf(chatId: string): string | null
    primaryWindowId(): string
  }
  // Background mode. Absent means the setting can never read on, so
  // the last-window-close rule collapses to exactly its form before background mode existed.
  backgroundMode?: {
    isEnabled(): boolean
    readStatus(): BackgroundStatus
  }
  /**
   * The question a person's own quit is asked while agents are working
   * (quit-confirmation.ts). Absent, every quit goes straight through, as it
   * did before it asked.
   */
  quitConfirmation?: Pick<QuitConfirmation, 'confirm' | 'quitWithoutAsking'>
  /**
   * Holds the computer awake while agents work (agent-keep-awake.ts). Fed the
   * same phases agent attention is, and let go at quit. Absent, nothing holds
   * the machine up.
   */
  agentKeepAwake?: Pick<AgentKeepAwake, 'onAgentPhase' | 'dispose'>
  /** The plugin-source update check (skills service); rides the hourly feed leg. */
  checkPluginSourceUpdates?: () => Promise<unknown>
  /**
   * Opens the gate on the boot jobs nothing on screen needs (the git probe and
   * the rest). Called once the main window reveals, so they never compete with
   * the renderer's first load. It also starts the workspace sync, should
   * `prepareWorkspacesAtBoot` not have.
   */
  startDeferredBootJobs?: () => void
  /**
   * The workspace sync: the launcher, the app's plugin home, and the pass over
   * every known workspace (the Studio skills chosen, the retired ones taken
   * out). Started as the loading screen goes up; the reveal waits for it for at
   * most `BOOT_WORKSPACE_SYNC_BUDGET_MS`, and it carries on past that.
   */
  prepareWorkspacesAtBoot?: () => Promise<unknown>
  /**
   * The Studio server in a process of its own (phase 6). Forked at ready
   * before the plate goes up, drained at quit beside the shell's own legs, and
   * the source of chat phases for the dock badge.
   */
  server?: Pick<DesktopServerHost, 'start' | 'shutdown' | 'log'> & {
    onAttentionPhase(listener: (event: AgentPhaseEvent) => void): void
  }
}

// How long after boot CLI detection settles the first model discovery pass
// runs; see the call site.
const BOOT_MODEL_DISCOVERY_DELAY_MS = 10_000

export function registerAppLifecycle({
  diagnosticsEnabled,
  allowMultipleInstances = false,
  terminalRuntime,
  conversations,
  conversationOwner,
  automationService,
  studioRpcService,
  agentStateService,
  workspaceSyncService,
  removeSessionIntegrations,
  releaseDataDir,
  canvasService,
  worktreePool,
  dependencyInstaller,
  browserRecorder,
  desktopShell,
  conversationCommands,
  pullRequestRecord,
  localServers,
  usageLimitResumes,
  scheduledMessages,
  launchNotices,
  analytics,
  moduleKernel,
  moduleLoadReady,
  updateService,
  handleAuthCallback,
  chatWindows,
  backgroundMode,
  quitConfirmation,
  agentKeepAwake,
  checkPluginSourceUpdates,
  startDeferredBootJobs,
  prepareWorkspacesAtBoot,
  onAgentAttentionReady,
  agentNotifier,
  onChatLinksReady,
  server,
}: RegisterAppLifecycleOptions): void {
  // Background mode: the last window closing stops being the end of
  // the process. Everything below the window layer — the scheduler, the Studio
  // gateway, the automations engine, the mobile bridge, the power-save blocker
  // held for active runs — is untouched by any of this on purpose; window close
  // is a presentation event.
  const backgroundPresence = createBackgroundPresence({
    platform: process.platform,
    isBackgroundModeEnabled: () => backgroundMode?.isEnabled() ?? false,
    readStatus: () => backgroundMode?.readStatus() ?? emptyBackgroundStatus(),
    createTray: createElectronBackgroundTray,
    buildMenu: buildElectronBackgroundMenu,
    actions: {
      open: () => openWindowFromBackground(),
      quit: () => app.quit(),
    },
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Reopening from the tray (or a second launch of the app) has to work on
  // Windows and Linux, where there is no `activate` event to fall back on.
  function openWindowFromBackground(): void {
    // The hidden canvas worker is not a way back into the app: with the pane
    // closed and an agent drawing, it can be the only window there is, and
    // focusing it would drop the tray and leave nothing on screen.
    const existing = BrowserWindow.getAllWindows().find((win) => !isCanvasWorkerWindow(win))
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    } else {
      // Not once the quit's shutdown is running: a window opened against
      // services that are stopping flashes up and is gone when the app exits.
      if (shutdownRun) return
      createMainWindow({ diagnosticsEnabled })
    }
    backgroundPresence.onWindowOpened()
  }

  // A `sprintengine://chat/…` link (shared/deep-link.ts), held until the window
  // it is for is listening, then opened there (chat-link-router.ts). It only
  // ever selects a chat; the auth callback keeps its own path below.
  const chatLinks = createChatLinkRouter<BrowserWindow>({
    windows: listWorkspaceWindows,
    windowIdOf: workspaceWindowIdOf,
    primaryWindowId: () => chatWindows?.primaryWindowId() ?? 'primary',
    holderOf: (chatId) => chatWindows?.holderOf(chatId) ?? null,
    // Not once the app is quitting: a link still waiting when its last window
    // closes for the quit must not open a new one.
    canOpenWindow: () => app.isReady() && shutdownRun === null,
    // Only ever asked with no workspace window open, so it makes one. Raising
    // whatever window there is, as the tray's Open does, could raise an aux
    // window, and the link would wait for a workspace window that never came.
    openWindow: () => {
      createMainWindow({ diagnosticsEnabled })
      backgroundPresence.onWindowOpened()
    },
    send: (win, link, generation) => win.webContents.send(CHAT_LINK_OPEN_CHANNEL, link, generation),
  })
  onChatLinksReady?.((link) => chatLinks.open(link))
  function openChatLinkFrom(argv: readonly string[]): void {
    const link = chatLinkFromArgv(argv)
    if (link) chatLinks.open(link)
  }
  registerChatLinkIpc({
    ipcMain,
    router: chatLinks,
    windowOf: (contents) => BrowserWindow.fromWebContents(contents),
    isWorkspaceWindow: isWorkspaceWindowWebContents,
  })

  // The single-instance lock itself is taken by the entry (index.ts), before any
  // service is built, so a second launch exits without paying for the service
  // graph. This process holds it, and hears every later launch here.
  if (!allowMultipleInstances) {
    app.on('second-instance', (_, argv) => {
      // A hook or bridge script that reached the binary without
      // ELECTRON_RUN_AS_NODE is not a person asking for the app. Raising the
      // window for it took focus from whatever they were doing, once per tool
      // call.
      if (isScriptSecondLaunch(argv)) return
      // Relaunching the app while it is backgrounded must produce a window:
      // without this the second launch silently did nothing, which on Windows
      // and Linux left the tray as the only way back in. A launch carrying a
      // chat link gets its window from the link router, which raises the one
      // the chat opens in, or opens one.
      routeSecondLaunch(argv, {
        openChatLink: (link) => chatLinks.open(link),
        openWindow: openWindowFromBackground,
      })
      handleAuthCallback(argv)
    })
  }

  // macOS hands a link over here, to a running app and to one the link is
  // launching alike; in the second case before `ready`, which the chat-link
  // router waits out.
  app.on('open-url', (event, callbackUrl) => {
    event.preventDefault()
    handleAuthCallback([callbackUrl])
    openChatLinkFrom([callbackUrl])
  })

  let hostedFeedPoller: HostedFeedPoller | null = null
  let bootModelDiscoveryTimer: ReturnType<typeof setTimeout> | null = null

  // On whenever a window has focus, and cheap: a report of "the main thread
  // stopped answering for N ms" is the one piece of evidence a frozen terminal
  // leaves behind on a packaged build, where nobody has a console open.
  let releaseStallMonitorGate: (() => void) | null = null
  let releasePollerActivity: (() => void) | null = null
  const stallMonitor = createMainThreadStallMonitor({
    report: (report) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'terminal',
        title: 'Main process stalled',
        message:
          `The main process did not answer for up to ${report.maxStallMs} ms ` +
          `(${report.stalls} stall(s), ${report.totalStallMs} ms in total over ${Math.round(report.windowMs / 1000)} s). ` +
          'Terminal input and clicks wait behind it.',
        details: JSON.stringify({
          ...report,
          platform: process.platform,
          rssBytes: process.memoryUsage().rss,
        }),
      }).catch(() => undefined)
    },
  })

  // A logout, restart or power-off, or a process signal (`pkill`, a systemd
  // stop, Ctrl+C), is the OS's quit, never the person's: it is not asked
  // about, and a question already up is taken down so it cannot hold the OS
  // up. A signal quits through `before-quit` like any other quit, so the
  // ordered shutdown below runs before the process goes; a signal sent again
  // well after the first exits without waiting for it.
  registerUnaskedQuits({
    platform: process.platform,
    quitConfirmation,
    quit: () => app.quit(),
    exit: () => app.exit(1),
    onWindowCreated: (listener) => {
      app.on('browser-window-created', (_event, win) => listener(win))
    },
    onSystemShutdown: (listener) => {
      void app.whenReady().then(() => powerMonitor.on('shutdown', listener))
    },
    onSignal: (signal, listener) => {
      process.on(signal, listener)
    },
  })

  app.whenReady().then(async () => {
    markStartup('main.app-ready')
    app.setAppLogsPath()
    bindElectronPowerActivity()
    releaseStallMonitorGate = gateStallMonitorOnActivity(powerActivity, stallMonitor)

    if (process.platform === 'win32') {
      app.setAppUserModelId(process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.sprintengine.studio')
    }
    registerDeepLinkProtocols()

    setChatWindowsForCloseChord(listWorkspaceWindows)
    Menu.setApplicationMenu(createAppMenu())
    // Out of process the server is forked first thing: it can only start once
    // the app is ready, and it composes in parallel with the windows below.
    server?.start()
    // Always-on: one local SprintEngine Studio MCP gateway per app instance.
    // Started here and NOT awaited: it runs alongside the renderer's load
    // rather than in front of the plate. Every agent launch waits for it
    // instead (`whenAgentLaunchReady` in app-services.ts), so no agent can start
    // before the listener its MCP config points at exists.
    void automationService?.initialize().catch((error: unknown) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Studio MCP gateway did not start',
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    })
    // The owner socket for paired local apps, beside it and not awaited
    // either. Nothing in the app depends on it; a socket that cannot start
    // says so in Settings.
    void studioRpcService?.start().catch(() => undefined)

    // The plate goes up BEFORE the main window is created: from here until the
    // reveal there is always something on screen. A nightly build opens on its
    // own plate; the update service read the build's channel from its version
    // when it was constructed, before any window existed.
    createSplashWindow({ buildChannel: updateService.getState().buildChannel })
    markStartup('main.splash-shown')
    const mainWindow = createMainWindow({ diagnosticsEnabled, deferShow: true })
    markStartup('main.window-created')

    const bootReveal = createBootReveal({
      reveal: () => {
        // Order matters: close the plate first, then show the app. Reversed,
        // both are briefly on screen — the one thing the transition must never
        // do.
        closeSplashWindow()
        revealMainWindow(mainWindow)
        markStartup('main.reveal')
        startBootJobsAfterReveal()
      },
    })
    // The workspace sync, while the plate is up. The reveal waits for whichever
    // comes first of the sync finishing and its budget running out — never
    // longer — and the sync keeps going in the background past the budget,
    // exactly as it ran before it moved here. BootReveal's own hard timeout
    // still stands over all of it.
    const workspacesPrepared = prepareWorkspacesAtBoot
      ? settleWithin(prepareWorkspacesAtBoot(), BOOT_WORKSPACE_SYNC_BUDGET_MS)
      : Promise.resolve('settled' as const)
    void workspacesPrepared.then((outcome) => {
      markStartup('main.workspaces-prepared')
      if (outcome === 'timed-out') {
        void writeDiagnosticLog({
          level: 'info',
          source: 'workspace',
          title: 'Workspace sync continued after startup',
          message: `Preparing workspaces took longer than ${BOOT_WORKSPACE_SYNC_BUDGET_MS / 1000} s, so the app opened and it carried on in the background.`,
        }).catch(() => undefined)
      }
    })

    // `once`: a renderer that reloads mid-boot (dev HMR) must not re-arm a
    // reveal that has already happened.
    ipcMain.once('app:boot-complete', () => {
      void workspacesPrepared.then(() => bootReveal.trigger())
    })
    // A renderer that dies before its first frame never sends the signal, and
    // the window it was going to reveal is hidden. The timeout inside
    // createBootReveal is the only thing between that and a Force Quit, so cover
    // outright destruction here too rather than making the user wait it out.
    mainWindow.webContents.on('render-process-gone', () => bootReveal.trigger())

    // Discovery runs while the plate is up. Deliberately not awaited: the reveal
    // is driven by the renderer's first frame, not by these legs, so a slow CLI
    // probe delays a warmed cache and never the app.
    void runBootDiscovery({
      onProgress: sendSplashProgress,
      ...(prepareWorkspacesAtBoot ? { prepareWorkspaces: () => workspacesPrepared } : {}),
      // The one detection of this machine's CLIs a launch makes (Re-check in
      // Settings is the only other), with the commands the person set, so the
      // renderer's first read is answered from it. What it finds schedules the
      // version check's comparison (app-services), which waits for a window to
      // say whether checks are on. WSL machines are detected after the reveal.
      detectClis: () => detectCliMachines({ which: 'local' }),
      // Not awaited, so this mark can (and usually does) land after the reveal —
      // which is the point: it shows how much of the boot the user never waits
      // for, and how much of the CLI probe the splash actually covered.
      // The one update check at boot. It MOVED here rather than being
      // duplicated; the packaged guard rides with it, since checkForUpdates
      // records an error state in an unpackaged build.
      checkUpdates: async () => {
        if (!app.isPackaged) return
        await updateService.checkForUpdates(false)
      },
    }).finally(() => {
      markStartup('main.discovery-settled')
      // Model discovery follows CLI detection, whose held answer it reads, and
      // waits a little longer so the probes do not compete with the renderer's
      // first paint. Each CLI is re-probed only when its catalog is a day old or
      // its version changed, so on most launches this spawns nothing.
      // Out of process the server runs this pass itself, where the cache is.
      if (server) return
      bootModelDiscoveryTimer = setTimeout(() => {
        bootModelDiscoveryTimer = null
        void discoverAndBroadcastCliModels().catch(() => undefined)
      }, BOOT_MODEL_DISCOVERY_DELAY_MS)
    })

    // What the studio pulls on its own after boot: the hosted card and sources
    // feeds and the CLI version advisories 15 s after the window is up and then
    // hourly, and app updates hourly plus on waking from sleep and on coming
    // back to the app after half an hour — so a session left open all day still
    // learns about a same-day release without a network wake every few minutes.
    // Nothing runs while the machine sleeps, and every interval stretches on
    // battery (see poller.ts). The boot leg above keeps the one immediate update
    // check; the poller's first update check waits a full interval so it is not
    // repeated. Skipped while offline.
    hostedFeedPoller = createHostedFeedPoller({
      checkUpdates: async () => {
        if (!app.isPackaged) return
        await updateService.checkForUpdates(false)
      },
      // Three riders on one hour. The plugin-source update check rides the feed
      // leg for the cadence it wants and one fewer timer
      // (backlog/2026-09-05-plugin-sources.md), and the card feed rides it for
      // the same reason — this is the ONLY thing in the app that ever fetches
      // the card feed, and without it a shipped machine serves the bundled seed
      // until the next release, which is the whole point of hosting the file.
      // The sources feed rides it for the same reason again: its IPC
      // only ever reads disk, so this leg is the only thing that refreshes the
      // recommended list a machine offers.
      //
      // The tick is a heartbeat and not a schedule: every rider owns its own
      // window, so an hourly knock on a feed fetched forty minutes ago costs
      // nothing and an offline machine is not made to pay a timeout. The feeds
      // own a TTL and a retry gap; the plugin-source check owns a per-source
      // cadence window that widens to a day when no GitHub token is configured,
      // which is why the ruling changed no timer here — the leg
      // still knocks hourly and simply finds nothing due 23 times out of 24.
      //
      // Each rider is awaited on its own so one feed that cannot be read does
      // not take the others' hour with it; the first failure is rethrown so the
      // poller still reports the leg as failed.
      refreshFeed: async () => {
        const failures: unknown[] = []
        await readHostedCardFeed().catch((error) => void failures.push(error))
        await readHostedSourcesFeed().catch((error) => void failures.push(error))
        await checkPluginSourceUpdates?.().catch(() => undefined)
        if (failures.length > 0) throw failures[0]
      },
      // Compares the installed versions startup (or the last Re-check) found
      // against the registry. No detection: nothing is spawned on any machine,
      // no WSL distribution is started, and a CLI that is not installed is
      // never asked about.
      refreshVersions: () => readCliVersionAdvisories(),
      isOnline: () => net.isOnline(),
    })
    hostedFeedPoller.start()
    releasePollerActivity = bindPollerToActivity(powerActivity, hostedFeedPoller)

    // Work that only has to happen at some point after launch, started once
    // the window is on screen so none of it competes with the renderer's first
    // load. The reveal fires once (a renderer that never signals is revealed by
    // the boot-reveal timeout), so this runs once.
    function startBootJobsAfterReveal(): void {
      startDeferredBootJobs?.()
      // Each WSL machine turned on is detected once at startup, like this one,
      // so its CLI updates badge Settings without the person visiting its list.
      // After the reveal: asking may start the distribution's helper, which is
      // not something the first paint should wait behind.
      void detectCliMachines({ which: 'wsl' }).catch(() => undefined)
      // One-shot cleanup of the retired checkpoint machinery
      // (the-diff-an-agent-made / remove-checkpoint-machinery). Deliberately not
      // awaited and deliberately after the window exists: it walks repos with
      // `git update-ref -d`, and a cleanup that cannot finish must never be
      // something a launch waits on. With no checkpoint index on disk it returns
      // immediately, which is every machine that never ran those builds.
      // MIGRATION — remove this call and src/main/checkpoint-sweep.ts one release
      // after it ships (target: 2026-10).
      void sweepRetiredCheckpoints(app.getPath('userData'))
        .then((result) => {
          if (result.refsDeleted > 0 || result.indexRemoved) {
            void writeDiagnosticLog({
              level: 'info',
              source: 'workspace',
              title: 'Retired checkpoint refs swept',
              message: `Removed ${result.refsDeleted} ref(s) across ${result.reposVisited} repo(s)`,
            }).catch(() => undefined)
          }
        })
        .catch(() => {
          // The index survives a failure, so the next launch tries again.
        })
    }

    // Always-on: start the agent-state reporter socket so launches that follow
    // can install the hook against a live endpoint.
    void agentStateService?.initialize()

    // An agent that finished or is waiting flashes the taskbar button or
    // bounces the dock; the window itself stays where the person left it.
    const agentAttention = createAgentAttention({
      platform: process.platform,
      listWindows: () => BrowserWindow.getAllWindows().filter((win) => !isCanvasWorkerWindow(win)),
      bounceDock: () => app.dock?.bounce('informational'),
      setBadgeCount: (count) => app.setBadgeCount(count),
    })
    // The banner naming the chat, and keeping the computer awake while an
    // agent works, hear every phase the attention channel does.
    const onAgentPhase = (event: AgentPhaseEvent): void => {
      agentAttention.onAgentPhase(event)
      agentNotifier?.onAgentPhase(event)
      agentKeepAwake?.onAgentPhase(event)
    }
    if (agentKeepAwake) app.once('will-quit', () => agentKeepAwake.dispose())
    terminalRuntime.registerAgentPhaseListener?.(onAgentPhase)
    const disposeConversationAttention = conversations?.onEvent?.(createConversationAttentionListener({ onAgentPhase }))
    if (disposeConversationAttention) app.once('will-quit', disposeConversationAttention)
    // Out of process the server watches its chats and says when one's phase moves.
    server?.onAttentionPhase(onAgentPhase)
    onAgentAttentionReady?.(agentAttention)
    app.on('browser-window-focus', (_event, win) => {
      if (!isCanvasWorkerWindow(win)) agentAttention.onWindowFocused()
    })

    void Promise.resolve(moduleLoadReady).then(() => moduleKernel?.runStartup())
    handleAuthCallback(process.argv)
    // A link that launched the app on Windows or Linux is one of its arguments.
    openChatLinkFrom(process.argv)

    app.on('activate', () => {
      // A Dock click while the quit's shutdown runs opens nothing, as for the
      // tray above.
      if (shutdownRun) return
      if (BrowserWindow.getAllWindows().every((win) => isCanvasWorkerWindow(win))) {
        createMainWindow({ diagnosticsEnabled })
      }
      // The tray stands in for a window; with one on screen it goes away, so a
      // backgrounded app never shows two ways in at once.
      backgroundPresence.onWindowOpened()
    })
  })

  app.on('window-all-closed', () => {
    if (backgroundPresence.onWindowAllClosed() !== 'quit') return
    // Closing the last window ends the process here (Windows and Linux with
    // background mode off), so it is a quit like Cmd+Q and asks the same
    // question. The window is already gone by now; Cancel brings one back
    // rather than leave a process running with nothing on screen.
    if (!quitConfirmation) {
      app.quit()
      return
    }
    void quitConfirmation.confirm().then((decision) => {
      if (decision === 'quit') app.quit()
      else if (decision === 'stay') openWindowFromBackground()
    })
  })

  // The app's ordered shutdown, run once whichever way the app is leaving: a
  // quit (`before-quit`), or "Restart to update", which runs it BEFORE handing
  // over to the installer. The Windows installer force-kills a running app a
  // couple of seconds after it starts, so a shutdown that only began at the
  // updater's own quit could be cut off before its later legs ran.
  //
  // The legs are ordered by what a cut-short quit would cost, cheapest-to-save
  // and most-missed first, within what they depend on:
  //  1. Stop new work: module begin hooks, timers, the automations engine (so a
  //     dying agent cannot finalize a run: open a PR, remove its worktree), the
  //     dependency installs agent worktrees are running, and the agent-state
  //     socket.
  //  2. Small writes the person would miss: the workspace registry (every
  //     sidebar change), then every chat's buffered transcript.
  //  3. Terminal snapshots: the most valuable and, with many terminals, the
  //     slowest.
  //  4. What the terminal legs fed: captured pull requests. Then the chat
  //     sessions' own stop, the canvas's in-flight write, and the registry
  //     once more for anything the legs above changed.
  //  5. The integrations the app writes into repositories, now that no agent
  //     it launched is left to run them (a cut-short removal resumes next quit).
  //  6. What costs nothing if lost: the WSL helpers (they exit when this
  //     process's end closes their stdin), telemetry's network send, and the
  //     module kernel's own shutdown.
  let shutdownRun: Promise<void> | null = null
  let leavingForUpdate = false
  // The pool's wait for slot steps in flight, short when leaving for an
  // update: its ten seconds also have to cover the Studio server's drain after
  // it. A step cut short is recovered at the next start, as after a crash.
  const poolShutdownOptions = () => (leavingForUpdate ? { waitMs: POOL_UPDATE_SHUTDOWN_WAIT_MS } : {})
  // Who hears about each leg as it finishes: "Restart to update" passes one in,
  // which drives the progress window and the diagnostics timings. Joined late
  // (the shutdown already running), it still hears the legs that are left.
  let shutdownObserver: ((leg: ShutdownLegReport) => void) | null = null
  // The leg running now, for the quit that gives up waiting on it to name.
  let runningShutdownLeg: string | null = null
  const runShutdown = (observer?: (leg: ShutdownLegReport) => void): Promise<void> => {
    if (observer) shutdownObserver = observer
    if (shutdownRun) return shutdownRun
    const shutdownStartedAt = Date.now()
    // Drop the tray before the shutdown legs run: quit from the tray is the
    // same graceful path as any other quit (sidecar snapshots, gateway
    // discovery file removed), and the icon must not outlive the decision.
    backgroundPresence.onBeforeQuit()
    markAppQuitInProgressForWindowClose()
    // Quit legitimately blocks (snapshot writes, waiting on ptys); that is not
    // a stall anyone is reporting.
    releaseStallMonitorGate?.()
    releaseStallMonitorGate = null
    stallMonitor.stop()
    releasePollerActivity?.()
    releasePollerActivity = null
    const inProcessLegs: Array<[name: string, task: () => unknown]> = [
      // Module begin hooks run first (registration order): they stop
      // self-scheduled loops and flip shutting-down flags so no new work is
      // dispatched while shared infrastructure tears down.
      ['modules (begin)', () => moduleKernel?.runShutdownBegin()],
      [
        'timers',
        () => {
          if (bootModelDiscoveryTimer) clearTimeout(bootModelDiscoveryTimer)
          hostedFeedPoller?.stop()
        },
      ],
      ['launch notices', () => launchNotices?.freeze()],
      // Before the gateway, whose audit it writes to: its clients are told to
      // come back later, and resume from their cursors.
      ['local app socket', () => studioRpcService?.stop()],
      ['automations', () => automationService?.shutdown()],
      // With the new work: an install the quit cuts short is not recorded, so
      // its worktree installs again at its next lease, and an agent that was
      // waiting on it is not started on the way out.
      ['dependency installs', () => dependencyInstaller?.shutdown()],
      ['agent state', () => agentStateService?.shutdown()],
      ['workspace registry', () => workspaceSyncService?.flush()],
      ['chat transcripts', () => conversationOwner?.flushTranscripts?.()],
      ['terminals', () => terminalRuntime.shutdown()],
      // In process, the core's record: a lookup a last chat turn end started
      // is written down, and the watch timers stop. The shell's client of it
      // closed with the local app socket; out of process the server settles
      // the record in its own legs.
      ['pull requests (flush)', () => pullRequestRecord?.flush()],
      ['pull requests (dispose)', () => pullRequestRecord?.dispose()],
      ['local servers (flush)', () => localServers?.flush()],
      ['local servers (dispose)', () => localServers?.dispose()],
      ['usage-limit resumes', () => usageLimitResumes?.dispose()],
      ['scheduled messages', () => scheduledMessages?.dispose()],
      ['chats', () => conversationOwner?.shutdown()],
      ['browser recordings', () => browserRecorder?.stopAll('app_quit')],
      ['canvas', () => canvasService?.dispose()],
      ['worktree pool', () => worktreePool?.shutdown(poolShutdownOptions())],
      ['command lists', () => conversationCommands?.dispose()],
      ['workspace registry (final)', () => workspaceSyncService?.flush()],
      // Not when leaving for an update: the new build starts straight away and
      // writes them back, and the installer's time limit is better spent on
      // the legs after this one.
      ['integrations', () => (leavingForUpdate ? undefined : removeSessionIntegrations?.())],
      // Each WSL helper is told to shut down (it would also go on its own when
      // this process's end closes its stdin).
      ['WSL helpers', () => hostRegistry().dispose()],
      // Last of the app-owned legs: every service above has had its chance to
      // record, and a network round trip must not sit in front of anything
      // that still has state to persist.
      ['telemetry', () => analytics?.shutdown()],
      // Module-owned shutdown runs here via each module's onShutdown hook —
      // draining in-flight work and stopping kernel-owned sidecars in reverse
      // registration order.
      ['modules', () => moduleKernel?.runShutdown()],
      ['data directory', () => releaseDataDir?.()],
    ]
    // Out of process the server drains on its own (transcripts first), in
    // parallel with the shell's terminals; the integrations wait for it, so no
    // chat agent is left to use the entries being removed (spec 7.4).
    let serverStopped: Promise<unknown> = Promise.resolve()
    const outOfProcessLegs: Array<[name: string, task: () => unknown]> = [
      ['modules (begin)', () => moduleKernel?.runShutdownBegin()],
      [
        'timers',
        () => {
          if (bootModelDiscoveryTimer) clearTimeout(bootModelDiscoveryTimer)
          hostedFeedPoller?.stop()
        },
      ],
      ['launch notices', () => launchNotices?.freeze()],
      ['dependency installs', () => dependencyInstaller?.shutdown()],
      ['browser recordings', () => browserRecorder?.stopAll('app_quit')],
      // The canvas's last board write lands before the server stops serving.
      ['canvas', () => canvasService?.dispose()],
      ['worktree pool', () => worktreePool?.shutdown(poolShutdownOptions())],
      ['desktop tools', () => desktopShell?.stop()],
      [
        'studio server (drain)',
        () => {
          serverStopped = server!
            .shutdown({
              drain: true,
              budgetMs: leavingForUpdate
                ? serverUpdateDrainBudgetMs(Date.now() - shutdownStartedAt)
                : SERVER_DRAIN_BUDGET_MS,
              onProgress: (progress) =>
                server!.log.note(
                  `shutdown ${progress.done}/${progress.total} ${progress.leg}${progress.failed ? ' (failed)' : ''}`,
                ),
            })
            .catch(() => undefined)
        },
      ],
      ['agent state', () => agentStateService?.shutdown()],
      ['terminals', () => terminalRuntime.shutdown()],
      ['pull requests (flush)', () => pullRequestRecord?.flush()],
      ['pull requests (dispose)', () => pullRequestRecord?.dispose()],
      ['studio server', () => serverStopped],
      ['integrations', () => (leavingForUpdate ? undefined : removeSessionIntegrations?.())],
      ['WSL helpers', () => hostRegistry().dispose()],
      ['telemetry', () => analytics?.shutdown()],
      ['modules', () => moduleKernel?.runShutdown()],
    ]
    const legs = server ? outOfProcessLegs : inProcessLegs
    const shutdown = async () => {
      for (const [index, [name, task]] of legs.entries()) {
        const started = Date.now()
        runningShutdownLeg = name
        let failed = false
        // One failing leg must not cost the ones after it: best-effort by
        // design, the process is leaving either way.
        try {
          await task()
        } catch {
          failed = true
        }
        try {
          shutdownObserver?.({ name, done: index + 1, total: legs.length, durationMs: Date.now() - started, failed })
        } catch {
          // A progress report must not stop the shutdown.
        }
        // Back to the event loop between legs, so the window messages queued
        // behind a leg's synchronous stretch are pumped before the next one:
        // Windows marks a window "not responding" when its thread goes five
        // seconds without them, and the progress window has to keep painting.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      runningShutdownLeg = null
    }
    shutdownRun = shutdown()
    return shutdownRun
  }

  let exitScheduled = false
  let installFallback: NodeJS.Timeout | null = null
  app.on('before-quit', (event) => {
    // The updater did take over: its quit is the exit, so the fallback below
    // must never relaunch the old build under a running installer.
    if (installFallback) clearTimeout(installFallback)
    installFallback = null
    if (exitScheduled) return
    event.preventDefault()
    // A shutdown already running is "Restart to update" handing over: the
    // updater's own quit, never asked about.
    if (shutdownRun || !quitConfirmation) {
      exitAfterShutdown()
      return
    }
    // `pending`: the question is already up for an earlier quit, and its
    // answer decides this one too.
    void quitConfirmation.confirm().then((decision) => {
      if (decision === 'quit') exitAfterShutdown()
    })
  })
  function exitAfterShutdown(): void {
    if (exitScheduled) return
    exitScheduled = true
    // Joins a shutdown "Restart to update" already ran, so the updater's own
    // quit exits at once instead of running the legs a second time. A leg
    // that never settles (a child that ignores its signal, a write to a disk
    // gone away) must not keep a quit the person asked for from happening, so
    // past the budget the app leaves anyway, saying which leg it left behind.
    void settleWithin(runShutdown(), QUIT_SHUTDOWN_BUDGET_MS).then(async (outcome) => {
      if (outcome === 'timed-out') {
        const leg = runningShutdownLeg ?? 'unknown'
        await settleWithin(
          writeDiagnosticLog({
            level: 'warning',
            source: 'workspace',
            title: 'Quit did not finish shutting down',
            message: `The app quit after ${QUIT_SHUTDOWN_BUDGET_MS / 1000} s with the "${leg}" shutdown step still running; the steps after it did not run.`,
          }),
          QUIT_DIAGNOSTIC_WRITE_MS,
        )
      }
      app.exit(0)
    })
  }

  updateService.setPrepareForInstall(async (report) => {
    // The person pressed "Restart to update"; the quit that hands over to the
    // installer is the app's.
    quitConfirmation?.quitWithoutAsking()
    if (!shutdownRun) leavingForUpdate = true
    const run = runShutdown(report)
    let bounded: NodeJS.Timeout | undefined
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        bounded = setTimeout(resolve, UPDATE_SHUTDOWN_BUDGET_MS)
      }),
    ])
    clearTimeout(bounded)
    // The services are down from here, so the app must not outlive a hand-over
    // that goes wrong: on Windows and Linux the updater starts the installer
    // and quits at once, so an installer that fails to start leaves nothing to
    // quit the app. Any `before-quit` cancels this. Not on macOS, where the
    // quit can legitimately wait on Squirrel still copying the update, and a
    // relaunch there would race the bundle swap.
    if (process.platform === 'darwin' || exitScheduled) return
    installFallback = setTimeout(() => {
      installFallback = null
      if (exitScheduled) return
      app.relaunch()
      app.exit(0)
    }, UPDATE_INSTALL_QUIT_FALLBACK_MS)
    installFallback.unref()
  })
}

/**
 * How long a quit waits for the ordered shutdown before the app exits anyway.
 * Generous: the legs normally take a second or two, and the server's drain
 * alone may take 8 s. Only a leg that has hung reaches it, and the legs run in
 * order of importance, so what it cuts short is the least missed.
 */
export const QUIT_SHUTDOWN_BUDGET_MS = 25_000
/** How long that exit waits for the note saying which leg hung to be written. */
const QUIT_DIAGNOSTIC_WRITE_MS = 1_000

/**
 * How long "Restart to update" waits for the ordered shutdown before handing
 * over to the installer anyway. The legs run in order of importance, so what
 * this can cut short is the least missed; and the installer is still worth
 * more than a leg that has hung.
 */
const UPDATE_SHUTDOWN_BUDGET_MS = 10_000

/** How long the worktree pool may wait for its steps in flight within that budget. */
const POOL_UPDATE_SHUTDOWN_WAIT_MS = 2_000

/**
 * How long the Studio server may drain at quit, and within "Restart to
 * update", whose 10 s covers both processes: on Windows the installer waits on
 * main's pid only, and the server is the same executable image, so it must be
 * gone (killed at its budget) before the hand-over.
 */
const SERVER_DRAIN_BUDGET_MS = 8_000
const SERVER_UPDATE_DRAIN_BUDGET_MS = 6_000

/**
 * The drain's budget when leaving for an update, counted from when the
 * shutdown began rather than from when the drain does: the legs before it (the
 * canvas's last write, the modules' begin hooks) can take a while, and the kill
 * at the budget still has to land inside the update's 10 s with time for the
 * exit to be seen.
 */
export function serverUpdateDrainBudgetMs(elapsedMs: number): number {
  const left = UPDATE_SHUTDOWN_BUDGET_MS - SERVER_UPDATE_KILL_MARGIN_MS - elapsedMs
  return Math.max(SERVER_UPDATE_MIN_DRAIN_MS, Math.min(SERVER_UPDATE_DRAIN_BUDGET_MS, left))
}
const SERVER_UPDATE_KILL_MARGIN_MS = 1_500
const SERVER_UPDATE_MIN_DRAIN_MS = 500

/**
 * After the shutdown, the updater quits the app to install. Should it not (the
 * installer failed to start), relaunch the old build rather than leave a
 * window over services that have already shut down. Windows and Linux only.
 */
const UPDATE_INSTALL_QUIT_FALLBACK_MS = 30_000

/**
 * Feed `powerActivity` from Electron. Needs the app ready (`powerMonitor` is
 * unavailable before it), so it runs first thing in `whenReady`.
 *
 * Focus is "any app window is focused", recomputed on every focus and blur so
 * moving between two app windows does not read as leaving the app. A locked
 * screen counts as unfocused whatever the key window says: nobody is typing.
 * The canvas worker window is a hidden headless renderer and never counts.
 */
function bindElectronPowerActivity(): void {
  const syncFocus = (): void => {
    const focused = !powerActivity.isScreenLocked() && anyWindowFocused({ skipCanvasWorker: true })
    powerActivity.noteFocus(focused)
  }
  app.on('browser-window-focus', syncFocus)
  app.on('browser-window-blur', syncFocus)
  // A locked screen hides every window, which the pages cannot always see for
  // themselves (see `sendWindowHidden`).
  const syncLock = (locked: boolean): void => {
    powerActivity.noteScreenLocked(locked)
    syncFocus()
    for (const win of BrowserWindow.getAllWindows()) sendWindowHidden(win)
  }
  powerMonitor.on('lock-screen', () => syncLock(true))
  powerMonitor.on('unlock-screen', () => syncLock(false))
  powerMonitor.on('suspend', () => powerActivity.noteSuspend())
  powerMonitor.on('resume', () => {
    powerActivity.noteResume()
    syncFocus()
  })
  powerMonitor.on('on-battery', () => powerActivity.noteBattery(true))
  powerMonitor.on('on-ac', () => powerActivity.noteBattery(false))
  try {
    powerActivity.noteBattery(powerMonitor.isOnBatteryPower())
  } catch {
    // A platform that cannot say is treated as on power: the plain cadence.
  }
  syncFocus()
}

// Every scheme in `DEEP_LINK_SCHEMES` (shared/deep-link-scheme.ts). Registering
// is cheap and idempotent; an unclaimed scheme is a dead link with nowhere to
// report itself.
function registerDeepLinkProtocols(): void {
  // A packaged AppImage answers for its schemes with a desktop entry it writes
  // itself (linux-url-handler.ts). Electron's registration names a desktop file
  // no AppImage installs: run beside it, it would hand the default to a file
  // that is not there at every start, and the entry would take it back.
  const appImageEntry = process.platform === 'linux' && app.isPackaged && Boolean(process.env.APPIMAGE)
  if (appImageEntry) {
    void registerLinuxUrlHandler(
      {
        ...systemLinuxUrlHandlerDeps(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        env: process.env,
        log: (level, message, details) => {
          void writeDiagnosticLog({
            level,
            source: 'workspace',
            title: 'Link handler',
            message,
            ...(details ? { details: JSON.stringify(details) } : {}),
          }).catch(() => undefined)
        },
        record: (path, scheme) =>
          recordIntegrationWrite({
            kind: 'protocol-handler',
            path,
            marker: scheme,
            createdFile: true,
            hostId: 'local',
          }),
      },
      DEEP_LINK_SCHEMES,
    )
    return
  }
  for (const scheme of DEEP_LINK_SCHEMES) {
    if (!app.isPackaged) {
      // A dev build is `electron <app-dir>`, so the OS has to be handed both
      // halves; a packaged bundle describes its own entry point.
      app.setAsDefaultProtocolClient(scheme, process.execPath, [app.getAppPath()])
    } else {
      app.setAsDefaultProtocolClient(scheme)
    }
    // On Windows the registration is a key under HKCU\Software\Classes and on
    // Linux a desktop-entry association, and neither leaves with the app; on
    // macOS it lives in the bundle's Info.plist and does.
    if (process.platform !== 'darwin') {
      recordIntegrationWrite({
        kind: 'protocol-handler',
        path: process.platform === 'win32' ? `HKCU\\Software\\Classes\\${scheme}` : `x-scheme-handler/${scheme}`,
        marker: scheme,
        hostId: 'local',
      })
    }
  }
}
