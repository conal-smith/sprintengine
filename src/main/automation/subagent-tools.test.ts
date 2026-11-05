import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentState } from '../../shared/agent-state'
import { isAgentLaunchingGatewayTool } from '../../shared/conversation/approvalRules'
import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import type { LaunchedAgentLink } from '../agent-launch-notices'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { createSubagentTools, type SubagentToolsDeps } from './subagent-tools'
import { localOnlyGatewayToolReason } from './tailnet/tailnet-scopes'

const WORKSPACE = 'ws-1'
const PARENT = 'agent-parent'
const caller: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: WORKSPACE, agentId: PARENT },
} as McpConnectionContext

function chatRecord(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'opus' },
    ...overrides,
  } as AgentState
}

function summary(overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: 'conv',
    workspaceId: WORKSPACE,
    agentId: 'x',
    status: 'ready',
    ...overrides,
  } as ConversationSessionSummary
}

function harness(
  options: {
    ceiling?: NonNullable<ReturnType<SubagentToolsDeps['resolveAgentPermissionPreset']>>
    launched?: (request: ConversationLaunchRequest, childId: string) => ConversationLaunchResult
    result?: { text: string; truncated: boolean }
    /** Where a sub-agent's session stands, each time it is read. */
    sessions?: (agentId: string, reads: number) => ConversationSessionSummary | undefined
  } = {},
) {
  const agents: Record<string, AgentState> = { [PARENT]: chatRecord() }
  const requests: ConversationLaunchRequest[] = []
  const links: LaunchedAgentLink[] = []
  const stops: string[] = []
  const dismissed: string[] = []
  const reads = new Map<string, number>()
  let clock = 1_000
  const deps: SubagentToolsDeps = {
    launch: async (request) => {
      requests.push(request)
      const agentId = `agent-child-${requests.length}`
      const answer = options.launched?.(request, agentId)
      if (answer && !answer.ok) return answer
      agents[agentId] = chatRecord({
        name: request.name ?? '',
        conversation: { providerId: `${request.cli}-agent`, modelId: request.cliModel ?? 'default' },
        ...(request.permissionPreset ? { cliPermissionPreset: request.permissionPreset } : {}),
        ...(request.mode ? { conversationMode: request.mode } : {}),
        ...(request.subagentOf ? { subagentOf: request.subagentOf } : {}),
        ...(request.subagentReadOnly ? { subagentReadOnly: true as const } : {}),
      })
      return (
        answer ?? {
          ok: true,
          workspaceId: WORKSPACE,
          agentId,
          name: request.name ?? '',
          cli: request.cli ?? '',
          providerId: 'p',
          modelId: 'm',
          sessionId: `conv-${agentId}`,
        }
      )
    },
    resolveAgentPermissionPreset: () => options.ceiling ?? 'bypass',
    isKnownCli: (cli) => cli !== 'missing',
    displayNames: (cli, model) => ({ cli: cli === 'cursor' ? 'Cursor' : cli, model: model ? `Model ${model}` : null }),
    linkLaunchedAgent: (link) => (links.push(link), { linked: true }),
    dismissNotice: (sessionId) => dismissed.push(sessionId),
    subagents: {
      stop: async ({ agentId }) => {
        stops.push(agentId)
      },
      fail: ({ agentId }, error) => {
        agents[agentId] = { ...agents[agentId]!, subagentEnd: { at: clock, status: 'failed', error } }
      },
      result: async () => options.result ?? null,
    },
    chats: {
      agentsOf: (workspaceId) => (workspaceId === WORKSPACE ? agents : null),
      session: (_workspaceId, agentId) => {
        const read = (reads.get(agentId) ?? 0) + 1
        reads.set(agentId, read)
        return (
          options.sessions?.(agentId, read) ??
          summary({ agentId, status: 'active', phase: 'running', turnStartedAt: 1 })
        )
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    },
  }
  const tools = createSubagentTools(deps)
  const call = (name: string, args: Record<string, unknown>, context: McpConnectionContext | undefined = caller) =>
    tools.find((tool) => tool.name === name)!.handler(args, context)
  return { agents, requests, links, stops, dismissed, call }
}

const code = (result: McpToolResult) => (result.structuredContent as { error?: { code?: string } }).error?.code
const body = (result: McpToolResult) => result.structuredContent as Record<string, unknown>
const finished = (agentId: string) => summary({ agentId, status: 'ready', phase: 'completed', lastTurnEndedAt: 2_000 })

test('a start writes who the sub-agent belongs to and hands it only its task', async () => {
  const h = harness()
  const started = await h.call('subagent.start', {
    task: 'Check the build',
    cli: 'cursor',
    cliModel: 'muse',
    role: 'review',
  })
  assert.equal(started.isError, undefined, JSON.stringify(started.structuredContent))
  const request = h.requests[0]!
  assert.equal(request.workspaceId, WORKSPACE)
  assert.equal(request.newChat, undefined)
  assert.deepEqual(request.subagentOf, { agentId: PARENT, startedAt: 1_000 })
  assert.equal(request.prompt, 'Act as the review sub-agent for this task.\n\nCheck the build')
  assert.equal(request.name, 'Cursor · Model muse')
  assert.equal(body(started).subagentId, 'agent-child-1')
  assert.equal(body(started).status, 'working')
  assert.match(String(body(started).next), /notice/)
  assert.equal(h.links[0]?.parent.agentId, PARENT)
  assert.equal(h.links[0]?.child.transport, 'conversation')
})

test("a general task goes as written, on the caller's own CLI and preset by default", async () => {
  const h = harness({ ceiling: 'auto' })
  await h.call('subagent.start', { task: 'Look around' })
  assert.equal(h.requests[0]?.prompt, 'Look around')
  assert.equal(h.requests[0]?.cli, 'claude-code')
  assert.equal(h.requests[0]?.permissionPreset, 'auto')
})

test('read-only maps to what holds each CLI, and a CLI with none is refused', async () => {
  const cursor = harness({ ceiling: 'manual' })
  const asked = await cursor.call('subagent.start', {
    task: 'Review',
    cli: 'cursor',
    readOnly: true,
    permissionPreset: 'bypass',
  })
  assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent))
  assert.equal(cursor.requests[0]?.mode, 'ask')
  assert.equal(cursor.requests[0]?.permissionPreset, 'none')
  assert.equal(cursor.requests[0]?.subagentReadOnly, true)
  assert.equal(body(asked).readOnly, true)
  assert.equal(body(asked).mode, 'ask')

  const claude = harness()
  await claude.call('subagent.start', { task: 'Review', cli: 'claude-code', readOnly: true })
  assert.equal(claude.requests[0]?.mode, 'ask')
  assert.equal(claude.requests[0]?.permissionPreset, 'manual')

  const codex = harness()
  await codex.call('subagent.start', { task: 'Review', cli: 'codex', readOnly: true })
  assert.equal(codex.requests[0]?.mode, undefined)
  assert.equal(codex.requests[0]?.permissionPreset, 'manual')

  const grok = harness()
  assert.equal(
    code(await grok.call('subagent.start', { task: 'Review', cli: 'grok', readOnly: true })),
    'read_only_unsupported',
  )
  assert.equal(grok.requests.length, 0)
})

test('a sub-agent runs no looser than its parent', async () => {
  const h = harness({ ceiling: 'manual' })
  assert.equal(
    code(await h.call('subagent.start', { task: 'Go', permissionPreset: 'bypass' })),
    'permission_escalation',
  )
  assert.equal(h.requests.length, 0)
})

test('only a chat that is not itself a sub-agent can start one', async () => {
  const h = harness()
  const outsider = { metadata: { kind: 'local-script' } } as unknown as McpConnectionContext
  assert.equal(code(await h.call('subagent.start', { task: 'Go' }, outsider)), 'not_a_chat')
  h.agents[PARENT] = chatRecord({ runtimeKind: 'terminal' } as Partial<AgentState>)
  assert.equal(code(await h.call('subagent.start', { task: 'Go' })), 'not_a_chat')
  h.agents[PARENT] = chatRecord({ subagentOf: { agentId: 'agent-lead', startedAt: 1 } })
  assert.equal(code(await h.call('subagent.start', { task: 'Go' })), 'nested_subagent')
  assert.equal(h.requests.length, 0)
})

test('a fifth running sub-agent is refused, and one that ended makes room', async () => {
  const ended = new Set<string>()
  const h = harness({ sessions: (agentId) => (ended.has(agentId) ? finished(agentId) : undefined) })
  for (let run = 0; run < 4; run += 1) {
    const started = await h.call('subagent.start', { task: `Run ${run}` })
    assert.equal(started.isError, undefined)
  }
  assert.equal(code(await h.call('subagent.start', { task: 'One too many' })), 'too_many_subagents')
  ended.add('agent-child-1')
  assert.equal((await h.call('subagent.start', { task: 'Now there is room' })).isError, undefined)
})

test('a start refuses what it cannot run, and takes a launch failure in its own words', async () => {
  const h = harness()
  assert.equal(code(await h.call('subagent.start', { task: '   ' })), 'invalid_arguments')
  assert.equal(code(await h.call('subagent.start', { task: '--flag' })), 'prompt_reads_as_option')
  assert.equal(code(await h.call('subagent.start', { task: 'Go', cli: 'missing' })), 'unknown_cli')
  assert.equal(code(await h.call('subagent.start', { task: 'Go', cli: 'generic-shell' })), 'cli_not_conversational')
  assert.equal(code(await h.call('subagent.start', { task: 'Go', timeoutMs: 700_000 })), 'invalid_arguments')

  const effort = harness({
    launched: () => ({ ok: false, code: 'unsupported_effort', message: 'No such level.' }),
  })
  assert.equal(code(await effort.call('subagent.start', { task: 'Go', effort: 'huge' })), 'unsupported_effort')
  const failed = harness({
    launched: () => ({ ok: false, code: 'conversation_start_failed', message: 'The model is unknown.' }),
  })
  const refused = await failed.call('subagent.start', { task: 'Go', cliModel: 'nope' })
  assert.equal(code(refused), 'launch_failed')
  assert.match(JSON.stringify(refused.structuredContent), /The model is unknown/)
})

test('wait answers with the result when the sub-agent finishes, and the notice saying the same is dropped', async () => {
  const h = harness({
    result: { text: 'All good.', truncated: true },
    sessions: (agentId, reads) => (agentId !== PARENT && reads > 3 ? finished(agentId) : undefined),
  })
  const done = await h.call('subagent.start', { task: 'Review', wait: true })
  assert.equal(body(done).status, 'completed')
  assert.equal(body(done).result, 'All good.')
  assert.equal(body(done).resultTruncated, true)
  assert.equal(body(done).waitTimedOut, false)
  assert.equal(body(done).next, undefined)
  assert.deepEqual(h.dismissed, ['conv'])
})

test('a recorded end outranks what the session says, and a repeated read answers the same', async () => {
  const h = harness({ result: { text: 'Done.', truncated: false } })
  const started = await h.call('subagent.start', { task: 'Review' })
  const subagentId = String(body(started).subagentId)
  h.agents[subagentId] = {
    ...h.agents[subagentId]!,
    subagentEnd: { at: 3_000, status: 'failed', error: 'The model is gone.' },
  }
  const first = await h.call('subagent.status', { subagentId })
  assert.equal(body(first).status, 'failed')
  assert.equal(body(first).error, 'The model is gone.')
  assert.equal(body(first).endedAt, 3_000)
  assert.deepEqual(body(await h.call('subagent.status', { subagentId })), body(first))
})

test('a parent working in a worktree of its own gives its sub-agent the same folder', async () => {
  const h = harness()
  h.agents[PARENT] = chatRecord({ execution: { mode: 'worktree', worktreeId: null, cwd: '/repo/.wt/a' } })
  await h.call('subagent.start', { task: 'Review' })
  assert.equal(h.requests[0]?.worktreePath, '/repo/.wt/a')
})

test('wait answers when the sub-agent needs the person', async () => {
  const h = harness({
    sessions: (agentId) => summary({ agentId, status: 'awaiting_approval', phase: 'waiting_for_approval' }),
  })
  const waiting = await h.call('subagent.start', { task: 'Edit', wait: true })
  assert.equal(body(waiting).status, 'needs_input')
  assert.equal(body(waiting).waitTimedOut, false)
})

test('a wait that times out says so, cancels nothing, and can be waited on again', async () => {
  let done = false
  const h = harness({ sessions: (agentId) => (done ? finished(agentId) : undefined) })
  const first = await h.call('subagent.start', { task: 'Slow', wait: true, timeoutMs: 1_000 })
  assert.equal(body(first).waitTimedOut, true)
  assert.equal(body(first).status, 'working')
  assert.deepEqual(h.stops, [])
  done = true
  const again = await h.call('subagent.status', { subagentId: body(first).subagentId, wait: true })
  assert.equal(body(again).status, 'completed')
  assert.equal(body(again).waitTimedOut, false)
})

test('a first message that fails reads as failed, with its reason', async () => {
  const h = harness({
    launched: (request) => {
      request.onFirstSendFailed?.('The first message was refused.')
      return undefined as unknown as ConversationLaunchResult
    },
  })
  const failed = await h.call('subagent.start', { task: 'Go', wait: true })
  assert.equal(body(failed).status, 'failed')
  assert.equal(body(failed).error, 'The first message was refused.')
})

test('status answers its parent alone', async () => {
  const h = harness()
  const started = await h.call('subagent.start', { task: 'Go' })
  const subagentId = body(started).subagentId
  assert.equal(body(await h.call('subagent.status', { subagentId })).status, 'working')
  const sibling = {
    metadata: { kind: 'studio-agent', workspaceId: WORKSPACE, agentId: 'agent-other' },
  } as McpConnectionContext
  h.agents['agent-other'] = chatRecord()
  assert.equal(code(await h.call('subagent.status', { subagentId }, sibling)), 'not_your_subagent')
  assert.equal(code(await h.call('subagent.status', { subagentId: 'agent-gone' })), 'unknown_subagent')
  assert.equal(code(await h.call('subagent.status', { subagentId: PARENT })), 'unknown_subagent')
})

test('cancel stops a working sub-agent and leaves a finished one as it is', async () => {
  let done = false
  const h = harness({ sessions: (agentId) => (done ? finished(agentId) : undefined) })
  const started = await h.call('subagent.start', { task: 'Go' })
  const subagentId = body(started).subagentId
  await h.call('subagent.cancel', { subagentId })
  assert.deepEqual(h.stops, [subagentId])
  done = true
  const after = await h.call('subagent.cancel', { subagentId, reason: 'Not needed' })
  assert.equal(body(after).status, 'completed')
  assert.equal(h.stops.length, 1)
})

test("the tools are for this machine's chats alone, and a person who asks to be asked sees every start", () => {
  for (const name of ['subagent.start', 'subagent.status', 'subagent.cancel']) {
    assert.notEqual(localOnlyGatewayToolReason(name), null, name)
  }
  assert.equal(isAgentLaunchingGatewayTool(STUDIO_MCP_SERVER_ID, 'subagent.start'), true)
  assert.equal(isAgentLaunchingGatewayTool(STUDIO_MCP_SERVER_ID, 'subagent.status'), false)
})
