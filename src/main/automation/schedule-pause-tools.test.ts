import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import { isAgentLaunchingGatewayTool } from '../../shared/conversation/approvalRules'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { createScheduledAgentsScheduler } from '../scheduled-agents/scheduler'
import { createScheduledAgentsService, type ScheduledAgentsService } from '../scheduled-agents/service'
import { createScheduledAgentsStore } from '../scheduled-agents/store'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'

// `schedule.pause` and `schedule.resume`, and what `schedule.list` says about a
// pause, over the real scheduled agents service.

// Wednesday 30 September 2026, 12:10 UTC.
const NOW = Date.UTC(2026, 8, 30, 12, 10)

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const workspace = (id: string, fields: Partial<Workspace> = {}): Workspace =>
  ({ id, name: id, mode: 'standard', folderPath: '/Users/dev/acme', agents: {}, createdAt: 1, ...fields }) as Workspace

const agentCaller = (workspaceId: string): McpConnectionContext => ({
  metadata: { kind: 'studio-agent', workspaceId, agentId: 'agent-caller', cliId: 'claude-code' },
})

type Listed = {
  scheduledAgents: Array<{ id: string; paused: boolean; pausedAt: string | null; nextRunAt: string | null }>
  pausedAll: { since: string; until: string | null } | null
}

async function harness(options: { callerPreset?: CliPermissionPreset; preset?: CliPermissionPreset } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-schedule-pause-tools-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = createScheduledAgentsStore({
    filePath: join(dir, 'scheduled-agents.json'),
    now: () => NOW,
    newId: () => 'sa-1',
  })
  await store.load()
  const scheduler = createScheduledAgentsScheduler({
    list: () => store.list(),
    recordRun: (id, run) => store.recordRun(id, run),
    run: async () => ({ at: NOW, ok: true, workspaceId: 'ws-run' }),
    pausedAll: () => store.pausedAll(),
    now: () => NOW,
    setTimer: () => null,
    clearTimer: () => undefined,
  })
  scheduler.start()
  const service: ScheduledAgentsService = createScheduledAgentsService({ store, scheduler, now: () => NOW })
  const made = await service.create({
    prompt: 'Apply bug fixes to Studio',
    schedule: { cron: '0 13 * * *', timezone: 'UTC' },
    folderPath: '/Users/dev/acme',
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: options.preset ?? null,
    skills: [],
    mcpServers: [],
    worktree: null,
  })
  assert.ok(made.ok)
  const backends = {
    getWorkspaceSyncSnapshot: () =>
      ({
        sequence: 1,
        state: {
          workspaces: [
            workspace('ws-1'),
            workspace('ws-other', { folderPath: '/Users/dev/other' }),
            workspace('ws-run', { scheduledAgentId: 'sa-1' }),
          ],
          activeWorkspaceId: 'ws-1',
          primaryWorkspaceWindowId: 'primary',
          workspaceWindows: [],
        },
      }) as unknown as WorkspaceSyncSnapshot,
    listTerminalSessions: () => [],
    resolveAgentPermissionPreset: () => options.callerPreset ?? 'bypass',
    getScheduledAgents: () => service,
    defaultChatCli: () => 'claude-code',
  } as unknown as AutomationBackends
  const tools = createAutomationTools(backends)
  const call = (name: string, args: Record<string, unknown>, context?: McpConnectionContext) => {
    const registration = tools.find((candidate) => candidate.name === name)
    assert.ok(registration, `tool ${name} is served`)
    return registration.handler(args, context)
  }
  return { service, call }
}

const errorCode = (result: McpToolResult) => (result.structuredContent as { error?: { code: string } }).error?.code

test('schedule.list says whether each schedule is paused, and whether they all are', async () => {
  const { service, call } = await harness()
  let listed = (await call('schedule.list', {})).structuredContent as Listed
  assert.deepEqual(listed.scheduledAgents[0], {
    ...listed.scheduledAgents[0],
    paused: false,
    pausedAt: null,
    nextRunAt: '2026-09-30T13:00:00.000Z',
  })
  assert.equal(listed.pausedAll, null)

  await service.pause('sa-1')
  await service.pauseAll(NOW + 60 * 60 * 1000)
  listed = (await call('schedule.list', {})).structuredContent as Listed
  assert.equal(listed.scheduledAgents[0]?.paused, true)
  assert.equal(listed.scheduledAgents[0]?.pausedAt, '2026-09-30T12:10:00.000Z')
  assert.equal(listed.scheduledAgents[0]?.nextRunAt, null)
  assert.deepEqual(listed.pausedAll, { since: '2026-09-30T12:10:00.000Z', until: '2026-09-30T13:10:00.000Z' })
})

test('schedule.pause and schedule.resume pause a schedule and resume it from its next time', async () => {
  const { service, call } = await harness()
  const paused = await call('schedule.pause', { id: 'sa-1' })
  assert.equal(paused.isError, undefined, JSON.stringify(paused.structuredContent))
  const pausedAgent = (paused.structuredContent as { scheduledAgent: Listed['scheduledAgents'][number] }).scheduledAgent
  assert.equal(pausedAgent.paused, true)
  assert.equal(pausedAgent.nextRunAt, null)
  assert.equal(service.get('sa-1')?.pausedAt, NOW)

  const resumed = await call('schedule.resume', { id: 'sa-1' })
  const resumedAgent = (resumed.structuredContent as { scheduledAgent: Listed['scheduledAgents'][number] })
    .scheduledAgent
  assert.equal(resumedAgent.paused, false)
  assert.equal(resumedAgent.nextRunAt, '2026-09-30T13:00:00.000Z')

  assert.equal(errorCode(await call('schedule.pause', { id: 'nope' })), 'unknown_scheduled_agent')
  assert.equal(errorCode(await call('schedule.resume', { id: 'nope' })), 'unknown_scheduled_agent')
  assert.equal(errorCode(await call('schedule.pause', {})), 'invalid_arguments')
})

test('schedule.run still runs a paused schedule', async () => {
  const { call } = await harness()
  await call('schedule.pause', { id: 'sa-1' })
  const ran = await call('schedule.run', { id: 'sa-1' })
  assert.deepEqual(ran.structuredContent, { workspaceId: 'ws-run' })
})

test('a chat a schedule started may not pause or resume one', async () => {
  const { service, call } = await harness()
  for (const name of ['schedule.pause', 'schedule.resume']) {
    const result = await call(name, { id: 'sa-1' }, agentCaller('ws-run'))
    assert.equal(errorCode(result), 'scheduled_run_refused', name)
  }
  assert.equal(service.get('sa-1')?.pausedAt, undefined)
  const fromChat = await call('schedule.pause', { id: 'sa-1' }, agentCaller('ws-1'))
  assert.equal(fromChat.isError, undefined)
})

test('an agent may not resume a schedule that would run looser than it may', async () => {
  const { service, call } = await harness({ callerPreset: 'manual', preset: 'bypass' })
  await service.pause('sa-1')
  const refused = await call('schedule.resume', { id: 'sa-1' }, agentCaller('ws-1'))
  assert.equal(errorCode(refused), 'permission_escalation')
  assert.equal(service.get('sa-1')?.pausedAt, NOW, 'still paused')
  // Pausing starts nothing, so it is held to no ceiling.
  await service.resume('sa-1')
  assert.equal((await call('schedule.pause', { id: 'sa-1' }, agentCaller('ws-1'))).isError, undefined)
})

test('pausing and resuming are mutations, and resuming is asked about as a launch is', () => {
  assert.equal(
    isStudioGatewayMutation('schedule.pause', () => []),
    true,
  )
  assert.equal(
    isStudioGatewayMutation('schedule.resume', () => []),
    true,
  )
  assert.equal(isAgentLaunchingGatewayTool('sprintengine-studio', 'schedule.resume'), true)
  assert.equal(isAgentLaunchingGatewayTool('sprintengine-studio', 'schedule.pause'), false)
})

test('schedule.update changes a schedule in place and keeps what it was not told', async () => {
  const { service, call } = await harness({ preset: 'auto' })
  const updated = await call('schedule.update', {
    id: 'sa-1',
    prompt: 'Apply bug fixes to Studio, then open a pull request',
    cron: '0 9 * * 1-5',
    model: 'opus',
    worktreeName: 'fixes',
    skills: ['gh-triage'],
  })
  assert.equal(updated.isError, undefined)
  const agent = service.get('sa-1')!
  assert.equal(agent.prompt, 'Apply bug fixes to Studio, then open a pull request')
  assert.deepEqual(agent.schedule, { cron: '0 9 * * 1-5', timezone: 'UTC' })
  assert.equal(agent.cliModel, 'opus')
  assert.deepEqual(agent.worktree, { name: 'fixes' })
  assert.deepEqual(agent.skills, [{ id: 'gh-triage', name: 'gh-triage' }])
  // Kept: its project, its CLI and its preset.
  assert.equal(agent.folderPath, '/Users/dev/acme')
  assert.equal(agent.cli, 'claude-code')
  assert.equal(agent.permissionPreset, 'auto')

  // Taken off: the model, the worktree.
  await call('schedule.update', { id: 'sa-1', model: '', worktree: false })
  assert.equal(service.get('sa-1')!.cliModel, null)
  assert.equal(service.get('sa-1')!.worktree, null)
  assert.equal(service.get('sa-1')!.prompt, 'Apply bug fixes to Studio, then open a pull request')

  // Moved to another workspace's project.
  await call('schedule.update', { id: 'sa-1', workspaceId: 'ws-other' })
  assert.equal(service.get('sa-1')!.folderPath, '/Users/dev/other')

  // Once, then repeating again on a cron.
  await call('schedule.update', { id: 'sa-1', once: '2026-10-01T09:00:00.000Z' })
  assert.equal(service.get('sa-1')!.schedule.once, Date.parse('2026-10-01T09:00:00.000Z'))
  await call('schedule.update', { id: 'sa-1', cron: '0 10 * * *' })
  assert.equal(service.get('sa-1')!.schedule.once, undefined)
  assert.equal(service.get('sa-1')!.schedule.cron, '0 10 * * *')

  assert.equal(errorCode(await call('schedule.update', { id: 'nope', prompt: 'x' })), 'unknown_scheduled_agent')
  assert.equal(errorCode(await call('schedule.update', { prompt: 'x' })), 'invalid_arguments')
  assert.equal(errorCode(await call('schedule.update', { id: 'sa-1', cron: 'not a cron' })), 'scheduled_agent_invalid')
})

test("schedule.update is refused to a scheduled run, and held to its caller's preset", async () => {
  const { call } = await harness({ callerPreset: 'manual', preset: 'bypass' })
  const fromRun = await call('schedule.update', { id: 'sa-1', prompt: 'x' }, agentCaller('ws-run'))
  assert.equal(errorCode(fromRun), 'scheduled_run_refused')
  // A looser schedule than the agent asking is not one it may rewrite.
  const looser = await call('schedule.update', { id: 'sa-1', prompt: 'x' }, agentCaller('ws-1'))
  assert.equal(errorCode(looser), 'permission_escalation')
  assert.equal(
    isStudioGatewayMutation('schedule.update', () => []),
    true,
  )
})
