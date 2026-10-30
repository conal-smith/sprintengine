import assert from 'node:assert/strict'
import { test } from 'vitest'

import { exportChatEvents } from '../../../tests/fixtures/conversations/export-chat'
import type { ConversationCommand } from '../../../packages/conversation-protocol/src/public'
import type { ConversationPermissionPreset, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import type { ConversationGatewayCommandResult } from './tailnet/tailnet-conversation-host'
import { localOnlyGatewayToolReason } from './tailnet/tailnet-scopes'
import {
  CHAT_WAIT_DEFAULT_MS,
  createConversationChatTools,
  type ConversationChatControl,
} from './conversation-chat-tools'
import { chatMessagesOf } from './conversation-chat-read'

// One chat's agent driving another chat on this machine: it sends through the
// chat's normal send path, reads the words alone inside a budget, waits on the
// chat's state, and stops a turn — and never drives a chat that runs looser
// than it does.

type Sent = { workspaceId: string; agentId: string; clientId: string; command: ConversationCommand }

function session(overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: 's-1',
    workspaceId: 'ws-target',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ConversationSessionSummary
}

function harness(
  options: {
    agents?: Record<string, string[]>
    summary?: () => ConversationSessionSummary | undefined
    preset?: ConversationPermissionPreset
    callerPreset?: CliPermissionPreset | null
    answers?: ConversationGatewayCommandResult[]
    clock?: { now: number }
  } = {},
) {
  const sent: Sent[] = []
  const pages: Array<{ before?: number; turns: number }> = []
  const answers = [...(options.answers ?? [])]
  const clock = options.clock ?? { now: 1_000 }
  const chats: ConversationChatControl = {
    chatAgentsOf: (workspaceId) =>
      (options.agents ?? { 'ws-target': ['agent-1'], 'ws-caller': ['agent-1'] })[workspaceId] ?? null,
    resolveKey: (workspaceId, agentId) => ({ workspaceRoot: `/Users/dev/${workspaceId}`, workspaceId, agentId }),
    chatTitle: (workspaceId) => (workspaceId === 'ws-caller' ? 'Release plan' : 'Parser fix'),
    session: () => (options.summary ? options.summary() : session()),
    permissionOf: () => options.preset ?? 'auto',
    command: async (key, clientId, _commandId, command) => {
      sent.push({ workspaceId: key.workspaceId, agentId: key.agentId, clientId, command })
      return answers.shift() ?? { ok: true }
    },
    readPage: async (_key, page) => {
      pages.push(page)
      return { ok: true, events: exportChatEvents(), hasMore: true, before: 42 }
    },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
  }
  const tools = createConversationChatTools({
    resolveAgentPermissionPreset: () => (options.callerPreset === undefined ? 'auto' : options.callerPreset),
    chats,
  })
  const call = (name: string, args: Record<string, unknown>, context: McpConnectionContext = agent) =>
    tools.find((tool) => tool.name === name)!.handler(args, context) as Promise<McpToolResult>
  return { call, sent, pages, clock }
}

const agent: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-caller', agentId: 'agent-1', verified: true },
}
const script: McpConnectionContext = { metadata: { kind: 'external-local' } }

const body = (result: McpToolResult) => result.structuredContent as Record<string, any>
const errorCode = (result: McpToolResult) => (result.isError ? body(result).error.code : null)

test('a chat not in a turn takes the message at once, headed with the chat it came from', async () => {
  const h = harness()
  const result = await h.call('conversation.send', { workspaceId: 'ws-target', message: 'Rebase on main.' })
  assert.equal(result.isError, undefined)
  assert.equal(body(result).queued, false)
  assert.equal(body(result).sentAt, 1_000)
  assert.equal(h.sent.length, 1)
  const command = h.sent[0]!.command as Extract<ConversationCommand, { kind: 'send' }>
  assert.equal(command.queue, undefined, 'a free chat is not held: the message goes as the agent’s own')
  assert.match(command.message, /^\[Sent by the agent in "Release plan" \(workspaceId ws-caller, agentId agent-1\)/u)
  assert.match(command.message, /Rebase on main\.$/u)
  assert.equal(h.sent[0]!.clientId, 'studio-agent:ws-caller:agent-1')
})

test("the person's own script sends the words as written", async () => {
  const h = harness()
  await h.call('conversation.send', { workspaceId: 'ws-target', message: 'Hello' }, script)
  assert.equal((h.sent[0]!.command as { message: string }).message, 'Hello')
})

test('a chat in a turn holds the message for its end; one that turned busy on the way is held too', async () => {
  const working = harness({ summary: () => session({ status: 'active', phase: 'running' }) })
  const held = await working.call('conversation.send', { workspaceId: 'ws-target', message: 'Next: docs.' })
  assert.equal(body(held).queued, true)
  assert.equal((working.sent[0]!.command as { queue?: true }).queue, true)

  const raced = harness({ answers: [{ ok: false, code: 'busy', message: 'A turn is running.' }] })
  const result = await raced.call('conversation.send', { workspaceId: 'ws-target', message: 'Next: docs.' })
  assert.equal(body(result).queued, true)
  assert.deepEqual(
    raced.sent.map((sent) => (sent.command as { queue?: true }).queue),
    [undefined, true],
    'refused busy, it is held rather than lost',
  )
})

test('a steer goes into the running turn, and says so when the CLI could only queue it', async () => {
  const h = harness({
    summary: () => session({ status: 'active', phase: 'running' }),
    answers: [
      { ok: true },
      { ok: true, notice: 'This agent cannot take a message while it is working, so it is queued.' },
    ],
  })
  const steered = await h.call('conversation.send', { workspaceId: 'ws-target', message: 'Stop.', mode: 'steer' })
  assert.equal(body(steered).queued, false)
  assert.equal((h.sent[0]!.command as { steer?: true }).steer, true)
  const queued = await h.call('conversation.send', { workspaceId: 'ws-target', message: 'Stop.', mode: 'steer' })
  assert.equal(body(queued).queued, true)
  assert.match(body(queued).notice, /queued/u)
})

test('an agent may not message a chat that runs looser than it does', async () => {
  const strict = harness({ callerPreset: 'manual', preset: 'bypass' })
  const refused = await strict.call('conversation.send', { workspaceId: 'ws-target', message: 'rm -rf build' })
  assert.equal(errorCode(refused), 'permission_escalation')
  assert.equal(strict.sent.length, 0)

  const equal = harness({ callerPreset: 'auto', preset: 'auto' })
  assert.equal((await equal.call('conversation.send', { workspaceId: 'ws-target', message: 'ok' })).isError, undefined)

  // An agent whose own preset cannot be found is held to the strictest.
  const unknown = harness({ callerPreset: null, preset: 'auto' })
  const held = await unknown.call('conversation.send', { workspaceId: 'ws-target', message: 'ok' })
  assert.equal(errorCode(held), 'permission_escalation')

  // The person's own scripts are not capped, as a launch from them is not.
  const own = harness({ callerPreset: 'manual', preset: 'bypass' })
  assert.equal(
    (await own.call('conversation.send', { workspaceId: 'ws-target', message: 'ok' }, script)).isError,
    undefined,
  )
})

test('an agent cannot send to, wait on or stop its own chat', async () => {
  const h = harness()
  for (const name of ['conversation.send', 'conversation.wait', 'conversation.interrupt']) {
    const result = await h.call(name, { workspaceId: 'ws-caller', message: 'hi' })
    assert.equal(errorCode(result), 'own_chat', name)
  }
  assert.equal(h.sent.length, 0)
})

test('a chat is named by its workspace, and by its agent where the workspace holds several', async () => {
  const h = harness({ agents: { 'ws-target': ['agent-1', 'agent-2'] } })
  assert.equal(errorCode(await h.call('conversation.read', { workspaceId: 'ws-target' })), 'ambiguous')
  assert.equal(
    errorCode(await h.call('conversation.read', { workspaceId: 'ws-target', agentId: 'agent-9' })),
    'unknown_agent',
  )
  assert.equal(errorCode(await h.call('conversation.read', { workspaceId: 'ws-gone' })), 'unknown_workspace')
  const read = await h.call('conversation.read', { workspaceId: 'ws-target', agentId: 'agent-2' })
  assert.equal(body(read).agentId, 'agent-2')
})

test('a read is the words alone, a page at a time, with the cursor to the earlier turns', async () => {
  const h = harness()
  const read = body(await h.call('conversation.read', { workspaceId: 'ws-target', turns: 2 }))
  assert.deepEqual(h.pages[0], { turns: 2 })
  assert.equal(read.title, 'Parser fix')
  assert.equal(read.hasMore, true)
  assert.equal(read.before, 42)
  assert.ok(read.messages.some((message: { from: string }) => message.from === 'person'))
  assert.ok(read.messages.some((message: { from: string }) => message.from === 'agent'))
  assert.ok(!JSON.stringify(read.messages).includes('FULL-TOOL-OUTPUT'), 'no step output reaches the caller')

  await h.call('conversation.read', { workspaceId: 'ws-target', before: 42 })
  assert.deepEqual(h.pages[1], { turns: 3, before: 42 })
  assert.equal(
    errorCode(await h.call('conversation.read', { workspaceId: 'ws-target', turns: 99 })),
    'invalid_arguments',
  )
})

test('a read inside its budget keeps the newest messages, cuts the one that does not fit, and counts the rest', () => {
  const whole = chatMessagesOf(exportChatEvents(), 100_000)
  assert.equal(whole.omitted, 0)
  assert.ok(whole.messages.length >= 2)
  const newest = whole.messages.at(-1)!
  const tight = chatMessagesOf(exportChatEvents(), newest.text.length + 250)
  assert.equal(tight.messages.at(-1)!.text, newest.text, 'the newest message is whole')
  assert.ok(tight.omitted > 0)
  assert.ok(tight.messages.length + tight.omitted <= whole.messages.length)
  const total = tight.messages.reduce((sum, message) => sum + message.text.length, 0)
  assert.ok(total <= newest.text.length + 250)
})

test('a wait answers at once when the chat is already there, and on the first condition reached', async () => {
  const idle = harness({ summary: () => session({ status: 'ready', phase: 'completed', lastAssistantTail: 'Done.' }) })
  const now = body(await idle.call('conversation.wait', { workspaceId: 'ws-target' }))
  assert.equal(now.reached, 'idle')
  assert.equal(now.waitedMs, 0)
  assert.equal(now.lastReply, 'Done.')

  const asking = harness({ summary: () => session({ status: 'awaiting_approval', phase: 'waiting_for_approval' }) })
  assert.equal(body(await asking.call('conversation.wait', { workspaceId: 'ws-target' })).reached, 'needs_input')
  const onlyIdle = body(
    await asking.call('conversation.wait', { workspaceId: 'ws-target', until: ['idle'], timeoutMs: 2_000 }),
  )
  assert.equal(onlyIdle.reached, null, 'a chat waiting on the person is not idle')
  assert.equal(onlyIdle.waitedMs, 2_000)
})

test('"finished" waits for a turn that ends after the send, and a wait gives up at its timeout', async () => {
  const clock = { now: 10_000 }
  // The turn runs for three seconds of the wait, then ends.
  const summary = () =>
    clock.now < 13_000
      ? session({ status: 'active', phase: 'running', lastTurnEndedAt: 5_000 })
      : session({ status: 'ready', phase: 'completed', lastTurnEndedAt: 13_000 })
  const h = harness({ clock, summary })
  const finished = body(
    await h.call('conversation.wait', { workspaceId: 'ws-target', until: ['finished'], since: 9_000 }),
  )
  assert.equal(finished.reached, 'finished')
  assert.equal(finished.state.lastTurnEndedAt, 13_000)

  // A turn that ended before `since` is not the one waited for.
  const before = body(
    await h.call('conversation.wait', {
      workspaceId: 'ws-target',
      until: ['finished'],
      since: 20_000,
      timeoutMs: 1_000,
    }),
  )
  assert.equal(before.reached, null)

  const forever = harness({ summary: () => session({ status: 'active', phase: 'running' }) })
  const timedOut = body(await forever.call('conversation.wait', { workspaceId: 'ws-target' }))
  assert.equal(timedOut.reached, null)
  assert.equal(timedOut.waitedMs, CHAT_WAIT_DEFAULT_MS)
})

test('an interrupt stops a running turn and leaves a chat not in one alone', async () => {
  const idle = harness({ summary: () => undefined })
  const left = body(await idle.call('conversation.interrupt', { workspaceId: 'ws-target' }))
  assert.equal(left.interrupted, false)
  assert.equal(left.state.phase, 'at_rest')
  assert.equal(idle.sent.length, 0)

  const running = harness({ summary: () => session({ status: 'active', phase: 'running' }) })
  const stopped = body(await running.call('conversation.interrupt', { workspaceId: 'ws-target' }))
  assert.equal(stopped.interrupted, true)
  assert.deepEqual(running.sent[0]!.command, { kind: 'interrupt' })
})

test('the chat-to-chat tools are for agents on this machine, never a paired device', () => {
  for (const name of ['conversation.send', 'conversation.read', 'conversation.wait', 'conversation.interrupt'])
    assert.ok(localOnlyGatewayToolReason(name), name)
  assert.equal(localOnlyGatewayToolReason('conversation.create'), null)
})
