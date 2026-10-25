import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import {
  createConversationLifecycle,
  createConversationListChangeFilter,
  MAX_CHAT_NAME_LENGTH,
} from './conversation-lifecycle'
import { CHAT_MANAGE_MUTATION_TOOL_NAMES, createConversationTools } from './conversation-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { gatewayToolsForCaller, requiredScopeForTool } from './tailnet/tailnet-scopes'

// A paired desktop's chat management on a chat here, beyond the row menu's
// marks: each written to this machine's record as its own windows write it.

const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }
const LOCAL: McpConnectionContext = { metadata: { kind: 'external-local' } }

function fixture(record: Partial<WorkspaceRegistryRecord> = {}) {
  const stored = { id: 'ws-1', name: 'Chat 12', createdAt: 10, ...record } as WorkspaceRegistryRecord
  const renames: Array<{ workspaceId: string; name: string; actor: WorkspaceRegistryActor }> = []
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('nothing here moves the visit clock'),
    isWorking: () => false,
    renameWorkspace: (workspaceId, name, actor) => {
      renames.push({ workspaceId, name, actor })
      stored.name = name
      stored.titleLocked = true
      return { ok: true, event: {} as never }
    },
  })
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
  })
  return { stored, renames, writes, tools, tool: (name: string) => tools.find((candidate) => candidate.name === name)! }
}

const errorCode = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: { code: string } }).error.code

test('Rename names the chat as a window’s Rename does, as the paired device, and once', async () => {
  const f = fixture()
  const renamed = await f
    .tool('conversation.rename')
    .handler({ workspaceId: 'ws-1', name: '  Parser review ' }, TAILNET)
  assert.equal(renamed.isError, undefined)
  assert.deepEqual(renamed.structuredContent, { ok: true, workspaceId: 'ws-1', name: 'Parser review' })
  assert.deepEqual(f.renames, [{ workspaceId: 'ws-1', name: 'Parser review', actor: 'mobile' }])
  // The same name again, sent twice by a retry, writes nothing.
  await f.tool('conversation.rename').handler({ workspaceId: 'ws-1', name: 'Parser review' }, TAILNET)
  assert.equal(f.renames.length, 1)
})

test('Rename refuses an empty or overlong name, and a chat this machine does not have', async () => {
  const f = fixture()
  for (const name of ['', '   ', 'x'.repeat(MAX_CHAT_NAME_LENGTH + 1)]) {
    const refused = await f.tool('conversation.rename').handler({ workspaceId: 'ws-1', name }, TAILNET)
    assert.equal(errorCode(refused), 'invalid_arguments', JSON.stringify(name.slice(0, 10)))
  }
  const missing = await f.tool('conversation.rename').handler({ workspaceId: 'ws-9', name: 'A' }, TAILNET)
  assert.equal(errorCode(missing), 'unknown_workspace')
  assert.deepEqual(f.renames, [])
})

test('the management tools are a paired device’s, and not listed to an agent here', () => {
  const { tools } = fixture()
  const names = (context: McpConnectionContext) => gatewayToolsForCaller(tools, context).map((tool) => tool.name)
  assert.ok(names(TAILNET).includes('conversation.rename'))
  assert.ok(!names(LOCAL).includes('conversation.rename'))
})

test('each is an audited mutation needing conversation:operate', () => {
  for (const name of ['conversation.rename', 'conversation.auto_compact'])
    assert.ok(CHAT_MANAGE_MUTATION_TOOL_NAMES.includes(name), name)
  for (const name of CHAT_MANAGE_MUTATION_TOOL_NAMES) {
    assert.equal(isStudioGatewayMutation(name), true, name)
    assert.equal(requiredScopeForTool(name, true), 'conversation:operate', name)
  }
})

test('Auto compact is the chat’s own choice from then on, written as its menu writes it, and once', async () => {
  const f = fixture()
  const on = await f.tool('conversation.auto_compact').handler({ workspaceId: 'ws-1', enabled: true }, TAILNET)
  assert.deepEqual(on.structuredContent, { ok: true, workspaceId: 'ws-1', autoCompact: true })
  assert.deepEqual(f.writes, [{ workspaceId: 'ws-1', patch: { autoCompactEnabled: true }, actor: 'mobile' }])
  await f.tool('conversation.auto_compact').handler({ workspaceId: 'ws-1', enabled: true }, TAILNET)
  assert.equal(f.writes.length, 1, 'switching it to what it is writes nothing')
  // Off is a choice too: the chat stays off whatever this machine's default says.
  await f.tool('conversation.auto_compact').handler({ workspaceId: 'ws-1', enabled: false }, TAILNET)
  assert.deepEqual(f.writes[1]?.patch, { autoCompactEnabled: false })
  const refused = await f.tool('conversation.auto_compact').handler({ workspaceId: 'ws-1', enabled: 'on' }, TAILNET)
  assert.equal(errorCode(refused), 'invalid_arguments')
})

test('a switch of Auto compact moves the list a paired device reads', () => {
  const moves = createConversationListChangeFilter({ turnEndOf: () => undefined })
  assert.equal(
    moves({
      type: 'workspace.fields_updated',
      payload: { workspaceId: 'ws-1', patch: { autoCompactEnabled: true } },
    } as never),
    true,
  )
})
