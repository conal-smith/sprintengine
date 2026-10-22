import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import {
  applyWorkspaceFieldsPatch,
  type WorkspaceFieldsPatch,
  type WorkspaceSyncEvent,
} from '../../shared/workspace-sync'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { createConversationLifecycle, createConversationListChangeFilter } from './conversation-lifecycle'
import { createConversationTools } from './conversation-tools'

// A paired desktop's row menu on a chat here: Star, Highlight color, Snooze
// and Auto-settle, written to this machine's record as its own menu writes
// them (`chat-row-menu`).

const NOW = 1_000_000
const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }

function fixture(record: Partial<WorkspaceRegistryRecord>, options: { working?: boolean } = {}) {
  const stored = { id: 'ws-1', name: 'Fix the login', createdAt: 10, ...record } as WorkspaceRegistryRecord
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('nothing here moves the visit clock'),
    isWorking: () => options.working === true,
    now: () => NOW,
  })
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
  })
  const toolNamed = (name: string) => tools.find((candidate) => candidate.name === name)!
  return {
    stored,
    writes,
    snooze: toolNamed('conversation.snooze'),
    highlight: toolNamed('conversation.highlight'),
    autoSettle: toolNamed('conversation.auto_settle'),
  }
}

const errorCode = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: { code: string } }).error.code

test('snoozing writes the row menu’s own patch, as the paired device, and null wakes the chat', async () => {
  const f = fixture({})
  const slept = await f.snooze.handler({ workspaceId: 'ws-1', until: NOW + 3_600_000 }, TAILNET)
  assert.equal(slept.isError, undefined)
  assert.deepEqual(slept.structuredContent, { ok: true, workspaceId: 'ws-1', snoozedUntil: NOW + 3_600_000 })
  assert.deepEqual(f.writes, [{ workspaceId: 'ws-1', patch: { snoozedUntil: NOW + 3_600_000 }, actor: 'mobile' }])

  const woke = await f.snooze.handler({ workspaceId: 'ws-1', until: null }, TAILNET)
  assert.deepEqual(woke.structuredContent, { ok: true, workspaceId: 'ws-1', snoozedUntil: null })
  assert.deepEqual(f.writes[1]?.patch, { snoozedUntil: null })
  assert.equal(f.stored.snoozedUntil, null)

  // Waking a chat that is awake is not a write.
  await f.snooze.handler({ workspaceId: 'ws-1', until: null }, TAILNET)
  assert.equal(f.writes.length, 2)
})

test('a snooze waits for a working chat, refuses a settled one and a wake time already past', async () => {
  const working = fixture({}, { working: true })
  assert.equal(errorCode(await working.snooze.handler({ workspaceId: 'ws-1', until: NOW + 1 }, TAILNET)), 'working')
  assert.deepEqual(working.writes, [])

  const settled = fixture({ settledAt: 5 })
  assert.equal(errorCode(await settled.snooze.handler({ workspaceId: 'ws-1', until: NOW + 1 }, TAILNET)), 'settled')

  const past = fixture({})
  assert.equal(errorCode(await past.snooze.handler({ workspaceId: 'ws-1', until: NOW }, TAILNET)), 'invalid_arguments')
  assert.equal(
    errorCode(await past.snooze.handler({ workspaceId: 'ws-1', until: 'tomorrow' }, TAILNET)),
    'invalid_arguments',
  )
  assert.equal(
    errorCode(await past.snooze.handler({ workspaceId: 'ws-elsewhere', until: NOW + 1 }, TAILNET)),
    'unknown_workspace',
  )
  assert.deepEqual(past.writes, [])
})

test('star and colour change what they name, keep the rest, and a chat left with neither has no highlight', async () => {
  const f = fixture({ highlight: { starred: false, color: 'blue' } })
  const starred = await f.highlight.handler({ workspaceId: 'ws-1', starred: true }, TAILNET)
  assert.deepEqual(starred.structuredContent, { ok: true, workspaceId: 'ws-1', starred: true, color: 'blue' })
  assert.deepEqual(f.stored.highlight, { starred: true, color: 'blue' })

  await f.highlight.handler({ workspaceId: 'ws-1', color: 'green' }, TAILNET)
  assert.deepEqual(f.stored.highlight, { starred: true, color: 'green' })

  await f.highlight.handler({ workspaceId: 'ws-1', starred: false, color: null }, TAILNET)
  assert.equal(f.stored.highlight, null)
  assert.deepEqual(f.writes.at(-1)?.patch, { highlight: null })
})

test('a highlight is refused a colour the menu does not offer, and a call that names nothing', async () => {
  const f = fixture({})
  assert.equal(
    errorCode(await f.highlight.handler({ workspaceId: 'ws-1', color: 'teal' }, TAILNET)),
    'invalid_arguments',
  )
  assert.equal(errorCode(await f.highlight.handler({ workspaceId: 'ws-1' }, TAILNET)), 'invalid_arguments')
  assert.equal(
    errorCode(await f.highlight.handler({ workspaceId: 'ws-1', starred: 'yes' }, TAILNET)),
    'invalid_arguments',
  )
  assert.deepEqual(f.writes, [])
})

test('Auto-settle is switched on and off as the row menu’s switch writes it, and a no-op writes nothing', async () => {
  const f = fixture({})
  const on = await f.autoSettle.handler({ workspaceId: 'ws-1', enabled: true }, TAILNET)
  assert.deepEqual(on.structuredContent, { ok: true, workspaceId: 'ws-1', autoSettle: true })
  assert.deepEqual(f.writes, [{ workspaceId: 'ws-1', patch: { autoSettleEnabled: true }, actor: 'mobile' }])
  await f.autoSettle.handler({ workspaceId: 'ws-1', enabled: true }, TAILNET)
  assert.equal(f.writes.length, 1)
  await f.autoSettle.handler({ workspaceId: 'ws-1', enabled: false }, TAILNET)
  assert.deepEqual(f.writes[1]?.patch, { autoSettleEnabled: null })
  assert.equal(
    errorCode(await f.autoSettle.handler({ workspaceId: 'ws-1', enabled: 'on' }, TAILNET)),
    'invalid_arguments',
  )
})

test('a snooze, a highlight or Auto-settle moves the conversation list a paired device reads', () => {
  const event = (patch: WorkspaceFieldsPatch): WorkspaceSyncEvent => ({
    id: 'e',
    type: 'workspace.fields_updated',
    sourceWindowId: 'primary',
    sequence: 1,
    createdAt: 1,
    payload: { workspaceId: 'ws-1', patch, editedAt: 1 },
  })
  const changed = createConversationListChangeFilter({ turnEndOf: () => undefined })
  assert.equal(changed(event({ snoozedUntil: 5 })), true)
  assert.equal(changed(event({ snoozedUntil: null })), true)
  assert.equal(changed(event({ highlight: { starred: true, color: null } })), true)
  assert.equal(changed(event({ highlight: null })), true)
  assert.equal(changed(event({ autoSettleEnabled: true })), true)
})
