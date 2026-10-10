import type { IJsonModel } from 'flexlayout-react'
import { current, isDraft } from 'immer'
import { nanoid } from 'nanoid'
import { moveEditorBuffer } from '../../utils/editorBuffers'
import { isPlaceholderAgentName } from '../../utils/agentNames'
import {
  decideWorkspaceSettlement,
  isSettledWorkspace,
  settleWorkspacePatch,
  wakeWorkspacePatch,
} from '../../utils/workspaceSettle'
import { hasSnooze, snoozeWorkspacePatch, wakeSnoozedWorkspacePatch } from '../../utils/workspaceSnooze'
import type { WorkspaceFieldsPatch } from '../../../../shared/workspace-sync'
import { noteChatOpened } from '../../components/panels/agentChat/unreadDivider'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { isRetiredWorkspaceMode } from '../../../../shared/workspace-mode'
import { hostIdToRecord } from '../../../../shared/execution-host'
import { instantiateTemplateAgentIds } from '../../../../shared/agent-ids'
import { workspaceProjectRoot, workspaceProjectRootOf } from '../../utils/workspaceWorktree'
import { isProjectlessChatsRoot } from '../../../../shared/projectless-chats'
import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import { normalizeRecentWorkspaceFolders } from './settingsSlice'
import { releaseWorktreeEntriesOwnedBy } from './worktreesSlice'
import {
  workspaceSyncClient,
  type WorkspaceActiveChangedApply,
  type WorkspaceClosedApply,
  type WorkspaceCreatedApply,
  type WorkspaceMovedApply,
  type WorkspacePlacementApply,
} from '../workspaceSyncClient'
import type {
  AgentCli,
  AgentId,
  AgentState,
  AppSettings,
  EditorState,
  LayoutTemplate,
  GitPanelView,
  Workspace,
  WorkspaceWorktree,
  WorkspaceBacklogState,
  WorkspaceFileExplorerState,
  WorkspaceFolderRole,
  WorkspaceGitPanelState,
  WorkspaceHighlight,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
  WorkspaceMemoryConfig,
  WorkspaceMode,
  WorkspaceWorktreeState,
} from '../../types/workspace'
import { deriveWorkspaceTitle, isDefaultWorkspaceName } from '../../../../shared/workspace-title'
import { MESH_CONVERSATION_COMPONENT, meshConversationSessionId } from '../../../../shared/tailnet-mesh'

// How far the person's last-input clock may run ahead of main's copy before
// the next report is sent as a field patch (recordWorkspaceTerminalActivity).
// Renderer-session scoped: a fresh window sends its first report.
const WORKSPACE_ACTIVITY_CLOCK_SYNC_MS = 60_000
const activityClockSyncedAt = new Map<WorkspaceId, number>()

// Every window sees the same sessions and reaches the same rest decisions, so
// every window applies them locally — but only the window a workspace is
// routed to SPEAKS for it to main. Otherwise M windows send M identical
// commands for one turn end and main commits, rebuilds and re-broadcasts each.
// A row no window routes (a registry whose window entry was dropped) is the
// primary window's to speak for, so nothing is left with no reporter.
function thisWindowSpeaksFor(state: WorkspacesSliceCarrier, workspaceId: WorkspaceId): boolean {
  const owner = findWorkspaceWindow(state, workspaceId)?.id ?? PRIMARY_WORKSPACE_WINDOW_ID
  return owner === getCurrentWorkspaceWindowIdForSlice()
}
// TerminalSessionSnapshot is a global ambient type from src/renderer/src/env.d.ts.

const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'

// This renderer's own window id, derived from the URL like workspaceStore and
// workspaceSyncClient. Used to decide whether a move targets this renderer's
// window (refocus the moved workspace) or another window (keep global active on
// the window this renderer displays). Guarded for the non-DOM test environment.
function getCurrentWorkspaceWindowIdForSlice(): WorkspaceWindowId {
  if (typeof window === 'undefined') return PRIMARY_WORKSPACE_WINDOW_ID
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

export function workspaceFolderKey(value: string | null | undefined): string | null {
  const normalized = normalizeProjectRootKey(value)
  return normalized ? normalized.toLowerCase() : null
}

// A workspace's mode is an open string: `'standard'`, a bundled rail-hidden
// mode, or the id of a module-registered workspace type. Core never mints a
// module's literal itself, so anything non-empty passes through.
export function normalizeWorkspaceMode(input: unknown): WorkspaceMode {
  if (typeof input === 'string' && input.trim().length > 0) return input
  return 'standard'
}

function defaultWorkspaceFileExplorerState(): WorkspaceFileExplorerState {
  return { expandedPaths: [], selectedPath: null }
}

const FOLDER_ROLE_VALUES = {
  sources: true,
  'test-sources': true,
  resources: true,
  'test-resources': true,
  generated: true,
  excluded: true,
} satisfies Record<WorkspaceFolderRole, true>

// Absent rather than empty when nothing is marked, so the persisted registry
// does not carry a `{}` per workspace. An unknown role string is dropped, not
// coerced: a wrong colour on a folder is worse than no colour, and a role this
// build does not know about is one a newer build wrote.
function normalizeWorkspaceFolderRoles(input: unknown): Record<string, WorkspaceFolderRole> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const entries = Object.entries(input as Record<string, unknown>).filter(
    (entry): entry is [string, WorkspaceFolderRole] =>
      entry[0].trim().length > 0 && typeof entry[1] === 'string' && entry[1] in FOLDER_ROLE_VALUES,
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function normalizeWorkspaceFileExplorerState(input: unknown): WorkspaceFileExplorerState {
  const obj = input && typeof input === 'object' ? (input as Partial<WorkspaceFileExplorerState>) : null
  const rawExpandedPaths = obj?.expandedPaths
  const expandedPaths = Array.isArray(rawExpandedPaths)
    ? Array.from(
        new Set(rawExpandedPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)),
      )
    : []
  const selectedPath =
    typeof obj?.selectedPath === 'string' && obj.selectedPath.trim().length > 0 ? obj.selectedPath : null
  const folderRoles = normalizeWorkspaceFolderRoles(obj?.folderRoles)
  return folderRoles ? { expandedPaths, selectedPath, folderRoles } : { expandedPaths, selectedPath }
}

function defaultWorkspaceBacklogState(): WorkspaceBacklogState {
  return { selectedRelativePath: null, view: 'active', sort: 'recent', group: 'none', search: '' }
}

// Runtime guards for the persisted enums, exhaustiveness-checked against the
// source unions via `satisfies` so a new lens/sort fails to compile until it is
// added here too.
const BACKLOG_VIEW_VALUES = {
  active: true,
  all: true,
  epics: true,
  quick_wins: true,
  strategic_bets: true,
  defer: true,
  unestimated: true,
  completed: true,
  archived: true,
} satisfies Record<WorkspaceBacklogState['view'], true>

const BACKLOG_SORT_VALUES = {
  best: true,
  recent: true,
  created: true,
  status: true,
  priority: true,
  largest: true,
  smallest: true,
  dependency: true,
  no_epic: true,
} satisfies Record<WorkspaceBacklogState['sort'], true>

const BACKLOG_GROUP_VALUES = {
  none: true,
  by_epic: true,
} satisfies Record<WorkspaceBacklogState['group'], true>

const MAX_BACKLOG_SEARCH_LENGTH = 200

// Returns undefined for absent state so the persisted registry is not bloated
// with a default record for every workspace; a present-but-malformed record is
// coerced to safe defaults rather than dropped.
export function normalizeWorkspaceBacklogState(input: unknown): WorkspaceBacklogState | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<WorkspaceBacklogState>
  const view =
    typeof raw.view === 'string' && raw.view in BACKLOG_VIEW_VALUES
      ? (raw.view as WorkspaceBacklogState['view'])
      : 'active'
  const sort =
    typeof raw.sort === 'string' && raw.sort in BACKLOG_SORT_VALUES
      ? (raw.sort as WorkspaceBacklogState['sort'])
      : 'recent'
  const group =
    typeof raw.group === 'string' && raw.group in BACKLOG_GROUP_VALUES
      ? (raw.group as WorkspaceBacklogState['group'])
      : 'none'
  const selectedRelativePath =
    typeof raw.selectedRelativePath === 'string' && raw.selectedRelativePath.trim().length > 0
      ? raw.selectedRelativePath
      : null
  const search = typeof raw.search === 'string' ? raw.search.slice(0, MAX_BACKLOG_SEARCH_LENGTH) : ''
  return { selectedRelativePath, view, sort, group, search }
}

function defaultWorkspaceGitPanelState(): WorkspaceGitPanelState {
  return { activeView: 'changes', activeScopeId: 'main', commitDraftsByScopeId: {} }
}

const GIT_PANEL_VIEW_VALUES = {
  changes: true,
  worktrees: true,
  log: true,
  stashes: true,
  terminal: true,
} satisfies Record<GitPanelView, true>

const MAX_COMMIT_DRAFT_LENGTH = 10000

export function normalizeWorkspaceGitPanelState(input: unknown): WorkspaceGitPanelState | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<WorkspaceGitPanelState>
  const activeView =
    typeof raw.activeView === 'string' && raw.activeView in GIT_PANEL_VIEW_VALUES
      ? (raw.activeView as GitPanelView)
      : 'changes'
  const activeScopeId =
    typeof raw.activeScopeId === 'string' && raw.activeScopeId.trim().length > 0 ? raw.activeScopeId : 'main'
  const commitDraftsByScopeId: Record<string, string> = {}
  if (raw.commitDraftsByScopeId && typeof raw.commitDraftsByScopeId === 'object') {
    for (const [scopeId, text] of Object.entries(raw.commitDraftsByScopeId)) {
      if (scopeId.length > 0 && typeof text === 'string' && text.trim().length > 0) {
        commitDraftsByScopeId[scopeId] = text.slice(0, MAX_COMMIT_DRAFT_LENGTH)
      }
    }
  }
  return { activeView, activeScopeId, commitDraftsByScopeId }
}

interface WorkspacesSliceState {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  // Explicit intent record set by removeWorkspace when the splice leaves
  // workspaces=[] and cleared by addWorkspace/importWorkspace. Persisted into
  // the workspace-registry storage key so cold-load distinguishes user-removed-
  // all from hydration failure.
  workspaceRegistryEmptyState: import('../../types/workspace').WorkspaceRegistryEmptyState | null
}

interface WorkspacesSliceActions {
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
  setWorkspaceHighlight: (id: WorkspaceId, highlight: Partial<WorkspaceHighlight>) => void
  clearWorkspaceHighlight: (id: WorkspaceId) => void
  setWorkspaceSettled: (id: WorkspaceId, settled: boolean) => void
  /**
   * Mark a chat's worktree as given back by the agent worktree cleanup (a
   * stamp), or as on disk again (`null`). See `WorkspaceWorktree.reclaimedAt`.
   */
  setWorkspaceWorktreeReclaimed: (id: WorkspaceId, reclaimedAt: number | null) => void
  setWorkspaceChatFolder: (id: WorkspaceId, folderPath: string, worktree: WorkspaceWorktree | null) => void
  setWorkspaceAutoSettle: (id: WorkspaceId, enabled: boolean) => void
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
    /** Each chat's pull requests, for Settle on merge; absent while not yet read. */
    pullRequestsByWorkspaceId?: Readonly<Record<string, readonly BranchPullRequest[]>>
  }) => WorkspaceId[]
  recordWorkspaceTerminalActivity: (id: WorkspaceId, lastInputAt: number) => void
  recordWorkspaceUserMessage: (id: WorkspaceId, at: number) => void
  recordWorkspaceTurnEnd: (id: WorkspaceId, at: number) => void
  recordWorkspaceVisit: (id: WorkspaceId, at: number) => void
  speaksForWorkspace: (id: WorkspaceId) => boolean
  forgetFolder: (folderPath: string) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: {
      name?: string
      folderPath?: string | null
      // Set for a chat created on a paired machine; see Workspace.remoteOrigin.
      remoteOrigin?: import('../../types/workspace').WorkspaceRemoteOrigin | null
      // The machine on this computer the workspace runs on; see Workspace.hostId.
      hostId?: import('../../../../shared/execution-host').ExecutionHostId | null
      // The SSH machine it is on; see Workspace.environment.
      environment?: import('../../types/workspace').WorkspaceEnvironmentRef | null
      worktree?: WorkspaceWorktree | null
      // CLI for the general template agents (e.g. the solo "New chat" agent).
      // When set, overrides the remembered `lastSelectedCli` default below.
      templateAgentCli?: AgentCli | null
      mode?: Workspace['mode']
      // Externally-triggered creation: it must not dismiss whatever the
      // operator is reading, so a background create skips the door-surface
      // clear that user-initiated creation does.
      // activeWorkspaceId assignment is unchanged either way.
      background?: boolean
      // False: the workspace joins its window without coming to the front (a
      // chat started with ⌘⏎ from New chat), and leaves the doors alone.
      activate?: false
      windowId?: WorkspaceWindowId | null
      // Open-in-new-chat seed for the single-agent "solo chat" template. The UI
      // builds a data-only descriptor so this slice never imports prompt
      // helpers. `agentPatch` is merged onto the lone template agent
      // record, `tabName` renames the lone layout tab, and `terminal` swaps that
      // tab for a terminal tab (and seeds no agent record).
      seedAgent?: SoloChatSeed | null
      // The layout's agent tabs name agents of this workspace that are moving
      // in (a tab dragged out of another chat): their ids are kept, and each
      // one's own record leaves that workspace and arrives in this one's create,
      // so main never holds the new chat's tab without the agent behind it.
      // Otherwise every template agent takes a fresh id and a fresh record.
      moveLayoutAgentsFrom?: WorkspaceId
    },
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  /**
   * Name a still-default workspace after `prompt`, the first real request sent
   * inside it. No-op when the name is already locked or the prompt yields no
   * usable title. Returns the title it applied, or null when it applied none,
   * so a model-written title arriving later knows what it may replace.
   */
  autoTitleWorkspaceFromPrompt: (id: WorkspaceId, prompt: string) => string | null
  /**
   * Land a model-written title that was requested when `replacing` was applied
   * by the heuristic (or null when the heuristic applied nothing). It lands
   * only if nobody has renamed the workspace since: the name must still be
   * `replacing`, or, when that is null, the name must still be unlocked. Returns
   * whether it landed. A late result after a hand rename is dropped, and the
   * person's name stands.
   */
  applyGeneratedWorkspaceTitle: (id: WorkspaceId, title: string, replacing: string | null) => boolean
  setActiveWorkspace: (id: WorkspaceId) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  setFileExplorerExpandedPaths: (id: WorkspaceId, expandedPaths: string[]) => void
  setFileExplorerFolderRole: (id: WorkspaceId, folderPath: string, role: WorkspaceFolderRole | null) => void
  setFileExplorerSelectedPath: (id: WorkspaceId, selectedPath: string | null) => void
  setBacklogViewState: (id: WorkspaceId, patch: Partial<WorkspaceBacklogState>) => void
  setGitPanelState: (id: WorkspaceId, patch: Partial<Omit<WorkspaceGitPanelState, 'commitDraftsByScopeId'>>) => void
  /**
   * Remember which agent this workspace is on — the agent whose terminal tab
   * was last selected. Idempotent by design: the layout calls it on every
   * selection change and on mount, so the common case must be a no-op rather
   * than a write that re-persists the registry.
   */
  setLastActiveAgent: (id: WorkspaceId, agentId: string | null) => void
  setGitCommitDraft: (id: WorkspaceId, scopeId: string, text: string) => void
  clearGitCommitDraft: (id: WorkspaceId, scopeId: string) => void
  /**
   * Write one module's entry in a workspace's per-module state bag;
   * null/undefined removes it. False when the workspace is unknown. Declared
   * here AND on the WorkspaceStore interface (dual-declaration).
   */
  setWorkspaceModuleState: (workspaceId: WorkspaceId, moduleId: string, state: unknown) => boolean
  importWorkspace: (ws: Workspace) => void
  /**
   * Move an agent record to another workspace, keeping its id. False, and
   * nothing moved, when the destination already has an agent of that id; see
   * the action for why it refuses rather than renaming.
   */
  moveAgentToWorkspace: (sourceWorkspaceId: WorkspaceId, destWorkspaceId: WorkspaceId, agentId: AgentId) => boolean
  /** Delete an agent record from a workspace entirely (not just close its tab).
   *  Caller is responsible for killing the agent's terminal and removing its
   *  layout tab first. Idempotent: a missing workspace/agent is a no-op. */
  removeAgent: (workspaceId: WorkspaceId, agentId: AgentId) => void
  moveOpenFileToWorkspace: (sourceWorkspaceId: WorkspaceId, destWorkspaceId: WorkspaceId, path: string) => void
}

export type WorkspacesSlice = WorkspacesSliceState & WorkspacesSliceActions

// Cross-slice helpers passed in by workspaceStore.ts. Each is the same module-
// scope function used inline today; deferring its move to the matching slice
// (agents/layout/run-state/worktrees/memory). When those slices land, the deps
// shrink. This explicit DI keeps workspacesSlice import-cycle-free.
export interface WorkspacesSliceDependencies {
  defaultAgent: (id: AgentId, name?: string) => AgentState
  defaultEditorState: () => EditorState
  defaultWorkspaceMemoryConfig: () => WorkspaceMemoryConfig
  defaultWorkspaceWorktreeState: () => WorkspaceWorktreeState
  normalizeAgentState: (agent: AgentState) => AgentState
  normalizeWorkspaceWorktreeState: (input: Partial<WorkspaceWorktreeState> | null | undefined) => WorkspaceWorktreeState
  hideNavRailTabStrip: (model: IJsonModel | null | undefined) => IJsonModel | null | undefined
  pickWorkspaceAgentName: (agents: Workspace['agents']) => string
  isPathOrChild: (path: string, parentPath: string) => boolean
}

// activeGlobalSurface is owned by the settings slice but cleared here: activating
// a workspace must return the card region from a door-routed full-page surface to
// that workspace (the sidebar's one-selected-thing invariant, global-surfaces
// epic 1704). activeModalSurface clears with it (doors→modals, 2026-09-01): a
// reveal must land on a visible workspace, not one behind a scrim. The combined
// store carries both fields; the carrier widens to reach them.
type WorkspacesSliceCarrier = WorkspacesSliceState & {
  appSettings: AppSettings
  activeGlobalSurface: string | null
  activeModalSurface: string | null
  activeModalSurfaceWorkspaceId: string | null
}
type WorkspacesSliceSet = (mutator: (state: WorkspacesSliceCarrier) => void) => void

// The one activation-side dismissal of routed/floating surfaces: activating a
// workspace returns the card region from a door AND closes any modal, so the
// workspace lands visible (doors→modals, 2026-09-01). Every activation path
// calls this — a new path that forgets it re-opens the invisible-reveal bug.
function clearRoutedSurfaces(state: WorkspacesSliceCarrier): void {
  state.activeGlobalSurface = null
  state.activeModalSurface = null
  // The opener workspace is part of the modal, and goes when it does.
  state.activeModalSurfaceWorkspaceId = null
}

function findWorkspaceWindow(
  state: WorkspacesSliceCarrier,
  workspaceId: WorkspaceId,
): WorkspaceWindowState | undefined {
  return state.workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))
}

function ensureWorkspaceWindow(
  state: WorkspacesSliceCarrier,
  windowId: WorkspaceWindowId,
  kind: WorkspaceWindowState['kind'] = windowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
): WorkspaceWindowState {
  const existing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
  if (existing) return existing

  const now = Date.now()
  const windowState: WorkspaceWindowState = {
    id: windowId,
    kind,
    workspaceIds: [],
    activeWorkspaceId: null,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: now,
    lastFocusedAt: now,
  }
  state.workspaceWindows.push(windowState)
  return windowState
}

function normalizeBounds(bounds: WorkspaceWindowState['bounds'] | null | undefined): WorkspaceWindowState['bounds'] {
  if (!bounds) return null
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(Number.isFinite)) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(800, Math.round(width)),
    height: Math.max(600, Math.round(height)),
  }
}

function normalizeWindowAssignments(state: WorkspacesSliceCarrier): void {
  const workspaceOrder = new Map(state.workspaces.map((workspace, index) => [workspace.id, index] as const))
  const validWorkspaceIds = new Set(workspaceOrder.keys())
  const assignedWorkspaceIds = new Set<WorkspaceId>()
  const primaryWindow = ensureWorkspaceWindow(state, state.primaryWorkspaceWindowId, 'primary')
  primaryWindow.kind = 'primary'

  state.workspaceWindows.forEach((windowState) => {
    const nextWorkspaceIds: WorkspaceId[] = []
    for (const workspaceId of windowState.workspaceIds) {
      if (!validWorkspaceIds.has(workspaceId) || assignedWorkspaceIds.has(workspaceId)) continue
      nextWorkspaceIds.push(workspaceId)
      assignedWorkspaceIds.add(workspaceId)
    }
    windowState.workspaceIds = nextWorkspaceIds.sort(
      (left, right) => (workspaceOrder.get(left) ?? 0) - (workspaceOrder.get(right) ?? 0),
    )
    if (!windowState.activeWorkspaceId || !nextWorkspaceIds.includes(windowState.activeWorkspaceId)) {
      windowState.activeWorkspaceId = nextWorkspaceIds[0] ?? null
    }
  })

  for (const workspace of state.workspaces) {
    if (assignedWorkspaceIds.has(workspace.id)) continue
    primaryWindow.workspaceIds.push(workspace.id)
    assignedWorkspaceIds.add(workspace.id)
  }
  if (!primaryWindow.activeWorkspaceId || !primaryWindow.workspaceIds.includes(primaryWindow.activeWorkspaceId)) {
    primaryWindow.activeWorkspaceId = primaryWindow.workspaceIds[0] ?? null
  }
  state.workspaceWindows = state.workspaceWindows.filter(
    (windowState) => windowState.kind === 'primary' || windowState.workspaceIds.length > 0,
  )
}

type LayoutAgentTabNode = {
  component?: unknown
  name?: unknown
  config?: {
    agentId?: unknown
  }
  children?: LayoutAgentTabNode[]
}

// Data-only descriptor for opening a specific agent in a fresh "solo chat"
// workspace (see addWorkspace `seedAgent`). Built by the spawn-menu UI so this
// slice stays free of prompt/runtime imports.
export type SoloChatSeed = {
  agentPatch?: Partial<AgentState>
  tabName?: string
  terminal?: { terminalId: string }
  /**
   * Swap it instead for a chat pane following a conversation on another
   * machine (remote-sessions-ux / new-chat-on-a-remote-machine). Like
   * `terminal`, no local agent record is created — the conversation lives on
   * the remote machine; this workspace is the pane onto it.
   */
  meshConversation?: {
    connectionId: string
    machineName: string
    remoteWorkspaceId: string
    remoteAgentId: string
    title: string
  }
}

// Transform the single-agent solo-chat layout for a seed: rename the lone agent
// tab, or swap it for a terminal tab. Pure — clones the template layout so the
// shared template constant is never mutated. Only the solo template (exactly one
// agent tab) is ever passed here.
export function applySoloChatSeed(layout: IJsonModel, seed: SoloChatSeed): IJsonModel {
  const next = structuredClone(layout)
  let done = false
  const visit = (node: LayoutAgentTabNode | undefined) => {
    if (!node || done) return
    if (node.component === 'agent') {
      const target = node as { component?: unknown; id?: unknown; name?: unknown; config?: Record<string, unknown> }
      if (seed.meshConversation) {
        const remote = seed.meshConversation
        target.component = MESH_CONVERSATION_COMPONENT
        target.id = `mesh-conversation:${remote.connectionId}:${encodeURIComponent(remote.remoteWorkspaceId)}:${encodeURIComponent(remote.remoteAgentId)}`
        target.name = seed.tabName ?? remote.title
        target.config = {
          connectionId: remote.connectionId,
          machineName: remote.machineName,
          remoteWorkspaceId: remote.remoteWorkspaceId,
          remoteAgentId: remote.remoteAgentId,
          remoteSessionId: meshConversationSessionId(remote.remoteWorkspaceId, remote.remoteAgentId),
          title: remote.title,
        }
        done = true
        return
      }
      if (seed.terminal) {
        target.component = 'terminal'
        target.name = seed.tabName ?? 'Terminal'
        target.config = { terminalId: seed.terminal.terminalId }
        done = true
        return
      }
      if (seed.tabName) {
        target.name = seed.tabName
        done = true
        return
      }
    }
    node.children?.forEach(visit)
  }
  visit(next.layout as LayoutAgentTabNode)
  next.borders?.forEach((border) => visit(border as LayoutAgentTabNode))
  return next
}

function collectTemplateAgentTabs(layout: IJsonModel): Array<{ id: AgentId; name?: string }> {
  const seen = new Set<string>()
  const agents: Array<{ id: AgentId; name?: string }> = []

  const collect = (node: LayoutAgentTabNode | undefined) => {
    if (!node) return

    if (node.component === 'agent' && typeof node.config?.agentId === 'string' && node.config.agentId.trim()) {
      const id = node.config.agentId.trim()
      if (!seen.has(id)) {
        seen.add(id)
        agents.push({
          id,
          name: typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined,
        })
      }
    }

    node.children?.forEach(collect)
  }

  collect(layout.layout as LayoutAgentTabNode)
  layout.borders?.forEach((border) => collect(border as LayoutAgentTabNode))

  return agents
}

export function createWorkspacesSlice(
  set: WorkspacesSliceSet,
  deps: WorkspacesSliceDependencies,
  // The current state, for the actions that have to DECIDE before they
  // write: a `set` whose draft goes untouched still notifies every
  // subscriber through this store's middleware, the rest sweep runs on a
  // 30 s tick in every window, and a refused agent move tells its caller so.
  getState: () => WorkspacesSliceCarrier,
): WorkspacesSlice {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    workspaceWindows: [
      {
        id: PRIMARY_WORKSPACE_WINDOW_ID,
        kind: 'primary',
        workspaceIds: [],
        activeWorkspaceId: null,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: Date.now(),
        lastFocusedAt: Date.now(),
      },
    ],
    primaryWorkspaceWindowId: PRIMARY_WORKSPACE_WINDOW_ID,
    workspaceRegistryEmptyState: null,

    reorderWorkspaces: (orderedIds) =>
      set((state) => {
        const byId = new Map(state.workspaces.map((ws) => [ws.id, ws] as const))
        const next: Workspace[] = []
        for (const id of orderedIds) {
          const ws = byId.get(id)
          if (ws) {
            next.push(ws)
            byId.delete(id)
          }
        }
        for (const remaining of byId.values()) next.push(remaining)
        state.workspaces = next
        normalizeWindowAssignments(state)
      }),

    registerWorkspaceWindow: (windowId, kind) =>
      set((state) => {
        if (!windowId.trim()) return
        ensureWorkspaceWindow(state, windowId.trim(), kind)
        normalizeWindowAssignments(state)
      }),

    updateWorkspaceWindowPlacement: (windowId, placement) => {
      set((state) => {
        const windowState = ensureWorkspaceWindow(state, windowId)
        windowState.bounds = normalizeBounds(placement.bounds)
        windowState.isMaximized = placement.isMaximized === true
        windowState.displayId = typeof placement.displayId === 'number' ? placement.displayId : null
        windowState.lastFocusedAt = Date.now()
      })
      // Local state is the functional path; storage-event sync still mirrors it
      // to other windows as rollback. Also broadcast the placement through main.
      // Callers pass only their own window id, and these calls already arrive
      // pre-debounced by the 250 ms window placement debounce in
      // window-factory.ts/window-ipc.ts, so dispatch frequency stays bounded.
      // Fire-and-forget: an unseeded/rejecting main service is a logged no-op.
      void workspaceSyncClient.dispatchUpdatePlacement({
        windowId,
        bounds: placement.bounds ?? null,
        isMaximized: placement.isMaximized === true,
        displayId: typeof placement.displayId === 'number' ? placement.displayId : null,
      })
    },

    closeWorkspaceWindow: (windowId, fallbackWindowId) => {
      let resolvedFallbackWindowId: WorkspaceWindowId | null = null
      set((state) => {
        if (windowId === state.primaryWorkspaceWindowId) return
        const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
        if (!closing) return
        resolvedFallbackWindowId = fallbackWindowId ?? state.primaryWorkspaceWindowId
        const target = ensureWorkspaceWindow(
          state,
          resolvedFallbackWindowId,
          resolvedFallbackWindowId !== state.primaryWorkspaceWindowId ? 'detached' : 'primary',
        )
        for (const workspaceId of closing.workspaceIds) {
          if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
        }
        if (!target.activeWorkspaceId && target.workspaceIds.length > 0) {
          target.activeWorkspaceId =
            closing.activeWorkspaceId && target.workspaceIds.includes(closing.activeWorkspaceId)
              ? closing.activeWorkspaceId
              : (target.workspaceIds[0] ?? null)
        }
        state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
        normalizeWindowAssignments(state)
      })
      // Broadcast the detached-window close through main (functional path stays
      // local + storage-event rollback). Only dispatch when a close actually
      // happened: a non-existent or primary window short-circuits above.
      if (resolvedFallbackWindowId) {
        void workspaceSyncClient.dispatchCloseWorkspaceWindow(windowId, resolvedFallbackWindowId)
      }
    },

    moveWorkspaceToWindow: (workspaceId, targetWindowId, sourceWindowId) => {
      let moved = false
      set((state) => {
        if (!state.workspaces.find((workspace) => workspace.id === workspaceId)) return
        const target = ensureWorkspaceWindow(
          state,
          targetWindowId,
          targetWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
        )
        for (const windowState of state.workspaceWindows) {
          if (windowState.id === targetWindowId) continue
          windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspaceId)
          if (windowState.activeWorkspaceId === workspaceId) {
            windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
          }
        }
        if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
        target.activeWorkspaceId = workspaceId
        target.lastFocusedAt = Date.now()
        const currentWindowId = getCurrentWorkspaceWindowIdForSlice()
        if (targetWindowId === currentWindowId) {
          // The workspace landed in THIS renderer's own window — focus it
          // globally. This covers same-window moves and the failed move-out
          // rollback (createWorkspaceWindow failure) that restores the workspace
          // to the current window using the failed target id as sourceWindowId.
          state.activeWorkspaceId = workspaceId
        } else if (state.activeWorkspaceId === workspaceId || state.activeWorkspaceId == null) {
          // The workspace moved to another window. Keep this renderer's global
          // active on the window it displays (its own/source window's
          // deterministic fallback, already advanced off the moved workspace by
          // the loop) rather than a workspace that now lives elsewhere. Only
          // adjust when global active was the moved-away workspace or unset; a
          // still-present active workspace in this window stays.
          const anchorWindow =
            state.workspaceWindows.find((windowState) => windowState.id === currentWindowId) ??
            (sourceWindowId
              ? state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
              : undefined)
          state.activeWorkspaceId = anchorWindow?.activeWorkspaceId ?? null
        }
        normalizeWindowAssignments(state)
        moved = true
      })
      // A user move always focuses the moved workspace in its destination, so
      // dispatch makeActive: true. Broadcast through main (functional path stays
      // local + storage-event rollback). Skip when the workspace was unknown.
      if (moved) {
        void workspaceSyncClient.dispatchMoveWorkspaceToWindow(
          workspaceId,
          sourceWindowId ?? null,
          targetWindowId,
          true,
        )
      }
    },

    setActiveWorkspaceForWindow: (windowId, workspaceId) => {
      let changed = false
      set((state) => {
        const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
        if (!windowState?.workspaceIds.includes(workspaceId)) return
        changed = windowState.activeWorkspaceId !== workspaceId
        windowState.activeWorkspaceId = workspaceId
        windowState.lastFocusedAt = Date.now()
        state.activeWorkspaceId = workspaceId
        // Leaving a door-routed full-page surface for a workspace (epic 1704);
        // an open modal closes with it so the workspace lands unobscured.
        clearRoutedSurfaces(state)
      })
      // Local state is the functional path (storage-event sync still mirrors it
      // to other windows as rollback). When the active selection actually
      // changes, also dispatch it through main so the event bus can broadcast it
      // once the main service is authoritative. Re-focusing the already-active
      // workspace bumps lastFocusedAt locally but emits no cross-window event.
      // Fire-and-forget: dispatch failures are logged, never thrown.
      if (changed) void workspaceSyncClient.dispatchSetActiveWorkspace(windowId, workspaceId)
    },

    // Applies an accepted/broadcast active_changed event without re-dispatching,
    // so an imported event never re-emits a new command. Updates only the
    // targeted window's active workspace; global active selection is claimed
    // only when this renderer owns the targeted window.
    applyWorkspaceActiveChangedEvent: ({ windowId, workspaceId, createdAt, isCurrentWindow }) =>
      set((state) => {
        const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
        if (!windowState) return
        if (workspaceId !== null && !windowState.workspaceIds.includes(workspaceId)) return
        windowState.activeWorkspaceId = workspaceId
        if (Number.isFinite(createdAt)) windowState.lastFocusedAt = createdAt
        if (isCurrentWindow && workspaceId) state.activeWorkspaceId = workspaceId
      }),

    // Applies an accepted/broadcast moved_to_window event without re-dispatching.
    // Mirrors the move membership transfer but only claims the single global
    // active id when this renderer owns the destination window — a move targeting
    // another window updates routing without flipping this renderer's selection.
    applyWorkspaceMovedEvent: ({
      workspaceId,
      fromWindowId,
      toWindowId,
      makeActive,
      createdAt,
      isCurrentWindowTarget,
    }) =>
      set((state) => {
        if (!state.workspaces.find((workspace) => workspace.id === workspaceId)) return
        const target = ensureWorkspaceWindow(
          state,
          toWindowId,
          toWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
        )
        for (const windowState of state.workspaceWindows) {
          if (windowState.id === toWindowId) continue
          windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspaceId)
          if (windowState.activeWorkspaceId === workspaceId) {
            windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
          }
        }
        if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
        if (makeActive) {
          target.activeWorkspaceId = workspaceId
          if (Number.isFinite(createdAt)) target.lastFocusedAt = createdAt
          if (isCurrentWindowTarget) state.activeWorkspaceId = workspaceId
        } else if (!target.activeWorkspaceId) {
          target.activeWorkspaceId = target.workspaceIds[0] ?? null
        }
        if (fromWindowId && fromWindowId !== toWindowId) {
          const source = state.workspaceWindows.find((windowState) => windowState.id === fromWindowId)
          if (source && source.activeWorkspaceId === workspaceId) {
            source.activeWorkspaceId = source.workspaceIds[0] ?? null
          }
        }
        normalizeWindowAssignments(state)
      }),

    // Applies an accepted/broadcast closed event without re-dispatching. Routes
    // the moved workspaces to the fallback window and drops the closing window.
    // The event can reach a renderer that never held the closing window record
    // (routing drift) — `movedWorkspaceIds` carries the ids the service routed to
    // the fallback so the transfer still completes; the closing record's own
    // membership is only a fallback for an empty payload. Global active selection
    // is left untouched — closing a foreign window must not flip this renderer's
    // active workspace.
    applyWorkspaceClosedEvent: ({ windowId, fallbackWindowId, movedWorkspaceIds, createdAt }) =>
      set((state) => {
        if (windowId === state.primaryWorkspaceWindowId) return
        const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
        const routedWorkspaceIds = movedWorkspaceIds.length > 0 ? movedWorkspaceIds : (closing?.workspaceIds ?? [])
        if (!closing && routedWorkspaceIds.length === 0) return
        const fallback = ensureWorkspaceWindow(
          state,
          fallbackWindowId,
          fallbackWindowId !== state.primaryWorkspaceWindowId ? 'detached' : 'primary',
        )
        for (const id of routedWorkspaceIds) {
          if (!fallback.workspaceIds.includes(id)) fallback.workspaceIds.push(id)
        }
        if (!fallback.activeWorkspaceId && fallback.workspaceIds.length > 0) {
          fallback.activeWorkspaceId =
            closing?.activeWorkspaceId && fallback.workspaceIds.includes(closing.activeWorkspaceId)
              ? closing.activeWorkspaceId
              : (fallback.workspaceIds[0] ?? null)
        }
        if (Number.isFinite(createdAt)) fallback.lastFocusedAt = createdAt
        if (closing) {
          state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
        }
        normalizeWindowAssignments(state)
      }),

    // Applies an accepted/broadcast placement event without re-dispatching.
    // Touches only the target window's placement fields, never workspace objects
    // or window membership.
    applyWorkspacePlacementEvent: ({ windowId, bounds, isMaximized, displayId, createdAt }) =>
      set((state) => {
        const windowState = ensureWorkspaceWindow(state, windowId)
        windowState.bounds = normalizeBounds(bounds)
        windowState.isMaximized = isMaximized === true
        windowState.displayId = typeof displayId === 'number' ? displayId : null
        if (Number.isFinite(createdAt)) windowState.lastFocusedAt = createdAt
      }),

    // Applies an accepted/broadcast workspace.created event without re-dispatching.
    // Inserts the workspace at its project's head (deterministic by event
    // sequence) and assigns it to the target window at the head. A renderer that already
    // has the workspace (the source applying its own accepted event, or a
    // duplicate broadcast) keeps its local object and only re-confirms the
    // assignment, so application is idempotent. Only the renderer that owns the
    // target window claims the single global active id. A retired-mode record
    // (`RETIRED_WORKSPACE_MODES`) is ignored: main refuses to mint one, and an
    // older main's broadcast must not bring a dropped row back.
    applyWorkspaceCreatedEvent: ({ workspace, windowId, createdAt, isCurrentWindowTarget, activate }) =>
      set((state) => {
        if (isRetiredWorkspaceMode(workspace.mode)) return
        if (!state.workspaces.some((candidate) => candidate.id === workspace.id)) {
          // The event's `folderPath` is the workspace's own folder, which for a
          // worktree chat is the worktree; the block it belongs in is the
          // project it was cut from, which the workspace object itself carries.
          const insertFolderKey = workspaceFolderKey(workspaceProjectRoot(workspace))
          const blockStart = state.workspaces.findIndex(
            (candidate) => workspaceFolderKey(workspaceProjectRoot(candidate)) === insertFolderKey,
          )
          if (blockStart === -1) {
            state.workspaces.unshift(workspace)
          } else {
            state.workspaces.splice(blockStart, 0, workspace)
          }
        }
        for (const windowState of state.workspaceWindows) {
          windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspace.id)
        }
        const target = ensureWorkspaceWindow(state, windowId)
        target.workspaceIds = [workspace.id, ...target.workspaceIds]
        // A workspace created in the background (a scheduled run) joins the
        // list and leaves what the window shows alone, as main's reducer does.
        if (activate) {
          target.activeWorkspaceId = workspace.id
          if (Number.isFinite(createdAt)) target.lastFocusedAt = createdAt
          if (isCurrentWindowTarget) state.activeWorkspaceId = workspace.id
        }
        state.workspaceRegistryEmptyState = null
        normalizeWindowAssignments(state)
      }),

    setWorkspaceHighlight: (id, highlight) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const current: WorkspaceHighlight = ws.highlight ?? { starred: false, color: null }
        ws.highlight = {
          starred: highlight.starred ?? current.starred,
          color: highlight.color === undefined ? current.color : highlight.color,
        }
      }),

    clearWorkspaceHighlight: (id) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.highlight = undefined
      }),

    // A hand decision about rest (settled-chats, 2026-09-07). Settle parks the
    // row in its folder's Settled shelf and records the decision so the sweep
    // leaves it alone; Un-settle brings it back and HOLDS it back — without
    // the override the sweep would re-settle a three-day-idle row on its next
    // tick. Applied locally, then sent to main as the field patch every
    // user-edited registry field travels by.
    setWorkspaceSettled: (id, settled) => {
      let patch: WorkspaceFieldsPatch | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        patch = settled ? settleWorkspacePatch(ws, Date.now(), 'settled') : wakeWorkspacePatch('active')
        Object.assign(ws, patch)
      })
      // A hand gesture is this window's to report, whichever window routes the row.
      if (patch) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
    },

    // Not a hand gesture: the primary window's cleanup sweep stamps it when it
    // gives a settled chat's worktree back, and whichever window brings the
    // worktree back clears it. Either is the only window that knows, so it
    // reports whatever window routes the row.
    setWorkspaceWorktreeReclaimed: (id, reclaimedAt) => {
      let patch: WorkspaceFieldsPatch | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws?.worktree || (ws.worktree.reclaimedAt ?? null) === reclaimedAt) return
        const { reclaimedAt: _previous, ...rest } = ws.worktree
        const worktree = reclaimedAt === null ? rest : { ...rest, reclaimedAt }
        ws.worktree = worktree
        patch = { worktree }
      })
      if (patch) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
    },

    // A New chat on a worktree opens before its worktree exists, folderless;
    // the window that made the worktree gives it the folder, which only it
    // knows, so it reports whatever window routes the row.
    setWorkspaceChatFolder: (id, folderPath, worktree) => {
      const patch: WorkspaceFieldsPatch = { folderPath, worktree }
      let changed = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        ws.folderPath = folderPath
        ws.worktree = worktree
        changed = true
      })
      if (changed) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
    },

    // The row menu's Auto-settle switch. Settles and wakes nothing by itself:
    // the sweep reads it on its next tick.
    setWorkspaceAutoSettle: (id, enabled) => {
      const patch: WorkspaceFieldsPatch = { autoSettleEnabled: enabled ? true : null }
      let changed = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws || (ws.autoSettleEnabled === true) === enabled) return
        Object.assign(ws, patch)
        changed = true
      })
      if (changed) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
    },

    // Sleep by hand (snooze, 2026-09-10): the row leaves the active list for
    // its folder's Snoozed shelf until `wakeAt`, and `null` brings it back now.
    //
    // The RECORD only. Suspending the chat's terminals is the sidebar's half
    // (`snoozeWorkspaceById`), which is also the layer that kills them for
    // Settle — the store never talks to a pty.
    //
    // Nothing schedules the wake: the row simply stops reading as asleep once
    // the stamp is in the past. A hand gesture, so it reports from whichever
    // window made it, exactly as Settle does.
    setWorkspaceSnoozed: (id, wakeAt) => {
      let patch: WorkspaceFieldsPatch | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        // Waking a row that was never asleep is a no-op, not a write. The menu
        // only offers Wake on a sleeping row, but a write here would broadcast
        // a field patch — and wake every other window's copy of the row — to
        // say nothing.
        if (wakeAt === null && !hasSnooze(ws)) return
        patch = wakeAt === null ? wakeSnoozedWorkspacePatch() : snoozeWorkspacePatch(wakeAt)
        Object.assign(ws, patch)
      })
      if (patch) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
    },

    // The rest sweep (settled-chats, 2026-09-07), run by the sidebar on mount
    // and on its 30 s tick: a quiet row with Auto-settle on settles after three idle days, a
    // resting row that is working again wakes. The sidebar passes what only
    // it knows — `busyIds`, the rows whose agent is working, and `heldIds`,
    // the rows that want the person (blocked on a prompt, or wearing the
    // unseen finished mark) — because those verdicts are derived from live
    // sessions the store does not hold; every window's active workspace is
    // exempt here so the sweep can never settle what someone is looking at.
    // Every window runs it, but a window decides only for the rows it is
    // routed — `heldIds` carries this window's own unseen marks, so two
    // windows can disagree about a row, and a decision applied locally but
    // never reported would leave that window at odds with main until the
    // next snapshot reset it. The routed window decides, applies and
    // reports; the others learn from main's broadcast. The rule itself is
    // `decideWorkspaceSettlement`.
    reconcileWorkspaceSettlement: ({ now, busyIds, heldIds, pullRequestsByWorkspaceId }) => {
      // Decide against the current state and write only when a row moves,
      // so a tick on which nothing changes touches no subscriber.
      const current = getState()
      const activeIds = new Set<WorkspaceId | null>([
        current.activeWorkspaceId,
        ...current.workspaceWindows.map((windowState) => windowState.activeWorkspaceId),
      ])
      const patches: [WorkspaceId, WorkspaceFieldsPatch][] = []
      // Reported back so the caller can quiet what came to rest: a settled
      // chat holds no terminals (2026-09-07), and the sidebar is the layer
      // that kills ptys. Only rows that actually SETTLED — a wake is not a
      // reason to touch anything.
      const settledIds: WorkspaceId[] = []
      for (const ws of current.workspaces) {
        if (!thisWindowSpeaksFor(current, ws.id)) continue
        const decision = decideWorkspaceSettlement({
          workspace: ws,
          now,
          active: activeIds.has(ws.id),
          busy: busyIds.has(ws.id),
          held: heldIds.has(ws.id),
          context: {
            pullRequests: pullRequestsByWorkspaceId?.[ws.id],
            settleOnMerge: current.appSettings.settleOnPullRequestMerge,
          },
        })
        if (decision === 'none') continue
        const patch = decision === 'settle' ? settleWorkspacePatch(ws, now, null) : wakeWorkspacePatch(null)
        patches.push([ws.id, patch])
        if (decision === 'settle') settledIds.push(ws.id)
      }
      if (patches.length === 0) return settledIds
      set((state) => {
        for (const [id, patch] of patches) {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) Object.assign(ws, patch)
        }
      })
      for (const [id, patch] of patches) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
      return settledIds
    },

    // Monotonic: `lastTerminalActivityAt` only moves forward, and is fed from the
    // session's last input (a keystroke, or an automation driving the chat),
    // not terminal output — so reopening a workspace never advances it. See
    // deriveWorkspaceLastInputAt.
    //
    // Input wakes a resting workspace: it leaves the Settled shelf, and any
    // hand decision about its rest is spent with it (new activity resumes the
    // usual rules). Only input that ADVANCES the clock counts — the sessions
    // are re-listed on every window mount with the same stamps they had, and a
    // replay must not un-settle a row the person put to rest after typing.
    //
    // Main's copy of the clock is what a restart rebuilds the row from, so it
    // is refreshed here too, on a coarse cadence (the sweep needs days, not
    // seconds): the first report per window, then whenever the clock has
    // moved a minute past the last copy sent. A rest decision sends the clock
    // with it (`settleWorkspacePatch`), so main is never behind a decision.
    recordWorkspaceTerminalActivity: (id, lastInputAt) => {
      let patch: WorkspaceFieldsPatch | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const previous = ws.lastTerminalActivityAt
        if (typeof previous === 'number' && previous >= lastInputAt) return
        ws.lastTerminalActivityAt = lastInputAt
        const synced = activityClockSyncedAt.get(id)
        const syncClock = synced === undefined || lastInputAt - synced >= WORKSPACE_ACTIVITY_CLOCK_SYNC_MS
        const speaks = thisWindowSpeaksFor(state, id)
        if (isSettledWorkspace(ws) || ws.settledOverride != null) {
          Object.assign(ws, wakeWorkspacePatch(null))
          if (speaks) patch = { ...wakeWorkspacePatch(null), lastTerminalActivityAt: lastInputAt }
        } else if (syncClock && speaks) {
          patch = { lastTerminalActivityAt: lastInputAt }
        }
      })
      if (patch) {
        activityClockSyncedAt.set(id, lastInputAt)
        void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
      }
    },

    // Monotonic like the stamp above, fed from the hook-reported
    // `UserPromptSubmit` of any agent in the workspace (WorkspaceManager
    // mirrors it off the session snapshots) and, for a conversation-runtime
    // chat that has no pty to report one, from the chat pane's own send.
    //
    // This is what the sidebar orders by, so it goes to main on every advance
    // rather than on the coarse cadence the keystroke clock uses: messages are
    // rare, and a restart that rebuilt the row from a minute-old copy would
    // deal the list a different order than the one the person left.
    //
    // A message wakes a resting row exactly as a keystroke does — it is the
    // person returning, and it spends any hand decision about rest with them.
    // Only a message that ADVANCES the clock counts, for the reason the
    // keystroke path gives: a re-listed session replays the stamp it already
    // had, and that must not un-settle a row the person put to rest after
    // speaking.
    recordWorkspaceUserMessage: (id, at) => {
      let patch: WorkspaceFieldsPatch | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        if (typeof ws.lastUserMessageAt === 'number' && ws.lastUserMessageAt >= at) return
        ws.lastUserMessageAt = at
        const speaks = thisWindowSpeaksFor(state, id)
        if (isSettledWorkspace(ws) || ws.settledOverride != null) {
          // The wake lands locally whichever window saw the message; only the
          // window that speaks for the row tells main, exactly as the
          // keystroke path does.
          Object.assign(ws, wakeWorkspacePatch(null))
          if (speaks) patch = { ...wakeWorkspacePatch(null), lastUserMessageAt: at }
        } else if (speaks) {
          patch = { lastUserMessageAt: at }
        }
      })
      if (patch) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, patch)
    },

    // Monotonic like the stamp above, fed from the hook-reported turn end of any
    // agent in the workspace (WorkspaceManager mirrors it off the session
    // snapshots). An agent finishing is not the person returning, so it never
    // wakes a resting row — but it is activity for the rest sweep, so main's
    // copy is kept current; turn ends are rare enough to send every advance.
    recordWorkspaceTurnEnd: (id, at) => {
      let report = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        if (typeof ws.lastTurnEndedAt === 'number' && ws.lastTurnEndedAt >= at) return
        ws.lastTurnEndedAt = at
        report = thisWindowSpeaksFor(state, id)
      })
      if (report) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, { lastTurnEndedAt: at })
    },

    // A person has this chat on screen in this window (`lastVisitedAt`):
    // monotonic like the clocks above, and reported from the window showing
    // it, whichever window routes the row, as a hand gesture is. The phone and
    // a paired desktop read their "finished, unseen" mark from it, so reading
    // a chat here clears the mark there.
    recordWorkspaceVisit: (id, at) => {
      let report = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        if (typeof ws.lastVisitedAt === 'number' && ws.lastVisitedAt >= at) return
        ws.lastVisitedAt = at
        report = true
      })
      if (report) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, { lastVisitedAt: at })
    },

    speaksForWorkspace: (id) => thisWindowSpeaksFor(getState(), id),

    forgetFolder: (folderPath) =>
      set((state) => {
        if (!folderPath) return
        const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
        const key = normalize(folderPath)
        state.workspaces = state.workspaces.filter((ws) => {
          // Matched on the project the workspace files under, not its own
          // folder, so forgetting a project also takes its worktree chats with
          // it. The forget dialog counts the group's rows and promises to close
          // them; a surviving worktree row would re-found the header it just
          // said goodbye to.
          const projectRoot = workspaceProjectRoot(ws)
          if (!projectRoot) return true
          return normalize(projectRoot) !== key
        })
        if (state.activeWorkspaceId && !state.workspaces.find((w) => w.id === state.activeWorkspaceId)) {
          state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
        }
        normalizeWindowAssignments(state)
        // Recents are bare paths with no marker to read, so a worktree path that
        // predates the project rule is recognised by the container convention
        // alone. Without this the forgotten project comes straight back in New
        // chat's picker as a project named after the worktree slug.
        state.appSettings.recentWorkspaceFolders = state.appSettings.recentWorkspaceFolders.filter(
          (folder) => normalize(workspaceProjectRootOf({ folderPath: folder }) ?? folder) !== key,
        )
        if (state.workspaces.length === 0) {
          // forgetFolder is the second explicit removal path that can leave
          // workspaces=[]. Mirror removeWorkspace's intent record so the
          // empty-snapshot guard treats this as a valid intentional empty
          // rather than a dangerous wipe.
          state.workspaceRegistryEmptyState = {
            reason: 'user_removed_all',
            updatedAt: new Date().toISOString(),
          }
        }
      }),

    addWorkspace: (template, options) => {
      let id = nanoid()
      // Captured so creation is broadcast through main as a workspace.created
      // event. Local creation stays the functional path; storage-event sync is
      // the rollback. Fire-and-forget after the synchronous set().
      let createdEventPayload: {
        workspace: Workspace
        windowId: WorkspaceWindowId
        folderPath: string | null
        activate: boolean
      } | null = null
      // Started without being looked at (⌘⏎ from New chat): the window keeps
      // what it shows, and main is told so, or its echo would bring it front.
      const activate = options?.activate !== false
      // The agents that moved in from `moveLayoutAgentsFrom`, removed from that
      // workspace in main once the create that carries them has been sent.
      const movedInAgentIds: AgentId[] = []

      set((state) => {
        const folderPath = options?.folderPath ?? null
        const recordedHostId = hostIdToRecord(options?.hostId, folderPath)
        const fallbackName = `${template.name} ${state.workspaces.length + 1}`
        const explicitMode = options?.mode
        const targetWindowId =
          options?.windowId ??
          (state.activeWorkspaceId ? findWorkspaceWindow(state, state.activeWorkspaceId)?.id : null) ??
          state.primaryWorkspaceWindowId
        const workspaceName = options?.name?.trim() || fallbackName
        // Only a workspace on an app-minted name ("Chat 44", "Solo 3") is a
        // candidate for auto-titling. A wizard-typed name or a chained run's
        // name is already meaningful and is locked here so the first prompt
        // never overwrites it. A SHAPE test, deliberately: the New chat button
        // passes its own per-folder ordinal ("Chat 63") while `fallbackName`
        // numbers globally, so comparing the two strings locked every new chat
        // at birth and the first prompt never named anything.
        const titleLocked = !isDefaultWorkspaceName(workspaceName, template.name)
        // The template's agent ids (`agent-1`, `agent-2`) are placeholders every
        // workspace made from it would share; this one's agents take ids of
        // their own, and the layout's tabs follow them.
        const moveFrom = options?.moveLayoutAgentsFrom
          ? state.workspaces.find((candidate) => candidate.id === options.moveLayoutAgentsFrom)
          : undefined
        const templateLayout = options?.moveLayoutAgentsFrom
          ? template.layout
          : instantiateTemplateAgentIds(template.layout).layout
        const agents: Workspace['agents'] = {}
        if (options?.moveLayoutAgentsFrom) {
          // Each record moves within this one write, so no reader ever sees the
          // agent in both chats or in neither.
          for (const { id: agentId } of collectTemplateAgentTabs(templateLayout)) {
            const record = moveFrom?.agents[agentId]
            if (!moveFrom || !record) continue
            // A plain copy: the record also rides the create command, which must
            // not carry a draft that is revoked when this write ends.
            agents[agentId] = isDraft(record) ? current(record) : record
            delete moveFrom.agents[agentId]
            movedInAgentIds.push(agentId)
          }
        } else if (options?.seedAgent?.terminal || options?.seedAgent?.meshConversation) {
          // Terminal and remote seeds: the lone agent tab is swapped for a
          // terminal / remote-pane tab in the layout below, so no local agent
          // record is created for it — a remote chat's agent lives on the
          // other machine.
        } else {
          const templateAgentCli =
            typeof options?.templateAgentCli === 'string' && options.templateAgentCli.trim()
              ? options.templateAgentCli.trim()
              : state.appSettings.lastSelectedCli
          const agentPatch = options?.seedAgent?.agentPatch
          collectTemplateAgentTabs(templateLayout).forEach((agent, index) => {
            // A generic template tab label ("Agent", "Agent 2", "A1") is a slot
            // placeholder, never an identity — every agent gets a real picked
            // name (the layout tab renames itself to agent.name on render). A
            // distinctive name from a user-saved template survives.
            const templateName = agent.name && !isPlaceholderAgentName(agent.name) ? agent.name : undefined
            const base = {
              ...deps.defaultAgent(agent.id, templateName ?? deps.pickWorkspaceAgentName(agents)),
              cli: templateAgentCli,
            }
            // The solo-chat template has a single agent tab; merge the seed patch
            // onto it so an Open-in-new-chat agent (a conversation agent, an
            // agent with a skill attached) is initialized at creation time,
            // race-free before first render.
            agents[agent.id] = index === 0 && agentPatch ? { ...base, ...agentPatch } : base
          })
        }
        // Standard/dev templates: normalize nav-only tabsets to strip-less so a
        // user-saved template predating the nav-switch model never seeds a
        // redundant tab strip on Files / Git / Knowledge Graph. When a seed
        // renames the lone tab or swaps it for a terminal, apply that transform.
        const baseStandardLayout = deps.hideNavRailTabStrip(templateLayout) ?? templateLayout
        const standardLayout =
          options?.seedAgent &&
          (options.seedAgent.tabName || options.seedAgent.terminal || options.seedAgent.meshConversation)
            ? applySoloChatSeed(baseStandardLayout, options.seedAgent)
            : baseStandardLayout
        const newWorkspace: Workspace = {
          id,
          name: workspaceName,
          ...(titleLocked ? { titleLocked: true } : {}),
          // Module-contributed workspace types: the explicit mode from
          // buildModuleTypeCreation IS the identity every mode-derived surface
          // (panel scopes, run glyphs, the not-installed state, creation
          // re-resolution) keys on — dropping it to 'standard' silently strips
          // all of them.
          mode: explicitMode ?? 'standard',
          folderPath,
          folderMissing: false,
          ...(options?.remoteOrigin ? { remoteOrigin: options.remoteOrigin } : {}),
          // Only a machine its folder would not imply is written: an absent
          // hostId already means this machine (or, for a folder inside a
          // distribution, that distribution), so every workspace on macOS and
          // Linux stays exactly the record it always was.
          ...(recordedHostId ? { hostId: recordedHostId } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(options?.worktree ? { worktree: options.worktree } : {}),
          templateId: template.id,
          layoutModel: standardLayout,
          agents,
          worktreeState: deps.defaultWorkspaceWorktreeState(),
          memory: deps.defaultWorkspaceMemoryConfig(),
          editorState: deps.defaultEditorState(),
          fileExplorerState: defaultWorkspaceFileExplorerState(),
          createdAt: Date.now(),
        }
        // New workspaces appear at the top of their folder's block (newest
        // first), matching the recency-ordered sidebar. A brand-new folder
        // lands at the head of the registry so its group renders first. Manual
        // drag-reorder still rewrites this order afterward.
        //
        // The block is the workspace's PROJECT, so a worktree chat lands at the
        // head of the project it was cut from rather than at the head of the
        // whole registry, which would yank that project's group to the top.
        const insertFolderKey = workspaceFolderKey(workspaceProjectRoot(newWorkspace))
        const blockStart = state.workspaces.findIndex(
          (existing) => workspaceFolderKey(workspaceProjectRoot(existing)) === insertFolderKey,
        )
        if (blockStart === -1) {
          state.workspaces.unshift(newWorkspace)
        } else {
          state.workspaces.splice(blockStart, 0, newWorkspace)
        }
        // Recents feed New chat's project picker, so a worktree chat contributes
        // the PROJECT it was cut from — its own folder would show up there as a
        // project named after the worktree slug. A chat started without a
        // project adds nothing: "No project" is a row of the picker's own.
        const recentFolder = workspaceProjectRoot(newWorkspace) ?? folderPath
        if (recentFolder && !isProjectlessChatsRoot(recentFolder)) {
          state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
            [recentFolder],
            state.appSettings.recentWorkspaceFolders,
          )
        }
        if (activate) {
          state.activeWorkspaceId = id
          if (!options?.background) clearRoutedSurfaces(state)
        }
        const targetWindow = ensureWorkspaceWindow(state, targetWindowId)
        targetWindow.workspaceIds = [id, ...targetWindow.workspaceIds.filter((workspaceId) => workspaceId !== id)]
        // Not activated, a window that had nothing to show still comes to
        // show it (normalizeWindowAssignments): a window never has workspaces
        // and none active.
        if (activate) targetWindow.activeWorkspaceId = id
        normalizeWindowAssignments(state)
        state.workspaceRegistryEmptyState = null
        createdEventPayload = { workspace: newWorkspace, windowId: targetWindowId, folderPath, activate }
      })

      if (createdEventPayload) {
        const { workspace, windowId, folderPath, activate: activated } = createdEventPayload
        void workspaceSyncClient.dispatchCreateWorkspace(
          workspace,
          windowId,
          folderPath,
          activated ? {} : { activate: false },
        )
        // Sent after the create, so main holds the agent in one chat or the
        // other throughout, never in neither.
        for (const agentId of movedInAgentIds) {
          void workspaceSyncClient.dispatchUpdateWorkspaceAgent(options!.moveLayoutAgentsFrom!, agentId, null)
        }
      }
      return id
    },

    // Main tombstones the id as it removes the record, so a lagging window's
    // optimistic edit against this workspace is rejected rather than
    // resurrecting it.
    removeWorkspace: (id) => {
      void workspaceSyncClient.dispatchRemoveWorkspace(id)
      set((state) => {
        const idx = state.workspaces.findIndex((w) => w.id === id)
        if (idx === -1) return
        state.workspaces.splice(idx, 1)
        if (state.activeWorkspaceId === id) {
          state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
        }
        normalizeWindowAssignments(state)
        if (state.workspaces.length === 0) {
          // Explicit registry empty-state record: the one thing that tells main
          // an empty registry is intent rather than a fault, so hydration seeds
          // empty instead of refusing. addWorkspace + importWorkspace clear it.
          state.workspaceRegistryEmptyState = {
            reason: 'user_removed_all',
            updatedAt: new Date().toISOString(),
          }
        }
      })
    },

    // Applied optimistically, then asked of main. Main decides with
    // per-field last-write-wins on the name stamp: the later gesture wins
    // whatever order the two commands arrive in, and the window that loses
    // converges on main's broadcast. The lock travels with the name — without
    // it the winning rename would still be auto-titled over.
    renameWorkspace: (id, name) => {
      let accepted: string | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        ws.name = name.trim() || ws.name
        // A hand-typed name is final: auto-titling must never overwrite it, and
        // the lock is set even when the rename was a no-op (the user retyping
        // the same name is still them settling on it).
        ws.titleLocked = true
        accepted = ws.name
      })
      if (accepted) void workspaceSyncClient.dispatchRenameWorkspace(id, accepted, true)
    },

    // Name a still-default workspace after the first real prompt sent inside it.
    // A no-op once the name is locked — by an earlier auto-title, a manual
    // rename, or an explicit name at creation — which is what stops the title
    // moving when a second prompt or a second terminal arrives.
    //
    // Takes the raw prompt rather than a finished title so the derivation stays
    // in one place and a rejected prompt (an app-injected skill drop, filler)
    // leaves the workspace unlocked for the next one.
    autoTitleWorkspaceFromPrompt: (id, prompt) => {
      let accepted: string | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws || ws.titleLocked) return
        const title = deriveWorkspaceTitle(prompt)
        if (!title) return
        ws.name = title
        ws.titleLocked = true
        accepted = title
      })
      if (accepted) void workspaceSyncClient.dispatchRenameWorkspace(id, accepted, true)
      return accepted
    },

    applyGeneratedWorkspaceTitle: (id, rawTitle, replacing) => {
      // The service guards its answer, but this is a public action, and the
      // two beside it (rename, auto-title) each refuse an empty name themselves.
      const title = rawTitle.trim()
      if (!title) return false
      let landed = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        // `titleLocked` is the one gate every other path uses for "still the
        // app's name"; a hand rename and an explicit name at birth both set it.
        const stillOurs = replacing !== null ? ws.name === replacing : !ws.titleLocked
        if (!stillOurs || ws.name === title) return
        ws.name = title
        ws.titleLocked = true
        landed = true
      })
      if (landed) void workspaceSyncClient.dispatchRenameWorkspace(id, title, true)
      return landed
    },

    setActiveWorkspace: (id) => {
      // Opening a chat spends its snooze (snooze, 2026-09-10) — both a running
      // one, because you are here now and "not now" is over, and a spent one,
      // because the Woke mark exists to get you to this exact click and has
      // nothing left to say once you have made it.
      let snoozePatch: WorkspaceFieldsPatch | null = null
      // The opening, said before the chat is drawn so its view mounts at the
      // "New" divider (`unreadDivider.ts`), with the visit clock as it stands
      // before this opening is stamped. A chat followed from another machine
      // keeps its clock there, and has no divider here.
      const opened = getState().workspaces.find((w) => w.id === id)
      if (opened && !opened.remoteOrigin)
        noteChatOpened(id, typeof opened.lastVisitedAt === 'number' ? opened.lastVisitedAt : null, Date.now())
      set((state) => {
        state.activeWorkspaceId = id
        // Leaving a door-routed full-page surface for a workspace (epic 1704);
        // an open modal closes with it so the workspace lands unobscured.
        clearRoutedSurfaces(state)
        const windowState = findWorkspaceWindow(state, id)
        const seenAt = Date.now()
        if (windowState) {
          windowState.activeWorkspaceId = id
          windowState.lastFocusedAt = seenAt
        }
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws && hasSnooze(ws)) {
          snoozePatch = wakeSnoozedWorkspacePatch()
          Object.assign(ws, snoozePatch)
        }
      })
      // Selecting is a hand gesture, reported by the window that made it — the
      // rule `setWorkspaceSettled` follows, for the same reason.
      if (snoozePatch) void workspaceSyncClient.dispatchUpdateWorkspaceFields(id, snoozePatch)
    },

    setFolderPath: (id, folderPath) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) {
          const folderChanged = ws.folderPath !== folderPath
          ws.folderPath = folderPath
          ws.folderMissing = false
          if (folderChanged) {
            // The new folder invalidates folder/repo-scoped view state: the file
            // selection, the Backlog item (keyed by folder-relative path), and the
            // Git scope/commit drafts all belong to the previous folder.
            ws.fileExplorerState = defaultWorkspaceFileExplorerState()
            ws.backlogState = undefined
            ws.gitPanelState = undefined
          }
          if (folderPath) {
            state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
              [folderPath],
              state.appSettings.recentWorkspaceFolders,
            )
          }
        }
      }),

    setFolderMissing: (id, folderMissing) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.folderMissing = folderMissing
      }),

    setFileExplorerExpandedPaths: (id, expandedPaths) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        // Preserve the persisted selection; only the expanded set is changing here.
        ws.fileExplorerState = normalizeWorkspaceFileExplorerState({
          expandedPaths,
          selectedPath: ws.fileExplorerState?.selectedPath ?? null,
          folderRoles: ws.fileExplorerState?.folderRoles,
        })
      }),

    setFileExplorerFolderRole: (id, folderPath, role) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const folderRoles = { ...ws.fileExplorerState?.folderRoles }
        // A null role CLEARS the mark rather than storing "none": the absence
        // of an entry is what lets a folder inherit from an ancestor again.
        if (role) folderRoles[folderPath] = role
        else delete folderRoles[folderPath]
        ws.fileExplorerState = normalizeWorkspaceFileExplorerState({
          expandedPaths: ws.fileExplorerState?.expandedPaths ?? [],
          selectedPath: ws.fileExplorerState?.selectedPath ?? null,
          folderRoles,
        })
      }),

    setFileExplorerSelectedPath: (id, selectedPath) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        ws.fileExplorerState = normalizeWorkspaceFileExplorerState({
          expandedPaths: ws.fileExplorerState?.expandedPaths ?? [],
          selectedPath,
          folderRoles: ws.fileExplorerState?.folderRoles,
        })
      }),

    setBacklogViewState: (id, patch) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const current = ws.backlogState ?? defaultWorkspaceBacklogState()
        ws.backlogState = normalizeWorkspaceBacklogState({ ...current, ...patch })
      }),

    setGitPanelState: (id, patch) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const current = ws.gitPanelState ?? defaultWorkspaceGitPanelState()
        ws.gitPanelState = normalizeWorkspaceGitPanelState({ ...current, ...patch })
      }),

    setLastActiveAgent: (id, agentId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const next = typeof agentId === 'string' && agentId.trim().length > 0 ? agentId.trim() : null
        // The guard is the point: selection fires on mount, on every layout
        // change and on every programmatic focus, and an unconditional write
        // would mark the registry dirty on each one.
        if ((ws.lastActiveAgentId ?? null) === next) return
        ws.lastActiveAgentId = next
      }),

    setGitCommitDraft: (id, scopeId, text) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws || scopeId.length === 0) return
        const current = ws.gitPanelState ?? defaultWorkspaceGitPanelState()
        const commitDraftsByScopeId = { ...current.commitDraftsByScopeId }
        if (text.trim().length > 0) commitDraftsByScopeId[scopeId] = text
        else delete commitDraftsByScopeId[scopeId]
        ws.gitPanelState = normalizeWorkspaceGitPanelState({ ...current, commitDraftsByScopeId })
      }),

    clearGitCommitDraft: (id, scopeId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws?.gitPanelState) return
        if (!(scopeId in ws.gitPanelState.commitDraftsByScopeId)) return
        const commitDraftsByScopeId = { ...ws.gitPanelState.commitDraftsByScopeId }
        delete commitDraftsByScopeId[scopeId]
        ws.gitPanelState = { ...ws.gitPanelState, commitDraftsByScopeId }
      }),

    setWorkspaceModuleState: (workspaceId, moduleId, moduleStateValue) => {
      let updated = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (moduleStateValue === undefined || moduleStateValue === null) {
          if (ws.moduleState && moduleId in ws.moduleState) {
            delete ws.moduleState[moduleId]
            if (Object.keys(ws.moduleState).length === 0) delete ws.moduleState
          }
        } else {
          ;(ws.moduleState ??= {})[moduleId] = moduleStateValue
        }
        updated = true
      })
      return updated
    },

    importWorkspace: (ws) =>
      set((state) => {
        const id = nanoid()
        const agents = Object.fromEntries(
          Object.entries(ws.agents).map(([k, v]) => [
            k,
            deps.normalizeAgentState({
              ...v,
              streamBuffer: '',
              status: 'idle' as const,
              cliStartupPrompt: undefined,
            }),
          ]),
        )
        state.workspaces.push({
          ...ws,
          id,
          name: `${ws.name} (imported)`,
          mode: normalizeWorkspaceMode(ws.mode),
          folderPath: ws.folderPath ?? null,
          folderMissing: false,
          agents,
          worktreeState: deps.normalizeWorkspaceWorktreeState(ws.worktreeState),
          editorState: ws.editorState ?? deps.defaultEditorState(),
          fileExplorerState: normalizeWorkspaceFileExplorerState(ws.fileExplorerState),
          backlogState: normalizeWorkspaceBacklogState(ws.backlogState),
          gitPanelState: normalizeWorkspaceGitPanelState(ws.gitPanelState),
        })
        state.activeWorkspaceId = id
        const targetWindow = ensureWorkspaceWindow(state, state.primaryWorkspaceWindowId)
        targetWindow.workspaceIds.push(id)
        targetWindow.activeWorkspaceId = id
        normalizeWindowAssignments(state)
        state.workspaceRegistryEmptyState = null
      }),

    moveAgentToWorkspace: (sourceWorkspaceId, destWorkspaceId, agentId) => {
      if (sourceWorkspaceId === destWorkspaceId) return false
      // Decided before the write. An agent of the same id already in the
      // destination is a different agent (template-built chats all began with
      // an `agent-1`), and writing over it would lose its record while its
      // transcript and process live on with nothing pointing at them. Renaming
      // the arriving agent is no safer: its running process, transcript and
      // checkpoints are all filed under the id it has. So the move is refused
      // and both agents stay as they are.
      const workspaces = getState().workspaces
      const source = workspaces.find((w) => w.id === sourceWorkspaceId)
      const dest = workspaces.find((w) => w.id === destWorkspaceId)
      if (!source?.agents[agentId] || !dest || dest.agents[agentId]) return false
      let moved: AgentState | undefined
      set((state) => {
        const sourceDraft = state.workspaces.find((w) => w.id === sourceWorkspaceId)
        const destDraft = state.workspaces.find((w) => w.id === destWorkspaceId)
        const agent = sourceDraft?.agents[agentId]
        if (!sourceDraft || !destDraft || !agent || destDraft.agents[agentId]) return
        destDraft.agents[agentId] = agent
        delete sourceDraft.agents[agentId]
        moved = { ...(isDraft(agent) ? current(agent) : agent) }
      })
      if (!moved) return false
      // Main owns the registry: without these the move lived only in this
      // window, and main, every other window and the next start all kept the
      // agent in the chat it left. The whole record goes to the destination
      // first, as a new agent's seed does, and only then leaves the source, so
      // main never holds the agent in neither chat.
      void workspaceSyncClient.dispatchUpdateWorkspaceAgent(destWorkspaceId, agentId, moved)
      void workspaceSyncClient.dispatchUpdateWorkspaceAgent(sourceWorkspaceId, agentId, null)
      return true
    },

    removeAgent: (workspaceId, agentId) => {
      set((state) => {
        const workspace = state.workspaces.find((w) => w.id === workspaceId)
        if (!workspace?.agents[agentId]) return
        delete workspace.agents[agentId]
        // The agent's worktree is released with it: no longer `assigned`, so
        // the agent worktree cleanup may reclaim it once it is clean and its
        // work is merged (the cleanup decides that, never this). Left assigned,
        // it would be protected for ever by an owner that no longer exists.
        releaseWorktreeEntriesOwnedBy(workspace, agentId)
      })
      void workspaceSyncClient.dispatchUpdateWorkspaceAgent(workspaceId, agentId, null)
    },

    moveOpenFileToWorkspace: (sourceWorkspaceId, destWorkspaceId, path) => {
      if (sourceWorkspaceId === destWorkspaceId) return
      moveEditorBuffer(sourceWorkspaceId, destWorkspaceId, path)
      set((state) => {
        const source = state.workspaces.find((w) => w.id === sourceWorkspaceId)
        const dest = state.workspaces.find((w) => w.id === destWorkspaceId)
        if (!source || !dest) return
        const sourceEditor = source.editorState
        if (!sourceEditor) return
        const idx = sourceEditor.openFiles.findIndex((file) => file.path === path)
        if (idx === -1) return
        const [openFile] = sourceEditor.openFiles.splice(idx, 1)
        if (sourceEditor.activeFilePath === path) {
          sourceEditor.activeFilePath = sourceEditor.openFiles.at(-1)?.path ?? null
        }
        if (!dest.editorState) dest.editorState = deps.defaultEditorState()
        const destEditor = dest.editorState
        const existing = destEditor.openFiles.findIndex((file) => file.path === path)
        if (existing !== -1) {
          destEditor.openFiles[existing] = openFile
        } else {
          destEditor.openFiles.push(openFile)
        }
        destEditor.activeFilePath = path
      })
    },
  }
}
