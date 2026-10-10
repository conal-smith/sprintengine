import { machineAwareIpc } from './environments/ssh/machine-ipc'
import { app, BrowserWindow, nativeImage, shell } from 'electron'
import type { IpcMain } from 'electron'
import { registerAgentConfigImportIpc } from './ipc/agent-config-import-ipc'
import { registerAppearanceIpc } from './ipc/appearance-ipc'
import { registerBackgroundModeIpc } from './ipc/background-mode-ipc'
import { registerTelemetryIpc } from './ipc/telemetry-ipc'
import { registerQuitConfirmationIpc } from './ipc/quit-confirmation-ipc'
import { registerAgentNotificationsIpc } from './ipc/agent-notifications-ipc'
import { registerAgentBrowserToolsIpc } from './ipc/agent-browser-tools-ipc'
import { registerKeepAwakeIpc } from './ipc/keep-awake-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import {
  registerRemoteStudioConnectionIpc,
  registerStudioConnectionIpc,
  type RemoteWindowConnector,
} from './ipc/studio-connection-ipc'
import { assertAppSender } from './ipc/ipc-sender'
import { registerAppMenuIpc } from './app-menu'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerStudioPluginIpc } from './ipc/studio-plugin-ipc'
import { registerStudioAreaSkillsIpc } from './ipc/studio-area-skills-ipc'
import { registerCliRuntimeIpc } from './ipc/cli-runtime-ipc'
import { registerTextGenerationIpc } from './ipc/text-generation-ipc'
import { registerPullRequestCreateIpc } from './ipc/pull-request-create-ipc'
import { registerClipboardIpc } from './ipc/clipboard-ipc'
import { registerConversationPeekIpc } from './ipc/conversation-peek-ipc'
import { registerAgentCompactIpc } from './ipc/agent-compact-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerAttachedFilesIpc } from './ipc/attached-files-ipc'
import { createAttachedFileRegistry, createAttachedFiles, createAttachedFileThumbnails } from './attached-files'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitRepoWatchIpc } from './ipc/git-repo-watch-ipc'
import { getTerminalSessionById } from './terminal-runtime'
import { createFolderOpenIpcDependencies, registerFolderOpenIpc } from './ipc/folder-open-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerWorktreePoolIpc } from './ipc/worktree-pool-ipc'
import { registerDesignSystemIpc } from './ipc/design-system-ipc'
import { registerMcpIpc } from './ipc/mcp-ipc'
import { registerMemoryActivityIpc } from './ipc/memory-activity-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerProjectlessChatsIpc } from './ipc/projectless-chats-ipc'
import { registerMarketplacePluginIpc } from './ipc/marketplace-plugin-ipc'
import { registerMarketplaceRegistryIpc } from './ipc/marketplace-registry-ipc'
import { registerHostedSourcesFeedIpc } from './ipc/hosted-feed-ipc'
import { registerHostedCardFeedIpc } from './ipc/card-feed-ipc'
import { registerCardsIpc } from './ipc/cards-ipc'
import { registerCliVersionIpc } from './ipc/cli-version-ipc'
import { registerModuleEnablementIpc, type ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc'
import { registerModuleAppStateIpc } from './ipc/module-app-state-ipc'
import { registerModuleRegistryIpc } from './ipc/module-registry-ipc'
import { registerPluginIpc } from './ipc/plugins-ipc'
import { registerPullRequestIpc } from './ipc/pull-request-ipc'
import { registerSkillsIpc } from './ipc/skills-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerWorkspaceSkillsIpc } from './ipc/workspace-skills-ipc'
import { registerThirdPartyModuleIpc } from './ipc/third-party-module-ipc'
import type { ThirdPartyLaunchSession } from './modules/third-party-main-loader'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerVersionControlIpc } from './ipc/version-control-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerPanePopOutIpc } from './ipc/pane-popout-ipc'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerCanvasIpc } from './ipc/canvas-ipc'
import { registerEditorRevealIpc } from './ipc/editor-reveal-ipc'
import { registerToursIpc } from './ipc/tours-ipc'
import { pickCanvasExportDirectory, revealCanvasBoardFile } from './ipc/canvas-export-dialog'
import { registerExtensionScaffoldIpc } from './ipc/extension-scaffold-ipc'
import {
  confirmWorkspaceWindowClose,
  createDiagnosticsWindow,
  createMainWindow,
  isAuxWindow,
  isWorkspaceWindowWebContents,
  openAuxWindow,
  openPanePopOutWindow,
} from './window-factory'
import type { AppServices } from './app-services'
import { chatIdsOnRecord } from './agent-worktree-keep-checks'
import type { CliModelDiscoveryInput } from '../shared/ipc/cli-model-discovery'
import type { TerminalSpawnResult } from '../shared/ipc/terminal'
import { registerServerDomainIpc } from '../server/desktop/server-ipc'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createProjectLogoIo } from './project-logo-io'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder } from './diagnostics-folder'
import { writeDiagnosticLog } from './diagnostics-service'

export type CoreIpcOptions = {
  applyModuleEnablementLive?: ModuleEnablementLiveApplier
  /** What this session's third-party main halves did, for Settings → Extensions. */
  readThirdPartyLaunchSession?: () => Promise<ThirdPartyLaunchSession>
  /**
   * The Studio server in a process of its own: its domains register there, on
   * its IPC tunnel, and a chat view's protocol connection is brokered to it.
   */
  server?: {
    studioConnections: RemoteWindowConnector
    /** A model discovery pass, run by the server, which keeps the catalog cache. */
    discoverModels(input: CliModelDiscoveryInput): Promise<unknown>
  }
}

/** What registration hands back for the app's shutdown to finish. */
export type CoreIpcHandles = {
  conversationCommands: { dispose(): Promise<void> }
}

export function registerCoreIpc(
  ipcMain: IpcMain,
  services: AppServices,
  diagnosticsEnabled: boolean,
  options: CoreIpcOptions = {},
): CoreIpcHandles {
  // The file, git, terminal and folder channels never touch this computer for
  // a workspace on an SSH machine: its paths are spelled `ssh://…`, and these
  // registrations send them to that machine's server or refuse them in words
  // (phase 8).
  const machineIpc = machineAwareIpc(
    ipcMain,
    services.ssh ? { call: (id, channel, args) => services.ssh!.environments.machineCall(id, channel, args) } : null,
  )
  registerWindowIpc(ipcMain, {
    createWorkspaceWindow: ({ windowId, bounds, isMaximized }) => {
      createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized })
    },
    confirmWindowClose: confirmWorkspaceWindowClose,
    openAuxWindow,
    isAuxWindow,
  })
  const panePopOuts = registerPanePopOutIpc(ipcMain, {
    openWindow: openPanePopOutWindow,
    isWorkspaceWindow: isWorkspaceWindowWebContents,
    windowOf: (contents) => BrowserWindow.fromWebContents(contents),
  })
  registerBrowserIpc(ipcMain, services.browserManager, services.browserRecorder)
  registerCanvasIpc(ipcMain, services.canvasService, services.canvasSubscribers, {
    pickExportDirectory: pickCanvasExportDirectory,
    revealFile: revealCanvasBoardFile,
  })
  registerEditorRevealIpc(ipcMain, services.editorRevealBroker, {
    // The answering window, never a name the message carries; only workspace
    // windows show a workspace, so only they are heard.
    senderId: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win && isWorkspaceWindowWebContents(event.sender) ? win : null
    },
  })
  registerToursIpc(ipcMain, services.tourService)
  if (options.server) registerRemoteStudioConnectionIpc(ipcMain, options.server.studioConnections)
  else if (services.studioRpcService) registerStudioConnectionIpc(ipcMain, services.studioRpcService)
  registerAppMenuIpc(ipcMain)
  registerClipboardIpc(ipcMain)
  registerCliRuntimeIpc(
    ipcMain,
    options.server ? { discoverModels: (input) => options.server!.discoverModels(input) } : {},
  )
  registerTextGenerationIpc(ipcMain)
  // The chat's "Create PR": git, gh and the drafting CLI all run on this computer.
  registerPullRequestCreateIpc(ipcMain)
  registerAuthIpc(ipcMain, services.sprintengineAuth)
  registerBuiltinSkillsIpc(ipcMain, services.builtinSkillManager)
  registerStudioPluginIpc(ipcMain, services.studioPluginService)
  registerStudioAreaSkillsIpc(ipcMain, services.studioAreaSkillStore)
  registerMcpIpc(machineIpc, services.mcpConfigService)
  registerAgentConfigImportIpc(ipcMain, services.agentConfigImportService)
  registerSkillsIpc(ipcMain, services.skillsService)
  registerWorkspaceSkillsIpc(machineIpc, {
    workspaceSkills: services.workspaceSkillsService,
    agentCapabilities: services.agentCapabilityService,
    agentSkillInstaller: services.agentSkillInstaller,
  })
  const filesystemSearchHandlers = createFilesystemWatchSearchHandlers()
  registerFilesystemWatchSearchIpc(machineIpc, filesystemSearchHandlers)
  const filesystemReadHandlers = createFilesystemReadHandlers({ opener: shell, projectLogoIo: createProjectLogoIo() })
  registerFilesystemReadIpc(machineIpc, filesystemReadHandlers)
  // The file-manager target of the open-in-editor control is the same reveal the
  // rest of the app already uses, so it is handed the very same handler.
  registerFolderOpenIpc(machineIpc, createFolderOpenIpcDependencies(filesystemReadHandlers.showItemInFolder))
  // Memory/knowledge-graph backend is foundational: agent context injection
  // (TerminalView) and the Knowledge Graph settings tab
  // depend on it, so it is always registered. The memory-graph capability
  // module gates only the visualization panel (renderer side).
  registerMemoryIpc(machineIpc)
  registerMemoryActivityIpc(ipcMain)
  registerDiagnosticsIpc(ipcMain, {
    writeDiagnosticLog,
    openDiagnosticsLogsFolder,
    openDiagnosticsWindow: () => {
      createDiagnosticsWindow()
    },
    listConversationRoots: () => services.conversations.listLiveConversationRoots(),
  })
  registerUpdateIpc(ipcMain, { updateService: services.updateService })
  registerFilesystemMutationIpc(machineIpc, createFilesystemMutationHandlers())
  // A file attached to a message by path opens in its default app, and only
  // one the person attached here; on plain `ipcMain`, as it is this computer's.
  const attachedFileRegistry = createAttachedFileRegistry({ resolveUserDataDir: () => app.getPath('userData') })
  // Its writes wait a moment so a drop of many files is one; one still
  // waiting is written as the app goes.
  app.on('will-quit', () => attachedFileRegistry.flush())
  registerAttachedFilesIpc(
    ipcMain,
    createAttachedFiles({
      registry: attachedFileRegistry,
      thumbnails: createAttachedFileThumbnails({
        platform: process.platform,
        createThumbnail: (path, size) => nativeImage.createThumbnailFromPath(path, size),
      }),
      platform: process.platform,
      openPath: (path) => shell.openPath(path),
    }),
  )
  registerGitIpc(
    machineIpc,
    {
      enabled: diagnosticsEnabled,
      logMainPerfEvent: services.logMainPerfEvent,
      withIpcDiagnostics: services.withIpcDiagnostics,
    },
    // The changelist store's home. Resolved here rather than inside the git
    // modules so those stay free of `electron.app` and remain testable against
    // a temp directory.
    {
      userDataDir: app.getPath('userData'),
      onChangelistsChanged: services.broadcastGitChangelistsChanged,
      // Settled chats included: a worktree holding a chat's history is kept.
      knownWorkspaceIds: () => chatIdsOnRecord(services.workspaceSyncService.getSnapshot().state.workspaces),
      // Terminals and chats' live provider sessions, the list the pool uses too.
      livePaths: services.liveWorkPaths,
    },
  )
  registerGitRepoWatchIpc(machineIpc)
  registerWorktreePoolIpc(ipcMain, services.worktreePool, services.dependencyInstaller, {
    livePaths: services.liveWorkPaths,
    knownWorkspaceIds: () => chatIdsOnRecord(services.workspaceSyncService.getSnapshot().state.workspaces),
  })
  registerVersionControlIpc(machineIpc)
  registerMenuDialogIpc(ipcMain)
  registerProjectlessChatsIpc(ipcMain)
  registerModuleEnablementIpc(ipcMain, { applyLive: options.applyModuleEnablementLive })
  // Module app state (Settings section values), mirrored for `entry.main`.
  registerModuleAppStateIpc(ipcMain)
  registerModuleRegistryIpc(ipcMain, services.moduleRegistryMirror)
  registerAppearanceIpc(ipcMain)
  registerBackgroundModeIpc(ipcMain, services.backgroundModeStore)
  registerTelemetryIpc(ipcMain, services.telemetryConsentStore)
  registerQuitConfirmationIpc(ipcMain, services.quitConfirmationStore)
  registerAgentNotificationsIpc(ipcMain, services.agentNotificationsStore)
  registerAgentBrowserToolsIpc(ipcMain, services.agentBrowserToolsStore, () => {
    void services.desktopShell?.refreshToolsets()
  })
  registerKeepAwakeIpc(ipcMain, services.keepAwakeStore, () => services.agentKeepAwake.refresh())
  registerMarketplaceRegistryIpc(ipcMain)
  registerHostedSourcesFeedIpc(ipcMain)
  registerHostedCardFeedIpc(ipcMain)
  // Go, on a card on the Extensions home. Registered after the skills and MCP
  // services it composes, because it is those services said in one press.
  registerCardsIpc(ipcMain, {
    skillsService: services.skillsService,
    mcpConfigService: services.mcpConfigService,
    githubTokenStore: services.githubTokenStore,
  })
  registerCliVersionIpc(ipcMain)
  registerMarketplacePluginIpc(ipcMain, services)
  registerPluginIpc(ipcMain)
  // The domains the Studio server owns: registered here while it runs in
  // process, and by the server itself on its IPC tunnel when it runs in a
  // process of its own (src/server/desktop/server-ipc.ts).
  const { automationService, studioRpcService, workspaceBackupService, conversationTerminalHandoff } = services
  const { conversationCommands } =
    !options.server && automationService && studioRpcService && workspaceBackupService && conversationTerminalHandoff
      ? registerServerDomainIpc(ipcMain, {
          core: services.studioCore,
          gateway: automationService,
          studioRpc: studioRpcService,
          githubTokenStore: services.githubTokenStore,
          workspaceBackup: workspaceBackupService,
          terminalHandoff: (input) => conversationTerminalHandoff.handoff(input),
          files: { ...filesystemSearchHandlers, ...filesystemReadHandlers },
          assertAppSender,
        })
      : // The server registers them, and disposes its own command lists.
        { conversationCommands: { dispose: async () => undefined } }
  registerDesignSystemIpc(ipcMain)
  registerThirdPartyModuleIpc(ipcMain, services, {
    ...(options.readThirdPartyLaunchSession ? { readLaunchSession: options.readThirdPartyLaunchSession } : {}),
  })

  // The terminal runtime (agent-runtime) is always on, so its IPC registers
  // with the core surfaces.
  const terminalHandlers = services.terminalRuntime.ipcHandlers
  registerTerminalIpc(machineIpc, {
    ...terminalHandlers,
    // A pane terminal moves between windows by re-attaching, and the last
    // attach takes the pty's output. A pop-out's attach that crossed the
    // owner's taking the tab back must not be the last word.
    spawnTerminal: (sender, payload) => {
      const sessionId = payload?.sessionId
      const existing = typeof sessionId === 'string' ? getTerminalSessionById(sessionId) : null
      if (existing && !existing.isDisposed && !panePopOuts.mayAttachTerminal(sender, sessionId)) {
        return Promise.resolve({
          ok: false,
          sessionId,
          message: 'This terminal is shown in another window.',
          exitCode: 1,
        } satisfies TerminalSpawnResult)
      }
      return terminalHandlers.spawnTerminal(sender, payload)
    },
    // One idle-suspend setting governs both agent runtimes: PTY terminals and
    // headless conversation child processes share the threshold.
    setIdleSuspendThresholdMs: (value: unknown): void => {
      services.terminalRuntime.ipcHandlers.setIdleSuspendThresholdMs(value)
      services.conversationOwner.setIdleThresholdMs(value)
    },
  })

  // The conversation peek reads a terminal session, so it registers alongside
  // the runtime that owns one rather than with the core surfaces.
  registerConversationPeekIpc(ipcMain, services.conversationPeek)

  // Compacting a terminal agent types at its prompt, so it registers beside
  // the runtime that owns the session and goes through the control plane that
  // owns typing at one.
  registerAgentCompactIpc(ipcMain, {
    findTerminal: (sessionId) =>
      services.terminalRuntime.ipcHandlers.listTerminals().find((session) => session.sessionId === sessionId) ?? null,
    sendPrompt: async (sessionId, text, precondition) => {
      const result = await services.agentControlPlane.send({ sessionId }, text, { submit: true, precondition })
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },
  })

  // Same reason: a terminal agent's pull request marks follow its session, so
  // the hover's refresh registers beside the runtime that owns the session.
  // The lists themselves are the Studio server's, read over the protocol.
  registerPullRequestIpc(machineIpc, {
    refreshPullRequestsForSession: (sessionId) => services.refreshPullRequestsForSession(sessionId),
  })
  // ── extension-platform additions ──
  // Build your own extension: the SDK's templates, the machine check, the project.
  registerExtensionScaffoldIpc(machineIpc)
  return { conversationCommands }
}
