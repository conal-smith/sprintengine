/**
 * The main-owned workspace registry — the single authoritative store
 * for workspace domain state, and the single writer.
 *
 * Before this, the registry lived in the renderer's zustand store and main held
 * a mirror it declared non-authoritative: restart survivors came back as routing
 * placeholders whose mode/agents/layout were unknown, `workspace.create` had to
 * round-trip through a window and poll the bus for 7s to confirm, and gateway
 * tools refused placeholder workspaces with no live terminal. All three
 * followed from "who is allowed to mint a workspace"; this service is the
 * answer, and every creator — the UI, the gateway, automations, capability
 * modules, the scheduler, the phone — converges on it.
 *
 * Division of labour: pure record math is in `src/shared/workspace-registry.ts`,
 * fs and the write queue in `src/main/workspace-registry-store.ts`, and the
 * sequenced broadcast bus stays in `src/main/workspace-sync-service.ts`, which
 * mints events and calls back into this service to apply them. This service
 * never mutates state behind the bus's back: every accepted mutation is an
 * applied event, so main and every window converge through one code path.
 */
import { randomUUID } from 'crypto'
import {
  addWorkspaceRegistryTombstone,
  classifyPersistedWorkspaceState,
  emptyWorkspaceRegistryFieldStamps,
  emptyWorkspaceRegistryFile,
  isDangerousEmptyClassification,
  isWorkspaceTombstoned,
  normalizeWorkspaceForRegistry,
  parseWorkspaceRegistryFile,
  parseWorkspaceRegistryRecord,
  seedWorkspaceVisitClocks,
  shouldApplyFieldEdit,
  stampWorkspaceVisitClockAtBirth,
  toWorkspaceRegistryRecord,
  WORKSPACE_REGISTRY_SCHEMA_VERSION,
  type PersistedStateClassification,
  type WorkspaceRegistryActor,
  type WorkspaceRegistryFieldStamps,
  type WorkspaceRegistryFile,
  type WorkspaceRegistryRecord,
  type WorkspaceRegistryStampedField,
  type WorkspaceRegistryTombstone,
} from '../shared/workspace-registry'
import { instantiateTemplateAgentIds } from '../shared/agent-ids'
import { resolveHeadlessLayoutTemplate } from '../shared/layouts/templates'
import { isDefaultWorkspaceName } from '../shared/workspace-title'
import { isRetiredWorkspaceMode } from '../shared/workspace-mode'
import {
  applyWorkspaceSyncEvent,
  type WorkspaceSyncCommand,
  type WorkspaceSyncEvent,
  type WorkspaceSyncState,
} from '../shared/workspace-sync'
import type {
  AgentId,
  AgentState,
  Workspace,
  WorkspaceId,
  WorkspaceMode,
  WorkspaceWindowId,
  WorkspaceWorktree,
} from '../renderer/src/types/workspace'
import { hostIdToRecord, type ExecutionHostId } from '../shared/execution-host'
import type { WorkspaceRegistryStore } from './workspace-registry-store'

export type WorkspaceRegistryDiagnostic = {
  level: 'warning'
  title: string
  message: string
  details?: string
}

export type WorkspaceRegistryServiceOptions = {
  store: WorkspaceRegistryStore
  now?: () => number
  newWorkspaceId?: () => string
  logDiagnostic?: (diagnostic: WorkspaceRegistryDiagnostic) => void
}

export type WorkspaceCreateRequest = {
  name?: string
  folderPath?: string | null
  templateId?: string
  mode?: WorkspaceMode
  /** Target window; defaults to the primary window, which always exists. */
  windowId?: WorkspaceWindowId
  /** The machine on this computer it runs on; absent or `local` is this one. */
  hostId?: ExecutionHostId | null
  /** Marks a workspace whose folder is a worktree, filed under the project it was cut from. */
  worktree?: WorkspaceWorktree | null
  /**
   * Agent records it is born with, so a window never sees a tab with no agent
   * behind it. Keyed by the template's id for the agent, a record follows that
   * agent to the fresh id the workspace gives it; keyed by an id named in
   * `templateAgentIds`, it is that agent already.
   */
  agents?: Record<AgentId, AgentState>
  /**
   * The id a template agent takes, keyed by the template's id for it, for a
   * caller that minted its agent before the workspace (main's new chat). Every
   * template agent not named here gets a fresh id.
   */
  templateAgentIds?: Record<AgentId, AgentId>
  /**
   * The name is one the app derived (a chat named after the first message main
   * sent it), so it is not locked: the chat's titler may still replace it with
   * a model-written title (`text-generation/chat-titler.ts`). Absent, a name
   * that is not app-minted locks.
   */
  titleOpen?: boolean
  /** The scheduled agent whose run this chat is; see `Workspace.scheduledAgentId`. */
  scheduledAgentId?: string
  /**
   * Join the window without becoming its active workspace (the
   * `workspace.created` event's `activate: false`), for a chat started on
   * nobody's request at that moment.
   */
  background?: boolean
  /**
   * A chat made from a session a person ran in an agent CLI, born with that
   * session's dates: created when it started, and last messaged and answered
   * when it last moved. The sidebar orders by those, so an import of weeks of
   * history files in beneath the chats of today rather than above them.
   */
  imported?: { startedAt: number; lastActiveAt: number }
}

export type WorkspaceCreateResult = {
  workspace: WorkspaceRegistryRecord
  windowId: WorkspaceWindowId
  folderPath: string | null
}

export type WorkspaceRegistryHydrateResult = {
  changed: boolean
  reason: 'seeded' | 'already_present' | 'refused_dangerous_empty' | 'seeded_empty_intent'
  classification: PersistedStateClassification
  seededWorkspaceCount: number
  droppedRecordIds: string[]
}

export type WorkspaceRegistryPrecheck = { ok: true } | { ok: false; reason: string; message: string }

export type WorkspaceRegistryService = ReturnType<typeof createWorkspaceRegistryService>

/**
 * The renderer's post-migrate-ladder localStorage payload, offered once on the
 * first boot after this landed. Main must never be handed a pre-ladder shape —
 * the ladder lives in the renderer and would not be re-run against main's file.
 */
export type WorkspaceRegistryHydratePayload = {
  workspaces?: unknown
  activeWorkspaceId?: unknown
  workspaceWindows?: unknown
  primaryWorkspaceWindowId?: unknown
  workspaceRegistryEmptyState?: unknown
  /** The raw localStorage string, so main classifies with the same guard the renderer uses. */
  rawLocalStorage?: string | null
}

export function createWorkspaceRegistryService(options: WorkspaceRegistryServiceOptions) {
  const now = options.now ?? Date.now
  const newWorkspaceId = options.newWorkspaceId ?? (() => randomUUID().replace(/-/g, '').slice(0, 21))
  const listeners = new Set<(state: WorkspaceSyncState) => void>()

  const loaded = options.store.read()
  let file: WorkspaceRegistryFile = loaded.status === 'loaded' ? loaded.file : emptyWorkspaceRegistryFile(now())
  // True when nothing authoritative has ever been written: hydration may seed.
  // A registry that loaded from disk is authoritative from then on and hydrate
  // is a no-op, whatever a window offers.
  let seeded = loaded.status === 'loaded' && file.revision > 0
  if (loaded.status === 'unreadable') {
    options.logDiagnostic?.({
      level: 'warning',
      title: 'Workspace registry unreadable',
      message:
        'The workspace registry could not be read. Workspaces are not lost: the app will re-seed from the ' +
        'window registry on the next boot, and the legacy registry key is left untouched.',
      details: loaded.details,
    })
  }

  // The first load under a build that keeps the visit clock counts every chat
  // already here as seen (`seedWorkspaceVisitClocks`), and writes that down so
  // it happens once. Seeded on copies: the store compares a write with the
  // file it read, and records changed in place would read as unchanged.
  if (loaded.status === 'loaded') {
    const workspaces = file.workspaces.map((record) => ({ ...record }))
    if (seedWorkspaceVisitClocks(workspaces, now()) > 0) {
      file = { ...file, workspaces }
      options.store.write(persistableFile(file))
    }
  }

  let state: WorkspaceSyncState = fileToState(file)

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  function getState(): WorkspaceSyncState {
    return state
  }

  function getRecords(): WorkspaceRegistryRecord[] {
    return state.workspaces as WorkspaceRegistryRecord[]
  }

  function getRecord(workspaceId: WorkspaceId): WorkspaceRegistryRecord | null {
    return getRecords().find((record) => record.id === workspaceId) ?? null
  }

  function getRevision(): number {
    return file.revision
  }

  function getTombstones(): WorkspaceRegistryTombstone[] {
    return file.tombstones
  }

  // -------------------------------------------------------------------------
  // Mutation — every accepted change arrives as an applied bus event
  // -------------------------------------------------------------------------

  /**
   * Apply a sequenced event minted by the bus. Returns false when the pure
   * reducer refuses it (a sequence gap or an unapplicable payload), which the
   * bus reports as a rejection rather than persisting a state main did not
   * actually reach.
   */
  function applyEvent(event: WorkspaceSyncEvent, actor: WorkspaceRegistryActor): boolean {
    const applied = applyWorkspaceSyncEvent(state, event)
    if (applied.status !== 'applied') return false
    state = applied.state
    commit(event, actor)
    return true
  }

  /**
   * Bump the store revision once per accepted mutation, stamp the records the
   * event touched, record a tombstone for a removal, then persist and wake
   * subscribers. One counter orders broadcasts; the per-record copy answers "is
   * this record newer than mine" after a partial apply.
   */
  function commit(event: WorkspaceSyncEvent, actor: WorkspaceRegistryActor): void {
    const at = now()
    const revision = file.revision + 1
    for (const workspaceId of touchedWorkspaceIds(event)) {
      const record = getRecord(workspaceId)
      if (record) record.revision = revision
    }
    stampEditedFields(event)
    if (event.type === 'workspace.created') {
      const created = getRecord(event.payload.workspace.id)
      if (created) stampWorkspaceVisitClockAtBirth(created, at)
    }

    let tombstones = file.tombstones
    if (event.type === 'workspace.removed') {
      tombstones = addWorkspaceRegistryTombstone(
        tombstones,
        { id: event.payload.workspaceId, removedAt: at, revision },
        at,
      )
    }

    file = {
      schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
      revision,
      changedAt: at,
      lastWrite: { actor, at: new Date(at).toISOString() },
      workspaces: getRecords(),
      workspaceWindows: state.workspaceWindows,
      primaryWorkspaceWindowId: state.primaryWorkspaceWindowId,
      activeWorkspaceId: state.activeWorkspaceId,
      // An empty registry is only ever intentional when the last removal said
      // so; anything else that empties it is a fault and must not be recorded
      // as intent (see the hydrate guard).
      registryEmptyState:
        state.workspaces.length === 0
          ? (file.registryEmptyState ?? { reason: 'user_removed_all', updatedAt: new Date(at).toISOString() })
          : null,
      tombstones,
    }
    seeded = true
    options.store.write(persistableFile(file), { lazy: isVisitClockOnly(event) })
    for (const listener of listeners) listener(state)
  }

  function stampEditedFields(event: WorkspaceSyncEvent): void {
    const stamp = (workspaceId: WorkspaceId, field: WorkspaceRegistryStampedField, editedAt: number): void => {
      const record = getRecord(workspaceId)
      if (record) {
        record.fieldEditedAt = { ...emptyWorkspaceRegistryFieldStamps(), ...record.fieldEditedAt, [field]: editedAt }
      }
    }
    switch (event.type) {
      case 'workspace.renamed':
        stamp(event.payload.workspaceId, 'name', event.payload.editedAt)
        break
      case 'workspace.layout_updated':
        stamp(event.payload.workspaceId, 'layoutModel', event.payload.editedAt)
        break
      case 'workspace.fields_updated':
        if (event.payload.patch.folderPath !== undefined) {
          stamp(event.payload.workspaceId, 'folderPath', event.payload.editedAt)
        }
        if (event.payload.patch.memory !== undefined) {
          stamp(event.payload.workspaceId, 'memory', event.payload.editedAt)
        }
        if (event.payload.patch.settledAt !== undefined) {
          stamp(event.payload.workspaceId, 'settledAt', event.payload.editedAt)
        }
        if (event.payload.patch.settledOverride !== undefined) {
          stamp(event.payload.workspaceId, 'settledOverride', event.payload.editedAt)
        }
        if (event.payload.patch.autoSettleEnabled !== undefined) {
          stamp(event.payload.workspaceId, 'autoSettleEnabled', event.payload.editedAt)
        }
        if (event.payload.patch.autoCompactEnabled !== undefined) {
          stamp(event.payload.workspaceId, 'autoCompactEnabled', event.payload.editedAt)
        }
        break
      default:
        break
    }
  }

  /**
   * Reject a command before the bus mints an event for it.
   *
   * Two rules live here, and only here:
   * - **Tombstones.** A command naming a recently removed workspace is refused
   *   rather than silently resurrecting the record — without this, a lagging
   *   window's optimistic edit against a workspace another window deleted would
   *   re-create it.
   * - **Per-field last-write-wins.** A command older than the field's stamp is
   *   dropped; the caller learns the rejection and reverts its optimistic apply
   *   to main's value, and the current value is still on the bus for every
   *   other window.
   *
   * A third, for creation: a record whose mode is retired is refused, so a
   * window still holding a row main dropped on load cannot propose it back.
   */
  function precheckCommand(command: WorkspaceSyncCommand): WorkspaceRegistryPrecheck {
    if (command.type === 'workspace.created') return precheckWorkspaceMode(command.payload.workspace.mode)
    const workspaceId = registryCommandWorkspaceId(command)
    if (!workspaceId) return { ok: true }
    if (isWorkspaceTombstoned(file.tombstones, workspaceId)) {
      return {
        ok: false,
        reason: 'unknown_workspace',
        message: `Workspace "${workspaceId}" was removed; the edit was not applied.`,
      }
    }
    const record = getRecord(workspaceId)
    if (!record) {
      return {
        ok: false,
        reason: 'unknown_workspace',
        message: `Workspace "${workspaceId}" is not in the registry.`,
      }
    }
    // A record that entered through an older path may carry no stamp map; an
    // unstamped field reads as never-edited, so the first write wins rather
    // than the read throwing inside main's command path.
    const stamps = record.fieldEditedAt ?? emptyWorkspaceRegistryFieldStamps()
    for (const [field, editedAt] of stampedFieldsForCommand(command)) {
      if (!shouldApplyFieldEdit(stamps[field] ?? 0, editedAt)) {
        return {
          ok: false,
          reason: 'stale_edit',
          message:
            `A newer edit to "${field}" on workspace "${workspaceId}" is already applied; ` +
            'this window is behind and converges on the current value.',
        }
      }
    }
    if (command.type === 'workspace.update_agent') {
      const agent = record.agents[command.payload.agentId]
      const currentStamp = typeof agent?.configEditedAt === 'number' ? agent.configEditedAt : 0
      if (!shouldApplyFieldEdit(currentStamp, command.payload.configEditedAt)) {
        return {
          ok: false,
          reason: 'stale_edit',
          message:
            `A newer edit to agent "${command.payload.agentId}" in workspace "${workspaceId}" is already ` +
            'applied; this window is behind and converges on the current value.',
        }
      }
    }
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /** Refuse a mode no build can render any more (`RETIRED_WORKSPACE_MODES`). */
  function precheckWorkspaceMode(mode: unknown): WorkspaceRegistryPrecheck {
    if (!isRetiredWorkspaceMode(mode)) return { ok: true }
    return {
      ok: false,
      reason: 'retired_workspace_mode',
      message: `Workspace mode "${String(mode)}" was retired; the workspace was not added to the registry.`,
    }
  }

  /**
   * Mint the record a `workspace.created` event will carry.
   *
   * The caller applies the returned record through the bus, which is what makes
   * the new id observable in the same tick and retires the 7s confirmation poll.
   */
  function prepareCreate(input: WorkspaceCreateRequest): WorkspaceCreateResult {
    const folderPath = normalizeOptionalString(input.folderPath)
    const windowId = resolveTargetWindowId(input.windowId)
    const hostId = hostIdToRecord(input.hostId, folderPath)
    const template = resolveHeadlessLayoutTemplate({ templateId: input.templateId })
    const createdAt = now()
    const name = normalizeOptionalString(input.name) ?? defaultWorkspaceName(template.name, getRecords().length + 1)
    // The template's agent ids are placeholders every workspace made from it
    // would share; this workspace's agents take ids of their own.
    const instantiated = instantiateTemplateAgentIds(template.layout, { assign: input.templateAgentIds })
    const workspace: Workspace = {
      id: newWorkspaceId(),
      name,
      // A workspace given a meaningful name locks its title at creation so the
      // first prompt never auto-titles over it — the same rule the renderer's
      // creation path applies. An app-minted name ("Chat 63" from the New chat
      // button, "Solo 4" from a headless create) is NOT meaningful and stays
      // open for the first prompt to name.
      ...(isDefaultWorkspaceName(name, template.name) || input.titleOpen ? {} : { titleLocked: true }),
      mode: input.mode ?? 'standard',
      folderPath,
      folderMissing: false,
      // This machine is written only for a folder inside a distribution, which
      // would otherwise read back as that distribution (owner ruling 2026-10-03).
      ...(hostId ? { hostId } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.scheduledAgentId?.trim() ? { scheduledAgentId: input.scheduledAgentId.trim() } : {}),
      templateId: template.id,
      layoutModel: instantiated.layout,
      agents: rekeyTemplateAgents(input.agents, instantiated.agentIds),
      worktreeState: { containerPath: null, entries: {}, updatedAt: null },
      memory: { relativeRoot: null },
      editorState: { openFiles: [], activeFilePath: null },
      createdAt,
      ...(input.imported
        ? {
            createdAt: input.imported.startedAt,
            lastUserMessageAt: input.imported.lastActiveAt,
            lastTurnEndedAt: input.imported.lastActiveAt,
            // Seen as of its last move: the person ran that session, and an
            // import of weeks of history is not weeks of unread finishes.
            lastVisitedAt: input.imported.lastActiveAt,
          }
        : {}),
    }
    return {
      workspace: toWorkspaceRegistryRecord(workspace, file.revision + 1, stampsForCreate(createdAt)),
      windowId,
      folderPath,
    }
  }

  /**
   * Adopt a full record composed elsewhere — a creation path that carries
   * layout logic living in the window. Main stays the only WRITER: the record
   * is normalized to what the registry owns, stamped, and persisted here. The
   * renderer proposes; main decides and persists.
   */
  function adoptRecord(workspace: Workspace): WorkspaceRegistryRecord {
    const existing = getRecord(workspace.id)
    return toWorkspaceRegistryRecord(
      normalizeWorkspaceForRegistry(workspace),
      file.revision + 1,
      existing?.fieldEditedAt ?? stampsForCreate(workspace.createdAt || now()),
    )
  }

  function resolveTargetWindowId(requested?: WorkspaceWindowId): WorkspaceWindowId {
    const trimmed = requested?.trim()
    if (trimmed && state.workspaceWindows.some((windowState) => windowState.id === trimmed)) return trimmed
    return state.primaryWorkspaceWindowId
  }

  // -------------------------------------------------------------------------
  // Hydration from the renderer's localStorage (one time, first boot)
  // -------------------------------------------------------------------------

  /**
   * Seed the registry from a window's post-migrate-ladder localStorage state.
   * Precedent: `hydrateAutomationMode` and the launch-settings mirror's
   * `hydrate` — seed only when no record exists, actor `system`, and a no-op
   * once main has written anything, so a second window racing the first is a
   * no-op rather than a merge.
   *
   * Refusal is loud and recoverable. An empty payload without an explicit
   * intent record is a FAULT, not an intent: the app has already been bitten by
   * an empty snapshot overwriting a real profile, which is why the renderer's
   * wipe guard exists, and this is the same guard on main's side of the move.
   * The legacy key is left untouched, so a refusal costs one boot and retries.
   */
  function hydrate(payload: WorkspaceRegistryHydratePayload): WorkspaceRegistryHydrateResult {
    const classification = classifyPersistedWorkspaceState({
      rawLocalStorage: payload.rawLocalStorage ?? null,
    })
    if (seeded) {
      return {
        changed: false,
        reason: 'already_present',
        classification,
        seededWorkspaceCount: 0,
        droppedRecordIds: [],
      }
    }

    const rawWorkspaces = Array.isArray(payload.workspaces) ? payload.workspaces : []
    const emptyIntent = isEmptyIntentRecord(payload.workspaceRegistryEmptyState)

    if (rawWorkspaces.length === 0) {
      if (emptyIntent) {
        file = {
          ...emptyWorkspaceRegistryFile(now()),
          revision: 1,
          registryEmptyState: { reason: 'user_removed_all', updatedAt: new Date(now()).toISOString() },
        }
        state = fileToState(file)
        seeded = true
        options.store.write(persistableFile(file))
        for (const listener of listeners) listener(state)
        return {
          changed: true,
          reason: 'seeded_empty_intent',
          classification,
          seededWorkspaceCount: 0,
          droppedRecordIds: [],
        }
      }
      options.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry not seeded',
        message:
          'A window offered an empty workspace list with no record of the user removing everything, so the ' +
          'registry was left unseeded rather than written empty. Your workspaces are still in the previous ' +
          'store and seeding retries on the next launch.',
        details: `classification=${classification} dangerous=${isDangerousEmptyClassification(classification)}`,
      })
      return {
        changed: false,
        reason: 'refused_dangerous_empty',
        classification,
        seededWorkspaceCount: 0,
        droppedRecordIds: [],
      }
    }

    const records: WorkspaceRegistryRecord[] = []
    const droppedRecordIds: string[] = []
    for (const [index, candidate] of rawWorkspaces.entries()) {
      // The renderer's ladder already filtered retired modes; this is the same
      // filter on main's side, silent because such a row is not a fault.
      if (isRecordValue(candidate) && isRetiredWorkspaceMode(candidate.mode)) continue
      const parsed = parseWorkspaceRegistryRecord(candidate)
      if ('reason' in parsed) {
        const id = isRecordValue(candidate) && typeof candidate.id === 'string' ? candidate.id : `#${index}`
        droppedRecordIds.push(id)
        options.logDiagnostic?.({
          level: 'warning',
          title: 'Workspace dropped during registry migration',
          message: `Workspace "${id}" could not be migrated and was skipped; the remaining workspaces migrated normally.`,
          details: `failing_field=${parsed.reason}`,
        })
        continue
      }
      const createdAt = typeof parsed.record.createdAt === 'number' ? parsed.record.createdAt : now()
      records.push(toWorkspaceRegistryRecord(parsed.record, 1, stampsForCreate(createdAt)))
    }
    if (records.length === 0) {
      options.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry not seeded',
        message:
          'Every workspace in the offered registry failed validation, so nothing was seeded rather than ' +
          'writing an empty registry. The previous store is untouched and seeding retries on the next launch.',
        details: `classification=${classification} dropped=${droppedRecordIds.length}`,
      })
      return {
        changed: false,
        reason: 'refused_dangerous_empty',
        classification,
        seededWorkspaceCount: 0,
        droppedRecordIds,
      }
    }

    const at = now()
    const seedState: WorkspaceSyncState = {
      workspaces: records,
      activeWorkspaceId: typeof payload.activeWorkspaceId === 'string' ? payload.activeWorkspaceId : null,
      workspaceWindows: Array.isArray(payload.workspaceWindows)
        ? (payload.workspaceWindows as WorkspaceSyncState['workspaceWindows'])
        : [],
      primaryWorkspaceWindowId:
        typeof payload.primaryWorkspaceWindowId === 'string' && payload.primaryWorkspaceWindowId
          ? payload.primaryWorkspaceWindowId
          : 'primary',
      lastAppliedWorkspaceSyncSequence: state.lastAppliedWorkspaceSyncSequence,
    }
    const seedFile: WorkspaceRegistryFile = {
      schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
      revision: 1,
      changedAt: at,
      lastWrite: { actor: 'system', at: new Date(at).toISOString() },
      workspaces: records,
      workspaceWindows: seedState.workspaceWindows,
      primaryWorkspaceWindowId: seedState.primaryWorkspaceWindowId,
      activeWorkspaceId: seedState.activeWorkspaceId,
      registryEmptyState: null,
      tombstones: [],
    }
    // Round-trip the seed through the same parser a loaded file goes through,
    // so a window's routing block gets exactly the validation main's own file
    // gets. Without it a malformed `workspaceWindows` entry from an old profile
    // would be seeded verbatim and break routing on the very first boot.
    file = parseWorkspaceRegistryFile(JSON.parse(JSON.stringify(seedFile)))?.file ?? seedFile
    // A window's own registry is chats from before this build: seen, as a
    // loaded file's are.
    seedWorkspaceVisitClocks(file.workspaces, at)
    state = fileToState(file)
    seeded = true
    options.store.write(persistableFile(file))
    for (const listener of listeners) listener(state)
    return {
      changed: true,
      reason: 'seeded',
      classification,
      seededWorkspaceCount: records.length,
      droppedRecordIds,
    }
  }

  /** True while the registry has never been written — the window offers to hydrate. */
  function needsHydration(): boolean {
    return !seeded
  }

  function subscribe(listener: (state: WorkspaceSyncState) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    getState,
    getRecords,
    getRecord,
    getRevision,
    /**
     * Mint an id for a record a caller composes itself and then hands to
     * `adoptRecord` (a record composed in a window). One generator
     * for both creation shapes, so a composed record's id is indistinguishable
     * from a `prepareCreate` one.
     */
    newWorkspaceId,
    getTombstones,
    applyEvent,
    precheckCommand,
    precheckWorkspaceMode,
    prepareCreate,
    adoptRecord,
    hydrate,
    needsHydration,
    subscribe,
    flush: () => options.store.flush(),
  }

  function fileToState(source: WorkspaceRegistryFile): WorkspaceSyncState {
    const next: WorkspaceSyncState = {
      workspaces: source.workspaces.map((record) => ({ ...record })),
      activeWorkspaceId: source.activeWorkspaceId,
      workspaceWindows: source.workspaceWindows.map((windowState) => ({
        ...windowState,
        workspaceIds: [...windowState.workspaceIds],
        bounds: windowState.bounds ? { ...windowState.bounds } : null,
      })),
      primaryWorkspaceWindowId: source.primaryWorkspaceWindowId,
      // The bus owns the sequence; a restart restarts it, and windows resync
      // from the snapshot rather than replaying across the restart boundary.
      lastAppliedWorkspaceSyncSequence: 0,
    }
    ensurePrimaryWindow(next)
    return next
  }

  /**
   * Detach the snapshot handed to the store from live state. The write is
   * debounced by 250 ms and serializes at flush time, so anything still
   * aliasing the live arrays could be mutated between the queue and the write
   * — the file would then carry a state main never committed at that revision.
   */
  function persistableFile(source: WorkspaceRegistryFile): WorkspaceRegistryFile {
    return {
      ...source,
      workspaces: source.workspaces.map((record) =>
        toWorkspaceRegistryRecord(record, record.revision, record.fieldEditedAt),
      ),
      workspaceWindows: source.workspaceWindows.map((windowState) => ({
        ...windowState,
        workspaceIds: [...windowState.workspaceIds],
        bounds: windowState.bounds ? { ...windowState.bounds } : null,
      })),
      tombstones: source.tombstones.map((entry) => ({ ...entry })),
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A window showing a chat stamps its visit clock every ten seconds, and each
 * stamp would otherwise rewrite the whole registry file. Memory, subscribers
 * and every device reading the clock see the stamp at once; only the disk
 * waits, for the next other write, the lazy interval, or quit. Marking a chat
 * unread is a gesture, not a stamp, and is written straight away.
 */
function isVisitClockOnly(event: WorkspaceSyncEvent): boolean {
  if (event.type !== 'workspace.fields_updated') return false
  const fields = Object.keys(event.payload.patch)
  return fields.length > 0 && fields.every((field) => field === 'lastVisitedAt')
}

function ensurePrimaryWindow(state: WorkspaceSyncState): void {
  if (state.workspaceWindows.some((windowState) => windowState.id === state.primaryWorkspaceWindowId)) return
  state.workspaceWindows.unshift({
    id: state.primaryWorkspaceWindowId,
    kind: 'primary',
    workspaceIds: [],
    activeWorkspaceId: null,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 0,
    lastFocusedAt: 0,
  })
}

/** Records a bump applies to, so an unrelated workspace's revision stays put. */
function touchedWorkspaceIds(event: WorkspaceSyncEvent): WorkspaceId[] {
  switch (event.type) {
    case 'workspace.created':
      return [event.payload.workspace.id]
    case 'workspace.renamed':
    case 'workspace.layout_updated':
    case 'workspace.fields_updated':
    case 'workspace.agents_updated':
    case 'agent_terminal.session_assigned':
    case 'agent_terminal.launch_state_updated':
      return [event.payload.workspaceId]
    case 'workspace.moved_to_window':
      return [event.payload.workspaceId]
    default:
      return []
  }
}

function registryCommandWorkspaceId(command: WorkspaceSyncCommand): WorkspaceId | null {
  switch (command.type) {
    case 'workspace.rename':
    case 'workspace.update_layout':
    case 'workspace.update_fields':
    case 'workspace.update_agent':
    case 'workspace.remove':
      return command.payload.workspaceId
    default:
      return null
  }
}

function stampedFieldsForCommand(command: WorkspaceSyncCommand): [WorkspaceRegistryStampedField, number][] {
  switch (command.type) {
    case 'workspace.rename':
      return [['name', command.payload.editedAt]]
    case 'workspace.update_layout':
      return [['layoutModel', command.payload.editedAt]]
    case 'workspace.update_fields': {
      const fields: [WorkspaceRegistryStampedField, number][] = []
      if (command.payload.patch.folderPath !== undefined) fields.push(['folderPath', command.payload.editedAt])
      if (command.payload.patch.memory !== undefined) fields.push(['memory', command.payload.editedAt])
      if (command.payload.patch.settledAt !== undefined) fields.push(['settledAt', command.payload.editedAt])
      if (command.payload.patch.settledOverride !== undefined) {
        fields.push(['settledOverride', command.payload.editedAt])
      }
      if (command.payload.patch.autoSettleEnabled !== undefined) {
        fields.push(['autoSettleEnabled', command.payload.editedAt])
      }
      if (command.payload.patch.autoCompactEnabled !== undefined) {
        fields.push(['autoCompactEnabled', command.payload.editedAt])
      }
      if (command.payload.patch.snoozedUntil !== undefined) fields.push(['snoozedUntil', command.payload.editedAt])
      return fields
    }
    default:
      return []
  }
}

function stampsForCreate(createdAt: number): WorkspaceRegistryFieldStamps {
  // A freshly minted record's fields were "edited" at creation, so the first
  // real user edit (which is necessarily later) always wins over the seed.
  return { ...emptyWorkspaceRegistryFieldStamps(), name: createdAt, layoutModel: createdAt, folderPath: createdAt }
}

// A record handed in under the template's id for an agent moves to the id that
// agent took in this workspace, so it stays the agent behind that tab. A record
// under any other key is kept as it came.
function rekeyTemplateAgents(
  agents: Record<AgentId, AgentState> | undefined,
  templateAgentIds: Record<AgentId, AgentId>,
): Record<AgentId, AgentState> {
  const rekeyed: Record<AgentId, AgentState> = {}
  for (const [key, agent] of Object.entries(agents ?? {})) {
    const id = Object.hasOwn(templateAgentIds, key) ? templateAgentIds[key] : key
    rekeyed[id] = id === key ? agent : { ...agent, id }
  }
  return rekeyed
}

function defaultWorkspaceName(templateName: string, ordinal: number): string {
  return `${templateName} ${ordinal}`
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isEmptyIntentRecord(value: unknown): boolean {
  return isRecordValue(value) && value.reason === 'user_removed_all'
}
