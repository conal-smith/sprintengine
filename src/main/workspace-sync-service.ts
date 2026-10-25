import {
  type WorkspaceFieldsPatch,
  type WorkspaceSyncCommand,
  type WorkspaceSyncCommandResult,
  type WorkspaceSyncEvent,
  type WorkspaceSyncEventType,
  type WorkspaceSyncSnapshot,
  type WorkspaceSyncState,
} from '../shared/workspace-sync'
import type {
  WorkspaceCreateRequest,
  WorkspaceCreateResult,
  WorkspaceRegistryService,
} from './workspace-registry-service'
import type { WorkspaceRegistryActor } from '../shared/workspace-registry'
import type { AgentState, Workspace, WorkspaceId } from '../renderer/src/types/workspace'
import { isRecord } from '../shared/records'
import { isConversationHighlightColor } from '../../packages/conversation-protocol/src/public'

const MAX_REPLAY_EVENTS = 500

// The sequenced broadcast bus over the main-owned workspace registry.
//
// This service used to be a state machine with its own snapshot, explicitly NOT
// authoritative: restart survivors were rebuilt as routing placeholders whose
// mode, agents, and layout were unknown until a renderer re-offered them. The
// registry (`workspace-registry-service.ts`) is authoritative now, so the
// placeholder model, its `workspaceNames`/`workspaceFolderPaths`/
// `workspaceModes` side-maps, and the routing snapshot they patched are gone.
//
// What is left here is the wire: monotonic sequences, duplicate/stale
// rejection, a bounded replay log, command validation, and event minting. The
// direction of authority is what changed — a renderer used to apply locally and
// then tell main; now a renderer ASKS and main DECIDES, and the accepted event
// is the authoritative record of what happened.

type DispatchInput = {
  command: unknown
  sourceWindowId: string
}

type WorkspaceSyncServiceOptions = {
  registry: WorkspaceRegistryService
  maxReplayEvents?: number
  now?: () => number
  // Resolves a CLI's conversation-resume capabilities from the plugin registry.
  // Injected (app-services wires it to the registry) so this service stays a
  // pure state machine; the resolved caps are stamped onto assign_session so
  // stores never re-derive resume from a cli-id allowlist. Default: both false.
  resolveResumeCapabilities?: (cli: string) => { resumeSession: boolean; sessionIdFromCaller: boolean }
}

export type WorkspaceSyncService = ReturnType<typeof createWorkspaceSyncService>

/** Actor names the process boundary a main-originated mutation came through. */
export type WorkspaceMutationActor = WorkspaceRegistryActor

export function createWorkspaceSyncService(options: WorkspaceSyncServiceOptions) {
  const registry = options.registry
  const maxReplayEvents = Math.max(1, Math.floor(options.maxReplayEvents ?? MAX_REPLAY_EVENTS))
  const now = options.now ?? Date.now
  const resolveResumeCapabilities =
    options.resolveResumeCapabilities ?? (() => ({ resumeSession: false, sessionIdFromCaller: false }))
  let nextSequence = registry.getState().lastAppliedWorkspaceSyncSequence + 1
  const events: WorkspaceSyncEvent[] = []
  const eventListeners = new Set<(event: WorkspaceSyncEvent) => void>()

  function state(): WorkspaceSyncState {
    return registry.getState()
  }

  // One clone per registry mutation, not one per read. `getSnapshot` is read
  // from fifteen places in main — a remote session list once took it once PER
  // SESSION for a workspace-name lookup — and each read deep-cloned
  // the whole state (462 workspaces on the owner's machine: ~9 ms a clone, and
  // the 30-second beachball of 2026-09-05 was seconds of them back to back).
  // The registry replaces its state object and bumps its revision on every
  // accepted mutation, so those two together are the cache key; an unchanged
  // registry hands back the same snapshot object. Readers treat it as
  // read-only — the clone still protects the registry, just once.
  let cachedSnapshot: { state: WorkspaceSyncState; revision: number; snapshot: WorkspaceSyncSnapshot } | null = null

  function getSnapshot(): WorkspaceSyncSnapshot {
    const current = state()
    const revision = registry.getRevision()
    if (cachedSnapshot && cachedSnapshot.state === current && cachedSnapshot.revision === revision) {
      return cachedSnapshot.snapshot
    }
    const snapshot = stateToSnapshot(current)
    cachedSnapshot = { state: current, revision, snapshot }
    return snapshot
  }

  function getEventsAfter(sequence: unknown): WorkspaceSyncEvent[] {
    if (!Number.isInteger(sequence) || typeof sequence !== 'number' || sequence < 0) return []
    return events
      .filter((event) => event.sequence > sequence)
      .slice(-maxReplayEvents)
      .map(clone)
  }

  function dispatch(input: DispatchInput): WorkspaceSyncCommandResult {
    const sourceWindowId = normalizeId(input.sourceWindowId)
    if (!sourceWindowId) {
      return failure('invalid_source_window', 'Workspace sync dispatch requires a source window id.')
    }

    const validation = validateCommand(input.command, state(), sourceWindowId)
    if (!validation.ok) {
      return failure(validation.reason, validation.message)
    }

    // Tombstones and per-field last-write-wins are the registry's call, not the
    // bus's: a rejection here means the window is behind, and it reverts its
    // optimistic apply to main's value rather than keeping one main refused.
    const precheck = registry.precheckCommand(validation.command)
    if (!precheck.ok) {
      return { ok: false, reason: precheck.reason, message: precheck.message, snapshot: getSnapshot() }
    }

    // A window-composed create is a PROPOSAL, not a write: the record is
    // normalized to what the registry owns and stamped here before it is
    // committed. This is how a record composed in a window — the one shape whose
    // creation logic still lives in the renderer — stays compatible with
    // single-writer authority: the window proposed the payload, main wrote it.
    const command =
      validation.command.type === 'workspace.created'
        ? ({
            ...validation.command,
            payload: {
              ...validation.command.payload,
              workspace: registry.adoptRecord(validation.command.payload.workspace),
            },
          } satisfies WorkspaceSyncCommand)
        : validation.command

    // `announce: false` — the IPC handler broadcasts this one itself so it can
    // skip the window that sent it. That window learns the authoritative
    // outcome from the invoke result, which carries the accepted event
    // (including any value main normalized) or the rejection, so a broadcast
    // back to it would only be a redundant round-trip.
    return emit(command, sourceWindowId, 'ui', false)
  }

  /**
   * Create a workspace and return the authoritative record in the SAME call.
   *
   * This is what retires `createWorkspaceConfirmed`'s renderer round-trip and
   * its 7s bus-confirmation poll: the caller never gets back an id it cannot
   * observe, because the id it gets is the one main just committed. With zero
   * windows open it still succeeds — creation is no longer a renderer errand.
   */
  function createWorkspace(
    input: WorkspaceCreateRequest,
    actor: WorkspaceMutationActor,
  ): { ok: true; result: WorkspaceCreateResult } | { ok: false; reason: string; message: string } {
    const modeCheck = registry.precheckWorkspaceMode(input.mode)
    if (!modeCheck.ok) return modeCheck
    const prepared = registry.prepareCreate(input)
    const emitted = emit(
      {
        type: 'workspace.created',
        payload: {
          workspace: prepared.workspace,
          windowId: prepared.windowId,
          insert: { kind: 'folder_head', folderPath: prepared.folderPath },
          ...(input.background ? { activate: false as const } : {}),
        },
      },
      prepared.windowId,
      actor,
    )
    if (!emitted.ok) return { ok: false, reason: emitted.reason, message: emitted.message }
    const committed = registry.getRecord(prepared.workspace.id)
    if (!committed) {
      return {
        ok: false,
        reason: 'registry_commit_failed',
        message: `Workspace "${prepared.workspace.id}" was accepted but is not readable from the registry.`,
      }
    }
    return { ok: true, result: { ...prepared, workspace: committed } }
  }

  /**
   * Adopt a record a window composed itself — the one
   * mode whose creation logic still lives in the renderer.
   * The record is normalized and committed here, so main remains the only
   * writer and the only persister; the window proposed the payload, it did not
   * write it.
   */
  function adoptWorkspace(
    workspace: Workspace,
    windowId: string,
    folderPath: string | null,
    actor: WorkspaceMutationActor,
  ): WorkspaceSyncCommandResult {
    const modeCheck = registry.precheckWorkspaceMode(workspace.mode)
    if (!modeCheck.ok) return failure(modeCheck.reason, modeCheck.message)
    return emit(
      {
        type: 'workspace.created',
        payload: {
          workspace: registry.adoptRecord(workspace),
          windowId,
          insert: { kind: 'folder_head', folderPath },
        },
      },
      windowId,
      actor,
    )
  }

  /** Remove a workspace and tombstone its id so a lagging edit cannot resurrect it. */
  function removeWorkspace(workspaceId: WorkspaceId, actor: WorkspaceMutationActor): WorkspaceSyncCommandResult {
    if (!registry.getRecord(workspaceId)) {
      return failure('unknown_workspace', `Workspace "${workspaceId}" is not in the registry.`)
    }
    return emit(
      { type: 'workspace.remove', payload: { workspaceId } },
      registry.getState().primaryWorkspaceWindowId,
      actor,
    )
  }

  /**
   * Record a main-originated field change (folder resolution, archive, the
   * scheduler's own bookkeeping). Not last-write-wins: main's subsystems write
   * through the service and carry no user gesture to stamp.
   */
  function updateWorkspaceFields(
    workspaceId: WorkspaceId,
    patch: WorkspaceFieldsPatch,
    actor: WorkspaceMutationActor,
  ): WorkspaceSyncCommandResult {
    if (patch.visitRewoundAt !== undefined) {
      return failure('field_not_editable', 'The visit clock goes back only through Mark unread (rewindVisit).')
    }
    return emit(
      { type: 'workspace.update_fields', payload: { workspaceId, patch, editedAt: now() } },
      registry.getState().primaryWorkspaceWindowId,
      actor,
    )
  }

  /**
   * Mark unread's write, and the only one that may move a chat's visit clock
   * back: `lastVisitedAt` goes to `lastVisitedAt`, stamped with a
   * `visitRewoundAt` of now, which is what lets every reducer take the
   * earlier time (`visitRewindApplies`). It travels as an ordinary
   * `workspace.fields_updated`, so a window applies it as it applies any.
   */
  function rewindVisit(
    workspaceId: WorkspaceId,
    lastVisitedAt: number,
    actor: WorkspaceMutationActor,
  ): WorkspaceSyncCommandResult {
    if (!Number.isFinite(lastVisitedAt)) {
      return failure('invalid_field_value', 'A visit clock goes back to a time, never to nothing.')
    }
    if (!registry.getRecord(workspaceId)) {
      return failure('unknown_workspace', `Workspace "${workspaceId}" is not in the registry.`)
    }
    const patch: WorkspaceFieldsPatch = { lastVisitedAt, visitRewoundAt: now() }
    return emit(
      { type: 'workspace.update_fields', payload: { workspaceId, patch, editedAt: now() } },
      registry.getState().primaryWorkspaceWindowId,
      actor,
    )
  }

  /**
   * Record a name main chose itself: a chat's title, taken from its first
   * message (`chat-titler.ts`). It carries the lock as a window's title does,
   * so the name stops moving once it lands.
   *
   * Stamped with the name's current stamp rather than now, as an agent main
   * registers is stamped 0: nobody decided this name, so a person's rename in
   * any window wins over it, even one typed a moment before this write and
   * still on its way to main. A name a person did decide, on a paired device
   * (`conversation.rename`), passes `editedAt` as a window's rename stamps it.
   */
  function renameWorkspace(
    workspaceId: WorkspaceId,
    name: string,
    titleLocked: boolean,
    actor: WorkspaceMutationActor,
    editedAt?: number,
  ): WorkspaceSyncCommandResult {
    const record = registry.getRecord(workspaceId)
    if (!record) return failure('unknown_workspace', `Workspace "${workspaceId}" is not in the registry.`)
    if (!name.trim()) return failure('invalid_workspace_name', 'A workspace name cannot be empty.')
    return emit(
      {
        type: 'workspace.rename',
        payload: { workspaceId, name, titleLocked, editedAt: editedAt ?? record.fieldEditedAt?.name ?? 0 },
      },
      registry.getState().primaryWorkspaceWindowId,
      actor,
    )
  }

  /**
   * Record a main-originated agent change. `configEditedAt` defaults to now;
   * a caller writing something no person decided (main registering an agent it
   * launched) passes 0, so any window's edit to that agent — even one stamped
   * before this write arrived — still wins over it.
   */
  function updateWorkspaceAgent(
    workspaceId: WorkspaceId,
    agentId: string,
    patch: Partial<AgentState> | null,
    actor: WorkspaceMutationActor,
    configEditedAt: number = now(),
  ): WorkspaceSyncCommandResult {
    return emit(
      { type: 'workspace.update_agent', payload: { workspaceId, agentId, patch, configEditedAt } },
      registry.getState().primaryWorkspaceWindowId,
      actor,
    )
  }

  /**
   * Subscribe to accepted events. The IPC layer attaches here so an event minted
   * with no source window — a gateway create, an automation, the scheduler —
   * still reaches every window; `dispatch` results are broadcast by the IPC
   * handler itself so it can skip the window that sent the command.
   */
  function subscribeEvents(listener: (event: WorkspaceSyncEvent) => void): () => void {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
  }

  return {
    adoptWorkspace,
    createWorkspace,
    dispatch,
    flush: () => registry.flush(),
    getEventsAfter,
    getSnapshot,
    removeWorkspace,
    renameWorkspace,
    rewindVisit,
    subscribeEvents,
    updateWorkspaceAgent,
    updateWorkspaceFields,
  }

  /** Mint, apply, log, and announce one accepted command. */
  function emit(
    command: WorkspaceSyncCommand,
    sourceWindowId: string,
    actor: WorkspaceMutationActor,
    announce = true,
  ): WorkspaceSyncCommandResult {
    const event: WorkspaceSyncEvent = {
      id: `workspace-sync-${nextSequence}`,
      type: eventTypeForCommand(command),
      sourceWindowId,
      sequence: nextSequence,
      createdAt: now(),
      payload: eventPayloadForCommand(command, state(), resolveResumeCapabilities, now),
    } as WorkspaceSyncEvent

    if (!registry.applyEvent(event, actor)) {
      return failure('event_apply_failed', 'Workspace sync command could not be applied to the registry.')
    }

    nextSequence += 1
    events.push(event)
    if (events.length > maxReplayEvents) events.splice(0, events.length - maxReplayEvents)
    if (announce) {
      for (const listener of eventListeners) listener(clone(event))
    }
    return { ok: true, event: clone(event) }
  }
}

function failure(reason: string, message: string): WorkspaceSyncCommandResult {
  return { ok: false, reason, message }
}

function stateToSnapshot(state: WorkspaceSyncState): WorkspaceSyncSnapshot {
  const { lastAppliedWorkspaceSyncSequence: sequence, ...snapshotState } = state
  return {
    sequence,
    state: clone(snapshotState),
  }
}

type ValidationResult = { ok: true; command: WorkspaceSyncCommand } | { ok: false; reason: string; message: string }

function validateCommand(input: unknown, state: WorkspaceSyncState, sourceWindowId: string): ValidationResult {
  if (!isRecord(input) || typeof input.type !== 'string' || !isRecord(input.payload)) {
    return reject('invalid_command', 'Workspace sync command must include a type and payload.')
  }

  switch (input.type) {
    case 'workspace_window.set_active':
      return validateSetActive(input.payload, state, sourceWindowId)
    case 'workspace.move_to_window':
      return validateMoveToWindow(input.payload, state, sourceWindowId)
    case 'workspace_window.update_placement':
      return validatePlacement(input.payload, state, sourceWindowId)
    case 'workspace_window.close':
      return validateWindowClose(input.payload, state, sourceWindowId)
    case 'workspace.created':
      return validateWorkspaceCreated(input.payload, state, sourceWindowId)
    case 'agent_terminal.assign_session':
      return validateAssignSession(input.payload, state, sourceWindowId)
    case 'agent_terminal.update_launch_state':
      return validateLaunchState(input.payload, state, sourceWindowId)
    case 'workspace.rename':
      return validateRename(input.payload)
    case 'workspace.update_layout':
      return validateUpdateLayout(input.payload)
    case 'workspace.update_fields':
      return validateUpdateFields(input.payload)
    case 'workspace.update_agent':
      return validateUpdateAgent(input.payload)
    case 'workspace.remove':
      return validateRemove(input.payload)
    default:
      return reject('unknown_command_type', `Workspace sync command type "${input.type}" is not supported.`)
  }
}

function validateSetActive(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  const windowId = normalizeId(payload.windowId)
  if (!windowId) return reject('invalid_window_id', 'Active workspace commands require a window id.')
  if (windowId !== sourceWindowId) {
    return reject(
      'window_authority_mismatch',
      `Window "${sourceWindowId}" cannot change active workspace for window "${windowId}".`,
    )
  }
  const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
  if (!windowState) return reject('unknown_window', `Window "${windowId}" is not known to workspace sync.`)
  const workspaceId = payload.workspaceId === null ? null : normalizeId(payload.workspaceId)
  if (payload.workspaceId !== null && !workspaceId) {
    return reject('invalid_workspace_id', 'Active workspace commands require a workspace id or null.')
  }
  if (workspaceId && !windowState.workspaceIds.includes(workspaceId)) {
    return reject('workspace_not_in_window', `Workspace "${workspaceId}" is not assigned to window "${windowId}".`)
  }
  return { ok: true, command: { type: 'workspace_window.set_active', payload: { windowId, workspaceId } } }
}

function validateMoveToWindow(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const toWindowId = normalizeId(payload.toWindowId)
  const fromWindowId = payload.fromWindowId === null ? null : normalizeId(payload.fromWindowId)
  if (!workspaceId || !toWindowId || (payload.fromWindowId !== null && !fromWindowId)) {
    return reject('invalid_move_payload', 'Move commands require workspace, source, and target window ids.')
  }
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return reject('unknown_workspace', `Workspace "${workspaceId}" is not known to workspace sync.`)
  }
  const sourceWindow = state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
  if (!sourceWindow)
    return reject('unknown_source_window', `Source window "${sourceWindowId}" is not known to workspace sync.`)
  if (fromWindowId && fromWindowId !== sourceWindowId) {
    return reject(
      'window_authority_mismatch',
      `Window "${sourceWindowId}" cannot move workspace from window "${fromWindowId}".`,
    )
  }
  if (!sourceWindow.workspaceIds.includes(workspaceId)) {
    return reject(
      'workspace_not_in_source_window',
      `Workspace "${workspaceId}" is not assigned to source window "${sourceWindowId}".`,
    )
  }
  if (fromWindowId) {
    const source = state.workspaceWindows.find((windowState) => windowState.id === fromWindowId)
    if (!source)
      return reject('unknown_source_window', `Source window "${fromWindowId}" is not known to workspace sync.`)
    if (!source.workspaceIds.includes(workspaceId)) {
      return reject(
        'workspace_not_in_source_window',
        `Workspace "${workspaceId}" is not assigned to source window "${fromWindowId}".`,
      )
    }
  }
  return {
    ok: true,
    command: {
      type: 'workspace.move_to_window',
      payload: { workspaceId, fromWindowId, toWindowId, makeActive: payload.makeActive === true },
    },
  }
}

function validatePlacement(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  const windowId = normalizeId(payload.windowId)
  if (!windowId) return reject('invalid_window_id', 'Placement commands require a window id.')
  if (windowId !== sourceWindowId) {
    return reject(
      'window_authority_mismatch',
      `Window "${sourceWindowId}" cannot update placement for window "${windowId}".`,
    )
  }
  if (!state.workspaceWindows.some((candidate) => candidate.id === windowId)) {
    return reject('unknown_window', `Window "${windowId}" is not known to workspace sync.`)
  }
  const bounds = payload.bounds
  if (bounds !== null && !isBounds(bounds)) {
    return reject('invalid_bounds', 'Placement commands require finite bounds or null.')
  }
  if (payload.displayId !== null && payload.displayId !== undefined && !isFiniteNumber(payload.displayId)) {
    return reject('invalid_display_id', 'Placement display id must be a finite number or null.')
  }
  return {
    ok: true,
    command: {
      type: 'workspace_window.update_placement',
      payload: {
        windowId,
        bounds: bounds ? { ...bounds } : null,
        isMaximized: payload.isMaximized === true,
        displayId: isFiniteNumber(payload.displayId) ? payload.displayId : null,
      },
    },
  }
}

function validateWindowClose(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  const windowId = normalizeId(payload.windowId)
  const fallbackWindowId = normalizeId(payload.fallbackWindowId)
  if (!windowId || !fallbackWindowId) {
    return reject('invalid_close_payload', 'Close commands require a window id and fallback window id.')
  }
  if (windowId !== sourceWindowId) {
    return reject('window_authority_mismatch', `Window "${sourceWindowId}" cannot close window "${windowId}".`)
  }
  if (windowId === state.primaryWorkspaceWindowId) {
    return reject('cannot_close_primary_window', 'Workspace sync cannot close the primary window.')
  }
  if (!state.workspaceWindows.some((candidate) => candidate.id === windowId)) {
    return reject('unknown_window', `Window "${windowId}" is not known to workspace sync.`)
  }
  if (!state.workspaceWindows.some((candidate) => candidate.id === fallbackWindowId)) {
    return reject('unknown_fallback_window', `Fallback window "${fallbackWindowId}" is not known to workspace sync.`)
  }
  return { ok: true, command: { type: 'workspace_window.close', payload: { windowId, fallbackWindowId } } }
}

function validateWorkspaceCreated(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  if (!isRecord(payload.workspace)) {
    return reject('invalid_workspace', 'Workspace creation commands require a workspace object.')
  }
  const workspaceId = normalizeId(payload.workspace.id)
  const windowId = normalizeId(payload.windowId)
  if (!workspaceId || !windowId) {
    return reject('invalid_workspace_created_payload', 'Workspace creation commands require workspace and window ids.')
  }
  if (windowId !== sourceWindowId) {
    return reject(
      'window_authority_mismatch',
      `Window "${sourceWindowId}" cannot create a workspace in window "${windowId}".`,
    )
  }
  if (!state.workspaceWindows.some((candidate) => candidate.id === windowId)) {
    return reject('unknown_window', `Window "${windowId}" is not known to workspace sync.`)
  }
  // A same-id create is a duplicate, full stop. The placeholder exception this
  // check used to carry ("accept a re-offer over a restart placeholder to heal
  // the mode main lost") is gone with the placeholder: main never loses the
  // mode now, so there is nothing to heal and a duplicate is only ever a bug.
  if (state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return reject('workspace_already_exists', `Workspace "${workspaceId}" already exists.`)
  }
  if (!isRecord(payload.workspace.agents)) {
    return reject('invalid_workspace', 'Workspace creation commands require a renderer-compatible workspace payload.')
  }
  if (!isRecord(payload.insert) || payload.insert.kind !== 'folder_head') {
    return reject('invalid_insert', 'Workspace creation commands require a folder_head insert descriptor.')
  }
  if (
    payload.insert.folderPath !== null &&
    payload.insert.folderPath !== undefined &&
    typeof payload.insert.folderPath !== 'string'
  ) {
    return reject('invalid_insert', 'Workspace creation folder path must be a string or null.')
  }
  const folderPath = payload.insert.folderPath === null ? null : normalizeOptionalString(payload.insert.folderPath)
  return {
    ok: true,
    command: {
      type: 'workspace.created',
      payload: {
        workspace: clone(payload.workspace) as Workspace,
        windowId,
        insert: { kind: 'folder_head', folderPath },
        // A chat started from this window without being brought to the
        // front (⌘⏎ from New chat): the echo must leave the window as it is.
        ...(payload.activate === false ? { activate: false as const } : {}),
      },
    },
  }
}

function validateRename(payload: Record<string, unknown>): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  if (!workspaceId) return reject('invalid_workspace_id', 'Rename commands require a workspace id.')
  if (typeof payload.name !== 'string' || !payload.name.trim()) {
    return reject('invalid_workspace_name', 'Rename commands require a non-empty name.')
  }
  const editedAt = editedAtOf(payload.editedAt)
  if (editedAt === null) return reject('invalid_edited_at', 'Rename commands require a numeric editedAt stamp.')
  if (payload.titleLocked !== undefined && typeof payload.titleLocked !== 'boolean') {
    return reject('invalid_title_locked', 'Rename command field "titleLocked" must be boolean when provided.')
  }
  return {
    ok: true,
    command: {
      type: 'workspace.rename',
      payload: {
        workspaceId,
        name: payload.name,
        ...(payload.titleLocked !== undefined ? { titleLocked: payload.titleLocked } : {}),
        editedAt,
      },
    },
  }
}

function validateUpdateLayout(payload: Record<string, unknown>): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  if (!workspaceId) return reject('invalid_workspace_id', 'Layout commands require a workspace id.')
  if (!isRecord(payload.layoutModel)) {
    return reject('invalid_layout_model', 'Layout commands require a FlexLayout model object.')
  }
  const editedAt = editedAtOf(payload.editedAt)
  if (editedAt === null) return reject('invalid_edited_at', 'Layout commands require a numeric editedAt stamp.')
  return {
    ok: true,
    command: {
      type: 'workspace.update_layout',
      payload: {
        workspaceId,
        layoutModel: clone(payload.layoutModel) as unknown as Workspace['layoutModel'],
        editedAt,
      },
    },
  }
}

// The fields a window may edit. Anything outside this list is main's own
// (session assignment, launch flags) and is
// refused rather than silently dropped, so a caller learns its patch did
// nothing instead of believing it landed.
const EDITABLE_FIELDS = [
  'folderPath',
  'folderMissing',
  'memory',
  'settledAt',
  'settledOverride',
  'autoSettleEnabled',
  'autoCompactEnabled',
  'snoozedUntil',
  'highlight',
  'worktree',
  'lastTerminalActivityAt',
  'lastUserMessageAt',
  'lastTurnEndedAt',
  'lastVisitedAt',
  // Not `visitRewoundAt`: it is the one stamp that lets a patch lower the
  // visit clock, so only Mark unread's own command writes it (`rewindVisit`).
] as const

// The domain of each typed editable field. A wrong-shaped value would persist
// and broadcast to every window, and the readers of these fields are plain
// `typeof` tests — a string clock would make the rest sweep read NaN, an
// unknown override would park a row out of the sweep forever.
const FIELD_VALUE_CHECKS: Partial<Record<(typeof EDITABLE_FIELDS)[number], (value: unknown) => boolean>> = {
  settledAt: (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  settledOverride: (value) => value === null || value === 'settled' || value === 'active',
  autoSettleEnabled: (value) => value === null || typeof value === 'boolean',
  autoCompactEnabled: (value) => value === null || typeof value === 'boolean',
  snoozedUntil: (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  // A star and one of the row menu's colours: what a paired device reads back
  // off the chat list (`parseConversationWireHighlight`).
  highlight: (value) =>
    value === null ||
    (isRecord(value) &&
      typeof value.starred === 'boolean' &&
      (value.color === null || isConversationHighlightColor(value.color))),
  lastTerminalActivityAt: (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  lastUserMessageAt: (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  lastTurnEndedAt: (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  lastVisitedAt: (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
}

function fieldValueIsWellFormed(key: string, value: unknown): boolean {
  const check = FIELD_VALUE_CHECKS[key as (typeof EDITABLE_FIELDS)[number]]
  return check ? check(value) : true
}

function validateUpdateFields(payload: Record<string, unknown>): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  if (!workspaceId) return reject('invalid_workspace_id', 'Field commands require a workspace id.')
  if (!isRecord(payload.patch)) return reject('invalid_patch', 'Field commands require a patch object.')
  const editedAt = editedAtOf(payload.editedAt)
  if (editedAt === null) return reject('invalid_edited_at', 'Field commands require a numeric editedAt stamp.')
  const patch: WorkspaceFieldsPatch = {}
  for (const [key, value] of Object.entries(payload.patch)) {
    if (value === undefined) continue
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) {
      return reject('field_not_editable', `Workspace field "${key}" is not editable through workspace sync.`)
    }
    if (!fieldValueIsWellFormed(key, value)) {
      return reject('invalid_field_value', `Workspace field "${key}" was sent a value of the wrong shape.`)
    }
    ;(patch as Record<string, unknown>)[key] = clone(value)
  }
  if (Object.keys(patch).length === 0) {
    return reject('empty_patch', 'Field commands require at least one field to change.')
  }
  return { ok: true, command: { type: 'workspace.update_fields', payload: { workspaceId, patch, editedAt } } }
}

function validateUpdateAgent(payload: Record<string, unknown>): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const agentId = normalizeId(payload.agentId)
  if (!workspaceId || !agentId) {
    return reject('invalid_agent_payload', 'Agent commands require workspace and agent ids.')
  }
  if (payload.patch !== null && !isRecord(payload.patch)) {
    return reject('invalid_patch', 'Agent commands require a patch object or null to remove the agent.')
  }
  const configEditedAt = editedAtOf(payload.configEditedAt)
  if (configEditedAt === null) {
    return reject('invalid_edited_at', 'Agent commands require a numeric configEditedAt stamp.')
  }
  return {
    ok: true,
    command: {
      type: 'workspace.update_agent',
      payload: {
        workspaceId,
        agentId,
        patch: payload.patch === null ? null : (clone(payload.patch) as Partial<AgentState>),
        configEditedAt,
      },
    },
  }
}

function validateRemove(payload: Record<string, unknown>): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  if (!workspaceId) return reject('invalid_workspace_id', 'Remove commands require a workspace id.')
  return { ok: true, command: { type: 'workspace.remove', payload: { workspaceId } } }
}

function validateAssignSession(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const agentId = normalizeId(payload.agentId)
  const sessionId = normalizeId(payload.sessionId)
  const cli = normalizeId(payload.cli)
  if (!workspaceId || !agentId || !sessionId || !cli) {
    return reject(
      'invalid_terminal_session_payload',
      'Terminal session commands require workspace, agent, session, and cli ids.',
    )
  }
  const ownership = validateSourceWindowOwnsWorkspace(state, sourceWindowId, workspaceId)
  if (!ownership.ok) return ownership
  return {
    ok: true,
    command: { type: 'agent_terminal.assign_session', payload: { workspaceId, agentId, sessionId, cli } },
  }
}

function validateLaunchState(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string,
): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const agentId = normalizeId(payload.agentId)
  if (!workspaceId || !agentId) {
    return reject('invalid_terminal_launch_payload', 'Terminal launch state commands require workspace and agent ids.')
  }
  const ownership = validateSourceWindowOwnsWorkspace(state, sourceWindowId, workspaceId)
  if (!ownership.ok) return ownership
  const commandPayload: Extract<WorkspaceSyncCommand, { type: 'agent_terminal.update_launch_state' }>['payload'] = {
    workspaceId,
    agentId,
  }
  if (payload.cliSessionId !== undefined) {
    if (payload.cliSessionId !== null && !normalizeId(payload.cliSessionId)) {
      return reject(
        'invalid_terminal_launch_payload',
        'Terminal launch state field "cliSessionId" must be a non-empty string or null when provided.',
      )
    }
    commandPayload.cliSessionId = payload.cliSessionId === null ? null : normalizeId(payload.cliSessionId)
  }
  for (const key of ['cliStartRequested', 'cliHasLaunched', 'cliOnboardingPromptSent', 'cliResumeAvailable'] as const) {
    if (payload[key] !== undefined) {
      if (typeof payload[key] !== 'boolean') {
        return reject(
          'invalid_terminal_launch_payload',
          `Terminal launch state field "${key}" must be boolean when provided.`,
        )
      }
      commandPayload[key] = payload[key]
    }
  }
  return { ok: true, command: { type: 'agent_terminal.update_launch_state', payload: commandPayload } }
}

function validateSourceWindowOwnsWorkspace(
  state: WorkspaceSyncState,
  sourceWindowId: string,
  workspaceId: string,
): ValidationResult {
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return reject('unknown_workspace', `Workspace "${workspaceId}" is not known to workspace sync.`)
  }
  const sourceWindow = state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
  if (!sourceWindow)
    return reject('unknown_source_window', `Source window "${sourceWindowId}" is not known to workspace sync.`)
  if (!sourceWindow.workspaceIds.includes(workspaceId)) {
    return reject(
      'workspace_not_in_source_window',
      `Workspace "${workspaceId}" is not assigned to source window "${sourceWindowId}".`,
    )
  }
  return {
    ok: true,
    command: { type: 'workspace_window.set_active', payload: { windowId: sourceWindowId, workspaceId } },
  }
}

// Most accepted events carry the validated command payload verbatim. The close
// event additionally records the workspace ids the fallback window inherits,
// computed from the closing window's current membership in the service snapshot
// (the same set the reducer routes to the fallback).
function eventPayloadForCommand(
  command: WorkspaceSyncCommand,
  state: WorkspaceSyncState,
  resolveResumeCapabilities: (cli: string) => { resumeSession: boolean; sessionIdFromCaller: boolean },
  now: () => number,
): unknown {
  if (command.type === 'workspace_window.close') {
    const closing = state.workspaceWindows.find((windowState) => windowState.id === command.payload.windowId)
    return {
      ...clone(command.payload),
      movedWorkspaceIds: closing ? [...closing.workspaceIds] : [],
    }
  }
  if (command.type === 'agent_terminal.assign_session') {
    // Resolve resume capabilities authoritatively from the registry and stamp
    // them onto the broadcast event, so every applier stores the value given
    // instead of re-deriving resume behavior from `cli`.
    const caps = resolveResumeCapabilities(command.payload.cli)
    return {
      ...clone(command.payload),
      cliResumeAvailable: caps.resumeSession,
      cliUsesStableSessionId: caps.sessionIdFromCaller,
    }
  }
  if (command.type === 'workspace.remove') {
    return { workspaceId: command.payload.workspaceId, removedAt: now() }
  }
  return clone(command.payload)
}

function eventTypeForCommand(command: WorkspaceSyncCommand): WorkspaceSyncEventType {
  switch (command.type) {
    case 'workspace_window.set_active':
      return 'workspace_window.active_changed'
    case 'workspace.move_to_window':
      return 'workspace.moved_to_window'
    case 'workspace_window.update_placement':
      return 'workspace_window.placement_updated'
    case 'workspace_window.close':
      return 'workspace_window.closed'
    case 'workspace.created':
      return 'workspace.created'
    case 'agent_terminal.assign_session':
      return 'agent_terminal.session_assigned'
    case 'agent_terminal.update_launch_state':
      return 'agent_terminal.launch_state_updated'
    case 'workspace.rename':
      return 'workspace.renamed'
    case 'workspace.update_layout':
      return 'workspace.layout_updated'
    case 'workspace.update_fields':
      return 'workspace.fields_updated'
    case 'workspace.update_agent':
      return 'workspace.agents_updated'
    case 'workspace.remove':
      return 'workspace.removed'
  }
}

function reject(reason: string, message: string): ValidationResult {
  return { ok: false, reason, message }
}

function editedAtOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.width) && isFiniteNumber(value.height)
  )
}

function clone<T>(value: T): T {
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value))
}
