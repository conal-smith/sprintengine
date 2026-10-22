import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ScheduledAgentView } from '../../shared/scheduled-agents'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import type { ConversationLaunchRequest } from '../conversation-launch-service'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { createConversationTools } from './conversation-tools'
import { createAgentPermissionResolver, type AgentPermissionResolver } from './launch-permission-cap'

const WORKSPACE: Workspace = {
  id: 'ws-1',
  name: 'App',
  mode: 'standard',
  folderPath: '/Users/dev/app',
  templateId: 'solo',
  layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
  agents: {},
  worktreeState: { containerPath: null, entries: {}, updatedAt: null },
  memory: { relativeRoot: null },
  editorState: { openFiles: [], activeFilePath: null },
  createdAt: 1,
} as Workspace

function snapshot(): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces: [WORKSPACE],
      activeWorkspaceId: 'ws-1',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
    },
  } as unknown as WorkspaceSyncSnapshot
}

const AGENT_CALLER: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-caller', cliId: 'claude-code' },
}
const EXTERNAL_CALLER: McpConnectionContext = { metadata: { kind: 'external-local' } }
const PAIRED_DEVICE: McpConnectionContext = {
  metadata: { kind: 'remote-tailnet', deviceId: 'dev-1', deviceName: 'dev-macbook-air', agentId: 'agent-caller' },
}

type Harness = {
  launches: AgentLaunchRequest[]
  chats: ConversationLaunchRequest[]
  created: unknown[]
  ran: unknown[]
  resolved: number
  call(tool: string, args: Record<string, unknown>, context: McpConnectionContext): Promise<McpToolResult>
}

/**
 * The launching tools over fake backends, the caller's preset answered by
 * `callerPreset` (null: the caller cannot be found).
 */
function harness(
  callerPreset: CliPermissionPreset | null,
  options: { scheduled?: ScheduledAgentView[] } = {},
): Harness {
  const sessions: TerminalSessionSnapshot[] = []
  const h: Harness = {
    launches: [],
    chats: [],
    created: [],
    ran: [],
    resolved: 0,
    call: async (name, args, context) => {
      const registration = tools.find((candidate) => candidate.name === name)
      assert.ok(registration, `tool ${name} is served`)
      return registration.handler(args, context)
    },
  }
  const resolveAgentPermissionPreset: AgentPermissionResolver = () => {
    h.resolved += 1
    return callerPreset
  }
  const backends = {
    getWorkspaceSyncSnapshot: snapshot,
    listTerminalSessions: () => sessions,
    resolveAgentPermissionPreset,
    launchAgent: async (request: AgentLaunchRequest) => {
      h.launches.push(request)
      const agentId = `agent-launched-${h.launches.length}`
      const sessionId = `sess-${h.launches.length}`
      sessions.push({
        sessionId,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId,
        agentName: 'Scout',
        cli: 'claude-code',
        cwd: '/Users/dev/app',
        processAlive: true,
        suspended: false,
        visible: false,
        startedAt: 1,
        lastOutputAt: 1,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'idle', since: 1 },
        agentRecord: { agentId, name: 'Scout', cli: 'claude-code', cliPermissionPreset: request.permissionPreset },
      } as unknown as TerminalSessionSnapshot)
      return { ok: true, workspaceId: 'ws-1', agentId, sessionId, cli: 'claude-code', executionId: sessionId }
    },
    listPlugins: () => [],
    ensureBuiltinSkillInstalled: async () => true,
    readBacklogItem: async (_root: string, relativePath: string) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
      body: '',
    }),
    backlogWrite: { addOrUpdateLink: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }) },
    defaultChatCli: () => 'claude-code',
    getScheduledAgents: () => ({
      list: () => options.scheduled ?? [],
      get: (id: string) => (options.scheduled ?? []).find((agent) => agent.id === id) ?? null,
      create: async (input: unknown) => {
        h.created.push(input)
        return { ok: true, agent: scheduledAgent(input as Partial<ScheduledAgentView>) }
      },
      runNow: async (id: string) => {
        h.ran.push(id)
        return { ok: true, run: { at: 0, ok: true, workspaceId: 'ws-run' } }
      },
    }),
    now: () => 0,
    sleep: async () => {},
  } as unknown as AutomationBackends
  const tools: McpToolRegistration[] = [
    ...createAutomationTools(backends),
    ...createConversationTools({
      resolveAgentPermissionPreset,
      lifecycle: {
        settle: () => assert.fail('no chat is settled here'),
        visit: () => assert.fail('no chat is visited here'),
        markUnread: () => assert.fail('no chat is marked unread here'),
        snooze: () => assert.fail('nothing is snoozed here'),
        highlight: () => assert.fail('nothing is starred here'),
        setAutoSettle: () => assert.fail('no Auto-settle is switched here'),
      },
      launch: async (request) => {
        h.chats.push(request)
        return {
          ok: true,
          workspaceId: 'ws-1',
          agentId: 'agent-chat-1',
          name: 'Ada',
          cli: 'claude-code',
          providerId: 'claude-agent',
          modelId: 'default',
          sessionId: 'conv-1',
        }
      },
    }),
  ]
  return h
}

// The four tools that start an agent now, with the arguments each needs.
const LAUNCHING_TOOLS: ReadonlyArray<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'agent.launch', args: { workspaceId: 'ws-1' } },
  { tool: 'terminal.create', args: { workspaceId: 'ws-1' } },
  { tool: 'backlog.work', args: { path: 'backlog/unfiled/item.md' } },
  { tool: 'conversation.create', args: { workspaceId: 'ws-1' } },
]

// The preset each launch was forwarded with, whichever service took it.
function forwarded(h: Harness): Array<CliPermissionPreset | undefined> {
  return [...h.launches, ...h.chats].map((request) => request.permissionPreset)
}

function errorCode(result: McpToolResult): string | undefined {
  return (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code
}

function errorMessage(result: McpToolResult): string {
  return (result.structuredContent as { error?: { message?: string } } | undefined)?.error?.message ?? ''
}

function scheduledAgent(fields: Partial<ScheduledAgentView>): ScheduledAgentView {
  return {
    id: 'sa-1',
    prompt: 'tidy up',
    schedule: { cron: '0 9 * * *', timezone: 'UTC' },
    folderPath: '/Users/dev/app',
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: null,
    skills: [],
    mcpServers: [],
    worktree: null,
    ownerModuleId: null,
    createdAt: 0,
    updatedAt: 0,
    lastRun: null,
    lastFailureSeenAt: null,
    nextRunAt: null,
    ...fields,
  }
}

const SCHEDULE_ARGS = { workspaceId: 'ws-1', prompt: 'tidy up', cron: '0 9 * * *' }

// The preset each scheduled agent was stored with.
function storedPresets(h: Harness): Array<CliPermissionPreset | null> {
  return h.created.map((input) => (input as { permissionPreset: CliPermissionPreset | null }).permissionPreset)
}

for (const { tool, args } of LAUNCHING_TOOLS) {
  test(`${tool}: an agent on none cannot launch one on bypass`, async () => {
    const h = harness('none')
    const result = await h.call(tool, { ...args, permissionPreset: 'bypass' }, AGENT_CALLER)
    assert.equal(result.isError, true)
    assert.equal(errorCode(result), 'permission_escalation')
    assert.match(errorMessage(result), /only launch agents at that level or stricter/u)
    assert.deepEqual(forwarded(h), [], 'nothing was launched')
  })

  test(`${tool}: an agent on none cannot launch on bypass by its retired spelling either`, async () => {
    const h = harness('none')
    const result = await h.call(tool, { ...args, permissionPreset: 'bypass_all' }, AGENT_CALLER)
    assert.equal(errorCode(result), 'permission_escalation')
    assert.deepEqual(forwarded(h), [])
  })

  test(`${tool}: an agent on none that names no preset launches on none`, async () => {
    const h = harness('none')
    const result = await h.call(tool, args, AGENT_CALLER)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    assert.deepEqual(forwarded(h), ['none'])
  })

  test(`${tool}: an agent on none may launch on none`, async () => {
    const h = harness('none')
    const result = await h.call(tool, { ...args, permissionPreset: 'none' }, AGENT_CALLER)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    assert.deepEqual(forwarded(h), ['none'])
  })

  test(`${tool}: an agent on bypass may launch on bypass or none, and an omitted preset is left to the machine`, async () => {
    const h = harness('bypass')
    for (const preset of ['bypass', 'none', undefined]) {
      const result = await h.call(
        tool,
        preset === undefined ? args : { ...args, permissionPreset: preset },
        AGENT_CALLER,
      )
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    }
    assert.deepEqual(forwarded(h), ['bypass', 'none', undefined])
  })

  test(`${tool}: an agent that cannot be found is capped at the strictest preset`, async () => {
    const h = harness(null)
    const refused = await h.call(tool, { ...args, permissionPreset: 'bypass' }, AGENT_CALLER)
    assert.equal(errorCode(refused), 'permission_escalation')
    const omitted = await h.call(tool, args, AGENT_CALLER)
    assert.equal(omitted.isError, undefined, JSON.stringify(omitted.structuredContent))
    assert.deepEqual(forwarded(h), ['manual'])
  })

  test(`${tool}: a caller with no agent identity launches as it did before`, async () => {
    const h = harness('none')
    // backlog.work finds its project from the caller's workspace or from a
    // folder it names; an external caller names the folder.
    const external = tool === 'backlog.work' ? { ...args, projectRoot: '/Users/dev/app' } : args
    await h.call(tool, { ...external, permissionPreset: 'bypass' }, EXTERNAL_CALLER)
    await h.call(tool, external, EXTERNAL_CALLER)
    assert.deepEqual(forwarded(h), ['bypass', undefined])
    assert.equal(h.resolved, 0, 'no agent was looked up')
  })

  test(`${tool}: a paired device launches as it did before`, async () => {
    const h = harness('none')
    const remote = tool === 'backlog.work' ? { ...args, projectRoot: '/Users/dev/app' } : args
    await h.call(tool, { ...remote, permissionPreset: 'bypass' }, PAIRED_DEVICE)
    assert.deepEqual(forwarded(h), ['bypass'])
    assert.equal(h.resolved, 0)
  })
}

test('schedule.create: an agent on none cannot schedule an agent on bypass', async () => {
  const h = harness('none')
  const result = await h.call('schedule.create', { ...SCHEDULE_ARGS, permissionPreset: 'bypass' }, AGENT_CALLER)
  assert.equal(errorCode(result), 'permission_escalation')
  assert.deepEqual(h.created, [], 'nothing was written')
})

test('schedule.create: an agent on none that names no preset stores none, not the run-time choice', async () => {
  const h = harness('none')
  const result = await h.call('schedule.create', SCHEDULE_ARGS, AGENT_CALLER)
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  assert.deepEqual(storedPresets(h), ['none'])
})

test('schedule.create: an agent on none may schedule an agent on none', async () => {
  const h = harness('none')
  const result = await h.call('schedule.create', { ...SCHEDULE_ARGS, permissionPreset: 'none' }, AGENT_CALLER)
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  assert.deepEqual(storedPresets(h), ['none'])
})

test('schedule.create: an agent on bypass stores the preset exactly as sent', async () => {
  const h = harness('bypass')
  for (const preset of ['bypass', 'none', undefined]) {
    const args = preset === undefined ? SCHEDULE_ARGS : { ...SCHEDULE_ARGS, permissionPreset: preset }
    const result = await h.call('schedule.create', args, AGENT_CALLER)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  }
  assert.deepEqual(storedPresets(h), ['bypass', 'none', null])
})

test('schedule.create: an agent that cannot be found is capped at the strictest preset', async () => {
  const h = harness(null)
  const refused = await h.call('schedule.create', { ...SCHEDULE_ARGS, permissionPreset: 'bypass' }, AGENT_CALLER)
  assert.equal(errorCode(refused), 'permission_escalation')
  const omitted = await h.call('schedule.create', SCHEDULE_ARGS, AGENT_CALLER)
  assert.equal(omitted.isError, undefined, JSON.stringify(omitted.structuredContent))
  assert.deepEqual(storedPresets(h), ['manual'])
})

test('schedule.create: a caller with no agent identity stores the preset exactly as sent', async () => {
  const h = harness('none')
  await h.call('schedule.create', { ...SCHEDULE_ARGS, permissionPreset: 'bypass' }, EXTERNAL_CALLER)
  await h.call('schedule.create', SCHEDULE_ARGS, EXTERNAL_CALLER)
  assert.deepEqual(storedPresets(h), ['bypass', null])
  assert.equal(h.resolved, 0)
})

test('schedule.run: an agent on none cannot run a scheduled agent that may launch on bypass', async () => {
  // One that names no preset follows the person's choice at run time, which
  // the cap cannot see, so it counts as bypass.
  for (const permissionPreset of ['bypass', null] as const) {
    const h = harness('none', { scheduled: [scheduledAgent({ permissionPreset })] })
    const result = await h.call('schedule.run', { id: 'sa-1' }, AGENT_CALLER)
    assert.equal(errorCode(result), 'permission_escalation', String(permissionPreset))
    assert.deepEqual(h.ran, [])
  }
})

test('schedule.run: an agent on none may run a scheduled agent that launches on none', async () => {
  const h = harness('none', { scheduled: [scheduledAgent({ permissionPreset: 'none' })] })
  const result = await h.call('schedule.run', { id: 'sa-1' }, AGENT_CALLER)
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  assert.deepEqual(h.ran, ['sa-1'])
})

test('schedule.run: an agent on bypass, or a caller with no agent identity, runs any scheduled agent', async () => {
  for (const [preset, context] of [
    ['bypass', AGENT_CALLER],
    ['none', EXTERNAL_CALLER],
  ] as const) {
    const h = harness(preset, { scheduled: [scheduledAgent({ permissionPreset: 'bypass' })] })
    const result = await h.call('schedule.run', { id: 'sa-1' }, context)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    assert.deepEqual(h.ran, ['sa-1'])
  }
})

type ChatSession = { workspaceId: string; agentId: string; status: string; permissionPreset?: string }
type TerminalSession = {
  kind?: string
  workspaceId?: string
  launchWorkspaceId?: string
  agentId?: string
  processAlive: boolean
  agentRecord?: { cliPermissionPreset?: unknown }
}

function resolverOver(state: {
  chats?: ChatSession[]
  terminals?: TerminalSession[]
  records?: Record<string, unknown>
}): AgentPermissionResolver {
  return createAgentPermissionResolver({
    listConversationSessions: (agentId) => (state.chats ?? []).filter((session) => session.agentId === agentId),
    listTerminalSessions: () => state.terminals ?? [],
    readAgentRecordPreset: (workspaceId, agentId) => {
      const key = `${workspaceId}/${agentId}`
      return state.records && key in state.records ? { found: true, preset: state.records[key] } : { found: false }
    },
  })
}

test('resolver: a running chat answers with the preset it has now, not the one its record holds', () => {
  const resolve = resolverOver({
    chats: [{ workspaceId: 'ws-1', agentId: 'agent-a', status: 'ready', permissionPreset: 'none' }],
    records: { 'ws-1/agent-a': 'bypass' },
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test('resolver: a running chat that never chose a preset passes no override, so it reads as none', () => {
  const resolve = resolverOver({ chats: [{ workspaceId: 'ws-1', agentId: 'agent-a', status: 'active' }] })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test('resolver: a stopped chat is not the agent, so its record answers', () => {
  const resolve = resolverOver({
    chats: [{ workspaceId: 'ws-1', agentId: 'agent-a', status: 'stopped', permissionPreset: 'none' }],
    records: { 'ws-1/agent-a': 'bypass' },
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'bypass')
})

test('resolver: a live terminal main launched answers with its launch record', () => {
  const resolve = resolverOver({
    terminals: [
      {
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'agent-a',
        processAlive: true,
        agentRecord: { cliPermissionPreset: 'none' },
      },
    ],
    records: { 'ws-1/agent-a': 'bypass' },
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test("resolver: a window's terminal agent answers with its record, and an old record with none is auto", () => {
  const resolve = resolverOver({ records: { 'ws-1/agent-a': 'none', 'ws-1/agent-b': undefined } })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-b' }), 'auto')
})

test('resolver: the strictest of several sessions under one id wins', () => {
  const resolve = resolverOver({
    chats: [
      { workspaceId: 'ws-1', agentId: 'agent-a', status: 'ready', permissionPreset: 'bypass' },
      { workspaceId: 'ws-1', agentId: 'agent-a', status: 'ready', permissionPreset: 'none' },
    ],
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test("resolver: another workspace's agent of the same id does not answer", () => {
  const resolve = resolverOver({
    chats: [{ workspaceId: 'ws-2', agentId: 'agent-a', status: 'ready', permissionPreset: 'bypass' }],
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), null)
})

test("resolver: another workspace's terminal agent of the same id does not answer either way", () => {
  const terminal = (workspaceId: string, preset: string): TerminalSession => ({
    kind: 'agent',
    workspaceId,
    agentId: 'agent-1',
    processAlive: true,
    agentRecord: { cliPermissionPreset: preset },
  })
  const resolve = resolverOver({ terminals: [terminal('ws-2', 'none'), terminal('ws-1', 'bypass')] })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-1' }), 'bypass', "ws-2's none does not hold ws-1 back")
  assert.equal(resolve({ workspaceId: 'ws-2', agentId: 'agent-1' }), 'none', "ws-1's bypass lends ws-2 nothing")
  assert.equal(resolve({ workspaceId: 'ws-3', agentId: 'agent-1' }), null)
})

test('resolver: an agent moved to another chat answers for the chat its process names', () => {
  // Its process names ws-1, where it was launched; its session and its record
  // are in ws-2 now. A window-spawned terminal carries no launch record, so the
  // record is read from where the agent is.
  const moved: TerminalSession = {
    kind: 'agent',
    workspaceId: 'ws-2',
    launchWorkspaceId: 'ws-1',
    agentId: 'agent-1',
    processAlive: true,
  }
  const resolve = resolverOver({ terminals: [moved], records: { 'ws-2/agent-1': 'none' } })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-1' }), 'none')
  const launched = resolverOver({ terminals: [{ ...moved, agentRecord: { cliPermissionPreset: 'none' } }] })
  assert.equal(launched({ workspaceId: 'ws-1', agentId: 'agent-1' }), 'none')
})

test('resolver: a connection naming no workspace is held to the strictest agent of its id anywhere', () => {
  const resolve = resolverOver({
    chats: [
      { workspaceId: 'ws-1', agentId: 'agent-1', status: 'ready', permissionPreset: 'bypass' },
      { workspaceId: 'ws-2', agentId: 'agent-1', status: 'ready', permissionPreset: 'none' },
    ],
  })
  assert.equal(resolve({ agentId: 'agent-1' }), 'none')
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-1' }), 'bypass')
})

test('resolver: an agent nothing knows is unresolved', () => {
  assert.equal(resolverOver({})({ workspaceId: 'ws-1', agentId: 'agent-ghost' }), null)
  assert.equal(resolverOver({})({ agentId: 'agent-ghost' }), null)
})
