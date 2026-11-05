import assert from 'node:assert/strict'
import { test } from 'vitest'

import { conversationWorkingRoot, type AgentState } from '../shared/agent-state'
import type {
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationSessionSummary,
} from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings, type AgentLaunchSettings } from '../shared/launch-settings'
import { SOLO_CHAT_TEMPLATE_AGENT_ID } from '../shared/layouts/templates'
import {
  emptyWorkspaceRegistryFile,
  normalizeWorkspaceForRegistry,
  parseWorkspaceRegistryRecord,
  toWorkspaceRegistryRecord,
} from '../shared/workspace-registry'
import { deriveWorkspaceTitle, isDefaultWorkspaceName } from '../shared/workspace-title'
import type { Workspace } from '../renderer/src/types/workspace'
import {
  createConversationLaunchService,
  type ConversationLaunchServiceDeps,
  type ConversationLaunchWorkspace,
} from './conversation-launch-service'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceSyncService } from './workspace-sync-service'

type Harness = {
  writes: Array<{ workspaceId: string; agentId: string; agent: AgentState | null }>
  starts: ConversationStartSessionInput[]
  sends: Array<Parameters<ConversationLaunchServiceDeps['send']>[0]>
  installs: Array<{ workingRoot: string; skillId: string }>
  warnings: string[]
}

function harness(
  overrides: Partial<ConversationLaunchServiceDeps> & {
    workspace?: ConversationLaunchWorkspace | null
    settings?: Partial<AgentLaunchSettings>
  } = {},
) {
  const record: Harness = { writes: [], starts: [], sends: [], installs: [], warnings: [] }
  const workspace =
    overrides.workspace === undefined
      ? { id: 'ws-1', folderPath: '/repo/a', agents: { 'agent-1': { name: 'Ada' } } }
      : overrides.workspace
  const service = createConversationLaunchService({
    getWorkspace: (id) => (workspace && workspace.id === id ? workspace : null),
    getLaunchSettings: () => ({ ...emptyAgentLaunchSettings(), ...overrides.settings }),
    writeAgent: (workspaceId, agentId, agent) => {
      record.writes.push({ workspaceId, agentId, agent })
      return { ok: true }
    },
    listWorkspaces: () => (workspace ? [workspace] : []),
    createWorkspace: () => ({ ok: false, message: 'not in this test' }),
    removeWorkspace: () => undefined,
    startSession: async (input) => {
      record.starts.push(input)
      return {
        ok: true,
        session: {
          sessionId: 'conv_1',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        } as ConversationSessionSummary,
      }
    },
    send: async (input) => {
      record.sends.push(input)
      return { ok: true } as ConversationSessionActionResult
    },
    ensureSkillInstalled: async (workingRoot, skillId) => {
      record.installs.push({ workingRoot, skillId })
      return skillId === 'no-such-skill'
        ? { ok: false, status: 'unknown-skill', message: `Unknown skill: ${skillId}` }
        : { ok: true, status: 'installed' }
    },
    warn: (message) => record.warnings.push(message),
    newAgentSuffix: () => 'abc123',
    newCommandId: () => 'cmd-1',
    ...overrides,
  })
  return { service, record }
}

test('a chat launch writes a conversation agent, starts its session and sends the prompt', async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    cliModel: 'opus',
    permissionPreset: 'none',
    prompt: '  fix the build  ',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.agentId, 'agent-claude-code-abc123')
  assert.equal(result.sessionId, 'conv_1')
  assert.equal(result.modelId, 'opus')

  assert.equal(record.writes.length, 1)
  const agent = record.writes[0]!.agent!
  assert.equal(agent.runtimeKind, 'conversation')
  assert.deepEqual(agent.conversation, { providerId: result.providerId, modelId: 'opus' })
  assert.equal(agent.cliPermissionPreset, 'none')
  // Main sends the prompt itself; a mounting chat view must not send it again.
  assert.equal(agent.chatStartupPrompt, undefined)
  assert.notEqual(agent.name, 'Ada', 'the name is not one the workspace already uses')

  assert.deepEqual(record.starts[0], {
    workspaceRoot: '/repo/a',
    workspaceId: 'ws-1',
    agentId: 'agent-claude-code-abc123',
    providerId: result.providerId,
    modelId: 'opus',
    permissionPreset: 'none',
  })
  await Promise.resolve()
  assert.deepEqual(record.sends, [{ sessionId: 'conv_1', commandId: 'cmd-1', message: 'fix the build' }])
})

test('an unnamed CLI, model and preset take what the launcher here would', async () => {
  const { service, record } = harness({
    settings: { lastSelectedCli: 'codex', cliPermissionPresets: { codex: 'none' } },
  })
  const result = await service.launch({ workspaceId: 'ws-1' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.cli, 'codex')
  assert.equal(result.modelId, 'default')
  assert.equal(record.starts[0]!.permissionPreset, 'none')
  assert.deepEqual(record.sends, [], 'no prompt, no first message')
})

test('a CLI with no chat provider is refused before anything is written', async () => {
  const { service, record } = harness()
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'not-a-chat-cli' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'cli_not_conversational')
  assert.deepEqual(record.writes, [])
  assert.deepEqual(record.starts, [])
})

test('an unknown workspace, or one with no folder, is refused', async () => {
  const unknown = await harness().service.launch({ workspaceId: 'nope', cli: 'claude' })
  assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')
  const folderless = await harness({ workspace: { id: 'ws-1', folderPath: null } }).service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
  })
  assert.equal(!folderless.ok && folderless.code, 'workspace_folder_missing')
})

test('a session that cannot start takes its agent record back out', async () => {
  const { service, record } = harness({
    startSession: async (): Promise<ConversationStartSessionResult> => ({ ok: false, message: 'CLI not installed' }),
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'hi' })
  assert.deepEqual(result, { ok: false, code: 'conversation_start_failed', message: 'CLI not installed' })
  assert.deepEqual(
    record.writes.map((write) => [write.agentId, write.agent === null]),
    [
      ['agent-claude-code-abc123', false],
      ['agent-claude-code-abc123', true],
    ],
  )
  assert.deepEqual(record.sends, [])
})

test('a refused first message is reported, and the launch still stands', async () => {
  const { service, record } = harness({
    send: async () => ({ ok: false, message: 'busy' }) as ConversationSessionActionResult,
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'hi' })
  assert.equal(result.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(record.warnings.length, 1)
  assert.match(record.warnings[0]!, /busy/)
})

/** Every agent id a layout's tabs name, in layout order. */
function layoutAgentIds(layout: unknown): string[] {
  return [...JSON.stringify(layout).matchAll(/"agentId":"([^"]+)"/g)].map((match) => match[1]!)
}

/** The launch wired to a real registry and bus, as app-services wires it, around one chat in a worktree. */
function registryHarness(startSession?: ConversationLaunchServiceDeps['startSession']) {
  const existing: Workspace = {
    id: 'ws-old',
    name: 'Fix the flaky login test',
    titleLocked: true,
    mode: 'standard',
    folderPath: '/Users/dev/.worktrees/app/login-fix',
    hostId: 'wsl:Ubuntu',
    worktree: { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' },
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: [
        toWorkspaceRegistryRecord(existing, 1),
        toWorkspaceRegistryRecord({ ...existing, id: 'ws-two', name: 'Chat' }, 1),
      ],
    }),
    now: () => 1000,
    newWorkspaceId: () => `ws-new-${++ids}`,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => 1000 })
  const writes: string[] = []
  const service = createConversationLaunchService({
    getWorkspace: (id) => registry.getRecord(id),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => {
      writes.push(agentId)
      return sync.updateWorkspaceAgent(workspaceId, agentId, agent, 'system')
    },
    listWorkspaces: () => registry.getRecords(),
    createWorkspace: (request) => {
      const created = sync.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      sync.removeWorkspace(workspaceId, 'system')
    },
    startSession:
      startSession ??
      (async (input) => ({
        ok: true,
        session: {
          sessionId: 'conv_1',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        } as ConversationSessionSummary,
      })),
    send: async () => ({ ok: true }) as ConversationSessionActionResult,
    newCommandId: () => 'cmd-1',
  })
  return { service, registry, writes }
}

test('a new chat is born in a workspace of its own, in the named workspace’s folder, titled by its first message', async () => {
  const { service, registry, writes } = registryHarness()
  const result = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code', prompt: 'hi' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.notEqual(result.workspaceId, 'ws-old')
  // An id of its own, never the template's placeholder every chat once shared.
  assert.match(result.agentId, /^agent-claude-code-[0-9a-z]{16}$/)
  assert.notEqual(result.agentId, SOLO_CHAT_TEMPLATE_AGENT_ID)
  assert.deepEqual(writes, [], 'nothing is added to the chat the workspace already was')
  assert.deepEqual(Object.keys(registry.getRecord('ws-old')?.agents ?? {}), [])

  const created = registry.getRecord(result.workspaceId)!
  assert.equal(created.folderPath, '/Users/dev/.worktrees/app/login-fix')
  assert.equal(created.hostId, 'wsl:Ubuntu')
  assert.deepEqual(created.worktree, { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' })
  // Named as New chat names one beside the folder's others, and left open for
  // the first message to title.
  assert.equal(created.name, 'Chat 2')
  assert.equal(isDefaultWorkspaceName(created.name), true)
  assert.equal(created.titleLocked, undefined)
  // The layout's one agent tab is the chat's agent, from the first event.
  assert.deepEqual(layoutAgentIds(created.layoutModel), [result.agentId])
  assert.deepEqual(Object.keys(created.agents), [result.agentId])
  assert.equal(created.agents[result.agentId]?.id, result.agentId)
  assert.equal(created.agents[result.agentId]?.runtimeKind, 'conversation')
  assert.equal(created.agents[result.agentId]?.name, result.name)
})

test('two new chats never share an agent id, so nothing matched by agent id reaches the other', async () => {
  const { service, registry } = registryHarness()
  const first = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code' })
  const second = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code' })
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return
  assert.notEqual(first.workspaceId, second.workspaceId)
  assert.notEqual(first.agentId, second.agentId)
  for (const launched of [first, second]) {
    const created = registry.getRecord(launched.workspaceId)!
    assert.deepEqual(layoutAgentIds(created.layoutModel), [launched.agentId])
    assert.deepEqual(Object.keys(created.agents), [launched.agentId])
  }
})

test('a new chat main starts is named after its first message, and the name stays open for a model title', async () => {
  const { service, registry } = registryHarness()
  const prompt = 'Fix the upload retry on flaky networks'
  const result = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code', prompt })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const created = registry.getRecord(result.workspaceId)!
  // No window may be showing this chat (a phone started it), so it is listed
  // under its heuristic title at once; the chat's titler can still replace it
  // with a model-written one.
  assert.equal(created.name, deriveWorkspaceTitle(prompt))
  assert.equal(created.titleLocked, undefined)
})

test('a new chat that sends nothing first keeps an app-minted name', async () => {
  const { service, registry } = registryHarness()
  const result = await service.launch({
    workspaceId: 'ws-old',
    newChat: true,
    cli: 'claude-code',
    prompt: 'Fix the upload retry on flaky networks',
    sendFirst: false,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(registry.getRecord(result.workspaceId)?.name, 'Chat 2')
})

test('a new chat whose session cannot start takes its whole workspace back out', async () => {
  const { service, registry } = registryHarness(async () => ({ ok: false, message: 'CLI not installed' }))
  const before = registry.getRecords().map((record) => record.id)
  const result = await service.launch({ workspaceId: 'ws-old', newChat: true, cli: 'claude-code' })
  assert.deepEqual(result, { ok: false, code: 'conversation_start_failed', message: 'CLI not installed' })
  assert.deepEqual(
    registry.getRecords().map((record) => record.id),
    before,
  )
})

test('a chat born in a folder gets a workspace of its own there, on its machine and worktree', async () => {
  const starts: ConversationStartSessionInput[] = []
  const { service, registry, writes } = registryHarness(async (input) => {
    starts.push(input)
    return {
      ok: true,
      session: {
        sessionId: 'conv_1',
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      } as ConversationSessionSummary,
    }
  })
  const before = registry.getRecords().length
  const result = await service.launch({
    newChatIn: {
      folderPath: '/Users/dev/.worktrees/app/nightly-20260930-2100',
      hostId: 'wsl:Ubuntu',
      worktree: { branch: 'agent/nightly-20260930-2100', baseRef: 'HEAD', repoRoot: '/Users/dev/app' },
    },
    cli: 'claude-code',
    prompt: 'triage new issues',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(registry.getRecords().length, before + 1, 'a workspace is minted; no existing one is joined')
  assert.deepEqual(writes, [])
  assert.match(result.agentId, /^agent-claude-code-[0-9a-z]{16}$/)
  const created = registry.getRecord(result.workspaceId)!
  assert.deepEqual(layoutAgentIds(created.layoutModel), [result.agentId])
  assert.equal(created.folderPath, '/Users/dev/.worktrees/app/nightly-20260930-2100')
  assert.equal(created.hostId, 'wsl:Ubuntu')
  assert.deepEqual(created.worktree, {
    branch: 'agent/nightly-20260930-2100',
    baseRef: 'HEAD',
    repoRoot: '/Users/dev/app',
  })
  // A scheduled run is listed under what it was sent from the start; the name
  // stays open for a model-written one.
  assert.equal(created.name, deriveWorkspaceTitle('triage new issues'))
  assert.equal(created.titleLocked, undefined)
  assert.equal(starts[0]!.workspaceRoot, '/Users/dev/.worktrees/app/nightly-20260930-2100')
  // The chat runs on the machine it was born on: its CLI, whichever chat CLI
  // it is, is that distribution's.
  assert.deepEqual(starts[0]!.cliRuntimes?.['claude-code'], { command: '', hostId: 'wsl:Ubuntu' })
  assert.deepEqual(starts[0]!.cliRuntimes?.codex, { command: '', hostId: 'wsl:Ubuntu' })
})

test("a scheduled run's chat carries its schedule's id on its workspace, through a restart", async () => {
  const { service, registry } = registryHarness()
  const result = await service.launch({
    newChatIn: { folderPath: '/Users/dev/app' },
    cli: 'claude-code',
    prompt: 'triage new issues',
    scheduledAgentId: 'sa-1',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const created = registry.getRecord(result.workspaceId)!
  assert.equal(created.scheduledAgentId, 'sa-1')
  // What main writes to disk and reads back at start-up keeps it.
  const reread = parseWorkspaceRegistryRecord(JSON.parse(JSON.stringify(created)))
  assert.ok('record' in reread)
  if ('record' in reread) assert.equal(reread.record.scheduledAgentId, 'sa-1')

  // A chat joining a workspace is not a run, and a chat nobody scheduled is unmarked.
  const joined = await service.launch({ workspaceId: 'ws-old', cli: 'claude-code', scheduledAgentId: 'sa-1' })
  assert.equal(joined.ok, true)
  assert.equal(registry.getRecord('ws-old')!.scheduledAgentId, undefined)
  const plain = await service.launch({ newChatIn: { folderPath: '/Users/dev/app' }, cli: 'claude-code' })
  assert.equal(plain.ok, true)
  if (plain.ok) assert.equal(registry.getRecord(plain.workspaceId)!.scheduledAgentId, undefined)
})

test('a chat launched in the background joins the list without becoming the active chat', async () => {
  const { service, registry } = registryHarness()
  const front = await service.launch({ newChatIn: { folderPath: '/Users/dev/app' }, cli: 'claude-code' })
  assert.equal(front.ok, true)
  if (!front.ok) return
  assert.equal(registry.getState().activeWorkspaceId, front.workspaceId, 'an ordinary new chat is brought to the front')

  const run = await service.launch({
    newChatIn: { folderPath: '/Users/dev/app' },
    cli: 'claude-code',
    prompt: 'triage new issues',
    scheduledAgentId: 'sa-1',
    background: true,
  })
  assert.equal(run.ok, true)
  if (!run.ok) return
  const state = registry.getState()
  assert.equal(state.activeWorkspaceId, front.workspaceId, 'the window keeps what it was showing')
  const primary = state.workspaceWindows.find((windowState) => windowState.id === state.primaryWorkspaceWindowId)
  assert.ok(primary?.workspaceIds.includes(run.workspaceId), 'the run is in the window list all the same')
  assert.equal(primary?.activeWorkspaceId, front.workspaceId)
})

test("a WSL chat runs that distribution's CLI, whichever chat CLI it is", async () => {
  const settings = {
    cliRuntimes: { 'claude-code': { command: 'claude-local' }, codex: { command: 'codex-local' } },
    hosts: {
      'wsl:Ubuntu': {
        enabled: true,
        cliCommands: { 'claude-code': '/home/dev/.local/bin/claude', codex: '/home/dev/.local/bin/codex' },
        env: {},
      },
    },
  }
  const wsl = harness({
    settings,
    workspace: { id: 'ws-1', folderPath: '/home/dev/app', hostId: 'wsl:Ubuntu', agents: {} },
  })
  await wsl.service.launch({ workspaceId: 'ws-1', cli: 'codex' })
  const runtimes = wsl.record.starts[0]!.cliRuntimes
  assert.deepEqual(runtimes?.['claude-code'], { command: '/home/dev/.local/bin/claude', hostId: 'wsl:Ubuntu' })
  assert.deepEqual(runtimes?.codex, { command: '/home/dev/.local/bin/codex', hostId: 'wsl:Ubuntu' })
  // A CLI with no command set there is found on that machine's PATH, never this one's.
  assert.deepEqual(runtimes?.grok, { command: '', hostId: 'wsl:Ubuntu' })

  const local = harness({ settings })
  await local.service.launch({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.deepEqual(local.record.starts[0]!.cliRuntimes, settings.cliRuntimes, 'a chat on this machine is unchanged')
})

test('a chat in a folder inside a distribution runs where its workspace runs: that distribution unless This PC was picked', async () => {
  const settings = {
    cliRuntimes: { codex: { command: 'codex-local' } },
    hosts: { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/home/dev/.local/bin/codex' }, env: {} } },
  }
  const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
  // A workspace that records no machine runs in its folder's distribution, as
  // the router and Studio's git have it (`workspaceHostIdOf`), so its chat's
  // CLI is that distribution's too, not this PC's against the same folder.
  const older = harness({ settings, workspace: { id: 'ws-1', folderPath, agents: {} } })
  await older.service.launch({ workspaceId: 'ws-1', cli: 'codex' })
  assert.deepEqual(older.record.starts[0]!.cliRuntimes?.codex, {
    command: '/home/dev/.local/bin/codex',
    hostId: 'wsl:Ubuntu',
  })
  const onThisPc = harness({ settings, workspace: { id: 'ws-1', folderPath, hostId: 'local', agents: {} } })
  await onThisPc.service.launch({ workspaceId: 'ws-1', cli: 'codex' })
  assert.deepEqual(onThisPc.record.starts[0]!.cliRuntimes, settings.cliRuntimes, "This PC picked runs this PC's CLI")
})

test("skills are installed in the working root, attached to the first message and kept as the chat's chips", async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    prompt: 'triage',
    skills: ['backlog', ' backlog ', 'review'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(record.installs, [
    { workingRoot: '/repo/a', skillId: 'backlog' },
    { workingRoot: '/repo/a', skillId: 'review' },
  ])
  assert.deepEqual(record.writes[0]!.agent!.conversationSkills, ['backlog', 'review'])
  await Promise.resolve()
  assert.deepEqual(record.sends[0]!.skills, [{ id: 'backlog' }, { id: 'review' }])
})

test('an unknown skill refuses the launch before anything is written', async () => {
  const { service, record } = harness()
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', skills: ['no-such-skill'] })
  assert.equal(!result.ok && result.code, 'unknown_skill')
  assert.deepEqual(record.writes, [])
  assert.deepEqual(record.starts, [])
})

test("a chat on an SSH machine writes no skill copy on this computer: the machine's runtime attaches them", async () => {
  const { service, record } = harness({
    workspace: { id: 'ws-1', folderPath: 'ssh://e1/home/dev/repo', agents: {} },
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', skills: ['backlog'] })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(record.installs, [])
  assert.deepEqual(record.writes[0]!.agent!.conversationSkills, ['backlog'])
})

test('a skill copy that could not be written is reported, and the launch goes on', async () => {
  const { service, record } = harness({
    ensureSkillInstalled: async () => ({ ok: false, status: 'install-failed', message: 'disk full' }),
  })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', skills: ['backlog'] })
  assert.equal(result.ok, true)
  assert.match(record.warnings[0]!, /disk full/)
})

test('the owning module is stamped on the chat record', async () => {
  const { service, record } = harness()
  await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', ownerModuleId: 'acme.reviews' })
  assert.equal(record.writes[0]!.agent!.ownerModuleId, 'acme.reviews')
  const { service: own, record: ownRecord } = harness()
  await own.launch({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.equal(ownRecord.writes[0]!.agent!.ownerModuleId, undefined, "a chat nobody's module started has no owner")
})

test('tools allowed at launch reach the session it starts, once each, and none means none', async () => {
  const { service, record } = harness()
  await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', allowedTools: ['Write', ' Edit ', 'Write', ''] })
  assert.deepEqual(record.starts[0]!.allowedTools, ['Write', 'Edit'])
  // Session-only, like a connector's servers: nothing about them is written on the record.
  assert.equal(JSON.stringify(record.writes[0]!.agent).includes('Write'), false)
  const { service: plain, record: plainRecord } = harness()
  await plain.launch({ workspaceId: 'ws-1', cli: 'claude-code', allowedTools: [] })
  assert.equal('allowedTools' in plainRecord.starts[0]!, false)
})

test('a worktree launch starts the session in the worktree and records where it runs', async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    worktreePath: '/repo/a/.worktrees/run-1',
    skills: ['backlog'],
  })
  assert.equal(result.ok, true)
  assert.equal(record.starts[0]!.workspaceRoot, '/repo/a/.worktrees/run-1')
  assert.equal(record.installs[0]!.workingRoot, '/repo/a/.worktrees/run-1')
  assert.deepEqual(record.writes[0]!.agent!.execution, {
    mode: 'worktree',
    worktreeId: null,
    cwd: '/repo/a/.worktrees/run-1',
  })
  assert.equal(conversationWorkingRoot(record.writes[0]!.agent, '/repo/a'), record.starts[0]!.workspaceRoot)
})

test('sendFirst false starts the session and sends nothing', async () => {
  const { service, record } = harness()
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'hi', sendFirst: false })
  assert.equal(result.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(record.sends, [])
})

test('pictures ride the first message, and a failed first message reaches the caller', async () => {
  const failures: string[] = []
  const { service, record } = harness({
    send: async (input) => {
      record.sends.push(input)
      throw new Error('provider went away')
    },
  })
  const attachment = { id: 'img-1', mediaType: 'image/png', dataBase64: 'AA==', byteLength: 1 }
  await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    prompt: 'what is this',
    attachments: [attachment],
    onFirstSendFailed: (message) => failures.push(message),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(record.sends[0]!.attachments, [attachment])
  assert.equal(failures.length, 1)
  assert.match(failures[0]!, /provider went away/)
})

test('the owner and the creating command survive the registry normalisation every window and restart goes through', async () => {
  const { service, record } = harness()
  await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    ownerModuleId: 'acme.reviews',
    launchCommandId: 'module:acme.reviews:create-1',
  })
  const agent = record.writes[0]!.agent!
  const workspace = normalizeWorkspaceForRegistry({
    id: 'ws-1',
    agents: { [agent.id]: agent },
  } as unknown as Workspace)
  assert.equal(workspace.agents[agent.id]!.ownerModuleId, 'acme.reviews')
  const persisted = JSON.parse(JSON.stringify(workspace)).agents[agent.id]
  assert.equal(persisted.ownerModuleId, 'acme.reviews')
  assert.equal(persisted.launchCommandId, 'module:acme.reviews:create-1')
})

test("a connector launch starts the chat with that connector's MCP server, and refuses one it cannot run", async () => {
  const railway = {
    id: 'railway',
    name: 'Railway',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@railway/mcp'],
    env: { RAILWAY_ENV: 'prod' },
    envVarNames: ['RAILWAY_TOKEN'],
    enabled: true,
    clients: ['claude-code' as const],
    scope: 'user' as const,
    source: 'custom' as const,
    riskLevel: 'local-command' as const,
  }
  const settings = { mcp: { syncEnabled: true, servers: { railway, off: { ...railway, id: 'off', enabled: false } } } }

  const { service, record } = harness({ settings })
  const launched = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', connectorId: 'railway' })
  assert.equal(launched.ok, true)
  assert.deepEqual(record.starts[0]!.mcpServers, [
    {
      id: 'railway',
      name: 'Railway',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@railway/mcp'],
      env: { RAILWAY_ENV: 'prod' },
      envVarNames: ['RAILWAY_TOKEN'],
    },
  ])

  // Not installed, or switched off: no chat at all, rather than one without it.
  for (const connectorId of ['nowhere', 'off']) {
    const refused = harness({ settings })
    const result = await refused.service.launch({ workspaceId: 'ws-1', cli: 'claude-code', connectorId })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'connector_unavailable')
    assert.deepEqual(refused.record.writes, [])
    assert.deepEqual(refused.record.starts, [])
  }

  // A start the provider refuses (a CLI whose chats take no MCP servers) takes the record back out.
  const unsupported = harness({
    settings,
    startSession: async () => ({ ok: false, message: 'A Gemini chat cannot be started with MCP servers of its own.' }),
  })
  const result = await unsupported.service.launch({ workspaceId: 'ws-1', cli: 'claude-code', connectorId: 'railway' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /MCP servers of its own/)
  assert.equal(unsupported.record.writes.at(-1)!.agent, null)

  // No connector, no servers named.
  const plain = harness({ settings })
  await plain.service.launch({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.equal(plain.record.starts[0]!.mcpServers, undefined)
})

test('several connectors start the chat with each of their servers, once each, and one unavailable refuses it', async () => {
  const server = (id: string) => ({
    id,
    name: id,
    transport: 'http' as const,
    url: `https://mcp.example.com/${id}`,
    enabled: true,
    clients: ['claude-code' as const],
    scope: 'user' as const,
    source: 'custom' as const,
    riskLevel: 'network' as const,
  })
  const settings = { mcp: { syncEnabled: true, servers: { linear: server('linear'), sentry: server('sentry') } } }

  const { service, record } = harness({ settings })
  const launched = await service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    connectorId: 'linear',
    connectorIds: ['sentry', 'linear', ' '],
  })
  assert.equal(launched.ok, true)
  assert.deepEqual(
    record.starts[0]!.mcpServers?.map((entry) => entry.id),
    ['linear', 'sentry'],
  )

  const refused = harness({ settings })
  const result = await refused.service.launch({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    connectorIds: ['sentry', 'gone'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'connector_unavailable')
  assert.deepEqual(refused.record.starts, [])
})

test('a launch naming a turn mode keeps it on the chat and sends the first message in it', async () => {
  const { service, record } = harness({ runsTurnMode: (providerId) => providerId === 'cursor-agent' })
  const result = await service.launch({ workspaceId: 'ws-1', cli: 'cursor', mode: 'ask', prompt: 'review this' })
  assert.equal(result.ok, true, !result.ok ? result.message : '')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(record.writes[0]?.agent?.conversationMode, 'ask')
  assert.equal(record.writes[0]?.agent?.conversationModeHeld, true)
  assert.equal(record.sends[0]?.mode, 'ask')
})

test('a launch naming no turn mode leaves the chat and its first message alone', async () => {
  const { service, record } = harness({ runsTurnMode: () => true })
  await service.launch({ workspaceId: 'ws-1', cli: 'cursor', mode: 'default', prompt: 'go' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(record.writes[0]?.agent?.conversationMode, undefined)
  assert.equal(record.writes[0]?.agent?.conversationModeHeld, undefined)
  assert.equal(record.sends[0]?.mode, undefined)
})

test('a turn mode the provider cannot run refuses the launch before anything is written', async () => {
  const { service, record } = harness({ runsTurnMode: (providerId) => providerId !== 'codex-agent' })
  const refused = await service.launch({ workspaceId: 'ws-1', cli: 'codex', mode: 'ask', prompt: 'review this' })
  assert.equal(!refused.ok && refused.code, 'unsupported_mode')
  assert.equal(record.writes.length, 0)
  assert.equal(record.starts.length, 0)
})

test("a sub-agent is written with its parent, and its task goes as Studio's message", async () => {
  const { service, record } = harness()
  const result = await service.launch({
    workspaceId: 'ws-1',
    cli: 'cursor',
    prompt: 'review this',
    subagentOf: { agentId: 'agent-1', startedAt: 5 },
    subagentReadOnly: true,
  })
  assert.equal(result.ok, true, !result.ok ? result.message : '')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(record.writes[0]?.agent?.subagentOf, { agentId: 'agent-1', startedAt: 5 })
  assert.equal(record.writes[0]?.agent?.subagentReadOnly, true)
  assert.deepEqual(record.sends[0]?.origin, { kind: 'studio', reason: 'subagent-task' })
})
