import { app, BrowserWindow, ipcMain, net, powerMonitor, powerSaveBlocker, safeStorage } from 'electron'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { buildAgentStateReporterCommand, buildLauncherHookCommand } from './agent-state'
import { LAUNCH_FILES_DIR, prepareLaunchIntegration, pruneLaunchFiles } from './integrations/launch-integration'
import { knowledgeActivityLaunchCommand } from './memory-activity'
import { gitTracksPath } from './skills/studio-plugin'
import { createAgentConfigImportService } from './agent-config-import'
import {
  ensureAgentIntegrationHome,
  LAUNCH_REPORTER_REL,
  LAUNCH_STATUS_LINE_REL,
  pruneAgentIntegrationHomes,
  type EnsureAgentIntegrationHomeOptions,
} from './agent-integration-home'
import { createAgentStateService } from './agent-state-service'
import { primeDefaultWslDistro } from './hosts/wsl-distro'
import { configureWslHelpers } from './hosts/wsl-helper-runtime'
import { createDesktopWslServers } from '../server/wsl/desktop-wsl-servers'
import { createDesktopSsh, type DesktopSsh } from './environments/ssh/desktop-ssh'
import { isMachinePath } from '../shared/machine-paths'
import { workspaceProjectRootOf } from '../shared/worktree-paths'
import type { WorkspaceEnvironmentRef } from '../renderer/src/types/workspace'
import { sessionSshPreview } from './environments/ssh/ssh-preview'
import { relayShellToolsets, SSH_RELAYED_TOOLSETS } from '../server/wsl/wsl-tool-relay'
import { cliTakesLaunchPlugins } from './agent-launch-render'
import { resolveSocketPath as resolveAutomationSocketPath } from './automation/automation-service'
import { invalidateCliAvailabilityOnHost, subscribeKnownCliAvailability } from './cli-availability'
import { wslHostId } from '../shared/execution-host'
import {
  appLaunchPluginsActive,
  launchCarriesAppPluginsFor,
  setLaunchPluginDirsResolver,
  setLaunchSkillPluginDirsResolver,
  setLaunchStatusLineScriptResolver,
} from './terminal-launch'
import { TAILNET_EVENT_CHANNEL } from '../shared/tailnet'
import { MESH_EVENT_CHANNEL } from '../shared/tailnet-mesh'
import { CANVAS_MODULE_DEFAULT_ENABLED } from '../shared/modules/manifest'
import { createTailnetNotifier } from './tailnet-notifications'
import { createInProcessShellBridge } from './shell-bridge'
import { createShellReveal } from './shell-reveal'
import { revealMainWindow } from './window-factory'
import { createAutomationTools } from './automation/automation-tools'
import { createTailnetTools, type TailnetToolsFrontDoor } from './automation/tailnet/tailnet-tools'
import { desktopGatewayTools } from './automation/desktop-gateway-tools'
import { createDesktopShellTools } from './desktop-shell-tools'
import { createAgentPermissionResolver } from './automation/launch-permission-cap'
import { liveGatewayLaunchTokens, onGatewayLaunchTokenChange } from '../server/core/gateway-launch-tokens'
import { shellTerminalToolsets } from '../server/desktop/shell-toolsets'
import { readStudioEnv } from '../shared/studio-env'
import type { McpToolContribution } from './module-host/main-host'
import { createDefaultMarketplaceRegistryClient } from './ipc/marketplace-registry-ipc'
import { toThirdPartyModuleView } from './ipc/third-party-module-ipc'
import { getGitRepoWatch } from './ipc/git-repo-watch-ipc'
import { resolveCheckoutForCwd } from './checkout-resolve'
import { createModuleRegistryMirror } from './modules/registry-mirror'
import { readModuleTrustContextSync } from './modules/trust-context'
import { defaultUserModuleRoot, discoverUserModules } from './modules/user-module-registry'
import type { ScheduledAgentsService } from './scheduled-agents/service'
import {
  createBuiltinSkillManager,
  ensureSkillInstalled,
  setDefaultSkillManager,
  setLaunchDeliversBundledSkillResolver,
  pruneRetiredBuiltinSkillCopies,
  BUILTIN_SKILLS_RESOURCE_DIR,
  findBuiltinSkill,
  findModuleSkill,
  resolveSkillById,
} from './builtin-skills'
import { SprintEngineAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from './workspace-roots'
import { createAgentSkillInstaller } from './agent-skill-installer'
import { createCapabilityWatcher } from './capability-watcher'
import { createMcpConfigService } from './mcp-config-service'
import { createSkillsService } from './skills'
import { createWorkspaceExtensionsReader } from './workspace-extensions'
import { sweepGitRepoCache } from './skills/git-repo-reader'
import {
  getBundledAgentStateReporterPath,
  getBundledAgentStateReporterTemplatePath,
  getBundledResourceDir,
  getBundledStatusLineForwarderPath,
  getBundledStudioPluginRoot,
} from './bundled-resources'
import { createGitTransportProbe } from './git-transport-probe'
import { sharedGhRunner } from './github/gh'
import { createGhHostTokenResolver } from './github/host-token'
import { SKILL_SOURCES_UPDATED_CHANNEL } from './skills/source-updates'
import {
  createAgentCapabilityService,
  createFsSkillDirectoryReader,
  createWorkspaceSkillsService,
} from './workspace-skills-service'
import type { HostAgentIntegration } from './hosts/execution-host'
import { hostRegistry } from './hosts/host-registry'
import { setCliModelDiscoveryRuntimesResolver } from './ipc/cli-model-discovery-ipc'
import {
  configureCliVersionService,
  launchSettingsCliMachines,
  scheduleCliVersionRead,
} from './cli-version-advisory-service'
import { createBackgroundModeStore } from './background-mode-store'
import { createQuitConfirmationStore } from './quit-confirmation-store'
import { createAgentNotificationsStore } from './agent-notifications-store'
import { agentBrowserToolGate, createAgentBrowserToolsStore } from './agent-browser-tools-store'
import { createAgentNotifier } from './agent-notifications'
import type { ChatLink } from '../shared/deep-link'
import { createKeepAwakeStore } from './keep-awake-store'
import { createAgentKeepAwake, terminalAgentWorking } from './agent-keep-awake'
import { countWorkingTerminalAgents, createQuitConfirmation } from './quit-confirmation'
import { askToQuitWhileWorking } from './quit-confirmation-electron'
import { conversationSummaryPhase, conversationTurnInProgress } from '../shared/conversation/phase'
import { createStudioAreaSkillStore } from './studio-area-skill-store'
import { createAnalyticsService } from './telemetry/analytics-service'
import { createTelemetryConsentStore } from './telemetry/consent-store'
import { readInstallId } from './telemetry/install-id'
import type { BackgroundStatus } from '../shared/background-mode'
import { isTelemetryEventName, type TelemetryProperties } from '../shared/telemetry'
import { resolveMemoryRoot } from './memory-graph'
import { getPluginManifest, listPluginRegistryEntries } from './plugin-registry-instance'
import { createMcpServerResolver } from './mcp-config-readers/resolve-servers'
import { syncStudioMcpConfig } from './studio-mcp-sync'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { excludeMcpConfigFromWorktree } from './git'
import { createWorktreeServices } from './worktree-services'
import { createConversationPeekService } from './conversation-peek/service'
import { chatHandoffStart, createConversationTerminalHandoff } from './conversation-terminal-handoff'
import { createAgentPromptStore, registeredAgentOwners } from './agent-prompt-store'
import {
  createTerminalRuntime,
  getTerminalSessionById,
  listLiveTerminalSessions,
  listTerminalRoots,
  notePullRequestRecordChanged,
  resolveSpawnEventSink,
} from './terminal-runtime'
import { isTerminalProcessAlive, setSessionPullRequestReader } from './terminal-session'
import { cliResumeCapabilities } from './cli-resume-capabilities'
import { createAgentChangelistFeed } from './agent-changelist-feed'
import { createTerminalPullRequests, type TerminalPullRequests } from './terminal-pull-requests'
import { createBrowserManager } from './browser/browser-manager'
import { setAfterWindowZoom } from './app-menu'
import { createBrowserControl } from './browser/browser-control'
import { createBrowserRecorder } from './browser/browser-recorder'
import { createHostRecordingEncoder } from './browser/recording-encoder'
import { createWorkspaceRecordingOutputs } from './browser/recording-output'
import { createBrowserTools } from './automation/browser-tools'
import { createCanvasTools } from './automation/canvas-tools'
import { createEditorTools } from './automation/editor-tools'
import { createAgentWrittenFiles } from './editor-reveal/agent-written-files'
import { createEditorRevealBroker } from './editor-reveal/editor-reveal-broker'
import { createEditorToolBackends } from './editor-reveal/editor-tool-backends'
import { EDITOR_REVEAL_PENDING_CHANNEL } from '../shared/editor-reveal'
import { createTourTools } from './automation/tour-tools'
import { createAppTourService } from './tours/tour-app'
import { canvasBoardStoreDir } from './canvas/canvas-board-store'
import { createCanvasService } from './canvas/canvas-service'
import { createNodeCanvasFs, watchCanvasDirectory } from './canvas/canvas-node-fs'
import { createCanvasSubscriberRegistry } from './canvas/canvas-subscribers'
import { createCanvasWorkerHost } from './canvas/canvas-worker-host'
import { createCanvasWorkerTransport, isCanvasWorkerWindow } from './canvas/canvas-worker-window'
import { broadcastToWorkspaceWindows, isBrowserHostWebContents, listWorkspaceWindows } from './window-factory'
import { createAgentControlPlane } from './agent-control-plane'
import { createAgentLaunchNotices } from './agent-launch-notices'
import { powerActivity } from './power-activity'
import { isSettledWorkspace } from '../shared/workspace-lifecycle'
import { forwardStatusLineRateLimits, usageLimitsStore, usageRateLimit } from './usage-limits/store'
import { createAgentLaunchService } from './agent-launch-service'
import { createLaunchedAgentRegistration, withLaunchedAgentRegistration } from './launched-agent-registration'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { SprintEngineUpdateService } from './update-service'
import { channelForVersion, createUpdateChannelStore } from './update-channel-store'
import { createUpdateInstallNoteStore } from './update-install-note'
import { sendSplashProgress, showUpdateProgressWindow } from './splash-window'
import { GitHubTokenStore } from './github-token-store'
import { installSharedCredentialStore } from './secret-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { writeDiagnosticLog } from './diagnostics-service'
import { getPluginById, getPluginRegistry } from './plugin-registry-instance'
import { declaredPermissionPresets } from './plugin-render'
import { createStudioPluginService } from './studio-plugin-service'
import { resolveInstalledSkillHarnesses } from './marketplace/skill-harness-targets'
import { buildLauncherMcpServer, usableLocalLauncherRef } from './integrations/launcher'
import {
  cleanRepositoriesAtBoot,
  prepareStudioIntegrations,
  wslLedgerMirrorPath,
} from './integrations/integration-boot'
import {
  holdLauncher,
  launcherHeldByOthers,
  leaveLiveInstances,
  otherInstanceRunning,
  registerLiveInstance,
  releaseLauncher,
} from './integrations/live-instances'
import { entriesRunLauncher, removeIntegrations, SESSION_INTEGRATION_KINDS } from './integrations/remove-integrations'
import { studioPlatform } from '../server/platform/platform'
import { createStudioCore, studioBridgeScriptPath } from '../server/core/studio-core'
import { installWorkspaceStoreMigration } from './workspace-store-migration'
import { createStudioGateway } from '../server/core/studio-gateway'
import { createStudioRpc } from '../server/core/studio-rpc'
import type { StudioRpcService } from './studio-rpc/studio-rpc-service'
import { createServerGatewayBackends, launchSettingsGatewayDeps } from '../server/desktop/gateway-backends'
import { SERVER_EVENTS, SERVER_METHODS, SHELL_METHODS } from '../server/desktop/server-methods'
import {
  createRemoteCore,
  createRemoteCredentialStore,
  createRemoteGitHubTokenStore,
  type ShellServerLink,
} from './server-supervisor/remote-core'
import { anyWindowFocused, broadcastToAllWindows } from './window-broadcast'

// How long the quit gives the session integrations' removal. What it does not
// reach stays listed, and the next quit takes it out.
const QUIT_INTEGRATION_REMOVAL_BUDGET_MS = 5_000
// How long the first launch of a run waits for the repository clean-up.
const BOOT_REPOSITORY_CLEANUP_BUDGET_MS = 4_000

// How long a quit waits for the server to say how many chats are working
// before it asks (or does not) on what the shell knows by itself.
const QUIT_COUNT_SERVER_BUDGET_MS = 1_000

// How long an agent launch waits for a server that is still starting before
// it goes ahead and lets the launch report what is missing.
const AGENT_LAUNCH_SERVER_WAIT_MS = 30_000
import {
  createIntegrationLedger,
  hostIdForPath,
  installIntegrationLedger,
  INTEGRATION_LEDGER_FILE,
} from './integrations/ledger'

// How long a cloned skill repository may go unread before the start-up sweep
// removes it (skills/git-repo-reader.ts `sweepGitRepoCache`).
const SKILL_REPO_CACHE_IDLE_MS = 60 * 24 * 60 * 60 * 1000

export function createAppServices(
  diagnosticsEnabled: boolean,
  /**
   * The Studio server in a process of its own (phase 6). Null in process, the
   * default: everything below is built here, as it always has been. With a
   * server, the shell builds no server-owned store and reaches the core
   * through the mirror and the control channel (server-supervisor/remote-core.ts).
   */
  server: ShellServerLink | null = null,
) {
  // What the server-bound services below take from Electron, installed by the
  // entry. Read through it where a service is being moved off Electron.
  const platform = studioPlatform()
  // A terminal's credential comes from the server that keeps it.
  if (server) installSharedCredentialStore(createRemoteCredentialStore(server.rpc))
  const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
    enabled: diagnosticsEnabled,
  })
  // What the server's code asks of the shell that is not an agent tool: the
  // keychain, OS notifications and where a click on one goes, the analytics
  // sink, the integrations gate, and terminal launches for the internal
  // service tokens. In process it calls the shell's services directly; the
  // same object is what the shell serves a server in a process of its own.
  // Its late-bound members (the launch, the gate) resolve at call time.
  // The chat-link router opens a chat a clicked banner names; it is built with
  // the app's lifecycle, after these services (setChatLinkOpener).
  let chatLinkOpener: ((link: ChatLink) => void) | null = null
  const shellBridge = createInProcessShellBridge({
    safeStorage,
    launchAgent: () => (request) => agentLaunchService.launch(request),
    reveal: createShellReveal({
      windows: () => BrowserWindow.getAllWindows(),
      // Never the hidden canvas worker: with the pane closed and an agent
      // drawing it can be the only window open.
      isCanvasWorker: isCanvasWorkerWindow,
      revealMainWindow,
      openChat: () => chatLinkOpener,
    }),
    notifier: platform.notifier,
    // Only the events this app sends at all; the record drops any property
    // value that is not a plain string, number or boolean.
    analytics: (event) => {
      if (isTelemetryEventName(event.name)) analytics.record(event.name, event.properties as TelemetryProperties)
    },
    integrationsReady: () => agentIntegrationReady,
  })
  // Learn the default WSL distribution's name once, in the background, so a WSL
  // launch built later can name it with `-d` (Windows only; a no-op elsewhere).
  primeDefaultWslDistro()
  const sprintengineAuth = new SprintEngineAuthBridge()
  const mcpConfigService = createMcpConfigService()
  // Every file, entry and piece of machine state the app writes outside
  // userData is recorded here as it is written (integrations/ledger.ts), so it
  // can all be taken back out. Installed before anything that writes.
  const integrationLedgerStore = createIntegrationLedger({
    path: join(app.getPath('userData'), INTEGRATION_LEDGER_FILE),
    // A distribution's entries are mirrored into it while its helper is up.
    mirrorPathFor: (hostId) => {
      const host = hostRegistry().get(hostId)
      const home = host.kind === 'wsl' ? host.agentIntegration()?.home.native : null
      return home ? wslLedgerMirrorPath(home) : null
    },
    onError: (error) => {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Integration ledger not written',
        message: error instanceof Error ? error.message : String(error),
        source: 'workspace',
      })
    },
  })
  installIntegrationLedger(integrationLedgerStore)
  const resolveStudioMcpBridgeScriptPath = () => studioBridgeScriptPath(platform.paths)
  const workspaceSkillsService = createWorkspaceSkillsService()
  // The watcher is built first because the capability answer has to state
  // whether it can be kept true: a workspace whose paths could not be watched
  // is stale-but-correct, and the surface says so from `diagnostics`.
  const capabilityWatcher = createCapabilityWatcher({
    listPlugins: () => listPluginRegistryEntries(),
    lookupManifest: (pluginId) => getPluginManifest(pluginId),
    onWorkspaceFocus: (listener) => {
      app.on('browser-window-focus', listener)
      return () => app.off('browser-window-focus', listener)
    },
  })
  const agentCapabilityService = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins: () => listPluginRegistryEntries(),
    lookupManifest: (pluginId) => getPluginManifest(pluginId),
    mcpResolver: createMcpServerResolver(),
    freshness: capabilityWatcher,
  })
  const agentSkillInstaller = createAgentSkillInstaller({
    listPlugins: () => listPluginRegistryEntries(),
    invalidate: (workspaceRoot, harnessId) => capabilityWatcher.invalidate(workspaceRoot, harnessId),
  })

  // Declared before terminalRuntime so the runtime can ensure-install a skill
  // at spawn. Reads loaded CLI plugins to compute native targets.
  const builtinSkillManager = createBuiltinSkillManager({
    listPlugins: () => getPluginRegistry().loaded(),
  })
  // The process-wide `ensureSkillInstalled` — the one the launch boundary,
  // the Backlog action and `MainHost.ensureSkillInstalled` all call — must use
  // THIS manager, the only one that knows the installed CLI plugins and can
  // therefore compute the `all-native` fan-out.
  setDefaultSkillManager(builtinSkillManager)

  // Authoritative agent state: owns the reporter socket + per-workspace install.
  // Declared before the agent-state service because that service's
  // `resolveLaunchInjectsPlugins` closes over it: the launch flag and the
  // workspace installer must read one value, never two that can disagree.
  let agentIntegrationPluginDirs: string[] = []
  // The one-skill plugins in that copy, by skill id (`launchSkillPluginDir`).
  let agentIntegrationSkillPluginDirs: Record<string, string> = {}
  // The status-line forwarder inside that copy. Separate from the directories
  // because a status line is not a plugin component — no plugin can declare
  // one — so it travels in the launch's `--settings` document instead.
  let agentIntegrationStatusLinePath = ''
  // THE question every workspace writer asks before touching the repository on
  // behalf of an agent launch: will this CLI's launch carry the app's own plugin
  // directories? One closure, so the launch flag (terminal-launch's
  // `pluginDirsForLaunch` asks the same three things), the agent-state
  // installer, the skill installer and the MCP sync can never disagree — a
  // disagreement is either a doubled registration or a session with none.
  //
  // Asked with the launch's machine. A WSL distribution carries the copy its
  // helper wrote inside it, once the helper is up; the launch builder reads the
  // same host (`pluginDirsForLaunch`), so the two agree there too. A launch
  // passes the `integration` it captured when it prepared that machine, so a
  // helper restarting in between cannot make this answer differ from what the
  // launch itself carries; absent, the machine is asked as it stands now.
  const launchCarriesAppPlugins = (
    cli: string,
    hostId?: string | null,
    integration?: HostAgentIntegration | null,
  ): boolean => {
    const host = hostRegistry().get(hostId)
    if (host.kind === 'wsl') {
      const current = integration === undefined ? host.agentIntegration() : integration
      return cliTakesLaunchPlugins(cli) && (current?.pluginDirs.length ?? 0) > 0
    }
    return launchCarriesAppPluginsFor(cli, agentIntegrationPluginDirs)
  }
  // The app's MCP gateway as a stdio server on the machine a CLI runs on: this
  // app's own binary run as Node here, and inside a WSL distribution the
  // pinned Node and the bridge the helper installed, which finds the helper's
  // socket through the discovery file in the helper's directory. Null (no
  // gateway written) for a WSL machine whose helper is not up. `integration`
  // as for `launchCarriesAppPlugins`.
  const studioGatewayFor = (
    hostId?: string | null,
    integration?: HostAgentIntegration | null,
  ): { command: string; args: string[]; env: Record<string, string>; envVarNames?: string[] } | null => {
    const host = hostRegistry().get(hostId)
    if (host.kind === 'wsl') {
      return (integration === undefined ? host.agentIntegration() : integration)?.studioMcpEntry ?? null
    }
    // Through the Studio launcher, so the entry this writes into a repository
    // keeps working when the app moves or updates, and serves an empty MCP
    // server rather than failing to start once the app is gone.
    const launcher = usableLocalLauncherRef(homedir())
    if (!launcher) {
      // The launcher could not be written this run: name this build directly,
      // which works for as long as it stays installed.
      return {
        command: process.execPath,
        args: [resolveStudioMcpBridgeScriptPath()],
        env: { ELECTRON_RUN_AS_NODE: '1', SPRINTENGINE_USER_DATA_DIR: app.getPath('userData') },
      }
    }
    return {
      ...buildLauncherMcpServer(launcher),
      env: { SPRINTENGINE_USER_DATA_DIR: app.getPath('userData') },
    }
  }
  // The agent-state hook a launch hands Codex on its command line: the
  // launcher, which needs no Node on PATH, else the reporter inside this
  // build's plugin copy. Null when neither is there, which leaves the launch
  // on the workspace registration.
  const launchAgentStateHookCommand = (): string | null => {
    const socketPath = agentStateService.getSocketPath()
    const launcher = usableLocalLauncherRef(homedir())
    if (launcher) return buildLauncherHookCommand(launcher, 'agent-state', socketPath)
    const home = agentIntegrationPluginDirs[0] ? dirname(agentIntegrationPluginDirs[0]) : null
    const reporter = home ? join(home, LAUNCH_REPORTER_REL) : null
    return reporter && existsSync(reporter) ? buildAgentStateReporterCommand(reporter, socketPath) : null
  }
  // A bundled skill arrives as a plugin of its own, in that same copy, on the
  // launch whose prompt invokes it — when the copy on the launch's machine
  // holds it. The launch builder reads the same map (`pluginDirsForLaunch`).
  setLaunchDeliversBundledSkillResolver((cli, skillId, hostId, integration) => {
    if (!launchCarriesAppPlugins(cli, hostId, integration)) return false
    const host = hostRegistry().get(hostId)
    const available =
      host.kind === 'wsl'
        ? ((integration === undefined ? host.agentIntegration() : integration)?.skillPluginDirs ?? {})
        : agentIntegrationSkillPluginDirs
    return Object.hasOwn(available, skillId)
  })
  const listAgentStateSpecs = () =>
    getPluginRegistry()
      .loaded()
      .flatMap((plugin) => (plugin.manifest.agentStateSpec ? [plugin.manifest.agentStateSpec] : []))

  // Created before terminalRuntime so the runtime can install the reporter at
  // launch; `onFrame` resolves to terminalRuntime (declared just below) at
  // frame time, well after construction.
  const agentStateService = createAgentStateService({
    resolveUserDataDir: () => app.getPath('userData'),
    resolveAgentStateSpec: (cli) =>
      getPluginRegistry()
        .loaded()
        .find((plugin) => plugin.manifest.id === cli)?.manifest.agentStateSpec ?? null,
    resolveReporterScriptPath: getBundledAgentStateReporterPath,
    resolveStatusLineScriptPath: getBundledStatusLineForwarderPath,
    // A CLI that takes the app's plugin directories at launch gets this same
    // reporter for the session, so nothing is written into the workspace. Both
    // halves must hold: a manifest that declares the flag, and a materialised
    // copy to point it at — until the copy exists (or if this build shipped
    // none) the workspace install remains the way agent state works at all.
    resolveLaunchInjectsPlugins: launchCarriesAppPlugins,
    // Read when a launch-injected CLI tidies what an earlier build wrote into
    // the workspace: the shared reporter script stays while another CLI's
    // registration there still runs it.
    listAgentStateSpecs,
    resolveReporterTemplatePath: getBundledAgentStateReporterTemplatePath,
    onFrame: (frame) => terminalRuntime.ingestAgentStateFrame(frame),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Which of the built-in plugin's area skills agents get: none until the
  // person opts in, from a surface's suggestion or from Settings, and then in
  // every workspace (shared/studio-area-skills.ts). Read by every plugin copy
  // (this machine's launch home, each WSL distribution's) and the workspace
  // installer; a change re-runs them.
  const studioAreaSkillStore = createStudioAreaSkillStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // WSL machines: each distribution's helper relays its agents' hook frames,
  // their MCP connections and PATH changes back here (hosts/wsl-helper-*.ts).
  // Configured on every platform because it costs nothing; only Windows ever
  // starts a helper.
  configureWslHelpers({
    appVersion: platform.identity.version(),
    userDataDir: app.getPath('userData'),
    resources: () => {
      const helperDir = getBundledResourceDir('wsl-helper')
      const hooksDir = getBundledResourceDir('hooks')
      const automationDir = getBundledResourceDir('automation')
      return helperDir && hooksDir && automationDir ? { helperDir, hooksDir, automationDir } : null
    },
    pluginSources: () => ({
      templateRoot: getBundledStudioPluginRoot(),
      reporterSourcePath: getBundledAgentStateReporterPath(),
      statusLineSourcePath: getBundledStatusLineForwarderPath(),
      enabledSkillDirs: studioAreaSkillStore.enabledSkillDirs(),
      launchSkillsSourceRoot: getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR),
    }),
    automationSocketPath: () => resolveAutomationSocketPath(app.getPath('userData')),
    ingestAgentStateLine: (line) => agentStateService.ingestLine(line),
    onPathsChanged: (distro) => invalidateCliAvailabilityOnHost(wslHostId(distro)),
    // Chromium's network stack, so the one-time Node.js download honours the
    // system proxy the way the rest of the app's requests do.
    fetch: (url, init) => net.fetch(url, init),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', title: 'WSL helper', message, source: 'terminal' })
    },
  })

  // Boot jobs that nothing on screen needs — the git probe and the rest — wait
  // for the main window to reveal, so they do not compete with the renderer's
  // first load. The lifecycle opens the gate on reveal; an agent launch opens
  // it early.
  let openBootJobsGate: () => void = () => undefined
  const bootJobsGate = new Promise<void>((resolve) => {
    openBootJobsGate = resolve
  })
  // The workspace sync — the launcher, the plugin home and the pass over every
  // known workspace — runs while the loading screen is up instead (owner,
  // 2026-09-28: it "should happen when the user opens the application"). The
  // lifecycle opens this gate as the plate goes up and waits a bounded time for
  // the pass (`prepareWorkspacesAtBoot`); the reveal, and an agent launch, open
  // it too, so nothing depends on the lifecycle having asked.
  let openWorkspaceSyncGate: () => void = () => undefined
  const workspaceSyncGate = new Promise<void>((resolve) => {
    openWorkspaceSyncGate = resolve
  })
  const startDeferredBootJobs = (): void => {
    openWorkspaceSyncGate()
    openBootJobsGate()
  }

  const agentIntegrationHomeOptions = (): EnsureAgentIntegrationHomeOptions => ({
    templateRoot: getBundledStudioPluginRoot(),
    reporterSourcePath: getBundledAgentStateReporterPath(),
    // The forwarder the launch names in its `--settings` status line: it is
    // how the app reads context usage, cost and lines changed for a session.
    statusLineSourcePath: getBundledStatusLineForwarderPath(),
    userDataDir: app.getPath('userData'),
    tokens: {
      nodeCommand: process.execPath,
      bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
      userDataDir: app.getPath('userData'),
      agentStateSocketPath: agentStateService.getSocketPath(),
    },
    enabledSkillDirs: studioAreaSkillStore.enabledSkillDirs(),
    launchSkillsSourceRoot: getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR),
    // Native Windows runs the copy's hooks through the launcher, which the
    // launch waits for before materialising (`launcherWritten` below).
    hookLauncher: process.platform === 'win32' ? usableLocalLauncherRef(homedir()) : null,
  })

  // The app's own plugin, materialised ONCE for this build under the profile's
  // userData directory and handed to every launch that can take it
  // (`--plugin-dir`) rather than written into the person's repository. Empty
  // until the copy lands; every agent launch waits for it to settle (see
  // `whenAgentLaunchReady`), and a build whose copy failed falls back to the
  // workspace installer instead of losing agent state.
  // Opens once the launcher pass (`prepareStudioIntegrations`) has finished.
  let repositoryCleanupGate: Promise<void> = Promise.resolve()
  const agentIntegrationReady = (async () => {
    await workspaceSyncGate
    // The Studio launcher every hook and gateway entry runs, pointed at this
    // build — before any launch, because a launch writes commands that name
    // it. Then, in the background, the one-time list of what earlier builds
    // wrote and every listed entry moved onto the launcher.
    let launcherReady: () => void = () => undefined
    const launcherWritten = new Promise<void>((resolve) => {
      launcherReady = resolve
    })
    let integrationsPrepared: () => void = () => undefined
    repositoryCleanupGate = new Promise<void>((resolve) => {
      integrationsPrepared = resolve
    })
    // Listed as running before anything is written, so another instance's
    // quit leaves what this one is about to use (integrations/live-instances.ts).
    await registerLiveInstance(homedir()).catch(() => undefined)
    void prepareStudioIntegrations({
      onLauncherReady: () => launcherReady(),
      ledger: integrationLedgerStore,
      home: homedir(),
      shell: process.platform === 'win32' ? 'windows' : 'posix',
      pointer: {
        node: process.execPath,
        runAsNode: true,
        payload: app.isPackaged
          ? process.resourcesPath
          : dirname(getBundledResourceDir('hooks') ?? join(app.getAppPath(), 'resources', 'hooks')),
        packaged: app.isPackaged,
      },
      // This machine's checkouts only: reading a `\\wsl.localhost` folder
      // would boot a stopped distribution just to look.
      listRoots: () =>
        workspaceRegistry
          .getState()
          .workspaces.flatMap((workspace) =>
            workspace.folderPath &&
            !isMachinePath(workspace.folderPath) &&
            hostIdForPath(workspace.folderPath) === 'local'
              ? [{ path: workspace.folderPath, hostId: 'local' }]
              : [],
          ),
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', title: 'Integrations', message, source: 'workspace' })
      },
    })
      .finally(() => integrationsPrepared())
      .catch((error: unknown) => {
        void writeDiagnosticLog({
          level: 'warning',
          title: 'Studio integrations not prepared',
          message:
            'The launcher, or the pass over what earlier builds wrote, failed. A hook naming a missing launcher fails until it is written; the pass is tried again next start.',
          details: error instanceof Error ? error.message : String(error),
          source: 'workspace',
        })
      })
    await launcherWritten
    const home = await ensureAgentIntegrationHome(agentIntegrationHomeOptions())
    if (!home.ok) {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Agent plugin directory unavailable',
        message: 'Agents fall back to the per-workspace install for skills and agent state.',
        details: home.message,
        source: 'workspace',
      })
      return
    }
    agentIntegrationPluginDirs = home.home.pluginDirs
    agentIntegrationSkillPluginDirs = home.home.skillPluginDirs
    agentIntegrationStatusLinePath = join(home.home.root, LAUNCH_STATUS_LINE_REL)
    // Old versions are only safe to delete here: a CLI reads a plugin directory
    // as it starts, and every agent this app launches dies with the app, so no
    // live session is reading a sibling version at startup.
    await pruneAgentIntegrationHomes(app.getPath('userData'), home.home.version)
  })()
  // The files the last run's launches named (`--mcp-config`, Cursor's launch
  // plugin, OpenCode's agent-state plugin): no session that read them outlived
  // that run. Before the first launch of this one, which waits on the copy.
  const launchFilesPruned = pruneLaunchFiles(join(app.getPath('userData'), LAUNCH_FILES_DIR)).catch(() => undefined)
  // What earlier builds wrote into repositories for what a launch now carries
  // itself, taken out once the launcher pass is done and before the first
  // launch, which waits on it for at most the budget (cleanRepositoriesAtBoot).
  // Skipped while another Studio runs: its sessions may still read those files.
  //
  // Launches wait for all of it, so nothing it removes is a file a launch just
  // wrote; both waits are bounded, and a pass that has not begun in time is
  // left to the quit.
  const repositoryCleanup = (async () => {
    await agentIntegrationReady
    let gateTimer: ReturnType<typeof setTimeout> | undefined
    const prepared = await Promise.race([
      repositoryCleanupGate.then(() => true),
      new Promise<boolean>((resolve) => {
        gateTimer = setTimeout(() => resolve(false), BOOT_REPOSITORY_CLEANUP_BUDGET_MS)
      }),
    ])
    if (gateTimer) clearTimeout(gateTimer)
    if (!prepared) return
    const home = homedir()
    if (await otherInstanceRunning(home).catch(() => true)) return
    const report = await cleanRepositoriesAtBoot({
      ledger: integrationLedgerStore,
      listRoots: () =>
        workspaceRegistry
          .getState()
          .workspaces.flatMap((workspace) =>
            workspace.folderPath &&
            !isMachinePath(workspace.folderPath) &&
            hostIdForPath(workspace.folderPath) === 'local'
              ? [{ path: workspace.folderPath, hostId: 'local' }]
              : [],
          ),
      migrateKnowledgeActivity: async (repo) => {
        await knowledgeActivityLaunchCommand(repo)
      },
      deadline: Date.now() + BOOT_REPOSITORY_CLEANUP_BUDGET_MS - 250,
      stop: () => otherInstanceRunning(home),
    })
    if (report.removed > 0 || report.failed > 0) {
      void writeDiagnosticLog({
        level: report.failed > 0 ? 'warning' : 'info',
        title: 'Repositories tidied',
        message: `${report.removed} of Studio's files and entries an earlier build left in repositories were removed${report.failed > 0 ? `; ${report.failed} could not be, and are tried again at quit` : ''}.`,
        details: report.outcomes
          .filter((outcome) => outcome.status !== 'skipped')
          .map((outcome) => `${outcome.status}\t${outcome.label}\t${outcome.path}\t${outcome.reason ?? ''}`)
          .join('\n'),
        source: 'workspace',
      })
    }
  })().catch(() => undefined)
  setLaunchPluginDirsResolver(() => agentIntegrationPluginDirs)
  setLaunchSkillPluginDirsResolver(() => agentIntegrationSkillPluginDirs)
  setLaunchStatusLineScriptResolver(() => agentIntegrationStatusLinePath)

  // The app's own plugin, installed into every workspace it opens. Declared
  // here because it needs the same bridge path the managed MCP sync uses, and
  // the same reporter the agent-state service installs — one resolver each,
  // never a second spelling of either.
  const studioPluginService = createStudioPluginService({
    resolveTemplateRoot: getBundledStudioPluginRoot,
    resolveAgentStateReporterPath: getBundledAgentStateReporterPath,
    resolveBridgeScriptPath: resolveStudioMcpBridgeScriptPath,
    resolveNodeCommand: () => process.execPath,
    resolveUserDataDir: () => app.getPath('userData'),
    resolveAgentStateSocketPath: () => agentStateService.getSocketPath(),
    listHarnesses: () => resolveInstalledSkillHarnesses(),
    // Read at install time, not at wiring time, and only once the copy has
    // settled: a workspace opened during startup is then never installed the
    // old way seconds before the launch starts carrying the same pieces, while
    // a build whose copy FAILED still gets the workspace install, which is what
    // keeps agent state working rather than losing it.
    resolveLaunchPluginsActive: () => appLaunchPluginsActive(agentIntegrationPluginDirs),
    whenLaunchPluginsSettled: () => agentIntegrationReady,
    resolveEnabledSkillDirs: () => studioAreaSkillStore.enabledSkillDirs(),
    pruneRetiredSkillCopies: pruneRetiredBuiltinSkillCopies,
    listAgentStateSpecs,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // The core this process serves from: launch settings and machines, the
  // workspace registry, the conversation runtime and the backend chats are
  // driven through, the launch service. The same composition a standalone
  // server builds under plain Node (src/server/core/studio-core.ts); built here
  // because a chat's agent is handed this app's gateway and the launch
  // cap reads this app's terminals.
  // SSH machines (phase 8), a preview off by default: with it off, none of
  // this exists. Main holds their sessions, because their prompts are dialogs
  // and the pane's forward is a session proxy.
  // Read lazily: the registry is the core's, built just below.
  const workspaceRegistryOf = (): {
    getRecord(id: string): { environment?: WorkspaceEnvironmentRef | null } | null | undefined
  } => core.workspaceRegistry
  const ssh: DesktopSsh | null = sessionSshPreview()
    ? createDesktopSsh({
        version: platform.identity.version(),
        server,
        workspaceEnvironment: (workspaceId: string): WorkspaceEnvironmentRef | null =>
          workspaceRegistryOf().getRecord(workspaceId)?.environment ?? null,
      })
    : null

  // This process reads and writes project stores too (the backlog, the
  // browser's captures, module storage), so it moves an older build's
  // in-project state the first time it meets a folder that still has some,
  // even when the core, which also moves every registered project at start,
  // runs in a server process of its own (main/workspace-store.ts).
  installWorkspaceStoreMigration({ log: (message) => console.info(`[workspace-store] ${message}`) })
  const core = server
    ? createRemoteCore(server)
    : createStudioCore(platform, {
        role: 'desktop',
        // A chat's agent is handed the gateway itself, on the machine its CLI
        // runs on: a Claude chat's child loads no project settings, so the
        // gateway pinned into a workspace's `.mcp.json` never reached it, and a
        // Codex or ACP chat would otherwise have only what a terminal launch left
        // pinned in the folder, with no identity.
        resolveStudioMcpServer: async ({ hostId }) => {
          await whenAgentLaunchReady()
          const gateway = studioGatewayFor(hostId ?? null)
          if (!gateway) return null
          return {
            id: STUDIO_MCP_SERVER_ID,
            name: STUDIO_MCP_SERVER_NAME,
            transport: 'stdio',
            command: gateway.command,
            args: gateway.args,
            env: gateway.env,
            ...(gateway.envVarNames?.length ? { envVarNames: gateway.envVarNames } : {}),
          }
        },
        // The live session objects, not `listTerminals()` snapshots: only a
        // few fields are read, and a snapshot of every session is not cheap.
        listTerminalSessions: () =>
          listLiveTerminalSessions().map((session) => ({
            kind: session.kind,
            workspaceId: session.workspaceId,
            agentId: session.agentId,
            processAlive: isTerminalProcessAlive(session),
            activity: session.activity,
            agentRecord: session.agentRecord,
          })),
        // A distribution turned on or off adds or drops its CLI updates.
        onHostSettingsChanged: () => scheduleCliVersionRead(),
        ...(ssh
          ? {
              sshServers: {
                servers: ssh.environments.routed,
                onConnected: (listener: Parameters<typeof ssh.environments.onConnected>[0]) =>
                  ssh.environments.onConnected(listener),
                // The host and port every device keys the machine's mark by,
                // as Settings › Machines does (`sshMachineRef`): what its SSH
                // config resolves to, else what was typed.
                machineOf: (savedId: string) => {
                  const machine = ssh.environments.list().find((entry) => entry.id === savedId)
                  if (!machine) return null
                  return machine.resolved
                    ? { host: machine.resolved.hostname, port: machine.resolved.port }
                    : { host: machine.destination }
                },
              },
            }
          : {}),
        // A distribution whose chats run on a Studio server inside it (phase
        // 7, off unless the person turns it on in Settings › Machines).
        wslServers: ({ readHostSettings }) =>
          createDesktopWslServers({
            readHostSettings,
            userDataDir: app.getPath('userData'),
            app: {
              version: platform.identity.version(),
              channel: channelForVersion(app.getVersion()) === 'nightly' ? 'nightly' : 'latest',
            },
            packaged: app.isPackaged,
            resourcesDir: app.isPackaged ? process.resourcesPath : null,
            appRoot: app.getAppPath(),
            isDefaultProfile: app.isPackaged && !readStudioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim(),
            fetch: (url, init) => net.fetch(url, init),
            log: (message) => {
              void writeDiagnosticLog({ level: 'info', title: 'WSL server', message, source: 'workspace' })
            },
          }),
      })
  const {
    agentLaunchSettings,
    hosts,
    workspaceRegistry,
    workspaceSyncService,
    conversationOwner,
    conversations,
    conversationModelCatalog,
    conversationLaunchService,
    resolveAgentPermissionPreset,
  } = core

  // Renderer-pushed "keep running in the background" setting. Read
  // synchronously inside `window-all-closed`, which is precisely when no
  // renderer is left to ask.
  const backgroundModeStore = createBackgroundModeStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // "Ask before quitting while agents are working": main's own, since the
  // quit dialog's "Don't ask again" writes it with no renderer involved.
  const quitConfirmationStore = createQuitConfirmationStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // A banner when a chat finishes or waits on the person while they are in
  // another app (agent-notifications.ts). Main owns the setting: the banners
  // are raised here, with no renderer to ask.
  const agentNotificationsStore = createAgentNotificationsStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const agentNotifier = createAgentNotifier({
    mode: () => agentNotificationsStore.mode(),
    isAnyWindowFocused: () =>
      BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && !isCanvasWorkerWindow(window) && window.isFocused(),
      ),
    chatLabel: (workspaceId, agentId) => {
      const workspace = workspaceSyncService
        .getSnapshot()
        .state.workspaces.find((candidate) => candidate.id === workspaceId)
      // Only a chat the sidebar lists: a module's background host is found
      // through its own door, and a banner would open somewhere the rail
      // cannot take the person back from.
      if (!workspace || (workspace.mode && workspace.mode !== 'standard')) return null
      const agents = Object.values(workspace.agents ?? {})
      const agentName = agents.length > 1 ? workspace.agents?.[agentId]?.name : undefined
      return { title: workspace.name || 'Chat', ...(agentName ? { agentName } : {}) }
    },
    show: (notice) => shellBridge.notify(notice),
  })

  // "Keep the computer awake while agents work": main's own, since main takes
  // and releases the blocker as agents start and stop. The lifecycle feeds it
  // the agents' phases and lets it go at quit.
  const keepAwakeStore = createKeepAwakeStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const agentKeepAwake = createAgentKeepAwake({
    // Read through at each call: the blocker is only touched once an agent works.
    blocker: {
      start: (type) => powerSaveBlocker.start(type),
      stop: (id) => powerSaveBlocker.stop(id),
    },
    isEnabled: () => keepAwakeStore.isEnabled(),
    // The live word on each agent: a terminal agent by its pty and hook state,
    // a chat run here by its session. A chat on an out-of-process server is
    // not known here, and is held only by its own events (and the stale cap).
    liveWorking: () => {
      const terminals = terminalRuntime.ipcHandlers.listTerminals().filter((session) => session.kind === 'agent')
      const listed = server ? null : conversations.listSessions()
      const chats = listed?.ok ? listed.sessions : []
      return (workspaceId, agentId) => {
        const terminal = terminals.find(
          (session) => session.agentId === agentId && (session.workspaceId ?? null) === workspaceId,
        )
        if (terminal) return terminalAgentWorking(terminal)
        const chat = chats.find((session) => session.agentId === agentId && session.workspaceId === workspaceId)
        if (!chat) return undefined
        return conversationSummaryPhase(chat) === 'running'
      }
    },
  })

  // Renderer-pushed "Share anonymous usage data" setting, and the one service
  // that acts on it. Built here, beside the other userData mirrors and before
  // anything that records, because `app.boot` is emitted below and the launch
  // paths further down take `analytics` as a dependency.
  //
  // Silent unless a PostHog project key is configured — see
  // `src/shared/telemetry.ts`, which is also where the collection boundary is
  // written down. From-source builds ship no key, so this is inert in dev.
  const telemetryConsentStore = createTelemetryConsentStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const analytics = createAnalyticsService({
    resolveUserDataDir: () => app.getPath('userData'),
    isConsented: () => telemetryConsentStore.isEnabled(),
    appVersion: app.getVersion(),
    // A dev build reports itself as such rather than being filtered out here,
    // so "is anyone using the shipped app" stays answerable without guessing
    // which version strings were builds from someone's laptop.
    packaged: app.isPackaged,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  // The install/active-machine counter. `firstRun` is true only on the boot
  // that minted the install id, which is what separates new installs from
  // returning ones without a second event.
  //
  // Guarded on `isActive` rather than left to `record`'s own no-op: reading the
  // id is what MINTS it, and an unkeyed or opted-out build has no business
  // writing an identity file it will never use.
  if (analytics.isActive()) {
    analytics.record('app.boot', {
      firstRun: readInstallId({ resolveUserDataDir: () => app.getPath('userData') }).created,
    })
  }

  // A model-discovery pass main starts itself (boot, after an install) probes
  // with the same per-CLI command overrides a launch would use.
  setCliModelDiscoveryRuntimesResolver(() => agentLaunchSettings.get().cliRuntimes)
  // The version check asks about the same machines, with the same commands,
  // that Settings ▸ Agents lists: this one and each WSL distribution turned on.
  configureCliVersionService({ machines: launchSettingsCliMachines(() => agentLaunchSettings.get()) })
  // It compares again whenever detection learns something new about a machine
  // — startup, Re-check, a WSL list opened for the first time — and when the
  // machines change (below), so a badge follows without the hourly wait.
  subscribeKnownCliAvailability(() => scheduleCliVersionRead())

  // One warning per distinct message per run: the same MCP config is synced
  // on every WSL launch, and the same sentence each time is noise.
  const mcpWslWarningsSeen = new Set<string>()

  // The Scheduled agents module registers on the module kernel AFTER app
  // services are constructed; index.ts injects the resolver once the kernel is
  // up. Declared here because the scheduled-agent tools resolve it lazily, at
  // call time. Until the module is up, they report it as unavailable rather
  // than buffering.
  let resolveScheduledAgents: () => ScheduledAgentsService | null = () => null
  // Live main-process module enablement, injected by index.ts once the manifest
  // universe exists; it recomputes on every override the renderer pushes, so a
  // module the user just switched off is off here on the next call. Until then
  // nothing is enabled: a gateway tool that cannot learn its module's state must
  // report the capability as off rather than act on its behalf.
  let resolveModuleEnabled: (moduleId: string) => boolean = () => false
  // Module-contributed MCP tools on the Studio gateway, injected by
  // index.ts from the host kernel after loadMainModules. The gateway is
  // constructed before modules load, so until the seam is wired the registry
  // reads empty — and because the tool set is evaluated per request, module
  // tools appear on the very next call once modules are up.
  let resolveModuleMcpTools: () => ReadonlyArray<McpToolContribution> = () => []
  // The renderer's module registry, mirrored here. Empty until a
  // window pushes one; consumers report "not yet known" rather than "no
  // modules", the same rule the enablement mirror follows.
  const moduleRegistryMirror = createModuleRegistryMirror(
    server ? { onWrite: (snapshot) => server.rpc.emit(SERVER_EVENTS.moduleRegistrySnapshot, snapshot) } : {},
  )
  // The marketplace index reader the `marketplace.list` tool answers from —
  // same client, same on-disk cache, same bundled-first policy as the
  // Extensions storefront's IPC.
  const marketplaceRegistryReader = createDefaultMarketplaceRegistryClient()

  // Agent changelists: an agent's own list, holding exactly the lines it wrote.
  // The feed owns every rule about WHICH checkout a claim belongs to and what it
  // refuses to claim (see agent-changelist-feed.ts); this only hands it the
  // user-data dir it writes under and the way to tell the windows to re-read.
  // Shared by the feed and by the changelist IPC handlers (register-core-ipc):
  // a list moved by an agent and a list renamed by a person reach the other
  // windows the same way.
  const broadcastGitChangelistsChanged = (repoRoot: string): void => {
    // Same shape and same spelling the preload subscribes to
    // (`onGitChangelistsChanged`); the renderer re-reads for a matching root.
    broadcastToAllWindows('git:changelists-changed', { repoRoot })
  }
  const agentChangelistFeed = createAgentChangelistFeed({
    userDataDir: app.getPath('userData'),
    broadcast: broadcastGitChangelistsChanged,
  })
  // What each agent wrote, for the editor reveal: a file outside the workspace
  // that the asking agent wrote itself may be shown without asking the person.
  const agentWrittenFiles = createAgentWrittenFiles()

  // The conversation peek's durable history: each agent's captured prompts,
  // kept beside the agent's record in userData so they outlive the session,
  // the app and the sidecar sweep. The registry (created below, and only asked
  // once prompts are being written) says which agents still exist, so eviction
  // never takes the history of one still in the sidebar.
  const agentPrompts = createAgentPromptStore({
    resolveUserDataDir: () => app.getPath('userData'),
    agentExists: ({ workspaceId, agentId }) => {
      const record = workspaceRegistry.getRecord(workspaceId)
      if (record) return Object.hasOwn(record.agents, agentId)
      // A workspace the registry has never heard of is gone only once the
      // registry is authoritative; before hydration nothing is known.
      return workspaceRegistry.needsHydration() ? undefined : false
    },
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
    },
  })

  const terminalRuntime = createTerminalRuntime({
    diagnosticsEnabled,
    logMainPerfEvent,
    isAppFocused: () => anyWindowFocused(),
    // The runtime asks where an agent is at every turn end and session start.
    // That is also the moment its checkout's working tree most likely moved,
    // which git's own files do not show until something is staged: tell the
    // git view scheduler, so the sidebar re-reads that checkout now rather
    // than at the next fallback sweep.
    resolveObservedCheckout: async (cwd) => {
      const facts = await resolveCheckoutForCwd(cwd)
      if (facts?.gitRoot) getGitRepoWatch().noteActivity(facts.gitRoot)
      return facts
    },
    // The three agent-changelist seams. Fire-and-forget by contract: the feed
    // swallows its own failures, so none of them can cost a session anything.
    onAgentLaunched: (session) => agentChangelistFeed.onAgentLaunched(session),
    onAgentFileEdit: (input) => {
      // Under the workspace the process reports itself in, which is where the
      // editor tools look: an agent moved to another chat still names that one.
      const { launchWorkspaceId, workspaceId, agentId } = input.session
      agentWrittenFiles.note(launchWorkspaceId ?? workspaceId, agentId, input.path)
      agentChangelistFeed.onAgentFileEdit(input)
    },
    onAgentSessionExit: (session) => agentChangelistFeed.onAgentSessionExit(session),
    // Where an agent is, each time git answers, and the tool calls that may
    // have opened a pull request: the Studio server reads both
    // (terminal-pull-requests.ts, below).
    onObservedCheckoutResolved: (session, resolution) =>
      terminalPullRequests?.noteCheckoutResolved(session, resolution),
    onAgentToolCall: (session, toolCall) => terminalPullRequests?.noteToolCall(session, toolCall),
    // Durable freeze-the-view: suspended agent terminals persist their painted
    // screen to disk and reopen painted-and-paused after an app restart.
    snapshotSidecars: createTerminalSnapshotSidecarStore({
      resolveUserDataDir: () => app.getPath('userData'),
      logDiagnostic: (diagnostic) => {
        void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
      },
    }),
    agentPrompts,
    // Reaper decision trail (actions + rate-limited skips) into the daily
    // diagnostics JSONL — the in-memory reap ring buffer dies with the process.
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
    },
    // The CLI's own per-launch channels, where it has them: what this returns
    // is handed to that session alone, and the workspace writers below stand
    // down for it (integrations/launch-integration.ts).
    prepareLaunchIntegration: async (input) => {
      await whenAgentLaunchReady()
      return prepareLaunchIntegration(input, {
        spec: (cli) => getPluginById(cli)?.manifest.launchIntegration ?? null,
        isThisMachine: (hostId) => hostRegistry().get(hostId).kind !== 'wsl',
        carriesAppPlugins: launchCarriesAppPlugins,
        launchFilesDir: () => join(app.getPath('userData'), LAUNCH_FILES_DIR),
        gateway: (hostId) => studioGatewayFor(hostId),
        agentStateSpec: (cli) => getPluginById(cli)?.manifest.agentStateSpec ?? null,
        agentStateHookCommand: () => launchAgentStateHookCommand(),
        agentStateTemplatePath: getBundledAgentStateReporterTemplatePath,
        socketPath: () => agentStateService.getSocketPath(),
        bundledSkillPluginDir: (skillId) =>
          Object.hasOwn(agentIntegrationSkillPluginDirs, skillId) ? agentIntegrationSkillPluginDirs[skillId]! : null,
        skillSourceDir: (skillId) => {
          const moduleSkill = findModuleSkill(skillId)
          if (moduleSkill) return moduleSkill.sourceDir
          const root = getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR)
          return findBuiltinSkill(skillId) && root ? join(root, skillId) : null
        },
        skill: (skillId) => resolveSkillById(skillId),
        homeDir: () => homedir(),
        knowledgeActivityCommand: (workspaceRoot) => knowledgeActivityLaunchCommand(workspaceRoot),
        gitTracks: (path) => gitTracksPath(dirname(path), basename(path)),
        warn: (message) => {
          void writeDiagnosticLog({ level: 'warning', title: 'Launch integration', message, source: 'terminal' })
        },
      })
    },
    syncMcpConfig: ({ integration, ...input }) =>
      whenAgentLaunchReady().then(() =>
        syncStudioMcpConfig(
          {
            ...input,
            // A launch that carries the app's plugin directory gets the gateway
            // from that plugin's own `.mcp.json`; pinning it into the repository
            // as well would be a second copy of the server, and one a plain
            // terminal's `claude` in that checkout would load too.
            studioGatewayDeliveredAtLaunch:
              input.clients.length === 1 && launchCarriesAppPlugins(input.clients[0], input.hostId, integration),
          },
          {
            mcpConfigService,
            studioGateway: () => studioGatewayFor(input.hostId, integration),
            // Once per server per run: the same config is synced on every
            // WSL launch, and the same sentence each time is noise.
            warn: (message) => {
              if (mcpWslWarningsSeen.has(message)) return
              mcpWslWarningsSeen.add(message)
              void writeDiagnosticLog({
                level: 'warning',
                title: 'MCP server may not start in WSL',
                message,
                source: 'terminal',
              })
            },
          },
        ),
      ),
    // Skill-at-spawn: make the skill the launch's prompt invokes present in the
    // session CLI's native skill dir before launch. Check-first so already-installed workspaces skip
    // the rewrite; install only fills missing or stale native targets. A CLI
    // whose launch carries the skill in the app's plugin directory gets no copy.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId, cli, launch) => {
      const result = await ensureSkillInstalled(workspaceRoot, skillId, {
        cli,
        ...(launch ? { hostId: launch.hostId, integration: launch.integration } : {}),
      })
      if (result.ok) return
      // An id nothing answers to used to be a silent no-op, so a renamed skill
      // or a module that failed to load produced an agent invoking a skill
      // that was never copied — with nothing anywhere saying so.
      const level = result.status === 'unknown-skill' ? 'warn' : 'log'
      console[level](
        `[skills] could not ensure skill "${skillId}" in ${workspaceRoot}: ${result.status}${result.message ? ` — ${result.message}` : ''}`,
      )
      void writeDiagnosticLog({
        source: 'terminal',
        level: result.status === 'unknown-skill' ? 'warning' : 'info',
        title: `Skill "${skillId}" was not installed`,
        message: result.message ?? `The skill installer answered "${result.status}".`,
        details: `status=${result.status} workspaceRoot=${workspaceRoot}`,
        extensionsRow: 'skills',
      })
    },
    // Connector launch: keep the generated managed MCP config out of the
    // connector chat's worktree git (`.mcp.json` / `.codex/config.toml`).
    excludeWorktreeMcpConfig: (worktreePath) => excludeMcpConfigFromWorktree(worktreePath),
    resolveWorkspaceHostId: (workspaceId) => {
      const hostId = workspaceSyncService
        .getSnapshot()
        .state.workspaces.find((workspace) => workspace.id === workspaceId)?.hostId
      return typeof hostId === 'string' ? hostId : null
    },
    prepareAgentStateHook: async (workspaceRoot, cli, execution) => {
      // A workspace's Studio skills, before the CLI reads its skill folder: the
      // boot pass reaches the known workspaces one at a time, and the last quit
      // took every copy back out. Settled, this costs nothing. A workspace
      // folder only — never an agent worktree, which the pass never writes to.
      const [root] = uniqueResolvedRoots([workspaceRoot])
      if (root && listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()).includes(root)) {
        await studioPluginService.ensureInstalled(root)
      }
      return agentStateService.installForWorkspace(workspaceRoot, cli, execution)
    },
  })
  // The pull request record is the Studio server's (owner ruling 2026-10-03):
  // the terminal agents' marks are read from it over the protocol, by
  // `terminalPullRequests`, built below once the shell's connection to the
  // server exists. Bound late; until it is, a session wears no marks.
  let terminalPullRequests: TerminalPullRequests | null = null
  // The snapshot's `pullRequests` field is filled from here, and nowhere else.
  setSessionPullRequestReader((session) => terminalPullRequests?.listForSession(session) ?? [])

  // The one interaction path to a live agent session. Every caller
  // that drives an agent — the review guide, later the composer and MCP —
  // goes through this instead of writing to a pty itself, so
  // concurrent prompts serialize per session and submit determinism lives in
  // one place. It holds no window reference, so it works headless.
  const agentControlPlane = createAgentControlPlane({
    terminal: {
      list: () => terminalRuntime.ipcHandlers.listTerminals(),
      write: (sessionId, data) => terminalRuntime.ipcHandlers.writeTerminal(sessionId, data),
      read: (sessionId) => terminalRuntime.readTerminalOutput(sessionId),
      readSince: (sessionId, cursor) => terminalRuntime.readTerminalOutputSince(sessionId, cursor),
    },
    conversation: {
      // The runtime's list result carries the shared ok/message envelope but
      // never fails; the empty arm is the type's other branch, not a swallowed
      // error — a target that matches nothing fails loudly at the plane.
      list: () => {
        const result = conversations.listSessions()
        return result.ok ? result.sessions : []
      },
      sendTurn: async ({ sessionId, message, origin }) => {
        const result = await conversations.sendTurn({ sessionId, message, ...(origin ? { origin } : {}) })
        return result.ok
          ? { ok: true }
          : { ok: false, message: result.message, ...(result.code ? { code: result.code } : {}) }
      },
      interrupt: async ({ sessionId }) => {
        const result = await conversations.interrupt({ sessionId })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
    },
  })
  // An agent that launched another hears when that one finishes or stops,
  // through the plane above, instead of polling agent.status. The chat half
  // reads this process's chats; out of process they are the server's, and a
  // chat there is not linked (`link` says so and the caller polls). A notice
  // waits out a usage limit on the parent's provider, as this process's store
  // reads it: its own chats' readings and its terminals' status lines.
  const agentLaunchNotices = createAgentLaunchNotices({
    plane: agentControlPlane,
    readChatReply: (sessionId) => {
      const listed = conversations.listSessions()
      return listed.ok
        ? listed.sessions.find((session) => session.sessionId === sessionId)?.lastAssistantTail
        : undefined
    },
    usageLimit: (provider) => usageRateLimit(provider),
    onUsageLimitsChanged: (listener) => {
      usageLimitsStore().onChanged(listener)
    },
    isSettled: (workspaceId) => {
      const record = workspaceRegistry.getRecord(workspaceId)
      return record ? isSettledWorkspace(record) : false
    },
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Launch notices', message })
    },
  })
  // A hold's timer stood still while the computer slept; waking reads the clock again.
  powerActivity.onResume(() => agentLaunchNotices.wake())
  powerActivity.onScreenLockChange((locked) => {
    if (!locked) agentLaunchNotices.wake()
  })
  terminalRuntime.registerAgentPhaseListener((event) => agentLaunchNotices.onAgentPhase(event))
  terminalRuntime.registerAgentSessionExitListener((event) => agentLaunchNotices.onAgentSessionExit(event))
  // A pty that exits mid-turn reports no phase; its exit is the agent stopping.
  terminalRuntime.registerAgentSessionExitListener((event) => agentKeepAwake.onAgentExit(event))
  conversations.onEvent((event) => agentLaunchNotices.onConversationEvent(event))
  // A chat parent is told when its turn has let go of it, not on the turn's
  // end event, which comes while the turn still holds the chat.
  conversationOwner.onSessionIdle((summary) => agentLaunchNotices.onChatIdle(summary))
  // The saved update channel is main's: the updater is configured here, before
  // any renderer exists to ask.
  const updateChannelStore = createUpdateChannelStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'update' })
    },
  })
  const updateService = new SprintEngineUpdateService({
    writeDiagnosticLog,
    channelStore: updateChannelStore,
    // The note an update leaves for the build that starts after it.
    installNotes: createUpdateInstallNoteStore({ resolveUserDataDir: () => app.getPath('userData') }),
    // "Restart to update" shows its progress on the launch plate.
    progressWindow: {
      show: (progress) => showUpdateProgressWindow(channelForVersion(app.getVersion()), progress),
      update: (progress) => sendSplashProgress(progress),
    },
  })
  const agentConfigImportService = createAgentConfigImportService({
    mcpConfigService,
    builtinSkillManager,
  })
  // The token is the server's out of process; the shell's skills, cards and
  // marketplace ask it for one.
  const githubTokenStore = server
    ? (createRemoteGitHubTokenStore(server.rpc) as GitHubTokenStore)
    : new GitHubTokenStore()

  // The terminal runtime exposes only generic agent-session seams
  // (spawn/kill/inventory + a session-exit listener); capability modules layer
  // their own system-specific behavior on top. sprintengineAuth and
  // terminalRuntime are seeded into the kernel so those modules can build on
  // them via the service bridge.

  // The backups are the server's out of process (its own copy writes them).
  const workspaceBackupService = server
    ? null
    : createWorkspaceBackupService({
        resolveUserDataDir: () => app.getPath('userData'),
        // Read at write time, from the core's registry.
        readRegistry: () => workspaceRegistry.getState(),
        // At most one registry serialization every ten seconds; the newest request
        // inside the interval is written when it ends.
        minRegistryIntervalMs: 10_000,
      })
  // An agent removed from the registry (its row deleted, or its workspace
  // removed) takes its stored prompts with it: they are a person's verbatim
  // typing, and nothing can show them any more.
  let registeredAgents = registeredAgentOwners(workspaceRegistry.getState())
  workspaceRegistry.subscribe((state) => {
    const next = registeredAgentOwners(state)
    for (const [key, owner] of registeredAgents) {
      if (!next.has(key)) void agentPrompts.remove(owner)
    }
    registeredAgents = next
  })

  // Composing an agent launch is main's job. Built here, after the
  // terminal runtime and workspace sync, because it reads both: the workspace it
  // launches into comes from the sync snapshot, and the launch itself is the
  // runtime's own spawn handler. Its defaults come from the main-owned launch
  // settings store, so a launch with zero windows open still uses the user's
  // real CLI, permission preset, and MCP servers.
  const composedAgentLaunchService = createAgentLaunchService({
    listWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
    getLaunchSettings: () => agentLaunchSettings.get(),
    // Hooks-only selectability (decision of record 2026-08-31): a KNOWN plugin
    // whose manifest declares no agentStateSpec is refused as an agent. An id
    // the registry does not hold falls through — the launch render's own
    // unknown-plugin error names the real problem, and refusing it here would
    // misattribute a typo to missing hook support.
    isAgentSelectableCli: (cli) => {
      const plugin = getPluginRegistry()
        .loaded()
        .find((candidate) => candidate.manifest.id === cli)
      return plugin ? Boolean(plugin.manifest.agentStateSpec) : true
    },
    permissionPresetsForCli: (cli) => {
      const plugin = getPluginRegistry()
        .loaded()
        .find((candidate) => candidate.manifest.id === cli)
      return plugin ? declaredPermissionPresets(plugin.manifest) : null
    },
    cliResumesSessions: (cli) => cliResumeCapabilities(cli).resumeSession,
    // The same resolver the renderer reaches over `memory:resolve-root`, so a
    // headless launch carries the project's Knowledge Graph exactly like an
    // interactively-spawned agent does.
    resolveKnowledgeRoot: (input) => resolveMemoryRoot(input.workspaceRoot, input.relativeRoot),
    terminal: {
      list: () => terminalRuntime.ipcHandlers.listTerminals(),
      // A headless launch has no window to be the event sink; the runtime
      // resolves one (or its no-op headless sender) itself.
      spawn: (payload) => terminalRuntime.ipcHandlers.spawnTerminal(resolveSpawnEventSink(), payload),
      kill: (sessionId) => terminalRuntime.ipcHandlers.killTerminal(sessionId),
    },
  })

  // The launched agent is registered in the workspace registry here, in main,
  // at launch — not left for a window to project from the session list. Every
  // launch main composes (a paired machine over the tailnet, the MCP tools,
  // backlog work, automations, a module's agent sessions) comes through this
  // door, and the registry broadcast is what tells every window and every
  // paired device. An agent a window creates itself is in the registry already.
  const launchedAgentRegistration = createLaunchedAgentRegistration({
    registry: workspaceRegistry,
    workspaceSync: workspaceSyncService,
    // The live session objects, not `listTerminals()` snapshots: this runs on
    // every session-list beat and reads a handful of fields.
    listLaunchedSessions: () =>
      listLiveTerminalSessions()
        .filter((session) => session.agentRecord !== undefined)
        .map((session) => ({
          sessionId: session.sessionId,
          kind: session.kind,
          processAlive: isTerminalProcessAlive(session),
          workspaceId: session.workspaceId,
          agentRecord: session.agentRecord,
          worktreeId: session.worktreeId,
          cliSessionId: session.cliSessionId,
        })),
    hasSession: (sessionId) => {
      const session = getTerminalSessionById(sessionId)
      return session !== null && !session.isDisposed
    },
  })
  const registeredAgentLaunchService = withLaunchedAgentRegistration(
    composedAgentLaunchService,
    launchedAgentRegistration,
  )

  // Telemetry rides on the OUTSIDE of the composed service rather than inside
  // it. `createAgentLaunchService` is a pure composer with its own tests; a
  // measurement is not part of what it composes, and every caller — agent.launch,
  // backlog.work, terminal.create, automation spawns — comes through this one
  // door anyway, so wrapping here covers them all without touching that module.
  //
  // Only the resolved CLI and a handful of shape flags go out. The request's
  // prompt, name, worktree path and cwd do not: they are the user's words and
  // the user's disk (see the boundary in shared/telemetry.ts).
  const agentLaunchService: typeof composedAgentLaunchService = {
    ...registeredAgentLaunchService,
    async launch(request) {
      const result = await registeredAgentLaunchService.launch(request)
      if (result.ok) {
        analytics.record('agent.launched', {
          cli: result.cli,
          worktree: request.worktreePath !== undefined,
          connector: request.connectorId !== undefined,
          withPrompt: Boolean(request.prompt),
          ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
        })
      }
      return result
    },
  }

  // Resume in terminal: a chat's CLI session handed to a terminal agent,
  // through the same launch door as every other agent.
  // Resume in terminal is served by the server out of process, which asks the
  // shell for the terminal through the bridge.
  const conversationTerminalHandoff = server
    ? null
    : createConversationTerminalHandoff({
        runtime: conversations,
        launch: (request) => agentLaunchService.launch(request),
        cliResumesSessions: (cli) => cliResumeCapabilities(cli).resumeSession,
        permissionPresetsForCli: (cli) => {
          const plugin = getPluginRegistry()
            .loaded()
            .find((candidate) => candidate.manifest.id === cli)
          return plugin ? declaredPermissionPresets(plugin.manifest) : null
        },
        chatName: (workspaceId, agentId) =>
          workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
            ?.agents?.[agentId]?.name,
        chatStart: (workspaceId, agentId) =>
          chatHandoffStart(
            workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId),
            agentId,
            agentLaunchSettings.get(),
          ),
      })

  // Built after workspace sync because adopting the retired skill packs needs to
  // know which projects are open — that is where a previously installed pack's
  // directory would be.
  // Repositories are read over git, not the GitHub API (git-transport ruling,
  // owner 2026-09-08): the API's anonymous limit is what capped a Sync at
  // twenty linked repositories, and git's protocol is not counted by it. The
  // probe runs after the app is ready — not in this constructor, which runs at
  // module load, and not synchronously: on a Mac without the command line
  // tools `git --version` raises Apple's install dialog, which must never be
  // the first thing a person sees. A machine without a usable git keeps the
  // API reader and its cap, and the door says to install git rather than to
  // add a token; the deps are getters, so the service sees the probe's answer
  // the moment it lands and again if git turns up later.
  const skillRepoCacheDir = join(app.getPath('userData'), 'skill-repos')
  const gitTransport = createGitTransportProbe({
    cacheDir: skillRepoCacheDir,
    resolveToken: () => githubTokenStore.resolveToken(),
    // A source on a company's self-hosted GitHub reads with the GitHub CLI's
    // sign-in for that host; the stored token above only ever goes to github.com.
    resolveHostToken: createGhHostTokenResolver(sharedGhRunner()),
  })
  void Promise.all([app.whenReady(), bootJobsGate]).then(async () => {
    await gitTransport.refresh()
    // Objects fetched into a promisor clone are never repacked away, so a
    // repository that keeps moving grows its clone for as long as it is read.
    // A clone nobody has read in sixty days is not worth the disk, and the
    // reader rebuilds it from the network on the next read (review,
    // 2026-09-09).
    await sweepGitRepoCache(skillRepoCacheDir, SKILL_REPO_CACHE_IDLE_MS).catch(() => undefined)
  })
  const skillsService = createSkillsService(app.getPath('userData'), {
    resolveToken: () => githubTokenStore.resolveToken(),
    get repoReader() {
      return gitTransport.reader
    },
    get repoTransport() {
      return gitTransport.reader ? ('git' as const) : ('api' as const)
    },
    get gitInstalled() {
      return gitTransport.installed
    },
    refreshTransport: () => gitTransport.refresh(),
    // The same bundled tree the plugin installer materialises, read here as the
    // offline seed of our marketplace tab (studio-marketplace ruling,
    // 2026-09-06). One resolver, so a build that ships the plugin can never
    // fail to seed the catalogue that lists it.
    studioMarketplaceSeedRoot: getBundledStudioPluginRoot,
    broadcastSourceUpdates: (check) => broadcastToAllWindows(SKILL_SOURCES_UPDATED_CHANNEL, check),
  })
  // The `tailnet.*` tools configure the service that (transitively) owns them,
  // so the tool set cannot capture it at construction. Assigned immediately
  // below; until then those tools answer that they are not wired up yet.
  let tailnetToolsFrontDoor: TailnetToolsFrontDoor | null = null
  // OS notifications for pairing and reachability (pair-from-the-scan-and-
  // stay-paired, phase 3): only while no window is focused, only the events a
  // person is waiting on, never the code. A click brings the app forward and
  // opens the Remote popover in the first workspace window.
  // The server notifies for its own tailnet out of process.
  const tailnetNotifier = server
    ? null
    : createTailnetNotifier({
        isAnyWindowFocused: () =>
          BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
        isEnabled: () => automationService?.getTailnetStatus().notifications ?? false,
        openRemote: () => void shellBridge.reveal.tab({ kind: 'remote' }),
        // A later phase of the same request replaces the banner rather than
        // stacking "waiting" under "paired": the notice's key says which. A click
        // opens the Remote popover, which the bridge's reveal does.
        show: (notice) => shellBridge.notify({ ...notice, activate: { kind: 'remote' } }),
      })
  // The embedded browser's main half (browser-pane epic): adopts the guests the
  // pane's browser tabs attach, drives them, and finds the dev servers this
  // workspace's terminals are running. The control layer is the agents' hands
  // on those same tabs, exposed as the gateway's browser.* tools below.
  const browserManager = createBrowserManager({
    listTerminalRoots,
    // A pane popped out of its window hosts its browser tabs there.
    isHostWindow: isBrowserHostWebContents,
    broadcast: broadcastToWorkspaceWindows,
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    ...(ssh ? { machinePartitions: ssh.panes } : {}),
  })
  const browserControl = createBrowserControl(browserManager)
  browserManager.onUnregister((tabId) => browserControl.forget(tabId))
  setAfterWindowZoom((contents) => browserManager.reapplyGuestZoom(contents))
  // Recording a tab to video for the agents' `browser.record_*` tools: the
  // window hosting the tab captures and encodes it, and the file goes into the
  // calling agent's workspace (docs/design/browser-recording.md).
  const browserRecorder = createBrowserRecorder({
    encoder: createHostRecordingEncoder({ ipcMain, tabs: browserManager }),
    outputs: createWorkspaceRecordingOutputs({
      // The project's own folder: for a chat in a worktree (every New chat
      // leases one from the pool), the checkout it was cut from, so the video
      // outlives the worktree and never holds a pool slot on disk.
      resolveWorkspaceRoot: (workspaceId) => {
        const record = workspaceSyncService
          .getSnapshot()
          .state.workspaces.find((workspace) => workspace.id === workspaceId)
        return record ? workspaceProjectRootOf(record) : null
      },
      machineLabel: (id) => ssh?.environments.list().find((machine) => machine.id === id)?.label ?? null,
    }),
    publish: (tabId, recording) => browserManager.setRecording(tabId, recording),
    describeTab: (tabId) => {
      try {
        return new URL(browserManager.state(tabId)?.url ?? '').host
      } catch {
        return ''
      }
    },
    log: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Browser recording', message })
    },
  })
  browserManager.onUnregister((tabId) => browserRecorder.tabClosed(tabId))

  // The Canvas pane's main half. It owns the `.excalidraw` files under a
  // workspace root — the SAME root the browser sidecar and the backlog resolve
  // against — and it is the only writer of them: the tab commits through it and
  // the `canvas.*` tools call it directly, so a board has one merge and one
  // revision however it was edited. The hidden worker window behind it is built
  // lazily on the first call that needs a DOM and disposed when it goes idle.
  // The editor reveal's main half (editor.* tools): asks the windows to open a
  // file or diff, and keeps what no window could show for when one does.
  const editorRevealBroker = createEditorRevealBroker({
    targets: () =>
      listWorkspaceWindows().map((window) => ({
        id: window,
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        send: (channel: string, payload: unknown) => window.webContents.send(channel, payload),
      })),
    broadcastPending: (workspaceIds) => broadcastToWorkspaceWindows(EDITOR_REVEAL_PENDING_CHANNEL, { workspaceIds }),
  })

  // Where live work sits, for the pool and the agent worktree cleanup alike:
  // every live terminal, the checkout it observes, and the folder of every chat
  // whose provider session is working now. One list, so neither recycles a
  // folder the other would have kept.
  const liveWorkPaths = async (): Promise<string[]> => [
    ...listLiveTerminalSessions().flatMap((session) =>
      [session.cwd, session.observedCheckout?.cwd, session.observedCheckout?.gitRoot].filter(
        (path): path is string => typeof path === 'string' && path.length > 0,
      ),
    ),
    ...(await conversations.liveConversationWorkspaceRoots().catch(() => [])),
  ]
  const { worktreePool, dependencyInstaller, worktreeTools } = createWorktreeServices({
    userDataPath: app.getPath('userData'),
    liveWorkPaths,
    workspaceSyncService,
  })

  const canvasSubscribers = createCanvasSubscriberRegistry()
  const canvasService = createCanvasService({
    fs: createNodeCanvasFs(),
    now: () => Date.now(),
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    resolveBoardStore: (_workspaceId, workspaceRoot) => canvasBoardStoreDir(app.getPath('userData'), workspaceRoot),
    broadcast: broadcastToWorkspaceWindows,
    sendTo: canvasSubscribers.sendTo,
    watch: watchCanvasDirectory,
    worker: createCanvasWorkerHost({
      transport: createCanvasWorkerTransport({
        ipcMain,
        log: (message, details) => {
          void writeDiagnosticLog({
            level: 'warning',
            source: 'workspace',
            title: 'Canvas',
            message,
            ...(details ? { details: JSON.stringify(details) } : {}),
          })
        },
      }),
    }),
    log: (message, details) => {
      void writeDiagnosticLog({
        level: 'info',
        source: 'workspace',
        title: 'Canvas',
        message,
        ...(details ? { details: JSON.stringify(details) } : {}),
      })
    },
  })
  // Diff tours (tour.* tools, the Diff viewer's tour mode). One owner for
  // every tour: the gateway writes them, the viewer plays them, and an owner's
  // question is typed into the author's terminal from here.
  const tours = createAppTourService({
    userDataDir: app.getPath('userData'),
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    listTerminals: () => terminalRuntime.ipcHandlers.listTerminals(),
    writeTerminal: (sessionId, data) => terminalRuntime.ipcHandlers.writeTerminal(sessionId, data),
    launchAgent: async (request) => {
      const launched = await agentLaunchService.launch(request)
      return launched.ok ? { ok: true, agentId: launched.agentId } : { ok: false, message: launched.message }
    },
    broadcastToWorkspaceWindows,
    broadcastToViewers: (channel, payload) => broadcastToAllWindows(channel, payload, { skipCanvasWorker: true }),
    isAppFocused: () => anyWindowFocused(),
  })
  const tourService = tours.service
  terminalRuntime.registerAgentPhaseListener((event) => tourService.onAgentPhase(event))

  /**
   * Whether the Canvas module is on.
   *
   * `canvas` is a renderer-only module: main's enablement gate resolves the
   * manifests of modules with a MAIN half, and a module whose whole substance
   * is a pane tab is not in that list — it would answer false for a module the
   * person can see switched on. The renderer's mirrored registry is the one
   * place main can read the user's actual switch, and until a window has pushed
   * one the module's own `defaultEnabled` stands: refusing every canvas tool
   * for the first seconds of a run would read as a broken capability, not a
   * disabled one.
   *
   * A snapshot that ARRIVED but carries no `canvas` entry means the same thing
   * as no snapshot at all — the window's registry has not listed it yet — so it
   * falls to the same default. Reading it as "off" put the answer through a
   * resolver that has no canvas manifest to resolve and therefore always says
   * false, which turned a module the person can see switched on into every
   * canvas tool refusing.
   */
  const isCanvasEnabled = (): boolean => {
    const snapshot = moduleRegistryMirror.read()
    const entry = snapshot?.modules.find((module) => module.id === 'canvas')
    if (entry) return entry.enabled
    return CANVAS_MODULE_DEFAULT_ENABLED
  }

  // The browser and canvas tools, as main runs them. The shell offers both to
  // the gateway as client toolsets, the way any app offers its tools;
  // `SPRINTENGINE_CLIENT_TOOLS=0` keeps them registered in process, as before,
  // for one release. The canvas service stays on this disk's files while the
  // server runs in this process: they are the server's files too.
  const clientToolsEnabled = readStudioEnv('SPRINTENGINE_CLIENT_TOOLS') !== '0'
  // "Let agents use the built-in browser" (Settings → Agents). Offered as a
  // client toolset, the tools are withdrawn and offered again as it changes;
  // served in process (the env switch above), each list leaves them out while
  // it is off. Either way the switch is read when it is needed, never kept.
  const agentBrowserToolsStore = createAgentBrowserToolsStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const browserToolsOffered = () => agentBrowserToolsStore.isEnabled()
  const browserToolGate = agentBrowserToolGate(browserToolsOffered)
  const browserTools = createBrowserTools({
    manager: browserManager,
    control: browserControl,
    recorder: browserRecorder,
    hasWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
  })
  const canvasTools = createCanvasTools({
    service: canvasService,
    hasWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
    isCanvasEnabled,
  })
  // The editor and tour tools act on what a window shows. In process they are
  // the gateway's own; out of process the shell offers them as its `editor`
  // and `tour` toolsets (phase 6, 6.3).
  const editorTools = createEditorTools(
    createEditorToolBackends({
      findWorkspace: (workspaceId) =>
        workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
      listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
      agentWrittenFiles,
      broker: editorRevealBroker,
      userDataDir: () => app.getPath('userData'),
      isAppFocused: () => anyWindowFocused(),
    }),
  )
  const tourTools = createTourTools({
    service: tourService,
    hasWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
  })

  // Instance-global SprintEngine Studio MCP surface: reads come from the
  // workspace-sync snapshot and terminal runtime, and mutations go straight to
  // the main services that own them — one lane, no window required.
  // The gateway starts with the app.
  // Out of process the gateway, the tailnet and the mesh are the server's.
  const automationService = server
    ? null
    : createStudioGateway(core, {
        // The live-state push (remote-sessions-ux): every window hears listener,
        // pairing, and connection changes the moment main does — the fix for pair
        // requests that could expire while only Settings, if open, would show them.
        onTailnetEvent: (payload) => {
          broadcastToAllWindows(TAILNET_EVENT_CHANNEL, payload)
          tailnetNotifier?.onTailnetEvent(payload)
        },
        onMeshEvent: (event) => {
          broadcastToAllWindows(MESH_EVENT_CHANNEL, event)
          tailnetNotifier?.onMeshEvent(event)
        },
        // A window someone could be looking at: the mesh's reachability timer and
        // its re-checks of an absent machine only feed rows on screen.
        hasWindow: () =>
          BrowserWindow.getAllWindows().some(
            (window) =>
              !window.isDestroyed() && !isCanvasWorkerWindow(window) && window.isVisible() && !window.isMinimized(),
          ),
        // Module-contributed tools, read from the host kernel per request and
        // gated on their owner's live enablement.
        resolveModuleTools: () => resolveModuleMcpTools(),
        isModuleEnabled: (moduleId) => resolveModuleEnabled(moduleId),
        // The core's own tools (`conversation.create`) among this app's window,
        // terminal and run tools, in the order agents have always listed them
        // (`desktopGatewayTools`).
        // This server's shell offers these, and an agent's first list waits for them.
        // Not the browser when it is switched off: the first list would wait
        // out the boot window for a toolset that is never coming.
        expectShellToolsets: clientToolsEnabled ? browserToolGate.expectedToolsets(['browser', 'canvas']) : [],
        ...(clientToolsEnabled ? {} : { hideTool: browserToolGate.hidesTool }),
        // An agent that starts a chat hears back from it, as one that launches
        // a terminal agent does.
        linkLaunchedAgent: (link) => agentLaunchNotices.link(link),
        appTools: desktopGatewayTools({
          browser: clientToolsEnabled ? [] : browserTools,
          canvas: clientToolsEnabled ? [] : canvasTools,
          editor: editorTools,
          tour: tourTools,
          automation: createAutomationTools(
            createServerGatewayBackends({
              getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
              listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
              readTerminalOutputTail: (sessionId, options) =>
                terminalRuntime.readTerminalOutputTail(sessionId, options),
              launchAgent: (request) => agentLaunchService.launch(request),
              linkLaunchedAgent: (link) => agentLaunchNotices.link(link),
              resolveAgentPermissionPreset,
              createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
              getScheduledAgents: () => resolveScheduledAgents(),
              ...launchSettingsGatewayDeps(agentLaunchSettings),
              // module.*/marketplace.*. The registry snapshot is the
              // renderer's mirror — main's own module list omits every renderer-only
              // module, so reporting from it would be wrong by construction. Trust
              // and launch readiness stay main-owned (signature verification and the
              // trust store live here), and the marketplace read goes through the
              // same client the Extensions storefront's IPC uses, cache included.
              getModuleRegistrySnapshot: () => moduleRegistryMirror.read(),
              listInstalledThirdPartyModules: async () => {
                const { modules, rejected } = await discoverUserModules(
                  defaultUserModuleRoot(),
                  readModuleTrustContextSync(app.getPath('userData')),
                )
                return { modules: modules.map((module) => toThirdPartyModuleView(module)), rejected }
              },
              listModuleContributedTools: () =>
                resolveModuleMcpTools().map((tool) => ({ moduleId: tool.moduleId, toolName: tool.registration.name })),
              readMarketplaceRegistry: (input) => marketplaceRegistryReader.read(input),
              // What a paired machine's composer offers a chat here.
              readWorkspaceExtensions: createWorkspaceExtensionsReader({
                listWorkspaceSkills: (input) => workspaceSkillsService.listWorkspaceSkills(input),
                agentCapabilities: (input) => agentCapabilityService.resolve(input),
                listSources: () => skillsService.listSources(),
              }),
            }),
          ),
          // Remote-control configuration, local socket only: the listener refuses
          // this whole family regardless of a device's scopes (tailnet-scopes.ts).
          worktree: worktreeTools,
          tailnet: createTailnetTools({ resolveTailnet: () => tailnetToolsFrontDoor }),
        }),
      })
  tailnetToolsFrontDoor = automationService
  // A chat agent in WSL reaches its own server's gateway: the desktop's
  // toolsets, and this side's own tools of the families the WSL server cannot
  // serve, are offered there too, and run here (phase 7).
  const wslServersOfCore = 'wslServers' in core ? core.wslServers : null
  // An SSH machine's agents get the pane's browser, whose tabs reach that
  // machine's network, and the canvas (phase 8).
  if (automationService && ssh)
    relayShellToolsets({
      onConnected: (listener) =>
        ssh.environments.onConnected((connection) =>
          listener({
            key: connection.key,
            name: connection.label,
            backend: connection.backend,
            open: (purpose: 'studio') => connection.open(purpose),
            toolsets: SSH_RELAYED_TOOLSETS,
            args: (_toolset, args) => args,
          }),
        ),
      registry: automationService.clientTools,
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', title: 'SSH machine', message, source: 'workspace' })
      },
    })
  if (automationService && wslServersOfCore)
    relayShellToolsets({
      onConnected: (listener) => wslServersOfCore.onConnected(listener),
      registry: automationService.clientTools,
      gatewayTools: () => automationService.ownTools(),
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', title: 'WSL server', message, source: 'workspace' })
      },
    })
  // The Studio RPC: the protocol applications on this machine follow, drive
  // and start chats with, on an owner-only socket in userData/run, composed
  // over the core and its gateway as a standalone server composes it. Its
  // paths, version and the push to Settings are the platform's. Nothing in the
  // app uses it yet; paired apps are listed and revoked in Settings.
  const studioRpc = automationService ? createStudioRpc(core, automationService) : null
  // Where the person's attention is, for routing a call to the window in
  // front of them when more than one desktop offers a toolset.
  const desktopFocus = {
    current: () => ({
      focused: anyWindowFocused({ skipCanvasWorker: true }),
      // A desktop shows every workspace it holds, each a tab away.
      workspaceIds: workspaceSyncService
        .getSnapshot()
        .state.workspaces.map((workspace) => workspace.id)
        .slice(0, 64),
    }),
    onChange: (listener: () => void) => {
      app.on('browser-window-focus', listener)
      app.on('browser-window-blur', listener)
      const unsubscribe = workspaceSyncService.subscribeEvents(listener)
      return () => {
        app.off('browser-window-focus', listener)
        app.off('browser-window-blur', listener)
        unsubscribe()
      }
    },
  }
  const logDesktopTools = (message: string) => {
    void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Desktop tools', message })
  }
  // The shell, a client of its own server: in process over a port main holds
  // both ends of, out of process over one it brokers to the server. It offers
  // what only a screen or a terminal can serve.
  const desktopShell = studioRpc
    ? createDesktopShellTools({
        transport: studioRpc.shellTransport(),
        version: app.getVersion(),
        toolsets: clientToolsEnabled
          ? [
              { name: 'browser', registrations: browserTools, enabled: browserToolsOffered },
              { name: 'canvas', registrations: canvasTools },
            ]
          : [],
        focus: desktopFocus,
        log: logDesktopTools,
      })
    : server
      ? createDesktopShellTools({
          transport: server.shellTransport(),
          version: app.getVersion(),
          // Out of process the server serves none of these itself (phase 6,
          // 6.3, decision R78): the browser and the canvas, the editor and
          // tours, and the terminal family, whose `agent.launch` and
          // `agent.status` ride an `agent` toolset under today's wire names.
          toolsets: [
            { name: 'browser', registrations: browserTools, enabled: browserToolsOffered },
            { name: 'canvas', registrations: canvasTools },
            { name: 'editor', registrations: editorTools },
            { name: 'tour', registrations: tourTools },
            { name: 'worktree', registrations: worktreeTools },
            ...shellTerminalToolsets(
              createServerGatewayBackends({
                getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
                listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
                readTerminalOutputTail: (sessionId, options) =>
                  terminalRuntime.readTerminalOutputTail(sessionId, options),
                launchAgent: (request) => agentLaunchService.launch(request),
                linkLaunchedAgent: (link) => agentLaunchNotices.link(link),
                // An agent launches no looser than it runs: its terminal here,
                // or the preset its record holds (a chat's live preset is the
                // server's, and its record carries the one last chosen).
                resolveAgentPermissionPreset: createAgentPermissionResolver({
                  listConversationSessions: () => [],
                  listTerminalSessions: () =>
                    listLiveTerminalSessions().map((session) => ({
                      kind: session.kind,
                      workspaceId: session.workspaceId,
                      agentId: session.agentId,
                      processAlive: isTerminalProcessAlive(session),
                      agentRecord: session.agentRecord,
                    })),
                  readAgentRecordPreset: (workspaceId, agentId) => {
                    const agent = workspaceRegistry.getRecord(workspaceId)?.agents[agentId]
                    return agent ? { found: true, preset: agent.cliPermissionPreset } : { found: false }
                  },
                }),
                // Neither is reached by a terminal or agent tool.
                createWorkspace: () => ({
                  ok: false,
                  reason: 'server_owned',
                  message: 'Workspaces are created by the Studio server.',
                }),
                getScheduledAgents: () => null,
                // Its ids for each CLI too, though the shell's terminal and
                // agent tools do not read them: the three are kept as one.
                ...launchSettingsGatewayDeps(agentLaunchSettings),
                getModuleRegistrySnapshot: () => moduleRegistryMirror.read(),
                listInstalledThirdPartyModules: async () => ({ modules: [], rejected: [] }),
                listModuleContributedTools: () => [],
                readMarketplaceRegistry: (input) => marketplaceRegistryReader.read(input),
              }),
            ),
          ],
          focus: desktopFocus,
          log: logDesktopTools,
        })
      : null
  // Out of process the shell's client starts now and connects once the
  // server is up; it comes back on its own after a restart and offers again.
  if (server) void desktopShell?.start()
  // The terminal agents' pull request marks, from the server's record, over a
  // connection of the shell's own in both modes: where each agent works goes
  // to the server, and the lists it answers ride the terminal snapshot.
  const shellTransport = studioRpc?.shellTransport() ?? server?.shellTransport() ?? null
  terminalPullRequests = shellTransport
    ? createTerminalPullRequests({
        transport: shellTransport,
        version: app.getVersion(),
        sessions: {
          list: () => listLiveTerminalSessions(),
          get: (sessionId) => getTerminalSessionById(sessionId),
        },
        onListsChanged: (affects) => notePullRequestRecordChanged(affects),
        log: logDesktopTools,
      })
    : null
  if (server) void terminalPullRequests?.start()
  if (server) {
    // What the server's gateway reads of the shell's terminals: the sessions
    // (the launch cap, `backlog.work`'s confirmation) and the launch tokens
    // they were issued (R87), by digest. Each change as it happens, and all of
    // them again to a server that has just started.
    const sendTerminalSessions = () =>
      server.rpc.emit(SERVER_EVENTS.terminalSessions, terminalRuntime.ipcHandlers.listTerminals())
    terminalRuntime.subscribeSessionsChanged(sendTerminalSessions)
    // A Claude terminal's status line is the only reading of the plan's usage
    // a person who never opens a chat gives; the limits the windows draw and
    // the resumes wait on are the server's store, so each reading goes there.
    forwardStatusLineRateLimits((rateLimits, at) => server.rpc.emit(SERVER_EVENTS.usageStatusLine, { rateLimits, at }))
    onGatewayLaunchTokenChange((change) => server.rpc.emit(SERVER_EVENTS.launchTokens, { changes: [change] }))
    // Asked by a server as it starts, before its gateway listens.
    server.rpc.handle(SHELL_METHODS.liveLaunchTokens, () => liveGatewayLaunchTokens())
    server.onServing(() => {
      server.rpc.emit(SERVER_EVENTS.launchTokens, { reset: true, changes: liveGatewayLaunchTokens() })
      sendTerminalSessions()
      // A server back from a restart: the shell's client connects now rather
      // than at the end of its backoff, and the SDK offers every toolset again.
      desktopShell?.client()?.wake()
    })
  }
  // Started and stopped with the RPC: the shell's client goes first, so the
  // RPC's goodbye is never one it would answer by reconnecting.
  const studioRpcService: StudioRpcService | null = studioRpc
    ? {
        ...studioRpc,
        start: () => {
          void desktopShell?.start()
          void terminalPullRequests?.start()
          return studioRpc.start()
        },
        stop: () => {
          desktopShell?.stop()
          terminalPullRequests?.stop()
          return studioRpc.stop()
        },
      }
    : null
  // The conversation peek (hover a chat row or an agent tab): the prompts this
  // app captured for the session the card is anchored to. Built here rather
  // than inside the runtime so its assembly rules stay Electron-free and
  // testable.
  const conversationPeek = createConversationPeekService({
    readSessionState: terminalRuntime.readConversationPeekSessionState,
    readConversationEvents: async (sessionId) => {
      if (server) {
        return server.rpc
          .call<Awaited<ReturnType<typeof conversations.readPeekTranscript>> | null>(
            SERVER_METHODS.conversationPeekEvents,
            { sessionId },
          )
          .catch(() => null)
      }
      const listed = conversations.listSessions()
      const summary = listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId) : undefined
      if (!summary) return null
      const workspaceRoot = workspaceRegistry.getRecord(summary.workspaceId)?.folderPath
      if (!workspaceRoot) return []
      // The first message and the newest turn, never the whole transcript:
      // a long chat is tens of megabytes, and a hover must not parse it.
      return conversations
        .readPeekTranscript({ workspaceRoot, workspaceId: summary.workspaceId, agentId: summary.agentId })
        .catch(() => [])
    },
  })

  // A live launched session whose agent is missing from its workspace is
  // adopted, so a launch-time write that did not land is not the end of it.
  terminalRuntime.subscribeSessionsChanged(() => launchedAgentRegistration.reconcile())
  // The app's own plugin goes into every workspace it opens, at the two moments
  // a workspace becomes real to main: the roots the registry already holds when
  // this process starts, and every accepted registry event after that. Not at
  // agent spawn like the hook and the MCP config — an agent that reaches its
  // first prompt without the skills has already lost the session they were for
  // (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).
  workspaceSyncService.subscribeEvents(() => {
    void studioPluginService.ensureInstalledForRoots(
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
    )
  })
  // The pass over the roots the registry already holds runs once the app's own
  // plugin copy has settled, so it installs the arrangement launches will
  // actually use. Each install also waits for that copy on its own, which is
  // what keeps an install triggered by an early registry event from writing the
  // old arrangement. Both start while the loading screen is up (see
  // `prepareWorkspacesAtBoot`); whatever the plate's budget does not cover
  // simply carries on after the reveal.
  const bootWorkspacePass = agentIntegrationReady.then(() =>
    studioPluginService.ensureInstalledForRoots(
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
    ),
  )
  void bootWorkspacePass.catch(() => undefined)
  // Out of process the registry arrives with the server's first snapshot, not
  // as events: the pass runs again once it has.
  if (server) {
    void server.mirror
      .whenLoaded()
      .then(() =>
        studioPluginService.ensureInstalledForRoots(
          uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
        ),
      )
      .catch(() => undefined)
  }
  const prepareWorkspacesAtBoot = (): Promise<void> => {
    openWorkspaceSyncGate()
    return bootWorkspacePass
  }
  // A Studio skill switched on or off reaches the next agent launched: the
  // plugin home the launch passes is brought in line, then every known
  // workspace (the choice is machine-wide). A session already running keeps
  // the skills it started with.
  studioAreaSkillStore.onChange(() => {
    void (async () => {
      await agentIntegrationReady
      if (agentIntegrationPluginDirs.length > 0) await ensureAgentIntegrationHome(agentIntegrationHomeOptions())
      await studioPluginService.ensureInstalledForRoots(
        uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
      )
    })().catch((error: unknown) => {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Studio skills not updated',
        message: 'The choice is saved and applies the next time a workspace is opened.',
        details: error instanceof Error ? error.message : String(error),
        source: 'workspace',
      })
    })
  })
  // Staying paired across sleep (phase 4): waking re-checks every paired
  // machine and re-dials waiting panes at once. `powerMonitor` needs the app
  // ready; services are built before that, so the hook waits for it.
  void app.whenReady().then(() => {
    // Out of process the server hears the wake as a power hint.
    if (!automationService) return
    const gateway = automationService
    const wake = () => gateway.mesh().onWake()
    powerMonitor.on('resume', wake)
    powerMonitor.on('unlock-screen', wake)
  })

  // Background mode: what the tray reports with no window open. Read
  // straight from the live main-process owners — the terminal runtime's session
  // list and the gateway's own status — because a presence that reported a
  // renderer projection would go stale the moment the last window it came from
  // closed.
  /**
   * What every agent launch waits for before it writes MCP config or builds a
   * command line: the Studio gateway listening (boot starts it alongside the
   * windows rather than ahead of them) and the plugin-home copy settled. A
   * launch before the reveal starts the deferred boot jobs itself.
   */
  function whenAgentLaunchReady(): Promise<void> {
    startDeferredBootJobs()
    // Out of process the gateway is listening once the server has said ready.
    const gatewayReady = automationService
      ? automationService.whenGatewayReady()
      : (server?.whenServing(AGENT_LAUNCH_SERVER_WAIT_MS) ?? Promise.resolve())
    return Promise.all([gatewayReady, agentIntegrationReady, launchFilesPruned, repositoryCleanup]).then(
      () => undefined,
    )
  }

  function readBackgroundStatus(): BackgroundStatus {
    const sessions = terminalRuntime.ipcHandlers
      .listTerminals()
      .filter((session) => session.kind === 'agent' && session.processAlive && !session.suspended)
    return {
      agentSessions: sessions.length,
      gateway: { running: automationService ? automationService.getStatus().running : (server?.isServing() ?? false) },
    }
  }

  // What a quit would stop: terminal agents mid-turn here in the shell, and
  // chats with a turn in progress wherever they run. Out of process the chats
  // are the server's, asked with a short budget: a server that does not
  // answer must not hold up the quit, so it counts none.
  async function countWorkingAgents(): Promise<number> {
    const terminals = countWorkingTerminalAgents(terminalRuntime.ipcHandlers.listTerminals())
    if (!server) {
      const listed = conversations.listSessions()
      return terminals + (listed.ok ? listed.sessions.filter(conversationTurnInProgress).length : 0)
    }
    if (!server.isServing()) return terminals
    let budget: NodeJS.Timeout | undefined
    const chats = await Promise.race([
      server.rpc.call<unknown>(SERVER_METHODS.conversationsWorking).catch(() => 0),
      new Promise<number>((resolve) => {
        budget = setTimeout(() => resolve(0), QUIT_COUNT_SERVER_BUDGET_MS)
      }),
    ])
    clearTimeout(budget)
    return terminals + (typeof chats === 'number' && chats > 0 ? chats : 0)
  }
  const quitConfirmation = createQuitConfirmation({
    isEnabled: () => quitConfirmationStore.isEnabled(),
    stopAsking: () => quitConfirmationStore.set(false),
    countWorkingAgents,
    ask: askToQuitWhileWorking,
  })

  // This profile, as the launcher's other users know it (integrations/live-instances.ts).
  const launcherProfile = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  // Every quit takes back out what the app writes again whenever it next needs
  // it (SESSION_INTEGRATION_KINDS): nothing Studio put into a repository or a
  // CLI's configuration outlives it, and deleting the app — which nothing
  // announces on macOS or Linux — leaves none of it behind. This machine's
  // entries only: reaching into a distribution would boot it just as its
  // helper is being stopped (the Windows uninstaller takes those out).
  async function removeSessionIntegrations(): Promise<void> {
    const home = homedir()
    // Held first: should the quit be cut short, what it leaves in place keeps
    // the launcher it runs, whichever profile quits next.
    await holdLauncher(home, launcherProfile).catch(() => undefined)
    const { othersRunning } = await leaveLiveInstances(home)
    // Another Studio (a development build beside the packaged app) runs the
    // same entries; they stay listed here, for a quit with nobody else running.
    if (othersRunning) return
    const removal = removeIntegrations(
      { ledger: integrationLedgerStore, scan: false },
      {
        kinds: SESSION_INTEGRATION_KINDS,
        hostId: 'local',
        keepCommitted: true,
        keepLauncher: await launcherHeldByOthers(home, launcherProfile),
        // Stops early enough to record what it did before the leg is cut off,
        // and as soon as another Studio starts.
        deadline: Date.now() + QUIT_INTEGRATION_REMOVAL_BUDGET_MS - 500,
        stop: () => otherInstanceRunning(home),
      },
    ).then(
      async (report) => {
        if (!entriesRunLauncher(await integrationLedgerStore.list(), 'local')) {
          await releaseLauncher(home, launcherProfile)
        }
        if (report.failed === 0) return
        void writeDiagnosticLog({
          level: 'warning',
          title: 'Integrations not removed at quit',
          message: `${report.failed} of Studio's entries could not be removed; the next quit tries them again.`,
          details: report.outcomes
            .filter((outcome) => outcome.status === 'failed')
            .map((outcome) => `${outcome.label}\t${outcome.path}\t${outcome.reason ?? ''}`)
            .join('\n'),
          source: 'workspace',
        })
      },
      (error: unknown) => {
        void writeDiagnosticLog({
          level: 'warning',
          title: 'Integrations not removed at quit',
          message: error instanceof Error ? error.message : String(error),
          source: 'workspace',
        })
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      removal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_INTEGRATION_REMOVAL_BUDGET_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  return {
    /** SSH machines (phase 8), when their preview is on this session. */
    ssh,
    shellBridge,
    /** The shell's client of its server: stopped first at quit, so the server's goodbye is not answered. */
    desktopShell,
    removeSessionIntegrations,
    startDeferredBootJobs,
    prepareWorkspacesAtBoot,
    agentConfigImportService,
    agentStateService,
    browserManager,
    browserRecorder,
    canvasService,
    canvasSubscribers,
    worktreePool,
    liveWorkPaths,
    dependencyInstaller,
    automationService,
    studioRpcService,
    backgroundModeStore,
    quitConfirmationStore,
    quitConfirmation,
    agentNotificationsStore,
    agentNotifier,
    agentBrowserToolsStore,
    setChatLinkOpener(open: (link: ChatLink) => void): void {
      chatLinkOpener = open
    },
    keepAwakeStore,
    agentKeepAwake,
    telemetryConsentStore,
    analytics,
    readBackgroundStatus,
    setScheduledAgentsResolver(resolver: () => ScheduledAgentsService | null): void {
      resolveScheduledAgents = resolver
    },
    setModuleEnabledResolver(resolver: (moduleId: string) => boolean): void {
      resolveModuleEnabled = resolver
    },
    setModuleMcpToolsResolver(resolver: () => ReadonlyArray<McpToolContribution>): void {
      resolveModuleMcpTools = resolver
    },
    moduleRegistryMirror,
    agentControlPlane,
    agentLaunchService,
    conversationTerminalHandoff,
    conversationLaunchService,
    conversationModelCatalog,
    tourService,
    setTourAttention: tours.setAttention,
    builtinSkillManager,
    studioPluginService,
    studioAreaSkillStore,
    studioCore: core,
    conversationOwner,
    conversations,
    githubTokenStore,
    logMainPerfEvent,
    mcpConfigService,
    sprintengineAuth,
    skillsService,
    agentLaunchSettings,
    hosts,
    conversationPeek,
    terminalRuntime,
    agentChangelistFeed,
    editorRevealBroker,
    // At quit: the shell's client closes, and in process the core's record
    // settles its writes (out of process the server does, in its own legs).
    // A hover on a terminal agent's line: ask the server again.
    refreshPullRequestsForSession: (sessionId: string) => terminalPullRequests?.refreshForSession(sessionId) ?? false,
    pullRequestRecord: {
      flush: async () => {
        terminalPullRequests?.stop()
        if (!server) await core.pullRequests.flush()
      },
      dispose: () => {
        if (!server) core.pullRequests.dispose()
      },
    },
    // In process, the core's local servers settle at quit and the runs the
    // Studio started stop; out of process the server does that itself.
    localServers: server
      ? null
      : { flush: () => core.localServers.flush(), dispose: () => core.localServers.dispose() },
    // In process, the core's resumes after a usage limit and the messages a
    // person scheduled stop before the chats; out of process the server stops
    // them in its own legs.
    usageLimitResumes: server ? null : { dispose: () => core.stopUsageLimitResumes() },
    scheduledMessages: server ? null : { dispose: () => core.stopScheduledMessages() },
    broadcastGitChangelistsChanged,
    updateService,
    withIpcDiagnostics,
    workspaceBackupService,
    workspaceSkillsService,
    agentCapabilityService,
    agentSkillInstaller,
    capabilityWatcher,
    workspaceSyncService,
    workspaceRegistry,
  }
}

export type AppServices = ReturnType<typeof createAppServices>
