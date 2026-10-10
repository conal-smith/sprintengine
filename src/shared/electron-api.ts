import type { ClientCapability } from './client-capabilities'
import type { AttachedFilePreview } from './attached-files'
import type { ChatLink } from './deep-link'
import type { AgentNotificationMode } from './agent-notifications'
import type { PreviewOpenAnswer, PreviewPort, PreviewSummary, WebDevicesStatus } from './web-client'
import type {
  SshEnvironmentResult,
  SshEnvironmentSettings,
  SshEnvironmentSummary,
  SshPromptRequest,
  SshResolveResult,
} from './ssh-environments'
import type { SshPreviewStatus } from './ssh-preview'
import type { ServerMode } from './server-mode'
import type { StudioServerInfo, StudioServerStatus } from './studio-server-status'
import type { EditorRevealAck, EditorRevealRequest, EditorStateQuery, EditorStateReply } from './editor-reveal'
import type {
  LiveTour,
  TourAsk,
  TourChangedEvent,
  TourGotoAnswer,
  TourGotoRequest,
  TourPlayback,
  TourResult,
  TourRevealRequest,
  TourSummary,
} from './tours/tour-types'
import type { ConversationPeek } from './conversation-peek'
import type {
  ChatTitleRequest,
  PullRequestTextResult,
  TextGenerationResult,
  TextGenerationSettings,
} from './text-generation/contract'
import type {
  CreatePullRequestOutcome,
  CreatePullRequestState,
  PullRequestCheckoutPin,
  PushForPullRequestOutcome,
} from './git/pull-request-create'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsPatch,
  AgentLaunchSettingsRecord,
  AgentLaunchSettingsSnapshot,
  AgentLaunchSettingsWriteAck,
} from './launch-settings'

export type { ConversationPeek, ConversationPeekMessage, ConversationPeekSource } from './conversation-peek'
export type { HostedSource, HostedSourceKind, HostedSourcesFeed } from './hosted-sources-feed'
export type {
  CardAction,
  CardActionVerb,
  CardSurfaceView,
  HostedCard,
  HostedCardFeed,
  HostedCardKind,
} from './hosted-card-feed'
// The build-identity shape a window reports; re-exported because it is part of
// this IPC contract like the rest of the surface below.
import type { BuildStamp } from './build-stamp'
export type { BuildStamp } from './build-stamp'
import type {
  InstalledSkillsInput,
  InstalledSkillsResult,
  InstalledSkillRemoveInput,
  InstalledSkillRemoveResult,
} from './installed-skills'
import type {
  BrowserCaptureInput,
  BrowserClearResult,
  BrowserConfig,
  BrowserHostKey,
  BrowserPointerEvent,
  BrowserRecordingEnded,
  BrowserRecordingStart,
  BrowserRecordingStarted,
  BrowserRegisterInput,
  BrowserRegisterResult,
  BrowserScreenshotResult,
  BrowserTabState,
  LocalServer,
} from './browser'
import type { BrowserColorScheme, BrowserViewport } from './browser-devices'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasElement,
  CanvasExportImages,
  CanvasExportResult,
  CanvasPresence,
  CanvasResult,
  CanvasScenePush,
} from './canvas/types'
import type { CanvasWorkerReport, CanvasWorkerRequest, CanvasWorkerResponse } from './canvas/worker-protocol'
import type { FolderOpenRequest, FolderOpenResult, FolderOpenTargetAvailability } from './folder-open-targets'
// Re-exported because these shapes are the open-in-editor IPC contract itself:
// the renderer reads them off this module like the rest of the API surface.
export type {
  FolderOpenFailureReason,
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
  FolderOpenTargetId,
} from './folder-open-targets'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from './skills'
// Re-exported because the harness identity is part of this IPC contract: it
// rides BuiltinSkill, WorkspaceSkill and every install/uninstall result.
export type { SkillHarness } from './skills'
// Which transport the skills service reads repositories over. It rides
// `SkillSourcesResult` because every surface that says why a cadence or a
// shortfall applies has to know (git-transport ruling, owner 2026-09-08).
export type { SkillRepoTransport } from './skills'
// The capability query's shapes live with the other skill shapes; these are its
// IPC envelopes, same split as the skill-source calls below.
export type {
  AgentCapabilitiesInput,
  AgentCapabilitiesResult,
  AgentMcpServer,
  AgentSkill,
  AgentSkillSource,
  CapabilityDiagnostic,
} from './skills'
import type { AutomationServerStatus } from './automation'
import type {
  StudioLocalAppOfferInput,
  StudioLocalAppOfferView,
  StudioLocalAppToolReach,
  StudioLocalAppsStatus,
} from './studio-local-apps'
import type { StudioChatTransportMode, StudioConnectResult } from './studio-connection'
import type {
  TailnetApprovePairRequestView,
  TailnetLiveState,
  TailnetPairingOfferView,
  TailnetPushPayload,
  TailnetRemoteStatus,
  TailnetScope,
} from './tailnet'
import type { TailnetPeerScan } from './tailnet-peers'
import type { TailnetShareResult, TailnetShareStatus } from './tailnet-share'
import type { RepositoryIdentityRead } from './repository-identity'
import type { ModuleWorkspaceGitInfoResult } from './modules/workspace-view'
import type {
  MeshBrowse,
  MeshConnection,
  MeshCreateConversationResult,
  MeshNewChatWorktree,
  MeshSettleConversationResult,
  MeshVisitConversationResult,
  MeshWorkspaceCheckoutResult,
  MeshWorkspaceExtensionsResult,
  MeshEvent,
  MeshLiveState,
  MeshPairResult,
  MeshRequestPairingResult,
  TailnetForgetMachineResult,
  MeshConversationCommandResult,
  MeshConversationFrame,
  MeshConversationKey,
  MeshConversationImageResult,
  MeshConversationListResult,
} from './tailnet-mesh'
import type {
  ScheduledAgentDraft,
  ScheduledAgentLastRun,
  ScheduledAgentView,
  ScheduledAgentWriteResult,
} from './scheduled-agents'
// Write-back config + IPC contracts: schema owned by T10, IPC surface
// consumed by the T11 settings UI. Re-exported through the single electron-api
// surface like the rest of the tracker seam.
import type { DesignSystemBundleLintRunResult } from './design-system/bundle-lint-run'
import type { DesignSystemScaffoldResult } from './design-system/bundle-scaffold'
import type { DesignSystemBundleReadResult } from './design-system/bundle-view'
import type { DesignSystemLibraryListResult, DesignSystemRegisterResult } from './design-system/library'
import type { DesignSystemArrivalsResult } from './design-system/arrivals'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
  DesignSystemDetachResult,
} from './design-system/attach'
import type {
  ConversationEvent,
  ConversationInterruptInput,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSetModelInput,
  ConversationMcpServerActionInput,
  ConversationMcpServerActionResult,
  ConversationSetPermissionInput,
  ConversationProvidersListInput,
  ConversationProviderSignInInput,
  ConversationProviderSignInResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationSuspendSessionInput,
  ConversationTerminalHandoffInput,
  ConversationTerminalHandoffResult,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationAttachmentInput,
  ConversationAttachmentResult,
  ConversationImageAttachment,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationSubscribeInput,
  ConversationLoadEarlierInput,
  ConversationSessionFrame,
  ConversationPageResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationApprovalRulesResult,
  ConversationApprovalRuleRevokeResult,
} from './conversation-runtime'
import type { ModuleBridgeInvokeResult } from './modules/bridge'
import type { ModuleHostServiceRequest } from './modules/host-service-bridge'
import type {
  ConversationWorkspaceKey,
  ConversationThreadsResult,
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationRenameInput,
} from './conversation-index'
import type { ConversationSearchHit } from './conversation-index'
import type { ModuleEventEnvelope } from './modules/events'
import type { ModuleNotificationDelivery } from './modules/notifications'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
  ThirdPartyRendererEntriesResult,
} from './modules/manifest'
import type { ModuleRegistrySnapshot, ModuleRegistrySnapshotWriteResult } from './modules/registry-snapshot'
import type {
  WorkspaceMarkUnreadResult,
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from './workspace-sync'
import type { VersionControlProviderProbe } from './version-control'
import type { HostGhStatus } from './host-gh'
import type { ExecutionHostId, HostHomeResult, HostsListResult } from './execution-host'
// Re-exported because the probe shape is part of this IPC contract: the
// version-control settings sections read it straight off the api surface.
export type {
  VersionControlProbeFailure,
  VersionControlProviderId,
  VersionControlProviderProbe,
} from './version-control'
import type { SprintEngineAuthState } from './ipc/account'
import type { CliModelDiscoveryInput, CliModelDiscoveryResult } from './ipc/cli-model-discovery'
import type { ConversationCommandsRequest } from './ipc/conversation-commands'
import type { ConversationCommandCatalog } from './conversation/commands'
import type { UsageLimitsState } from './usage-limits'
import type { UsageLimitResumeState, UsageLimitResumeUpdate } from './usage-limit-resume'
import type { ScheduledMessagesState, ScheduledMessageUpdate } from './scheduled-messages'
import type {
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
} from './ipc/agent-cli'
import type {
  AgentConfigAdoptInput,
  AgentConfigAdoptResult,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
} from './ipc/agent-config'
import type {
  ConversationImportInput,
  ConversationImportResult,
  ConversationImportScanResult,
} from './ipc/conversation-import'
import type {
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliPermissionPreset,
  CliRuntimeSettings,
} from './ipc/agent-runtime'
import type {
  AppMenuAcceleratorUpdate,
  AppMenuAcceleratorUpdateResult,
  ColorScheme,
  ModuleEnablementOverrides,
  ModuleEnablementWriteResult,
  WindowMaterial,
  WorkspaceBackupWriteResult,
} from './ipc/app'
import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCreateEpicInput,
  BacklogCreateEpicResult,
  BacklogDependenciesInput,
  BacklogEnsureIdsInput,
  BacklogEnsureIdsResult,
  BacklogEpicColorInput,
  BacklogEpicInput,
  BacklogHighlightInput,
  BacklogItemRecordInput,
  BacklogLocationResult,
  BacklogMockupsInput,
  BacklogModuleMetadataInput,
  BacklogMoveSourceInput,
  BacklogMutationResult,
  BacklogReadResult,
  BacklogRemoveLinkInput,
  BacklogRemoveRecordInput,
  BacklogSetRootInput,
  BacklogStatusInput,
  BacklogTriageInput,
} from './ipc/backlog'
import type { CardRunInput, CardRunResult } from './ipc/cards'
import type { CliVersionAdvisoriesInput, CliVersionAdvisoriesResult } from './ipc/cli-version'
import type {
  AgentCli,
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretClearResult,
  ConversationSecretSetInput,
  ConversationSecretSetResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
  CredentialSecretClearInput,
  CredentialSecretClearResult,
  CredentialSecretSetInput,
  CredentialSecretSetResult,
  CredentialSecretStatusInput,
  CredentialSecretStatusResult,
} from './ipc/conversations'
import type { DiagnosticLogEntry, DiagnosticLogInput, ProjectLogo, WorkspaceFolderCheckResult } from './ipc/diagnostics'
import type { ContentSearchResult, FileSearchResult, FileSystemStat, FileWatchEvent } from './ipc/filesystem'
import type {
  BranchStepDiff,
  BranchStepSelection,
  BranchStepsSnapshot,
  Changelist,
  GitBranchSnapshot,
  GitCommandResult,
  GitConflictFileContent,
  GitFileBaseResult,
  GitFileHunksResult,
  GitFileStage,
  GitFileStageResult,
  GitGraphOptions,
  GitGraphSnapshot,
  GitHubCloneInput,
  GitHubCloneResult,
  GitHubRepoListResult,
  GitHubTokenStatus,
  GitHunkRef,
  GitHunkScope,
  GitPatchResult,
  GitPatchSaveResult,
  GitRepoOperation,
  GitResetMode,
  GitStashListSnapshot,
  GitStatusSnapshot,
  GitWorktreeCreateInput,
  GitWorktreeCreated,
  GitWorktreeListSnapshot,
  GitWorktreeOperationResult,
  GitWorktreeRemoveInput,
  GitWorktreeRestoreInput,
  GitWorktreeRestoreResult,
  RevFileResult,
  WorkspaceChangeSummary,
  GitCheckoutChange,
  AgentWorktreeCleanupInput,
  AgentWorktreeCleanupReport,
} from './ipc/git'
import type {
  WorktreeDependencyInstallView,
  WorktreeInventory,
  WorktreeInventoryInput,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from './ipc/worktree-pool'
import type { HostedCardFeedReadInput, HostedCardFeedReadResult, HostedSourcesFeedReadResult } from './ipc/hosted-feeds'
import type {
  GithubExtensionCheckUpdateInput,
  GithubExtensionCheckUpdateResult,
  GithubExtensionInstallInput,
  GithubExtensionResolveInput,
  GithubExtensionResolveResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyInput,
  MarketplacePluginVerifyResult,
  ThirdPartyModuleUninstallInput,
  ThirdPartyModuleUninstallResult,
} from './ipc/marketplace'
import type {
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
} from './ipc/marketplace-registry'
import type { McpSyncInput, McpSyncResult } from './ipc/mcp'
import type {
  MemoryActivityEvent,
  MemoryActivityInstallResult,
  MemoryActivityStatus,
  MemoryActivitySynapse,
  MemoryActivitySynapsesPayload,
  MemoryActivityUninstallResult,
  MemoryGraphIndexResult,
  MemoryPreviewResult,
  MemoryRootStatus,
} from './ipc/memory'
import type { WorkspaceBackupPayload, WorkspaceBackupReadResult } from './ipc/workspace-backup'
import type {
  AgentSkillWriteInput,
  AgentSkillWriteResult,
  SkillAddLocalSourceInput,
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillInstalledPluginsInput,
  SkillInstalledPluginsOutcome,
  SkillPluginInstallInput,
  SkillPluginInstallOutcome,
  SkillPluginScanLinkedInput,
  SkillPluginScanLinkedOutcome,
  SkillPluginUninstallInput,
  SkillPluginUninstallOutcome,
  SkillPopularReposOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSearchInput,
  SkillSearchOutcome,
  SkillSourceUpdateCheck,
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from './ipc/skills'
import type {
  BuiltinSkill,
  BuiltinSkillStatus,
  PluginRegistryListResult,
  StudioPluginStatus,
} from './ipc/studio-plugin'
import type { StudioAreaSkillChoices, StudioAreaSkillId } from './studio-area-skills'
import type {
  IpcStatsSnapshot,
  ProcessMetricsSnapshot,
  TerminalPromptUndelivered,
  TerminalSessionSnapshot,
  TerminalSessionsDelta,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
  TerminalVisibilityOptions,
  WorkspaceRegistryHydrateResult,
} from './ipc/terminal'
import type {
  AppUpdateChannelSetting,
  AppUpdateCheckResult,
  AppUpdateState,
  AppUpdateTrack,
  AuxWindowRetargetPayload,
  CreateWorkspaceWindowInput,
  CreateWorkspaceWindowResult,
  DockDiffToWorkspaceInput,
  DockDiffToWorkspacePayload,
  DockDiffToWorkspaceResult,
  DockFileToWorkspaceInput,
  OpenAuxWindowInput,
  OpenAuxWindowResult,
  OpenExternalResult,
  WindowPlacement,
  WindowState,
} from './ipc/window'
import type {
  PanePopOutAction,
  PanePopOutActionEvent,
  PanePopOutClosedEvent,
  PanePopOutOpenInput,
  PanePopOutOpenResult,
  PanePopOutSnapshot,
  PanePopOutState,
  PanePopOutStatePush,
} from './ipc/pane-popout'
import type {
  ExtensionScaffoldCreateInput,
  ExtensionScaffoldCreateResult,
  ExtensionScaffoldTarget,
  ExtensionScaffoldTargetInput,
} from './extension-scaffold'

// The contract, one module per domain. Everything a caller imports from this
// file is declared in one of them; this file adds the ElectronApi shape.
export type * from './ipc/filesystem'
export type * from './ipc/memory'
export type * from './ipc/studio-plugin'
export type * from './ipc/agent-cli'
export type * from './ipc/marketplace'
export type * from './ipc/cli-version'
export type * from './ipc/hosted-feeds'
export type * from './ipc/cards'
export type * from './ipc/marketplace-registry'
export type * from './ipc/conversations'
export type * from './ipc/agent-runtime'
export type * from './ipc/mcp'
export type * from './ipc/agent-config'
export type * from './ipc/conversation-import'
export type * from './ipc/skills'
export type * from './ipc/terminal'
export type * from './ipc/git'
export type * from './ipc/worktree-pool'
export type * from './ipc/diagnostics'
export type * from './ipc/window'
export type * from './ipc/pane-popout'
export type * from './ipc/account'
export type * from './ipc/workspace-backup'
export type * from './ipc/app'
export type * from './ipc/backlog'

/** `restarting: false` when the person answered Cancel to the quit question. */
export type AppRestartResult = { restarting: boolean }

export type ElectronApi = {
  /**
   * The OS of the machine the person is at: the client. It decides the
   * Primary modifier, the keyboard's labels and the window chrome. In a
   * desktop window it is the preload's `process.platform`; in a browser tab,
   * the browser's own (phase 9 spec, 3.3).
   */
  platform: string
  /**
   * The OS of the machine the Studio server runs on. It decides path syntax,
   * the "Reveal in Finder/Explorer" wording and CLI hints. The same as
   * `platform` for a desktop window on its own server.
   */
  hostPlatform: string
  /** What this shell can do (src/shared/client-capabilities.ts); ask `clientSupports`, not `typeof`. */
  clientCapabilities: readonly ClientCapability[]
  /** The ports the server's agents listen on, for a preview (web client only; `previews`). */
  previewsList: () => Promise<{ ports: PreviewPort[] }>
  /** Open a preview of a port on the server's loopback, on an origin of its own. */
  previewsOpen: (input: { port: number; typed?: boolean }) => Promise<PreviewOpenAnswer>
  previewsClose: (previewId: string) => Promise<boolean>
  onPreviewsChanged: (cb: (previews: PreviewSummary[]) => void) => () => void
  /** The browsers paired with this server's web listener, and the ones asking (web client only). */
  webDevicesStatus: () => Promise<WebDevicesStatus>
  webDevicesRevoke: (id: string) => Promise<boolean>
  webDevicesRename: (id: string, name: string) => Promise<boolean>
  /** A one-time link that pairs another browser, on one of the server's origins. */
  webDevicesLink: (origin?: string) => Promise<{ url: string; expiresAt: string }>
  /** Let a browser in by the six digits it shows. Three wrong tries decline it. */
  webDevicesApprove: (requestId: string, code: string) => Promise<{ ok: true } | { ok: false; message: string }>
  webDevicesDecline: (requestId: string) => Promise<boolean>
  onWebDevicesChanged: (cb: (status: WebDevicesStatus) => void) => () => void
  /** Whether this session has SSH machines (a preview, off by default; phase 8). */
  sshMachinesEnabled?: boolean
  isDevelopment: boolean
  isDiagnosticsEnabled: boolean
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<WindowState | null>
  windowClose: () => Promise<void>
  getWindowState: () => Promise<WindowState | null>
  getWindowPlacement: () => Promise<WindowPlacement | null>
  createWorkspaceWindow: (input: CreateWorkspaceWindowInput) => Promise<CreateWorkspaceWindowResult>
  openAuxWindow: (input: OpenAuxWindowInput) => Promise<OpenAuxWindowResult>
  onAuxWindowRetarget: (cb: (payload: AuxWindowRetargetPayload) => void) => () => void
  dockFileToWorkspace: (input: DockFileToWorkspaceInput) => Promise<void>
  onDockFileToWorkspace: (cb: (input: DockFileToWorkspaceInput) => void) => () => void
  dockDiffToWorkspace: (input: DockDiffToWorkspaceInput) => Promise<DockDiffToWorkspaceResult>
  onDockDiffToWorkspace: (cb: (input: DockDiffToWorkspacePayload) => void) => () => void
  /** The receiving window's half of the hand-off: "I opened the tab." */
  ackDockDiffToWorkspace: (requestId: string) => void
  confirmWindowClose: () => Promise<void>
  openExternal: (url: string) => Promise<OpenExternalResult>
  onWindowStateChanged: (cb: (state: WindowState) => void) => () => void
  /** Main's word on whether this window is minimized, hidden or behind a locked screen. */
  onWindowHiddenChanged: (cb: (hidden: boolean) => void) => () => void
  onWindowPlacementChanged: (cb: (placement: WindowPlacement) => void) => () => void
  onWindowCloseRequested: (cb: () => void) => () => void
  /**
   * A `sprintengine://chat/…` link for this window to open. Subscribing tells
   * main the window is listening, so call it once the registry has loaded: a
   * link that launched the app waits in main until then (chat-link-router.ts).
   */
  onChatLinkOpen: (cb: (link: ChatLink) => void) => () => void
  // The pane, or one tab, in a window of its own (ipc/pane-popout.ts). The
  // first six are the owner window's half, the last three the pop-out's.
  panePopOutOpen: (input: PanePopOutOpenInput) => Promise<PanePopOutOpenResult>
  /** Fire-and-forget: the owner's latest word on what the window shows. */
  panePopOutPush: (popOutId: string, state: PanePopOutState) => void
  panePopOutFocus: (popOutId: string) => Promise<void>
  panePopOutClose: (popOutId: string) => Promise<void>
  onPanePopOutAction: (cb: (event: PanePopOutActionEvent) => void) => () => void
  onPanePopOutClosed: (cb: (event: PanePopOutClosedEvent) => void) => () => void
  panePopOutGetState: (popOutId: string) => Promise<PanePopOutSnapshot | null>
  onPanePopOutState: (cb: (push: PanePopOutStatePush) => void) => () => void
  /** Fire-and-forget: what the person did in the pop-out, for the owner to apply. */
  panePopOutAct: (popOutId: string, action: PanePopOutAction) => void
  // The embedded browser (browser-pane epic, src/shared/browser.ts). The
  // renderer mounts the `<webview>` and registers its WebContents id; main
  // drives it and pushes `onBrowserState` for every registered tab.
  /** The partition for a workspace's tabs: an SSH machine's, behind its forward, or this computer's (phase 8). */
  browserConfig: (input?: { workspaceId?: string }) => Promise<BrowserConfig>
  browserRegister: (input: BrowserRegisterInput) => Promise<BrowserRegisterResult>
  browserUnregister: (tabId: string) => Promise<void>
  browserNavigate: (tabId: string, url: string) => Promise<boolean>
  browserBack: (tabId: string) => Promise<boolean>
  browserForward: (tabId: string) => Promise<boolean>
  browserReload: (tabId: string, ignoreCache?: boolean) => Promise<boolean>
  browserStop: (tabId: string) => Promise<boolean>
  browserOpenExternal: (tabId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  browserZoomStep: (tabId: string, direction: 1 | -1 | 0) => Promise<boolean>
  browserSetColorScheme: (tabId: string, scheme: BrowserColorScheme) => Promise<boolean>
  browserOpenDevTools: (tabId: string) => Promise<boolean>
  browserOpenWindow: (tabId: string) => Promise<boolean>
  browserClearCookies: () => Promise<BrowserClearResult>
  browserClearCache: () => Promise<BrowserClearResult>
  browserCapture: (input: BrowserCaptureInput) => Promise<BrowserScreenshotResult>
  browserCopyScreenshot: (tabId: string) => Promise<BrowserClearResult>
  browserLocalServers: (workspaceId: string) => Promise<LocalServer[]>
  /** Tell main which tab the person is looking at in a workspace's pane (agent tools target it). */
  browserNoteActive: (workspaceId: string, tabId: string | null) => Promise<void>
  /** An agent asked for a URL in this workspace's pane (browser.open); the renderer opens or navigates a tab. */
  onBrowserOpenRequest: (
    cb: (payload: { workspaceId: string; url: string | null; tabId: string | null }) => void,
  ) => () => void
  /** The agent's pointer is about to act at a point in a tab's viewport (the cursor overlay). */
  onBrowserPointer: (cb: (event: BrowserPointerEvent) => void) => () => void
  /** An agent asked for a device viewport on a tab (browser.resize); the renderer owns viewport state. */
  onBrowserViewportRequest: (cb: (payload: { tabId: string; viewport: BrowserViewport }) => void) => () => void
  onBrowserState: (cb: (state: BrowserTabState) => void) => () => void
  onBrowserFocusUrl: (cb: (payload: { tabId: string }) => void) => () => void
  onBrowserHostKey: (cb: (payload: { tabId: string; key: BrowserHostKey }) => void) => () => void
  /** The person's Stop on a recording an agent started on this tab. */
  browserStopRecording: (tabId: string) => Promise<boolean>
  /**
   * Main asks this window to record one of its tabs (`browser.record_start`):
   * the window captures the guest, encodes it and answers with the three sends below.
   */
  onBrowserRecordingStart: (cb: (start: BrowserRecordingStart) => void) => () => void
  onBrowserRecordingStop: (cb: (payload: { recordingId: string }) => void) => () => void
  browserRecordingStarted: (payload: BrowserRecordingStarted) => void
  /** One chunk of a recording's WebM, in order. */
  browserRecordingChunk: (recordingId: string, bytes: Uint8Array) => void
  /** After the last chunk. */
  browserRecordingEnded: (payload: BrowserRecordingEnded) => void
  // The Canvas pane (src/shared/canvas). Main owns the `.excalidraw` file, the
  // revision and the merge; a tab subscribes by opening a board and is pushed
  // every accepted scene until it closes it. Every path crossing here is
  // resolved against the workspace root on the main side, so a renderer cannot
  // name a file outside the project however it spells one.
  canvasListBoards: (workspaceId: string) => Promise<CanvasResult<CanvasBoardSummary[]>>
  /** Opens (optionally creating) a board and subscribes the calling window to it. */
  canvasOpenBoard: (input: {
    workspaceId: string
    path: string
    create?: boolean
  }) => Promise<CanvasResult<CanvasBoardState>>
  canvasCloseBoard: (input: CanvasBoardRef) => Promise<void>
  /**
   * The person's edit, debounced by the tab. `elements` is the full array
   * including tombstones, and `baseRevision` is what the tab last saw, so main
   * can merge rather than overwrite. `elements` comes back non-null only when
   * the merge differs from what was sent — that is the tab's cue to reconcile,
   * and sending it back unconditionally would echo every keystroke.
   */
  canvasCommitScene: (
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
  ) => Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  /**
   * Export the board into a folder the person picks: main shows the picker
   * (opening at `defaultDirectory` when given) and writes `<name>.excalidraw`
   * there, plus `<name>.png` / `<name>.svg` for each image the tab rendered.
   * The board itself stays where it is. `cancelled` when the picker was
   * dismissed.
   */
  canvasExportBoard: (
    input: CanvasBoardRef & { defaultDirectory?: string; images?: CanvasExportImages },
  ) => Promise<CanvasResult<CanvasExportResult>>
  /**
   * Show the board's file in the system file manager. Main resolves where it
   * is: a store board lives in the app's data folder, outside the project.
   */
  canvasRevealBoard: (input: CanvasBoardRef) => Promise<CanvasResult<void>>
  /**
   * The person has started a gesture on this board. Presence ONLY: it moves the
   * badge every other window shows, so an agent stops looking like it holds the
   * pen. It cancels nothing — an agent action in flight keeps running, and what
   * protects the person's work is the per-element merge in main, which
   * recomputes a contested agent edit once and then fails it `interrupted`.
   * Fire-and-forget.
   */
  canvasNoteHumanInput: (input: CanvasBoardRef) => void
  onCanvasScene: (cb: (push: CanvasScenePush) => void) => () => void
  onCanvasPresence: (cb: (presence: CanvasBoardRef & CanvasPresence) => void) => () => void
  /** An agent asked for a board in this workspace's pane (canvas.open); the tab opens docked. */
  onCanvasOpenRequest: (cb: (ref: CanvasBoardRef) => void) => () => void
  // Diff tours (src/main/tours). The Diff viewer reads and plays them; the
  // workspace window docks a tour's Diff tab when an agent writes one.
  tourList: (workspaceId: string) => Promise<TourSummary[]>
  tourRead: (workspaceId: string, tourId: string) => Promise<TourResult<LiveTour>>
  tourReportPlayback: (workspaceId: string, tourId: string, playback: TourPlayback) => Promise<void>
  tourAsk: (
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ) => Promise<TourResult<TourAsk> & { authorGone?: boolean }>
  tourCancelAsk: (workspaceId: string, tourId: string, askId: string) => Promise<void>
  tourAskNewAgent: (
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ) => Promise<TourResult<{ agentId: string }>>
  /** This window docked the tour's tab: `tour.create` answers `revealed: true`. */
  tourAcknowledgeReveal: (requestId: string) => void
  tourAnswerGoto: (answer: TourGotoAnswer) => void
  onTourChanged: (cb: (event: TourChangedEvent) => void) => () => void
  onTourRevealRequest: (cb: (request: TourRevealRequest) => void) => () => void
  onTourGotoRequest: (cb: (request: TourGotoRequest) => void) => () => void
  // The hidden canvas worker window's half of the same surface. Only that window
  // uses these three: it announces itself once its editor instance has mounted,
  // then answers requests until main disposes it.
  /**
   * Ready to take requests, and how the fonts went. A family in `missing` means
   * every label the worker measures is measured in a fallback face and written
   * to the person's file at that size, so main appends a warning to every edit,
   * layout and import it makes while that is true.
   */
  canvasWorkerReady: (report: CanvasWorkerReport) => void
  onCanvasWorkerRequest: (cb: (request: CanvasWorkerRequest) => void) => () => void
  canvasWorkerRespond: (response: CanvasWorkerResponse) => void
  // The editor reveal (editor.* tools): main asks every workspace window to
  // open a file or diff an agent means; the window showing that workspace
  // does, and says how. `editorRevealClaim` takes the reveal that waited for a
  // workspace no window was showing.
  onEditorRevealRequest: (cb: (request: EditorRevealRequest) => void) => () => void
  ackEditorReveal: (ack: EditorRevealAck) => void
  onEditorRevealPending: (cb: (payload: { workspaceIds: string[] }) => void) => () => void
  editorRevealClaim: (workspaceId: string) => Promise<EditorRevealRequest | null>
  editorRevealListPending: () => Promise<string[]>
  onEditorStateQuery: (cb: (query: EditorStateQuery) => void) => () => void
  replyEditorState: (reply: EditorStateReply) => void
  // Splash boot handshake. `notifyBootComplete` is sent once by the primary
  // workspace window when its first frame is on screen, and is what closes the
  // splash and reveals the main window (main also holds a hard timeout, so a
  // renderer that never gets there cannot strand a hidden main window). The
  // plate's own progress subscription is not here: the plate loads a preload of
  // its own (`src/preload/splash.ts`).
  notifyBootComplete: () => void
  // Boot measurement, off unless asked for. The flag is resolved in
  // preload from the same environment main reads, so the renderer never reports
  // marks into a main process that is not collecting them. A mark is an epoch
  // millisecond because the two processes have different `performance.now()`
  // origins — see src/shared/startup-timeline.ts.
  startupTimelineEnabled: boolean
  reportStartupMark: (id: string, atEpochMs: number) => void
  // Build identity. Every window reports the commit its bundle was
  // built from; main compares it against its own and says so once when the two
  // halves have diverged — see src/shared/build-stamp.ts.
  reportBuildStamp: (stamp: BuildStamp) => void
  workspaceSyncDispatch: (command: WorkspaceSyncCommand) => Promise<WorkspaceSyncCommandResult>
  workspaceSyncGetSnapshot: () => Promise<WorkspaceSyncSnapshot>
  workspaceSyncGetEventsAfter: (sequence: number) => Promise<WorkspaceSyncEvent[]>
  /**
   * True while main has never written a workspace registry — the
   * first boot after the inversion, or a fresh install. A window answers it by
   * offering its post-migrate-ladder localStorage state to
   * `workspaceRegistryHydrate`; false means main is authoritative and the
   * window mirrors instead.
   */
  workspaceRegistryNeedsHydration: () => Promise<boolean>
  workspaceRegistryHydrate: (payload: unknown) => Promise<WorkspaceRegistryHydrateResult>
  onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => () => void
  /**
   * Mark a chat here unread, as `conversation.mark_unread` does for a paired
   * device: its visit clock goes back to just before its latest finish, so
   * every device shows it unseen again. The change arrives as a sync event.
   */
  workspaceMarkUnread: (workspaceId: string) => Promise<WorkspaceMarkUnreadResult>
  automationGetStatus: () => Promise<AutomationServerStatus>
  /**
   * The applications on this machine paired with Studio's owner socket. Like
   * the tailnet's pairing, reachable from a window only: no socket method can
   * pair an app or widen one.
   */
  studioLocalAppsStatus: () => Promise<StudioLocalAppsStatus>
  /** Mint a one-time pairing code for an app. The code comes back once and is never re-readable. */
  studioLocalAppsOffer: (input: StudioLocalAppOfferInput) => Promise<StudioLocalAppOfferView>
  studioLocalAppsCancelOffer: (id: string) => Promise<StudioLocalAppsStatus>
  /** Revoke an app: its token stops working and its open connections are closed at once. */
  studioLocalAppsRevoke: (id: string) => Promise<StudioLocalAppsStatus>
  /** Change which agents a paired app's tools reach: the chats it starts, or every agent here. */
  studioLocalAppsSetReach: (id: string, reach: StudioLocalAppToolReach) => Promise<StudioLocalAppsStatus>
  onStudioLocalAppsChanged: (cb: (status: StudioLocalAppsStatus) => void) => () => void
  /** How this window's chat view reaches conversations: the protocol, or the conversation IPC. */
  studioChatTransport: StudioChatTransportMode
  /** A new connection to the Studio RPC over a port the preload keeps; its ticket is good for one hello. */
  studioConnect: () => Promise<StudioConnectResult>
  /** Send one frame on a connection. */
  studioPortSend: (connectionId: string, frame: string) => void
  /** Hear a connection's frames, and its end. Frames wait for this to be called. */
  studioPortListen: (connectionId: string, onFrame: (frame: string) => void, onClose: () => void) => void
  studioPortClose: (connectionId: string) => void
  // Tailnet remote control: the opt-in listener that serves the same
  // gateway surface to paired devices on the Tailscale network. Configuration
  // only — it never carries a tool call, and no MCP tool can reach it, so an
  // agent cannot pair a device or widen its own reach.
  tailnetGetStatus: () => Promise<TailnetRemoteStatus>
  tailnetSetEnabled: (enabled: boolean) => Promise<TailnetRemoteStatus>
  /** Mint a one-time pairing code. The token comes back once and is never re-readable. */
  tailnetOfferPairing: (scopes?: TailnetScope[]) => Promise<TailnetPairingOfferView>
  tailnetCancelPairing: () => Promise<TailnetRemoteStatus>
  tailnetRevokeDevice: (deviceId: string) => Promise<TailnetRemoteStatus>
  /**
   * Replace a paired device's scopes from this machine (remote-settings-rebuild).
   *
   * The set REPLACES what the device had, so this narrows as readily as it
   * widens. Rejects when no device holds that id: a row acting on something
   * that is no longer there must hear about it rather than report success.
   */
  tailnetUpdateDeviceScopes: (deviceId: string, scopes: TailnetScope[]) => Promise<TailnetRemoteStatus>
  /**
   * End a pairing in BOTH directions: revoke the device that machine holds
   * here, and forget the credential this machine holds there. Either id may be
   * omitted, and an id that is already gone is not an error — the result says
   * which halves were actually ended.
   */
  tailnetForgetMachine: (input: { deviceId?: string; connectionId?: string }) => Promise<TailnetForgetMachineResult>
  /**
   * Answer a pairing request from another machine. The scopes are the
   * ones chosen here, and this is the only surface that can grant the terminal
   * tier to a person rather than to an agent on the local socket.
   */
  tailnetApprovePairRequest: (
    id: string,
    scopes: TailnetScope[],
    code: string,
  ) => Promise<TailnetApprovePairRequestView>
  tailnetDenyPairRequest: (id: string) => Promise<TailnetRemoteStatus>
  /**
   * Main asks the chrome to open the Remote popover — the click on an OS
   * notification about a pair request or a machine's answer lands here.
   */
  onRemoteOpenRequested: (cb: () => void) => () => void
  /**
   * Machines on this tailnet, and which of them answer as a Studio.
   *
   * A read of the local Tailscale daemon plus a probe of each peer's public
   * health endpoint. Works with this machine's own listener off: finding
   * somewhere to connect to is independent of being connectable.
   */
  tailnetListPeers: () => Promise<TailnetPeerScan>
  /**
   * Live connections behind the push channel (remote-sessions-ux): which
   * devices hold a socket right now and which terminals they are attached to.
   * Read once as the initial snapshot; every `onTailnetEvent` payload carries
   * a fresher one.
   */
  tailnetGetLiveState: () => Promise<TailnetLiveState>
  /**
   * Subscribe to tailnet changes pushed from main — listener up/down, pair
   * requests arriving or resolving, devices connecting, terminal drive
   * begin/end. Returns the unsubscribe.
   */
  onTailnetEvent: (cb: (payload: TailnetPushPayload) => void) => () => void
  /**
   * Dev servers this machine publishes on the tailnet (`tailscale serve`), so a
   * phone or another desktop can open one. Read on demand: serve config lives
   * in tailscaled and outlives this process, so these never return a
   * remembered list.
   */
  tailnetShareStatus: () => Promise<TailnetShareStatus>
  tailnetSharePort: (localPort: number) => Promise<TailnetShareResult>
  tailnetUnsharePort: (servePort: number) => Promise<TailnetShareResult>
  // The Mesh: the machines this Studio is paired WITH, and the chats
  // it follows on them. Main owns the device tokens and every outbound socket —
  // the listener refuses any request carrying an `Origin`, which a renderer
  // always sends, so this is the only route a window has.
  meshListConnections: () => Promise<MeshConnection[]>
  /** Redeem a pairing link from another machine's Settings → Remote. */
  meshPair: (pairingUrl: string) => Promise<MeshPairResult>
  /**
   * Ask a machine to pair, for someone there to approve, then poll it.
   * Main holds the collect secret, so a window can neither dial the peer nor
   * take the token the approval mints.
   */
  meshRequestPairing: (
    endpoint: string,
    options?: {
      /** What to ask that machine to let THIS one do. The far end's default applies when omitted. */
      scopes?: TailnetScope[]
      /** What that machine may do HERE, granted in the same exchange. Omitted asks one way only. */
      reverseScopes?: TailnetScope[]
    },
  ) => Promise<MeshRequestPairingResult>
  meshCancelPairing: (requestId: string) => Promise<void>
  /** Re-check whether one paired machine (or every one, with no id) answers right now (phase 4). */
  meshCheckReachability: (connectionId?: string) => Promise<MeshLiveState>
  /** Drop this machine's credential for a peer. Revoking the device THERE is the other half. */
  meshForget: (connectionId: string) => Promise<MeshConnection[]>
  /** One machine's workspaces, or the gap that says why this pairing may not read them. */
  meshBrowse: (connectionId: string) => Promise<MeshBrowse>
  /**
   * Start a chat agent in a workspace on a paired machine (`conversation:operate`
   * there), and get the ids a chat pane here follows it by.
   */
  meshCreateConversation: (input: {
    connectionId: string
    workspaceId: string
    cli?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: string
    /** The CLI's effort level; dropped for a machine that does not advertise `new-chat-effort`. */
    effort?: string
    /** A worktree to start in; refused, never dropped, by a machine without the capability for it. */
    worktree?: MeshNewChatWorktree
    /**
     * Images that go with the first message. Each is put in that machine's
     * upload store under the new chat's session, and the first message names
     * them, as a message sent to a followed chat does.
     */
    attachments?: ConversationImageAttachment[]
    /** That machine's skill ids, attached as the chat's chips; refused by a machine without `new-chat-skills`. */
    skills?: string[]
  }) => Promise<MeshCreateConversationResult>
  /**
   * Settle a chat on a paired machine, or bring it back with `settled: false`
   * (`conversation.settle` there, which needs `conversation-lifecycle`).
   */
  meshSettleConversation: (input: {
    connectionId: string
    workspaceId: string
    settled?: boolean
  }) => Promise<MeshSettleConversationResult>
  /** Say a chat on a paired machine is on screen here (`conversation.visit` there). */
  meshVisitConversation: (input: { connectionId: string; workspaceId: string }) => Promise<MeshVisitConversationResult>
  /** A remote workspace's checkout facts — branch, trunk, branches, worktrees — for the launch panel's checkout · branch segments. */
  meshWorkspaceCheckout: (connectionId: string, workspaceId: string) => Promise<MeshWorkspaceCheckoutResult>
  /** A remote project's skills and, for a CLI, its MCP servers with their connection, for the composer's picker. */
  meshWorkspaceExtensions: (input: {
    connectionId: string
    workspaceId: string
    cli?: string
  }) => Promise<MeshWorkspaceExtensionsResult>
  /**
   * The pairing requests still waiting and each machine's last reachability —
   * the initial read behind `onMeshEvent`, carrying the same revision the
   * events do.
   */
  meshGetLiveState: () => Promise<MeshLiveState>
  /**
   * Whole-app mesh lifecycle (remote-sessions-ux): a machine paired or
   * forgotten, answering or not, a pairing wait moving on — broadcast to every
   * window, credential-free. Returns the unsubscribe.
   */
  onMeshEvent: (cb: (event: MeshEvent) => void) => () => void
  /**
   * Conversations on a paired machine, the same calls the local session API
   * makes with the machine named in the key. Main follows over the tailnet
   * and keeps the transcript tail; the renderer never holds a credential.
   */
  meshConversationList: (connectionId: string) => Promise<MeshConversationListResult>
  onMeshConversationSession: (
    input: { key: MeshConversationKey; turnLimit?: number },
    cb: (frame: MeshConversationFrame) => void,
  ) => () => void
  meshConversationLoadEarlier: (input: {
    key: MeshConversationKey
    beforeCursor: number
    turnLimit?: number
  }) => Promise<ConversationPageResult>
  /**
   * A message to a chat on a paired machine. `attachments` are the images a
   * chat here sends with a turn; main puts each in that machine's upload store
   * and the send names them. A chat that does not take images refuses the
   * message in words rather than sending the words alone.
   *
   * `queue`: hand the message to the machine to hold until the chat's turn
   * ends, and answer once it holds it. Needs `conversation-queued-sends`
   * there, and words alone: a held message carries no images.
   */
  meshConversationSend: (input: {
    key: MeshConversationKey
    message: string
    attachments?: ConversationImageAttachment[]
    queue?: boolean
    /** That machine's skill ids the chat runs with this message (`conversation-send-skills`). */
    skills?: string[]
  }) => Promise<MeshConversationCommandResult>
  // Take back a message the machine holds for the turn's end, by its id there.
  meshConversationCancelQueued: (input: {
    key: MeshConversationKey
    queuedId: string
  }) => Promise<MeshConversationCommandResult>
  meshConversationInterrupt: (input: { key: MeshConversationKey }) => Promise<MeshConversationCommandResult>
  meshConversationResolveApproval: (input: {
    key: MeshConversationKey
    requestId: string
    decision: 'once' | 'conversation' | 'deny'
  }) => Promise<MeshConversationCommandResult>
  meshConversationAnswerQuestion: (input: {
    key: MeshConversationKey
    requestId: string
    answers: Record<string, string>
  }) => Promise<MeshConversationCommandResult>
  // `manual` and `auto` need `conversation-permission-modes` there.
  meshConversationSetPermissionPreset: (input: {
    key: MeshConversationKey
    preset: CliPermissionPreset
  }) => Promise<MeshConversationCommandResult>
  // Switch a paired machine's chat to another model of its CLI, from the
  // catalog that machine's list names. Needs `conversation-models` there.
  meshConversationSetModel: (input: {
    key: MeshConversationKey
    modelId: string
  }) => Promise<MeshConversationCommandResult>
  meshConversationToolDetail: (input: {
    key: MeshConversationKey
    toolUseId: string
  }) => Promise<ConversationToolDetailResult>
  meshConversationTurnDiff: (input: {
    key: MeshConversationKey
    turnSeq: number
    path?: string
  }) => Promise<ConversationTurnDiffResult>
  // The picture a step of a paired machine's chat made or looked at, as a data
  // URL. Needs `conversation-images` there; the list says whether it has it.
  meshConversationToolImage: (input: {
    key: MeshConversationKey
    toolUseId: string
  }) => Promise<MeshConversationImageResult>
  // Scheduled agents: a prompt and a schedule, each run a new chat. Main owns
  // the list and the scheduler; the renderer reads and writes through these.
  listScheduledAgents: () => Promise<ScheduledAgentView[]>
  createScheduledAgent: (draft: ScheduledAgentDraft) => Promise<ScheduledAgentWriteResult>
  updateScheduledAgent: (id: string, draft: ScheduledAgentDraft) => Promise<ScheduledAgentWriteResult>
  removeScheduledAgent: (id: string) => Promise<{ ok: true } | { ok: false; message: string }>
  runScheduledAgentNow: (
    id: string,
  ) => Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  /** The card's "Failed" was seen: it goes back to saying when the agent runs next. */
  markScheduledAgentFailureSeen: (id: string) => Promise<{ ok: true }>
  /** The whole list, after every change — a write from anywhere, or a run's outcome. */
  onScheduledAgentsChanged: (cb: (agents: ScheduledAgentView[]) => void) => () => void
  authGetState: () => Promise<SprintEngineAuthState>
  authLogin: (organizationId?: string | null) => Promise<{ state: string; authorizationUrl: string }>
  authLogout: () => Promise<{ loggedOut: true }>
  authRefreshAccount: () => Promise<SprintEngineAuthState>
  onAuthStateChanged: (cb: (state: SprintEngineAuthState) => void) => () => void
  onAuthCallbackError: (cb: (message: string) => void) => () => void
  readdir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
  searchFiles: (
    rootPath: string,
    query: string,
    options?: { limit?: number; purpose?: 'mention'; channel?: string; recentAt?: Record<string, number> },
  ) => Promise<FileSearchResult>
  searchContent: (rootPath: string, query: string, options?: { limit?: number }) => Promise<ContentSearchResult>
  cancelContentSearch: () => Promise<void>
  cancelFileSearch: (channel?: string) => Promise<void>
  readfile: (path: string) => Promise<string>
  readImageDataUrl: (path: string) => Promise<string>
  pathExists: (path: string) => Promise<boolean>
  statPath: (path: string) => Promise<FileSystemStat>
  getPathForFile: (file: unknown) => string
  /**
   * A dropped, picked or pasted file's path, as `getPathForFile` reads it, and
   * that file remembered as attached: the paths `openAttachedFile` will open.
   * '' for a file with no path on disk.
   */
  attachFile: (file: unknown) => string
  /** What an attached path is now, the system's thumbnail of it, and whether a click may open it. */
  previewAttachedFile: (path: string) => Promise<AttachedFilePreview>
  /**
   * Open an attached file in its default app. Refuses, with the reason, a path
   * that was not attached and a file that would run as a program when opened.
   */
  openAttachedFile: (path: string) => Promise<void>
  /** Send dropped files that have no path to the server; answers a path there for each (`file-uploads`). */
  uploadFiles: (files: File[]) => Promise<string[]>
  checkWorkspaceFolder: (path: string) => Promise<WorkspaceFolderCheckResult>
  detectProjectLogo: (folderPath: string) => Promise<ProjectLogo | null>
  memoryResolveRoot: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryRootStatus>
  memoryIndex: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryGraphIndexResult>
  memoryReadPreview: (input: {
    workspaceRoot: string | null
    relativeRoot: string | null
    relativePath: string
  }) => Promise<MemoryPreviewResult>
  memoryActivityInstall: (input: {
    workspaceRoot: string | null
    memoryRelativeRoot: string | null
  }) => Promise<MemoryActivityInstallResult>
  memoryActivityUninstall: (input: { workspaceRoot: string | null }) => Promise<MemoryActivityUninstallResult>
  memoryActivityStartWatching: (input: {
    workspaceRoot: string | null
    memoryRelativeRoot: string | null
  }) => Promise<{ ok: true }>
  memoryActivityGetStatus: (input: { workspaceRoot: string | null }) => Promise<MemoryActivityStatus>
  memoryActivityGetSynapses: (input: { workspaceRoot: string | null }) => Promise<MemoryActivitySynapse[]>
  memoryActivityIsInstalled: (input: { workspaceRoot: string | null }) => Promise<boolean>
  onMemoryActivityEvent: (cb: (event: MemoryActivityEvent) => void) => () => void
  onMemoryActivityStatus: (cb: (status: MemoryActivityStatus) => void) => () => void
  onMemoryActivitySynapses: (cb: (payload: MemoryActivitySynapsesPayload) => void) => () => void
  builtinSkillsList: () => Promise<BuiltinSkill[]>
  builtinSkillStatus: (input: { workspaceRoot: string | null; skillId: string }) => Promise<BuiltinSkillStatus>
  /**
   * The app's own plugin: what this build ships against what the open workspace
   * holds. Read-only — the built-in plugin has no Install and no Remove.
   */
  studioPluginStatus: (input: { workspaceRoot: string | null }) => Promise<StudioPluginStatus>
  /**
   * The built-in plugin's area skills, opted into one by one and machine-wide
   * (shared/studio-area-skills.ts). A change installs into, or takes out of,
   * every workspace, and is pushed through `onStudioAreaSkillsChanged`.
   */
  studioAreaSkillsGet: () => Promise<StudioAreaSkillChoices>
  studioAreaSkillsSetEnabled: (input: {
    skillId: StudioAreaSkillId
    enabled: boolean
  }) => Promise<StudioAreaSkillChoices>
  /** Turn a surface's suggestion down; the skill stays a switch in Settings. */
  studioAreaSkillsDismiss: (input: { skillId: StudioAreaSkillId }) => Promise<StudioAreaSkillChoices>
  onStudioAreaSkillsChanged: (cb: (choices: StudioAreaSkillChoices) => void) => () => void
  pluginsList: () => Promise<PluginRegistryListResult>
  pluginsDetectAvailability: (input?: PluginDetectAvailabilityInput) => Promise<PluginAvailabilityResult>
  agentLaunchPreview: (input: AgentLaunchPreviewInput) => Promise<AgentLaunchPreviewResult>
  readMarketplaceRegistry: (input?: MarketplaceRegistryReadInput) => Promise<MarketplaceRegistryReadResult>
  /** The recommended-sources feed, from disk (cache, else seed); never fetches. */
  hostedSourcesFeedGet: () => Promise<HostedSourcesFeedReadResult>
  // The hosted card feed (src/shared/hosted-card-feed.ts). `get` is the disk copy with no network — the first-paint path;
  // `refresh` may fetch (the client's TTL decides unless forced); `changed`
  // fires after any read that replaced the feed, and only then.
  hostedCardFeedGet: () => Promise<HostedCardFeedReadResult>
  hostedCardFeedRefresh: (input?: Pick<HostedCardFeedReadInput, 'forceRefresh'>) => Promise<HostedCardFeedReadResult>
  onHostedCardFeedChanged: (cb: (result: HostedCardFeedReadResult) => void) => () => void
  // Pressing Go on a card on the Extensions home. One call runs the card's
  // ordered actions in the workspace the person is in and hands back what to
  // open; the renderer never runs an installer of its own (item 2469).
  cardsRun: (input: CardRunInput) => Promise<CardRunResult>
  // CLI version advisories: installed version against the package registry's
  // newest. `set-enabled` mirrors the Settings switch into main so the
  // background check can be turned off; `changed` fires from the poller.
  cliVersionAdvisories: (input?: CliVersionAdvisoriesInput) => Promise<CliVersionAdvisoriesResult>
  cliVersionChecksSetEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>
  onCliVersionAdvisoriesChanged: (cb: (result: CliVersionAdvisoriesResult) => void) => () => void
  // Verify resolves the entry by id in main and answers with what an install
  // would put on the machine, plus the one-time trust token that installs
  // exactly that (see src/main/marketplace/trust-tokens.ts).
  verifyMarketplacePlugin: (input: MarketplacePluginVerifyInput) => Promise<MarketplacePluginVerifyResult>
  installMarketplacePluginFromRegistry: (
    input: MarketplacePluginRegistryInstallInput,
  ) => Promise<MarketplacePluginRegistryInstallResult>
  updateMarketplacePluginFromRegistry: (
    input: MarketplacePluginRegistryInstallInput,
  ) => Promise<MarketplacePluginRegistryInstallResult>
  // Removes an installed marketplace plugin: its module folders, CLI plugins
  // and skill copies, its MCP servers out of the synced configs, and its module
  // trust grants. `pluginId` is the marketplace entry's id, or the id of a
  // module it installed. An added automation is deliberately left in place —
  // it is the user's from the moment it lands.
  uninstallMarketplacePlugin: (input: MarketplacePluginUninstallInput) => Promise<MarketplacePluginUninstallResult>
  readMarketplacePluginUpdateStates: (input?: MarketplaceRegistryReadInput) => Promise<MarketplaceUpdateStatesResult>
  // Install extension from GitHub: main resolves the repository's default
  // branch (or the ref the URL names) to a commit, discloses what it found
  // there, and issues the one-time token `installGithubExtension` spends.
  // `checkGithubExtensionUpdate` is the same review of where the branch is now.
  resolveGithubExtension: (input: GithubExtensionResolveInput) => Promise<GithubExtensionResolveResult>
  installGithubExtension: (input: GithubExtensionInstallInput) => Promise<MarketplacePluginRegistryInstallResult>
  checkGithubExtensionUpdate: (input: GithubExtensionCheckUpdateInput) => Promise<GithubExtensionCheckUpdateResult>
  conversationProvidersList: (input?: ConversationProvidersListInput) => Promise<ConversationProviderListResult>
  conversationProviderModels: (input: ConversationProviderModelsInput) => Promise<ConversationProviderModelsResult>
  // The line a plain terminal on this machine runs to sign a chat's CLI back
  // in, resolved to the executable the conversation provider runs.
  conversationProviderSignIn: (input: ConversationProviderSignInInput) => Promise<ConversationProviderSignInResult>
  conversationSecretStatus: (input: ConversationSecretStatusInput) => Promise<ConversationSecretStatusResult>
  conversationSecretSet: (input: ConversationSecretSetInput) => Promise<ConversationSecretSetResult>
  conversationSecretClear: (input: ConversationSecretClearInput) => Promise<ConversationSecretClearResult>
  credentialSecretStatus: (input: CredentialSecretStatusInput) => Promise<CredentialSecretStatusResult>
  credentialSecretSet: (input: CredentialSecretSetInput) => Promise<CredentialSecretSetResult>
  credentialSecretClear: (input: CredentialSecretClearInput) => Promise<CredentialSecretClearResult>
  conversationSessionStart: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  conversationSessionSendTurn: (input: ConversationSendTurnInput) => Promise<ConversationSessionActionResult>
  conversationSessionInterrupt: (input: ConversationInterruptInput) => Promise<ConversationSessionActionResult>
  conversationSessionRespondToRequest: (
    input: ConversationRespondToRequestInput,
  ) => Promise<ConversationSessionActionResult>
  // Live tool-permission switch on a running conversation session (takes effect
  // on the agent's next tool call).
  conversationSessionSetPermission: (input: ConversationSetPermissionInput) => Promise<ConversationSessionActionResult>
  // Switch a running conversation to another model of its provider; applies
  // from the next turn.
  conversationSessionSetModel: (input: ConversationSetModelInput) => Promise<ConversationSessionActionResult>
  /** Reconnect, switch or sign in to one of a live chat's MCP servers; a sign-in answers the URL to finish it at. */
  conversationSessionMcpAction: (input: ConversationMcpServerActionInput) => Promise<ConversationMcpServerActionResult>
  conversationSessionStop: (input: ConversationStopSessionInput) => Promise<ConversationSessionActionResult>
  // Settle and Snooze: end the chat's child process, keeping the session so the
  // next message respawns it.
  conversationSessionSuspend: (input: ConversationSuspendSessionInput) => Promise<ConversationSessionActionResult>
  // Resume in terminal: suspend the chat and open a terminal agent that
  // resumes its CLI session (`claude --resume <id>`, `codex resume <id>`).
  conversationSessionTerminalHandoff: (
    input: ConversationTerminalHandoffInput,
  ) => Promise<ConversationTerminalHandoffResult>
  conversationSessionsList: (input?: ConversationListSessionsInput) => Promise<ConversationListSessionsResult>
  conversationTranscript: (input: ConversationTranscriptInput) => Promise<ConversationTranscriptResult>
  conversationToolDetail: (input: ConversationToolDetailInput) => Promise<ConversationToolDetailResult>
  // The bytes of an image a sent turn carried, by the store reference its
  // `user_message` recorded — for a bubble replayed after a restart.
  conversationAttachment: (input: ConversationAttachmentInput) => Promise<ConversationAttachmentResult>
  // A plan the agent proposed, as a file the workspace pane can open: the
  // agent's own plan file while it still holds that plan, otherwise a copy in
  // app data.
  conversationPlanDocument: (input: ConversationPlanDocumentInput) => Promise<ConversationPlanDocumentResult>
  conversationLoadEarlier: (input: ConversationLoadEarlierInput) => Promise<ConversationPageResult>
  conversationTurnDiff: (input: ConversationTurnDiffInput) => Promise<ConversationTurnDiffResult>
  conversationRevertToTurn: (input: ConversationRevertInput) => Promise<ConversationRevertResult>
  // Take the conversation back to before one of its user messages ("Edit from
  // here"); gated on the provider's `rewind` capability.
  conversationRewindToTurn: (input: ConversationRewindInput) => Promise<ConversationRewindResult>
  // Start a new chat holding this one up to an earlier message ("Fork from
  // here"); gated on the provider's `fork` capability.
  conversationForkAtTurn: (input: ConversationForkInput) => Promise<ConversationForkResult>
  conversationApprovalRules: () => Promise<ConversationApprovalRulesResult>
  conversationThreads: (input: ConversationWorkspaceKey) => Promise<ConversationThreadsResult>
  conversationSearch: (input: ConversationSearchInput) => Promise<ConversationSearchResult>
  onConversationSearchBatch: (
    callback: (batch: { requestId: string; hits: ConversationSearchHit[] }) => void,
  ) => () => void
  conversationCancelSearch: (input: { requestId: string }) => Promise<{ ok: boolean }>
  conversationRename: (input: ConversationRenameInput) => Promise<{ ok: true } | { ok: false; message: string }>
  conversationDelete: (input: ConversationTranscriptInput) => Promise<{ ok: true } | { ok: false; message: string }>
  conversationRevokeApprovalRule: (input: { ruleId: string }) => Promise<ConversationApprovalRuleRevokeResult>
  onConversationSession: (
    input: ConversationSubscribeInput,
    cb: (frame: ConversationSessionFrame) => void,
  ) => () => void
  /** Every chat's lifecycle and step events, without their payloads: a sign that a chat moved. */
  onConversationEvent: (cb: (event: ConversationEvent) => void) => () => void
  logDiagnostic: (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder: () => Promise<{ opened: true; path: string }>
  updateGetState: () => Promise<AppUpdateState>
  updateCheck: () => Promise<AppUpdateCheckResult>
  updateDownload: () => Promise<AppUpdateCheckResult>
  updateQuitAndInstall: () => Promise<AppUpdateCheckResult>
  /**
   * Relaunch the app, asked about like a quit when agents are working. Absent
   * where there is no app to relaunch (a browser tab).
   */
  restartApp?: () => Promise<AppRestartResult>
  updateOpenReleaseNotes: () => Promise<{ opened: true; url: string }>
  /** The release channel the updater follows, and whether the person chose it. */
  /** The Studio server: its phase in words, the Advanced toggle, and the actions on it. */
  studioServerStatus: () => Promise<StudioServerStatus>
  studioServerInfo: () => Promise<StudioServerInfo | null>
  studioServerRetry: () => Promise<void>
  studioServerRestart: () => Promise<void>
  studioServerOpenLog: () => Promise<boolean>
  studioServerSetMode: (mode: ServerMode) => Promise<StudioServerStatus>
  studioServerRelaunch: (options?: { compatibility?: boolean }) => Promise<void>
  onStudioServerStatus: (cb: (status: StudioServerStatus) => void) => () => void
  updateGetChannel: () => Promise<AppUpdateChannelSetting>
  /** Save a channel choice, re-point the updater at it and check that channel. */
  updateSetChannel: (channel: AppUpdateTrack) => Promise<AppUpdateCheckResult>
  /** Download updates as soon as they are found, or wait to be asked (the default). */
  updateSetAutoDownload: (enabled: boolean) => Promise<AppUpdateState>
  /** The last update's result has been shown; stop reporting it. */
  updateDismissInstallOutcome: () => Promise<AppUpdateState>
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
  /** Read main's agent-launch settings: the record (null before any write) and the settings in force. */
  launchSettingsGet: () => Promise<AgentLaunchSettingsSnapshot>
  /** Apply a partial write to main's launch settings; the answer carries the record main now holds. */
  launchSettingsUpdate: (patch: AgentLaunchSettingsPatch) => Promise<AgentLaunchSettingsWriteAck>
  /**
   * Offer this window's pre-ownership localStorage values once. Main accepts
   * only while it holds no record; `changed: false` is a refusal.
   */
  launchSettingsMigrate: (settings: AgentLaunchSettings) => Promise<AgentLaunchSettingsWriteAck>
  /** Every change to main's launch settings, as the new record. Returns the unsubscribe. */
  onLaunchSettingsChanged: (cb: (record: AgentLaunchSettingsRecord) => void) => () => void
  /**
   * The machines this computer offers: this one, then (on Windows) its WSL
   * distributions — every one with `all`, the enabled ones otherwise.
   * `refresh` asks WSL again rather than answering from what it last said.
   */
  hostsList: (options?: { refresh?: boolean; all?: boolean }) => Promise<HostsListResult>
  /** A WSL machine's home, as the UNC path the folder picker opens at. */
  hostsHome: (hostId: ExecutionHostId) => Promise<HostHomeResult>
  /** The machine list may read differently now; ask again. Returns the unsubscribe. */
  onHostsChanged: (cb: () => void) => () => void
  /** SSH machines (phase 8): saved, with their state in words. */
  sshEnvironmentsList: () => Promise<SshEnvironmentSummary[]>
  /** What `ssh -G` makes of a destination, shown before it is saved. */
  sshEnvironmentResolve: (destination: string) => Promise<SshResolveResult>
  /** The plain `Host` names in the person's SSH config. */
  sshEnvironmentSuggestions: () => Promise<string[]>
  sshEnvironmentAdd: (input: { destination: string; label?: string }) => Promise<SshEnvironmentResult & { id?: string }>
  sshEnvironmentUpdate: (
    id: string,
    patch: Partial<SshEnvironmentSettings> & { label?: string },
  ) => Promise<SshEnvironmentResult>
  /** Connect now, as the person asked: ssh's questions may be shown. */
  sshEnvironmentConnect: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentDisconnect: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentStopServer: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentUpgradeServer: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentForget: (
    id: string,
    options?: { stopServer?: boolean; clearBrowsingData?: boolean },
  ) => Promise<SshEnvironmentResult>
  sshEnvironmentDiagnostics: (id: string) => Promise<{ ok: true; text: string } | { ok: false; message: string }>
  /** Sign a chat's CLI in on an SSH machine, with no terminal (decision R34). */
  sshSignIn: (id: string, providerId: string) => Promise<SshEnvironmentResult>
  onSshEnvironmentsChanged: (cb: () => void) => () => void
  /** ssh asks something; answer with `sshPromptAnswer`. */
  onSshPrompt: (cb: (request: SshPromptRequest) => void) => () => void
  /** A prompt is over without this window's answer (timed out, answered elsewhere, ssh gave up). */
  onSshPromptClosed: (cb: (id: string) => void) => () => void
  sshPromptAnswer: (id: string, answer: string | null) => void
  /** The SSH machines preview switch: this session's, and the next launch's. */
  sshPreviewStatus: () => Promise<SshPreviewStatus>
  sshPreviewSet: (enabled: boolean) => Promise<SshPreviewStatus>
  writefile: (path: string, content: string) => Promise<void>
  /**
   * Save one pasted/dropped image that exists only as bytes (a clipboard
   * screenshot, an image dragged out of a browser) into the app's temp images
   * folder, returning the absolute path an agent can read. An image dropped
   * from the OS already has a path and never comes through here.
   */
  saveDroppedImage: (input: { mediaType: string; dataBase64: string }) => Promise<string>
  /**
   * Open one conversation image attachment in the operating system's own image
   * viewer. The attachment exists only as base64 in the renderer, so the bytes
   * are written to the app's temp images folder first; `name` is a suggestion
   * for what that file is called, never a path.
   */
  openImageAttachment: (input: { mediaType: string; dataBase64: string; name?: string }) => Promise<void>
  createFile: (parentDir: string, name: string) => Promise<string>
  createDir: (parentDir: string, name: string) => Promise<string>
  ensureDir: (parentDir: string, name: string) => Promise<string>
  renamePath: (sourcePath: string, nextName: string) => Promise<string>
  movePath: (sourcePath: string, destinationDir: string) => Promise<string>
  copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
  copyPathInto: (sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }) => Promise<string>
  deletePath: (targetPath: string) => Promise<void>
  showItemInFolder: (targetPath: string) => Promise<void>
  openHtmlFileInBrowser: (targetPath: string) => Promise<void>
  listFolderOpenTargets: () => Promise<FolderOpenTargetAvailability[]>
  openFolderInTarget: (request: FolderOpenRequest) => Promise<FolderOpenResult>
  /**
   * Watch a directory tree. Events under `.git/`, `node_modules/`,
   * `.sprintengine/` and build output are dropped in main unless
   * `includeIgnored` is set; a burst arrives as one event naming its paths.
   */
  watchPath: (
    path: string,
    cb: (event: FileWatchEvent) => void,
    options?: { includeIgnored?: boolean },
  ) => Promise<() => Promise<void>>
  openDir: (options?: { defaultPath?: string }) => Promise<string | null>
  /** Creates `~/.sprintengine/skills` if needed and returns its absolute path. */
  ensureDefaultUserSkillsDir: () => Promise<string>
  defaultWorkspaceParentDir: () => Promise<string | null>
  /** Creates `~/.sprintengine/chats` if needed and returns it: New chat's "No project" scope. */
  projectlessChatsRoot: () => Promise<string>
  /** Makes a new folder in that root for one chat started without a project, named after its first words. */
  createProjectlessChatFolder: (prompt?: string) => Promise<string>
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) => Promise<boolean>
  clipboardReadText: () => Promise<string>
  clipboardWriteText: (text: string) => Promise<void>
  // What this machine actually has: probed `git`/`gh` versions plus gh's own
  // auth login. Read-only and argument-free — see src/shared/version-control.ts.
  probeVersionControlProviders: () => Promise<VersionControlProviderProbe[]>
  /**
   * A WSL machine's `gh`: installed, its version, and whether it holds a
   * token for github.com. Read-only; null when the machine did not answer.
   * Absent in a browser tab, which has no WSL machines of its own.
   */
  probeHostGh?: (hostId: string) => Promise<HostGhStatus | null>
  getGitRepoRoot: (folderPath: string, hostId?: string) => Promise<string | null>
  getGitStatus: (repoRoot: string) => Promise<GitStatusSnapshot>
  /**
   * Which of `relativePaths` the ignore rules cover — one `check-ignore` per
   * call, batched by the caller. Paths are relative to `repoRoot` with forward
   * slashes, and the reply echoes the same strings back.
   *
   * The answer depends on the path EXISTING: a rule written `out/` matches only
   * a directory, and directory-ness is read off the disk. Ask about entries you
   * have listed, never about speculative ones.
   */
  checkIgnored: (repoRoot: string, relativePaths: string[]) => Promise<string[]>
  /**
   * The branch reading for one checkout — the worktree the workspace's agents
   * run in when it has one, else its folder. Resolved by the caller, because
   * only the renderer holds the workspace's worktree record.
   */
  getWorkspaceChangeSummary: (checkoutPath: string) => Promise<WorkspaceChangeSummary>
  /**
   * Be told when a checkout's git readings go stale, instead of polling for it.
   * Main watches the checkout's git directory while any listener in any window
   * wants it, holds changes while no window is focused, and sends a slow
   * fallback. Returns the unsubscribe.
   */
  watchGitCheckout: (checkoutPath: string, cb: (change: GitCheckoutChange) => void) => () => void
  /** Remove agent worktrees that are clean and merged; report (and keep) the rest. */
  cleanupAgentWorktrees: (input: AgentWorktreeCleanupInput) => Promise<AgentWorktreeCleanupReport>
  /** A repository's worktree pool (main's worktree-pool/), or null when it has none. */
  getWorktreePoolSnapshot: (repoRoot: string) => Promise<WorktreePoolSnapshot | null>
  /** Every change to any pool's slots, as that pool's snapshot. */
  onWorktreePoolChanged: (cb: (snapshot: WorktreePoolSnapshot) => void) => () => void
  /** A person's decision on a held pool worktree, or the removal or clearing of an idle one. */
  worktreePoolAction: (input: WorktreePoolActionInput) => Promise<WorktreePoolActionResult>
  /**
   * Remove a worktree the pool does not own, checked as a pool eviction is:
   * kept, with the reason, when something works in it or it may hold work.
   */
  removeOtherWorktree: (input: { repoRoot: string; path: string }) => Promise<WorktreePoolActionResult>
  getWorktreePoolSettings: () => Promise<WorktreePoolSettings>
  setWorktreePoolSettings: (patch: Partial<WorktreePoolSettings>) => Promise<WorktreePoolSettings>
  /** Every worktree of these projects and of every pool, for Settings ▸ Worktrees. */
  getWorktreeInventory: (input: WorktreeInventoryInput) => Promise<WorktreeInventory>
  /** The dependency installs leased worktrees are running now. */
  listWorktreeInstalls: () => Promise<WorktreeDependencyInstallView[]>
  /** A leased worktree's dependency install started, moved on, or ended. */
  onWorktreeInstallChanged: (cb: (view: WorktreeDependencyInstallView) => void) => () => void
  /** Stop a running install; its agent starts as after a failed one. False when it had already ended. */
  cancelWorktreeInstall: (id: string) => Promise<boolean>
  /**
   * The branch's commits as steps, oldest first, for the changed-files surface.
   * Read live on every call — a rebase re-identifies commits, so a cached strip
   * would be confidently wrong about work that no longer exists.
   */
  getBranchSteps: (checkoutPath: string) => Promise<BranchStepsSnapshot>
  /** The files and line counts for one step, or for the whole span. */
  getBranchStepDiff: (checkoutPath: string, selection: BranchStepSelection) => Promise<BranchStepDiff>
  /**
   * A file's content at a revision, for one side of a step's diff. `absent` is
   * the correct original side for an addition and modified side for a deletion —
   * and also what a rejected rev or an out-of-repo path resolves to, so a caller
   * renders an empty pane rather than an error.
   */
  getGitFileAtRev: (repoRoot: string, rev: string, filePath: string) => Promise<RevFileResult>
  getGitFileBase: (repoRoot: string, filePath: string) => Promise<GitFileBaseResult>
  getGitFileAtStage: (repoRoot: string, filePath: string, stage: GitFileStage) => Promise<GitFileStageResult>
  getGitBranches: (repoRoot: string) => Promise<GitBranchSnapshot>
  /**
   * Which repository a folder is a clone of — its primary remote, normalised
   * (one-project-across-machines). A null `identity` is a non-repo or a
   * remote-less one; `settled: false` is a read that could not be made at all
   * (a spun-down volume, git unavailable), which is NOT the same answer and
   * must not be written down as one. See `RepositoryIdentityRead`.
   */
  getGitRepositoryIdentity: (folderPath: string) => Promise<RepositoryIdentityRead>
  /** A folder's branch and remotes, for a capability module's `getWorkspaceGitInfo`. */
  getModuleWorkspaceGitInfo: (folderPath: string) => Promise<ModuleWorkspaceGitInfoResult>
  getGitCommitGraph: (repoRoot: string, options?: GitGraphOptions) => Promise<GitGraphSnapshot>
  getGitConflictFile: (repoRoot: string, filePath: string) => Promise<GitConflictFileContent | null>
  resolveGitConflict: (repoRoot: string, filePath: string, content: string) => Promise<GitCommandResult>
  /**
   * The hunks of the diff the viewer is showing for one file, plus the whole
   * file's "N differences, M included" counter (git-commit-window T7).
   */
  getGitFileHunks: (repoRoot: string, filePath: string, scope: GitHunkScope) => Promise<GitFileHunksResult>
  /** Put one hunk of the working tree into the index — `git apply --cached`. */
  stageGitHunk: (ref: GitHunkRef) => Promise<GitCommandResult>
  /** Take one hunk back out of the index — the same patch, reversed. */
  unstageGitHunk: (ref: GitHunkRef) => Promise<GitCommandResult>
  stageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  unstageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  revertGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  commitGitChanges: (repoRoot: string, message: string) => Promise<GitCommandResult>
  pushGitBranch: (repoRoot: string) => Promise<GitCommandResult>
  fetchGitRemotes: (repoRoot: string) => Promise<GitCommandResult>
  pullGitBranchWithStash: (repoRoot: string) => Promise<GitCommandResult>
  switchGitBranch: (repoRoot: string, branchName: string) => Promise<GitCommandResult>
  mergeGitRef: (repoRoot: string, ref: string) => Promise<GitCommandResult>
  rebaseGitBranch: (repoRoot: string, ontoRef: string) => Promise<GitCommandResult>
  cherryPickGitCommit: (repoRoot: string, commitHash: string) => Promise<GitCommandResult>
  revertGitCommit: (repoRoot: string, commitHash: string) => Promise<GitCommandResult>
  resetGitBranchToCommit: (repoRoot: string, commitHash: string, mode: GitResetMode) => Promise<GitCommandResult>
  deleteGitBranch: (repoRoot: string, branchName: string, force?: boolean) => Promise<GitCommandResult>
  renameGitBranch: (repoRoot: string, branchName: string, newName: string) => Promise<GitCommandResult>
  continueGitOperation: (repoRoot: string, operation: GitRepoOperation) => Promise<GitCommandResult>
  abortGitOperation: (repoRoot: string, operation: GitRepoOperation) => Promise<GitCommandResult>
  listGitStashes: (repoRoot: string) => Promise<GitStashListSnapshot>
  pushGitStash: (repoRoot: string, message: string, includeUntracked?: boolean) => Promise<GitCommandResult>
  applyGitStash: (repoRoot: string, index: number, expectedHash: string, pop?: boolean) => Promise<GitCommandResult>
  dropGitStash: (repoRoot: string, index: number, expectedHash: string) => Promise<GitCommandResult>
  checkoutGitCommit: (repoRoot: string, commitHash: string) => Promise<GitCommandResult>
  checkoutGitCommitAsBranch: (repoRoot: string, branchName: string, commitHash: string) => Promise<GitCommandResult>
  createGitTagFromCommit: (repoRoot: string, tagName: string, commitHash: string) => Promise<GitCommandResult>
  listGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>>
  createGitWorktree: (input: GitWorktreeCreateInput) => Promise<GitWorktreeOperationResult<GitWorktreeCreated>>
  /** Recreate a chat's worktree the cleanup gave back, at its old path, from the branch it kept. */
  restoreGitWorktree: (input: GitWorktreeRestoreInput) => Promise<GitWorktreeRestoreResult>
  removeGitWorktree: (input: GitWorktreeRemoveInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  pruneGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  /** Lift an in-use lock the app placed on an agent worktree (never a lock a person placed). */
  unlockAgentGitWorktree: (
    repoRoot: string,
    worktreePath: string,
  ) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  /**
   * This repository's changelists, pruned against `git status` before they are
   * answered (git-commit-window T6). Every call below answers with the whole
   * reconciled set for the same reason.
   */
  getGitChangelists: (repoRoot: string) => Promise<Changelist[]>
  /** Which list new changes land in. Exactly one is active, always. */
  setActiveGitChangelist: (repoRoot: string, id: string) => Promise<Changelist[]>
  createGitChangelist: (
    repoRoot: string,
    input: { name: string; comment?: string; activate?: boolean; paths?: string[] },
  ) => Promise<Changelist[]>
  renameGitChangelist: (
    repoRoot: string,
    id: string,
    input: { name: string; comment?: string },
  ) => Promise<Changelist[]>
  /** Delete a list; its paths return to the default, which cannot be deleted. */
  deleteGitChangelist: (repoRoot: string, id: string) => Promise<Changelist[]>
  moveGitChangelistPaths: (repoRoot: string, id: string, paths: string[]) => Promise<Changelist[]>
  /**
   * Main has written a repository's changelists itself — an agent launched,
   * edited or exited, and its list moved without any window asking for it. The
   * renderer re-reads for a matching root; the payload carries the root and
   * nothing else, because the store's answer is always the WHOLE reconciled set
   * and a pushed copy of it could only ever be the older one.
   */
  onGitChangelistsChanged: (cb: (event: { repoRoot: string }) => void) => () => void
  /** `git diff` (or `--cached`) of the named paths, as patch text. */
  createGitPatch: (repoRoot: string, paths: string[], cached?: boolean) => Promise<GitPatchResult>
  /** The same text, through the OS save dialog. */
  saveGitPatch: (repoRoot: string, patch: string, defaultFileName?: string) => Promise<GitPatchSaveResult>
  getGitHubTokenStatus: () => Promise<GitHubTokenStatus>
  setGitHubToken: (token: string) => Promise<GitHubTokenStatus>
  clearGitHubToken: () => Promise<GitHubTokenStatus>
  listGitHubRepos: () => Promise<GitHubRepoListResult>
  cloneGitHubRepo: (input: GitHubCloneInput) => Promise<GitHubCloneResult>
  detectExistingAgentConfig: (input?: AgentConfigDetectInput) => Promise<AgentConfigDetectResult>
  adoptAgentConfig: (input: AgentConfigAdoptInput) => Promise<AgentConfigAdoptResult>
  scanImportableConversations: () => Promise<ConversationImportScanResult>
  importConversations: (input: ConversationImportInput) => Promise<ConversationImportResult>
  mcpSync: (input: McpSyncInput) => Promise<McpSyncResult>
  workspaceSkillsList: (input: WorkspaceSkillsListInput) => Promise<WorkspaceSkillsListResult>
  installedSkillsList: (input: InstalledSkillsInput) => Promise<InstalledSkillsResult>
  installedSkillRemove: (input: InstalledSkillRemoveInput) => Promise<InstalledSkillRemoveResult>
  // Everything the agent in one CLI can reach in one workspace, in one call:
  // its skills, its MCP servers, and any path that failed to read.
  agentCapabilities: (input: AgentCapabilitiesInput) => Promise<AgentCapabilitiesResult>
  // Put one skill where every installed, skill-capable CLI reads it, and take
  // it away again. Both report per target and neither returns the new list: the
  // write invalidates, and the surface re-reads through agentCapabilities.
  agentSkillAttach: (input: AgentSkillWriteInput) => Promise<AgentSkillWriteResult>
  skillsListSources: () => Promise<SkillSourcesResult>
  skillsAddSource: (input: SkillAddSourceInput) => Promise<SkillAddSourceResult>
  skillsAddLocalSource: (input: SkillAddLocalSourceInput) => Promise<SkillAddSourceResult>
  skillsRemoveSource: (input: SkillRemoveSourceInput) => Promise<SkillRemoveSourceResult>
  skillsGetScan: (input: SkillScanInput) => Promise<SkillScanOutcome>
  skillsReadFile: (input: SkillReadFileInput) => Promise<SkillReadFileResult>
  skillsInstall: (input: SkillInstallInput) => Promise<SkillInstallOutcome>
  skillsUninstall: (input: SkillUninstallInput) => Promise<SkillUninstallOutcome>
  skillsSyncSource: (input: SkillSyncSourceInput) => Promise<SkillSyncSourceOutcome>
  skillsSearch: (input: SkillSearchInput) => Promise<SkillSearchOutcome>
  skillsListPopularRepos: () => Promise<SkillPopularReposOutcome>
  skillsScanLinkedPlugin: (input: SkillPluginScanLinkedInput) => Promise<SkillPluginScanLinkedOutcome>
  skillsInstallPlugin: (input: SkillPluginInstallInput) => Promise<SkillPluginInstallOutcome>
  skillsUninstallPlugin: (input: SkillPluginUninstallInput) => Promise<SkillPluginUninstallOutcome>
  skillsListInstalledPlugins: (input: SkillInstalledPluginsInput) => Promise<SkillInstalledPluginsOutcome>
  /** Every check's result, pushed from main — the poller's hourly leg or a manual check. */
  /**
   * Ask for an update check now. Same check the hourly poller leg runs, under
   * the same per-source cadence window: a source inside its window is
   * reported in `skipped` with the sentence saying when it was last checked and
   * why it is waiting, rather than being asked again.
   */
  skillsCheckSourceUpdates: () => Promise<SkillSourceUpdateCheck>
  onSkillSourcesUpdated: (cb: (check: SkillSourceUpdateCheck) => void) => () => void
  cliDetect: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliDetectResult>
  cliInstallMethods: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallMethodInfo[]>
  cliInstall: (input: CliInstallInput, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallResult>
  cliUpdate: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallResult>
  onCliInstallOutput: (cli: AgentCli, cb: (chunk: string) => void) => () => void
  // Model discovery (src/shared/ipc/cli-model-discovery.ts): ask the installed
  // CLIs which models they accept. `discover` answers per CLI, skipping any that
  // are fresh, absent or unprobeable; `changed` pushes every catalog a probe
  // produced, whoever asked, and returns the unsubscribe.
  cliModelsDiscover: (input?: CliModelDiscoveryInput) => Promise<CliModelDiscoveryResult>
  onCliModelsChanged: (cb: (result: CliModelDiscoveryResult) => void) => () => void
  // A chat composer's slash commands for one CLI in one folder, and every
  // list main hears afterwards (src/main/conversation-commands).
  conversationCommands: (input: ConversationCommandsRequest) => Promise<ConversationCommandCatalog>
  onConversationCommandsChanged: (listener: (catalog: ConversationCommandCatalog) => void) => () => void
  // The subscription usage limits (five-hour and weekly windows) the agents
  // reported, per provider, and every change main hears afterwards
  // (src/main/usage-limits).
  usageLimits: () => Promise<UsageLimitsState>
  onUsageLimitsChanged: (listener: (state: UsageLimitsState) => void) => () => void
  // The chats a usage limit stopped, with the resume each has scheduled, and
  // the setting that schedules one for every such chat (usage-limits/resume.ts).
  usageLimitResumes: () => Promise<UsageLimitResumeState>
  updateUsageLimitResume: (update: UsageLimitResumeUpdate) => Promise<UsageLimitResumeState>
  onUsageLimitResumesChanged: (listener: (state: UsageLimitResumeState) => void) => () => void
  // The messages a person scheduled into a chat from its composer's "+", sent
  // when their time comes (src/main/scheduled-messages), and every change after.
  scheduledMessages: () => Promise<ScheduledMessagesState>
  updateScheduledMessage: (update: ScheduledMessageUpdate) => Promise<ScheduledMessagesState>
  onScheduledMessagesChanged: (listener: (state: ScheduledMessagesState) => void) => () => void
  // One-shot text generation on the person's own agent CLI (their login, no
  // API key): today the chat title from a first prompt. Never rejects — a
  // failure is a typed `{ ok: false }` the caller answers by keeping what it
  // had. See src/shared/text-generation/contract.ts.
  generateChatTitle: (request: ChatTitleRequest) => Promise<TextGenerationResult>
  // Renderer → main mirror of `appSettings.textGeneration`. The process that
  // runs the chats titles them by this copy, with or without a window open.
  setTextGenerationSettings: (settings: TextGenerationSettings) => Promise<void>
  // The chat's "Create PR" (src/main/pull-request-create.ts): whether it may
  // show for a checkout, a drafted title and description, the push, and the
  // creation. This computer's checkouts only. Never rejects.
  createPullRequestState: (cwd: string) => Promise<CreatePullRequestState | null>
  draftPullRequestText: (request: {
    cwd: string
    engine: ChatTitleRequest['engine']
    cliRuntimes?: ChatTitleRequest['cliRuntimes']
    /** Names the draft, so `cancelPullRequestDraft` can stop its CLI. */
    draftId?: string
  }) => Promise<PullRequestTextResult>
  /** The dialog closed while its draft was being written: the drafting CLI is stopped. */
  cancelPullRequestDraft: (draftId: string) => Promise<void>
  /** `pin`: the branch and commit the person confirmed; refused when the checkout has moved off it. */
  pushForPullRequest: (cwd: string, pin?: PullRequestCheckoutPin) => Promise<PushForPullRequestOutcome>
  createPullRequest: (input: {
    cwd: string
    title: string
    body: string
    pin?: PullRequestCheckoutPin
  }) => Promise<CreatePullRequestOutcome>
  /** Create a new design-system bundle in a user-chosen folder — seeded from an existing bundle, or bare from the shipped templates. Never overwrites; rolls back on failure. */
  seedDesignSystemBundle: (
    sourceDir: string | null,
    targetDir: string,
    name: string,
    summary: string,
  ) => Promise<DesignSystemScaffoldResult>
  /**
   * Run a bundle's own scripts/lint.mjs on demand (the bundle author's
   * contribution gate). NO CALLER as of 2026-09-08 — the orphan sweep found the
   * method reachable from nothing but its preload implementation. Kept rather
   * than deleted because it is the only programmatic route to a real, tested
   * capability (`src/main/design-system/bundle-lint-run.ts` and the
   * pipeline round-trip's author gate); the owner decides whether the Design
   * door's bundle view should call it or the whole chain should go.
   */
  lintDesignSystemBundle: (bundleDir: string) => Promise<DesignSystemBundleLintRunResult>
  /** Read one design-system bundle directory for the Design door: identity, accent resolved from the token SOURCE, and the parsed manifest. Read-only — never writes, never forks a bundle script. */
  readDesignSystemBundle: (bundleDir: string) => Promise<DesignSystemBundleReadResult>
  /** List the library: every registered folder, probed live for its source state. */
  listDesignSystemLibrary: () => Promise<DesignSystemLibraryListResult>
  /** The same library reduced to arrival dates — one `addedAt` map per readable bundle, for the Extensions drawer's Design count. Never inlines an asset; a broken registration is skipped. */
  listDesignSystemArrivals: () => Promise<DesignSystemArrivalsResult>
  /** Point the library at a folder on disk. Registers a reference — copies nothing. */
  registerDesignSystemFolder: (folderPath: string) => Promise<DesignSystemRegisterResult>
  /** Drop a registration. Removes the reference only; the user's folder is untouched. */
  forgetDesignSystemFolder: (id: string) => Promise<{ ok: true; forgotten: boolean }>
  /** Attach a design-system bundle (library entry or browsed folder) to a workspace as a one-time copy at design-system/, provenance stamped. Refuses if design-system/ already exists. */
  attachDesignSystemBundle: (
    source: DesignSystemAttachSource,
    workspaceRoot: string,
  ) => Promise<DesignSystemAttachResult>
  /** Remove the workspace's design-system/ copy. Idempotent; the caller owns the destructive confirmation. */
  detachDesignSystemBundle: (workspaceRoot: string) => Promise<DesignSystemDetachResult>
  /** List installed third-party capability modules with trust, permissions, and launch readiness. */
  listThirdPartyModules: () => Promise<ThirdPartyModuleListResult>
  /** Install a third-party capability module from a folder (validated, not executed). */
  installThirdPartyModuleFolder: (srcDir: string) => Promise<ThirdPartyModuleInstallResult>
  /** Trust or untrust an installed third-party module. */
  setThirdPartyModuleTrust: (id: string, trusted: boolean) => Promise<ThirdPartyModuleTrustResult>
  /** Remove a third-party module however it was installed (folder, marketplace, GitHub), with its trust, enablement and secrets. */
  uninstallThirdPartyModule: (input: ThirdPartyModuleUninstallInput) => Promise<ThirdPartyModuleUninstallResult>
  /** Open an installed third-party module's folder. Absent where there is no file manager to open it in. */
  revealThirdPartyModule?: (id: string) => Promise<ThirdPartyModuleTrustResult>
  /** Serve trusted third-party modules' entry.renderer bundles for the renderer loader. */
  listThirdPartyRendererEntries: () => Promise<ThirdPartyRendererEntriesResult>
  /** Install/trust changed; renderer-only modules may now be available. */
  onThirdPartyModulesChanged: (cb: () => void) => () => void
  /** Renderer→module-main bridge: invoke a channel a third-party module registered via registerIpc. Refusals are structured, not rejections. */
  moduleBridgeInvoke: (channel: string, payload?: unknown) => Promise<ModuleBridgeInvokeResult>
  /** A module renderer's call into a host service its main half reaches through the SDK (Backlog writes, usage). Answers are result-shaped. */
  moduleHostServiceInvoke: (request: ModuleHostServiceRequest) => Promise<unknown>
  /** Every capability module's main→renderer events on one host-owned channel; the renderer kernel fans them out by `sourceModuleId`. Returns the unsubscriber. */
  onModuleEvent: (cb: (envelope: ModuleEventEnvelope) => void) => () => void
  /** Every module's `notify` rows, as the kernel delivers them to each window's bell. Returns the unsubscriber. */
  onModuleNotification: (cb: (notification: ModuleNotificationDelivery) => void) => () => void
  /** The kernel's recent module notifications, oldest first: what a window that just booted has not heard. */
  listRecentModuleNotifications: () => Promise<ModuleNotificationDelivery[]>
  terminalSpawn: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata,
  ) => Promise<TerminalSpawnResult>
  terminalWrite: (sessionId: string, data: string) => Promise<void>
  terminalWriteFast: (sessionId: string, data: string) => void
  terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
  terminalStatus: (sessionId: string) => Promise<{ processAlive: boolean; suspended: boolean }>
  terminalList: () => Promise<TerminalSessionSnapshot[]>
  terminalSetVisible: (sessionId: string, visible: boolean, options?: TerminalVisibilityOptions) => Promise<void>
  // Freeze-the-view: suspend kills the agent process but keeps the painted,
  // resumable session; resume relaunches it (mirrors terminalSpawn's payload,
  // forced --resume) on the first keystroke.
  terminalSuspend: (sessionId: string) => Promise<void>
  terminalResume: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata,
  ) => Promise<TerminalSpawnResult>
  terminalKill: (sessionId: string) => Promise<void>
  // Push the user's "Pause idle terminals after" setting (ms) to the main reap
  // policy. Clamped/validated in main; the next idle sweep uses the latest value.
  setTerminalIdleSuspendMs: (ms: number) => Promise<void>
  // Push the user's "Always keep running" count — the recency floor below which
  // the idle reaper never pauses live agent terminals. Clamped/validated in main.
  setTerminalKeepRecentAliveCount: (count: number) => Promise<void>
  // Toggle the per-terminal user lock: while set, the reaper never suspends or
  // disposes this session. Broadcasts a sessions delta so the lock
  // state stays in sync across views.
  setTerminalReapExempt: (sessionId: string, exempt: boolean) => Promise<void>
  onTerminalReplay: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
  onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
  // What changed among the sessions — the changed ones and the ids of the gone
  // ones, never the whole list (`terminalList` is that).
  onTerminalSessionsDelta: (cb: (delta: TerminalSessionsDelta) => void) => () => void
  // First messages main could not type into their agent CLIs wait in main until
  // a workspace window takes them (once: the first to ask gets them). The event
  // says there is something to take; a window also asks when it mounts, so one
  // that opens later still hands them back.
  onTerminalPromptUndelivered: (cb: () => void) => () => void
  terminalTakeUndeliveredPrompts: () => Promise<TerminalPromptUndelivered[]>
  // Flow control: tell main the pane has parsed `units` UTF-16 units of the
  // session's live output, so it can pause the pty while a pane falls behind.
  terminalAck: (sessionId: string, units: number) => void
  // The conversation peek: what has been said in a chat the person is hovering
  // rather than looking at — the first message and everything since, from the
  // prompts this app captured. `source` says whether there is an answer, a
  // runtime that reports nothing, or no record at all, because the card is
  // required to say so rather than look broken. See `shared/conversation-peek.ts`.
  readConversationPeek: (sessionId: string) => Promise<ConversationPeek>
  // Compact a terminal agent's conversation: `/compact` at its prompt, once
  // main has checked the prompt is Claude Code's, waiting and empty
  // (terminalCompactBlocker in shared/prompt-cache.ts). Offered as its prompt
  // cache expires, so the next message re-sends a summary rather than all of it.
  compactAgentSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  // The hover hook for a terminal agent's pull request marks: the shell asks
  // the Studio server to look the session's branch up (once per key per hold)
  // and re-read any state older than ~60s. The pull requests themselves arrive as a fresh
  // `terminal:sessions-delta` carrying the session's `pullRequests`, never as
  // a return value, so one path owns the fact. The boolean says only whether
  // there was anything to ask about — false for a session main cannot name, or
  // one whose checkout has not resolved yet — so a caller that asks once per
  // session can tell "asked" from "could not ask yet" and try again.
  refreshPullRequestsForSession: (sessionId: string) => Promise<boolean>
  diagnosticsGetProcessMetrics: () => Promise<ProcessMetricsSnapshot>
  // Synchronous: returns the preload's accumulated IPC counters (empty channels
  // when diagnostics is disabled, since instrumentation is skipped entirely).
  diagnosticsGetIpcStats: () => IpcStatsSnapshot
  diagnosticsOpenWindow: () => Promise<void>
  onAppMenuCommand: (cb: (command: string) => void) => () => void
  updateAppMenuAccelerators: (updates: AppMenuAcceleratorUpdate[]) => Promise<AppMenuAcceleratorUpdateResult>
  workspaceBackupWrite: (payload: WorkspaceBackupPayload) => Promise<WorkspaceBackupWriteResult>
  workspaceBackupRead: () => Promise<WorkspaceBackupReadResult>
  setModuleEnablement: (overrides: ModuleEnablementOverrides) => Promise<ModuleEnablementWriteResult>
  // Renderer → main mirror of every module's app-level state (`module:<id>`
  // namespaces), so a module's entry.main reads its settings with no window.
  setModuleAppState: (bag: Record<string, Record<string, unknown>>) => Promise<void>
  // Renderer → main mirror of the module registry the user sees; main
  // caches the last push in memory for its own read surfaces.
  setModuleRegistrySnapshot: (snapshot: ModuleRegistrySnapshot) => Promise<ModuleRegistrySnapshotWriteResult>
  setColorScheme: (scheme: ColorScheme) => Promise<void>
  // `canvasColor` is the theme's opaque window ground (`#rrggbb`), sent with an
  // opaque material so main can paint new windows in it; omitted under glass.
  setWindowMaterial: (material: WindowMaterial, canvasColor?: string) => Promise<void>
  // Renderer → main mirror of `appSettings.keepRunningInBackground`.
  // Main reads it inside `window-all-closed`, when no renderer is left to ask.
  setBackgroundMode: (enabled: boolean) => Promise<void>
  // Renderer → main mirror of `appSettings.telemetryEnabled`. Main reads it on
  // every event it records, including ones emitted with no window open. This is
  // the whole renderer-facing telemetry surface — there is no channel for the
  // renderer to send an event, only this one to stop main sending them.
  setTelemetryEnabled: (enabled: boolean) => Promise<void>
  // "Ask before quitting while agents are working", which main owns: the quit
  // dialog's "Don't ask again" turns it off with no renderer involved. Both
  // answer with the value main now holds; null from a client with no quit of
  // its own to ask about (a browser tab).
  getQuitConfirmation: () => Promise<boolean | null>
  setQuitConfirmation: (enabled: boolean) => Promise<boolean | null>
  /** Whether agents are given the built-in browser's tools (Settings → Agents); null where main has none. */
  getAgentBrowserTools: () => Promise<boolean | null>
  setAgentBrowserTools: (enabled: boolean) => Promise<boolean | null>
  /** Banners for a chat that finished or waits on the person (Settings → General); null where main has none. */
  getAgentNotifications: () => Promise<AgentNotificationMode | null>
  setAgentNotifications: (mode: AgentNotificationMode) => Promise<AgentNotificationMode | null>
  // "Keep the computer awake while agents work", which main owns: it takes and
  // releases the power-save blocker as agents start and stop. Null from a
  // client whose machine is not this one to keep awake (a browser tab).
  getKeepAwake: () => Promise<boolean | null>
  setKeepAwake: (enabled: boolean) => Promise<boolean | null>
  resolveBacklogLocation: (workspaceRoot: string) => Promise<BacklogLocationResult>
  setBacklogRoot: (input: BacklogSetRootInput) => Promise<BacklogLocationResult>
  ensureBacklogObjectRecords: (workspaceRoot: string, items: BacklogItemRecordInput[]) => Promise<BacklogReadResult>
  ensureBacklogItemIds: (input: BacklogEnsureIdsInput) => Promise<BacklogEnsureIdsResult>
  updateBacklogStatus: (input: BacklogStatusInput) => Promise<BacklogMutationResult>
  updateBacklogTriage: (input: BacklogTriageInput) => Promise<BacklogMutationResult>
  updateBacklogHighlight: (input: BacklogHighlightInput) => Promise<BacklogMutationResult>
  addOrUpdateBacklogLink: (input: BacklogAddOrUpdateLinkInput) => Promise<BacklogMutationResult>
  removeBacklogLink: (input: BacklogRemoveLinkInput) => Promise<BacklogMutationResult>
  updateBacklogModuleMetadata: (input: BacklogModuleMetadataInput) => Promise<BacklogMutationResult>
  moveBacklogObjectSource: (input: BacklogMoveSourceInput) => Promise<BacklogMutationResult>
  removeBacklogObjectRecord: (input: BacklogRemoveRecordInput) => Promise<BacklogMutationResult>
  updateBacklogEpic: (input: BacklogEpicInput) => Promise<BacklogMutationResult>
  updateBacklogEpicColor: (input: BacklogEpicColorInput) => Promise<BacklogMutationResult>
  updateBacklogDependencies: (input: BacklogDependenciesInput) => Promise<BacklogMutationResult>
  updateBacklogMockups: (input: BacklogMockupsInput) => Promise<BacklogMutationResult>
  createBacklogEpic: (input: BacklogCreateEpicInput) => Promise<BacklogCreateEpicResult>
  // ── extension-platform additions ──
  // Build an extension (the New chat door's extension mode): the folder new
  // extensions are made in when the person picks none, what is at the
  // extension's folder while the name is typed (null for a name that is not
  // an id yet), and the project made there.
  extensionScaffoldHome: () => Promise<string>
  extensionScaffoldTarget: (input: ExtensionScaffoldTargetInput) => Promise<ExtensionScaffoldTarget | null>
  extensionScaffoldCreate: (input: ExtensionScaffoldCreateInput) => Promise<ExtensionScaffoldCreateResult>
}
