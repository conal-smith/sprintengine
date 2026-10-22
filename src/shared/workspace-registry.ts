/**
 * The workspace registry main owns.
 *
 * Before this, the registry lived in the renderer's zustand store (localStorage)
 * and main held an explicitly non-authoritative mirror: restart survivors came
 * back as routing placeholders whose mode/agents/layout were unknown, so
 * `workspace.create` had to round-trip through a window and gateway tools
 * refused workspaces with no live terminal. Main now owns the durable record —
 * identity, name, folder, mode, agent roster, and layout — persisted under
 * userData, and every renderer store is a subscriber mirror.
 *
 * This module is the pure half: record shapes, the revision math, per-field
 * last-write-wins, tombstones, reuse resolution, and the file parse/serialize
 * round-trip. No fs, no electron, no `window` — `src/main/workspace-registry-store.ts`
 * holds the fs/clock seam and `src/main/workspace-registry-service.ts` the
 * authority that mutates through it.
 *
 * The record shape derives from `normalizeWorkspaceForPartialize`
 * (`src/renderer/src/store/slices/normalizers.ts`), which is the authoritative
 * statement of what survives a restart today — it is not invented here.
 */
import { isDefaultWorkspaceName } from './workspace-title'
import { isRecord } from './records'
import { isRetiredWorkspaceMode } from './workspace-mode'
import type {
  AgentState,
  Workspace,
  WorkspaceId,
  WorkspaceRegistryEmptyState,
  WorkspaceWindowId,
  WorkspaceWindowState,
} from '../renderer/src/types/workspace'

export const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1

/**
 * Names the process boundary a write came through, never the human — the same
 * rule `AgentLaunchSettingsActor` follows.
 */
export type WorkspaceRegistryActor = 'ui' | 'gateway' | 'automation' | 'module' | 'mobile' | 'system'

/**
 * Per-field last-write-wins stamps for the fields a *user* edits. Each is the
 * `editedAt` of the accepted write; an incoming command older than the stamp is
 * dropped and the current value re-broadcast so the lagging window converges.
 *
 * This generalizes a per-field edit stamp rather than inventing a second
 * mechanism — per-agent edits keep using `AgentState.configEditedAt` itself.
 *
 * Fields written by main's own subsystems (session assignment, launch flags)
 * are deliberately absent: they are not LWW and carry no stamp.
 */
export type WorkspaceRegistryFieldStamps = {
  name: number
  layoutModel: number
  folderPath: number
  memory: number
  settledAt: number
  settledOverride: number
  autoSettleEnabled: number
  autoCompactEnabled: number
  snoozedUntil: number
}

const WORKSPACE_REGISTRY_STAMPED_FIELDS = [
  'name',
  'layoutModel',
  'folderPath',
  'memory',
  'settledAt',
  'settledOverride',
  'autoSettleEnabled',
  'autoCompactEnabled',
  'snoozedUntil',
] as const

export type WorkspaceRegistryStampedField = (typeof WORKSPACE_REGISTRY_STAMPED_FIELDS)[number]

/**
 * A durable workspace record. Structurally a `Workspace` so every existing
 * reader of main's workspace list (`workspace-roots`, the gateway projections,
 * the agent-launch service, module views) keeps working unchanged — the
 * renderer-owned view fields are stripped to their defaults on write rather
 * than removed from the type.
 */
export type WorkspaceRegistryRecord = Workspace & {
  /** Revision of the last accepted write to THIS record. */
  revision: number
  fieldEditedAt: WorkspaceRegistryFieldStamps
}

/**
 * An id removed recently. A lagging window's optimistic edit against a deleted
 * workspace is rejected against this list rather than resurrecting the record.
 */
export type WorkspaceRegistryTombstone = {
  id: WorkspaceId
  removedAt: number
  revision: number
}

export type WorkspaceRegistryFile = {
  schemaVersion: typeof WORKSPACE_REGISTRY_SCHEMA_VERSION
  /**
   * Monotonic write counter, bumped once per accepted mutation. Broadcasts
   * carry it; a mirror ignores anything at or below the revision it already
   * applied, so a slow echo can never re-assert a stale value.
   */
  revision: number
  changedAt: number
  lastWrite: { actor: WorkspaceRegistryActor; at: string }
  workspaces: WorkspaceRegistryRecord[]
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  activeWorkspaceId: WorkspaceId | null
  /**
   * The explicit "the user really did remove everything" record. Absent with an
   * empty `workspaces` array is a fault, never an intent — see
   * {@link classifyPersistedWorkspaceState}.
   */
  registryEmptyState: WorkspaceRegistryEmptyState | null
  tombstones: WorkspaceRegistryTombstone[]
}

/** Tombstones are pruned past whichever of these bounds comes first. */
export const WORKSPACE_REGISTRY_TOMBSTONE_LIMIT = 200
export const WORKSPACE_REGISTRY_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

const DEFAULT_PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'

export function emptyWorkspaceRegistryFieldStamps(): WorkspaceRegistryFieldStamps {
  return {
    name: 0,
    layoutModel: 0,
    folderPath: 0,
    memory: 0,
    settledAt: 0,
    settledOverride: 0,
    autoSettleEnabled: 0,
    autoCompactEnabled: 0,
    snoozedUntil: 0,
  }
}

export function emptyWorkspaceRegistryFile(now = 0): WorkspaceRegistryFile {
  return {
    schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    changedAt: now,
    lastWrite: { actor: 'system', at: new Date(now).toISOString() },
    workspaces: [],
    workspaceWindows: [
      {
        id: DEFAULT_PRIMARY_WORKSPACE_WINDOW_ID,
        kind: 'primary',
        workspaceIds: [],
        activeWorkspaceId: null,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: now,
        lastFocusedAt: now,
      },
    ],
    primaryWorkspaceWindowId: DEFAULT_PRIMARY_WORKSPACE_WINDOW_ID,
    activeWorkspaceId: null,
    registryEmptyState: null,
    tombstones: [],
  }
}

// ---------------------------------------------------------------------------
// Durability normalization
// ---------------------------------------------------------------------------

/**
 * Strip an agent down to what survives a restart, mirroring
 * `normalizeWorkspaceForPartialize` (`normalizers.ts`) field for field.
 *
 * Durable resume identity stays: `cliSessionId` keys the painted screen on disk
 * and `cliResumeAvailable`/`cliHasLaunched` are what `claude --resume` and
 * `codex resume` read after a restart. Only transient output and one-shot
 * restart state are dropped.
 */
function normalizeWorkspaceRegistryAgent(agent: AgentState): AgentState {
  return {
    ...agent,
    status: 'idle',
    streamBuffer: '',
    cliRestartNonce: 0,
    cliStartupPrompt: undefined,
  }
}

/**
 * Strip a workspace to the durable domain state main owns. The renderer keeps
 * per-window presentation (editor/file-explorer/backlog/git-panel view state)
 * in localStorage keyed by workspace id — two disjoint field sets, not two
 * copies of one fact, so this is not dual authority.
 *
 * A module's own `moduleState` bag travels as-is: the module that wrote it is
 * the only thing that can say what part of it is durable.
 */
export function normalizeWorkspaceForRegistry(workspace: Workspace): Workspace {
  const moduleState = isRecord(workspace.moduleState) ? workspace.moduleState : undefined
  const normalized: Workspace = {
    ...workspace,
    agents: Object.fromEntries(
      Object.entries(workspace.agents ?? {}).map(([id, agent]) => [id, normalizeWorkspaceRegistryAgent(agent)]),
    ),
    editorState: { openFiles: [], activeFilePath: null },
    fileExplorerState: undefined,
    backlogState: undefined,
    gitPanelState: undefined,
    ...(moduleState && Object.keys(moduleState).length > 0 ? { moduleState } : { moduleState: undefined }),
  }
  return normalized
}

export function toWorkspaceRegistryRecord(
  workspace: Workspace,
  revision: number,
  fieldEditedAt: WorkspaceRegistryFieldStamps = emptyWorkspaceRegistryFieldStamps(),
): WorkspaceRegistryRecord {
  return {
    ...normalizeWorkspaceForRegistry(workspace),
    revision,
    fieldEditedAt: { ...fieldEditedAt },
  }
}

// ---------------------------------------------------------------------------
// Revision math
// ---------------------------------------------------------------------------

/**
 * Content equality for the persisted registry, ignoring the write metadata a
 * bump would change. A content-identical write is a no-op: no revision bump, no
 * write, no subscriber wake — the same rule the launch-settings mirror applies.
 */
export function workspaceRegistryContentEqual(left: WorkspaceRegistryFile, right: WorkspaceRegistryFile): boolean {
  return serializeWorkspaceRegistryContent(left) === serializeWorkspaceRegistryContent(right)
}

/**
 * The comparison key behind `workspaceRegistryContentEqual`. Exposed so the
 * store can keep the key of what it last wrote and stringify only the new side
 * of each commit: a large profile's registry is a megabyte or more, and the
 * authority persists after every accepted mutation.
 */
export function serializeWorkspaceRegistryContent(file: WorkspaceRegistryFile): string {
  return JSON.stringify({
    workspaces: file.workspaces.map(({ revision: _revision, ...record }) => record),
    workspaceWindows: file.workspaceWindows,
    primaryWorkspaceWindowId: file.primaryWorkspaceWindowId,
    activeWorkspaceId: file.activeWorkspaceId,
    registryEmptyState: file.registryEmptyState,
    tombstones: file.tombstones,
  })
}

export function serializeWorkspaceRegistryFile(file: WorkspaceRegistryFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type WorkspaceRegistryParseResult = {
  file: WorkspaceRegistryFile
  /** Records dropped by per-record validation, with the field that failed. */
  droppedRecords: { id: string; reason: string }[]
  /**
   * Records dropped because their mode is retired (`RETIRED_WORKSPACE_MODES`).
   * Kept apart from `droppedRecords`: they are not malformed, just rows no
   * build can render any more, and a profile can carry a hundred of them.
   */
  retiredRecordIds: string[]
}

/**
 * Parse a persisted registry file. Returns null when the payload is not a
 * well-formed current-schema record — an unknown `schemaVersion` included, so a
 * file written by a newer build is never half-read as if it were this one. A
 * null result means "no authoritative record yet"; the caller falls through the
 * recovery order (backup → frozen legacy key → loud empty).
 *
 * Individual malformed records are dropped rather than failing the whole file:
 * losing one bad row is recoverable, losing every workspace is not.
 */
export function parseWorkspaceRegistryFile(raw: unknown): WorkspaceRegistryParseResult | null {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== WORKSPACE_REGISTRY_SCHEMA_VERSION) return null
  const revision = raw.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null
  if (!Array.isArray(raw.workspaces)) return null

  const droppedRecords: { id: string; reason: string }[] = []
  const retiredRecordIds: string[] = []
  const workspaces: WorkspaceRegistryRecord[] = []
  for (const [index, candidate] of raw.workspaces.entries()) {
    // A row whose mode was retired is filtered, not migrated: nothing registers
    // its type, so it would surface as an uninstalled-type placeholder whose
    // old roster could still be launched. Dropping it here keeps it out of
    // every consumer of main's registry, and the next write persists without it.
    if (isRecord(candidate) && typeof candidate.id === 'string' && isRetiredWorkspaceMode(candidate.mode)) {
      retiredRecordIds.push(candidate.id)
      continue
    }
    const parsed = parseWorkspaceRegistryRecord(candidate)
    if ('reason' in parsed) {
      droppedRecords.push({
        id: isRecord(candidate) && typeof candidate.id === 'string' ? candidate.id : `#${index}`,
        reason: parsed.reason,
      })
      continue
    }
    workspaces.push(parsed.record)
  }

  const primaryWorkspaceWindowId = normalizeId(raw.primaryWorkspaceWindowId) || DEFAULT_PRIMARY_WORKSPACE_WINDOW_ID
  const retired = new Set(retiredRecordIds)
  const withoutRetired = (workspaceId: string | null): string | null =>
    workspaceId && retired.has(workspaceId) ? null : workspaceId
  const rawActiveWorkspaceId = normalizeId(raw.activeWorkspaceId) || null
  const rawWrite = isRecord(raw.lastWrite) ? raw.lastWrite : null
  const file: WorkspaceRegistryFile = {
    schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
    revision,
    changedAt: typeof raw.changedAt === 'number' && Number.isFinite(raw.changedAt) ? raw.changedAt : 0,
    lastWrite: {
      actor: isRegistryActor(rawWrite?.actor) ? rawWrite.actor : 'system',
      at: typeof rawWrite?.at === 'string' ? rawWrite.at : '',
    },
    workspaces,
    workspaceWindows: Array.isArray(raw.workspaceWindows)
      ? raw.workspaceWindows.filter(isWorkspaceWindowState).map((windowState) =>
          retired.size === 0
            ? windowState
            : {
                ...windowState,
                workspaceIds: windowState.workspaceIds.filter((workspaceId) => !retired.has(workspaceId)),
                activeWorkspaceId: withoutRetired(windowState.activeWorkspaceId),
              },
        )
      : [],
    primaryWorkspaceWindowId,
    activeWorkspaceId: withoutRetired(rawActiveWorkspaceId),
    registryEmptyState: isRegistryEmptyState(raw.registryEmptyState) ? raw.registryEmptyState : null,
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.filter(isTombstone).map((entry) => ({ ...entry })) : [],
  }
  return { file, droppedRecords, retiredRecordIds }
}

type RecordParse = { record: WorkspaceRegistryRecord } | { reason: string }

/**
 * Per-record validation. A record is kept only when it carries the identity and
 * shape every reader depends on: an id, a name, a mode, a template, a layout,
 * and an agent map. A half-formed record is dropped with the failing field
 * named — passing one through would surface a workspace the app cannot render.
 */
export function parseWorkspaceRegistryRecord(raw: unknown): RecordParse {
  if (!isRecord(raw)) return { reason: 'not_an_object' }
  if (!normalizeId(raw.id)) return { reason: 'id' }
  if (typeof raw.name !== 'string') return { reason: 'name' }
  if (typeof raw.mode !== 'string' || !raw.mode) return { reason: 'mode' }
  if (typeof raw.templateId !== 'string' || !raw.templateId) return { reason: 'templateId' }
  if (!isRecord(raw.layoutModel)) return { reason: 'layoutModel' }
  if (!isRecord(raw.agents)) return { reason: 'agents' }
  if (raw.folderPath !== null && typeof raw.folderPath !== 'string') return { reason: 'folderPath' }

  const revision =
    typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
  const record: WorkspaceRegistryRecord = {
    ...(raw as unknown as Workspace),
    revision,
    fieldEditedAt: normalizeFieldStamps(raw.fieldEditedAt),
  }
  // Heal a lock that contradicts the name. Between 2026-07-29 and 2026-09-01 the
  // creation paths locked every New chat at birth (an equality test against the
  // wrong ordinal), so on disk "Chat 63" sits with `titleLocked: true` and the
  // first prompt can never name it. A default-shaped name has nothing worth
  // protecting, so the lock is dropped on read; the auto-title re-locks it with
  // a real name, which is the state the record should have reached.
  if (record.titleLocked && isDefaultWorkspaceName(record.name)) delete record.titleLocked
  // Heal the retired archive stamp into the settle stamp (settled-chats,
  // 2026-09-07). The startup archive sweep hid rows it stamped `archivedAt`
  // with nothing to list or restore them; a chat at rest is now `settledAt`,
  // shown in its folder's Settled shelf. Same no-migration idiom as the lock
  // above: the record reads as it should have been written, its old
  // last-write-wins stamp carried across so a lagging window's stale archive
  // command cannot outrank it.
  const legacy = record as WorkspaceRegistryRecord & { archivedAt?: unknown }
  if (typeof legacy.archivedAt === 'number') {
    if (typeof record.settledAt !== 'number') record.settledAt = legacy.archivedAt
    const legacyStamp = isRecord(raw.fieldEditedAt) ? raw.fieldEditedAt.archivedAt : undefined
    if (typeof legacyStamp === 'number' && legacyStamp > record.fieldEditedAt.settledAt) {
      record.fieldEditedAt.settledAt = legacyStamp
    }
  }
  delete legacy.archivedAt
  return { record }
}

/**
 * Count every record with no visit clock as seen at `at`, and say how many
 * that was.
 *
 * `lastVisitedAt` is what a paired phone and a second desktop read "finished,
 * unseen" from, and nothing recorded visits before it existed. A record that
 * predates it would otherwise read as never visited, and every chat whose
 * agent ever finished a turn would come back from the upgrade marked unread,
 * including the ones the person read on this desktop the day before. So the
 * first load under this build counts everything before it as seen, once, and
 * persists that. Records created since carry their own clock from birth
 * (`stampWorkspaceVisitClockAtBirth`), so a later load finds nothing to seed
 * and can never mark a chat seen that nobody has opened.
 */
export function seedWorkspaceVisitClocks(records: WorkspaceRegistryRecord[], at: number): number {
  let seeded = 0
  for (const record of records) {
    if (typeof record.lastVisitedAt === 'number') continue
    record.lastVisitedAt = at
    seeded += 1
  }
  return seeded
}

/**
 * A new chat's visit clock: its own creation. Nothing in it could have been
 * seen before it existed, and a turn that ends after it is one nobody has
 * looked at until someone opens it. Without a clock at birth the next load's
 * seed would count the chat as read.
 */
export function stampWorkspaceVisitClockAtBirth(record: WorkspaceRegistryRecord, at: number): void {
  if (typeof record.lastVisitedAt === 'number') return
  record.lastVisitedAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : at
}

function normalizeFieldStamps(raw: unknown): WorkspaceRegistryFieldStamps {
  const stamps = emptyWorkspaceRegistryFieldStamps()
  if (!isRecord(raw)) return stamps
  for (const field of WORKSPACE_REGISTRY_STAMPED_FIELDS) {
    const value = raw[field]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) stamps[field] = value
  }
  return stamps
}

// ---------------------------------------------------------------------------
// Per-field last-write-wins
// ---------------------------------------------------------------------------

/**
 * Main applies a command only when its `editedAt` is at least the field's
 * current stamp. `editedAt` is stamped by the ORIGINATING window at the moment
 * of the user gesture, never on arrival in main — a stamp assigned on arrival
 * would make ordering depend on IPC latency, which is the bug this rule exists
 * to prevent.
 *
 * Equal stamps are accepted: main is single-threaded, so arrival order decides
 * deterministically and the window that loses converges on the next broadcast.
 */
export function shouldApplyFieldEdit(currentStamp: number, editedAt: number): boolean {
  if (!Number.isFinite(editedAt)) return false
  return editedAt >= currentStamp
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

export function addWorkspaceRegistryTombstone(
  tombstones: WorkspaceRegistryTombstone[],
  entry: WorkspaceRegistryTombstone,
  now: number,
): WorkspaceRegistryTombstone[] {
  const next = tombstones.filter((candidate) => candidate.id !== entry.id)
  next.push(entry)
  return pruneWorkspaceRegistryTombstones(next, now)
}

/**
 * Prune past 200 entries or 24h, whichever comes first. A window offline longer
 * than that has already lost the bus replay window and resyncs from a full
 * snapshot, which cannot contain the deleted record at all — so a pruned
 * tombstone can no longer resurrect anything.
 */
export function pruneWorkspaceRegistryTombstones(
  tombstones: WorkspaceRegistryTombstone[],
  now: number,
): WorkspaceRegistryTombstone[] {
  const cutoff = now - WORKSPACE_REGISTRY_TOMBSTONE_TTL_MS
  const fresh = tombstones.filter((entry) => entry.removedAt > cutoff)
  return fresh.length > WORKSPACE_REGISTRY_TOMBSTONE_LIMIT
    ? fresh.slice(fresh.length - WORKSPACE_REGISTRY_TOMBSTONE_LIMIT)
    : fresh
}

export function isWorkspaceTombstoned(tombstones: WorkspaceRegistryTombstone[], id: WorkspaceId): boolean {
  return tombstones.some((entry) => entry.id === id)
}

// ---------------------------------------------------------------------------
// Reuse resolution
// ---------------------------------------------------------------------------

/** Case- and separator-insensitive folder identity, matching the renderer's key. */
export function workspaceRegistryFolderKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : null
}

// ---------------------------------------------------------------------------
// Hydration classification (ported from the renderer's persistence slice)
// ---------------------------------------------------------------------------

export type PersistedStateClassification =
  'present' | 'dangerous_empty_missing_storage' | 'dangerous_empty_unreadable' | 'dangerous_empty_no_workspaces'

export type PersistedStateClassificationInput = {
  rawLocalStorage: string | null
  parseError?: unknown
}

/**
 * Shape-only classifier for a renderer localStorage payload. It cannot prove
 * intent — the previous "valid_empty" inference (workspaces=[] + companion
 * appSettings) was unreliable because every startup write also carries those
 * fields. Intent lives in the explicit `workspaceRegistryEmptyState` record
 * instead.
 *
 * Moved here from `persistenceSlice.ts` so main's hydrate and the renderer's
 * wipe guard share one implementation rather than two that can drift; the slice
 * re-exports it.
 */
export function classifyPersistedWorkspaceState(
  input: PersistedStateClassificationInput,
): PersistedStateClassification {
  if (input.rawLocalStorage === null) return 'dangerous_empty_missing_storage'
  if (input.parseError) return 'dangerous_empty_unreadable'

  let parsed: { state?: { workspaces?: unknown } } | null = null
  try {
    parsed = JSON.parse(input.rawLocalStorage) as { state?: { workspaces?: unknown } }
  } catch {
    return 'dangerous_empty_unreadable'
  }

  const state = parsed?.state
  if (!state || typeof state !== 'object') return 'dangerous_empty_unreadable'

  if (Array.isArray(state.workspaces) && state.workspaces.length > 0) return 'present'

  // workspaces missing or empty — defense-in-depth treats both as dangerous.
  // Whether to seed empty is governed by the explicit intent record, never by
  // guessing intent from shape.
  return 'dangerous_empty_no_workspaces'
}

export function isDangerousEmptyClassification(classification: PersistedStateClassification): boolean {
  return classification !== 'present'
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRegistryActor(value: unknown): value is WorkspaceRegistryActor {
  return (
    value === 'ui' ||
    value === 'gateway' ||
    value === 'automation' ||
    value === 'module' ||
    value === 'mobile' ||
    value === 'system'
  )
}

function isRegistryEmptyState(value: unknown): value is WorkspaceRegistryEmptyState {
  return isRecord(value) && typeof value.reason === 'string'
}

function isTombstone(value: unknown): value is WorkspaceRegistryTombstone {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.removedAt === 'number' &&
    Number.isFinite(value.removedAt) &&
    typeof value.revision === 'number'
  )
}

function isWorkspaceWindowState(value: unknown): value is WorkspaceWindowState {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.kind === 'primary' || value.kind === 'detached') &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((workspaceId) => typeof workspaceId === 'string') &&
    (value.activeWorkspaceId === null || typeof value.activeWorkspaceId === 'string') &&
    (value.bounds === null || isRecord(value.bounds)) &&
    typeof value.isMaximized === 'boolean' &&
    (value.displayId === null || typeof value.displayId === 'number') &&
    typeof value.createdAt === 'number' &&
    typeof value.lastFocusedAt === 'number'
  )
}
