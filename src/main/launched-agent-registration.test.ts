import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { TerminalSessionSnapshot } from '../shared/electron-api'
import type { AgentLaunchRecord } from '../shared/agent-launch'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import type { WorkspaceSyncEvent } from '../shared/workspace-sync'
import { createAgentLaunchService } from './agent-launch-service'
import { createAutomationTools, type AutomationBackends } from './automation/automation-tools'
import type { McpToolRegistration } from './automation/mcp-socket-server'
import { createLaunchedAgentRegistration, withLaunchedAgentRegistration } from './launched-agent-registration'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceSyncService } from './workspace-sync-service'

// The host is the source of truth for what runs on it. These cases compose
// main the way app-services does — the real registry, the real sync bus, the
// real launch service, and the registration between them — over a fake
// terminal runtime, and drive launches through the gateway tools an MCP client
// calls. No window exists anywhere in this harness, which is the point: the
// registry must learn about the agent without one.

function sessionOf(overrides: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 'session-x',
    processAlive: true,
    kind: 'agent',
    visible: false,
    suspended: false,
    reapExempt: false,
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 1 },
    exitedAt: null,
    outputBufferLength: 0,
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    retainedOutputBytes: 0,
    ...overrides,
  }
}

/** The two runtime reads registration makes, over a plain session list. */
function runtimeOver(sessions: TerminalSessionSnapshot[]) {
  return {
    listLaunchedSessions: () => sessions.filter((session) => session.agentRecord !== undefined),
    hasSession: (sessionId: string) => sessions.some((session) => session.sessionId === sessionId),
  }
}

function launchRecord(overrides: Partial<AgentLaunchRecord> = {}): AgentLaunchRecord {
  return {
    agentId: 'agent-claude-code-4f2a1c',
    name: 'Scout',
    cli: 'claude-code',
    cliPermissionPreset: 'none',
    ...overrides,
  }
}

function host() {
  let clock = 1_000
  let suffix = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore(),
    now: () => (clock += 1),
    newWorkspaceId: () => 'ws-host',
  })
  const workspaceSync = createWorkspaceSyncService({ registry, now: () => clock })
  // Every event main announces: the IPC layer forwards these to every window
  // and the tailnet change feed forwards them to every paired device.
  const announced: WorkspaceSyncEvent[] = []
  workspaceSync.subscribeEvents((event) => announced.push(event))

  const created = workspaceSync.createWorkspace({ name: 'App', folderPath: '/Users/dev/app' }, 'ui')
  assert.ok(created.ok)
  const workspaceId = created.result.workspace.id
  // The agent the person made in their own window before any of this.
  const own = workspaceSync.dispatch({
    command: {
      type: 'workspace.update_agent',
      payload: { workspaceId, agentId: 'agent-1', patch: { name: 'Ada' }, configEditedAt: 1_500 },
    },
    sourceWindowId: 'primary',
  })
  assert.ok(own.ok)

  const sessions: TerminalSessionSnapshot[] = []
  const kills: string[] = []
  const composed = createAgentLaunchService({
    listWorkspaces: () => workspaceSync.getSnapshot().state.workspaces,
    getLaunchSettings: () => ({ ...emptyAgentLaunchSettings(), lastSelectedCli: 'claude-code' }),
    terminal: {
      list: () => sessions,
      spawn: async (payload) => {
        sessions.push(
          sessionOf({
            sessionId: payload.sessionId,
            workspaceId: payload.workspaceId,
            agentId: payload.agentId,
            agentName: payload.agentName,
            cli: payload.cli,
            cwd: payload.cwd,
            agentRecord: payload.agentRecord,
          }),
        )
        return { ok: true, sessionId: payload.sessionId }
      },
      kill: (sessionId) => {
        kills.push(sessionId)
        const session = sessions.find((candidate) => candidate.sessionId === sessionId)
        if (session) session.processAlive = false
      },
    },
    newSessionId: () => `session-${++suffix}`,
    newAgentSuffix: () => `4f2a${suffix}`,
  })
  const registration = createLaunchedAgentRegistration({
    registry,
    workspaceSync,
    ...runtimeOver(sessions),
  })
  const launchService = withLaunchedAgentRegistration(composed, registration)

  // The gateway tools an MCP client calls, over the same main-owned services.
  // Only what `agent.launch`, `terminal.create`, `terminal.list` and `workspace.list` read.
  const backends: Partial<AutomationBackends> = {
    getWorkspaceSyncSnapshot: () => workspaceSync.getSnapshot(),
    listTerminalSessions: () => sessions,
    launchAgent: (request) => launchService.launch(request),
    readRepositoryIdentity: async () => null,
    // A calling agent launches no looser than its own preset; this one has none on record.
    resolveAgentPermissionPreset: () => null,
    sleep: async () => {},
  }
  const tools = createAutomationTools(backends as AutomationBackends)

  return { registry, workspaceSync, announced, sessions, kills, registration, launchService, tools, workspaceId }
}

function tool(tools: McpToolRegistration[], name: string): McpToolRegistration {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found, `tool ${name} is registered`)
  return found
}

function agentIdsOf(h: ReturnType<typeof host>): string[] {
  return Object.keys(h.registry.getRecord(h.workspaceId)?.agents ?? {}).sort()
}

/** Launch through the gateway's `agent.launch`, and read back the agent and the session it runs in. */
async function launchOverGateway(h: ReturnType<typeof host>): Promise<{ agentId: string; sessionId: string }> {
  const launched = await tool(h.tools, 'agent.launch').handler({ workspaceId: h.workspaceId })
  assert.equal(launched.isError, undefined, JSON.stringify(launched.structuredContent))
  const { agent } = launched.structuredContent as {
    agent: { agentId: string; terminal: { sessionId: string } | null }
  }
  assert.ok(agent.terminal, 'the launch answers with the session it confirmed')
  return { agentId: agent.agentId, sessionId: agent.terminal.sessionId }
}

test('an agent launched through the gateway is in the host registry, and announced', async () => {
  const h = host()
  const before = h.announced.length
  const { agentId, sessionId } = await launchOverGateway(h)

  assert.deepEqual(agentIdsOf(h), ['agent-1', agentId].sort(), 'the workspace lists the launched agent beside its own')
  const agent = h.registry.getRecord(h.workspaceId)!.agents[agentId]!
  assert.equal(agent.cli, 'claude-code')
  assert.ok(agent.name && agent.name !== agentId, 'it carries the name the launch chose, like a local agent')
  assert.equal(agent.cliSessionId, sessionId, 'a window opening it attaches to the running session')
  assert.equal(agent.cliHasLaunched, true, 'and never spawns a second process beside it')

  const broadcast = h.announced
    .slice(before)
    .find((event) => event.type === 'workspace.agents_updated' && event.payload.agentId === agentId)
  assert.ok(broadcast, 'every window and every paired device is told at once')

  // The listing a client reads says the same.
  const listed = await tool(h.tools, 'workspace.list').handler({})
  const workspaces = (listed.structuredContent as { workspaces: Array<{ id: string; agentIds: string[] }> }).workspaces
  assert.deepEqual(workspaces.find((workspace) => workspace.id === h.workspaceId)?.agentIds.sort(), agentIdsOf(h))
})

test('an agent another agent opens with terminal.create is in the host registry, and announced', async () => {
  const h = host()
  const before = h.announced.length
  // The workspace's own agent asks: the terminal tools show it what it started.
  const caller = { metadata: { kind: 'studio-agent' as const, workspaceId: h.workspaceId, agentId: 'agent-1' } }
  const created = await tool(h.tools, 'terminal.create').handler({ workspaceId: h.workspaceId }, caller)
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
  const { agentId, sessionId, terminal } = created.structuredContent as {
    agentId: string
    sessionId: string
    terminal: { sessionId: string }
  }
  assert.equal(sessionId, terminal.sessionId, 'the top-level session id is the session the launch confirmed')

  assert.deepEqual(agentIdsOf(h), ['agent-1', agentId].sort(), 'the workspace lists the new agent beside its own')
  const agent = h.registry.getRecord(h.workspaceId)!.agents[agentId]!
  assert.equal(agent.cliSessionId, sessionId, 'a window opening it attaches to the running session')
  assert.equal(agent.cliHasLaunched, true, 'and never spawns a second process beside it')
  assert.ok(
    h.announced
      .slice(before)
      .some((event) => event.type === 'workspace.agents_updated' && event.payload.agentId === agentId),
    'every window is told at once',
  )

  // terminal.list reads the same session back, as an agent, to the agent that started it.
  const listed = await tool(h.tools, 'terminal.list').handler({ workspaceId: h.workspaceId, kind: 'agent' }, caller)
  const terminals = (listed.structuredContent as { terminals: Array<{ sessionId: string; agentId: string | null }> })
    .terminals
  assert.ok(terminals.some((row) => row.sessionId === sessionId && row.agentId === agentId))
})

test('agent.launch over MCP registers the agent too', async () => {
  const h = host()
  const launched = await tool(h.tools, 'agent.launch').handler({ workspaceId: h.workspaceId, name: 'Scout' })
  assert.equal(launched.isError, undefined, JSON.stringify(launched.structuredContent))
  const agents = h.registry.getRecord(h.workspaceId)!.agents
  const scout = Object.values(agents).find((agent) => agent.name === 'Scout')
  assert.ok(scout, 'the MCP-launched agent is in the registry under the name it was given')
})

test('the registration persists with the registry like any other agent', async () => {
  const store = createInMemoryWorkspaceRegistryStore()
  const registry = createWorkspaceRegistryService({ store, newWorkspaceId: () => 'ws-host' })
  const workspaceSync = createWorkspaceSyncService({ registry })
  const created = workspaceSync.createWorkspace({ name: 'App', folderPath: '/Users/dev/app' }, 'ui')
  assert.ok(created.ok)
  const sessions = [sessionOf({ sessionId: 's-1', workspaceId: 'ws-host', agentRecord: launchRecord() })]
  const registration = createLaunchedAgentRegistration({ registry, workspaceSync, ...runtimeOver(sessions) })
  assert.equal(registration.registerSession('s-1'), true)
  store.flush()

  // A restart: a fresh registry over the same store.
  const restarted = createWorkspaceRegistryService({ store })
  assert.equal(restarted.getRecord('ws-host')?.agents['agent-claude-code-4f2a1c']?.name, 'Scout')
})

test('a launch registers once, however many doors report it', async () => {
  const h = host()
  const { agentId, sessionId } = await launchOverGateway(h)
  const writes = () =>
    h.announced.filter((event) => event.type === 'workspace.agents_updated' && event.payload.agentId === agentId).length
  assert.equal(writes(), 1)

  // The session-list beat, and the same session reported again.
  assert.equal(h.registration.reconcile(), 0)
  assert.equal(h.registration.registerSession(sessionId), false)
  assert.equal(writes(), 1, 'no second write for an agent the registry already holds')

  // A window projecting the same session afterwards is a later edit and wins
  // over main's unstamped record — it is never refused as stale.
  const projected = h.workspaceSync.dispatch({
    command: {
      type: 'workspace.update_agent',
      payload: {
        workspaceId: h.workspaceId,
        agentId,
        patch: { name: 'Renamed in the window' },
        configEditedAt: 1,
      },
    },
    sourceWindowId: 'primary',
  })
  assert.equal(projected.ok, true, 'main stamps its registration 0, so no window edit can lose to it')
  assert.equal(h.registry.getRecord(h.workspaceId)!.agents[agentId]!.name, 'Renamed in the window')
  assert.deepEqual(agentIdsOf(h), ['agent-1', agentId].sort())
})

test('a live launched agent missing from its workspace is adopted on the next session beat', () => {
  const h = host()
  // Live on this machine, launched by the launch service, and missing from the
  // workspace: a launch whose own registration never landed.
  h.sessions.push(
    sessionOf({
      sessionId: 'session-orphaned',
      workspaceId: h.workspaceId,
      agentId: 'agent-claude-code-4f2a1c',
      agentRecord: launchRecord(),
    }),
  )
  assert.deepEqual(agentIdsOf(h), ['agent-1'])
  assert.equal(h.registration.reconcile(), 1)
  assert.deepEqual(agentIdsOf(h), ['agent-1', 'agent-claude-code-4f2a1c'])
  assert.equal(h.registry.getRecord(h.workspaceId)!.agents['agent-claude-code-4f2a1c']!.name, 'Scout')
  assert.ok(
    h.announced.some(
      (event) => event.type === 'workspace.agents_updated' && event.payload.agentId === 'agent-claude-code-4f2a1c',
    ),
  )
})

test('reconcile leaves alone what is not a launched agent it can place', () => {
  const h = host()
  h.sessions.push(
    // A window's own agent terminal: no launch record, and already registered.
    sessionOf({ sessionId: 'own', workspaceId: h.workspaceId, agentId: 'agent-1' }),
    // A helper session with no launch record.
    sessionOf({ sessionId: 'helper', workspaceId: h.workspaceId, agentId: 'review-guide' }),
    // A plain shell.
    sessionOf({ sessionId: 'shell', kind: 'terminal', workspaceId: h.workspaceId }),
    // A launched agent that already exited.
    sessionOf({
      sessionId: 'over',
      processAlive: false,
      workspaceId: h.workspaceId,
      agentRecord: launchRecord({ agentId: 'agent-over' }),
    }),
    // A launched agent whose workspace is gone.
    sessionOf({ sessionId: 'lost', workspaceId: 'ws-removed', agentRecord: launchRecord({ agentId: 'agent-lost' }) }),
  )
  const before = h.announced.length
  assert.equal(h.registration.reconcile(), 0)
  assert.equal(h.announced.length, before)
  assert.deepEqual(agentIdsOf(h), ['agent-1'])
  assert.equal(h.registry.getRecord('ws-removed'), null, 'no workspace is conjured for a lost session')
})

test('a suspended launched session is not adopted, as no window would reveal it', () => {
  const h = host()
  h.sessions.push(
    sessionOf({
      sessionId: 'frozen',
      processAlive: false,
      suspended: true,
      workspaceId: h.workspaceId,
      agentRecord: launchRecord({ agentId: 'agent-frozen' }),
    }),
  )
  assert.equal(h.registration.reconcile(), 0)
  assert.equal(h.registry.getRecord(h.workspaceId)!.agents['agent-frozen'], undefined)
})

test('an agent removed from its workspace while its session lives is not added back', async () => {
  const h = host()
  const { agentId } = await launchOverGateway(h)
  // Another window or device removes it (or moves it to another workspace)
  // while its process keeps running.
  const closed = h.workspaceSync.dispatch({
    command: {
      type: 'workspace.update_agent',
      payload: { workspaceId: h.workspaceId, agentId, patch: null, configEditedAt: 9_000 },
    },
    sourceWindowId: 'primary',
  })
  assert.ok(closed.ok)
  assert.equal(h.registration.reconcile(), 0, 'the next session-list beat resurrects nothing')
  assert.deepEqual(agentIdsOf(h), ['agent-1'])
})

test('disposing a launched agent takes it back out of the registry', async () => {
  const h = host()
  const launched = await h.launchService.launch({ workspaceId: h.workspaceId })
  assert.ok(launched.ok)
  assert.ok(h.registry.getRecord(h.workspaceId)!.agents[launched.agentId])

  const before = h.announced.length
  h.launchService.dispose({ workspaceId: h.workspaceId, agentId: launched.agentId })
  assert.deepEqual(h.kills, [launched.sessionId])
  assert.deepEqual(agentIdsOf(h), ['agent-1'], 'a one-shot agent leaves with its session, window or no window')
  assert.ok(
    h.announced
      .slice(before)
      .some((event) => event.type === 'workspace.agents_updated' && event.payload.patch === null),
  )
  // Disposing an agent main never registered touches nothing.
  h.launchService.dispose({ workspaceId: h.workspaceId, agentId: 'agent-1' })
  assert.deepEqual(agentIdsOf(h), ['agent-1'])
})
