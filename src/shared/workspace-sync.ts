import type {
  AgentCli,
  AgentId,
  AgentState,
  Workspace,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
} from '../renderer/src/types/workspace'
import { workspaceProjectRootOf } from './worktree-paths'

export type WindowPlacement = Pick<WorkspaceWindowState, 'bounds' | 'isMaximized' | 'displayId'>

export type WorkspaceSyncCommand =
  | {
      type: 'workspace_window.set_active'
      payload: { windowId: WorkspaceWindowId; workspaceId: WorkspaceId | null }
    }
  | {
      type: 'workspace.move_to_window'
      payload: {
        workspaceId: WorkspaceId
        fromWindowId: WorkspaceWindowId | null
        toWindowId: WorkspaceWindowId
        makeActive: boolean
      }
    }
  | {
      type: 'workspace_window.update_placement'
      payload: WindowPlacement & { windowId: WorkspaceWindowId }
    }
  | {
      type: 'workspace_window.close'
      payload: { windowId: WorkspaceWindowId; fallbackWindowId: WorkspaceWindowId }
    }
  | {
      type: 'workspace.created'
      payload: {
        workspace: Workspace
        windowId: WorkspaceWindowId
        insert: { kind: 'folder_head'; folderPath: string | null }
        /**
         * False when the workspace joins its window without being brought to
         * the front: a chat nobody asked to look at right now, like a
         * scheduled run. Absent, the new workspace becomes the active one, as
         * every create did before this field existed.
         */
        activate?: false
      }
    }
  | {
      type: 'agent_terminal.assign_session'
      payload: {
        workspaceId: WorkspaceId
        agentId: AgentId
        sessionId: string
        cli: AgentCli
      }
    }
  | {
      type: 'agent_terminal.update_launch_state'
      payload: {
        workspaceId: WorkspaceId
        agentId: AgentId
        cliSessionId?: string | null
        cliStartRequested?: boolean
        cliHasLaunched?: boolean
        cliOnboardingPromptSent?: boolean
        cliResumeAvailable?: boolean
      }
    }
  // Registry-domain edits. Main owns the record; a renderer applies
  // optimistically and asks, and main decides. One command per user-editable
  // fact, so two concurrent edits to different fields never contend — a rename
  // in one window and a layout drag in another both land.
  //
  // `editedAt` is stamped by the ORIGINATING window at the moment of the user
  // gesture, never on arrival in main: a stamp assigned on arrival would make
  // ordering depend on IPC latency, which is exactly the bug per-field
  // last-write-wins exists to prevent.
  | {
      type: 'workspace.rename'
      payload: { workspaceId: WorkspaceId; name: string; titleLocked?: boolean; editedAt: number }
    }
  | {
      type: 'workspace.update_layout'
      payload: { workspaceId: WorkspaceId; layoutModel: Workspace['layoutModel']; editedAt: number }
    }
  | {
      type: 'workspace.update_fields'
      payload: { workspaceId: WorkspaceId; patch: WorkspaceFieldsPatch; editedAt: number }
    }
  | {
      type: 'workspace.update_agent'
      payload: {
        workspaceId: WorkspaceId
        agentId: AgentId
        /** `null` removes the agent from the roster. */
        patch: Partial<AgentState> | null
        configEditedAt: number
      }
    }
  | {
      type: 'workspace.remove'
      payload: { workspaceId: WorkspaceId }
    }

/**
 * The activity clocks a record carries — the person's last keystroke, the
 * person's last submitted message, the agent's last turn end, and the last
 * time a person had the chat on screen — only ever move forward, and every
 * window learns them from the same sessions. So a patch may only ADVANCE
 * them: main's reducer and the renderer's inbound paths both keep the later
 * value, and an older reading from a lagging window can never roll a
 * persisted clock back.
 *
 * `lastVisitedAt` is written by every device that shows the chat — this
 * desktop's windows, a phone, another desktop — and a visit stamped on a
 * clock running slightly behind must not undo one stamped a moment earlier
 * somewhere else, so it is monotonic for the same reason the others are.
 * Mark unread is the one exception, and says so: it moves the visit clock
 * back together with a newer `visitRewoundAt`, itself monotonic, and only a
 * patch carrying one may lower it (`visitRewindApplies`).
 */
export const MONOTONIC_WORKSPACE_CLOCKS = [
  'lastTerminalActivityAt',
  'lastUserMessageAt',
  'lastTurnEndedAt',
  'lastVisitedAt',
  'visitRewoundAt',
] as const

/** True unless writing `value` into `key` would roll an activity clock back. */
export function workspaceFieldMayApply(record: Record<string, unknown>, key: string, value: unknown): boolean {
  if (!(MONOTONIC_WORKSPACE_CLOCKS as readonly string[]).includes(key)) return true
  const current = record[key]
  return typeof current !== 'number' || (typeof value === 'number' && value >= current)
}

const finiteClock = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Whether `incoming` moves the visit clock back on purpose: it carries a Mark
 * unread (`visitRewoundAt`) newer than the one `record` has seen, and a
 * `lastVisitedAt` that is a time, so that time is taken even when it is
 * earlier. Never a clear: a rewind with no time to go back to (null, NaN, a
 * string) rewinds nothing. The rewind is ordered by its own stamp, so a
 * lagging reading — of the clock before the rewind, or of an older rewind —
 * still cannot undo a later one. Only main's Mark unread writes the stamp
 * (`workspace-sync-service.ts`'s `rewindVisit`); no window's patch may carry it.
 */
export function visitRewindApplies(
  record: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): boolean {
  const rewoundAt = incoming['visitRewoundAt']
  if (!finiteClock(rewoundAt) || !finiteClock(incoming['lastVisitedAt'])) return false
  const current = record['visitRewoundAt']
  return typeof current !== 'number' || rewoundAt > current
}

/**
 * Apply a field patch in place. The one implementation of the patch contract
 * — absent key = no opinion, explicit null = cleared, a clock only advances,
 * the visit clock goes back only by Mark unread — shared by main's reducer and
 * the renderer's inbound path, so the two can never disagree about what a
 * patch did.
 */
export function applyWorkspaceFieldsPatch(record: Record<string, unknown>, patch: WorkspaceFieldsPatch): void {
  const rewinds = visitRewindApplies(record, patch)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (!(rewinds && key === 'lastVisitedAt') && !workspaceFieldMayApply(record, key, value)) continue
    record[key] = value
  }
}

/**
 * Mark unread's answer (`conversation.mark_unread`, and a window's row menu):
 * the visit clock as it now stands, or why nothing was marked.
 */
export type WorkspaceMarkUnreadResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | { ok: false; code: string; message: string }

/**
 * The registry fields a user edits through `workspace.update_fields`. An absent
 * key means "this window has no opinion" and never clears main's copy; an
 * explicit `null` is a tombstone meaning "the user cleared this".
 */
export type WorkspaceFieldsPatch = {
  folderPath?: string | null
  folderMissing?: boolean
  memory?: Workspace['memory']
  settledAt?: number | null
  settledOverride?: Workspace['settledOverride']
  autoSettleEnabled?: boolean | null
  autoCompactEnabled?: boolean | null
  snoozedUntil?: number | null
  highlight?: Workspace['highlight'] | null
  worktree?: Workspace['worktree']
  lastTerminalActivityAt?: number | null
  lastUserMessageAt?: number | null
  lastTurnEndedAt?: number | null
  lastVisitedAt?: number | null
  /**
   * Mark unread: written with the `lastVisitedAt` it lowers
   * (`visitRewindApplies`), and only by main's own command for it; a window's
   * `workspace.update_fields` carrying it is refused.
   */
  visitRewoundAt?: number
}

export type WorkspaceSyncEventType =
  | 'workspace_window.active_changed'
  | 'workspace.moved_to_window'
  | 'workspace_window.placement_updated'
  | 'workspace_window.closed'
  | 'workspace.created'
  | 'agent_terminal.session_assigned'
  | 'agent_terminal.launch_state_updated'
  | 'workspace.renamed'
  | 'workspace.layout_updated'
  | 'workspace.fields_updated'
  | 'workspace.agents_updated'
  | 'workspace.removed'

// The closed event extends the close command payload with the ids the service
// actually routed to the fallback window. The source renderer already knows the
// closing window's membership, but receiving renderers do not necessarily have
// the closing window's full record, so the moved ids travel with the event.
type WorkspaceWindowClosedEventPayload = Extract<
  WorkspaceSyncCommand,
  { type: 'workspace_window.close' }
>['payload'] & { movedWorkspaceIds: WorkspaceId[] }

// The broadcast session_assigned event extends the command with resume
// capabilities the main process resolves from the plugin registry (the
// authoritative manifest source). The applier stores these instead of
// re-deriving resume behavior from `cli`, so a new CLI resumes purely by
// declaring its manifest capabilities. See agent-cli-resume.ts.
type AgentTerminalSessionAssignedEventPayload = Extract<
  WorkspaceSyncCommand,
  { type: 'agent_terminal.assign_session' }
>['payload'] & { cliResumeAvailable: boolean; cliUsesStableSessionId: boolean }

export type WorkspaceSyncEvent =
  | WorkspaceSyncBaseEvent<
      'workspace_window.active_changed',
      Extract<WorkspaceSyncCommand, { type: 'workspace_window.set_active' }>['payload']
    >
  | WorkspaceSyncBaseEvent<
      'workspace.moved_to_window',
      Extract<WorkspaceSyncCommand, { type: 'workspace.move_to_window' }>['payload']
    >
  | WorkspaceSyncBaseEvent<
      'workspace_window.placement_updated',
      Extract<WorkspaceSyncCommand, { type: 'workspace_window.update_placement' }>['payload']
    >
  | WorkspaceSyncBaseEvent<'workspace_window.closed', WorkspaceWindowClosedEventPayload>
  | WorkspaceSyncBaseEvent<'workspace.created', Extract<WorkspaceSyncCommand, { type: 'workspace.created' }>['payload']>
  | WorkspaceSyncBaseEvent<'agent_terminal.session_assigned', AgentTerminalSessionAssignedEventPayload>
  | WorkspaceSyncBaseEvent<
      'agent_terminal.launch_state_updated',
      Extract<WorkspaceSyncCommand, { type: 'agent_terminal.update_launch_state' }>['payload']
    >
  | WorkspaceSyncBaseEvent<'workspace.renamed', Extract<WorkspaceSyncCommand, { type: 'workspace.rename' }>['payload']>
  | WorkspaceSyncBaseEvent<
      'workspace.layout_updated',
      Extract<WorkspaceSyncCommand, { type: 'workspace.update_layout' }>['payload']
    >
  | WorkspaceSyncBaseEvent<
      'workspace.fields_updated',
      Extract<WorkspaceSyncCommand, { type: 'workspace.update_fields' }>['payload']
    >
  | WorkspaceSyncBaseEvent<
      'workspace.agents_updated',
      Extract<WorkspaceSyncCommand, { type: 'workspace.update_agent' }>['payload']
    >
  | WorkspaceSyncBaseEvent<'workspace.removed', { workspaceId: WorkspaceId; removedAt: number }>

type WorkspaceSyncBaseEvent<Type extends WorkspaceSyncEventType, Payload> = {
  id: string
  type: Type
  sourceWindowId: WorkspaceWindowId
  sequence: number
  createdAt: number
  payload: Payload
}

export type WorkspaceSyncState = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  lastAppliedWorkspaceSyncSequence: number
}

export type WorkspaceSyncSnapshot = {
  sequence: number
  state: Omit<WorkspaceSyncState, 'lastAppliedWorkspaceSyncSequence'>
}

export type WorkspaceSyncCommandResult =
  | { ok: true; event: WorkspaceSyncEvent; snapshot?: WorkspaceSyncSnapshot }
  | { ok: false; reason: string; message: string; snapshot?: WorkspaceSyncSnapshot }

export type WorkspaceSyncApplyResult =
  | { status: 'applied'; state: WorkspaceSyncState; event: WorkspaceSyncEvent }
  | { status: 'ignored'; state: WorkspaceSyncState; event: WorkspaceSyncEvent; reason: 'duplicate_or_stale' }
  | {
      status: 'sequence_gap'
      state: WorkspaceSyncState
      event: WorkspaceSyncEvent
      expectedSequence: number
      receivedSequence: number
    }

export function applyWorkspaceSyncEvent(
  state: WorkspaceSyncState,
  event: WorkspaceSyncEvent,
): WorkspaceSyncApplyResult {
  const expectedSequence = state.lastAppliedWorkspaceSyncSequence + 1
  if (event.sequence <= state.lastAppliedWorkspaceSyncSequence) {
    return { status: 'ignored', state, event, reason: 'duplicate_or_stale' }
  }
  if (event.sequence !== expectedSequence) {
    return {
      status: 'sequence_gap',
      state,
      event,
      expectedSequence,
      receivedSequence: event.sequence,
    }
  }

  const next = cloneSyncState(state)
  applyWorkspaceSyncEventInPlace(next, event)
  next.lastAppliedWorkspaceSyncSequence = event.sequence
  return { status: 'applied', state: next, event }
}

export function applyWorkspaceSyncSnapshot(
  state: WorkspaceSyncState,
  snapshot: WorkspaceSyncSnapshot,
): WorkspaceSyncState {
  if (snapshot.sequence <= state.lastAppliedWorkspaceSyncSequence) return state
  return {
    ...cloneSyncState({
      ...snapshot.state,
      lastAppliedWorkspaceSyncSequence: snapshot.sequence,
    }),
  }
}

function applyWorkspaceSyncEventInPlace(state: WorkspaceSyncState, event: WorkspaceSyncEvent): void {
  switch (event.type) {
    case 'workspace_window.active_changed':
      setActiveWorkspaceForWindow(state, event.payload.windowId, event.payload.workspaceId, event.createdAt)
      break
    case 'workspace.moved_to_window':
      moveWorkspaceToWindow(state, event.payload, event.createdAt)
      break
    case 'workspace_window.placement_updated':
      updateWorkspaceWindowPlacement(state, event.payload, event.createdAt)
      break
    case 'workspace_window.closed':
      closeWorkspaceWindow(state, event.payload.windowId, event.payload.fallbackWindowId, event.createdAt)
      break
    case 'workspace.created':
      addCreatedWorkspace(
        state,
        event.payload.workspace,
        event.payload.windowId,
        event.payload.insert.folderPath,
        event.createdAt,
        event.payload.activate !== false,
      )
      break
    case 'agent_terminal.session_assigned':
      assignAgentTerminalSession(state, event.payload)
      break
    case 'agent_terminal.launch_state_updated':
      updateAgentTerminalLaunchState(state, event.payload)
      break
    case 'workspace.renamed':
      applyWorkspaceRename(state, event.payload)
      break
    case 'workspace.layout_updated':
      applyWorkspaceLayout(state, event.payload)
      break
    case 'workspace.fields_updated':
      applyWorkspaceFields(state, event.payload)
      break
    case 'workspace.agents_updated':
      applyWorkspaceAgentPatch(state, event.payload)
      break
    case 'workspace.removed':
      removeWorkspaceFromState(state, event.payload.workspaceId, event.createdAt)
      break
  }
}

function findWorkspace(state: WorkspaceSyncState, workspaceId: WorkspaceId): Workspace | undefined {
  return state.workspaces.find((candidate) => candidate.id === workspaceId)
}

function applyWorkspaceRename(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'workspace.rename' }>['payload'],
): void {
  const workspace = findWorkspace(state, payload.workspaceId)
  if (!workspace) return
  workspace.name = payload.name
  // `titleLocked` travels with the winning name: the lock is what makes the name
  // stop moving, so a rename that landed without it would let the next prompt
  // auto-title over the user's choice.
  if (payload.titleLocked !== undefined) workspace.titleLocked = payload.titleLocked
}

function applyWorkspaceLayout(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'workspace.update_layout' }>['payload'],
): void {
  const workspace = findWorkspace(state, payload.workspaceId)
  if (!workspace) return
  workspace.layoutModel = payload.layoutModel
}

function applyWorkspaceFields(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'workspace.update_fields' }>['payload'],
): void {
  const workspace = findWorkspace(state, payload.workspaceId)
  if (!workspace) return
  applyWorkspaceFieldsPatch(workspace as Record<string, unknown>, payload.patch)
}

function applyWorkspaceAgentPatch(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'workspace.update_agent' }>['payload'],
): void {
  const workspace = findWorkspace(state, payload.workspaceId)
  if (!workspace) return
  if (payload.patch === null) {
    const { [payload.agentId]: _removed, ...rest } = workspace.agents
    workspace.agents = rest
    return
  }
  const agent = findOrCreateAgent(state, payload.workspaceId, payload.agentId)
  if (!agent) return
  Object.assign(agent, payload.patch, { configEditedAt: payload.configEditedAt })
}

function removeWorkspaceFromState(state: WorkspaceSyncState, workspaceId: WorkspaceId, timestamp: number): void {
  state.workspaces = state.workspaces.filter((candidate) => candidate.id !== workspaceId)
  for (const windowState of state.workspaceWindows) {
    windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspaceId)
    if (windowState.activeWorkspaceId === workspaceId) {
      windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
    }
  }
  if (state.activeWorkspaceId === workspaceId) {
    state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
  }
  normalizeWorkspaceAssignments(state, timestamp)
}

function cloneSyncState(state: WorkspaceSyncState): WorkspaceSyncState {
  return {
    ...state,
    workspaces: state.workspaces.map(cloneWorkspace),
    workspaceWindows: state.workspaceWindows.map((windowState) => ({
      ...windowState,
      workspaceIds: [...windowState.workspaceIds],
      bounds: windowState.bounds ? { ...windowState.bounds } : null,
    })),
  }
}

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    agents: Object.fromEntries(Object.entries(workspace.agents).map(([agentId, agent]) => [agentId, { ...agent }])),
  }
}

function ensureWorkspaceWindow(
  state: WorkspaceSyncState,
  windowId: WorkspaceWindowId,
  kind: WorkspaceWindowState['kind'] = windowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
  timestamp = 0,
): WorkspaceWindowState {
  const existing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
  if (existing) return existing

  const windowState: WorkspaceWindowState = {
    id: windowId,
    kind,
    workspaceIds: [],
    activeWorkspaceId: null,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: timestamp,
    lastFocusedAt: timestamp,
  }
  state.workspaceWindows.push(windowState)
  return windowState
}

function workspaceFolderKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : null
}

function normalizeWorkspaceAssignments(state: WorkspaceSyncState, timestamp: number): void {
  const validWorkspaceIds = new Set(state.workspaces.map((workspace) => workspace.id))
  const assignedWorkspaceIds = new Set<WorkspaceId>()
  const primaryWindow = ensureWorkspaceWindow(state, state.primaryWorkspaceWindowId, 'primary', timestamp)
  primaryWindow.kind = 'primary'

  for (const windowState of state.workspaceWindows) {
    const nextWorkspaceIds: WorkspaceId[] = []
    for (const workspaceId of windowState.workspaceIds) {
      if (!validWorkspaceIds.has(workspaceId) || assignedWorkspaceIds.has(workspaceId)) continue
      nextWorkspaceIds.push(workspaceId)
      assignedWorkspaceIds.add(workspaceId)
    }
    windowState.workspaceIds = nextWorkspaceIds
    if (windowState.activeWorkspaceId && !nextWorkspaceIds.includes(windowState.activeWorkspaceId)) {
      windowState.activeWorkspaceId = nextWorkspaceIds[0] ?? null
    }
  }

  for (const workspace of state.workspaces) {
    if (assignedWorkspaceIds.has(workspace.id)) continue
    primaryWindow.workspaceIds.push(workspace.id)
    assignedWorkspaceIds.add(workspace.id)
  }
  if (primaryWindow.activeWorkspaceId && !primaryWindow.workspaceIds.includes(primaryWindow.activeWorkspaceId)) {
    primaryWindow.activeWorkspaceId = primaryWindow.workspaceIds[0] ?? null
  }
  state.workspaceWindows = state.workspaceWindows.filter(
    (windowState) => windowState.kind === 'primary' || windowState.workspaceIds.length > 0,
  )
}

function setActiveWorkspaceForWindow(
  state: WorkspaceSyncState,
  windowId: WorkspaceWindowId,
  workspaceId: WorkspaceId | null,
  timestamp: number,
): void {
  const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
  if (!windowState) return
  if (workspaceId !== null && !windowState.workspaceIds.includes(workspaceId)) return
  windowState.activeWorkspaceId = workspaceId
  windowState.lastFocusedAt = timestamp
  if (workspaceId) state.activeWorkspaceId = workspaceId
}

function moveWorkspaceToWindow(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'workspace.move_to_window' }>['payload'],
  timestamp: number,
): void {
  if (!state.workspaces.some((workspace) => workspace.id === payload.workspaceId)) return
  const target = ensureWorkspaceWindow(
    state,
    payload.toWindowId,
    payload.toWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
    timestamp,
  )
  for (const windowState of state.workspaceWindows) {
    if (windowState.id === payload.toWindowId) continue
    windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== payload.workspaceId)
    if (windowState.activeWorkspaceId === payload.workspaceId) {
      windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
    }
  }
  target.workspaceIds = [
    ...target.workspaceIds.filter((workspaceId) => workspaceId !== payload.workspaceId),
    payload.workspaceId,
  ]
  if (payload.makeActive) {
    target.activeWorkspaceId = payload.workspaceId
    target.lastFocusedAt = timestamp
    state.activeWorkspaceId = payload.workspaceId
  } else if (!target.activeWorkspaceId) {
    target.activeWorkspaceId = target.workspaceIds[0] ?? null
  }
  if (payload.fromWindowId && payload.fromWindowId !== payload.toWindowId) {
    const source = state.workspaceWindows.find((windowState) => windowState.id === payload.fromWindowId)
    if (source?.activeWorkspaceId === payload.workspaceId) {
      source.activeWorkspaceId = source.workspaceIds[0] ?? null
    }
  }
  normalizeWorkspaceAssignments(state, timestamp)
}

function updateWorkspaceWindowPlacement(
  state: WorkspaceSyncState,
  placement: Extract<WorkspaceSyncCommand, { type: 'workspace_window.update_placement' }>['payload'],
  timestamp: number,
): void {
  const windowState = ensureWorkspaceWindow(state, placement.windowId, undefined, timestamp)
  windowState.bounds = placement.bounds ? { ...placement.bounds } : null
  windowState.isMaximized = placement.isMaximized === true
  windowState.displayId = typeof placement.displayId === 'number' ? placement.displayId : null
  windowState.lastFocusedAt = timestamp
}

function closeWorkspaceWindow(
  state: WorkspaceSyncState,
  windowId: WorkspaceWindowId,
  fallbackWindowId: WorkspaceWindowId,
  timestamp: number,
): void {
  if (windowId === state.primaryWorkspaceWindowId) return
  const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
  if (!closing) return
  const fallback = ensureWorkspaceWindow(
    state,
    fallbackWindowId,
    fallbackWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
    timestamp,
  )
  for (const workspaceId of closing.workspaceIds) {
    if (!fallback.workspaceIds.includes(workspaceId)) fallback.workspaceIds.push(workspaceId)
  }
  fallback.activeWorkspaceId =
    closing.activeWorkspaceId && fallback.workspaceIds.includes(closing.activeWorkspaceId)
      ? closing.activeWorkspaceId
      : (fallback.workspaceIds[0] ?? null)
  state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
  if (fallback.activeWorkspaceId) state.activeWorkspaceId = fallback.activeWorkspaceId
  normalizeWorkspaceAssignments(state, timestamp)
}

function addCreatedWorkspace(
  state: WorkspaceSyncState,
  workspace: Workspace,
  windowId: WorkspaceWindowId,
  folderPath: string | null,
  timestamp: number,
  activate: boolean,
): void {
  state.workspaces = state.workspaces.filter((candidate) => candidate.id !== workspace.id)
  // The block is the workspace's PROJECT, not its own folder: a worktree chat's
  // `folderPath` is the worktree, so keying on it would unshift the chat to the
  // registry head and, after a restart, yank its parent's whole group to the top
  // of the sidebar. `folderPath` stays the event's payload for compatibility;
  // the record itself carries the marker this reads.
  const insertFolderKey = workspaceFolderKey(workspaceProjectRootOf(workspace) ?? folderPath)
  const blockStart = state.workspaces.findIndex(
    (candidate) => workspaceFolderKey(workspaceProjectRootOf(candidate)) === insertFolderKey,
  )
  if (blockStart === -1) {
    state.workspaces.unshift(cloneWorkspace(workspace))
  } else {
    state.workspaces.splice(blockStart, 0, cloneWorkspace(workspace))
  }
  for (const windowState of state.workspaceWindows) {
    windowState.workspaceIds = windowState.workspaceIds.filter((workspaceId) => workspaceId !== workspace.id)
  }
  const target = ensureWorkspaceWindow(state, windowId, undefined, timestamp)
  target.workspaceIds = [workspace.id, ...target.workspaceIds]
  // A workspace created in the background joins the window's list and leaves
  // what the person is looking at alone.
  if (!activate) {
    normalizeWorkspaceAssignments(state, timestamp)
    return
  }
  target.activeWorkspaceId = workspace.id
  target.lastFocusedAt = timestamp
  state.activeWorkspaceId = workspace.id
  normalizeWorkspaceAssignments(state, timestamp)
}

function assignAgentTerminalSession(
  state: WorkspaceSyncState,
  payload: AgentTerminalSessionAssignedEventPayload,
): void {
  const agent = findOrCreateAgent(state, payload.workspaceId, payload.agentId)
  if (!agent) return
  agent.cliSessionId = payload.sessionId
  agent.cli = payload.cli
  agent.cliStartRequested = true
  agent.cliHasLaunched = true
  agent.cliResumeAvailable = payload.cliResumeAvailable
  agent.cliUsesStableSessionId = payload.cliUsesStableSessionId
}

function updateAgentTerminalLaunchState(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'agent_terminal.update_launch_state' }>['payload'],
): void {
  const agent = findOrCreateAgent(state, payload.workspaceId, payload.agentId)
  if (!agent) return
  if (payload.cliSessionId !== undefined) agent.cliSessionId = payload.cliSessionId ?? undefined
  if (payload.cliStartRequested !== undefined) agent.cliStartRequested = payload.cliStartRequested
  if (payload.cliHasLaunched !== undefined) agent.cliHasLaunched = payload.cliHasLaunched
  if (payload.cliOnboardingPromptSent !== undefined) {
    agent.cliOnboardingPromptSent = payload.cliOnboardingPromptSent
  }
  if (payload.cliResumeAvailable !== undefined) agent.cliResumeAvailable = payload.cliResumeAvailable
}

function findOrCreateAgent(state: WorkspaceSyncState, workspaceId: WorkspaceId, agentId: AgentId): AgentState | null {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return null
  if (!workspace.agents[agentId]) {
    workspace.agents[agentId] = {
      id: agentId,
      name: agentId,
      status: 'idle',
      execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
      messages: [],
      streamBuffer: '',
      // Sync-created agent skeletons exist for terminal launch/session events;
      // the conversation runtime is opted into explicitly elsewhere.
      runtimeKind: 'terminal',
    }
  }
  return workspace.agents[agentId]
}
