import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import type {
  Workspace,
  WorkspaceBacklogState,
  WorkspaceGitPanelState,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
  LayoutTemplate,
  AgentState,
  AgentId,
  CliPermissionPreset,
  AgentCli,
  AgentCliModelSelection,
  AgentConfigAdoptionResult,
  AgentConversationRuntime,
  AppSettings,
  CliRuntimeSettings,
  FollowUpBehavior,
  NewChatAgentChoice,
  AgentExecution,
  WorkspaceWorktreeState,
  WorktreeEntry,
  MemoryGraphSettings,
  WorkspaceHighlight,
  McpServerConfig,
} from '../types/workspace'
import type { AppTheme, ChatWidth, ClockFormat, ReplyStreaming, WindowMaterial } from '../types/appTheme'
import { noteLaunchedAgentArrived, type LaunchedAgentProjection } from '../utils/launchedAgentProjection'
import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import type { FolderOpenTargetId } from '../../../shared/folder-open-targets'
import type { BranchPullRequest } from '../../../shared/git/pull-request'
import type { TextGenerationWritingStyle } from '../../../shared/text-generation/writing-style'
import type { CommandId } from '../commands/commandRegistry'
import type { ExtensionsDrawerView } from '../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { createAuthSlice } from './slices/authSlice'
import {
  createSettingsSlice,
  normalizeAppSettings,
  type ChatListView,
  type DiffViewMode,
  type SettingsOverlayOptions,
  type SettingsOverlayState,
  type SidebarSection,
} from './slices/settingsSlice'
import { clampSidebarWidth } from '../components/workspace/sidebarWidth'
import { clampWorkspaceAsideWidth } from '../components/workspace/workspaceAsideWidth'
import {
  adoptLegacyBacklogTab,
  createWorkspacePaneSlice,
  type WorkspacePaneSliceActions,
} from './slices/workspacePaneSlice'
import { createFocusedAgentSlice, type FocusedAgentSlice } from './slices/focusedAgentSlice'
import { createWorkspacesSlice, type SoloChatSeed, type WorkspacesSliceDependencies } from './slices/workspacesSlice'
import {
  createLayoutSlice,
  healRetiredRailLayout,
  stripRetiredRailTabsFromLayout,
  hideNavRailTabStrip,
} from './slices/layoutSlice'
import {
  createAgentsSlice,
  defaultAgent,
  defaultEditorState,
  isPathOrChild,
  normalizeAgentState,
  pickWorkspaceAgentName,
} from './slices/agentsSlice'
import {
  createWorktreesSlice,
  defaultWorkspaceWorktreeState,
  normalizeWorkspaceWorktreeState,
} from './slices/worktreesSlice'
import { createMemorySlice, defaultWorkspaceMemoryConfig } from './slices/memorySlice'
import { createCliAvailabilitySlice, type CliAvailabilitySlice } from './slices/cliAvailabilitySlice'
import { createPluginsSlice, type PluginsSlice } from './slices/pluginsSlice'
import { createHostedCardFeedSlice, type HostedCardFeedSlice } from './slices/hostedCardFeedSlice'
import { createCliVersionAdvisorySlice, type CliVersionAdvisorySlice } from './slices/cliVersionAdvisorySlice'
import {
  dropRetiredModeWorkspaces,
  nameGenericWorkspaceAgents,
  normalizeWorkspaceForPartialize,
} from './slices/normalizers'
import { keepLaterWorkspaceClocks } from '../utils/workspaceRecency'
import { isSettledWorkspace } from '../utils/workspaceSettle'
import { isSnoozeUnexpired } from '../utils/workspaceSnooze'
import { noteWorkspaceSettledElsewhere, noteWorkspaceSnoozedElsewhere } from '../utils/settledElsewhere'
import { isPlaceholderAgentName } from '../utils/agentNames'
import { applyWorkspaceFieldsPatch } from '../../../shared/workspace-sync'
import { isRetiredWorkspaceMode } from '../../../shared/workspace-mode'
import {
  configureWorkspaceSyncClient,
  workspaceSyncClient,
  type AgentTerminalLaunchStateApply,
  type AgentTerminalSessionApply,
  type WorkspaceActiveChangedApply,
  type WorkspaceClosedApply,
  type WorkspaceCreatedApply,
  type WorkspaceMovedApply,
  type WorkspacePlacementApply,
} from './workspaceSyncClient'
import {
  APP_SETTINGS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  type HydrationDiagnostic,
  type HydrationStorageSource,
  type PersistedStateClassification,
  type WorkspaceMigrationState,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
  migrateLegacyWorkspaceStorageKey,
  migratePersistedWorkspaceState,
  normalizeWorkspaceWindows,
} from './slices/persistenceSlice'
import { isLegacyV44WorkspaceEnvelope, splitLegacyV44Envelope } from './repositories/workspaceRegistry'
import type { AgentLaunchSettings } from '../../../shared/launch-settings'
import { launchSettingsApiFromWindow, launchSettingsClient } from './launchSettingsClient'
import { migrateLegacyCliPermissionPresets } from './legacyCliPermissionPresets'
import { onWindowVisibilityChange } from '../utils/windowActivity'
import {
  launchSettingsFieldsEqual,
  launchSettingsFromAppSettings,
  persistedLaunchSettingsFields,
  withLaunchSettings,
  withoutLaunchSettings,
} from './launchSettingsReadModel'
import type {
  ProjectColorSetting,
  WorkspaceFolderRole,
  WorkspaceRegistryEmptyState,
  WorkspaceWorktree,
} from '../types/workspace'

migrateLegacyWorkspaceStorageKey()

export interface WorkspaceStore
  extends
    PluginsSlice,
    CliAvailabilitySlice,
    HostedCardFeedSlice,
    CliVersionAdvisorySlice,
    WorkspacePaneSliceActions,
    FocusedAgentSlice {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
  appSettings: AppSettings
  authState: SprintEngineAuthState
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  // Which shape the chat rail lists conversations in (all-chats-view):
  // the project tree, or one stream of every chat newest-first. Persisted
  // in the settings envelope beside sidebarWidth.
  chatListView: ChatListView
  setChatListView: (view: ChatListView) => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  // Bumped after a skill/plugin install or uninstall so pickers re-read the
  // workspace registry without a restart.
  // The workspace pane column's width (browser-pane epic), persisted in the
  // settings envelope beside sidebarWidth. Open/closed is per workspace
  // (`workspace.paneState.open`); maximised is session-only.
  workspacePaneWidth: number
  setWorkspacePaneWidth: (width: number) => void
  workspacePaneMaximised: boolean
  setWorkspacePaneMaximised: (maximised: boolean) => void
  openFilesInExternalWindow: boolean
  setOpenFilesInExternalWindow: (enabled: boolean) => void
  diffOpensInWindow: boolean
  setDiffOpensInWindow: (enabled: boolean) => void
  diffView: DiffViewMode
  setDiffView: (view: DiffViewMode) => void
  checkCliVersions: boolean
  setCheckCliVersions: (enabled: boolean) => void
  // The request that opened the Settings modal — not the modal's visibility;
  // `activeModalSurface === 'settings'` is what says it is showing.
  settingsOverlay: SettingsOverlayState
  openSettingsOverlay: (opts?: SettingsOverlayOptions) => void
  closeSettingsOverlay: () => void
  // Opens the Extensions door on one of its views, optionally on that
  // view's Installed tab (source-tabs ruling, 2026-09-05).
  openExtensionsSurface: (opts?: { view?: ExtensionsDrawerView; installed?: boolean }) => void
  // The door-routed full-page surface for this window (global-surfaces epic
  // 1704): a registered surface id or null when a workspace owns the card
  // region. Transient and unsynced (absent from extractSettingsFields /
  // partializeWorkspaceStoreState). Opening a door sets
  // it; activating any workspace clears it — the sidebar's one-selected-thing
  // invariant.
  activeGlobalSurface: string | null
  openGlobalSurface: (surfaceId: string) => void
  closeGlobalSurface: () => void
  // The modal surface floating over this window (doors→modals, 2026-09-01): a
  // registered modal-surface id or null. Transient/unsynced like
  // activeGlobalSurface, but a float over the card region rather than a mount
  // kind — closing it lands where the user was. One at a time; activating a
  // workspace clears it.
  activeModalSurface: string | null
  // The workspace the open modal was opened from, when its opener had one.
  activeModalSurfaceWorkspaceId: string | null
  openModalSurface: (surfaceId: string, options?: { workspaceId?: string }) => void
  closeModalSurface: () => void
  // The app rail's active section (Home / Extensions), deciding what the
  // sidebar column shows. Transient like activeGlobalSurface.
  sidebarSection: SidebarSection
  setSidebarSection: (section: SidebarSection) => void
  reorderWorkspaces: (orderedIds: WorkspaceId[]) => void
  registerWorkspaceWindow: (windowId: WorkspaceWindowId, kind?: WorkspaceWindowState['kind']) => void
  updateWorkspaceWindowPlacement: (
    windowId: WorkspaceWindowId,
    placement: Pick<WorkspaceWindowState, 'bounds' | 'isMaximized' | 'displayId'>,
  ) => void
  closeWorkspaceWindow: (windowId: WorkspaceWindowId, fallbackWindowId?: WorkspaceWindowId) => void
  moveWorkspaceToWindow: (
    workspaceId: WorkspaceId,
    targetWindowId: WorkspaceWindowId,
    sourceWindowId?: WorkspaceWindowId | null,
  ) => void
  setActiveWorkspaceForWindow: (windowId: WorkspaceWindowId, workspaceId: WorkspaceId) => void
  applyWorkspaceActiveChangedEvent: (apply: WorkspaceActiveChangedApply) => void
  applyWorkspaceMovedEvent: (apply: WorkspaceMovedApply) => void
  applyWorkspaceClosedEvent: (apply: WorkspaceClosedApply) => void
  applyWorkspacePlacementEvent: (apply: WorkspacePlacementApply) => void
  applyWorkspaceCreatedEvent: (apply: WorkspaceCreatedApply) => void
  forgetFolder: (folderPath: string) => void
  setWorkspaceHighlight: (id: WorkspaceId, highlight: Partial<WorkspaceHighlight>) => void
  clearWorkspaceHighlight: (id: WorkspaceId) => void
  setWorkspaceSettled: (id: WorkspaceId, settled: boolean) => void
  /**
   * Mark a chat's worktree as given back by the agent worktree cleanup (a
   * stamp), or as on disk again (`null`). See `WorkspaceWorktree.reclaimedAt`.
   */
  setWorkspaceWorktreeReclaimed: (id: WorkspaceId, reclaimedAt: number | null) => void
  /**
   * Give a New chat that opened before its worktree was made the folder it
   * runs in: the worktree with its marker, or the project itself with none.
   */
  setWorkspaceChatFolder: (id: WorkspaceId, folderPath: string, worktree: WorkspaceWorktree | null) => void
  /** Take a chat out of auto-settling (idle and merge alike), or put it back. */
  setWorkspaceAutoSettle: (id: WorkspaceId, enabled: boolean) => void
  /** This chat's Auto compact: on, off, or `null` to follow the app-wide default. */
  setWorkspaceAutoCompact: (id: WorkspaceId, enabled: boolean | null) => void
  /**
   * Put a chat to sleep until `wakeAt`, or wake it now with `null`. The RECORD
   * only: suspending the chat's terminals is the sidebar's half of the gesture
   * (`snoozeWorkspaceById`). See `utils/workspaceSnooze.ts`.
   */
  setWorkspaceSnoozed: (id: WorkspaceId, wakeAt: number | null) => void
  /** Returns the ids that CAME TO REST on this tick, for the caller to quiet. */
  reconcileWorkspaceSettlement: (input: {
    now: number
    busyIds: ReadonlySet<WorkspaceId>
    heldIds: ReadonlySet<WorkspaceId>
    pullRequestsByWorkspaceId?: Readonly<Record<string, readonly BranchPullRequest[]>>
  }) => WorkspaceId[]
  recordWorkspaceTerminalActivity: (id: WorkspaceId, lastInputAt: number) => void
  recordWorkspaceUserMessage: (id: WorkspaceId, at: number) => void
  recordWorkspaceTurnEnd: (id: WorkspaceId, at: number) => void
  recordWorkspaceVisit: (id: WorkspaceId, at: number) => void
  speaksForWorkspace: (id: WorkspaceId) => boolean
  reconcileWorkspaceAgentLaunchFlags: (sessions: TerminalSessionSnapshot[]) => void
  projectLaunchedAgentSessions: (sessions: TerminalSessionSnapshot[]) => LaunchedAgentProjection[]
  setAuthState: (authState: SprintEngineAuthState) => void
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  setHostSettings: (
    hostId: import('../../../shared/execution-host').ExecutionHostId,
    settings: import('../../../shared/execution-host').ExecutionHostSettings | null,
  ) => void
  setMachineMark: (
    machineId: string,
    mark: import('../../../shared/machine-identity').MachineMarkSetting | null,
  ) => void
  setCliModelCatalog: (cli: AgentCli, catalog: DiscoveredCliModelCatalog | null) => void
  setMcpSyncEnabled: (enabled: boolean) => void
  upsertMcpServer: (server: McpServerConfig) => void
  /** Sync's writer: the same upsert, without turning MCP config sync back on. */
  refreshMcpServersFromSource: (servers: McpServerConfig[]) => void
  removeMcpServer: (serverId: string) => void
  setLastSelectedCli: (cli: AgentCli) => void
  /** The prefix new worktree branches start with (Settings ▸ Worktrees); sanitized, `''` for none. */
  setWorktreeBranchPrefix: (prefix: string) => void
  setAutoCompactChats: (enabled: boolean) => void
  recordProjectUse: (folderPath: string) => void
  setLastSelectedConversationModel: (selection: AgentConversationRuntime | null) => void
  setTextGenerationEnabled: (enabled: boolean) => void
  setTextGenerationEngine: (selection: AgentCliModelSelection | null) => void
  setTextGenerationWritingStyle: (style: Partial<TextGenerationWritingStyle>) => void
  setLastNewChatAgent: (choice: NewChatAgentChoice) => void
  setLastFolderOpenTarget: (target: FolderOpenTargetId) => void
  /** The Design door's viewing scope. Null returns it to following the active workspace. */
  setDesignProjectScopePath: (path: string | null) => void
  /**
   * Set one project's colour, keyed by `projectColorKey` (utils/projectColor).
   * `'none'` is a stored "no colour"; `null` deletes the override, returning the
   * project to its hashed hue.
   */
  setProjectColor: (key: string, color: ProjectColorSetting | null) => void
  /**
   * Stamp a design system as seen, now — the Design door's "New" marker reads
   * against it. Called AFTER the render that computed the markers, so the visit
   * that reveals them is the visit that clears them.
   */
  markDesignSystemSeen: (bundleId: string, at?: string) => void
  setLastAgentSpawnPermissionPreset: (preset: CliPermissionPreset) => void
  /** The preset spawns on one CLI launch with; `null` returns it to the app-wide default. */
  setCliPermissionPreset: (cli: AgentCli, preset: CliPermissionPreset | null, mode?: string | null) => void
  setLastSelectedAgentModel: (selection: AgentCliModelSelection | null) => void
  /** Drop retired model ids from every remembered launch default for `cli`. */
  forgetCliModels: (cli: AgentCli, modelIds: readonly string[]) => void
  setLastSelectedAgentReasoning: (cli: AgentCli, reasoning: string | null) => void
  setCommandKeybindings: (commandId: CommandId, keybindings: string[]) => void
  setCommandKeybindingDisabled: (commandId: CommandId, disabled: boolean) => void
  resetCommandKeybindings: (commandId: CommandId) => void
  resetAllKeybindings: () => void
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
  setTerminalIdleSuspendMinutes: (minutes: number) => void
  setTerminalKeepRecentAlive: (count: number) => void
  setSettleOnPullRequestMerge: (enabled: boolean) => void
  /** Keep a chat with an open pull request out of the idle rule (Settings ▸ Settled chats). */
  setKeepChatsWithOpenPullRequest: (enabled: boolean) => void
  setBrowserAutoFloatAgentPreview: (enabled: boolean) => void
  /** What Enter does in a chat whose agent is working: queue the message, or steer the turn with it. */
  setFollowUpBehavior: (behavior: FollowUpBehavior) => void
  /** Keep the app (and its running agents) alive after the last window closes. */
  setKeepRunningInBackground: (enabled: boolean) => void
  setTelemetryEnabled: (enabled: boolean) => void
  setModuleEnabled: (moduleId: string, enabled: boolean) => void
  /** Drop what the app kept for uninstalled modules: the enablement choice and the settings namespace. */
  forgetModules: (moduleIds: readonly string[]) => void
  /** Write one value in a module's `module:<id>` settings namespace; `undefined` deletes the key. */
  setModuleSettingValue: (moduleId: string, key: string, value: unknown) => void
  dismissFirstRunCliCard: () => void
  markAgentConfigAdopted: () => void
  markConversationImportOffered: () => void
  // Transient outcome of the silent first-run config adoption, read out as one
  // line in Settings → Agents. Not persisted (see extractSettingsFields).
  agentConfigAdoptionResult: AgentConfigAdoptionResult | null
  setAgentConfigAdoptionResult: (result: AgentConfigAdoptionResult | null) => void
  setAppearanceTheme: (theme: AppTheme) => void
  setAppearanceWindowMaterial: (material: WindowMaterial) => void
  setAppearanceChatContrast: (contrast: number) => void
  setAppearanceChatWidth: (width: ChatWidth) => void
  setAppearanceClockFormat: (format: ClockFormat) => void
  setAppearanceReplyStreaming: (mode: ReplyStreaming) => void
  setAppearanceAgentCharacters: (enabled: boolean) => void
  setAppearanceUsageLimits: (enabled: boolean) => void
  setAppearanceInterfaceFont: (family: string) => void
  setAppearanceCodeFont: (family: string) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: {
      name?: string
      folderPath?: string | null
      // Set for a chat created on a paired machine; see Workspace.remoteOrigin.
      remoteOrigin?: import('../types/workspace').WorkspaceRemoteOrigin | null
      // The machine on this computer the workspace runs on; see Workspace.hostId.
      hostId?: import('../../../shared/execution-host').ExecutionHostId | null
      // The SSH machine it is on; see Workspace.environment.
      environment?: import('../types/workspace').WorkspaceEnvironmentRef | null
      worktree?: WorkspaceWorktree | null
      templateAgentCli?: AgentCli | null
      seedAgent?: SoloChatSeed | null
      // A dragged-out agent tab: keep its id, and move its record in from here.
      moveLayoutAgentsFrom?: WorkspaceId
      mode?: Workspace['mode']
      // Executor-triggered creation: skip the door-surface clear.
      background?: boolean
      // False: the workspace joins its window without coming to the front, as
      // a chat started with ⌘⏎ from New chat does. Absent, it becomes the
      // window's active workspace.
      activate?: false
      windowId?: WorkspaceWindowId | null
    },
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  autoTitleWorkspaceFromPrompt: (id: WorkspaceId, prompt: string) => string | null
  applyGeneratedWorkspaceTitle: (id: WorkspaceId, title: string, replacing: string | null) => boolean
  setActiveWorkspace: (id: WorkspaceId) => void
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  setFileExplorerExpandedPaths: (id: WorkspaceId, expandedPaths: string[]) => void
  setFileExplorerFolderRole: (id: WorkspaceId, folderPath: string, role: WorkspaceFolderRole | null) => void
  setFileExplorerSelectedPath: (id: WorkspaceId, selectedPath: string | null) => void
  setBacklogViewState: (id: WorkspaceId, patch: Partial<WorkspaceBacklogState>) => void
  setGitPanelState: (id: WorkspaceId, patch: Partial<Omit<WorkspaceGitPanelState, 'commitDraftsByScopeId'>>) => void
  /** Remember which agent this workspace is on — the Diff surfaces' default
   *  changelist (agent changelists). See workspacesSlice. */
  setLastActiveAgent: (id: WorkspaceId, agentId: string | null) => void
  setGitCommitDraft: (id: WorkspaceId, scopeId: string, text: string) => void
  clearGitCommitDraft: (id: WorkspaceId, scopeId: string) => void
  /**
   * Write one module's entry in a workspace's per-module state bag;
   * null/undefined removes it. False for an unknown workspace.
   */
  setWorkspaceModuleState: (workspaceId: WorkspaceId, moduleId: string, state: unknown) => boolean
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
  removeAgent: (workspaceId: WorkspaceId, agentId: AgentId) => void
  applyAgentTerminalSessionEvent: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchStateEvent: (apply: AgentTerminalLaunchStateApply) => void
  setAgentExecution: (workspaceId: WorkspaceId, agentId: AgentId, execution: Partial<AgentExecution>) => void
  setWorkspaceWorktreeState: (workspaceId: WorkspaceId, worktreeState: Partial<WorkspaceWorktreeState> | null) => void
  setWorkspaceMemoryRelativeRoot: (workspaceId: WorkspaceId, relativeRoot: string | null) => void
  updateMemoryGraphSettings: (
    workspaceId: WorkspaceId,
    update:
      | Partial<MemoryGraphSettings>
      | ((current: MemoryGraphSettings) => Partial<MemoryGraphSettings> | MemoryGraphSettings),
  ) => void
  upsertWorktreeEntry: (workspaceId: WorkspaceId, entry: WorktreeEntry) => void
  markWorktreeMissing: (workspaceId: WorkspaceId, worktreeId: string, missingAt?: number) => void
  removeWorktreeEntry: (workspaceId: WorkspaceId, worktreeId: string) => void
  appendStream: (workspaceId: WorkspaceId, agentId: AgentId, chunk: string) => void
  commitStream: (workspaceId: WorkspaceId, agentId: AgentId) => void
  importWorkspace: (ws: Workspace) => void

  // Per-workspace editor actions
  openFile: (workspaceId: WorkspaceId, path: string, name: string, content: string) => void
  closeFile: (workspaceId: WorkspaceId, path: string) => void
  setActiveFile: (workspaceId: WorkspaceId, path: string) => void
  updateFileContent: (workspaceId: WorkspaceId, path: string, content: string) => void
  markFileClean: (workspaceId: WorkspaceId, path: string) => void
  remapOpenFiles: (workspaceId: WorkspaceId, fromPath: string, toPath: string) => void
  removeOpenFilesForPath: (workspaceId: WorkspaceId, path: string) => void

  moveAgentToWorkspace: (sourceWorkspaceId: WorkspaceId, destWorkspaceId: WorkspaceId, agentId: AgentId) => boolean
  moveOpenFileToWorkspace: (sourceWorkspaceId: WorkspaceId, destWorkspaceId: WorkspaceId, path: string) => void
}

const workspacesSliceDeps: WorkspacesSliceDependencies = {
  defaultAgent,
  defaultEditorState,
  defaultWorkspaceMemoryConfig,
  defaultWorkspaceWorktreeState,
  normalizeAgentState,
  normalizeWorkspaceWorktreeState,
  hideNavRailTabStrip,
  pickWorkspaceAgentName,
  isPathOrChild,
}

// Module-level hydration context: getItem populates it during async hydrate;
// onRehydrateStorage reads it once after the store finishes hydrating and emits
// a single structured diagnostic log entry so persistence failures and recoveries
// are observable instead of silent.
type HydrationContext = {
  storageSource: HydrationStorageSource
  classification: PersistedStateClassification
  persistedWorkspaceCount: number
  parseError?: string
  recoveryError?: string
}

const hydrationContext: HydrationContext = {
  storageSource: 'fresh',
  classification: 'dangerous_empty_missing_storage',
  persistedWorkspaceCount: 0,
}

function getPersistedWorkspaceCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const envelope = JSON.parse(raw) as { state?: { workspaces?: unknown } }
    const workspaces = envelope?.state?.workspaces
    return Array.isArray(workspaces) ? workspaces.length : 0
  } catch {
    return 0
  }
}

// The userData backup is the last-known-good copy that recovery falls back to
// when the legacy registry key reads as dangerously empty. Main owns the
// registry, so main fills the registry half in when it writes the file
// (`src/main/workspace-backup.ts`) and this window sends only the settings
// envelope it owns. Serializing a registry of a few hundred workspaces here
// cost several milliseconds of this thread on every store write, for data
// that was main's to begin with.
//
// The backup is refreshed when the settings or the workspace list change,
// coalesced so that a burst of layout writes costs one IPC.
const BACKUP_WRITE_DEBOUNCE_MS = 1000
let backupWriteTimer: ReturnType<typeof setTimeout> | null = null

// A pane pop-out window (`?aux=pane`) writes neither the settings key nor the
// backup. It mounts the pane's own tab bodies, so any setter they reach runs
// in it, and its store holds the settings as they were when it opened: a
// write from it would put that snapshot back over everything the workspace
// window has changed since (the hazard auxWindows/auxSettingsWrite.ts exists
// for). Its workspace list moves on every registry broadcast and every pane
// state its owner pushes, and each of those would otherwise ask for a backup
// carrying the same stale settings. The settings its bodies do change go to
// the owner, which writes them (panePopOutRedirect.ts).
const PERSISTS_NOTHING = readAuxWindowKind() === 'pane'

function readAuxWindowKind(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return new URL(window.location.href).searchParams.get('aux')
  } catch {
    return null
  }
}

function scheduleBackupWrite(): void {
  if (typeof window === 'undefined' || PERSISTS_NOTHING) return
  const api = window.api
  if (!api || typeof api.workspaceBackupWrite !== 'function') return

  if (backupWriteTimer) clearTimeout(backupWriteTimer)
  backupWriteTimer = setTimeout(() => {
    backupWriteTimer = null
    const state = useWorkspaceStore.getState()
    // The backup mirrors a non-empty registry only. An intentionally empty
    // one is honored locally and never promoted over the last good copy.
    if (state.workspaces.length === 0) return
    void api
      .workspaceBackupWrite({
        version: WORKSPACE_STORE_VERSION,
        writtenAt: new Date().toISOString(),
        data: { settings: serializeSettingsEnvelope(partializeWorkspaceStoreState(state), WORKSPACE_STORE_VERSION) },
      })
      .catch((error: unknown) => {
        console.warn('[workspaceStore] backup write failed', {
          message: error instanceof Error ? error.message : 'unknown',
        })
      })
  }, BACKUP_WRITE_DEBOUNCE_MS)
}

// Workspace fields whose change alone does not refresh the backup: the
// keystroke clock, written on terminal input, and the visit clock, stamped
// every few seconds while a chat is on screen. The next change that does
// refresh it carries the clocks along.
const BACKUP_IGNORED_WORKSPACE_FIELDS: ReadonlySet<string> = new Set(['lastTerminalActivityAt', 'lastVisitedAt'])

/**
 * Whether a new workspace list differs from the previous one in anything but
 * the fields above. Cheap by construction: the store shares every workspace it
 * did not touch, so only the changed ones have their top-level fields compared.
 */
export function workspacesChangedForBackup(previous: readonly Workspace[], next: readonly Workspace[]): boolean {
  if (previous.length !== next.length) return true
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index] as Record<string, unknown> | undefined
    const after = next[index] as unknown as Record<string, unknown>
    if (before === after) continue
    if (!before) return true
    for (const key of Object.keys(after)) {
      if (!BACKUP_IGNORED_WORKSPACE_FIELDS.has(key) && before[key] !== after[key]) return true
    }
    for (const key of Object.keys(before)) {
      if (!(key in after)) return true
    }
  }
  return false
}

// Two-key split persistence (T23). The custom storage adapter is the only
// place workspace-registry and app-settings keys are read or written:
//   sprintengine-workspaces   → read at hydration only. Main owns the
//                               registry, and the key is frozen.
//   sprintengine-app-settings → written when a settings field changes, and
//                               then only on a coalesced timer (see setItem).
// Partialize hands setItem the settings fields by reference, so a store write
// that leaves them alone (a tab click, a terminal clock, a focus change) costs
// a handful of reference comparisons and serializes nothing.

type RegistryEnvelopeState = {
  workspaces: unknown
  activeWorkspaceId: unknown
  workspaceWindows: unknown
  primaryWorkspaceWindowId: unknown
  workspaceRegistryEmptyState: unknown
}

type SettingsEnvelopeState = {
  appSettings: unknown
  sidebarCollapsed: unknown
  chatListView: unknown
  sidebarWidth: unknown
  workspacePaneWidth: unknown
  openFilesInExternalWindow: unknown
  diffOpensInWindow: unknown
  diffView: unknown
  checkCliVersions: unknown
}

let lastWrittenSettingsSerialized: string | null = null

// The agent-launch fields are main's (launchSettingsReadModel.ts). A settings
// envelope written before main owned them still carries them; hydration reads
// them once, here, as the one-time migration offer, and ignores them otherwise.
// Until main confirms it holds a record, every settings write carries the raw
// values forward unchanged, so a boot on which main never answers loses
// nothing; once it does, they are stripped and never written again.
let legacyLaunchSettingsOffer: AgentLaunchSettings | null = null
let pendingLegacyLaunchFields: Record<string, unknown> | null = null

/** The envelope's `appSettings`: the launch fields removed, and the legacy copy carried while it is pending. */
function persistableAppSettings(appSettings: unknown): unknown {
  if (!appSettings || typeof appSettings !== 'object' || Array.isArray(appSettings)) return appSettings
  const stripped = withoutLaunchSettings(appSettings as Record<string, unknown>)
  return pendingLegacyLaunchFields ? { ...stripped, ...pendingLegacyLaunchFields } : stripped
}

/**
 * The hydrated `appSettings`: the persisted envelope normalized with its
 * launch fields ignored, and the launch fields taken from this window's own
 * read model. The one exception is an envelope written before main owned
 * them: its values are kept as the migration offer, and shown until main
 * answers, so a window never renders defaults the person did not choose.
 */
function mergePersistedAppSettings(
  persisted: Partial<AppSettings> | undefined,
  current: AppSettings,
  workspaces: Workspace[],
): AppSettings {
  const legacyFields = persistedLaunchSettingsFields(persisted)
  pendingLegacyLaunchFields = legacyFields
  legacyLaunchSettingsOffer = legacyFields
    ? launchSettingsFromAppSettings(normalizeAppSettings(persisted, workspaces))
    : null
  const normalized = normalizeAppSettings(persisted ? withoutLaunchSettings(persisted) : undefined, workspaces)
  return withLaunchSettings(normalized, legacyLaunchSettingsOffer ?? launchSettingsFromAppSettings(current), workspaces)
}

// Main holds a record now: drop the legacy launch fields from the stored
// envelope in place, rather than waiting for the next settings change to
// rewrite it.
function stripLegacyLaunchSettingsFromStorage(): void {
  if (!pendingLegacyLaunchFields) return
  pendingLegacyLaunchFields = null
  legacyLaunchSettingsOffer = null
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
    if (!raw) return
    const envelope = JSON.parse(raw) as { state?: { appSettings?: unknown }; version?: number } | null
    const appSettings = envelope?.state?.appSettings
    if (!envelope?.state || !persistedLaunchSettingsFields(appSettings)) return
    envelope.state.appSettings = withoutLaunchSettings(appSettings as Record<string, unknown>)
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(envelope))
    lastWrittenSettingsSerialized = null
  } catch (error) {
    console.warn('[workspaceStore] could not strip the legacy launch settings', {
      message: error instanceof Error ? error.message : 'unknown',
    })
  }
}

function preserveAgentTerminalMetadata(
  incomingWorkspace: Workspace,
  currentWorkspace: Workspace | undefined,
): Workspace {
  if (!currentWorkspace) return incomingWorkspace
  let changed = false
  const nextAgents = { ...incomingWorkspace.agents }
  for (const [agentId, currentAgent] of Object.entries(currentWorkspace.agents)) {
    const incomingAgent = nextAgents[agentId]
    // A session event could seed main with only an id before the window sent
    // its agent config. Keep a recoverable name until it is written back.
    if (
      incomingAgent &&
      isPlaceholderAgentName(incomingAgent.name, agentId) &&
      !isPlaceholderAgentName(currentAgent.name, agentId)
    ) {
      nextAgents[agentId] = { ...incomingAgent, name: currentAgent.name }
      changed = true
    }
    if (
      !currentAgent.cliStartRequested &&
      !currentAgent.cliHasLaunched &&
      !currentAgent.cliSessionId &&
      !currentAgent.cliResumeAvailable &&
      !currentAgent.cliOnboardingPromptSent
    )
      continue
    nextAgents[agentId] = {
      ...(nextAgents[agentId] ?? currentAgent),
      cliSessionId: currentAgent.cliSessionId,
      cliStartRequested: currentAgent.cliStartRequested,
      cliHasLaunched: currentAgent.cliHasLaunched,
      cliOnboardingPromptSent: currentAgent.cliOnboardingPromptSent,
      cliResumeAvailable: currentAgent.cliResumeAvailable,
      cliUsesStableSessionId: currentAgent.cliUsesStableSessionId,
      cli: currentAgent.cli ?? incomingAgent?.cli,
    }
    changed = true
  }
  return changed ? { ...incomingWorkspace, agents: nextAgents } : incomingWorkspace
}

// The registry in the shape this window offers main on the one-time hydration
// handshake: workspace file content and in-memory agent buffers stripped, and
// window membership re-derived. Main is never handed the raw store shape.
type RegistryFields = Pick<
  WorkspaceStore,
  'workspaces' | 'activeWorkspaceId' | 'workspaceWindows' | 'primaryWorkspaceWindowId' | 'workspaceRegistryEmptyState'
>

function partializeRegistryFields(state: RegistryFields): RegistryFields {
  return {
    workspaces: state.workspaces.map(normalizeWorkspaceForPartialize),
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceWindows: normalizeWorkspaceWindows(
      state.workspaces,
      state.workspaceWindows,
      state.primaryWorkspaceWindowId,
      state.activeWorkspaceId,
    ).windows,
    primaryWorkspaceWindowId: state.primaryWorkspaceWindowId,
    workspaceRegistryEmptyState: state.workspaceRegistryEmptyState,
  }
}

/**
 * Every field the settings envelope carries, and therefore the ONLY keys a
 * settings blob read back off disk may put into the store.
 *
 * Exported because an aux window merges that blob before writing its own field
 * (`auxWindows/auxSettingsWrite.ts`), and "the key holds settings and nothing
 * else" is an assumption about a file on disk rather than a fact about this
 * process. Named here so the allowlist and the writer cannot drift apart.
 */
export const SETTINGS_ENVELOPE_FIELDS = [
  'appSettings',
  'sidebarCollapsed',
  'chatListView',
  'sidebarWidth',
  'workspacePaneWidth',
  'openFilesInExternalWindow',
  'diffOpensInWindow',
  'diffView',
  'checkCliVersions',
] as const

function extractSettingsFields(state: Record<string, unknown>): SettingsEnvelopeState {
  const fields: Record<string, unknown> = {}
  for (const key of SETTINGS_ENVELOPE_FIELDS) fields[key] = state[key]
  // Never the launch fields: main owns them (see persistableAppSettings).
  if (fields.appSettings && typeof fields.appSettings === 'object') {
    fields.appSettings = withoutLaunchSettings(fields.appSettings as Record<string, unknown>)
  }
  return fields as SettingsEnvelopeState
}

/**
 * What the persist middleware hands `setItem` on every store write: the
 * settings fields, by reference, and the workspace list, by reference only.
 *
 * Nothing here is copied or normalized. The write path decides from reference
 * equality whether anything it owns changed, and only then pays for
 * serialization. The registry is not in it: main persists the registry, and
 * the legacy key is frozen. `workspaces` rides along so a change to the list
 * can ask main to refresh the userData backup; it is never written from here.
 */
type PersistedWorkspaceSlice = SettingsEnvelopeState & { workspaces: WorkspaceStore['workspaces'] }

function partializeWorkspaceStoreState(s: WorkspaceStore): PersistedWorkspaceSlice {
  return {
    appSettings: s.appSettings,
    sidebarCollapsed: s.sidebarCollapsed,
    chatListView: s.chatListView,
    sidebarWidth: s.sidebarWidth,
    workspacePaneWidth: s.workspacePaneWidth,
    openFilesInExternalWindow: s.openFilesInExternalWindow,
    diffOpensInWindow: s.diffOpensInWindow,
    diffView: s.diffView,
    checkCliVersions: s.checkCliVersions,
    workspaces: s.workspaces,
  }
}

function settingsFieldsUnchanged(previous: PersistedWorkspaceSlice, next: PersistedWorkspaceSlice): boolean {
  for (const key of SETTINGS_ENVELOPE_FIELDS) {
    if (previous[key] !== next[key]) return false
  }
  return true
}

/** The settings key's on-disk envelope, launch fields stripped (see persistableAppSettings). */
function serializeSettingsEnvelope(state: PersistedWorkspaceSlice, version: number): string {
  const settingsFields = extractSettingsFields(state as unknown as Record<string, unknown>)
  return JSON.stringify({
    state: { ...settingsFields, appSettings: persistableAppSettings(settingsFields.appSettings) },
    version,
  })
}

export function __workspaceStorePartializeForTests(
  s: WorkspaceStore,
): ReturnType<typeof partializeWorkspaceStoreState> {
  return partializeWorkspaceStoreState(s)
}

function readWorkspaceRegistryKey(): {
  raw: string | null
  envelope: { state: RegistryEnvelopeState; version: number } | null
} {
  if (typeof window === 'undefined') return { raw: null, envelope: null }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  } catch (error) {
    hydrationContext.parseError = error instanceof Error ? error.message : 'localStorage_read_failed'
    return { raw: null, envelope: null }
  }
  if (!raw) return { raw, envelope: null }
  try {
    const parsed = JSON.parse(raw) as { state?: RegistryEnvelopeState; version?: number }
    if (!parsed?.state) return { raw, envelope: null }
    return { raw, envelope: { state: parsed.state, version: parsed.version ?? 0 } }
  } catch {
    return { raw, envelope: null }
  }
}

function readSettingsKey(): { raw: string | null; envelope: { state: SettingsEnvelopeState; version: number } | null } {
  if (typeof window === 'undefined') return { raw: null, envelope: null }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
  } catch {
    return { raw: null, envelope: null }
  }
  if (!raw) return { raw, envelope: null }
  try {
    const parsed = JSON.parse(raw) as { state?: SettingsEnvelopeState; version?: number }
    if (!parsed?.state) return { raw, envelope: null }
    return { raw, envelope: { state: parsed.state, version: parsed.version ?? 0 } }
  } catch {
    return { raw, envelope: null }
  }
}

type BackupEnvelopePair = {
  registry: string
  settings: string | null
}

function serializeBackupEnvelopeValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function coerceBackupEnvelopePair(data: unknown): BackupEnvelopePair | null {
  if (typeof data === 'string') {
    return { registry: data, settings: null }
  }

  if (data && typeof data === 'object') {
    const split = data as { registry?: unknown; settings?: unknown }
    if ('registry' in split) {
      const registry = serializeBackupEnvelopeValue(split.registry)
      if (!registry) return null
      return {
        registry,
        settings: serializeBackupEnvelopeValue(split.settings),
      }
    }
  }

  const registry = serializeBackupEnvelopeValue(data)
  return registry ? { registry, settings: null } : null
}

function parseSettingsEnvelopeState(raw: string | null): SettingsEnvelopeState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: SettingsEnvelopeState }
    return parsed?.state ?? null
  } catch {
    return null
  }
}

// A settings change reaches localStorage at most this long after it lands in
// the store. Long enough to fold a drag of the sidebar edge, or the handful of
// writes one click can make, into a single write; short enough that nothing a
// person could notice is lost if the process dies without a pagehide.
const SETTINGS_WRITE_COALESCE_MS = 250
let settingsWriteTimer: ReturnType<typeof setTimeout> | null = null
let pendingSettingsWrite: { state: PersistedWorkspaceSlice; version: number } | null = null
// The last slice setItem saw, for the reference comparison. Null until the
// first write after hydration, which is therefore always examined in full.
let lastPersistedSlice: PersistedWorkspaceSlice | null = null
// Set while `adoptStoredSettings` applies settings another window saved: they
// are already on disk, so the write the store would make of them is skipped.
let adoptingStoredSettings = false

/**
 * Write the pending settings change now, if there is one. Runs on the coalesce
 * timer and when the window is hidden or unloads, so a change made just before
 * quitting or reloading still reaches disk. Exported for tests.
 */
export function flushWorkspaceSettingsWrite(): void {
  if (settingsWriteTimer !== null) {
    clearTimeout(settingsWriteTimer)
    settingsWriteTimer = null
  }
  const pending = pendingSettingsWrite
  pendingSettingsWrite = null
  if (!pending || typeof window === 'undefined') return
  // Content dedup on top of the reference check: a setter that rebuilds
  // `appSettings` with the same values changes the reference, not the data.
  const settingsSerialized = JSON.stringify(extractSettingsFields(pending.state as unknown as Record<string, unknown>))
  if (settingsSerialized === lastWrittenSettingsSerialized) return
  try {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, serializeSettingsEnvelope(pending.state, pending.version))
  } catch (error) {
    console.warn('[workspaceStore] localStorage settings write failed', {
      message: error instanceof Error ? error.message : 'unknown',
    })
  }
  lastWrittenSettingsSerialized = settingsSerialized
  // The backup carries the settings envelope too, so recovery does not
  // restore workspaces while silently dropping recent folders, skill packs or
  // sidebar state.
  if (pending.state.workspaces.length > 0) scheduleBackupWrite()
}

function installSettingsFlushOnExit(): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('pagehide', flushWorkspaceSettingsWrite)
  window.addEventListener('beforeunload', flushWorkspaceSettingsWrite)
  // On hide, through the window's own visibility rather than
  // `document.visibilityState`, which stays 'visible' for a minimized macOS
  // window. A hidden window's timers are throttled, so a write left on the
  // 250 ms timer could otherwise sit there for as long as it stays hidden.
  onWindowVisibilityChange((visible) => {
    if (!visible) flushWorkspaceSettingsWrite()
  })
}
installSettingsFlushOnExit()

const workspaceStateStorage: PersistStorage<PersistedWorkspaceSlice> = {
  getItem: (_name: string): StorageValue<PersistedWorkspaceSlice> | null => {
    if (typeof window === 'undefined') {
      hydrationContext.storageSource = 'fresh'
      hydrationContext.classification = 'dangerous_empty_missing_storage'
      hydrationContext.persistedWorkspaceCount = 0
      return null
    }

    // Cold-load: try registry key first. If it's a legacy v44 envelope (single
    // key holding both registry + settings), split it on the fly and write the
    // settings half to APP_SETTINGS_STORAGE_KEY so subsequent writes use the
    // new shape. The persist middleware's migrate ladder still upgrades the
    // workspace fields through version 45.
    const registry = readWorkspaceRegistryKey()
    let registryState = registry.envelope?.state ?? null
    let registryVersion = registry.envelope?.version ?? 0
    let legacyExtractedSettings: SettingsEnvelopeState | null = null

    if (registry.raw && isLegacyV44WorkspaceEnvelope(registry.raw)) {
      const split = splitLegacyV44Envelope(registry.raw)
      if (split) {
        registryState = {
          workspaces: split.registry.state.workspaces,
          activeWorkspaceId: split.registry.state.activeWorkspaceId,
          workspaceWindows: undefined,
          primaryWorkspaceWindowId: undefined,
          workspaceRegistryEmptyState: null,
        }
        registryVersion = split.registry.version
        if (split.extractedSettings) {
          legacyExtractedSettings = split.extractedSettings as SettingsEnvelopeState
          try {
            window.localStorage.setItem(
              APP_SETTINGS_STORAGE_KEY,
              JSON.stringify({ state: split.extractedSettings, version: registryVersion }),
            )
          } catch {
            // Best-effort; settings fields are still merged below in memory.
          }
        }
      }
    }

    const classification = classifyPersistedWorkspaceState({ rawLocalStorage: registry.raw })
    hydrationContext.classification = classification
    hydrationContext.persistedWorkspaceCount = getPersistedWorkspaceCount(registry.raw)

    if (classification === 'present') {
      hydrationContext.storageSource = 'localStorage'
    } else {
      // Dangerous empty hydrations leave storageSource as 'fresh' here; the
      // post-hydrate recovery kickoff may upgrade it to 'backup' before the
      // canonical diagnostic emits.
      hydrationContext.storageSource = 'fresh'
    }

    // Merge registry + settings into the single envelope zustand expects.
    const settings = readSettingsKey()
    const settingsState = legacyExtractedSettings ?? settings.envelope?.state ?? null
    const mergedState: Record<string, unknown> = {
      ...registryState,
      ...settingsState,
    }
    // If everything is absent we treat this as a true cold-start. Zustand will
    // create the store from defaults; partialize will not write until a real
    // mutation happens.
    if (!registryState && !settingsState) return null

    const version = Math.max(registryVersion, settings.envelope?.version ?? 0)
    // Seed the settings dedup baseline so the first post-hydrate setItem can
    // decide whether to re-serialize that key. The registry key has no baseline
    // any more: it is frozen and never written again.
    lastWrittenSettingsSerialized = JSON.stringify(extractSettingsFields(mergedState))
    // Handed to the middleware as an object: both halves were just parsed, so
    // a stringify-and-parse round trip here would only copy them. A key whose
    // value is undefined is dropped, as that round trip used to drop it, so
    // merge's spread cannot blank a field in the current state.
    for (const key of Object.keys(mergedState)) {
      if (mergedState[key] === undefined) delete mergedState[key]
    }
    return { state: mergedState as unknown as PersistedWorkspaceSlice, version }
  },

  // The persist middleware calls this after EVERY store write, including the
  // many that change nothing it persists: a tab click is about three writes.
  // So the fast path is reference comparison and nothing else, and the one
  // write that does change a setting is coalesced onto a short timer, flushed
  // early when the window goes away (`flushWorkspaceSettingsWrite`).
  //
  // The registry key is FROZEN, not deleted. Main owns the workspace registry,
  // so the renderer does not write this key and leaves the last written value
  // in place as the rollback artifact; a later release deletes it, in its own
  // commit. The stated trade: a user who downgrades loses workspace changes
  // made since. Dual-writing the key instead would be exactly the dual
  // authority the move to main exists to end, and a stale dual-write is worse
  // than a clean frozen snapshot, because it would silently lose the NEWER
  // state on the way back up.
  setItem: (_name: string, value: StorageValue<PersistedWorkspaceSlice>): void => {
    if (typeof window === 'undefined') return
    if (PERSISTS_NOTHING) return
    const next = value.state
    const previous = lastPersistedSlice
    lastPersistedSlice = next
    if (adoptingStoredSettings) {
      // What is on disk now is what was just adopted. A write this window had
      // waiting carries its older copy, and would put it back over the newer.
      if (settingsWriteTimer !== null) clearTimeout(settingsWriteTimer)
      settingsWriteTimer = null
      pendingSettingsWrite = null
      lastWrittenSettingsSerialized = JSON.stringify(extractSettingsFields(next as unknown as Record<string, unknown>))
      return
    }

    // A changed workspace list asks main for a fresh backup. Only a non-empty
    // one: the intentional empty case is honored locally but never promoted
    // over the last-known-good copy. And not for the keystroke clock alone,
    // which moves on terminal input: each backup has main serialize the whole
    // registry, and typing is not a change worth recovering.
    if (
      previous &&
      previous.workspaces !== next.workspaces &&
      next.workspaces.length > 0 &&
      workspacesChangedForBackup(previous.workspaces, next.workspaces)
    ) {
      scheduleBackupWrite()
    }

    if (previous && settingsFieldsUnchanged(previous, next)) return
    pendingSettingsWrite = { state: next, version: value.version ?? WORKSPACE_STORE_VERSION }
    if (settingsWriteTimer === null) {
      settingsWriteTimer = setTimeout(flushWorkspaceSettingsWrite, SETTINGS_WRITE_COALESCE_MS)
    }
  },

  removeItem: (_name: string): void => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY)
      window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY)
    } catch {
      // Removal is best-effort.
    }
    lastWrittenSettingsSerialized = null
    lastPersistedSlice = null
    pendingSettingsWrite = null
  },
}

// Run after the synchronous hydrate completes. For non-dangerous classifications
// this is a no-op that immediately emits the canonical hydration diagnostic. For
// dangerous classifications it reads the userData backup over IPC, validates
// that the backup classifies as `present`, and replays the recovered envelope
// into the store before emitting the final diagnostic. Either way exactly one
// `[workspaceStore] hydration` log entry fires per cold load, and it reflects
// the final storageSource (`localStorage`, `backup`, or `fresh`) plus any
// parse/recovery error.
async function attemptBackupRecovery(): Promise<void> {
  if (typeof window === 'undefined') {
    emitHydrationDiagnostic()
    return
  }

  // Re-read and re-classify from the current localStorage. The recovery
  // function is module-load-once in production, but tests rebind the storage
  // mock between cases and call it again; trusting the previous hydration
  // context would carry stale values into the new scenario.
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  } catch (error) {
    hydrationContext.parseError = error instanceof Error ? error.message : 'localStorage_read_failed'
  }
  hydrationContext.classification = classifyPersistedWorkspaceState({ rawLocalStorage: raw })
  hydrationContext.persistedWorkspaceCount = getPersistedWorkspaceCount(raw)
  hydrationContext.storageSource = hydrationContext.classification === 'present' ? 'localStorage' : 'fresh'
  hydrationContext.recoveryError = undefined

  if (!isDangerousEmptyClassification(hydrationContext.classification)) {
    emitHydrationDiagnostic()
    return
  }

  // Honor the in-memory or on-disk intent record: if the user explicitly
  // removed all workspaces, do not overwrite that decision with a stale
  // backup payload. AC6: distinguish intentional user_removed_all from
  // hydration failure / unknown wipe.
  const currentIntent = useWorkspaceStore.getState().workspaceRegistryEmptyState
  let persistedIntent: WorkspaceRegistryEmptyState | null = null
  try {
    const parsedRegistry = raw
      ? (JSON.parse(raw) as { state?: { workspaceRegistryEmptyState?: WorkspaceRegistryEmptyState | null } })
      : null
    persistedIntent = parsedRegistry?.state?.workspaceRegistryEmptyState ?? null
  } catch {
    persistedIntent = null
  }
  if (currentIntent != null || persistedIntent != null) {
    emitHydrationDiagnostic()
    return
  }
  if (typeof window.api?.workspaceBackupRead !== 'function') {
    emitHydrationDiagnostic()
    return
  }

  try {
    const result = await window.api.workspaceBackupRead()
    if (!result.ok) {
      if (result.reason !== 'missing') {
        hydrationContext.recoveryError = `${result.reason}${result.message ? `:${result.message}` : ''}`
      }
      emitHydrationDiagnostic()
      return
    }

    // The backup IPC is async. A user can create a workspace while recovery is
    // in flight; if that happens, the new non-empty registry is the fresher
    // source of truth and must not be replaced by an older backup snapshot.
    let latestRaw: string | null = null
    try {
      latestRaw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    } catch {
      latestRaw = null
    }
    const latestClassification = classifyPersistedWorkspaceState({ rawLocalStorage: latestRaw })
    const latestWorkspaceCount = getPersistedWorkspaceCount(latestRaw)
    const latestIntent = useWorkspaceStore.getState().workspaceRegistryEmptyState
    if (
      useWorkspaceStore.getState().workspaces.length > 0 ||
      latestWorkspaceCount > 0 ||
      !isDangerousEmptyClassification(latestClassification) ||
      latestIntent != null
    ) {
      hydrationContext.classification = latestClassification
      hydrationContext.persistedWorkspaceCount = latestWorkspaceCount
      hydrationContext.storageSource = latestClassification === 'present' ? 'localStorage' : 'fresh'
      emitHydrationDiagnostic()
      return
    }

    const recoveredBackup = coerceBackupEnvelopePair(result.payload.data)
    if (!recoveredBackup) {
      hydrationContext.recoveryError = 'backup_payload_unserializable'
      emitHydrationDiagnostic()
      return
    }
    const recovered = recoveredBackup.registry
    const recoveredClassification = classifyPersistedWorkspaceState({ rawLocalStorage: recovered })
    if (recoveredClassification !== 'present') {
      // Backup exists but does not classify as a recoverable workspace list.
      // This is expected after an intentional valid-empty persist write: the
      // previous session ended with workspaces=[], so the backup mirrors that
      // and we honor the user's intent by not recovering. Not an error.
      emitHydrationDiagnostic()
      return
    }

    let envelope: { state?: Partial<WorkspaceMigrationState> } | null = null
    try {
      envelope = JSON.parse(recovered) as { state?: Partial<WorkspaceMigrationState> }
    } catch (error) {
      hydrationContext.recoveryError = error instanceof Error ? error.message : 'recovery_parse_error'
      emitHydrationDiagnostic()
      return
    }
    if (!envelope?.state || !Array.isArray(envelope.state.workspaces)) {
      emitHydrationDiagnostic()
      return
    }

    // Automations is a global screen now, not a workspace type (store v62). This
    // backup-recovery path bypasses the migrate ladder, so apply the same drop
    // here — both in memory and in the write-back below — so we never re-persist
    // a retired automations workspace. If dropping it empties the list there is
    // nothing to recover, so honor the clean empty state.
    envelope.state.workspaces = envelope.state.workspaces.filter(
      (workspace) => (workspace as { mode?: string }).mode !== 'automations',
    )
    // Roadmap (store v65) and Multiloop (store v66) are retired workspace modes.
    // This backup-recovery path bypasses the migrate ladder too, so run the same
    // retired-mode filter here before we re-persist.
    envelope.state.workspaces = dropRetiredModeWorkspaces(envelope.state.workspaces as Workspace[])
    envelope.state.workspaces = (envelope.state.workspaces as Workspace[]).map(healRetiredRailLayout)
    if (envelope.state.workspaces.length === 0) {
      emitHydrationDiagnostic()
      return
    }

    // App-settings salvage. New backups carry the split settings envelope
    // beside the registry envelope. Older T22-era backups may carry
    // appSettings/sidebarCollapsed inside the recovered registry envelope.
    // In both cases, recovery must not bring the workspace list back while
    // silently dropping recent folders, skill packs, or sidebar state. An old
    // backup can still carry the agent-launch fields; those are main's, and
    // the window keeps its copy of main's record over them.
    const legacyState = envelope!.state as Partial<WorkspaceMigrationState> & {
      sidebarCollapsed?: boolean
    }
    const legacyAppSettings = legacyState.appSettings
    const legacySidebarCollapsed = legacyState.sidebarCollapsed
    const recoveredSettingsState = parseSettingsEnvelopeState(recoveredBackup.settings)

    try {
      // Write back the filtered envelope (automations workspaces already
      // dropped above), never the raw backup, so the on-disk registry matches
      // the recovered in-memory state.
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(envelope))
      if (recoveredBackup.settings && recoveredSettingsState) {
        window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, recoveredBackup.settings)
      }
    } catch {
      // Best-effort write-back; the in-memory recovery still proceeds.
    }
    hydrationContext.storageSource = 'backup'
    hydrationContext.persistedWorkspaceCount = envelope.state.workspaces.length

    useWorkspaceStore.setState((current) => {
      const recoveredWorkspaces = envelope!.state!.workspaces as WorkspaceStore['workspaces']
      const recoveredSettings =
        legacyAppSettings !== undefined
          ? normalizeAppSettings(legacyAppSettings, recoveredWorkspaces as Workspace[])
          : recoveredSettingsState?.appSettings !== undefined
            ? normalizeAppSettings(
                recoveredSettingsState.appSettings as Partial<AppSettings>,
                recoveredWorkspaces as Workspace[],
              )
            : normalizeAppSettings(current.appSettings, recoveredWorkspaces as Workspace[])
      // A backup can carry launch fields from before main owned them; main's
      // record is what this window shows, so they stay as they are.
      const recoveredAppSettings = withLaunchSettings(
        recoveredSettings,
        launchSettingsFromAppSettings(current.appSettings),
        recoveredWorkspaces as Workspace[],
      )
      const normalizedWindows = normalizeWorkspaceWindows(
        recoveredWorkspaces as Workspace[],
        envelope!.state!.workspaceWindows,
        envelope!.state!.primaryWorkspaceWindowId,
        envelope!.state!.activeWorkspaceId ?? current.activeWorkspaceId,
      )
      // Don't let the recovered active pointer dangle at a dropped automations
      // workspace; fall back to the first surviving (filtered) workspace.
      const recoveredActiveId =
        envelope!.state!.activeWorkspaceId &&
        recoveredWorkspaces.some((workspace) => workspace.id === envelope!.state!.activeWorkspaceId)
          ? envelope!.state!.activeWorkspaceId
          : (recoveredWorkspaces[0]?.id ?? current.activeWorkspaceId)
      const next: WorkspaceStore = {
        ...current,
        workspaces: recoveredWorkspaces,
        activeWorkspaceId: recoveredActiveId,
        workspaceWindows: normalizedWindows.windows,
        primaryWorkspaceWindowId: normalizedWindows.primaryWorkspaceWindowId,
        workspaceRegistryEmptyState: null,
        appSettings: recoveredAppSettings,
      }
      if (typeof legacySidebarCollapsed === 'boolean') {
        next.sidebarCollapsed = legacySidebarCollapsed
      } else if (typeof recoveredSettingsState?.sidebarCollapsed === 'boolean') {
        next.sidebarCollapsed = recoveredSettingsState.sidebarCollapsed
      }
      return next
    })

    // Mirror the recovered app-settings to sprintengine-app-settings now so the
    // next persist write doesn't clobber recentWorkspaceFolders with the
    // current empty state.
    if (
      legacyAppSettings !== undefined ||
      typeof legacySidebarCollapsed === 'boolean' ||
      recoveredSettingsState !== null
    ) {
      try {
        const next = useWorkspaceStore.getState()
        window.localStorage.setItem(
          APP_SETTINGS_STORAGE_KEY,
          JSON.stringify({
            state: {
              appSettings: persistableAppSettings(next.appSettings),
              sidebarCollapsed: next.sidebarCollapsed,
            },
            version: WORKSPACE_STORE_VERSION,
          }),
        )
      } catch {
        // Best-effort write-back; in-memory state still carries the salvage.
      }
    }
  } catch (error) {
    hydrationContext.recoveryError = error instanceof Error ? error.message : 'unknown_recovery_error'
  }

  emitHydrationDiagnostic()
}

function emitHydrationDiagnostic(): void {
  const hydratedWorkspaceCount = useWorkspaceStore.getState().workspaces.length
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? null
  const diagnostic: HydrationDiagnostic = {
    persistedWorkspaceCount: hydrationContext.persistedWorkspaceCount,
    hydratedWorkspaceCount,
    activeWorkspaceId,
    storageSource: hydrationContext.storageSource,
    classification: hydrationContext.classification,
    ...(hydrationContext.parseError ? { parseError: hydrationContext.parseError } : {}),
    ...(hydrationContext.recoveryError ? { recoveryError: hydrationContext.recoveryError } : {}),
  }
  console.info('[workspaceStore] hydration', diagnostic)
}

// Spelled out rather than inferred: the inferred type runs through immer's draft
// types, which immer 11 no longer exports, and this project emits declarations
// (`composite`), so an inferred type it cannot name fails the typecheck.
type WorkspaceStoreHook = UseBoundStore<
  Mutate<StoreApi<WorkspaceStore>, [['zustand/persist', unknown], ['zustand/immer', never]]>
>

export const useWorkspaceStore: WorkspaceStoreHook = create<WorkspaceStore>()(
  persist(
    immer((set, get) => ({
      ...createAuthSlice(set),
      ...createSettingsSlice(set),
      ...createLayoutSlice(set),
      ...createAgentsSlice(set),
      ...createWorktreesSlice(set),
      ...createMemorySlice(set),
      ...createPluginsSlice(set),
      ...createCliAvailabilitySlice(set),
      ...createHostedCardFeedSlice(set),
      ...createCliVersionAdvisorySlice(set),
      ...createWorkspacePaneSlice(set),
      ...createFocusedAgentSlice(set),
      ...createWorkspacesSlice(set, workspacesSliceDeps, get),
    })),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: WORKSPACE_STORE_VERSION,
      // The middleware's option type is widened to `unknown` by the explicit
      // hook type above; partialize and this storage agree on the slice.
      storage: workspaceStateStorage as PersistStorage<unknown>,
      migrate: (persisted: unknown, version: number) => {
        try {
          return migratePersistedWorkspaceState(persisted, version)
        } catch (error) {
          hydrationContext.parseError = error instanceof Error ? error.message : 'migration_failed'
          throw error
        }
      },
      merge: (persisted, current) => {
        const state = persisted as
          | Partial<
              WorkspaceMigrationState & {
                sidebarCollapsed?: boolean
                chatListView?: string
                sidebarWidth?: number
                workspacePaneWidth?: number
              }
            >
          | undefined
        // Version-gated migrations cannot be the only enforcement of these
        // workspace-row invariants: a dev-HMR module swap (or any write path that
        // stamps WORKSPACE_STORE_VERSION onto un-migrated state) leaves the
        // un-migrated rows — a workspace in a mode whose feature was retired —
        // in a "current-version" envelope the migrate ladder will never look at
        // again. merge() runs on every hydration regardless of version, so the
        // invariants self-heal here.
        const rawWorkspaces = nameGenericWorkspaceAgents(
          dropRetiredModeWorkspaces(state?.workspaces ?? current.workspaces),
          // Files/Git rail tabs → pane tabs (browser-pane epic, store v73): the
          // enforcement half, for the same reason as the heals above.
        ).map(healRetiredRailLayout)
        const workspaces = rawWorkspaces
        const normalizedWindows = normalizeWorkspaceWindows(
          workspaces,
          state?.workspaceWindows ?? current.workspaceWindows,
          state?.primaryWorkspaceWindowId ?? current.primaryWorkspaceWindowId,
          state?.activeWorkspaceId ?? current.activeWorkspaceId,
        )

        // The persisted active pointer can reference a host the dedupe just
        // dropped; fall back to a surviving workspace instead of dangling.
        const persistedActiveWorkspaceId =
          state?.activeWorkspaceId && workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
            ? state.activeWorkspaceId
            : null
        return {
          ...current,
          ...state,
          workspaces,
          activeWorkspaceId:
            persistedActiveWorkspaceId ??
            (state?.activeWorkspaceId ? (workspaces[0]?.id ?? null) : current.activeWorkspaceId),
          workspaceWindows: normalizedWindows.windows,
          primaryWorkspaceWindowId: normalizedWindows.primaryWorkspaceWindowId,
          sidebarCollapsed:
            typeof state?.sidebarCollapsed === 'boolean' ? state.sidebarCollapsed : current.sidebarCollapsed,
          // A value this build does not know (an older or newer name for a
          // rail shape) falls back to the default rather than leaving the rail
          // in a shape nothing renders.
          chatListView:
            state?.chatListView === 'all' || state?.chatListView === 'projects'
              ? state.chatListView
              : current.chatListView,
          sidebarWidth:
            typeof state?.sidebarWidth === 'number' ? clampSidebarWidth(state.sidebarWidth) : current.sidebarWidth,
          workspacePaneWidth:
            typeof state?.workspacePaneWidth === 'number'
              ? clampWorkspaceAsideWidth(state.workspacePaneWidth)
              : current.workspacePaneWidth,
          workspaceRegistryEmptyState:
            state?.workspaceRegistryEmptyState !== undefined
              ? state.workspaceRegistryEmptyState
              : current.workspaceRegistryEmptyState,
          appSettings: mergePersistedAppSettings(state?.appSettings, current.appSettings, workspaces),
        }
      },
      partialize: partializeWorkspaceStoreState,
      // Hydration diagnostic emission moved to attemptBackupRecovery so the
      // single canonical entry reflects the final storageSource and any
      // recovery error. onRehydrateStorage only records sync-rehydrate parse
      // errors that arose before recovery; the diagnostic is emitted exactly
      // once when recovery completes (or is a no-op for non-dangerous states).
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          hydrationContext.parseError =
            hydrationContext.parseError ?? (error instanceof Error ? error.message : 'rehydrate_failed')
        }
      },
    },
  ),
)

function scheduleInitialPluginCatalogRefresh(): void {
  if (typeof window === 'undefined') return
  if (!window.api || typeof window.api.pluginsList !== 'function') return
  queueMicrotask(() => {
    const store = useWorkspaceStore.getState()
    void store.refreshPluginCatalog()
    // Detect which agent CLI binaries are actually installed so deployment
    // pickers/defaults can hide and avoid defaulting to uninstalled agents.
    // After main's launch settings are in, so the probe runs each CLI's real
    // command and WSL switch rather than the defaults.
    if (typeof window.api?.pluginsDetectAvailability === 'function') {
      void launchSettingsClient.ready.then(() => {
        const current = useWorkspaceStore.getState()
        return current.refreshCliAvailability({
          cliRuntimes: current.appSettings.cliRuntimes,
        })
      })
    }
  })
}

scheduleInitialPluginCatalogRefresh()

// Mirror module enablement to the main process so it can gate module IPC and
// sidecar spawning at the next launch. The renderer is the source of truth; the
// main cache is updated whenever the override changes (deduped). Guarded for
// non-browser bundles (node test harnesses) where window/api are absent.
function syncModuleEnablementToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setModuleEnablement?: (o: Record<string, boolean>) => Promise<unknown> } | undefined
  if (!api?.setModuleEnablement) return

  let lastSerialized = ''
  const push = (overrides: Record<string, boolean>): void => {
    const serialized = JSON.stringify(overrides)
    if (serialized === lastSerialized) return
    lastSerialized = serialized
    void api.setModuleEnablement!(overrides)
  }

  push(useWorkspaceStore.getState().appSettings.modules ?? {})
  useWorkspaceStore.subscribe((state) => push(state.appSettings.modules ?? {}))
}
syncModuleEnablementToMain()

// Mirror the "Pause idle terminals after" setting (minutes → ms) to the main
// reap policy so the next idle sweep uses the user's value. Renderer is the
// source of truth; pushed on startup and on every change (deduped). Main clamps.
function syncTerminalIdleSuspendToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setTerminalIdleSuspendMs?: (ms: number) => Promise<unknown> } | undefined
  if (!api?.setTerminalIdleSuspendMs) return

  let lastSent = NaN
  const push = (minutes: number): void => {
    const ms = Math.round(minutes * 60 * 1000)
    if (ms === lastSent) return
    lastSent = ms
    void api.setTerminalIdleSuspendMs!(ms)
  }

  push(useWorkspaceStore.getState().appSettings.terminalIdleSuspendMinutes)
  useWorkspaceStore.subscribe((state) => push(state.appSettings.terminalIdleSuspendMinutes))
}
syncTerminalIdleSuspendToMain()

// Mirror the "Always keep running" recency floor to the main reap policy so the
// next idle sweep never pauses below the user's N most recently used agents.
// Renderer is the source of truth; pushed on startup and on every change
// (deduped). Main clamps.
function syncTerminalKeepRecentAliveToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setTerminalKeepRecentAliveCount?: (count: number) => Promise<unknown> } | undefined
  if (!api?.setTerminalKeepRecentAliveCount) return

  let lastSent = NaN
  const push = (count: number): void => {
    if (count === lastSent) return
    lastSent = count
    void api.setTerminalKeepRecentAliveCount!(count)
  }

  push(useWorkspaceStore.getState().appSettings.terminalKeepRecentAlive)
  useWorkspaceStore.subscribe((state) => push(state.appSettings.terminalKeepRecentAlive))
}
syncTerminalKeepRecentAliveToMain()

// One-time hydration handshake. On the first boot after the registry
// inverted, main has no registry file and this window is the only place the
// user's workspaces exist. It offers its POST-migrate-ladder state — the value
// after zustand's `migrate` chain has run up to WORKSPACE_STORE_VERSION —
// because the ladder lives here and would never be re-run against main's file.
//
// Main decides: it seeds only when it has written nothing, so a second window
// racing this one is a no-op rather than a merge, and it REFUSES an empty offer
// that carries no explicit "the user removed everything" record. The legacy key
// is left untouched either way, so a refusal costs one boot and retries.
async function offerRegistryHydration(): Promise<void> {
  const api = window.api as
    | {
        workspaceRegistryNeedsHydration?: () => Promise<boolean>
        workspaceRegistryHydrate?: (payload: unknown) => Promise<unknown>
      }
    | undefined
  if (!api?.workspaceRegistryNeedsHydration || !api.workspaceRegistryHydrate) return
  let needsHydration = false
  try {
    needsHydration = await api.workspaceRegistryNeedsHydration()
  } catch {
    return
  }
  if (!needsHydration) return
  const state = useWorkspaceStore.getState()
  const registry = readWorkspaceRegistryKey()
  try {
    await api.workspaceRegistryHydrate({
      ...partializeRegistryFields(state),
      rawLocalStorage: registry.raw,
    })
  } catch (error) {
    console.warn('[workspaceStore] workspace registry hydration offer failed', {
      message: error instanceof Error ? error.message : 'unknown',
    })
  }
}

function withoutRetiredModeWorkspaces(
  snapshot: import('../../../shared/workspace-sync').WorkspaceSyncSnapshot,
): import('../../../shared/workspace-sync').WorkspaceSyncSnapshot {
  const retiredIds = new Set(
    snapshot.state.workspaces
      .filter((workspace) => isRetiredWorkspaceMode(workspace.mode))
      .map((workspace) => workspace.id),
  )
  if (retiredIds.size === 0) return snapshot
  const keep = (workspaceId: WorkspaceId | null): WorkspaceId | null =>
    workspaceId && retiredIds.has(workspaceId) ? null : workspaceId
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      workspaces: snapshot.state.workspaces.filter((workspace) => !retiredIds.has(workspace.id)),
      activeWorkspaceId: keep(snapshot.state.activeWorkspaceId),
      workspaceWindows: snapshot.state.workspaceWindows.map((windowState) => ({
        ...windowState,
        workspaceIds: windowState.workspaceIds.filter((workspaceId) => !retiredIds.has(workspaceId)),
        activeWorkspaceId: keep(windowState.activeWorkspaceId),
      })),
    },
  }
}

// Adopt main's registry wholesale. This is the mirror's seed at start and its
// recovery after a sequence gap. Presentation state the renderer still owns
// (open editor files, the file-explorer/backlog/git panel view) is preserved
// per workspace: main strips those fields on write, so taking the snapshot
// verbatim would blank the panels of every workspace on every resync.
function adoptRegistrySnapshot(rawSnapshot: import('../../../shared/workspace-sync').WorkspaceSyncSnapshot): void {
  // Retired-mode rows (`RETIRED_WORKSPACE_MODES`) never enter the window, the
  // same filter `dropRetiredModeWorkspaces` applies to the localStorage path.
  // Main drops them when it loads its registry; this covers a snapshot from a
  // main that still carries one.
  const snapshot = withoutRetiredModeWorkspaces(rawSnapshot)
  // An empty registry never replaces a non-empty window. This is the same wipe
  // guard the localStorage path has carried since an empty snapshot overwrote a
  // real profile once, moved to the seam where the hazard now lives: on the
  // first boot the hydration offer and this seed race, and a corrupt registry
  // file reads as empty on purpose. Either way, blanking every open workspace
  // is never the right answer — main re-seeds from this window instead.
  if (snapshot.state.workspaces.length === 0 && useWorkspaceStore.getState().workspaces.length > 0) {
    console.warn('[workspaceStore] ignored an empty registry snapshot over a non-empty window', {
      localWorkspaceCount: useWorkspaceStore.getState().workspaces.length,
      snapshotSequence: snapshot.sequence,
    })
    resolveWorkspaceRegistryReady()
    return
  }
  // Layouts main still holds in their rail form (Files/Git docked): healed on
  // the way in, and written back once so the heal converges instead of
  // re-running on every snapshot.
  const healedLayouts: { id: WorkspaceId; layoutModel: Workspace['layoutModel'] }[] = []
  useWorkspaceStore.setState((current) => {
    const currentById = new Map(current.workspaces.map((workspace) => [workspace.id, workspace] as const))
    const workspaces = snapshot.state.workspaces.map((raw) => {
      // Main's copy of a layout can still dock Files/Git in the rail until a
      // window's next layout write; heal it here as merge() does.
      const incoming = healRetiredRailLayout(raw)
      if (incoming.layoutModel !== raw.layoutModel) {
        healedLayouts.push({ id: incoming.id, layoutModel: incoming.layoutModel })
      }
      const existing = currentById.get(incoming.id)
      if (!existing) return incoming
      return keepLaterWorkspaceClocks(existing, {
        ...incoming,
        editorState: existing.editorState,
        fileExplorerState: existing.fileExplorerState,
        backlogState: existing.backlogState,
        gitPanelState: existing.gitPanelState,
        // The pane record is window-owned view state like the three above:
        // main never carries it, so a snapshot must not blank it. Main's
        // layout can still dock the Backlog rail (store v74) while this
        // window already has a pane: the heal above seeded a pane from the
        // raw layout that the existing record would now discard, so adopt
        // the rail into the record we keep instead.
        paneState: existing.paneState ? adoptLegacyBacklogTab(raw.layoutModel, existing.paneState) : incoming.paneState,
        // Live-only fields main never persists: a module's own cache in the
        // state bag, and in-flight terminal metadata for agents this window
        // owns.
        moduleState: existing.moduleState,
        agents: preserveAgentTerminalMetadata(incoming, existing).agents,
      })
    })
    return {
      ...current,
      workspaces,
      activeWorkspaceId: snapshot.state.activeWorkspaceId ?? current.activeWorkspaceId,
      workspaceWindows: snapshot.state.workspaceWindows,
      primaryWorkspaceWindowId: snapshot.state.primaryWorkspaceWindowId,
      workspaceRegistryEmptyState: workspaces.length === 0 ? current.workspaceRegistryEmptyState : null,
    }
  })
  for (const healed of healedLayouts) {
    void workspaceSyncClient.dispatchUpdateWorkspaceLayout(healed.id, healed.layoutModel)
  }
  // A window may still remember a name that main lost. Persist that recovery
  // before consulting terminal metadata, which may carry an older launch name.
  const adopted = useWorkspaceStore.getState().workspaces
  for (const raw of snapshot.state.workspaces) {
    const workspace = adopted.find((candidate) => candidate.id === raw.id)
    for (const [id, agent] of Object.entries(workspace?.agents ?? {})) {
      if (isPlaceholderAgentName(raw.agents[id]?.name, id) && !isPlaceholderAgentName(agent.name, id)) {
        void workspaceSyncClient.dispatchUpdateWorkspaceAgent(raw.id, id, raw.agents[id] ? { name: agent.name } : agent)
      }
    }
  }
  if (
    adopted.some((workspace) =>
      Object.entries(workspace.agents).some(([id, agent]) => isPlaceholderAgentName(agent.name, id)),
    )
  ) {
    void repairRegistryAgentNames()
  }
  resolveWorkspaceRegistryReady()
}

async function repairRegistryAgentNames(): Promise<void> {
  // Read retained sessions too: a paused agent can still carry its original
  // name. Re-read the store after the await so a rename or removal wins.
  const sessions = (await window.api?.terminalList?.().catch(() => [])) ?? []
  const repairs: { workspaceId: string; agentId: string; name: string }[] = []
  useWorkspaceStore.setState((current) => {
    const workspaces = nameGenericWorkspaceAgents(current.workspaces, (workspaceId, agentId) => {
      const agent = current.workspaces.find((workspace) => workspace.id === workspaceId)?.agents[agentId]
      const matching = sessions.filter(
        (session) =>
          session.kind === 'agent' &&
          session.workspaceId === workspaceId &&
          session.agentId === agentId &&
          (!agent?.cliSessionId || agent.cliSessionId === session.sessionId),
      )
      for (const session of matching) {
        for (const name of [session.agentName, session.agentRecord?.name]) {
          if (!isPlaceholderAgentName(name, agentId)) return name
        }
      }
      return undefined
    })
    if (workspaces === current.workspaces) return current
    for (const workspace of workspaces) {
      const before = current.workspaces.find((candidate) => candidate.id === workspace.id)
      for (const [agentId, agent] of Object.entries(workspace.agents)) {
        if (agent.name !== before?.agents[agentId]?.name)
          repairs.push({ workspaceId: workspace.id, agentId, name: agent.name })
      }
    }
    return { ...current, workspaces }
  })
  for (const repair of repairs) {
    void workspaceSyncClient.dispatchUpdateWorkspaceAgent(repair.workspaceId, repair.agentId, { name: repair.name })
  }
}

// Module workspace launchers must see main's saved rows before deduplicating.
// A failed initial read deliberately leaves automatic creation pending.
let resolveWorkspaceRegistryReady: () => void = () => undefined
export const workspaceRegistryReady = new Promise<void>((resolve) => {
  resolveWorkspaceRegistryReady = resolve
  if (typeof window === 'undefined' || typeof window.api?.workspaceSyncGetSnapshot !== 'function') resolve()
})

// Wire the main-mediated workspace sync bus. The client asks main for every
// registry mutation and applies the accepted/broadcast events to this window's
// mirror. Main is the authority: an apply is not a local decision being
// recorded, it is main's decision being adopted.
function initWorkspaceSyncClient(): void {
  if (typeof window === 'undefined') return
  // Applying an imported (accepted or broadcast) event must not re-emit a
  // command — the no-echo contract. It no longer needs the persist-suppression
  // and dedup-baseline plumbing it used to: with the registry out of
  // localStorage, an apply cannot trigger a registry write, and there is no
  // storage listener left to echo it back.
  const applyImportedSyncEvent = (apply: () => void): void => {
    apply()
  }
  const patchWorkspace = (workspaceId: WorkspaceId, patch: (workspace: Workspace) => Workspace): void => {
    useWorkspaceStore.setState((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => (workspace.id === workspaceId ? patch(workspace) : workspace)),
    }))
  }
  configureWorkspaceSyncClient({
    applyRegistrySnapshot: (snapshot) => applyImportedSyncEvent(() => adoptRegistrySnapshot(snapshot)),
    applyWorkspaceRenamed: (apply) =>
      applyImportedSyncEvent(() =>
        patchWorkspace(apply.workspaceId, (workspace) => ({
          ...workspace,
          name: apply.name,
          ...(apply.titleLocked !== undefined ? { titleLocked: apply.titleLocked } : {}),
        })),
      ),
    applyWorkspaceLayoutUpdated: (apply) =>
      applyImportedSyncEvent(() =>
        patchWorkspace(apply.workspaceId, (workspace) => ({
          ...workspace,
          // A window on an older build can still broadcast a layout docking a
          // retired rail tab; this window never renders one.
          layoutModel: stripRetiredRailTabsFromLayout(apply.layoutModel) as Workspace['layoutModel'],
        })),
      ),
    applyWorkspaceFieldsUpdated: (apply) =>
      applyImportedSyncEvent(() => {
        let settled = false
        let snoozed = false
        patchWorkspace(apply.workspaceId, (workspace) => {
          // The shared patch contract: absent = no opinion, null = cleared, a
          // clock only advances (`applyWorkspaceFieldsPatch`).
          const next = { ...workspace } as Record<string, unknown>
          applyWorkspaceFieldsPatch(next, apply.patch)
          settled = !isSettledWorkspace(workspace) && isSettledWorkspace(next as Workspace)
          const now = Date.now()
          snoozed = !isSnoozeUnexpired(workspace, now) && isSnoozeUnexpired(next as Workspace, now)
          return next as Workspace
        })
        // Settled somewhere else: the sidebar ends its processes and moves
        // the person on, as a Settle made here does.
        if (settled) noteWorkspaceSettledElsewhere(apply.workspaceId)
        // Snoozed somewhere else (a paired desktop's row menu): the sidebar
        // pauses its processes, as a Snooze made here does.
        else if (snoozed) noteWorkspaceSnoozedElsewhere(apply.workspaceId)
      }),
    applyWorkspaceAgentUpdated: (apply) =>
      applyImportedSyncEvent(() =>
        patchWorkspace(apply.workspaceId, (workspace) => {
          if (apply.patch === null) {
            const { [apply.agentId]: _removed, ...agents } = workspace.agents
            return { ...workspace, agents }
          }
          // An agent that arrives on the bus while this window runs may be one
          // main just launched and registered; the session tick decides whether
          // it gets a tab. A snapshot never counts, so a reload reveals nothing.
          if (!workspace.agents[apply.agentId]) noteLaunchedAgentArrived(workspace.id, apply.agentId)
          const existing = workspace.agents[apply.agentId] ?? defaultAgent(apply.agentId)
          return {
            ...workspace,
            agents: {
              ...workspace.agents,
              [apply.agentId]: { ...existing, ...apply.patch, configEditedAt: apply.configEditedAt },
            },
          }
        }),
      ),
    applyWorkspaceRemoved: (apply) =>
      applyImportedSyncEvent(() => {
        useWorkspaceStore.setState((current) => ({
          ...current,
          workspaces: current.workspaces.filter((workspace) => workspace.id !== apply.workspaceId),
          activeWorkspaceId:
            current.activeWorkspaceId === apply.workspaceId
              ? (current.workspaces.filter((workspace) => workspace.id !== apply.workspaceId).at(-1)?.id ?? null)
              : current.activeWorkspaceId,
          workspaceWindows: current.workspaceWindows.map((windowState) => ({
            ...windowState,
            workspaceIds: windowState.workspaceIds.filter((id) => id !== apply.workspaceId),
            activeWorkspaceId:
              windowState.activeWorkspaceId === apply.workspaceId
                ? (windowState.workspaceIds.filter((id) => id !== apply.workspaceId)[0] ?? null)
                : windowState.activeWorkspaceId,
          })),
        }))
      }),
    applyActiveChanged: (apply: WorkspaceActiveChangedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceActiveChangedEvent(apply)),
    applyWorkspaceMoved: (apply: WorkspaceMovedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceMovedEvent(apply)),
    applyWorkspaceClosed: (apply: WorkspaceClosedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceClosedEvent(apply)),
    applyWorkspacePlacement: (apply: WorkspacePlacementApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspacePlacementEvent(apply)),
    applyWorkspaceCreated: (apply: WorkspaceCreatedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceCreatedEvent(apply)),
    applyAgentTerminalSession: (apply: AgentTerminalSessionApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyAgentTerminalSessionEvent(apply)),
    applyAgentTerminalLaunchState: (apply: AgentTerminalLaunchStateApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyAgentTerminalLaunchStateEvent(apply)),
  })
  // Subscribe immediately so no broadcast is missed, and offer hydration
  // alongside it. The two race by design: the snapshot seed cannot blank this
  // window because `adoptRegistrySnapshot` refuses an empty registry over a
  // non-empty one, and once main is seeded its next broadcast (or the next
  // gap resync) carries the authoritative list.
  workspaceSyncClient.start()
  void offerRegistryHydration()
}
initWorkspaceSyncClient()

// Main owns the agent-launch settings; this window's `appSettings` copy of them
// is a read model (launchSettingsClient.ts). Started after hydration so the
// migration offer, if this profile still has one, is already known.
function initLaunchSettingsClient(): void {
  void launchSettingsClient.start({
    api: launchSettingsApiFromWindow(),
    apply: (settings) =>
      useWorkspaceStore.setState((current) => {
        const appSettings = withLaunchSettings(current.appSettings, settings, current.workspaces)
        // An adoption that changes nothing leaves the store alone, so the
        // echo of this window's own write does not re-render every picker.
        if (launchSettingsFieldsEqual(appSettings, current.appSettings)) return current
        return { ...current, appSettings }
      }),
    legacyOffer: () => legacyLaunchSettingsOffer,
    onLegacySettled: stripLegacyLaunchSettingsFromStorage,
  })
}
initLaunchSettingsClient()

// The per-CLI permission presets this profile kept in localStorage before main
// owned them: offered once, after main's record is in, for the CLIs main holds
// nothing for (legacyCliPermissionPresets.ts).
function migrateCliPermissionPresetsToMain(): void {
  if (!launchSettingsApiFromWindow()) return
  let storage: Storage | null = null
  try {
    storage = window.localStorage
  } catch {
    // A restricted context has no localStorage, and so nothing to hand over.
  }
  void launchSettingsClient.ready.then(() =>
    migrateLegacyCliPermissionPresets({
      storage,
      held: async () => (await window.api.launchSettingsGet()).settings.cliPermissionPresets ?? {},
      update: (patch) => launchSettingsClient.update(patch),
    }),
  )
}
migrateCliPermissionPresetsToMain()

/**
 * Resolves once main's launch settings are in this window's store (or main
 * could not be asked). The workspace window renders after it, bounded, so no
 * picker shows a CLI or preset the person never chose.
 */
export const launchSettingsReady: Promise<void> = launchSettingsClient.ready

// Re-export so consumers (tests, devtools) can use a single import surface.
export {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
}
export type { HydrationDiagnostic, PersistedStateClassification }

export const __workspaceStoreBackupRecoveryPromise: Promise<void> = attemptBackupRecovery()
export const __workspaceStoreRunBackupRecoveryForTests = attemptBackupRecovery

/**
 * Take settings another window has just saved, without writing them back.
 *
 * An auxiliary window (a diff, the editor, a popped-out pane) hydrates its
 * settings once, when it opens. When a workspace window saves a change — a
 * theme, a window material — the aux window adopts it through here. Writing
 * the result back would be at best a copy of what is already saved and at
 * worst, should the workspace window save again meanwhile, an older copy over
 * the newer one, so the write it would cause is skipped.
 */
export function adoptStoredSettings(settings: Partial<WorkspaceStore>): void {
  adoptingStoredSettings = true
  try {
    useWorkspaceStore.setState(settings)
  } finally {
    adoptingStoredSettings = false
  }
}
