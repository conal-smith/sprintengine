import type {
  AgentCli,
  AppSettings,
  Workspace,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
} from '../../types/workspace'
import { defaultEditorState, normalizeAgentCli, normalizeAgentState } from './agentsSlice'
import { hideNavRailTabStrip, healRetiredRailLayout, stripSettingsTabsFromLayout } from './layoutSlice'
import { normalizeWorkspaceMemoryConfig } from './memorySlice'
import {
  defaultAppSettings,
  normalizeAppSettings,
  normalizeCliPermissionPreset,
  normalizeRecentWorkspaceFolders,
} from './settingsSlice'
import { normalizeWorkspaceFileExplorerState, normalizeWorkspaceMode } from './workspacesSlice'
import { normalizeWorkspaceWorktreeState } from './worktreesSlice'
import { dropRetiredModeWorkspaces, mapMigrationWorkspaces } from './normalizers'

export const WORKSPACE_STORAGE_KEY = 'sprintengine-workspaces'
export const APP_SETTINGS_STORAGE_KEY = 'sprintengine-app-settings'
export const WORKSPACE_STORE_VERSION = 78
export const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
const LEGACY_WORKSPACE_STORAGE_KEY = ['free', 'ai', 'ide', 'workspaces'].join('-')

export type WorkspaceMigrationState = {
  workspaces: Workspace[]
  activeWorkspaceId?: WorkspaceId | null
  workspaceWindows?: WorkspaceWindowState[]
  primaryWorkspaceWindowId?: WorkspaceWindowId
  // Retired keys stay declared here so the migrations that read or delete them
  // are typed rather than cast: `cliCommands` holds the pre-v10 CLI commands.
  appSettings?: Partial<AppSettings> & {
    cliCommands?: Partial<Record<AgentCli, string>>
  }
  sidebarCollapsed?: boolean
  openFilesInExternalWindow?: boolean
  workspaceRegistryEmptyState?: import('../../types/workspace').WorkspaceRegistryEmptyState | null
}

export function normalizeWorkspaceWindows(
  workspaces: Workspace[],
  windows: WorkspaceWindowState[] | null | undefined,
  primaryWorkspaceWindowId: WorkspaceWindowId | null | undefined,
  fallbackActiveWorkspaceId?: WorkspaceId | null,
): { windows: WorkspaceWindowState[]; primaryWorkspaceWindowId: WorkspaceWindowId } {
  const now = Date.now()
  const workspaceIds = workspaces.map((workspace) => workspace.id)
  const validWorkspaceIds = new Set(workspaceIds)
  const primaryId = primaryWorkspaceWindowId?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  const seenWindowIds = new Set<WorkspaceWindowId>()
  const assignedWorkspaceIds = new Set<WorkspaceId>()
  const nextWindows: WorkspaceWindowState[] = []

  const sourceWindows =
    Array.isArray(windows) && windows.length > 0
      ? windows
      : [
          {
            id: primaryId,
            kind: 'primary' as const,
            workspaceIds,
            activeWorkspaceId: fallbackActiveWorkspaceId ?? workspaceIds[0] ?? null,
            bounds: null,
            isMaximized: false,
            displayId: null,
            createdAt: now,
            lastFocusedAt: now,
          },
        ]

  for (const source of sourceWindows) {
    if (!source || typeof source.id !== 'string' || !source.id.trim()) continue
    const id = source.id.trim()
    if (seenWindowIds.has(id)) continue
    seenWindowIds.add(id)

    const memberIds: WorkspaceId[] = []
    for (const workspaceId of Array.isArray(source.workspaceIds) ? source.workspaceIds : []) {
      if (!validWorkspaceIds.has(workspaceId) || assignedWorkspaceIds.has(workspaceId)) continue
      memberIds.push(workspaceId)
      assignedWorkspaceIds.add(workspaceId)
    }

    nextWindows.push({
      id,
      kind: id === primaryId ? 'primary' : source.kind === 'primary' ? 'detached' : 'detached',
      workspaceIds: memberIds,
      activeWorkspaceId:
        source.activeWorkspaceId && memberIds.includes(source.activeWorkspaceId)
          ? source.activeWorkspaceId
          : (memberIds[0] ?? null),
      bounds: normalizeWorkspaceWindowBounds(source.bounds),
      isMaximized: source.isMaximized === true,
      displayId: typeof source.displayId === 'number' ? source.displayId : null,
      createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
      lastFocusedAt: typeof source.lastFocusedAt === 'number' ? source.lastFocusedAt : now,
    })
  }

  let primaryWindow = nextWindows.find((windowState) => windowState.id === primaryId)
  if (!primaryWindow) {
    primaryWindow = {
      id: primaryId,
      kind: 'primary',
      workspaceIds: [],
      activeWorkspaceId: null,
      bounds: null,
      isMaximized: false,
      displayId: null,
      createdAt: now,
      lastFocusedAt: now,
    }
    nextWindows.unshift(primaryWindow)
  } else {
    primaryWindow.kind = 'primary'
  }

  for (const workspaceId of workspaceIds) {
    if (assignedWorkspaceIds.has(workspaceId)) continue
    primaryWindow.workspaceIds.push(workspaceId)
    assignedWorkspaceIds.add(workspaceId)
  }

  primaryWindow.activeWorkspaceId =
    primaryWindow.activeWorkspaceId && primaryWindow.workspaceIds.includes(primaryWindow.activeWorkspaceId)
      ? primaryWindow.activeWorkspaceId
      : fallbackActiveWorkspaceId && primaryWindow.workspaceIds.includes(fallbackActiveWorkspaceId)
        ? fallbackActiveWorkspaceId
        : (primaryWindow.workspaceIds[0] ?? null)

  return {
    windows: nextWindows.filter((windowState) => windowState.kind === 'primary' || windowState.workspaceIds.length > 0),
    primaryWorkspaceWindowId: primaryId,
  }
}

function normalizeWorkspaceWindowBounds(
  bounds: WorkspaceWindowState['bounds'] | null | undefined,
): WorkspaceWindowState['bounds'] {
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

export function migrateLegacyWorkspaceStorageKey(): void {
  try {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem(WORKSPACE_STORAGE_KEY)) return

    const legacyState = window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY)
    if (legacyState) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyState)
  } catch {
    // Persist will fall back to a fresh store if localStorage is unavailable.
  }
}

export function readPersistedWorkspaceState(): Partial<WorkspaceMigrationState> | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: Partial<WorkspaceMigrationState> }
    return parsed.state && typeof parsed.state === 'object' ? parsed.state : null
  } catch {
    return null
  }
}

export function nonEmptyPersistedWorkspaceState(): Partial<WorkspaceMigrationState> | null {
  const persisted = readPersistedWorkspaceState()
  return Array.isArray(persisted?.workspaces) && persisted.workspaces.length > 0 ? persisted : null
}

// The persisted-state classifier moved to `src/shared/workspace-registry.ts`
// so main's registry hydration and this window's wipe guard share one
// implementation instead of two that can drift — main refuses to seed on
// exactly the classifications the guard refuses to overwrite on. Re-exported
// here because the renderer's import sites (and the store's public surface)
// name it from this module.
export { classifyPersistedWorkspaceState, isDangerousEmptyClassification } from '../../../../shared/workspace-registry'
import type { PersistedStateClassification } from '../../../../shared/workspace-registry'
export type { PersistedStateClassification }

// The T22 one-shot intent flag was removed in T23 — intent now lives in
// state.workspaceRegistryEmptyState (an explicit record set by removeWorkspace
// when the splice leaves workspaces=[], cleared by addWorkspace and
// importWorkspace, and persisted into the registry storage key). Partialize
// reads the field directly; no module-local flag coordination is needed.

export type HydrationStorageSource = 'localStorage' | 'backup' | 'fresh'

export type HydrationDiagnostic = {
  persistedWorkspaceCount: number
  hydratedWorkspaceCount: number
  activeWorkspaceId: string | null
  storageSource: HydrationStorageSource
  classification: PersistedStateClassification
  parseError?: string
  migrationError?: string
  recoveryError?: string
}

export function migratePersistedWorkspaceState(persisted: unknown, version: number): unknown {
  const state = persisted as Partial<WorkspaceMigrationState> | undefined
  if (!state) return state as never
  state.workspaces = state.workspaces ?? []
  const migrationState = state as WorkspaceMigrationState

  if (version < 1) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      folderPath: ws.folderPath ?? null,
      editorState: ws.editorState ?? defaultEditorState(),
    }))
  }
  if (version < 2) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      mode: ws.mode ?? 'standard',
    }))
  }
  // v3-v8 forwarded the in-tree sprint engine's run state, roster agents and
  // board layout. The engine was deleted outright (2026-09-16) and a persisted
  // `sprintengine` row is dropped by dropRetiredModeWorkspaces, so the rungs
  // are gone rather than kept as no-ops.
  if (version < 10) {
    const current = migrationState
    const defaults = defaultAppSettings()
    const existing = current.appSettings ?? {}
    current.appSettings = {
      cliRuntimes: {
        codex: {
          ...defaults.cliRuntimes.codex,
          ...existing.cliRuntimes?.codex,
          command:
            existing.cliRuntimes?.codex?.command ?? existing.cliCommands?.codex ?? defaults.cliRuntimes.codex.command,
        },
        'claude-code': {
          ...defaults.cliRuntimes['claude-code'],
          ...existing.cliRuntimes?.['claude-code'],
          command: existing.cliRuntimes?.['claude-code']?.command ?? defaults.cliRuntimes['claude-code'].command,
        },
      },
      lastSelectedCli: defaults.lastSelectedCli,
    }
  }
  if (version < 11) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
        'claude-code': {
          ...defaults.cliRuntimes['claude-code'],
          ...current.appSettings?.cliRuntimes?.['claude-code'],
        },
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
    }
  }
  if (version < 12) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
    }
  }
  if (version < 13) {
    // This rung used to re-key a remembered agent identity that no longer
    // exists, so it keeps only its shape-preserving half.
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
    }
  }
  if (version < 16) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      folderMissing: false,
    }))
  }
  if (version < 21) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      agents: Object.fromEntries(
        Object.entries(ws.agents ?? {}).map(([id, agent]) => [id, normalizeAgentState(agent)]),
      ),
      worktreeState: normalizeWorkspaceWorktreeState(ws.worktreeState),
    }))
  }
  if (version < 25) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      editorState: {
        openFiles: (ws.editorState?.openFiles ?? []).map(({ content: _content, ...file }) => ({
          ...file,
          isDirty: false,
        })),
        activeFilePath: ws.editorState?.activeFilePath ?? null,
      },
    }))
  }
  if (version < 26) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
    }
  }
  if (version < 27) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
        current.appSettings?.recentWorkspaceFolders,
        state.workspaces.map((ws) => ws.folderPath),
      ),
    }
  }
  if (version < 28) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
        current.appSettings?.recentWorkspaceFolders,
        state.workspaces.map((ws) => ws.folderPath),
      ),
    }
  }
  if (version < 31) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...current.appSettings,
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...current.appSettings?.cliRuntimes,
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastAgentSpawnPermissionPreset: normalizeCliPermissionPreset(current.appSettings?.lastAgentSpawnPermissionPreset),
      recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
        current.appSettings?.recentWorkspaceFolders,
        state.workspaces.map((ws) => ws.folderPath),
      ),
    }
  }
  if (version < 33) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 34) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 35) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      memory: normalizeWorkspaceMemoryConfig(ws.memory),
    }))
  }
  if (version < 36) {
    // Re-run memory normalization so the bumped GRAPH_SETTINGS_VERSION
    // upgrades layout numerics (link distance, node size, forces) on
    // workspaces that pre-date the tighter defaults.
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      memory: normalizeWorkspaceMemoryConfig(ws.memory),
    }))
  }
  if (version < 39) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 40) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      mode: normalizeWorkspaceMode(ws.mode),
    }))
  }
  if (version < 41) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 42) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 43) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      layoutModel: stripSettingsTabsFromLayout(ws.layoutModel) as Workspace['layoutModel'],
    }))
  }
  // v44 healed guided-brief workspaces (mode + runtime state + layout). The
  // Design Wizard was retired 2026-09-08, so the rung is gone: a persisted
  // 'guided-brief' row is now dropped outright by dropRetiredModeWorkspaces.
  if (version < 45) {
    // v45 splits non-workspace state into APP_SETTINGS_STORAGE_KEY and adds an
    // explicit workspaceRegistryEmptyState record to the registry envelope.
    // The on-disk split is handled by the workspaceStore custom storage
    // adapter on first read; here we only backfill the in-memory field so
    // existing rehydrate paths (merge, partialize) see it.
    if (migrationState.workspaceRegistryEmptyState === undefined) {
      migrationState.workspaceRegistryEmptyState = null
    }
  }
  if (version < 46) {
    const fallbackCli = normalizeAgentCli({ cli: migrationState.appSettings?.lastSelectedCli }, 'claude-code')
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      agents: Object.fromEntries(
        Object.entries(ws.agents ?? {}).map(([id, agent]) => [id, normalizeAgentState({ ...agent, id }, fallbackCli)]),
      ),
    }))
  }
  // v47 and v50 forwarded the layouts of a workspace mode that has since been
  // retired. `healRetiredRailLayout` now strips that mode's tabs on every
  // hydration, so the two rungs are dropped rather than kept as no-ops.
  // v48, v49 and v58 forwarded the in-tree sprint engine's board layout and
  // automation state. Retired with the engine (2026-09-16).
  if (version < 59) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      fileExplorerState: normalizeWorkspaceFileExplorerState(ws.fileExplorerState),
    }))
  }
  // v52 hid the FlexLayout tab strip around the 'guided-brief' tab. Retired
  // with the Design Wizard (2026-09-08); the tab component itself is stripped
  // from persisted layouts by stripRetiredModuleTabsFromLayout.
  if (version < 54) {
    // Files / Git / Knowledge Graph are now exclusive strip-less switches that
    // share one left pane; the sidebar PanelRail carries their selection chrome,
    // so the FlexLayout tab strip on a nav-only tabset is redundant. Stamp
    // enableTabStrip: false onto existing layouts' nav-only tabsets without
    // touching mixed tabsets (those self-heal on the next rail toggle).
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = hideNavRailTabStrip(ws.layoutModel)
      return next ? { ...ws, layoutModel: next } : ws
    })
  }
  if (version < 55) {
    const normalized = normalizeWorkspaceWindows(
      migrationState.workspaces,
      migrationState.workspaceWindows,
      migrationState.primaryWorkspaceWindowId,
      migrationState.activeWorkspaceId,
    )
    migrationState.workspaceWindows = normalized.windows
    migrationState.primaryWorkspaceWindowId = normalized.primaryWorkspaceWindowId
  }
  if (version < 56) {
    // v56 added the voice dictation settings and normalized so existing
    // installs picked up their defaults. Dictation retired 2026-10-09 (see
    // v78); the rung stays because it is a plain normalizer pass, and
    // normalizeAppSettings no longer builds that key.
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  // v57, v60 and v61 cleared the in-tree sprint engine's launch intent, nav
  // tab and per-run permission preferences. Retired with the engine
  // (2026-09-16).
  if (version < 62) {
    // Automations is now a global app screen (a content-area destination), not
    // a workspace type. Drop any persisted automations workspaces: their only
    // content was the locked control-center tab — every automation definition
    // and run history lives on disk under each project's
    // `.sprintengine/automations/` (now `legacy/automations/` in the project's
    // store), so nothing the user authored is lost. Window
    // membership and the active-workspace pointer are reconciled against the
    // surviving workspaces by normalizeWorkspaceWindows during merge.
    migrationState.workspaces = (migrationState.workspaces ?? []).filter((ws) => ws.mode !== 'automations')
    // Don't leave the active pointer dangling at a dropped automations workspace.
    // (Window-level active ids are reconciled by normalizeWorkspaceWindows; this
    // keeps the top-level pointer honest too.)
    if (
      migrationState.activeWorkspaceId &&
      !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  // v63 and v64 kept one Automations host per project folder. Retired with
  // Automations (2026-09-30): the host mode is dropped outright by
  // dropRetiredModeWorkspaces.
  if (version < 65) {
    // The `roadmap` workspace mode retired: Roadmap became an
    // instance-global sidebar surface, itself deleted on 2026-09-05. Drop any
    // persisted roadmap-mode workspace — its only content was the board lens,
    // and the roadmap plans themselves live on disk under the home project's
    // `backlog/roadmaps/`, so nothing the user authored is lost. Window
    // membership is reconciled by
    // normalizeWorkspaceWindows during merge; keep the top-level active pointer
    // honest too (mirrors the v62 automations-mode drop).
    migrationState.workspaces = dropRetiredModeWorkspaces(migrationState.workspaces ?? [])
    if (
      migrationState.activeWorkspaceId &&
      !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  if (version < 66) {
    // The `multiloop` workspace mode retired: the feature was removed outright.
    // Drop any persisted multiloop-mode workspace — any loop state on disk under
    // the project folder is untouched. Window membership is reconciled by
    // normalizeWorkspaceWindows during merge; keep the top-level active pointer
    // honest too (mirrors the v65 roadmap-mode drop above).
    migrationState.workspaces = dropRetiredModeWorkspaces(migrationState.workspaces ?? [])
    if (
      migrationState.activeWorkspaceId &&
      !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  if (version < 67) {
    // Re-run the app-settings normalizer over an upgrading profile. It was
    // added to reset a conversation-transport opt-in whose pre-flip default had
    // already been written to every profile; that setting retired with the
    // Design Wizard (2026-09-08) and normalizeAppSettings now simply drops the
    // stale key, along with every other retired one. The rung stays because
    // normalizeAppSettings owns the rule and this gives clean upgrades the same
    // result as the merge path.
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  // v68 dropped the in-tree sprint engine's model catalog from app settings.
  // normalizeAppSettings is the enforcement half and builds every field
  // explicitly, so an upgraded profile drops the key with or without the rung.
  if (version < 69) {
    // `cliModelCatalog` arrives with this version: what each agent CLI last
    // reported about its own models, separate from the user's own ids in
    // `cliRuntimes[cli].models`. Nothing on disk carries one yet, so this rung
    // is the clean-upgrade half only — it runs the normalizer once so an
    // upgraded profile is stamped with the shape the pickers merge. The
    // enforcement half is normalizeAppSettings itself: persist merge() runs it
    // on every hydration, so a hand-edited or dev-written catalog cannot ride
    // into the pickers inside a current-version envelope this ladder will never
    // revisit (same split as the v67/v68 rungs above).
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 70) {
    // Reasoning effort arrives with this version: `AgentCliModelSelection`
    // gains an optional per-CLI `reasoning` level, so a stored selection may
    // now legitimately carry an empty model (the CLI's default model at a
    // chosen effort). No profile on disk has one yet, so this rung is the
    // clean-upgrade half only. The enforcement half is normalizeAppSettings —
    // persist merge() runs it on every hydration, which is what keeps a
    // hand-edited or dev-written level (e.g. a blank one, or a selection with
    // neither model nor level) out of the pickers and out of launch argv
    // inside a current-version envelope this ladder will never revisit (same
    // split as the v67/v68/v69 rungs above).
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  // v71 and v72 hoisted the in-tree sprint engine's workspace fields into the
  // per-module state bag and dropped its remembered spawn default from app
  // settings. Both retired with the engine (2026-09-16); a `sprintengine` row
  // is dropped outright by dropRetiredModeWorkspaces, and normalizeAppSettings
  // builds every settings field explicitly.
  if (version < 73) {
    // Files and Git left the FlexLayout rail for the workspace pane, and the
    // Skills aside is gone (browser-pane epic). A layout that had Files or
    // Git docked comes back with the same surfaces open as pane tabs — the
    // person's panels move rather than close — and the retired tabs are
    // stripped so no layout renders an unavailable surface. A workspace that
    // already carries a pane record (a dev build ahead of the ladder) keeps it.
    // The same heal also runs in persist merge() and on every registry
    // snapshot main sends — this rung is the clean-upgrade half.
    mapMigrationWorkspaces(migrationState, healRetiredRailLayout)
  }
  if (version < 74) {
    // The workspace Backlog left the rail for the pane too. The same heal:
    // a layout still docking `backlog` adopts it into the (now always
    // present) pane record and the rail tab is stripped. Idempotent over the
    // v73 rung above, so a v72 profile passing both is migrated once.
    mapMigrationWorkspaces(migrationState, healRetiredRailLayout)
  }
  if (version < 75) {
    // The `reviews-host` workspace mode retired: Reviews became an installable
    // module whose guide spawns into the workspace the door was opened from, so
    // the per-project background host has no producer left. Drop any persisted
    // reviews-host row — its guide-terminal agent records go with it, and the
    // review data on disk (`.sprintengine/review/`) is untouched. Mirrors the v66
    // multiloop-mode drop above, active pointer included.
    migrationState.workspaces = dropRetiredModeWorkspaces(migrationState.workspaces ?? [])
    if (
      migrationState.activeWorkspaceId &&
      !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  // v76 hoisted the in-tree sprint engine's remaining workspace fields into
  // the per-module state bag. Retired with the engine (2026-09-16).
  if (version < 77) {
    // Files open in the editor window by default (owner ruling 2026-09-25), and
    // the window now carries a file tree beside the file. The preference was
    // already `true` out of the box, but it was STICKY: docking one file back
    // into the workspace flipped it to in-app for good, which is how most
    // profiles came to be on `false` without anyone having chosen it. Nothing
    // before this version offered the choice in Settings, so no stored `false`
    // is a decision — every profile is set to the window once, here. From now
    // on the value only moves when the person picks it in Settings.
    migrationState.openFilesInExternalWindow = true
  }
  if (version < 78) {
    // Voice dictation retired (2026-10-09). Its settings carried the
    // transcription host's bearer token in plain text, so an upgrading profile
    // re-runs the normalizer — which no longer builds the key — and the bump
    // makes the store write the cleaned settings straight back, rather than
    // leaving the token on disk until the next unrelated save. merge() runs
    // the same normalizer on every hydration: this rung is the clean-upgrade
    // half (same split as the v67 rung above).
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }

  return state as never
}
