import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentLaunchRequest } from '../../shared/agent-launch'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import type { McpConnectionMetadata, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createAgentLaunchService } from '../agent-launch-service'
import type { TerminalSpawnPayload } from '../ipc/terminal-ipc'
import { createAutomationTools, type AutomationBackends } from './automation-tools'

// The terminal tools show an agent the terminals it or its chat started, so
// every launching tool records who asked, and the launch puts it on the session.

const AGENT: McpConnectionMetadata = { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' }

test('agent.launch and terminal.create record the calling agent on the launch', async () => {
  const requests: AgentLaunchRequest[] = []
  const workspace = { id: 'ws-1', name: 'Repo', mode: 'standard', folderPath: '/repo/a', agents: {} }
  const tools = createAutomationTools({
    getWorkspaceSyncSnapshot: () => ({ state: { workspaces: [workspace], workspaceWindows: [] } }),
    listTerminalSessions: () => [],
    launchAgent: async (request: AgentLaunchRequest) => {
      requests.push(request)
      return { ok: false, code: 'not_in_this_test', message: 'not launched' }
    },
    resolveAgentPermissionPreset: () => 'bypass',
  } as unknown as AutomationBackends)
  const call = (name: string, metadata: McpConnectionMetadata) =>
    (tools.find((tool) => tool.name === name) as McpToolRegistration).handler({ workspaceId: 'ws-1' }, { metadata })

  await call('agent.launch', AGENT)
  await call('terminal.create', AGENT)
  await call('terminal.create', { kind: 'external-local' })
  assert.deepEqual(
    requests.map((request) => request.launchedBy),
    [{ workspaceId: 'ws-1', agentId: 'agent-1' }, { workspaceId: 'ws-1', agentId: 'agent-1' }, undefined],
  )
})

test('the launch service carries the caller onto the session it starts', async () => {
  const spawns: TerminalSpawnPayload[] = []
  const service = createAgentLaunchService({
    listWorkspaces: () => [{ id: 'ws-2', mode: 'standard', folderPath: '/repo/b', agents: {} }],
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    terminal: {
      list: () => [],
      spawn: async (payload) => {
        spawns.push(payload)
        return { ok: true, sessionId: payload.sessionId }
      },
      kill: () => undefined,
    },
  })
  await service.launch({
    workspaceId: 'ws-2',
    cli: 'claude-code',
    launchedBy: { workspaceId: 'ws-1', agentId: 'agent-1' },
  })
  await service.launch({ workspaceId: 'ws-2', cli: 'claude-code' })
  assert.deepEqual(spawns[0]?.agentRecord?.launchedBy, { workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.equal(spawns[1]?.agentRecord?.launchedBy, undefined, 'a launch the person made names no agent')
})
