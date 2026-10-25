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
import { conversationPullRequestsOf } from './tailnet/tailnet-conversation-machine'
import { gatewayToolsForCaller, requiredScopeForTool } from './tailnet/tailnet-scopes'

// A paired desktop's chat management on a chat here, beyond the row menu's
// marks: each written to this machine's record as its own windows write it.

const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }
const LOCAL: McpConnectionContext = { metadata: { kind: 'external-local' } }

function fixture(record: Partial<WorkspaceRegistryRecord> = {}, watched: string[] = []) {
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
  const watches = new Set(watched)
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
    pullRequestWatches: {
      watchedOf: () => [...watches],
      unwatch: (_key, url) => watches.delete(url),
    },
  })
  return {
    stored,
    renames,
    writes,
    watches,
    tools,
    tool: (name: string) => tools.find((candidate) => candidate.name === name)!,
  }
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
  for (const name of [
    'conversation.rename',
    'conversation.auto_compact',
    'conversation.pull_request_unwatch',
    'conversation.delete_plan',
    'conversation.delete',
    'conversation.search',
    'conversation.approval_rules',
    'conversation.approval_rule_revoke',
  ]) {
    assert.ok(names(TAILNET).includes(name), name)
    assert.ok(!names(LOCAL).includes(name), name)
  }
})

test('each is an audited mutation needing conversation:operate', () => {
  for (const name of [
    'conversation.rename',
    'conversation.auto_compact',
    'conversation.pull_request_unwatch',
    'conversation.delete',
    'conversation.approval_rule_revoke',
  ])
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

test('Stop watching ends this machine’s watch of a chat’s pull request, one or every one, and once', async () => {
  const one = 'https://github.com/acme/app/pull/7'
  const two = 'https://github.com/acme/app/pull/8'
  const f = fixture({}, [one, two])
  const tool = f.tool('conversation.pull_request_unwatch')
  const stopped = await tool.handler({ workspaceId: 'ws-1', agentId: 'agent-1', url: one }, TAILNET)
  assert.deepEqual(stopped.structuredContent, {
    ok: true,
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    stopped: 1,
    pullRequests: [one],
  })
  const again = await tool.handler({ workspaceId: 'ws-1', agentId: 'agent-1', url: one }, TAILNET)
  assert.equal((again.structuredContent as { stopped: number }).stopped, 0, 'a watch already ended changes nothing')
  const rest = await tool.handler({ workspaceId: 'ws-1', agentId: 'agent-1' }, TAILNET)
  assert.deepEqual((rest.structuredContent as { pullRequests: string[] }).pullRequests, [two])
  assert.equal(f.watches.size, 0)
  assert.equal(errorCode(await tool.handler({ workspaceId: 'ws-1' }, TAILNET)), 'invalid_arguments')
})

test('a listed pull request carries its watch', () => {
  const [listed] = conversationPullRequestsOf([
    {
      url: 'https://github.com/acme/app/pull/7',
      repoKey: 'github.com/acme/app',
      repoName: 'app',
      number: 7,
      title: 'Fix it',
      state: 'open',
      isDraft: false,
      openedAt: 1,
      stateAt: 1,
      watch: { since: 5, waitingOn: 'checks' },
    },
  ])
  assert.deepEqual(listed?.watch, { since: 5, waitingOn: 'checks' })
})

test('Delete plans and deletes a settled chat as this machine’s own Delete, with no path of this machine’s', async () => {
  const present = new Set(['ws-1'])
  const deleted: string[][] = []
  const worktree = {
    path: '/Users/dev/.sprintengine-worktrees/app/chat-k',
    repoRoot: '/Users/dev/app',
    name: 'chat-k',
    branch: 'agent/chat-k',
    pooled: false,
    changedPaths: 0,
    unpushedCommits: 1,
    fate: 'remove' as const,
  }
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: {} as never,
    settledChatDeletion: () => ({
      plan: async (ids) => ids.map((workspaceId) => ({ workspaceId, remoteMachine: null, worktrees: [worktree] })),
      delete: async (ids) => {
        deleted.push([...ids])
        for (const id of ids) present.delete(id)
        return ids.map((workspaceId) => ({
          workspaceId,
          ok: true as const,
          worktrees: [{ path: worktree.path, name: 'chat-k', branch: 'agent/chat-k', result: 'removed' as const }],
        }))
      },
      has: (workspaceId) => present.has(workspaceId),
    }),
  })
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
  const plan = await tool('conversation.delete_plan').handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.deepEqual(plan.structuredContent, {
    ok: true,
    workspaceId: 'ws-1',
    worktrees: [
      { name: 'chat-k', branch: 'agent/chat-k', pooled: false, changedPaths: 0, unpushedCommits: 1, fate: 'remove' },
    ],
  })
  const gone = await tool('conversation.delete').handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.deepEqual(gone.structuredContent, {
    ok: true,
    workspaceId: 'ws-1',
    worktrees: [{ name: 'chat-k', branch: 'agent/chat-k', result: 'removed' }],
  })
  // Sent again, it is gone, as was asked, and nothing more is deleted.
  const again = await tool('conversation.delete').handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.equal((again.structuredContent as { gone?: boolean }).gone, true)
  assert.deepEqual(deleted, [['ws-1']])
})

test('Delete is refused in words where this process cannot delete', async () => {
  const { tool } = fixture()
  const refused = await tool('conversation.delete').handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.equal(errorCode(refused), 'unavailable')
})

test('the always-allow rules are listed by their project’s name, never a path, and revoked once', async () => {
  let rules = [
    {
      id: 'r1',
      workspaceRoot: '/Users/dev/parser',
      toolKind: 'command' as const,
      toolName: 'Bash',
      matcher: { type: 'command' as const, program: 'npm', subcommand: 'test' },
      label: 'Run npm test',
      createdAt: 5,
    },
  ]
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: {} as never,
    approvalRules: {
      list: async () => ({ ok: true, rules }),
      revoke: async (ruleId) => {
        rules = rules.filter((rule) => rule.id !== ruleId)
        return { ok: true }
      },
    },
  })
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
  const listed = await tool('conversation.approval_rules').handler({}, TAILNET)
  assert.deepEqual(listed.structuredContent, {
    ok: true,
    rules: [
      { id: 'r1', label: 'Run npm test', toolName: 'Bash', toolKind: 'command', project: 'parser', createdAt: 5 },
    ],
  })
  const revoked = await tool('conversation.approval_rule_revoke').handler({ ruleId: 'r1' }, TAILNET)
  assert.deepEqual(revoked.structuredContent, { ok: true, ruleId: 'r1' })
  const again = await tool('conversation.approval_rule_revoke').handler({ ruleId: 'r1' }, TAILNET)
  assert.deepEqual(again.structuredContent, { ok: true, ruleId: 'r1' }, 'a rule already gone changes nothing')
  assert.deepEqual(rules, [])
})
