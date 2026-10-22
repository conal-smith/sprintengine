import assert from 'node:assert/strict'
import { test } from 'vitest'
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
  pruneWorkspaceRegistryTombstones,
  serializeWorkspaceRegistryFile,
  shouldApplyFieldEdit,
  toWorkspaceRegistryRecord,
  workspaceRegistryContentEqual,
  workspaceRegistryFolderKey,
  WORKSPACE_REGISTRY_SCHEMA_VERSION,
  WORKSPACE_REGISTRY_TOMBSTONE_LIMIT,
  WORKSPACE_REGISTRY_TOMBSTONE_TTL_MS,
  type WorkspaceRegistryFile,
  type WorkspaceRegistryTombstone,
} from './workspace-registry'
import type { Workspace } from '../renderer/src/types/workspace'
import { isRetiredWorkspaceMode, RETIRED_WORKSPACE_MODES } from './workspace-mode'

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Workspace',
    mode: 'standard',
    folderPath: '/repo',
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1_000,
    ...overrides,
  } as Workspace
}

test('a registry file round-trips through serialize and parse', () => {
  const file: WorkspaceRegistryFile = {
    ...emptyWorkspaceRegistryFile(5_000),
    revision: 7,
    workspaces: [toWorkspaceRegistryRecord(workspace(), 7)],
    activeWorkspaceId: 'ws-1',
  }
  const parsed = parseWorkspaceRegistryFile(JSON.parse(serializeWorkspaceRegistryFile(file)))
  assert.ok(parsed, 'a well-formed current-schema file parses')
  assert.equal(parsed.file.revision, 7)
  assert.equal(parsed.file.workspaces.length, 1)
  assert.equal(parsed.file.workspaces[0]?.id, 'ws-1')
  assert.equal(parsed.file.activeWorkspaceId, 'ws-1')
  assert.deepEqual(parsed.droppedRecords, [])
})

test('every retired-mode record is filtered on parse, with its window references', () => {
  const file: WorkspaceRegistryFile = {
    ...emptyWorkspaceRegistryFile(5_000),
    revision: 4,
    workspaces: [
      toWorkspaceRegistryRecord(workspace({ id: 'ws-keep' }), 4),
      ...RETIRED_WORKSPACE_MODES.map((mode) => toWorkspaceRegistryRecord(workspace({ id: `ws-${mode}`, mode }), 4)),
    ],
    activeWorkspaceId: 'ws-sprintengine',
  }
  file.workspaceWindows[0]!.workspaceIds = ['ws-sprintengine', 'ws-keep', 'ws-roadmap']
  file.workspaceWindows[0]!.activeWorkspaceId = 'ws-roadmap'
  const parsed = parseWorkspaceRegistryFile(JSON.parse(serializeWorkspaceRegistryFile(file)))
  assert.ok(parsed)
  assert.deepEqual(
    parsed.file.workspaces.map((record) => record.id),
    ['ws-keep'],
  )
  assert.deepEqual(
    parsed.retiredRecordIds,
    RETIRED_WORKSPACE_MODES.map((mode) => `ws-${mode}`),
  )
  assert.deepEqual(parsed.droppedRecords, [], 'a retired row is not reported as malformed')
  assert.equal(parsed.file.activeWorkspaceId, null)
  assert.deepEqual(parsed.file.workspaceWindows[0]?.workspaceIds, ['ws-keep'])
  assert.equal(parsed.file.workspaceWindows[0]?.activeWorkspaceId, null)
  assert.ok(RETIRED_WORKSPACE_MODES.includes('sprintengine'))
  assert.ok(RETIRED_WORKSPACE_MODES.includes('automations-host'))
  assert.equal(isRetiredWorkspaceMode('standard'), false)
  assert.equal(isRetiredWorkspaceMode('weather-deck'), false, 'a module-registered mode is not retired')
})

test('a default-named record locked at birth is healed on read', () => {
  // Between 2026-07-29 and 2026-09-01 every New chat was persisted as
  // "Chat N" + titleLocked, so the first prompt could never name it.
  const file: WorkspaceRegistryFile = {
    ...emptyWorkspaceRegistryFile(5_000),
    revision: 3,
    workspaces: [
      toWorkspaceRegistryRecord(workspace({ id: 'ws-chat', name: 'Chat 63', titleLocked: true }), 3),
      toWorkspaceRegistryRecord(workspace({ id: 'ws-named', name: 'Release prep', titleLocked: true }), 3),
      toWorkspaceRegistryRecord(workspace({ id: 'ws-renamed', name: 'jean', titleLocked: true }), 3),
    ],
  }
  const parsed = parseWorkspaceRegistryFile(JSON.parse(serializeWorkspaceRegistryFile(file)))
  assert.ok(parsed)
  const byId = new Map(parsed.file.workspaces.map((record) => [record.id, record]))
  assert.equal(
    byId.get('ws-chat')?.titleLocked,
    undefined,
    'a "Chat N" lock is dropped so the first prompt can name it',
  )
  assert.equal(byId.get('ws-named')?.titleLocked, true, 'a chosen name keeps its lock')
  assert.equal(byId.get('ws-renamed')?.titleLocked, true, 'a hand rename keeps its lock')
})

test('an unknown schemaVersion parses to null rather than being half-read', () => {
  const file = { ...emptyWorkspaceRegistryFile(0), schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION + 1 }
  assert.equal(parseWorkspaceRegistryFile(file), null)
  assert.equal(parseWorkspaceRegistryFile(null), null)
  assert.equal(parseWorkspaceRegistryFile({ schemaVersion: 1, revision: -1, workspaces: [] }), null)
})

test('one malformed record is dropped and the rest of the file survives', () => {
  const good = toWorkspaceRegistryRecord(workspace(), 1)
  const bad = { ...toWorkspaceRegistryRecord(workspace({ id: 'ws-2' }), 1), layoutModel: undefined }
  const parsed = parseWorkspaceRegistryFile({
    ...emptyWorkspaceRegistryFile(0),
    revision: 1,
    workspaces: [good, bad],
  })
  assert.ok(parsed)
  assert.deepEqual(
    parsed.file.workspaces.map((record) => record.id),
    ['ws-1'],
  )
  assert.deepEqual(parsed.droppedRecords, [{ id: 'ws-2', reason: 'layoutModel' }])
})

test('per-record validation names the field that failed', () => {
  for (const [field, override] of [
    ['id', { id: '' }],
    ['name', { name: 42 }],
    ['mode', { mode: '' }],
    ['templateId', { templateId: '' }],
    ['agents', { agents: null }],
    ['folderPath', { folderPath: 3 }],
  ] as const) {
    const parsed = parseWorkspaceRegistryRecord({ ...toWorkspaceRegistryRecord(workspace(), 1), ...override })
    assert.deepEqual(parsed, { reason: field }, `a bad ${field} is reported as ${field}`)
  }
})

test('content equality ignores the revision so an unchanged write is a no-op', () => {
  const base: WorkspaceRegistryFile = {
    ...emptyWorkspaceRegistryFile(1_000),
    revision: 3,
    workspaces: [toWorkspaceRegistryRecord(workspace(), 3)],
  }
  const bumped: WorkspaceRegistryFile = {
    ...base,
    revision: 4,
    changedAt: 9_999,
    lastWrite: { actor: 'gateway', at: 'later' },
    workspaces: [toWorkspaceRegistryRecord(workspace(), 4)],
  }
  assert.equal(workspaceRegistryContentEqual(base, bumped), true, 'same content, newer revision, no write')

  const changed: WorkspaceRegistryFile = {
    ...base,
    workspaces: [toWorkspaceRegistryRecord(workspace({ name: 'Renamed' }), 3)],
  }
  assert.equal(workspaceRegistryContentEqual(base, changed), false)
})

test('durability normalization strips renderer-owned view state and live agent noise', () => {
  const normalized = normalizeWorkspaceForRegistry(
    workspace({
      editorState: { openFiles: [{ path: '/a.ts', content: 'x', isDirty: true }], activeFilePath: '/a.ts' },
      fileExplorerState: { expandedPaths: ['/repo/src'] },
      moduleState: { weather: { deck: 'compact' }, backlog: { lens: 'all' } },
      agents: {
        'agent-1': {
          id: 'agent-1',
          name: 'A',
          status: 'running',
          streamBuffer: 'half a screen of output',
          cliRestartNonce: 4,
          cliSessionId: 'session-1',
          cliResumeAvailable: true,
          cliOnboardingPromptSent: true,
          cliStartupPrompt: 'do the thing',
        },
      },
    } as unknown as Partial<Workspace>),
  )

  assert.deepEqual(normalized.editorState, { openFiles: [], activeFilePath: null })
  assert.equal(normalized.fileExplorerState, undefined)
  assert.deepEqual(
    normalized.moduleState,
    { weather: { deck: 'compact' }, backlog: { lens: 'all' } },
    'a module bag travels as-is — only the module that wrote it can say what part is durable',
  )

  const agent = normalized.agents['agent-1']!
  assert.equal(agent.streamBuffer, '')
  assert.equal(agent.status, 'idle')
  assert.equal(agent.cliRestartNonce, 0)
  assert.equal(agent.cliStartupPrompt, undefined, 'a sent onboarding prompt is not re-armed')
  assert.equal(agent.cliSessionId, 'session-1', 'durable resume identity survives — claude --resume reads it')
  assert.equal(agent.cliResumeAvailable, true)
})

test('per-field last-write-wins accepts equal and newer stamps, drops older ones', () => {
  assert.equal(shouldApplyFieldEdit(100, 101), true)
  assert.equal(shouldApplyFieldEdit(100, 100), true, 'equal stamps: arrival order decides, deterministically')
  assert.equal(shouldApplyFieldEdit(100, 99), false)
  assert.equal(shouldApplyFieldEdit(0, 0), true, 'a never-edited field accepts the first write')
  assert.equal(shouldApplyFieldEdit(100, Number.NaN), false)
})

test('a record still carrying the retired archive stamp reads as settled', () => {
  const raw = {
    ...toWorkspaceRegistryRecord(workspace(), 1),
    archivedAt: 5_000,
    fieldEditedAt: { name: 1, archivedAt: 9_000 },
  }
  const parsed = parseWorkspaceRegistryRecord(raw)
  assert.ok('record' in parsed)
  assert.equal(parsed.record.settledAt, 5_000, 'the archive stamp heals into the settle stamp')
  assert.equal('archivedAt' in parsed.record, false, 'and the retired field is gone from the record')
  assert.equal(parsed.record.fieldEditedAt.settledAt, 9_000, 'its last-write-wins stamp carries across')
  assert.equal(parsed.record.fieldEditedAt.name, 1, 'other stamps are untouched')

  const already = parseWorkspaceRegistryRecord({ ...raw, settledAt: 7_000 })
  assert.ok('record' in already)
  assert.equal(already.record.settledAt, 7_000, 'a settle stamp already present is the newer fact and wins')
})

test('a fresh record carries zeroed stamps unless seeded', () => {
  assert.deepEqual(emptyWorkspaceRegistryFieldStamps(), {
    name: 0,
    layoutModel: 0,
    folderPath: 0,
    memory: 0,
    settledAt: 0,
    settledOverride: 0,
    autoSettleEnabled: 0,
    autoCompactEnabled: 0,
    snoozedUntil: 0,
  })
  assert.deepEqual(toWorkspaceRegistryRecord(workspace(), 1).fieldEditedAt, emptyWorkspaceRegistryFieldStamps())
})

test('tombstones reject a command against a removed id and prune at both bounds', () => {
  const now = 10_000_000
  let tombstones = addWorkspaceRegistryTombstone([], { id: 'ws-1', removedAt: now, revision: 3 }, now)
  assert.equal(isWorkspaceTombstoned(tombstones, 'ws-1'), true)
  assert.equal(isWorkspaceTombstoned(tombstones, 'ws-2'), false)

  // Re-removing an id replaces its entry rather than duplicating it.
  tombstones = addWorkspaceRegistryTombstone(tombstones, { id: 'ws-1', removedAt: now + 5, revision: 4 }, now)
  assert.equal(tombstones.length, 1)
  assert.equal(tombstones[0]?.revision, 4)

  const stale: WorkspaceRegistryTombstone = {
    id: 'ws-old',
    removedAt: now - WORKSPACE_REGISTRY_TOMBSTONE_TTL_MS - 1,
    revision: 1,
  }
  assert.deepEqual(
    pruneWorkspaceRegistryTombstones([stale, ...tombstones], now).map((entry) => entry.id),
    ['ws-1'],
    'past 24h a window has already lost the replay window and resyncs from a snapshot',
  )

  const many: WorkspaceRegistryTombstone[] = Array.from(
    { length: WORKSPACE_REGISTRY_TOMBSTONE_LIMIT + 10 },
    (_entry, index) => ({ id: `ws-${index}`, removedAt: now, revision: index }),
  )
  const pruned = pruneWorkspaceRegistryTombstones(many, now)
  assert.equal(pruned.length, WORKSPACE_REGISTRY_TOMBSTONE_LIMIT)
  assert.equal(pruned.at(-1)?.id, `ws-${WORKSPACE_REGISTRY_TOMBSTONE_LIMIT + 9}`, 'the newest survive the cap')
})

test('folder keys are case- and separator-insensitive with no trailing slash', () => {
  assert.equal(workspaceRegistryFolderKey('/Repo/App/'), '/repo/app')
  assert.equal(workspaceRegistryFolderKey('C:\\Repo\\App'), 'c:/repo/app')
  assert.equal(workspaceRegistryFolderKey('  '), null)
  assert.equal(workspaceRegistryFolderKey(null), null)
})

test('classification: every hydration row of the migration table', () => {
  const present = JSON.stringify({ state: { workspaces: [{ id: 'ws-1' }] } })
  assert.equal(classifyPersistedWorkspaceState({ rawLocalStorage: present }), 'present')
  assert.equal(isDangerousEmptyClassification('present'), false)

  assert.equal(classifyPersistedWorkspaceState({ rawLocalStorage: null }), 'dangerous_empty_missing_storage')
  assert.equal(
    classifyPersistedWorkspaceState({ rawLocalStorage: '{not json', parseError: undefined }),
    'dangerous_empty_unreadable',
  )
  assert.equal(
    classifyPersistedWorkspaceState({ rawLocalStorage: present, parseError: new Error('read failed') }),
    'dangerous_empty_unreadable',
  )
  assert.equal(
    classifyPersistedWorkspaceState({ rawLocalStorage: JSON.stringify({ state: { workspaces: [] } }) }),
    'dangerous_empty_no_workspaces',
  )
  assert.equal(
    classifyPersistedWorkspaceState({ rawLocalStorage: JSON.stringify({ nostate: true }) }),
    'dangerous_empty_unreadable',
  )
  for (const classification of [
    'dangerous_empty_missing_storage',
    'dangerous_empty_unreadable',
    'dangerous_empty_no_workspaces',
  ] as const) {
    assert.equal(isDangerousEmptyClassification(classification), true)
  }
})
