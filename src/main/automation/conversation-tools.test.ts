import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { LaunchedAgentLink } from '../agent-launch-notices'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { CONVERSATION_MUTATION_TOOL_NAMES, createConversationTools } from './conversation-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { requiredScopeForTool } from './tailnet/tailnet-scopes'

// conversation.create never touches a chat's rest; its tests leave it unreachable.
const noLifecycle = {
  settle: () => assert.fail('conversation.create does not settle'),
  visit: () => assert.fail('conversation.create does not visit'),
  markUnread: () => assert.fail('conversation.create does not mark anything unread'),
  snooze: () => assert.fail('nothing is snoozed here'),
  highlight: () => assert.fail('nothing is starred here'),
  setAutoSettle: () => assert.fail('no Auto-settle is switched here'),
}

function tool(launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>) {
  const [registration] = createConversationTools({
    launch,
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: noLifecycle,
  })
  assert.equal(registration?.name, 'conversation.create')
  return registration!
}

test("starting, settling, visiting, marking a chat unread and its row menu's marks are audited mutations needing conversation:operate", () => {
  assert.deepEqual(
    [...CONVERSATION_MUTATION_TOOL_NAMES],
    [
      'conversation.create',
      'conversation.settle',
      'conversation.visit',
      'conversation.mark_unread',
      'conversation.snooze',
      'conversation.highlight',
      'conversation.auto_settle',
    ],
  )
  for (const name of CONVERSATION_MUTATION_TOOL_NAMES) {
    assert.equal(isStudioGatewayMutation(name), true, name)
    assert.equal(requiredScopeForTool(name, true), 'conversation:operate', name)
  }
})

test('conversation.create forwards the launch and answers with the ids a pane follows', async () => {
  const requests: ConversationLaunchRequest[] = []
  const handler = tool(async (request) => {
    requests.push(request)
    return {
      ok: true,
      workspaceId: 'ws-1',
      agentId: 'agent-codex-1',
      name: 'Ada',
      cli: 'codex',
      providerId: 'codex-agent',
      modelId: 'default',
      sessionId: 'conv_1',
    }
  }).handler
  const result = await handler({ workspaceId: ' ws-1 ', cli: 'codex', prompt: 'hi', permissionPreset: 'bypass_all' })
  assert.deepEqual(requests, [{ workspaceId: 'ws-1', cli: 'codex', prompt: 'hi', permissionPreset: 'bypass' }])
  assert.equal(result.isError, undefined)
  assert.deepEqual((result.structuredContent as { conversation: unknown }).conversation, {
    workspaceId: 'ws-1',
    agentId: 'agent-codex-1',
    name: 'Ada',
    cli: 'codex',
    providerId: 'codex-agent',
    modelId: 'default',
    sessionId: 'conv_1',
  })
})

test('conversation.create refuses bad arguments and passes a launch refusal through', async () => {
  let launched = 0
  const handler = tool(async () => {
    launched += 1
    return { ok: false, code: 'cli_not_conversational', message: 'no chat' }
  }).handler
  const missing = await handler({})
  assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  const badPreset = await handler({ workspaceId: 'ws-1', permissionPreset: 'yolo' })
  assert.equal((badPreset.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  const badNewChat = await handler({ workspaceId: 'ws-1', newChat: 'yes' })
  assert.equal((badNewChat.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(launched, 0)
  const refused = await handler({ workspaceId: 'ws-1', cli: 'kimi-code' })
  assert.equal(refused.isError, true)
  assert.deepEqual((refused.structuredContent as { error: unknown }).error, {
    code: 'cli_not_conversational',
    message: 'no chat',
  })
})

test('conversation.create asks for a chat of its own when newChat is set, and declares the argument', async () => {
  const requests: ConversationLaunchRequest[] = []
  const registration = tool(async (request) => {
    requests.push(request)
    return {
      ok: true,
      workspaceId: 'ws-new',
      agentId: 'agent-1',
      name: 'Ada',
      cli: 'codex',
      providerId: 'codex-agent',
      modelId: 'default',
      sessionId: 'conv_2',
    }
  })
  const schema = registration.inputSchema as { properties: Record<string, { type: string }> }
  assert.equal(schema.properties.newChat?.type, 'boolean')
  const result = await registration.handler({ workspaceId: 'ws-1', newChat: true, prompt: 'hi' })
  await registration.handler({ workspaceId: 'ws-1', newChat: false })
  assert.deepEqual(requests, [{ workspaceId: 'ws-1', newChat: true, prompt: 'hi' }, { workspaceId: 'ws-1' }])
  assert.equal(
    (result.structuredContent as { conversation: { workspaceId: string } }).conversation.workspaceId,
    'ws-new',
  )
})

test('conversation.create links the calling agent to the chat it started, unless asked not to', async () => {
  const links: LaunchedAgentLink[] = []
  const [registration] = createConversationTools({
    launch: async () => ({
      ok: true,
      workspaceId: 'ws-1',
      agentId: 'agent-codex-1',
      name: 'Ada',
      cli: 'codex',
      providerId: 'codex-agent',
      modelId: 'default',
      sessionId: 'conv_1',
    }),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: noLifecycle,
    linkLaunchedAgent: (link) => (links.push(link), { linked: true as const }),
  })
  const caller = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-lead' } }
  const linked = await registration!.handler({ workspaceId: 'ws-1' }, caller)
  assert.equal((linked.structuredContent as { notifyParent: boolean }).notifyParent, true)
  assert.deepEqual(links, [
    {
      parent: { workspaceId: 'ws-1', agentId: 'agent-lead' },
      child: {
        workspaceId: 'ws-1',
        agentId: 'agent-codex-1',
        sessionId: 'conv_1',
        transport: 'conversation',
        name: 'Ada',
      },
    },
  ])

  const quiet = await registration!.handler({ workspaceId: 'ws-1', notifyParent: false }, caller)
  assert.equal((quiet.structuredContent as { notifyParent: boolean }).notifyParent, false)
  const remote = await registration!.handler({ workspaceId: 'ws-1' }, { metadata: { kind: 'remote-tailnet' } })
  assert.equal((remote.structuredContent as { notifyParent: boolean }).notifyParent, false)
  assert.equal(links.length, 1)

  // A gateway that cannot type into its callers says so rather than promising.
  const unlinked = await tool(async () => ({
    ok: true,
    workspaceId: 'ws-1',
    agentId: 'agent-codex-1',
    name: 'Ada',
    cli: 'codex',
    providerId: 'codex-agent',
    modelId: 'default',
    sessionId: 'conv_1',
  })).handler({ workspaceId: 'ws-1' }, caller)
  assert.equal((unlinked.structuredContent as { notifyParent: boolean }).notifyParent, false)
  assert.match((unlinked.structuredContent as { notifyParentReason: string }).notifyParentReason, /agent\.status/u)
})
