import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { createAutomationTools, type AutomationBackends } from './automation-tools'

// Every launching tool refuses a prompt that begins with `-` before it makes a
// worktree, a launch or a schedule for it.

function harness() {
  const launches: unknown[] = []
  const schedules: unknown[] = []
  const workspace = { id: 'ws-1', name: 'Repo', mode: 'standard', folderPath: '/repo/a', agents: {} }
  const backends = {
    getWorkspaceSyncSnapshot: () => ({ state: { workspaces: [workspace], workspaceWindows: [] } }),
    listTerminalSessions: () => [],
    launchAgent: async (request: unknown) => {
      launches.push(request)
      return { ok: false, code: 'not_in_this_test', message: 'not launched' }
    },
    getScheduledAgents: () => ({
      create: async (input: unknown) => {
        schedules.push(input)
        return { ok: false, message: 'not scheduled' }
      },
    }),
    defaultChatCli: () => 'claude-code',
    resolveAgentPermissionPreset: () => 'bypass',
  } as unknown as AutomationBackends
  const tools = createAutomationTools(backends)
  const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> =>
    (tools.find((tool) => tool.name === name) as McpToolRegistration).handler(args, {
      metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' },
    })
  return { call, launches, schedules }
}

function errorCode(result: McpToolResult): string {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent))
  return (result.structuredContent as { error: { code: string } }).error.code
}

for (const [name, args] of [
  ['agent.launch', { workspaceId: 'ws-1' }],
  ['terminal.create', { workspaceId: 'ws-1' }],
  ['schedule.create', { workspaceId: 'ws-1', cron: '0 9 * * 1-5' }],
] as const) {
  test(`${name} refuses a prompt that begins with a dash`, async () => {
    const app = harness()
    const refused = await app.call(name, { ...args, prompt: '  --permission-mode=bypassPermissions' })
    assert.equal(errorCode(refused), 'prompt_reads_as_option')
    assert.equal(app.launches.length + app.schedules.length, 0, 'nothing was launched or scheduled')

    // An ordinary prompt goes on to the launch or the schedule.
    await app.call(name, { ...args, prompt: 'fix the parser - quickly' })
    assert.equal(app.launches.length + app.schedules.length, 1)
  })
}
