import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { readAutomationSettings, writeAutomationSettings } from './automation-settings'
import {
  AUTOMATION_SERVER_INFO_FILENAME,
  createAutomationService,
  resolveSocketPath,
  STUDIO_MCP_SERVER_INFO_FILENAME,
} from './automation-service'
import { projectHue } from '../../shared/project-hue'
import { createMcpSocketServer, type McpConnectionContext, type McpToolRegistration } from './mcp-socket-server'
import { createWorkspaceRegistryService } from '../workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../workspace-registry-store'
import { createWorkspaceSyncService } from '../workspace-sync-service'
import { createFakeIpcMain } from '../module-host/ipc-main-fake.test-helper'
import { loadMainModules, type CapabilityModule } from '../module-host/load-modules'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { createAgentLaunchService } from '../agent-launch-service'
import { resolvePermissionArgs } from '../plugin-render'
import type { TerminalSpawnPayload } from '../ipc/terminal-ipc'
import {
  emptyAgentLaunchSettings,
  resolveAgentSpawnPermissionPreset,
  type AgentLaunchSettings,
} from '../../shared/launch-settings'
import { createGatewayAuditStore, STUDIO_GATEWAY_AUDIT_FILENAME } from './gateway-audit'
import { createStudioGatewayTools, isStudioGatewayMutation } from './studio-gateway-tools'
import { requiredScopeForTool } from './tailnet/tailnet-scopes'
import { DEFAULT_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { LaunchedAgentLink } from '../agent-launch-notices'
import type { WorktreeDependencyInstallView } from '../../shared/ipc/worktree-pool'
import type { LoadedPlugin, PluginManifest } from '../../shared/plugin-manifest'
import type { MarketplaceRegistryReadInput } from '../../shared/electron-api'
import type { MarketplaceComponentKind } from '../../shared/marketplace/manifest'
import type { CapabilityManifest, ThirdPartyModuleView } from '../../shared/modules/manifest'
import {
  EMPTY_MODULE_SURFACES,
  type ModuleRegistryEntry,
  type ModuleRegistrySnapshot,
} from '../../shared/modules/registry-snapshot'
import type { Workspace } from '../../renderer/src/types/workspace'
import type {
  ScheduledAgentLastRun,
  ScheduledAgentView,
  ScheduledAgentWriteResult,
} from '../../shared/scheduled-agents'
import type { ScheduledAgentsService } from '../scheduled-agents/service'
import { test } from 'vitest'

test('automation', async () => {
  function testWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
    return {
      id,
      name: `Workspace ${id}`,
      mode: 'standard',
      folderPath: null,
      templateId: 'solo',
      layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
      agents: {},
      worktreeState: { containerPath: null, entries: {}, updatedAt: null },
      memory: { relativeRoot: null },
      editorState: { openFiles: [], activeFilePath: null },
      createdAt: 1,
      ...overrides,
    }
  }

  function snapshotOf(workspaces: Workspace[]): WorkspaceSyncSnapshot {
    return {
      sequence: 1,
      state: {
        workspaces,
        activeWorkspaceId: workspaces[0]?.id ?? null,
        primaryWorkspaceWindowId: 'primary',
        workspaceWindows: [
          {
            id: 'primary',
            kind: 'primary',
            workspaceIds: workspaces.map((workspace) => workspace.id),
            activeWorkspaceId: workspaces[0]?.id ?? null,
            bounds: null,
            isMaximized: false,
            displayId: null,
            createdAt: 0,
            lastFocusedAt: 0,
          },
        ],
      },
    }
  }

  type BackendsOverrides = {
    workspaces?: Workspace[]
    sessions?: TerminalSessionSnapshot[]
    createWorkspace?: AutomationBackends['createWorkspace']
    launchAgent?: AutomationBackends['launchAgent']
    linkLaunchedAgent?: AutomationBackends['linkLaunchedAgent']
    /** The CLI this machine would spawn under; the harness's stub session reports it. */
    defaultCli?: string
    listBacklogItems?: AutomationBackends['listBacklogItems']
    readBacklogItem?: AutomationBackends['readBacklogItem']
    backlogWrite?: Partial<AutomationBackends['backlogWrite']>
    getScheduledAgents?: AutomationBackends['getScheduledAgents']
    mobileControl?: AutomationBackends['mobileControl']
    createAgentWorktree?: AutomationBackends['createAgentWorktree']
    readWorkspaceCheckout?: AutomationBackends['readWorkspaceCheckout']
    readRepositoryIdentity?: AutomationBackends['readRepositoryIdentity']
    listPlugins?: AutomationBackends['listPlugins']
    ensureBuiltinSkillInstalled?: AutomationBackends['ensureBuiltinSkillInstalled']
    getModuleRegistrySnapshot?: AutomationBackends['getModuleRegistrySnapshot']
    listInstalledThirdPartyModules?: AutomationBackends['listInstalledThirdPartyModules']
    listModuleContributedTools?: AutomationBackends['listModuleContributedTools']
    readMarketplaceRegistry?: AutomationBackends['readMarketplaceRegistry']
  }

  function unexpectedCall(name: string): () => never {
    return () => {
      throw new Error(`unexpected backlogWrite.${name} call`)
    }
  }

  function backendsOf(overrides: BackendsOverrides = {}): AutomationBackends {
    // `workspace.create` mints in main now, so the backend is a real
    // registry rather than a delegated renderer call the test has to stub answering.
    let createdIds = 0
    const registry = createWorkspaceRegistryService({
      store: createInMemoryWorkspaceRegistryStore(),
      now: () => 1_000,
      newWorkspaceId: () => `ws-created-${++createdIds}`,
    })
    const workspaceSync = createWorkspaceSyncService({ registry, now: () => 1_000 })
    return {
      getWorkspaceSyncSnapshot: () => snapshotOf(overrides.workspaces ?? []),
      createWorkspace: overrides.createWorkspace ?? ((input, actor) => workspaceSync.createWorkspace(input, actor)),
      listTerminalSessions: () => overrides.sessions ?? [],
      // Default: no launch port wired. A test that reaches a launch without
      // stubbing one gets an explicit failure, not a silent success.
      launchAgent:
        overrides.launchAgent ??
        (async () => ({ ok: false, code: 'no_launch_service', message: 'no launch service in test' })),
      // Every agent on bypass, as the owner runs them: the suites here are about
      // what a launch does, and launch-permission-cap.test.ts about the cap.
      resolveAgentPermissionPreset: () => 'bypass',
      // Default: the mobile lane is unwired. A test that exercises the mobile
      // tools stubs this; anything else that reaches it fails loudly.
      mobileControl: overrides.mobileControl ?? {
        readSnapshot: async () => {
          throw new Error('unexpected mobileControl.readSnapshot call')
        },
        dispatchCommand: async () => {
          throw new Error('unexpected mobileControl.dispatchCommand call')
        },
      },
      listBacklogItems: overrides.listBacklogItems ?? (async () => ({ ok: true, key: null, items: [] })),
      readBacklogItem:
        overrides.readBacklogItem ??
        (async (_root, relativePath) => ({ ok: false, message: `no item ${relativePath}` })),
      backlogWrite: {
        updateStatus: unexpectedCall('updateStatus'),
        updateType: unexpectedCall('updateType'),
        updateTriage: unexpectedCall('updateTriage'),
        updateEpic: unexpectedCall('updateEpic'),
        updateDependenciesPlanned: unexpectedCall('updateDependenciesPlanned'),
        addOrUpdateLink: unexpectedCall('addOrUpdateLink'),
        repairIntegrity: unexpectedCall('repairIntegrity'),
        ...overrides.backlogWrite,
      },
      getScheduledAgents: overrides.getScheduledAgents ?? (() => null),
      defaultChatCli: () => 'claude-code',
      createAgentWorktree:
        overrides.createAgentWorktree ??
        (async ({ workspaceRoot, name }) => ({
          worktreePath: `${workspaceRoot}/.sprintengine-worktrees/${name}`,
          branch: `agent/${name}`,
        })),
      readWorkspaceCheckout:
        overrides.readWorkspaceCheckout ??
        (async () => ({ git: false, branch: null, defaultBranch: null, branches: [], worktrees: [] })),
      readRepositoryIdentity: overrides.readRepositoryIdentity ?? (async () => null),
      listPlugins: overrides.listPlugins ?? (() => []),
      ensureBuiltinSkillInstalled: overrides.ensureBuiltinSkillInstalled ?? (async () => true),
      // module.*/marketplace.*: no registry mirrored and nothing installed unless
      // a case says otherwise, so the default backends prove the "not reported
      // yet" path rather than a fabricated empty registry.
      getModuleRegistrySnapshot: overrides.getModuleRegistrySnapshot ?? (() => null),
      listInstalledThirdPartyModules:
        overrides.listInstalledThirdPartyModules ?? (async () => ({ modules: [], rejected: [] })),
      listModuleContributedTools: overrides.listModuleContributedTools ?? (() => []),
      readMarketplaceRegistry:
        overrides.readMarketplaceRegistry ??
        (async () => {
          throw new Error('unexpected readMarketplaceRegistry call')
        }),
      // Confirmation polling is exercised against static snapshots; collapse the
      // wait so timeout paths run instantly.
      sleep: async () => {},
      now: (() => {
        let tick = 0
        return () => (tick += 30_000)
      })(),
    }
  }

  function tool(tools: McpToolRegistration[], name: string): McpToolRegistration {
    const found = tools.find((candidate) => candidate.name === name)
    assert.ok(found, `tool ${name} is registered`)
    return found
  }

  // The agent whose chat launched the sessions the terminal-list tests hold:
  // the terminal tools show a caller only the terminals it or its chat started.
  const LISTING_AGENT: McpConnectionContext = {
    metadata: { kind: 'studio-agent', workspaceId: 'ws-caller', agentId: 'agent-caller' },
  }

  // The connection context a Studio-launched agent's bridge presents; backlog
  // tools default their target project from this advisory identity.
  function agentContext(workspaceId: string): McpConnectionContext {
    return { metadata: { kind: 'studio-agent', workspaceId } }
  }

  async function testSettingsDefaultOnAndRoundTrip(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-automation-settings-'))
    try {
      const missing = readAutomationSettings(dir)
      assert.equal(missing.settings.enabled, true, 'missing settings file means the Studio MCP is enabled')
      assert.equal(missing.error, null)

      writeAutomationSettings(dir, { enabled: true })
      const enabled = readAutomationSettings(dir)
      assert.equal(enabled.settings.enabled, true)

      writeFileSync(join(dir, 'automation-settings.json'), 'not json')
      const malformed = readAutomationSettings(dir)
      assert.equal(malformed.settings.enabled, true, 'malformed legacy settings cannot disable the Studio MCP')
      assert.match(malformed.error ?? '', /not valid JSON/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async function testStudioGatewayStartsDespiteLegacyDisabledSetting(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-studio-mcp-service-'))
    try {
      writeAutomationSettings(dir, { enabled: false })
      const service = createAutomationService({
        resolveUserDataDir: () => dir,
        appVersion: '0.0.0-test',
        resolveBridgeScriptPath: () => BRIDGE_SCRIPT,
        resolveGatewayTools: () => [],
      })
      // Nothing to wait for in a host that never starts the gateway.
      await service.whenGatewayReady()
      // Boot starts the gateway without awaiting it; a launch waits on
      // `whenGatewayReady`, and by then the socket is listening.
      const initializing = service.initialize()
      await service.whenGatewayReady()
      assert.equal(service.getStatus().running, true, 'the gateway is listening once a launch may proceed')
      const started = await initializing
      assert.equal(started.enabled, true)
      assert.equal(started.running, true)
      assert.equal(existsSync(join(dir, STUDIO_MCP_SERVER_INFO_FILENAME)), true)
      assert.equal(existsSync(join(dir, AUTOMATION_SERVER_INFO_FILENAME)), true)

      const compatibilityDisable = await service.setEnabled(false)
      assert.equal(compatibilityDisable.enabled, true)
      assert.equal(compatibilityDisable.running, true, 'legacy toggle cannot disable the agent MCP contract')
      await service.shutdown()
      assert.equal(existsSync(join(dir, STUDIO_MCP_SERVER_INFO_FILENAME)), false)
      assert.equal(existsSync(join(dir, AUTOMATION_SERVER_INFO_FILENAME)), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async function testStudioGatewayEndpointContractAcrossPlatforms(): Promise<void> {
    const windows = resolveSocketPath('C:\\Users\\test\\AppData\\Roaming\\sprintengine', 'win32')
    assert.match(windows, /^\\\\\.\\pipe\\sprintengine-automation-[a-f0-9]{12}$/)
    const mac = resolveSocketPath('/Users/test/Library/Application Support/sprintengine', 'darwin')
    assert.equal(mac, '/Users/test/Library/Application Support/sprintengine/automation.sock')
    const linux = resolveSocketPath('/home/test/.config/sprintengine', 'linux')
    assert.equal(linux, '/home/test/.config/sprintengine/automation.sock')
    if (process.platform !== 'win32') {
      // Too long for a socket: a folder only this user can enter, never a
      // fixed name in the shared temp folder.
      const base = mkdtempSync(join(tmpdir(), 'se-socket-base-'))
      try {
        const longLinux = resolveSocketPath(`/home/test/${'nested/'.repeat(20)}sprintengine`, 'linux', base)
        const uid = process.getuid?.() ?? 0
        assert.equal(dirname(longLinux), join(base, `sprintengine-${uid}`))
        assert.match(basename(longLinux), /^automation-[a-f0-9]{12}\.sock$/)
        assert.equal(statSync(dirname(longLinux)).mode & 0o777, 0o700)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }
  }

  async function testToolListNamesTheToolSurface(): Promise<void> {
    const tools = createAutomationTools(backendsOf())
    assert.deepEqual(tools.map((registration) => registration.name).sort(), [
      'agent.launch',
      'agent.status',
      'backlog.assign',
      'backlog.list',
      'backlog.read',
      'backlog.repair',
      'backlog.update',
      'backlog.work',
      'cli.runtime.list',
      'marketplace.list',
      'module.list',
      'module.status',
      'schedule.create',
      'schedule.delete',
      'schedule.list',
      'schedule.pause',
      'schedule.resume',
      'schedule.run',
      'terminal.create',
      'terminal.list',
      'terminal.read',
      'workspace.checkout',
      'workspace.create',
      'workspace.extensions',
      'workspace.list',
      'workspace.mobile_command',
      'workspace.snapshot',
      'workspace.status',
    ])
  }

  // The list an agent or MCP client on this machine reads to see what runs.
  // It reports liveness honestly — a paused agent is not running but is not gone
  // — and carries the hook-reported phase with its provenance, so a caller can
  // tell an authoritative "waiting for you" from an output-timing guess.
  async function testTerminalListReportsAttachableSessions(): Promise<void> {
    const sessions = [
      {
        sessionId: 'session-live',
        agentRecord: { launchedBy: { workspaceId: 'ws-caller' } },
        processAlive: true,
        suspended: false,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'agent-a',
        agentName: 'Scout',
        cli: 'claude-code',
        cwd: '/repo/one',
        visible: true,
        startedAt: 10,
        lastOutputAt: 20,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'working', since: 20 },
        agentState: { phase: 'awaiting_input', source: 'hook', since: 21 },
      },
      {
        sessionId: 'session-paused',
        agentRecord: { launchedBy: { workspaceId: 'ws-caller' } },
        processAlive: false,
        suspended: true,
        kind: 'agent',
        workspaceId: 'ws-2',
        cwd: '/repo/two',
        visible: false,
        startedAt: 5,
        lastOutputAt: 6,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'idle', since: 6 },
      },
      {
        sessionId: 'session-shell',
        agentRecord: { launchedBy: { workspaceId: 'ws-caller' } },
        processAlive: true,
        suspended: false,
        kind: 'terminal',
        workspaceId: 'ws-1',
        cwd: '/repo/one',
        visible: true,
        startedAt: 30,
        lastOutputAt: 30,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'idle', since: 30 },
      },
    ] as unknown as TerminalSessionSnapshot[]
    const base = backendsOf({ sessions, workspaces: [testWorkspace('ws-1')] })
    // The workspace-name lookup must read the sync snapshot ONCE per call, never
    // once per session: on a registry of hundreds of workspaces a per-row read
    // was a whole-registry clone per row (the 30-second stall of 2026-09-05).
    let snapshotReads = 0
    const tools = createAutomationTools({
      ...base,
      getWorkspaceSyncSnapshot: () => {
        snapshotReads += 1
        return base.getWorkspaceSyncSnapshot()
      },
    })

    const all = await tool(tools, 'terminal.list').handler({}, LISTING_AGENT)
    assert.equal(all.isError, undefined, JSON.stringify(all.structuredContent))
    const listed = (
      all.structuredContent as {
        terminals: Array<{
          sessionId: string
          processAlive: boolean
          suspended: boolean
          agentState: unknown
          workspaceName: string | null
          git: unknown
        }>
      }
    ).terminals
    assert.deepEqual(
      listed.map((entry) => entry.sessionId),
      ['session-live', 'session-paused', 'session-shell'],
    )
    assert.equal(snapshotReads, 1, 'one snapshot read serves every row of a terminal.list')
    assert.equal(listed[0].workspaceName, testWorkspace('ws-1').name, 'a known workspace names its row')
    assert.equal(listed[1].workspaceName, null, 'an unknown workspace id reads as no name, never a guess')
    // Git facts are read for RUNNING sessions only: a paused or exited chat gets
    // null rather than the checkout's present numbers (the sidebar's own rule),
    // and a list never fans git out to every checkout ever held.
    assert.equal(listed[1].git, null, 'a paused session carries no git line')
    assert.deepEqual(listed[0].agentState, { phase: 'awaiting_input', source: 'hook', since: 21 })
    // Paused is its own answer: not running, not gone.
    assert.equal(listed[1].processAlive, false)
    assert.equal(listed[1].suspended, true)
    // A plain shell has no agent phase to report, and says so rather than guessing.
    assert.equal(listed[2].agentState, null)

    const filtered = await tool(tools, 'terminal.list').handler({ workspaceId: 'ws-1', kind: 'agent' }, LISTING_AGENT)
    assert.deepEqual(
      (filtered.structuredContent as { terminals: Array<{ sessionId: string }> }).terminals.map(
        (entry) => entry.sessionId,
      ),
      ['session-live'],
    )

    const refused = await tool(tools, 'terminal.list').handler({ kind: 'sideways' }, LISTING_AGENT)
    assert.equal(refused.isError, true)
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'invalid_kind')
  }

  // The facts a row needs to say what the sidebar says. Every one is additive
  // and null/zero when unknown, so a caller built before them reads the row
  // unchanged — which is why they are asserted as VALUES here rather than by
  // shape: `lastTurnEndedAt` in particular was read by a client for a whole
  // epic while this projection never sent it, and a shape assertion would not
  // have caught that.
  async function testTerminalListCarriesTheRowsProjectAndConversationFacts(): Promise<void> {
    const sessions = [
      {
        sessionId: 'session-live',
        agentRecord: { launchedBy: { workspaceId: 'ws-caller' } },
        processAlive: true,
        suspended: false,
        kind: 'agent',
        workspaceId: 'ws-1',
        cwd: '/repo/one',
        visible: true,
        startedAt: 10,
        lastOutputAt: 20,
        lastInputAt: null,
        lastVisibleAt: null,
        lastTurnEndedAt: 44,
        activeSubagents: 3,
        contextUsage: { usedPercentage: 62, at: 43 },
        pullRequests: [
          {
            url: 'https://github.com/acme/sprintengine/pull/7',
            repoKey: 'github.com/acme/sprintengine',
            repoName: 'sprintengine',
            number: 7,
            title: 'Carry the row',
            state: 'open',
            isDraft: true,
            openedAt: 1,
            readAt: 2,
          },
        ],
        activity: { kind: 'working', since: 20 },
      },
      {
        sessionId: 'session-bare',
        agentRecord: { launchedBy: { workspaceId: 'ws-caller' } },
        processAlive: true,
        suspended: false,
        kind: 'terminal',
        workspaceId: 'ws-2',
        cwd: '/repo/two',
        visible: true,
        startedAt: 30,
        lastOutputAt: 30,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'idle', since: 30 },
      },
    ] as unknown as TerminalSessionSnapshot[]

    const tools = createAutomationTools(
      backendsOf({
        sessions,
        workspaces: [
          testWorkspace('ws-1', { folderPath: '/code/sprintengine', snoozedUntil: 9_000 }),
          testWorkspace('ws-2', { folderPath: null }),
        ],
        readRepositoryIdentity: async (folderPath) =>
          folderPath === '/code/sprintengine'
            ? {
                canonicalKey: 'github.com/acme/sprintengine',
                remoteUrl: 'git@github.com:acme/sprintengine.git',
                name: 'sprintengine',
              }
            : null,
      }),
    )

    const listed = (
      (await tool(tools, 'terminal.list').handler({}, LISTING_AGENT)).structuredContent as {
        terminals: Array<Record<string, unknown>>
      }
    ).terminals

    // The field a client once read and never received.
    assert.equal(listed[0].lastTurnEndedAt, 44, 'a finished turn reports when it finished')
    assert.equal(listed[1].lastTurnEndedAt, null, 'a shell that never took a turn says null, not zero')

    assert.deepEqual(listed[0].contextUsage, { usedPercentage: 62, at: 43 })
    assert.equal(listed[1].contextUsage, null, 'a CLI-less shell reports no context usage rather than 0%')

    assert.equal(listed[0].activeSubagents, 3)
    assert.equal(listed[1].activeSubagents, 0, 'no subagents is zero, so a caller can count without a guard')

    // The hue is the shared hash of the REPOSITORY key, so this row is the same
    // degree in this list as in the desktop's own sidebar.
    assert.equal(listed[0].projectHue, projectHue('repo:github.com/acme/sprintengine'))
    assert.equal(listed[1].projectHue, null, 'a chat with no folder is not a project and wears no colour')

    assert.equal(listed[0].snoozedUntil, 9_000, 'a sleeping chat says when it wakes')
    assert.equal(listed[1].snoozedUntil, null, 'an awake chat says null, never 0')

    // The PR list is projected field by field: the row needs the state and the
    // draft flag to draw its mark, and nothing needs the read timestamps.
    assert.deepEqual(listed[0].pullRequests, [
      {
        url: 'https://github.com/acme/sprintengine/pull/7',
        repoKey: 'github.com/acme/sprintengine',
        repoName: 'sprintengine',
        number: 7,
        title: 'Carry the row',
        state: 'open',
        isDraft: true,
      },
    ])
    assert.deepEqual(listed[1].pullRequests, [], 'no pull requests is an empty list, never absent')
  }

  async function testReadToolsAnswerFromSnapshot(): Promise<void> {
    const workspace = testWorkspace('ws-1')
    workspace.agents['agent-a'] = {
      id: 'agent-a',
      name: 'Scout',
      status: 'idle',
      execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
      messages: [],
      streamBuffer: '',
      runtimeKind: 'terminal',
      cli: 'claude-code',
      cliSessionId: 'session-1',
      cliStartRequested: true,
      cliHasLaunched: true,
    } as Workspace['agents'][string]
    // The restart survivor an earlier fix had to hide (a routing placeholder with no
    // live terminal, the unactionable graveyard) no longer exists: main persists
    // the real record, so a workspace that survived a restart is listed like any
    // other and every workspace-scoped tool accepts its id.
    const restartSurvivor = testWorkspace('ws-old', { name: 'Survivor', folderPath: '/repo/old' })
    const sessions: TerminalSessionSnapshot[] = [
      {
        sessionId: 'session-1',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'agent-a',
        visible: true,
        startedAt: 10,
        lastOutputAt: 20,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'idle', since: 20 },
      } as unknown as TerminalSessionSnapshot,
    ]
    const identityReads: string[] = []
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [workspace, restartSurvivor],
        sessions,
        readRepositoryIdentity: async (folderPath) => {
          identityReads.push(folderPath)
          return folderPath === '/repo/old'
            ? { canonicalKey: 'github.com/acme/old', remoteUrl: 'git@github.com:acme/old.git', name: 'old' }
            : null
        },
      }),
    )

    const list = await tool(tools, 'workspace.list').handler({})
    assert.equal(list.isError, undefined)
    const listed = list.structuredContent as {
      workspaces: Array<{
        id: string
        detail: string
        repository: { canonicalKey: string } | null
        projectHue: number | null
      }>
    }
    assert.equal(listed.workspaces.length, 2)
    assert.deepEqual(
      listed.workspaces.map((entry) => entry.detail),
      ['full', 'full'],
    )
    // one-project-across-machines: each folder's repository rides the listing,
    // null where the reader has nothing, so a paired Studio can match clones.
    assert.deepEqual(identityReads, ['/repo/old'], 'read once per folder; a folderless workspace is not asked about')
    assert.equal(
      listed.workspaces.find((entry) => entry.id === 'ws-old')?.repository?.canonicalKey,
      'github.com/acme/old',
    )
    assert.equal(listed.workspaces.find((entry) => entry.id === 'ws-1')?.repository, null)
    // Each project's hue rides it too, the degree the sidebar paints; none for no folder.
    assert.equal(
      listed.workspaces.find((entry) => entry.id === 'ws-old')?.projectHue,
      projectHue('repo:github.com/acme/old'),
    )

    // A gateway tool operates on the restart survivor with no live agent
    // terminal — the case that used to fail `workspace_without_folder`.
    const survivorStatus = await tool(tools, 'workspace.status').handler({ workspaceId: 'ws-old' })
    assert.equal(survivorStatus.isError, undefined)
    assert.equal(
      (survivorStatus.structuredContent as { workspace: { folderPath: string | null } }).workspace.folderPath,
      '/repo/old',
    )

    const status = await tool(tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: 'agent-a' })
    assert.equal(status.isError, undefined)
    const agent = (status.structuredContent as { agent: { terminal: { processAlive: boolean } | null; cli: string } })
      .agent
    assert.equal(agent.cli, 'claude-code')
    assert.equal(agent.terminal?.processAlive, true)
  }

  async function testInvalidRequestsReturnExplicitErrors(): Promise<void> {
    const tools = createAutomationTools(backendsOf({ workspaces: [testWorkspace('ws-1')] }))

    const unknownWorkspace = await tool(tools, 'workspace.status').handler({ workspaceId: 'nope' })
    assert.equal(unknownWorkspace.isError, true)
    assert.match(JSON.stringify(unknownWorkspace.structuredContent), /unknown_workspace/)

    const malformed = await tool(tools, 'workspace.status').handler({ workspaceId: 42 })
    assert.equal(malformed.isError, true)
    assert.match(JSON.stringify(malformed.structuredContent), /invalid_arguments/)

    const unknownAgent = await tool(tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: 'ghost' })
    assert.equal(unknownAgent.isError, true)
    assert.match(JSON.stringify(unknownAgent.structuredContent), /unknown_agent/)

    const badLaunchArg = await tool(tools, 'agent.launch').handler({ workspaceId: 'ws-1', cli: 7 })
    assert.equal(badLaunchArg.isError, true)

    const launchUnknownWorkspace = await tool(tools, 'agent.launch').handler({ workspaceId: 'missing' })
    assert.equal(launchUnknownWorkspace.isError, true)
    assert.match(JSON.stringify(launchUnknownWorkspace.structuredContent), /unknown_workspace/)
  }

  // Wires a workspace + launch port that simulate a confirmed launch: the port
  // records the request, inserts the agent into the (mutated) workspace, and
  // registers a live terminal session so the handler's confirmation probe passes.
  // Returns the launch log and the worktree-creation call log.
  //
  // The launch stopped being a renderer delegation, so this stubs
  // `launchAgent` (the main-process AgentLaunchService) rather than the retired
  // renderer request — and the session it registers carries the id the launch
  // reports back, which is what the handler now confirms against.
  function launchHarness(overrides: BackendsOverrides = {}): {
    tools: ReturnType<typeof createAutomationTools>
    requests: AgentLaunchRequest[]
    worktreeCalls: Array<{ workspaceRoot: string; name: string; baseRef?: string }>
  } {
    const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
    const sessions: TerminalSessionSnapshot[] = []
    const requests: AgentLaunchRequest[] = []
    const worktreeCalls: Array<{ workspaceRoot: string; name: string; baseRef?: string }> = []
    const backends: AutomationBackends = {
      ...backendsOf({ workspaces: [workspace], sessions, ...overrides }),
      getWorkspaceSyncSnapshot: () => snapshotOf([workspace]),
      listTerminalSessions: () => sessions,
      ...(overrides.linkLaunchedAgent ? { linkLaunchedAgent: overrides.linkLaunchedAgent } : {}),
      createAgentWorktree:
        overrides.createAgentWorktree ??
        (async (input) => {
          worktreeCalls.push(input)
          return {
            worktreePath: `${input.workspaceRoot}/.sprintengine-worktrees/${input.name}`,
            branch: `agent/${input.name}`,
          }
        }),
      launchAgent:
        overrides.launchAgent ??
        (async (request) => {
          requests.push(request)
          const agentId = 'agent-claude-abc'
          workspace.agents[agentId] = {
            id: agentId,
            name: 'Scout',
            cli: 'claude-code',
            cliSessionId: 'sess-1',
          } as never
          // A full snapshot, not a stub: terminal.create projects the session it
          // just minted straight back to the caller, so a half-shaped one here
          // would pass a test the real runtime's snapshot would fail.
          sessions.push({
            sessionId: 'sess-1',
            kind: 'agent',
            workspaceId: 'ws-1',
            agentId,
            agentName: 'Scout',
            // The CLI the launch service resolved, in its real order: the request
            // when it named one, otherwise this machine's last-selected CLI.
            cli: request.cli ?? overrides.defaultCli ?? 'claude-code',
            cwd: request.worktreePath ?? '/tmp/project-a',
            processAlive: true,
            suspended: false,
            visible: false,
            startedAt: 1,
            lastOutputAt: 1,
            lastInputAt: null,
            lastVisibleAt: null,
            activity: { kind: 'idle', since: 1 },
            // The record the launch service mints: an unnamed preset resolved
            // through the same function it uses, on a machine nobody has
            // configured.
            agentRecord: {
              agentId,
              name: 'Scout',
              cli: request.cli ?? overrides.defaultCli ?? 'claude-code',
              cliPermissionPreset: resolveAgentSpawnPermissionPreset(
                emptyAgentLaunchSettings(),
                request.cli ?? overrides.defaultCli ?? 'claude-code',
                request.permissionPreset,
              ),
            },
          } as never)
          return {
            ok: true,
            workspaceId: request.workspaceId,
            agentId,
            sessionId: 'sess-1',
            cli: request.cli ?? overrides.defaultCli ?? 'claude-code',
            executionId: 'sess-1',
          }
        }),
    }
    return { tools: createAutomationTools(backends), requests, worktreeCalls }
  }

  // An agent of this app that launches another is linked to it, so it hears
  // back; the result says whether it will. A caller that is not one of this
  // app's agents, or that asked not to be told, is not linked.
  async function testAgentLaunchLinksItsCallerForNotices(): Promise<void> {
    const links: LaunchedAgentLink[] = []
    const linking = launchHarness({ linkLaunchedAgent: (link) => (links.push(link), { linked: true as const }) })
    const caller = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-lead' } }
    const launched = await tool(linking.tools, 'agent.launch').handler({ workspaceId: 'ws-1' }, caller)
    assert.equal(launched.isError, undefined, JSON.stringify(launched.structuredContent))
    assert.equal((launched.structuredContent as { notifyParent: boolean }).notifyParent, true)
    assert.deepEqual(links, [
      {
        parent: { workspaceId: 'ws-1', agentId: 'agent-lead' },
        child: {
          workspaceId: 'ws-1',
          agentId: 'agent-claude-abc',
          sessionId: 'sess-1',
          transport: 'terminal',
          name: 'Scout',
        },
      },
    ])

    const declined = launchHarness({ linkLaunchedAgent: (link) => (links.push(link), { linked: true as const }) })
    const quiet = await tool(declined.tools, 'agent.launch').handler(
      { workspaceId: 'ws-1', notifyParent: false },
      caller,
    )
    assert.equal((quiet.structuredContent as { notifyParent: boolean }).notifyParent, false)

    const outsider = launchHarness({ linkLaunchedAgent: (link) => (links.push(link), { linked: true as const }) })
    const external = await tool(outsider.tools, 'agent.launch').handler(
      { workspaceId: 'ws-1' },
      { metadata: { kind: 'external-local' } },
    )
    assert.equal((external.structuredContent as { notifyParent: boolean }).notifyParent, false)
    assert.match(
      (external.structuredContent as { notifyParentReason: string }).notifyParentReason,
      /not come from an agent of this app/u,
    )
    assert.equal(links.length, 1, 'neither the declined launch nor the outsider was linked')
    assert.equal('notifyParentReason' in (quiet.structuredContent as object), false, 'asked not to: nothing to explain')

    // A parent the notices cannot tell says why, in the result.
    const hookless = launchHarness({
      linkLaunchedAgent: () => ({ linked: false, reason: "The calling agent's CLI does not report its turns." }),
    })
    const untold = await tool(hookless.tools, 'agent.launch').handler({ workspaceId: 'ws-1' }, caller)
    assert.equal((untold.structuredContent as { notifyParent: boolean }).notifyParent, false)
    assert.equal(
      (untold.structuredContent as { notifyParentReason: string }).notifyParentReason,
      "The calling agent's CLI does not report its turns.",
    )

    const badFlag = await tool(launchHarness().tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      notifyParent: 'yes',
    })
    assert.equal((badFlag.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  async function testAgentLaunchWidensConfigAndIsolation(): Promise<void> {
    // bypass is a preset like any other here (owner ruling 2026-09-27), and its
    // pre-rename spelling means the same thing.
    for (const spelling of ['bypass', 'bypass_all']) {
      const bypass = launchHarness()
      const accepted = await tool(bypass.tools, 'agent.launch').handler({
        workspaceId: 'ws-1',
        permissionPreset: spelling,
      })
      assert.equal(accepted.isError, undefined, JSON.stringify(accepted.structuredContent))
      assert.equal(bypass.requests[0].permissionPreset, 'bypass', `${spelling} launches as bypass`)
    }

    // An out-of-vocabulary preset is a plain invalid_arguments failure.
    const badPreset = await tool(launchHarness().tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      permissionPreset: 'root',
    })
    assert.equal((badPreset.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    // The full config is forwarded verbatim; no worktree requested ⇒ no creation.
    const configured = launchHarness()
    const okConfig = await tool(configured.tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      name: 'Scout',
      prompt: 'go',
      cliModel: 'opus',
      permissionPreset: 'none',
    })
    assert.equal(okConfig.isError, undefined, JSON.stringify(okConfig.structuredContent))
    assert.equal(configured.worktreeCalls.length, 0, 'no worktree requested ⇒ createAgentWorktree not called')
    const req = configured.requests[0]
    assert.equal(req.cliModel, 'opus')
    assert.equal(req.permissionPreset, 'none')

    // Manual and Auto launch as themselves, and a caller written before the
    // preset rename still gets what its spelling meant.
    for (const [spelled, preset] of [
      ['manual', 'manual'],
      ['auto', 'auto'],
      ['default', 'manual'],
      ['auto_workspace', 'auto'],
    ] as const) {
      const older = launchHarness()
      const answered = await tool(older.tools, 'agent.launch').handler({
        workspaceId: 'ws-1',
        permissionPreset: spelled,
      })
      assert.equal(answered.isError, undefined, JSON.stringify(answered.structuredContent))
      assert.equal(older.requests[0].permissionPreset, preset, `${spelled} launches as ${preset}`)
    }
    assert.equal(req.worktreePath, undefined)
    assert.equal((okConfig.structuredContent as { worktreePath?: string }).worktreePath, undefined)

    // worktree:{} creates an agent/<name> worktree and threads its path through the
    // launch request and the success payload.
    const isolated = launchHarness()
    const okWorktree = await tool(isolated.tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      name: 'Scout',
      worktree: {},
    })
    assert.equal(okWorktree.isError, undefined, JSON.stringify(okWorktree.structuredContent))
    assert.deepEqual(isolated.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'Scout' }])
    const worktreeReq = isolated.requests[0]
    assert.equal(worktreeReq.worktreePath, '/tmp/project-a/.sprintengine-worktrees/Scout')
    assert.equal(
      (okWorktree.structuredContent as { worktreePath?: string }).worktreePath,
      '/tmp/project-a/.sprintengine-worktrees/Scout',
    )
    assert.equal(
      (okWorktree.structuredContent as { worktreeBranch?: string }).worktreeBranch,
      'agent/Scout',
      'the branch the worktree was minted on is reported, for the row that will name it',
    )

    // worktree.baseRef (checkout-and-branch-on-remote-create) is the ref the
    // worktree forks from — a branch the caller read off workspace.checkout —
    // and reaches the git helper as such; absent, the helper forks HEAD.
    const forked = launchHarness()
    const okForked = await tool(forked.tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      name: 'Scout',
      worktree: { name: 'fix', baseRef: 'release/2' },
    })
    assert.equal(okForked.isError, undefined, JSON.stringify(okForked.structuredContent))
    assert.deepEqual(forked.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'fix', baseRef: 'release/2' }])
    const badBase = await tool(launchHarness().tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      worktree: { baseRef: 7 },
    })
    assert.equal((badBase.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    // A connector forces a worktree even without an explicit worktree request.
    const connector = launchHarness()
    const okConnector = await tool(connector.tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      name: 'Scout',
      connectorId: 'railway',
    })
    assert.equal(okConnector.isError, undefined, JSON.stringify(okConnector.structuredContent))
    assert.deepEqual(connector.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'Scout' }])
    const connectorReq = connector.requests[0]
    assert.equal(connectorReq.connectorId, 'railway')
    assert.equal(connectorReq.worktreePath, '/tmp/project-a/.sprintengine-worktrees/Scout')

    // A worktree-creation failure is fatal isolation — worktree_unavailable, and
    // the launch never happens.
    const failed = launchHarness({ createAgentWorktree: async () => ({ error: 'not a git repository' }) })
    const denied = await tool(failed.tools, 'agent.launch').handler({ workspaceId: 'ws-1', worktree: { name: 'x' } })
    assert.equal(denied.isError, true)
    assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'worktree_unavailable')
    assert.equal(failed.requests.length, 0, 'a failed worktree never reaches the renderer')

    // A bare-string worktree (not an object) is rejected — no raw cwd surface.
    const badWorktree = await tool(launchHarness().tools, 'agent.launch').handler({
      workspaceId: 'ws-1',
      worktree: '/etc',
    })
    assert.equal((badWorktree.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  // A worktree whose project installs its dependencies first answers the
  // gateway call at once: the agent's id, state installing_dependencies, and
  // the install. The agent starts when the install ends, however it ends,
  // under that id, and agent.status says where it is all along.
  async function testAgentLaunchAnswersWhileItsWorktreeInstalls(): Promise<void> {
    const view = (state: 'running' | 'failed'): WorktreeDependencyInstallView => ({
      id: 'install-1',
      repoRoot: '/tmp/project-a',
      path: '/tmp/project-a/.sprintengine-worktrees/x',
      branch: 'agent/x',
      command: 'npm ci',
      reason: 'changed',
      state,
      startedAt: 10,
      endedAt: state === 'running' ? null : 20,
      lastLine: state === 'running' ? 'added 12 packages' : 'npm error 403',
      output: null,
      exitCode: state === 'running' ? null : 1,
    })
    const harnessWith = (
      settled: Promise<WorktreeDependencyInstallView | null>,
      linkLaunchedAgent?: AutomationBackends['linkLaunchedAgent'],
      // Holds the launch after its terminal is live, before it answers.
      launching?: Promise<void>,
    ) => {
      let current = view('running')
      void settled.then((ended) => {
        if (ended) current = ended
      })
      const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
      const sessions: TerminalSessionSnapshot[] = []
      const requests: AgentLaunchRequest[] = []
      const backends: AutomationBackends = {
        ...backendsOf({ workspaces: [workspace], sessions }),
        getWorkspaceSyncSnapshot: () => snapshotOf([workspace]),
        listTerminalSessions: () => sessions,
        ...(linkLaunchedAgent ? { linkLaunchedAgent } : {}),
        createAgentWorktree: async (input) => ({
          worktreePath: `${input.workspaceRoot}/.sprintengine-worktrees/${input.name}`,
          branch: `agent/${input.name}`,
          dependencyInstall: { view: view('running'), current: () => current, settled },
        }),
        launchAgent: async (request) => {
          requests.push(request)
          const agentId = request.agentId!
          workspace.agents[agentId] = { id: agentId, name: 'Scout', cli: 'claude-code' } as never
          sessions.push({
            sessionId: 'sess-9',
            kind: 'agent',
            workspaceId: 'ws-1',
            agentId,
            agentName: 'Scout',
            cli: 'claude-code',
            cwd: request.worktreePath,
            processAlive: true,
          } as never)
          await launching
          return {
            ok: true,
            workspaceId: 'ws-1',
            agentId,
            sessionId: 'sess-9',
            cli: 'claude-code',
            executionId: 'sess-9',
          }
        },
      }
      return { tools: createAutomationTools(backends), requests }
    }
    const settle = () => {
      let resolve: (value: WorktreeDependencyInstallView | null) => void = () => {}
      const promise = new Promise<WorktreeDependencyInstallView | null>((done) => (resolve = done))
      return { promise, resolve }
    }
    const flush = async () => {
      for (let pass = 0; pass < 20; pass += 1) await new Promise((resolve) => setImmediate(resolve))
    }

    const install = settle()
    let letLaunchAnswer: () => void = () => {}
    const launching = new Promise<void>((resolve) => (letLaunchAnswer = resolve))
    const links: LaunchedAgentLink[] = []
    const h = harnessWith(install.promise, (link) => (links.push(link), { linked: true as const }), launching)
    const caller = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-lead' } }
    const answered = await tool(h.tools, 'agent.launch').handler(
      { workspaceId: 'ws-1', name: 'Scout', worktree: { name: 'x' } },
      caller,
    )
    assert.equal(answered.isError, undefined, JSON.stringify(answered.structuredContent))
    const first = answered.structuredContent as {
      agent: { agentId: string; state: string; terminal: null; dependencyInstall: { state: string; command: string } }
      notifyParent: boolean
      notifyParentReason: string
      worktreePath: string
    }
    assert.match(first.agent.agentId, /^agent-claude-code-/u, 'the id the launch would mint, minted now')
    assert.equal(first.agent.state, 'installing_dependencies')
    assert.equal(first.agent.terminal, null)
    assert.deepEqual(
      { state: first.agent.dependencyInstall.state, command: first.agent.dependencyInstall.command },
      { state: 'running', command: 'npm ci' },
    )
    assert.equal(first.worktreePath, '/tmp/project-a/.sprintengine-worktrees/x')
    assert.equal(first.notifyParent, false)
    assert.match(first.notifyParentReason, /linked to it then/u)
    assert.equal(h.requests.length, 0, 'nothing started while the install runs')

    const waiting = await tool(h.tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: first.agent.agentId })
    assert.equal(waiting.isError, undefined, 'an agent waiting on its install is known')
    assert.equal((waiting.structuredContent as { agent: { state: string } }).agent.state, 'installing_dependencies')

    // The install fails: the agent starts anyway, under the id it was given,
    // in its worktree, and the caller is linked to it then.
    install.resolve(view('failed'))
    await flush()
    assert.equal(h.requests.length, 1)
    // Its terminal is live but the start is not confirmed yet: no longer
    // installing, and not started either.
    const starting = await tool(h.tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: first.agent.agentId })
    const mid = starting.structuredContent as { agent: { state?: string; terminal: { processAlive: boolean } } }
    assert.equal(mid.agent.state, 'starting')
    assert.equal(mid.agent.terminal.processAlive, true)
    letLaunchAnswer()
    await flush()
    assert.equal(h.requests[0]!.agentId, first.agent.agentId)
    assert.equal(h.requests[0]!.worktreePath, '/tmp/project-a/.sprintengine-worktrees/x')
    assert.equal(links.length, 1)
    assert.equal(links[0]!.child.agentId, first.agent.agentId)
    const started = await tool(h.tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: first.agent.agentId })
    const after = started.structuredContent as {
      agent: {
        state?: string
        terminal: { processAlive: boolean }
        dependencyInstall: { state: string; exitCode: number }
      }
      notifyParent: boolean
    }
    assert.equal(after.agent.state, undefined, 'started: no waiting state')
    assert.equal(after.agent.terminal.processAlive, true)
    assert.equal(after.agent.dependencyInstall.state, 'failed', 'and the caller can read that it runs without them')
    assert.equal(after.notifyParent, true)

    // The app quitting while it installs: nothing starts on the way out.
    const quitting = settle()
    const q = harnessWith(quitting.promise)
    const asked = await tool(q.tools, 'agent.launch').handler({ workspaceId: 'ws-1', worktree: { name: 'x' } })
    const agentId = (asked.structuredContent as { agent: { agentId: string } }).agent.agentId
    quitting.resolve(null)
    await flush()
    assert.equal(q.requests.length, 0)
    const gone = await tool(q.tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId })
    assert.equal((gone.structuredContent as { agent: { state: string } }).agent.state, 'launch_failed')
  }

  async function testCreateMintsInMainWithNoWindow(): Promise<void> {
    // The delegate-then-poll shape this used to assert is gone: there
    // is no renderer to ask and no bus confirmation to wait on, so the tool
    // succeeds with zero windows and returns the record main just committed.
    const backends = backendsOf()
    const tools = createAutomationTools(backends)
    const created = await tool(tools, 'workspace.create').handler({
      name: 'Created via automation',
      folderPath: '/repo/a',
    })
    assert.equal(created.isError, undefined, 'creation no longer depends on a window being open')
    const projection = (
      created.structuredContent as {
        workspace: { id: string; name: string; folderPath: string | null; detail: string }
      }
    ).workspace
    assert.equal(projection.id, 'ws-created-1')
    assert.equal(projection.name, 'Created via automation')
    assert.equal(projection.folderPath, '/repo/a')
    assert.equal(projection.detail, 'full', 'there is no routing-only projection left to report')
  }

  async function testCreateSurfacesARegistryRefusal(): Promise<void> {
    // A refusal from main is reported with its own reason — never softened into a
    // success, and never a timeout for something that is not a timeout.
    const backends = backendsOf({
      createWorkspace: () => ({ ok: false, reason: 'registry_commit_failed', message: 'disk is gone' }),
    })
    const tools = createAutomationTools(backends)
    const created = await tool(tools, 'workspace.create').handler({})
    assert.equal(created.isError, true)
    assert.match(JSON.stringify(created.structuredContent), /registry_commit_failed/)
  }

  // Opening an agent terminal on this machine for a local caller. The session
  // id is the deliverable — the caller follows the session it just opened — and
  // the workspace can be named the way the person names it, without an id.
  async function testTerminalCreateSpawnsAndReturnsTheAttachableSession(): Promise<void> {
    const byId = launchHarness()
    const created = await tool(byId.tools, 'terminal.create').handler({ workspaceId: 'ws-1', prompt: 'go' })
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
    const payload = created.structuredContent as {
      sessionId: string
      workspaceId: string
      agentId: string
      permissionPreset: string
      terminal: { sessionId: string; kind: string; processAlive: boolean; cli: string | null }
    }
    assert.equal(payload.sessionId, 'sess-1', 'the caller gets the session id, not a search hint')
    assert.equal(payload.workspaceId, 'ws-1')
    assert.equal(payload.terminal.sessionId, 'sess-1')
    assert.equal(payload.terminal.processAlive, true, 'success is a live session, not a launch call returning')
    assert.equal(byId.requests[0].prompt, 'go')
    // No worktree and no connector: terminal.create is not a second door onto
    // agent.launch's workspace-mutating options.
    assert.equal(byId.worktreeCalls.length, 0)
    assert.equal(byId.requests[0].worktreePath, undefined)
    assert.equal(byId.requests[0].connectorId, undefined)

    // A workspace named rather than identified.
    const byName = launchHarness()
    const named = await tool(byName.tools, 'terminal.create').handler({ workspaceName: 'workspace ws-1' })
    assert.equal(named.isError, undefined, JSON.stringify(named.structuredContent))
    assert.equal(byName.requests[0].workspaceId, 'ws-1')

    const unknownName = await tool(launchHarness().tools, 'terminal.create').handler({ workspaceName: 'nowhere' })
    assert.equal((unknownName.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')

    const bothWays = await tool(launchHarness().tools, 'terminal.create').handler({
      workspaceId: 'ws-1',
      workspaceName: 'Workspace ws-1',
    })
    assert.equal((bothWays.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    const neither = await tool(launchHarness().tools, 'terminal.create').handler({})
    assert.equal((neither.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    // Two workspaces sharing a name is an explicit refusal naming both ids:
    // opening a terminal in the wrong project is not a recoverable mistake.
    const twins = [
      testWorkspace('ws-left', { name: 'Twin', folderPath: '/tmp/left' }),
      testWorkspace('ws-right', { name: 'Twin', folderPath: '/tmp/right' }),
    ]
    const ambiguous = await tool(createAutomationTools(backendsOf({ workspaces: twins })), 'terminal.create').handler({
      workspaceName: 'twin',
    })
    assert.equal((ambiguous.structuredContent as { error: { code: string } }).error.code, 'ambiguous_workspace_name')
    assert.match(JSON.stringify(ambiguous.structuredContent), /ws-left/)
    assert.match(JSON.stringify(ambiguous.structuredContent), /ws-right/)
  }

  // workspace.checkout (checkout-and-branch-on-remote-create): the read a
  // paired Studio makes before choosing where a remote chat runs. It projects
  // the backend's facts under the workspace id, and answers a folderless or
  // unknown workspace with the same failures every workspace tool gives.
  async function testWorkspaceCheckoutReportsTheBackendsFacts(): Promise<void> {
    const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
    const orphan = testWorkspace('ws-none', { folderPath: null })
    const reads: string[] = []
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [workspace, orphan],
        readWorkspaceCheckout: async (root) => {
          reads.push(root)
          return {
            git: true,
            branch: 'main',
            defaultBranch: 'main',
            branches: [
              { name: 'feat/x', current: false },
              { name: 'main', current: true },
            ],
            worktrees: [{ path: '/tmp/project-a', branch: 'main', isMain: true }],
          }
        },
      }),
    )
    const answer = await tool(tools, 'workspace.checkout').handler({ workspaceId: 'ws-1' })
    assert.equal(answer.isError, undefined, JSON.stringify(answer.structuredContent))
    assert.deepEqual(reads, ['/tmp/project-a'], 'the read is against the workspace folder')
    const facts = answer.structuredContent as {
      workspaceId: string
      git: boolean
      branch: string | null
      defaultBranch: string | null
      branches: Array<{ name: string; current: boolean }>
      worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
    }
    assert.equal(facts.workspaceId, 'ws-1')
    assert.equal(facts.git, true)
    assert.equal(facts.branch, 'main')
    assert.deepEqual(
      facts.branches.map((entry) => entry.name),
      ['feat/x', 'main'],
    )
    assert.equal(facts.worktrees[0]?.isMain, true)

    const noFolder = await tool(tools, 'workspace.checkout').handler({ workspaceId: 'ws-none' })
    assert.equal((noFolder.structuredContent as { error: { code: string } }).error.code, 'workspace_without_folder')
    const unknown = await tool(tools, 'workspace.checkout').handler({ workspaceId: 'ws-ghost' })
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')
    assert.equal(
      isStudioGatewayMutation('workspace.checkout'),
      false,
      'a read, on workspace:read — the worktree itself is agent.launch',
    )
  }

  // This machine's own settings decide the CLI and the preset unless the caller
  // names them, the same as a launch from the desktop would.
  async function testTerminalCreateTakesThisMachinesLaunchDefaults(): Promise<void> {
    const inherited = launchHarness({ defaultCli: 'codex' })
    const ok = await tool(inherited.tools, 'terminal.create').handler({ workspaceId: 'ws-1' })
    assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent))
    assert.equal(
      inherited.requests[0].cli,
      undefined,
      'an unnamed CLI is left to the launch service, which reads the same settings store',
    )
    // An unnamed preset is left to the launch service too, and the answer
    // reports what it resolved: this machine's spawn default, `auto`.
    assert.equal(inherited.requests[0].permissionPreset, undefined, 'an unnamed preset is not floored here')
    assert.equal((ok.structuredContent as { permissionPreset: string }).permissionPreset, 'auto')
    // The CLI reported is the one the session actually spawned under.
    assert.equal((ok.structuredContent as { terminal: { cli: string } }).terminal.cli, 'codex')

    // An explicit CLI and preset are forwarded.
    const overridden = launchHarness({ defaultCli: 'codex' })
    const named = await tool(overridden.tools, 'terminal.create').handler({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      permissionPreset: 'none',
    })
    assert.equal(overridden.requests[0].cli, 'claude-code')
    assert.equal(overridden.requests[0].permissionPreset, 'none')
    assert.equal((named.structuredContent as { permissionPreset: string }).permissionPreset, 'none')

    // Asked for by either spelling: bypass is forwarded and reported.
    for (const spelling of ['bypass', 'bypass_all']) {
      const asked = launchHarness()
      const accepted = await tool(asked.tools, 'terminal.create').handler({
        workspaceId: 'ws-1',
        permissionPreset: spelling,
      })
      assert.equal(accepted.isError, undefined, JSON.stringify(accepted.structuredContent))
      assert.equal(asked.requests[0].permissionPreset, 'bypass', `${spelling} launches as bypass`)
      assert.equal((accepted.structuredContent as { permissionPreset: string }).permissionPreset, 'bypass')
    }

    // A launch failure is reported as itself, never as a created terminal.
    const broken = launchHarness({
      launchAgent: async () => ({ ok: false, code: 'no_cli_selected', message: 'nobody has chosen a CLI' }),
    })
    const failed = await tool(broken.tools, 'terminal.create').handler({ workspaceId: 'ws-1' })
    assert.equal(failed.isError, true)
    assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'no_cli_selected')
  }

  async function testSocketServerSpeaksMcpAndOnlyWhenStarted(): Promise<void> {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'se-automation-sock-')), 'automation.sock')
    let attributedAgentId: string | undefined
    const echoTool: McpToolRegistration = {
      name: 'workspace.list',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, context) => {
        attributedAgentId = context?.metadata.agentId
        return { content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }
      },
    }
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-automation',
      serverVersion: '0.0.0-test',
      resolveTools: () => [echoTool],
    })

    // Not started → nothing listens.
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const probe = connect(socketPath)
          probe.once('connect', () => {
            probe.destroy()
            resolve()
          })
          probe.once('error', reject)
        }),
      /ENOENT|ECONNREFUSED/,
      'no listener before start',
    )

    await server.start()
    try {
      const socket = connect(socketPath)
      socket.setEncoding('utf8')
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })

      const responses: Array<Record<string, unknown>> = []
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) responses.push(JSON.parse(line))
          newline = buffer.indexOf('\n')
        }
      })
      const waitForResponses = async (count: number): Promise<void> => {
        const deadline = Date.now() + 5_000
        while (responses.length < count) {
          if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${count} responses (got ${responses.length})`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }

      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'sprintengine.studio/connect', params: { agentId: 'agent-a', workspaceId: 'ws-1' } })}\n`,
      )
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`,
      )
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } })}\n`,
      )
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bogus.tool' } })}\n`,
      )
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'no/such/method' })}\n`)
      socket.write('this is not json\n')
      await waitForResponses(6)

      const byId = new Map(responses.map((response) => [response.id, response]))
      const init = byId.get(1) as {
        result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: object } }
      }
      assert.equal(init.result.protocolVersion, '2025-03-26')
      assert.equal(init.result.serverInfo.name, 'sprintengine-automation')
      assert.ok(init.result.capabilities.tools)

      const tools = byId.get(2) as { result: { tools: Array<{ name: string }> } }
      assert.deepEqual(
        tools.result.tools.map((entry) => entry.name),
        ['workspace.list'],
      )

      const call = byId.get(3) as { result: { structuredContent: { workspaces: unknown[] } } }
      assert.deepEqual(call.result.structuredContent.workspaces, [])
      assert.equal(attributedAgentId, 'agent-a', 'connection metadata is applied before the first tool call')

      const unknownTool = byId.get(4) as { error: { code: number; message: string } }
      assert.equal(unknownTool.error.code, -32602)
      assert.match(unknownTool.error.message, /Unknown tool/)

      const unknownMethod = byId.get(5) as { error: { code: number } }
      assert.equal(unknownMethod.error.code, -32601)

      const parseError = byId.get(null) as { error: { code: number } }
      assert.equal(parseError.error.code, -32700)

      socket.destroy()
    } finally {
      await server.stop()
    }

    // Stopped → the socket file is gone and nothing listens again.
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const probe = connect(socketPath)
          probe.once('connect', () => {
            probe.destroy()
            resolve()
          })
          probe.once('error', reject)
        }),
      /ENOENT|ECONNREFUSED/,
      'no listener after stop',
    )
  }

  async function testInitializeNegotiatesTheProtocolVersionInsteadOfEchoingIt(): Promise<void> {
    // The gateway used to answer initialize with whatever protocolVersion the client
    // asked for, which told a spec-tracking client (one asking for 2026-07-28 today)
    // that we speak a spec we do not implement.
    // Supported → itself; unsupported, malformed, or absent → our default.
    // The probe is a far-future date deliberately: a real upcoming spec version would
    // have to be re-pointed here the moment we start serving it, and the subject of
    // this test is the downgrade rule, not any one version.
    const unsupported = '2099-01-01'
    assert.ok(!SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(unsupported), 'this test needs a version we do NOT serve')
    // The maximum rose to 2026-07-28 in the commit that earned it: handshake-optional
    // framing, per-request `_meta.protocolVersion`, and `ttlMs` (the two tests below).
    assert.equal(DEFAULT_MCP_PROTOCOL_VERSION, '2026-07-28', 'the declared default is the declared maximum')

    const dir = mkdtempSync(join(tmpdir(), 'se-automation-negotiate-'))
    const socketPath = join(dir, 'automation.sock')
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-automation',
      serverVersion: '0.0.0-test',
      resolveTools: () => [],
    })
    await server.start()
    try {
      const socket = connect(socketPath)
      socket.setEncoding('utf8')
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })
      const responses: Array<Record<string, unknown>> = []
      let raw = ''
      let buffer = ''
      socket.on('data', (chunk: string) => {
        raw += chunk
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) responses.push(JSON.parse(line))
          newline = buffer.indexOf('\n')
        }
      })

      const initialize = (id: number, params: Record<string, unknown>): void => {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params })}\n`)
      }
      initialize(1, { protocolVersion: '2025-03-26' })
      initialize(2, { protocolVersion: unsupported })
      initialize(3, {})
      initialize(4, { protocolVersion: 20260728 })
      initialize(5, { protocolVersion: '2026-07-28' })
      // A revision we do not know that sits BETWEEN two we do serve. Answering
      // our maximum here named a version the client could not parse and it
      // rejected the handshake, so every spawned agent came up with no tools.
      initialize(6, { protocolVersion: '2025-11-25' })
      // Older than anything we serve: answer our oldest, still never our newest.
      initialize(7, { protocolVersion: '2024-01-01' })
      await waitUntil('seven initialize responses', () => responses.length >= 7)

      const answered = new Map(
        responses.map((response) => [response.id, (response.result as { protocolVersion: string }).protocolVersion]),
      )
      assert.equal(answered.get(1), '2025-03-26', 'a supported version is answered with itself')
      assert.equal(answered.get(2), DEFAULT_MCP_PROTOCOL_VERSION, 'an unsupported version downgrades, never errors')
      assert.equal(answered.get(3), DEFAULT_MCP_PROTOCOL_VERSION, 'an absent version answers the default')
      assert.equal(answered.get(4), DEFAULT_MCP_PROTOCOL_VERSION, 'a non-string version answers the default')
      assert.equal(answered.get(5), '2026-07-28', 'the version this gateway now implements is answered with itself')
      assert.equal(answered.get(6), '2025-06-18', 'an unknown version downgrades to the newest we serve at or below it')
      assert.equal(
        answered.get(7),
        '2024-11-05',
        'a client older than everything we serve gets our oldest, not our newest',
      )
      assert.ok(!raw.includes(unsupported), 'the requested version must never come back to the caller')

      socket.destroy()
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * A started socket server plus one connected client that collects newline-delimited
   * JSON-RPC responses. Deliberately sends no `initialize`: every test below it is
   * about a connection that never handshakes.
   *
   * Keep `prefix` short — a Unix socket path is capped near 104 bytes, and the temp
   * dir eats half of that, so a descriptive prefix fails `listen` with EINVAL.
   */
  async function handshakelessClient(prefix: string): Promise<{
    send: (frame: Record<string, unknown>) => void
    responses: Array<Record<string, unknown>>
    close: () => Promise<void>
  }> {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    const socketPath = join(dir, 'automation.sock')
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-automation',
      serverVersion: '0.0.0-test',
      resolveTools: () => [
        {
          name: 'workspace.list',
          description: 'test tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }),
        },
      ],
    })
    await server.start()
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const responses: Array<Record<string, unknown>> = []
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) responses.push(JSON.parse(line))
        newline = buffer.indexOf('\n')
      }
    })
    return {
      send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
      responses,
      close: async () => {
        socket.destroy()
        await server.stop()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  async function testToolsAnswerAConnectionThatNeverInitialized(): Promise<void> {
    // 2026-07-28 removes the initialize/initialized handshake, so a spec-tracking
    // client opens the socket and calls straight away. That already worked here (the
    // dispatch has no handshake gate), which is exactly why it needs pinning: nothing
    // in the code says "do not add a gate", so only this test stops one being added.
    const client = await handshakelessClient('sprintengine-mcp-nohandshake-')
    try {
      client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } })
      await waitUntil('two responses on a connection that never initialized', () => client.responses.length >= 2)

      const byId = new Map(client.responses.map((response) => [response.id, response]))
      const list = byId.get(1) as { error?: unknown; result: { tools: Array<{ name: string }>; ttlMs: number } }
      assert.equal(list.error, undefined, 'tools/list is not gated on a handshake')
      assert.deepEqual(
        list.result.tools.map((entry) => entry.name),
        ['workspace.list'],
      )
      // ttlMs (SEP-2549): five minutes, because module enable/disable rewrites this
      // surface live and notifications/tools/list_changed rides the same socket.
      assert.equal(list.result.ttlMs, 300_000, 'tools/list carries a cache hint')
      assert.ok(!('cacheScope' in list.result), 'no cacheScope value is invented')

      const call = byId.get(2) as { error?: unknown; result: { structuredContent: { workspaces: unknown[] } } }
      assert.equal(call.error, undefined, 'tools/call is not gated on a handshake')
      assert.deepEqual(call.result.structuredContent.workspaces, [])
    } finally {
      await client.close()
    }
  }

  async function testPerRequestProtocolVersionDeclarationIsValidated(): Promise<void> {
    // With the handshake optional and no headers on this transport, `params._meta.
    // protocolVersion` is the only place a client can state which spec its frame
    // speaks. A declaration is a commitment: unlike initialize (which downgrades),
    // an unsupported one is refused rather than served under semantics nobody agreed to.
    const unsupported = '2099-01-01'
    assert.ok(!SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(unsupported), 'this test needs a version we do NOT serve')

    const client = await handshakelessClient('sprintengine-mcp-declared-')
    try {
      const meta = (protocolVersion: unknown): Record<string, unknown> => ({ _meta: { protocolVersion } })
      client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: meta(DEFAULT_MCP_PROTOCOL_VERSION) })
      client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: meta(unsupported) })
      client.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
      client.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: meta(20260728) })
      client.send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'workspace.list', arguments: {}, ...meta(unsupported) },
      })
      client.send({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'workspace.list', arguments: {}, ...meta(DEFAULT_MCP_PROTOCOL_VERSION) },
      })
      await waitUntil('six responses', () => client.responses.length >= 6)

      const byId = new Map(client.responses.map((response) => [response.id, response]))
      const served = (id: number, why: string): void => {
        const response = byId.get(id) as { error?: { message: string }; result?: unknown }
        assert.equal(response.error, undefined, why)
        assert.ok(response.result, why)
      }
      const refused = (id: number, why: string): void => {
        const response = byId.get(id) as { error: { code: number; message: string }; result?: unknown }
        assert.equal(response.error.code, -32602, why)
        assert.match(response.error.message, /Unsupported MCP protocol version/, why)
        for (const version of SUPPORTED_MCP_PROTOCOL_VERSIONS) {
          assert.ok(response.error.message.includes(version), `the refusal names ${version}`)
        }
        assert.equal(response.result, undefined, 'a refused request is never also served')
      }
      served(1, 'a supported declared version is served normally')
      refused(2, 'an unsupported declared version is refused')
      served(3, 'no declaration at all is served normally')
      refused(4, 'a non-string declaration is a claim we cannot honour, not an absent one')
      refused(5, 'the check covers tools/call, not just tools/list')
      served(6, 'a supported declaration does not stop the tool running')
    } finally {
      await client.close()
    }
  }

  async function testStaleSocketFileIsReplacedOnStart(): Promise<void> {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'se-automation-stale-'))
    const socketPath = join(dir, 'automation.sock')
    writeFileSync(socketPath, '')
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-automation',
      serverVersion: '0.0.0-test',
      resolveTools: () => [],
    })
    await server.start()
    assert.equal(server.isRunning(), true, 'stale socket file does not block startup')
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }

  // The stdio bridge is a standalone script (never bundled with the app), so
  // these tests spawn it as a real child process. Tests run from the repo root
  // via the npm script, so cwd-relative resolution is stable.
  const BRIDGE_SCRIPT = join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')

  type BridgeExit = { code: number | null; stdoutLines: Array<Record<string, unknown>>; stderr: string }

  function spawnBridge(
    infoPath: string,
    env: NodeJS.ProcessEnv = process.env,
  ): {
    child: ChildProcessWithoutNullStreams
    stdoutLines: Array<Record<string, unknown>>
    stderrChunks: string[]
    exited: Promise<BridgeExit>
  } {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, '--info-path', infoPath], { stdio: 'pipe', env })
    const stdoutLines: Array<Record<string, unknown>> = []
    const stderrChunks: string[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) stdoutLines.push(JSON.parse(line))
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))
    const exited = new Promise<BridgeExit>((resolve) => {
      child.once('exit', (code) => resolve({ code, stdoutLines, stderr: stderrChunks.join('') }))
    })
    return { child, stdoutLines, stderrChunks, exited }
  }

  async function waitUntil(what: string, probe: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  async function testBridgePipesStdioToSocketAndOutlivesServerStop(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-automation-bridge-'))
    const socketPath = join(dir, 'automation.sock')
    const infoPath = join(dir, 'automation-server-info.json')
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-automation',
      serverVersion: '0.0.0-test',
      resolveTools: () => [
        {
          name: 'workspace.list',
          description: 'test tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }),
        },
      ],
    })
    await server.start()
    writeFileSync(infoPath, JSON.stringify({ socketPath, protocol: 'mcp-jsonrpc-ndjson', pid: process.pid }))
    const bridge = spawnBridge(infoPath)
    try {
      bridge.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`,
      )
      bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      await waitUntil('bridge responses', () => bridge.stdoutLines.length >= 2)

      const byId = new Map(bridge.stdoutLines.map((response) => [response.id, response]))
      const init = byId.get(1) as { result: { serverInfo: { name: string } } }
      assert.equal(init.result.serverInfo.name, 'sprintengine-automation')
      const tools = byId.get(2) as { result: { tools: Array<{ name: string }> } }
      assert.deepEqual(
        tools.result.tools.map((entry) => entry.name),
        ['workspace.list'],
      )
    } finally {
      // Server stop closes the socket. The bridge stays, waiting for Studio to
      // come back: an MCP client marks a stdio server that exits "not
      // connected" for the rest of its session.
      await server.stop()
    }
    const early = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve(null), 1_000))])
    assert.equal(early, null, 'the bridge outlives the server it was talking to')
    // It leaves, cleanly, when its client closes stdin.
    bridge.child.stdin.end()
    const exit = await bridge.exited
    assert.equal(exit.code, 0, `bridge exits 0 once its client is gone (stderr: ${exit.stderr})`)
    rmSync(dir, { recursive: true, force: true })
  }

  async function testConcurrentBridgesKeepResponsesAndAttributionIsolated(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-studio-mcp-concurrency-'))
    const socketPath = join(dir, 'automation.sock')
    const infoPath = join(dir, STUDIO_MCP_SERVER_INFO_FILENAME)
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-studio',
      serverVersion: '0.0.0-test',
      resolveTools: () => [
        {
          name: 'agent.identity',
          description: 'test attribution',
          inputSchema: { type: 'object' },
          handler: async (args, context) => {
            if (typeof args.delayMs === 'number')
              await new Promise((resolve) => setTimeout(resolve, args.delayMs as number))
            const agentId = context?.metadata.agentId ?? 'external-local'
            return { content: [{ type: 'text', text: agentId }], structuredContent: { agentId } }
          },
        },
      ],
    })
    await server.start()
    writeFileSync(infoPath, JSON.stringify({ socketPath, protocol: 'mcp-jsonrpc-ndjson', pid: process.pid }))
    const first = spawnBridge(infoPath, { ...process.env, SPRINTENGINE_AGENT_ID: 'agent-first' })
    const second = spawnBridge(infoPath, { ...process.env, SPRINTENGINE_AGENT_ID: 'agent-second' })
    try {
      for (const bridge of [first, second]) {
        bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
      }
      first.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent.identity', arguments: { delayMs: 40 } } })}\n`,
      )
      second.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent.identity', arguments: {} } })}\n`,
      )
      await waitUntil(
        'two independent bridge responses',
        () => first.stdoutLines.length >= 2 && second.stdoutLines.length >= 2,
      )
      const firstCall = first.stdoutLines.find((response) => response.id === 2) as {
        result: { structuredContent: { agentId: string } }
      }
      const secondCall = second.stdoutLines.find((response) => response.id === 2) as {
        result: { structuredContent: { agentId: string } }
      }
      assert.equal(firstCall.result.structuredContent.agentId, 'agent-first')
      assert.equal(secondCall.result.structuredContent.agentId, 'agent-second')
    } finally {
      await server.stop()
    }
    first.child.stdin.end()
    second.child.stdin.end()
    const [firstExit, secondExit] = await Promise.all([first.exited, second.exited])
    assert.equal(firstExit.code, 0)
    assert.equal(secondExit.code, 0)
    rmSync(dir, { recursive: true, force: true })
  }

  async function testBridgeFailsClearlyWithoutDiscoveryFile(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-automation-bridge-off-'))
    const bridge = spawnBridge(join(dir, 'automation-server-info.json'))
    const exit = await bridge.exited
    assert.equal(exit.code, 1, 'missing discovery file is a hard failure')
    assert.match(exit.stderr, /not running|disabled/i)
    rmSync(dir, { recursive: true, force: true })
  }

  async function testBridgeReportsStaleDiscoveryFile(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-automation-bridge-stale-'))
    // A freshly-exited child gives a pid that is certainly not alive.
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()))
    writeFileSync(
      join(dir, 'automation-server-info.json'),
      JSON.stringify({ socketPath: join(dir, 'gone.sock'), pid: dead.pid }),
    )
    const bridge = spawnBridge(join(dir, 'automation-server-info.json'))
    const exit = await bridge.exited
    assert.equal(exit.code, 1)
    assert.match(exit.stderr, /stale/i)
    rmSync(dir, { recursive: true, force: true })
  }

  async function testReadToolsResolveWorkspaceRootThroughSnapshot(): Promise<void> {
    const seenRoots: string[] = []
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [
          testWorkspace('ws-1', { folderPath: '/tmp/project-a' }),
          testWorkspace('ws-routing', { templateId: 'workspace-sync-routing-placeholder', folderPath: '/tmp/stale' }),
          testWorkspace('ws-folderless', { folderPath: null }),
        ],
        listBacklogItems: async (root) => {
          seenRoots.push(root)
          return {
            ok: true,
            key: 'MC',
            items: [
              {
                relativePath: 'backlog/2026-07-08-example.md',
                title: 'Example',
                id: 7,
                isEpic: false,
                status: 'ready',
              },
            ],
          }
        },
      }),
    )

    // Backlog reads default to the connection's own workspace — no id argument.
    const listed = await tool(tools, 'backlog.list').handler({}, agentContext('ws-1'))
    assert.equal(listed.isError, undefined)
    assert.deepEqual(listed.structuredContent, {
      workspaceKey: 'MC',
      items: [
        { relativePath: 'backlog/2026-07-08-example.md', title: 'Example', id: 7, isEpic: false, status: 'ready' },
      ],
    })

    assert.deepEqual(seenRoots, ['/tmp/project-a'], 'the tool resolves the snapshot folderPath')

    // An explicit projectRoot addresses any folder directly — external callers
    // are not gated on the app's workspace registry.
    const external = await tool(tools, 'backlog.list').handler({ projectRoot: '/tmp/external-clone' })
    assert.equal(external.isError, undefined, 'projectRoot works without any connection identity')
    assert.equal(seenRoots[1], '/tmp/external-clone')

    const relative = await tool(tools, 'backlog.list').handler({ projectRoot: 'not/absolute' })
    assert.equal((relative.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    // No projectRoot and no resolvable connection workspace ⇒ a clear failure.
    const bare = await tool(tools, 'backlog.list').handler({})
    assert.equal((bare.structuredContent as { error: { code: string } }).error.code, 'project_root_required')
    const unknown = await tool(tools, 'backlog.list').handler({}, agentContext('nope'))
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'project_root_required')

    // A restart-restored routing placeholder still resolves for the very agent
    // connected from it — the connection itself is the liveness proof.
    const routing = await tool(tools, 'backlog.list').handler({}, agentContext('ws-routing'))
    assert.equal(routing.isError, undefined, 'a connected agent may use its restored folder route')
    assert.equal(seenRoots[2], '/tmp/stale')

    const folderless = await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-folderless',
      prompt: 'tidy up',
      cron: '0 9 * * *',
    })
    assert.equal((folderless.structuredContent as { error: { code: string } }).error.code, 'workspace_without_folder')
  }

  async function testBacklogRepairRoutesOnlyValidatedIntegrityOperations(): Promise<void> {
    const repairs: Array<Record<string, unknown>> = []
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        backlogWrite: {
          repairIntegrity: async (input) => {
            repairs.push(input)
            return {
              ok: true,
              relativePath: input.relativePath,
              issue: input.issue,
              ...(input.issue === 'duplicate_id' ? { previousNumericId: 1741, numericId: 1744 } : { replacements: 1 }),
            }
          },
        },
      }),
    )
    const repair = tool(tools, 'backlog.repair')
    const repaired = await repair.handler({ path: 'backlog/example.md', issue: 'duplicate_id' }, agentContext('ws-1'))
    assert.equal(repaired.isError, undefined)
    assert.deepEqual(repairs, [
      {
        workspaceRoot: '/tmp/project-a',
        relativePath: 'backlog/example.md',
        issue: 'duplicate_id',
      },
    ])
    assert.deepEqual(repaired.structuredContent, {
      repaired: {
        ok: true,
        relativePath: 'backlog/example.md',
        issue: 'duplicate_id',
        previousNumericId: 1741,
        numericId: 1744,
      },
    })

    const invalid = await repair.handler({ path: 'backlog/example.md', issue: 'rewrite_body' }, agentContext('ws-1'))
    assert.equal(invalid.isError, true)
    assert.equal((invalid.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
    assert.equal(repairs.length, 1, 'invalid repair never reaches the writer')
  }

  async function testBacklogUpdateAppliesInOrderAndStopsOnFailure(): Promise<void> {
    const calls: string[] = []
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        backlogWrite: {
          updateStatus: async (input) => {
            calls.push(`status:${input.status}`)
            return { ok: true, store: { schemaVersion: 1, items: [] } }
          },
          updateType: async () => {
            calls.push('type')
            return { ok: false, message: 'Enter a valid Backlog item type.' }
          },
          updateEpic: async () => {
            calls.push('epic')
            return { ok: true, store: { schemaVersion: 1, items: [] } }
          },
        },
      }),
    )
    const update = tool(tools, 'backlog.update')

    const failed = await update.handler(
      { path: 'backlog/example.md', status: 'in_progress', type: 'feature', epic: null },
      agentContext('ws-1'),
    )
    assert.equal(failed.isError, true)
    assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'backlog_update_failed')
    assert.deepEqual(calls, ['status:in_progress', 'type'], 'stops at the first failing write; epic never runs')

    const empty = await update.handler({ path: 'backlog/example.md' }, agentContext('ws-1'))
    assert.equal((empty.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    const nullStatus = await update.handler({ path: 'backlog/example.md', status: null }, agentContext('ws-1'))
    assert.equal((nullStatus.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  // The epic ordering mark is the one field an agent sets to say "the
  // planning phase for this epic is over", so backlog.update has to carry it.
  async function testBacklogUpdateCarriesTheEpicOrderingMark(): Promise<void> {
    const marks: boolean[] = []
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        backlogWrite: {
          updateDependenciesPlanned: async (input) => {
            marks.push(input.dependenciesPlanned)
            return { ok: true, store: { schemaVersion: 1, items: [] } }
          },
        },
      }),
    )
    const update = tool(tools, 'backlog.update')

    const marked = await update.handler(
      { path: 'backlog/epics/auth.md', dependenciesPlanned: true },
      agentContext('ws-1'),
    )
    assert.equal(marked.isError, undefined)
    const cleared = await update.handler(
      { path: 'backlog/epics/auth.md', dependenciesPlanned: false },
      agentContext('ws-1'),
    )
    assert.equal(cleared.isError, undefined)
    assert.deepEqual(marks, [true, false], 'the mark is written exactly as asserted, both ways')

    // It is an assertion, not a string: a stringy "true" is refused before any write.
    const stringy = await update.handler(
      { path: 'backlog/epics/auth.md', dependenciesPlanned: 'true' },
      agentContext('ws-1'),
    )
    assert.equal((stringy.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
    assert.equal(marks.length, 2, 'an invalid mark never reaches the writer')
  }

  async function testBacklogAssignBuildsTheCanonicalLink(): Promise<void> {
    const linked: Array<Record<string, unknown>> = []
    const workspace = testWorkspace('ws-1', {
      folderPath: '/tmp/project-a',
      agents: {
        'agent-7': { name: 'Paddy', cli: 'claude-code' } as never,
      },
    })
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [workspace],
        backlogWrite: {
          addOrUpdateLink: async (input) => {
            linked.push(input as unknown as Record<string, unknown>)
            return { ok: true, store: { schemaVersion: 1, items: [] } }
          },
        },
      }),
    )
    const assign = tool(tools, 'backlog.assign')

    const assigned = await assign.handler({ path: 'backlog/example.md', agentId: 'agent-7' }, agentContext('ws-1'))
    assert.equal(assigned.isError, undefined)
    assert.equal(linked.length, 1)
    const input = linked[0] as {
      workspaceRoot: string
      relativePath: string
      status?: unknown
      link: { id: string; moduleId: string; type: string; label: string; target: { kind: string; id: string } }
    }
    assert.equal(input.workspaceRoot, '/tmp/project-a')
    assert.equal(input.relativePath, 'backlog/example.md')
    assert.equal(input.status, undefined, 'assignment is lifecycle-neutral; it must never move item status')
    assert.equal(input.link.id, 'agent-runtime:working-agent')
    assert.equal(input.link.moduleId, 'agent-runtime')
    assert.equal(input.link.type, 'agent')
    assert.equal(input.link.label, 'Agent: Paddy')
    assert.deepEqual(
      { kind: input.link.target.kind, id: input.link.target.id },
      { kind: 'agent.terminal', id: 'ws-1/agent-7' },
    )

    const unknownAgent = await assign.handler({ path: 'backlog/example.md', agentId: 'nope' }, agentContext('ws-1'))
    assert.equal((unknownAgent.structuredContent as { error: { code: string } }).error.code, 'unknown_agent')

    // An explicit projectRoot resolves to the open workspace using that folder —
    // and refuses folders no open workspace uses (agent links need the registry).
    const byRoot = await assign.handler({
      projectRoot: '/tmp/project-a',
      path: 'backlog/example.md',
      agentId: 'agent-7',
    })
    assert.equal(byRoot.isError, undefined, 'projectRoot maps back to the open workspace record')
    assert.equal(linked.length, 2)
    const elsewhere = await assign.handler({
      projectRoot: '/tmp/not-open',
      path: 'backlog/example.md',
      agentId: 'agent-7',
    })
    assert.equal((elsewhere.structuredContent as { error: { code: string } }).error.code, 'workspace_not_open')
  }

  // A minimal LoadedPlugin whose manifest carries just the id + optional
  // skillIntegration backlog.work reads. `template` undefined models a CLI with no
  // skill integration (the fallback path).
  function fakeCliPlugin(id: string, template?: string): LoadedPlugin {
    return {
      manifest: {
        id,
        ...(template
          ? { skillIntegration: { support: 'native', harnessId: id, invocation: { fileDropTemplate: template } } }
          : {}),
      },
      source: 'bundled',
      manifestPath: `/plugins/${id}/plugin.json`,
      pluginRoot: `/plugins/${id}`,
    } as unknown as LoadedPlugin
  }

  async function testBacklogWorkHandsItemToAgent(): Promise<void> {
    const links: Array<Record<string, unknown>> = []
    const ensured: Array<{ workspaceRoot: string; skillId: string }> = []
    const harness = launchHarness({
      listPlugins: () => [fakeCliPlugin('claude-code', '/{{skillId}} {{path}}')],
      readBacklogItem: async (_root, relativePath) => ({
        ok: true,
        item: { relativePath, title: 'Thing', isEpic: false, status: 'ready' },
        body: 'body',
      }),
      ensureBuiltinSkillInstalled: async (workspaceRoot, skillId) => {
        ensured.push({ workspaceRoot, skillId })
        return true
      },
      backlogWrite: {
        addOrUpdateLink: async (input) => {
          links.push(input as unknown as Record<string, unknown>)
          return { ok: true, store: { schemaVersion: 1, items: [] } }
        },
      },
    })

    const worked = await tool(harness.tools, 'backlog.work').handler(
      {
        path: 'backlog/example.md',
        cli: 'claude-code',
        name: 'Scout',
        instructions: 'Focus on the failing test first.',
      },
      agentContext('ws-1'),
    )
    assert.equal(worked.isError, undefined, JSON.stringify(worked.structuredContent))
    const result = (
      worked.structuredContent as {
        worked: {
          invocation: string
          skillEnsured: boolean
          assigned: boolean
          agentId: string
          relativePath: string
          warning?: string
        }
      }
    ).worked
    assert.equal(result.invocation, '/backlog backlog/example.md', 'Claude plugin renders /backlog <path>')
    assert.equal(result.skillEnsured, true)
    assert.equal(result.assigned, true)
    assert.equal(result.warning, undefined)
    assert.equal(result.relativePath, 'backlog/example.md')
    assert.equal(result.agentId, 'agent-claude-abc')

    // The launched startup prompt is the invocation with instructions appended.
    const req = harness.requests[0]
    assert.equal(req.prompt, '/backlog backlog/example.md\n\nFocus on the failing test first.')
    assert.equal(req.cli, 'claude-code')

    // The backlog skill is ensured before launch; the working-agent link is
    // written to the item and never carries a status change.
    assert.deepEqual(ensured, [{ workspaceRoot: '/tmp/project-a', skillId: 'backlog' }])
    assert.equal(links.length, 1)
    const link = links[0] as { relativePath: string; status?: unknown; link: { type: string; label: string } }
    assert.equal(link.relativePath, 'backlog/example.md')
    assert.equal(link.status, undefined, 'backlog.work never moves item status (skill contract owns lifecycle)')
    assert.equal(link.link.type, 'agent')
    assert.equal(link.link.label, 'Agent: Scout')
  }

  async function testBacklogWorkFallsBackAndRefusesFinishedItems(): Promise<void> {
    // A CLI without skillIntegration ⇒ plain-language fallback naming the path and
    // the lifecycle contract; with no instructions the prompt IS the fallback.
    const fallback = launchHarness({
      listPlugins: () => [fakeCliPlugin('mystery-cli')],
      readBacklogItem: async (_root, relativePath) => ({
        ok: true,
        item: { relativePath, title: 'T', isEpic: false, status: 'in_progress' },
        body: '',
      }),
      backlogWrite: { addOrUpdateLink: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }) },
    })
    const worked = await tool(fallback.tools, 'backlog.work').handler(
      { path: 'backlog/example.md', cli: 'mystery-cli' },
      agentContext('ws-1'),
    )
    assert.equal(worked.isError, undefined, JSON.stringify(worked.structuredContent))
    const invocation = (worked.structuredContent as { worked: { invocation: string } }).worked.invocation
    assert.match(invocation, /Work the Backlog item at backlog\/example\.md/)
    assert.match(invocation, /in_progress/)
    assert.match(invocation, /completed/)
    const req = fallback.requests[0]
    assert.equal(req.prompt, invocation, 'no instructions ⇒ prompt is exactly the fallback invocation')

    // completed and archived items are refused and never launched.
    for (const [item, path] of [
      [{ relativePath: 'backlog/done.md', title: 'D', isEpic: false, status: 'completed' as const }, 'backlog/done.md'],
      [
        { relativePath: 'backlog/archived/old.md', title: 'O', isEpic: false, status: 'ready' as const },
        'backlog/archived/old.md',
      ],
    ] as const) {
      const refuse = launchHarness({ readBacklogItem: async () => ({ ok: true, item, body: '' }) })
      const refused = await tool(refuse.tools, 'backlog.work').handler({ path }, agentContext('ws-1'))
      assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'backlog_item_not_workable')
      assert.equal(refuse.requests.length, 0, 'a non-workable item is never launched')
    }

    // A missing/invalid path is not_found (and never launched).
    const missing = launchHarness({ readBacklogItem: async () => ({ ok: false, message: 'no such item' }) })
    const notFound = await tool(missing.tools, 'backlog.work').handler(
      { path: 'backlog/gone.md' },
      agentContext('ws-1'),
    )
    assert.equal((notFound.structuredContent as { error: { code: string } }).error.code, 'backlog_item_not_found')
    assert.equal(missing.requests.length, 0)
  }

  async function testBacklogWorkPresetsAndPostLaunchLinkFailure(): Promise<void> {
    // bypass launches the item's agent like any other preset, and an omitted
    // one is left to the launch service's own resolution.
    const readyItem: BackendsOverrides['readBacklogItem'] = async (_root, relativePath) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
      body: '',
    })
    const linked: BackendsOverrides = {
      readBacklogItem: readyItem,
      backlogWrite: { addOrUpdateLink: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }) },
    }
    const bypass = launchHarness(linked)
    const accepted = await tool(bypass.tools, 'backlog.work').handler(
      { path: 'backlog/example.md', permissionPreset: 'bypass' },
      agentContext('ws-1'),
    )
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted.structuredContent))
    assert.equal(bypass.requests[0].permissionPreset, 'bypass')
    const omitted = launchHarness(linked)
    await tool(omitted.tools, 'backlog.work').handler({ path: 'backlog/example.md' }, agentContext('ws-1'))
    assert.equal(omitted.requests[0].permissionPreset, undefined, 'an unnamed preset is not floored here')

    // A link-write failure AFTER a confirmed launch is not overall failure: the
    // agent is already running, so the tool returns ok + assigned:false + warning.
    // A non-fatal skill-ensure failure rides skillEnsured:false in the same call.
    const linkFail = launchHarness({
      listPlugins: () => [fakeCliPlugin('claude-code', '/{{skillId}} {{path}}')],
      ensureBuiltinSkillInstalled: async () => false,
      readBacklogItem: async (_root, relativePath) => ({
        ok: true,
        item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
        body: '',
      }),
      backlogWrite: { addOrUpdateLink: async () => ({ ok: false, message: 'items.json is read-only' }) },
    })
    const worked = await tool(linkFail.tools, 'backlog.work').handler(
      { path: 'backlog/example.md', cli: 'claude-code' },
      agentContext('ws-1'),
    )
    assert.equal(worked.isError, undefined, 'a post-launch link failure is not overall failure')
    const result = (
      worked.structuredContent as {
        worked: { assigned: boolean; warning?: string; skillEnsured: boolean; agentId: string }
      }
    ).worked
    assert.equal(result.assigned, false)
    assert.equal(result.skillEnsured, false, 'a non-fatal skill-ensure failure rides skillEnsured')
    assert.match(result.warning ?? '', /read-only/)
    assert.equal(result.agentId, 'agent-claude-abc', 'the launched agent id is still reported')
    assert.equal(linkFail.requests.length, 1, 'the agent was launched exactly once')
  }

  // A fake of the scheduled agents service: it records what the tools hand it
  // and answers as `answers` says. Validation is the service's, not the tools'.
  function fakeScheduledAgents(
    answers: {
      create?: (input: unknown) => ScheduledAgentWriteResult
      runNow?: (id: string) => { ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }
    } = {},
  ) {
    const calls = { created: [] as unknown[], ran: [] as string[], removed: [] as string[] }
    const agents: ScheduledAgentView[] = [scheduledAgentView({ id: 'sa-1' })]
    const service = {
      list: () => agents,
      pausedAll: () => null,
      get: (id: string) => agents.find((agent) => agent.id === id) ?? null,
      create: async (input: unknown): Promise<ScheduledAgentWriteResult> => {
        calls.created.push(input)
        return answers.create?.(input) ?? { ok: true, agent: scheduledAgentView({ id: 'sa-2' }) }
      },
      remove: async (id: string) => {
        calls.removed.push(id)
        return agents.some((agent) => agent.id === id)
          ? ({ ok: true } as const)
          : ({ ok: false, message: `No scheduled agent "${id}".` } as const)
      },
      runNow: async (id: string) => {
        calls.ran.push(id)
        return answers.runNow?.(id) ?? { ok: true as const, run: { at: 0, ok: true as const, workspaceId: 'ws-run' } }
      },
    } as unknown as ScheduledAgentsService
    return { service, calls }
  }

  function scheduledAgentView(fields: Partial<ScheduledAgentView>): ScheduledAgentView {
    return {
      id: 'sa-1',
      prompt: 'Triage new issues',
      schedule: { cron: '0 21 * * 0', timezone: 'UTC' },
      folderPath: '/tmp/project-a',
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
      nextRunAt: Date.UTC(2026, 9, 4, 21, 0),
      ...fields,
    }
  }

  async function testScheduleToolsDriveTheScheduledAgentsService(): Promise<void> {
    const { service, calls } = fakeScheduledAgents()
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [
          testWorkspace('ws-1', { folderPath: '/tmp/project-a' }),
          testWorkspace('ws-tree', {
            folderPath: '/tmp/project-a/.worktrees/fix',
            worktree: { branch: 'agent/fix', baseRef: 'HEAD', repoRoot: '/tmp/project-a' },
            hostId: 'wsl:Ubuntu',
          } as Partial<Workspace>),
        ],
        getScheduledAgents: () => service,
      }),
    )

    // The list says each schedule in words and its next run as an instant.
    const listed = await tool(tools, 'schedule.list').handler({})
    const first = (listed.structuredContent as { scheduledAgents: Array<Record<string, unknown>> }).scheduledAgents[0]!
    assert.equal(first.scheduleWords, 'Every Sunday at 9:00 PM')
    assert.equal(first.nextRunAt, '2026-10-04T21:00:00.000Z')

    // A create is a draft for the service: the workspace's project and machine,
    // the last-picked CLI when none is named, and this computer's zone.
    const created = await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-1',
      prompt: 'Triage new issues',
      cron: '0 9 * * 1-5',
      worktree: true,
      skills: ['gh-triage'],
    })
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
    const draft = calls.created[0] as Record<string, unknown>
    assert.equal(draft.prompt, 'Triage new issues')
    assert.equal((draft.schedule as { cron: string }).cron, '0 9 * * 1-5')
    assert.equal((draft.schedule as { timezone: string }).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
    assert.equal(draft.folderPath, '/tmp/project-a')
    assert.equal(draft.hostId, null)
    assert.equal(draft.cli, 'claude-code')
    assert.equal(draft.permissionPreset, null, 'an omitted preset follows the choice at run time')
    assert.deepEqual(draft.worktree, { name: '' })
    assert.deepEqual(draft.skills, [{ id: 'gh-triage', name: 'gh-triage' }])

    // A workspace on a worktree schedules into its project, on its machine.
    await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-tree',
      prompt: 'x',
      cron: '@daily',
      timezone: 'UTC',
    })
    const fromTree = calls.created[1] as Record<string, unknown>
    assert.equal(fromTree.folderPath, '/tmp/project-a')
    assert.equal(fromTree.hostId, 'wsl:Ubuntu')
    assert.equal((fromTree.schedule as { timezone: string }).timezone, 'UTC')

    // A paired device's New chat names the schedule, a one-time instant and
    // the worktree's name, as this machine's own door does.
    await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-1',
      prompt: 'Check the deploy',
      cron: '30 15 7 10 *',
      timezone: 'UTC',
      once: '2026-10-07T15:30:00.000Z',
      name: 'Deploy check',
      worktreeName: 'deploy-check',
    })
    const fromDevice = calls.created[2] as Record<string, unknown>
    assert.equal(fromDevice.name, 'Deploy check')
    assert.equal((fromDevice.schedule as { once: number }).once, Date.parse('2026-10-07T15:30:00.000Z'))
    assert.deepEqual(fromDevice.worktree, { name: 'deploy-check' })
    const badOnce = await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-1',
      prompt: 'x',
      cron: '0 9 * * *',
      once: 'next tuesday',
    })
    assert.equal((badOnce.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    const ran = await tool(tools, 'schedule.run').handler({ id: 'sa-1' })
    assert.deepEqual(ran.structuredContent, { workspaceId: 'ws-run' })
    assert.deepEqual(calls.ran, ['sa-1'])

    const removed = await tool(tools, 'schedule.delete').handler({ id: 'sa-1' })
    assert.deepEqual(removed.structuredContent, { removed: 'sa-1' })
    const unknown = await tool(tools, 'schedule.delete').handler({ id: 'nope' })
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_scheduled_agent')

    // Module disabled/not loaded ⇒ explicit failure, never buffering.
    const withoutModule = createAutomationTools(
      backendsOf({ workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })] }),
    )
    for (const [name, args] of [
      ['schedule.list', {}],
      ['schedule.create', { workspaceId: 'ws-1', prompt: 'x', cron: '0 9 * * *' }],
      ['schedule.delete', { id: 'sa-1' }],
      ['schedule.run', { id: 'sa-1' }],
      ['schedule.pause', { id: 'sa-1' }],
      ['schedule.resume', { id: 'sa-1' }],
    ] as const) {
      const result = await tool(withoutModule, name).handler(args as Record<string, unknown>)
      assert.equal(result.isError, true)
      assert.equal(
        (result.structuredContent as { error: { code: string } }).error.code,
        'scheduled_agents_unavailable',
        name,
      )
    }
  }

  // A chat a schedule started may list the schedules but not make, remove or
  // fire one, so no run can start a chain of runs. Any other chat, and a
  // caller with no identity, keeps every tool.
  async function testAScheduledRunsChatMayNotChangeSchedules(): Promise<void> {
    const { service, calls } = fakeScheduledAgents()
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [
          testWorkspace('ws-1', { folderPath: '/tmp/project-a' }),
          testWorkspace('ws-run', { folderPath: '/tmp/project-a', scheduledAgentId: 'sa-1' }),
        ],
        getScheduledAgents: () => service,
      }),
    )
    const fromRun = agentContext('ws-run')
    const listed = await tool(tools, 'schedule.list').handler({}, fromRun)
    assert.equal(listed.isError, undefined, 'a run may still read the schedules')
    for (const [name, args] of [
      ['schedule.create', { workspaceId: 'ws-1', prompt: 'x', cron: '0 9 * * *' }],
      ['schedule.delete', { id: 'sa-1' }],
      ['schedule.run', { id: 'sa-1' }],
    ] as const) {
      const result = await tool(tools, name).handler(args as Record<string, unknown>, fromRun)
      const error = (result.structuredContent as { error: { code: string; message: string } }).error
      assert.equal(error.code, 'scheduled_run_refused', name)
      assert.match(error.message, /started by a scheduled agent/u, name)
    }
    assert.deepEqual(calls, { created: [], ran: [], removed: [] }, 'nothing reached the service')

    // The same calls from an ordinary chat, and from a caller that named no chat, go through.
    for (const context of [agentContext('ws-1'), undefined]) {
      const created = await tool(tools, 'schedule.create').handler(
        { workspaceId: 'ws-1', prompt: 'x', cron: '0 9 * * *' },
        context,
      )
      assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
      const ran = await tool(tools, 'schedule.run').handler({ id: 'sa-1' }, context)
      assert.equal(ran.isError, undefined, JSON.stringify(ran.structuredContent))
      const removed = await tool(tools, 'schedule.delete').handler({ id: 'sa-1' }, context)
      assert.equal(removed.isError, undefined, JSON.stringify(removed.structuredContent))
    }
  }

  // Every surface may spawn in bypass (owner ruling 2026-09-27): an external
  // caller gets the same two presets a person at the launcher does, and an
  // omitted one means what it means there. This pins that the tool boundary
  // neither refuses bypass nor quietly floors an omission to `none`.
  async function testBothPresetsAreOpenAtTheExternalToolBoundary(): Promise<void> {
    const { service, calls } = fakeScheduledAgents()
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        getScheduledAgents: () => service,
      }),
    )

    // The advertised vocabulary is exactly the four presets, on every tool that
    // launches an agent, and the text says what an omission means.
    for (const name of ['agent.launch', 'backlog.work', 'terminal.create'] as const) {
      const properties = tool(tools, name).inputSchema.properties as Record<
        string,
        { enum?: unknown; description?: string }
      >
      assert.deepEqual(
        properties.permissionPreset?.enum,
        ['none', 'manual', 'auto', 'bypass'],
        `${name} advertises every preset`,
      )
      assert.match(
        properties.permissionPreset?.description ?? '',
        /Omitted, the launch takes the preset chosen for that CLI on this machine, else the app default "auto"/,
        `${name} says what an omitted preset resolves to`,
      )
      // The one refusal it names is an agent of this app asking above its own
      // preset (launch-permission-cap.test.ts); nobody else is refused one.
      assert.match(
        properties.permissionPreset?.description ?? '',
        /Called by an agent of this app, the launch runs no looser than that agent's own preset: a looser one is refused/,
        `${name} refuses a preset only to an agent above its own`,
      )
    }

    // Every preset, and every retired spelling of one, is stored as the preset
    // it means; a schedule that names none follows the choice at run time.
    const spellings = ['bypass', 'bypass_all', 'none', 'manual', 'default', 'auto', 'auto_workspace']
    for (const preset of spellings) {
      const answer = await tool(tools, 'schedule.create').handler({
        workspaceId: 'ws-1',
        prompt: 'do it',
        cron: '0 9 * * *',
        permissionPreset: preset,
      })
      assert.equal(answer.isError, undefined, `an explicit "${preset}" scheduled agent is created`)
    }
    const omitted = await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-1',
      prompt: 'do it',
      cron: '0 9 * * *',
    })
    assert.equal(omitted.isError, undefined, 'a scheduled agent that names no preset is created')
    assert.deepEqual(
      calls.created.map((input) => (input as { permissionPreset: string | null }).permissionPreset),
      ['bypass', 'bypass', 'none', 'manual', 'manual', 'auto', 'auto', null],
      'each preset is stored as the preset it means',
    )
    const unreadable = await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-1',
      prompt: 'do it',
      cron: '0 9 * * *',
      permissionPreset: 'root',
    })
    assert.equal((unreadable.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  // The acceptance the owner ruling states, end to end through the real launch
  // service: a preset nobody named resolves exactly as it would at the desktop
  // launcher — the person's choice for the CLI, else the app default — and the
  // resolved preset is what renders the CLI's flag.
  async function testAnOmittedPresetResolvesLikeTheDesktopLauncher(): Promise<void> {
    const claudeManifest = JSON.parse(
      readFileSync(new URL('../../../resources/plugins/claude-code/plugin.json', import.meta.url), 'utf8'),
    ) as PluginManifest
    const launchWith = async (settings: AgentLaunchSettings, tool_: string, args: Record<string, unknown>) => {
      const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
      const sessions: TerminalSessionSnapshot[] = []
      const spawns: TerminalSpawnPayload[] = []
      const service = createAgentLaunchService({
        listWorkspaces: () => [{ id: 'ws-1', mode: 'standard', folderPath: '/tmp/project-a', agents: {} }],
        getLaunchSettings: () => settings,
        terminal: {
          list: () => sessions,
          spawn: async (payload) => {
            spawns.push(payload)
            sessions.push({
              sessionId: payload.sessionId,
              kind: 'agent',
              workspaceId: 'ws-1',
              agentId: payload.agentId,
              cli: payload.cli,
              processAlive: true,
              suspended: false,
              visible: false,
              startedAt: 1,
              lastOutputAt: 1,
              lastInputAt: null,
              lastVisibleAt: null,
              activity: { kind: 'idle', since: 1 },
              agentRecord: payload.agentRecord,
            } as never)
            return { ok: true, sessionId: payload.sessionId }
          },
          kill: () => undefined,
        },
        newSessionId: () => 'sess-real',
        newAgentSuffix: () => 'abc123',
      })
      const tools = createAutomationTools({
        ...backendsOf({ workspaces: [workspace], sessions }),
        getWorkspaceSyncSnapshot: () => snapshotOf([workspace]),
        listTerminalSessions: () => sessions,
        launchAgent: (request) => service.launch(request),
      })
      const answer = await tool(tools, tool_).handler({ workspaceId: 'ws-1', cli: 'claude-code', ...args })
      assert.equal(answer.isError, undefined, JSON.stringify(answer.structuredContent))
      assert.equal(spawns.length, 1)
      return { answer, preset: spawns[0]!.cliPermissionPreset }
    }
    const bypassFlag = ['--permission-mode', 'bypassPermissions']

    // A machine nobody chose on: an omitted preset launches with the CLI's own
    // auto mode (owner request 2026-10-01), on every launching tool.
    for (const name of ['agent.launch', 'terminal.create']) {
      const { preset } = await launchWith(emptyAgentLaunchSettings(), name, {})
      assert.equal(preset, 'auto', `${name}: the app default reaches the spawn`)
      assert.deepEqual(
        resolvePermissionArgs(claudeManifest, preset),
        ['--permission-mode', 'auto'],
        `${name}: with Claude Code's auto mode`,
      )
    }
    // A person who chose Bypass for the CLI keeps it.
    const chosenBypass = { ...emptyAgentLaunchSettings(), cliPermissionPresets: { 'claude-code': 'bypass' as const } }
    assert.deepEqual(
      resolvePermissionArgs(claudeManifest, (await launchWith(chosenBypass, 'agent.launch', {})).preset),
      bypassFlag,
    )

    // A person who chose `none` for this CLI: the same omitted preset passes no
    // flag, and terminal.create reports what was resolved.
    const chosenNone = { ...emptyAgentLaunchSettings(), cliPermissionPresets: { 'claude-code': 'none' as const } }
    const { answer, preset } = await launchWith(chosenNone, 'terminal.create', {})
    assert.equal(preset, 'none', "the person's choice for the CLI wins over the app default")
    assert.deepEqual(resolvePermissionArgs(claudeManifest, preset), [], 'and no permission flag is passed')
    assert.equal((answer.structuredContent as { permissionPreset: string }).permissionPreset, 'none')

    // A caller that names bypass gets it even where the person chose none: the
    // caller's own value comes first, as it does at the launcher.
    const named = await launchWith(chosenNone, 'agent.launch', { permissionPreset: 'bypass' })
    assert.deepEqual(resolvePermissionArgs(claudeManifest, named.preset), bypassFlag)
  }

  async function testScheduleToolsPassServiceFailuresThrough(): Promise<void> {
    const { service } = fakeScheduledAgents({
      create: () => ({ ok: false, message: 'Hour 25 doesn’t exist — use 0–23.' }),
      runNow: () => ({ ok: true, run: { at: 0, ok: false, message: 'not a git repository' } }),
    })
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        getScheduledAgents: () => service,
      }),
    )
    const created = await tool(tools, 'schedule.create').handler({
      workspaceId: 'ws-1',
      prompt: 'x',
      cron: '0 25 * * *',
    })
    const createError = (created.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(createError.code, 'scheduled_agent_invalid')
    assert.match(createError.message, /Hour 25/)

    // A run that could not start says why, rather than reporting a chat.
    const ran = await tool(tools, 'schedule.run').handler({ id: 'sa-1' })
    const runError = (ran.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(runError.code, 'scheduled_agent_run_failed')
    assert.match(runError.message, /not a git repository/)

    const unknown = await tool(tools, 'schedule.run').handler({ id: 'nope' })
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_scheduled_agent')
  }

  // `cli` and `cliModel` were blind strings until an agent could
  // enumerate them over MCP alone.
  async function testCliRuntimeListReportsTheRegistry(): Promise<void> {
    const plugin = (id: string, overrides: Partial<LoadedPlugin['manifest']> = {}): LoadedPlugin => ({
      manifest: {
        id,
        displayName: id === 'claude-code' ? 'Claude Code' : id,
        version: 1,
        binary: id === 'claude-code' ? 'claude' : id,
        permissionPresets: { bypass: { label: 'Bypass', args: ['--skip-prompts'] } },
        launch: { args: [] },
        promptInjection: { mode: 'argv' },
        completion: { mode: 'exit' },
        capabilities: { resumeSession: true, sessionIdFromCaller: false, toolUse: true, mcpServers: true },
        ...overrides,
      } as unknown as LoadedPlugin['manifest'],
      source: 'bundled',
      manifestPath: `/plugins/${id}/manifest.json`,
      pluginRoot: `/plugins/${id}`,
    })
    const tools = createAutomationTools({
      ...backendsOf(),
      listPlugins: () => [
        plugin('claude-code', {
          modelSelection: {
            args: ['--model', '{{model}}'],
            options: [{ id: 'claude-opus-5', label: 'Opus 5' }, { id: 'claude-sonnet-5' }],
            allowCustomId: true,
          },
          reasoningSelection: {
            args: ['--effort', '{{reasoning}}'],
            levels: [{ id: 'medium' }, { id: 'high', label: 'High' }],
            default: 'medium',
          },
        } as never),
        // A CLI that declares neither: it must still be listed, with the honest
        // empty answer — "no model may be passed" is not the same as "unlisted".
        // It also names only a manual setting, so it honours that and `none`.
        plugin('plain-cli', { permissionPresets: { manual: { label: 'Manual', args: ['--ask'] } } }),
        // Hooks-only selectability: a spec-less CLI stays LISTED (marked, not
        // omitted, so a remote caller holding a stale id learns why it is
        // refused) but flagged agentSelectable: false.
        plugin('hook-cli', {
          agentStateSpec: {
            registration: { kind: 'settings-json', path: '.claude/settings.local.json' },
            events: [{ event: 'Stop', phase: 'idle', turnEnd: true }],
          },
        } as never),
      ],
    })

    const listed = await tool(tools, 'cli.runtime.list').handler({})
    const clis = (listed.structuredContent as { clis: Array<Record<string, unknown>> }).clis
    assert.deepEqual(
      clis.map((entry) => entry.id),
      ['claude-code', 'plain-cli', 'hook-cli'],
    )
    assert.deepEqual(
      clis.map((entry) => entry.agentSelectable),
      [false, false, true],
      'agentSelectable mirrors agentStateSpec presence — marked, never omitted',
    )
    assert.deepEqual(clis[0].models, [{ id: 'claude-opus-5', label: 'Opus 5' }, { id: 'claude-sonnet-5' }])
    assert.equal(clis[0].allowCustomModelId, true)
    assert.deepEqual(clis[0].reasoningLevels, [{ id: 'medium' }, { id: 'high', label: 'High' }])
    assert.equal(clis[0].defaultReasoningLevel, 'medium')
    assert.deepEqual(clis[0].permissionPresets, ['none', 'bypass'])
    assert.deepEqual(clis[1].permissionPresets, ['manual', 'none'], 'only the presets it names, and none')
    assert.equal(clis[1].supportsModelSelection, false)
    assert.deepEqual(clis[1].models, [])
    assert.equal(clis[1].allowCustomModelId, false)
    assert.equal(clis[1].defaultReasoningLevel, null)

    const one = await tool(tools, 'cli.runtime.list').handler({ cli: 'plain-cli' })
    assert.deepEqual(
      (one.structuredContent as { clis: Array<{ id: string }> }).clis.map((entry) => entry.id),
      ['plain-cli'],
    )

    // An unknown id fails rather than answering an empty list a caller would read
    // as "this CLI exists and declares nothing".
    const unknown = await tool(tools, 'cli.runtime.list').handler({ cli: 'no-such-cli' })
    assert.equal(unknown.isError, true)
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_cli')
  }

  async function testReadToolsPassServiceFailuresThrough(): Promise<void> {
    const tools = createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        readBacklogItem: async () => ({
          ok: false,
          message: 'Backlog item backlog/gone.md does not exist in this workspace.',
        }),
      }),
    )

    const read = await tool(tools, 'backlog.read').handler({ path: 'backlog/gone.md' }, agentContext('ws-1'))
    assert.equal(read.isError, true)
    const readError = (read.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(readError.code, 'backlog_read_failed')
    assert.match(readError.message, /does not exist/)

    // Missing/blank arguments stay explicit invalid_arguments failures.
    const missing = await tool(tools, 'backlog.read').handler({}, agentContext('ws-1'))
    assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  async function testStudioGatewayRejectsDuplicatesAndClassifiesMutations(): Promise<void> {
    const appTool: McpToolRegistration = {
      name: 'workspace.list',
      description: 'list workspaces',
      inputSchema: { type: 'object' },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }
    const tools = createStudioGatewayTools({
      appTools: [appTool],
      resolveModuleTools: () => [],
      isModuleEnabled: () => true,
    })()
    assert.deepEqual(
      tools.map((entry) => entry.name),
      ['workspace.list'],
    )

    assert.throws(
      () =>
        createStudioGatewayTools({
          appTools: [appTool, appTool],
          resolveModuleTools: () => [],
          isModuleEnabled: () => true,
        }),
      /Duplicate SprintEngine Studio MCP tool/,
    )
    assert.equal(isStudioGatewayMutation('backlog.update'), true)
    assert.equal(isStudioGatewayMutation('backlog.repair'), true)
    assert.equal(isStudioGatewayMutation('backlog.list'), false)
    // browser-pane child 6: acting on the page is a mutation, looking at it is not.
    assert.equal(isStudioGatewayMutation('browser.click'), true)
    assert.equal(isStudioGatewayMutation('browser.open'), true)
    assert.equal(isStudioGatewayMutation('browser.snapshot'), false)
    // canvas-pane package F: drawing on a board writes a file in the person's
    // project, so it is audited and needs `operate`; reading the board is not.
    assert.equal(isStudioGatewayMutation('canvas.edit'), true)
    assert.equal(isStudioGatewayMutation('canvas.open'), true)
    assert.equal(isStudioGatewayMutation('canvas.layout'), true)
    assert.equal(isStudioGatewayMutation('canvas.import'), true)
    assert.equal(isStudioGatewayMutation('canvas.describe'), false)
    assert.equal(isStudioGatewayMutation('canvas.find'), false)
    assert.equal(isStudioGatewayMutation('canvas.list'), false)
    assert.equal(isStudioGatewayMutation('canvas.screenshot'), false)

    // A module's tool classifies itself (D11): core has no table it could appear
    // in, so `mutates: true` on the registration is what makes a remote caller
    // need `<family>:operate` and what puts the call in the audit. Read live from
    // the gateway's own resolver, so a module enabled mid-session is honoured.
    const moduleWrites: McpToolRegistration = {
      name: 'widget_write',
      description: 'writes',
      inputSchema: { type: 'object' },
      mutates: true,
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    }
    const moduleReads: McpToolRegistration = {
      name: 'widget_read',
      description: 'reads',
      inputSchema: { type: 'object' },
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    }
    const resolveWidgetTools = createStudioGatewayTools({
      appTools: [],
      resolveModuleTools: () => [
        { moduleId: 'widgets', moduleDisplayName: 'Widgets', registration: moduleWrites },
        { moduleId: 'widgets', moduleDisplayName: 'Widgets', registration: moduleReads },
      ],
      isModuleEnabled: () => true,
    })
    assert.equal(isStudioGatewayMutation('widget_write', resolveWidgetTools), true)
    assert.equal(isStudioGatewayMutation('widget_read', resolveWidgetTools), false)
    assert.equal(
      isStudioGatewayMutation('widget_write'),
      false,
      'without a resolver only the core tables answer — nothing is invented',
    )
    assert.equal(
      requiredScopeForTool('widget_write', isStudioGatewayMutation('widget_write', resolveWidgetTools)),
      'workspace:operate',
      'a declared write needs the operate scope a remote device must be granted',
    )
    assert.equal(
      requiredScopeForTool('widget_read', isStudioGatewayMutation('widget_read', resolveWidgetTools)),
      'workspace:read',
      'and an undeclared one stays on the read scope',
    )
  }

  // Two modules registering the same tool name → the second is rejected
  // as a module load error, the first registration wins, and the gateway keeps
  // serving. Also proves an SDK-shaped third-party module's tool reaches the
  // gateway through loadMainModules (the external-project fixture's shape).
  async function testModuleMcpToolContributionOwnershipAndCollisions(): Promise<void> {
    const registrationOf = (name: string, answer: string): McpToolRegistration => ({
      name,
      description: `test tool ${answer}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: answer }], structuredContent: { answer } }),
    })
    const moduleOf = (id: string, tools: McpToolRegistration[]): CapabilityModule => ({
      manifest: {
        id,
        displayName: id,
        version: 1,
        publisher: 'example-author',
        summary: 'test module',
        defaultEnabled: true,
        source: 'third-party',
        permissions: ['mcp:tools'],
      },
      registerMain: (host) => host.registerMcpTools(tools),
    })
    const { kernel, report } = loadMainModules({
      ipcMain: createFakeIpcMain().ipcMain,
      modules: [
        moduleOf('first-owner', [registrationOf('weather_deck_forecast', 'first')]),
        moduleOf('second-owner', [
          registrationOf('second_owner_extra', 'extra'),
          registrationOf('weather_deck_forecast', 'second'),
        ]),
      ],
    })
    assert.deepEqual(report.loaded, ['first-owner'], 'first registration wins')
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0]?.id, 'second-owner', 'the collision is a module load error')
    assert.match(report.errors[0]?.message ?? '', /already registered by module "first-owner"/)

    const warnings: string[] = []
    const resolveGatewayTools = createStudioGatewayTools({
      appTools: [],
      resolveModuleTools: () => kernel.mcpToolRegistrations(),
      isModuleEnabled: () => true,
      warn: (text) => warnings.push(text),
    })
    const served = resolveGatewayTools()
    const forecast = tool(served, 'weather_deck_forecast')
    const answered = await forecast.handler({})
    assert.deepEqual(answered.structuredContent, { answer: 'first' }, 'the gateway keeps serving the first owner')
    assert.equal(
      served.some((registration) => registration.name === 'second_owner_extra'),
      false,
      'a rejected batch registers nothing, not half',
    )
    assert.deepEqual(warnings, [], 'a kernel-rejected collision never reaches the gateway merge')

    // A module shadowing a CORE tool name is skipped with a warning; core wins,
    // and the warning fires once, not on every per-request resolution.
    const shadowWarnings: string[] = []
    const coreTool = registrationOf('workspace.list', 'core')
    const resolveShadowed = createStudioGatewayTools({
      appTools: [coreTool],
      resolveModuleTools: () => [
        {
          moduleId: 'first-owner',
          moduleDisplayName: 'first-owner',
          registration: registrationOf('workspace.list', 'shadow'),
        },
      ],
      isModuleEnabled: () => true,
      warn: (text) => shadowWarnings.push(text),
    })
    const shadowed = resolveShadowed()
    const coreAnswer = await tool(shadowed, 'workspace.list').handler({})
    assert.deepEqual(coreAnswer.structuredContent, { answer: 'core' })
    resolveShadowed()
    assert.equal(shadowWarnings.length, 1, 'the collision warns once across resolutions')
    assert.match(shadowWarnings[0] ?? '', /collides with a core gateway tool/)
  }

  // Module MCP tools end to end: the plumbing is unit-tested at the
  // kernel and the gateway merge, but nothing proved the last hop — that a real
  // connected MCP session LISTS a module's tool and can CALL it. This drives the
  // whole path a connected agent drives: module kernel → gateway resolver →
  // socket server → JSON-RPC tools/list + tools/call.
  async function testModuleContributedToolIsLiveOnAConnectedSession(): Promise<void> {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'se-module-tool-')), 'automation.sock')
    const forecastTool: McpToolRegistration = {
      name: 'weather_deck_forecast',
      description: 'Forecast from the fixture module.',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      handler: async (args) => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { city: args.city, sky: 'clear' },
      }),
    }
    const fixtureModule: CapabilityModule = {
      manifest: {
        id: 'weather-deck',
        displayName: 'Weather Deck',
        version: 1,
        publisher: 'example-author',
        summary: 'fixture module',
        defaultEnabled: true,
        source: 'third-party',
        permissions: ['mcp:tools'],
      },
      registerMain: (host) => host.registerMcpTools([forecastTool]),
    }
    const { kernel, report } = loadMainModules({ ipcMain: createFakeIpcMain().ipcMain, modules: [fixtureModule] })
    assert.deepEqual(report.loaded, ['weather-deck'])

    let moduleEnabled = true
    const resolveGatewayTools = createStudioGatewayTools({
      appTools: createAutomationTools(backendsOf()),
      resolveModuleTools: () => kernel.mcpToolRegistrations(),
      isModuleEnabled: () => moduleEnabled,
    })
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-automation',
      serverVersion: '0.0.0-test',
      resolveTools: resolveGatewayTools,
    })
    await server.start()
    try {
      const socket = connect(socketPath)
      socket.setEncoding('utf8')
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })
      const responses = new Map<unknown, Record<string, unknown>>()
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            const parsed = JSON.parse(line) as Record<string, unknown>
            responses.set(parsed.id, parsed)
          }
          newline = buffer.indexOf('\n')
        }
      })
      const call = async (
        id: number,
        method: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
        const deadline = Date.now() + 5_000
        while (!responses.has(id)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return responses.get(id) as Record<string, unknown>
      }

      // A Studio-launched agent's bridge announces itself, then lists.
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'sprintengine.studio/connect', params: { agentId: 'agent-a', workspaceId: 'ws-1' } })}\n`,
      )
      const listed = await call(1, 'tools/list')
      const names = (listed.result as { tools: Array<{ name: string; description: string }> }).tools
      const contributed = names.find((entry) => entry.name === 'weather_deck_forecast')
      assert.ok(contributed, 'the module tool is listed to a live session alongside the core tools')
      assert.equal(contributed.description, 'Forecast from the fixture module.')
      assert.ok(
        names.some((entry) => entry.name === 'workspace.list'),
        'core tools are still served',
      )
      // The discovery tool is only useful if a connected agent can actually see
      // it, so prove it on the same live listing rather than in isolation.
      assert.ok(
        names.some((entry) => entry.name === 'cli.runtime.list'),
        'cli.runtime.list reaches the connected session that needs it',
      )

      const answered = await call(2, 'tools/call', { name: 'weather_deck_forecast', arguments: { city: 'Dublin' } })
      assert.deepEqual(
        (answered.result as { structuredContent: Record<string, unknown> }).structuredContent,
        { city: 'Dublin', sky: 'clear' },
        'the module handler runs for the connected session',
      )

      // Disabling the owner mid-session keeps the tool ADVERTISED and answers an
      // actionable error instead of running it, live on the same
      // connection — the enablement gate is resolved per call, not captured.
      moduleEnabled = false
      const relisted = await call(3, 'tools/list')
      assert.ok(
        (relisted.result as { tools: Array<{ name: string }> }).tools.some(
          (entry) => entry.name === 'weather_deck_forecast',
        ),
        'a disabled module keeps advertising its capability',
      )
      const refused = await call(4, 'tools/call', { name: 'weather_deck_forecast', arguments: {} })
      const refusal = refused.result as {
        isError?: boolean
        structuredContent: { error: { code: string; message: string } }
      }
      assert.equal(refusal.isError, true)
      assert.equal(refusal.structuredContent.error.code, 'weather-deck_module_disabled')
      assert.match(refusal.structuredContent.error.message, /Weather Deck module is disabled/)

      socket.destroy()
    } finally {
      await server.stop()
    }
  }

  async function testStudioGatewayAuditIsRedactedAndRotated(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-studio-mcp-audit-'))
    try {
      const store = createGatewayAuditStore({ resolveUserDataDir: () => dir, maxBytes: 1024, backups: 2 })
      for (let index = 0; index < 20; index += 1) {
        store.record({
          connection: {
            kind: 'studio-agent',
            workspaceId: 'ws-1',
            agentId: 'agent-a',
            cliId: 'codex',
          },
          tool: 'backlog.create',
          durationMs: 7,
          args: {
            workspaceId: 'ws-1',
            relativePath: `backlog/item-${index}.md`,
            prompt: 'never-log-this-prompt',
            token: 'never-log-this-token',
            body: { secret: 'never-log-this-body' },
          },
          result: {
            content: [{ type: 'text', text: 'full tool response is not audited' }],
            structuredContent: { ok: true, relativePath: `backlog/item-${index}.md`, title: 'not retained' },
          },
        })
      }
      await store.flush()
      const path = join(dir, STUDIO_GATEWAY_AUDIT_FILENAME)
      assert.equal(existsSync(path), true)
      assert.equal(existsSync(`${path}.1`), true, 'bounded log rotates before unbounded growth')
      const combined = [path, `${path}.1`, `${path}.2`]
        .filter(existsSync)
        .map((candidate) => readFileSync(candidate, 'utf8'))
        .join('')
      assert.doesNotMatch(combined, /never-log-this|full tool response|"title"/)
      assert.match(combined, /"workspaceId":"ws-1"/)
      assert.match(combined, /"tool":"backlog.create"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // --- module.* / marketplace.* --------------------------------------

  function registryEntry(
    manifest: CapabilityManifest,
    overrides: Partial<ModuleRegistryEntry> = {},
  ): ModuleRegistryEntry {
    return {
      id: manifest.id,
      manifest,
      source: manifest.source ?? 'bundled',
      enabled: true,
      absence: null,
      surfaces: { ...EMPTY_MODULE_SURFACES },
      ...overrides,
    }
  }

  function registrySnapshot(
    modules: ModuleRegistryEntry[],
    channel: ModuleRegistrySnapshot['channel'] = 'development',
  ): ModuleRegistrySnapshot {
    return { capturedAt: Date.parse('2026-08-06T10:00:00Z'), channel, modules }
  }

  function installedModuleView(
    id: string,
    trust: ThirdPartyModuleView['trust'],
    launch: Partial<ThirdPartyModuleView['launch']> = {},
  ): ThirdPartyModuleView {
    return {
      manifest: { id, displayName: `Module ${id}`, version: 3, defaultEnabled: true, source: 'third-party' },
      trust,
      launch: { status: 'blocked_unsigned', hasMainEntry: true, expectedToLoad: false, ...launch },
    }
  }

  async function testModuleToolsReportTheRegistryTheUserSees(): Promise<void> {
    const snapshot = registrySnapshot([
      registryEntry(
        {
          id: 'backlog',
          displayName: 'Backlog',
          version: 1,
          category: 'core',
          defaultEnabled: true,
          dependsOn: ['agent-runtime'],
        },
        {
          surfaces: {
            ...EMPTY_MODULE_SURFACES,
            globalSurfaces: ['backlog'],
          },
        },
      ),
      registryEntry(
        { id: 'git', displayName: 'Git panel', version: 1, defaultEnabled: true },
        {
          enabled: false,
          absence: { reason: 'disabled', message: 'Module "git" is not enabled (Settings → Modules).' },
        },
      ),
      registryEntry({
        id: 'weather',
        displayName: 'Weather',
        version: 2,
        defaultEnabled: true,
        source: 'third-party',
        permissions: ['workspace.read'],
      }),
    ])
    const tools = createAutomationTools(
      backendsOf({
        getModuleRegistrySnapshot: () => snapshot,
        // `weather` loaded; `sketchy` is installed on disk but never trusted, so
        // the renderer registry has never heard of it.
        listInstalledThirdPartyModules: async () => ({
          modules: [
            installedModuleView('weather', 'trusted', { status: 'trusted_executable', expectedToLoad: true }),
            installedModuleView('sketchy', 'unsigned'),
          ],
          rejected: [],
        }),
        listModuleContributedTools: () => [{ moduleId: 'weather', toolName: 'weather.forecast' }],
      }),
    )

    const listed = await tool(tools, 'module.list').handler({})
    const modules = (
      listed.structuredContent as {
        modules: Array<{
          id: string
          source: string
          enabled: boolean
          installed: boolean
          absence: { reason: string } | null
          trust?: string
        }>
      }
    ).modules
    assert.deepEqual(
      modules.map((module) => module.id).sort(),
      ['backlog', 'git', 'sketchy', 'weather'],
      'every module the user could see is listed, including an installed-but-untrusted one',
    )
    const git = modules.find((module) => module.id === 'git')
    assert.equal(git?.enabled, false)
    assert.equal(git?.absence?.reason, 'disabled', 'a switched-off module says so instead of vanishing')
    const sketchy = modules.find((module) => module.id === 'sketchy')
    assert.equal(sketchy?.installed, true, 'an untrusted module is still installed')
    assert.equal(sketchy?.enabled, false)
    assert.equal(sketchy?.absence?.reason, 'untrusted')
    assert.equal(sketchy?.trust, 'unsigned')
    assert.equal(
      modules.find((module) => module.id === 'weather')?.trust,
      'trusted',
      'main-owned trust rides along for a loaded third-party module',
    )

    const thirdParty = await tool(tools, 'module.list').handler({ source: 'third-party' })
    assert.deepEqual(
      (thirdParty.structuredContent as { modules: Array<{ id: string }> }).modules.map((module) => module.id).sort(),
      ['sketchy', 'weather'],
    )
    const enabledOnly = await tool(tools, 'module.list').handler({ enabled: true })
    assert.deepEqual(
      (enabledOnly.structuredContent as { modules: Array<{ id: string }> }).modules.map((module) => module.id),
      ['backlog', 'weather'],
    )
    assert.equal(
      (await tool(tools, 'module.list').handler({ source: 'nope' })).isError,
      true,
      'an unknown source is rejected rather than filtered to nothing',
    )

    const status = await tool(tools, 'module.status').handler({ id: 'backlog' })
    const detail = (
      status.structuredContent as {
        module: {
          manifest: { id: string }
          dependsOn: string[]
          surfaces: { globalSurfaces: string[] }
          contributedTools: string[]
        }
      }
    ).module
    assert.equal(detail.manifest.id, 'backlog')
    assert.deepEqual(detail.dependsOn, ['agent-runtime'])
    assert.deepEqual(detail.surfaces.globalSurfaces, ['backlog'], 'contributed surfaces are reported, not guessed')
    assert.deepEqual(detail.contributedTools, [], 'backlog contributes no gateway tool in this fixture')
    const weatherStatus = await tool(tools, 'module.status').handler({ id: 'weather' })
    assert.deepEqual(
      (weatherStatus.structuredContent as { module: { contributedTools: string[]; permissions: string[] } }).module,
      {
        ...(weatherStatus.structuredContent as { module: Record<string, unknown> }).module,
        contributedTools: ['weather.forecast'],
        permissions: ['workspace.read'],
      },
    )

    // An installed-but-untrusted module still reports its own manifest — the
    // declared permissions are what a caller reads BEFORE deciding to trust it —
    // and null surfaces, because it registered nothing.
    const untrusted = await tool(tools, 'module.status').handler({ id: 'sketchy' })
    const untrustedDetail = (
      untrusted.structuredContent as {
        module: { manifest: { id: string } | null; surfaces: unknown; absence: { reason: string }; trust: string }
      }
    ).module
    assert.equal(untrustedDetail.manifest?.id, 'sketchy')
    assert.equal(untrustedDetail.surfaces, null, 'a module that never loaded contributes nothing')
    assert.equal(untrustedDetail.absence.reason, 'untrusted')
    assert.equal(untrustedDetail.trust, 'unsigned')

    const unknown = await tool(tools, 'module.status').handler({ id: 'nothing-like-this' })
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_module')
  }

  // Module lifecycle x module MCP tools, the seam neither owns: the gateway serves a module's
  // tools and `module.*` DESCRIBES that same module, from what should be one
  // source of truth (`app-services.ts` hands the same `resolveModuleMcpTools()` to
  // both). `testModuleContributedToolIsLiveOnAConnectedSession` above proves the
  // tool is listed, callable and enablement-gated; this proves the description
  // agrees with it — over one live session, cross-checked against the wire rather
  // than against a literal, so a `module.status` reading some other registry fails
  // here instead of misreporting the app to an agent.
  async function testModuleStatusAgreesWithTheToolsTheGatewayServes(): Promise<void> {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'se-module-agree-')), 'automation.sock')
    const forecastTool: McpToolRegistration = {
      name: 'weather_deck_forecast',
      description: 'Forecast from the fixture module.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { sky: 'clear' } }),
    }
    const manifest = {
      id: 'weather-deck',
      displayName: 'Weather Deck',
      version: 1,
      publisher: 'example-author',
      summary: 'fixture module',
      defaultEnabled: true,
      source: 'third-party' as const,
      permissions: ['mcp:tools' as const],
    }
    const fixtureModule: CapabilityModule = { manifest, registerMain: (host) => host.registerMcpTools([forecastTool]) }
    const { kernel } = loadMainModules({ ipcMain: createFakeIpcMain().ipcMain, modules: [fixtureModule] })

    // The one resolver, behind both surfaces — the production wiring. Feeding the
    // gateway and `module.status` separate literals would agree by construction.
    let moduleEnabled = true
    const appTools = createAutomationTools(
      backendsOf({
        getModuleRegistrySnapshot: () =>
          registrySnapshot([
            registryEntry(
              manifest,
              moduleEnabled
                ? {}
                : {
                    enabled: false,
                    absence: {
                      reason: 'disabled',
                      message: 'Module "weather-deck" is not enabled (Settings -> Modules).',
                    },
                  },
            ),
          ]),
        listModuleContributedTools: () =>
          kernel
            .mcpToolRegistrations()
            .map((entry) => ({ moduleId: entry.moduleId, toolName: entry.registration.name })),
      }),
    )
    const server = createMcpSocketServer({
      socketPath,
      serverName: 'sprintengine-studio',
      serverVersion: '0.0.0-test',
      resolveTools: createStudioGatewayTools({
        appTools,
        resolveModuleTools: () => kernel.mcpToolRegistrations(),
        isModuleEnabled: () => moduleEnabled,
      }),
    })
    await server.start()
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })
      const responses = new Map<number, Record<string, unknown>>()
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            const message = JSON.parse(line) as { id?: number }
            if (typeof message.id === 'number') responses.set(message.id, message)
          }
          newline = buffer.indexOf('\n')
        }
      })
      let nextId = 0
      const rpc = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        nextId += 1
        const id = nextId
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
        const deadline = Date.now() + 5_000
        while (!responses.has(id)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return responses.get(id) as Record<string, unknown>
      }
      const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        const response = await rpc('tools/call', { name, arguments: args })
        const result = (response as { result?: { structuredContent?: Record<string, unknown> } }).result
        assert.ok(result, `tools/call ${name} errored: ${JSON.stringify(response)}`)
        return result.structuredContent ?? {}
      }

      await rpc('initialize', { protocolVersion: '2025-03-26' })
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

      // What the session is actually served, minus everything core owns: whatever
      // is left is this module's, and is what module.status must name.
      const coreNames = new Set(createAutomationTools(backendsOf()).map((entry) => entry.name))
      const servedByModule = ((await rpc('tools/list')) as { result: { tools: Array<{ name: string }> } }).result.tools
        .map((entry) => entry.name)
        .filter((name) => !coreNames.has(name))
      assert.deepEqual(servedByModule, ['weather_deck_forecast'], 'the session is served exactly one module tool')

      const status = (await callTool('module.status', { id: 'weather-deck' })) as {
        module: { contributedTools: string[]; absence: { reason: string } | null }
      }
      assert.deepEqual(
        status.module.contributedTools,
        servedByModule,
        'module.status names the tools the gateway is really serving, read off this session',
      )
      assert.equal(status.module.absence, null, 'and reports the module as present while it is serving them')

      // Switching it off in Settings is ONE change with one meaning. The gateway
      // keeps advertising the tool (a caller learns why), and the description
      // surface must flip with it — the failure this guards is module.status
      // reporting an enabled module whose tools every call refuses.
      moduleEnabled = false
      const refused = (await callTool('weather_deck_forecast')) as { error?: { code: string } }
      assert.equal(refused.error?.code, 'weather-deck_module_disabled')
      const disabled = (await callTool('module.status', { id: 'weather-deck' })) as {
        module: { absence: { reason: string } | null }
      }
      assert.equal(
        disabled.module.absence?.reason,
        'disabled',
        'module.status and the gateway agree about enablement at the same instant',
      )
      const listedRow = (
        (await callTool('module.list')) as { modules: Array<{ id: string; enabled: boolean }> }
      ).modules.find((entry) => entry.id === 'weather-deck')
      assert.equal(listedRow?.enabled, false, 'module.list shows the same switched-off module Settings does')
    } finally {
      socket.destroy()
      await server.stop()
    }
  }

  async function testDevOnlyModulesAreAbsentFromAPackagedBuild(): Promise<void> {
    // A packaged build's renderer registry never carries the dev-only modules —
    // `activeForChannel` drops them — so the tools must report absence, never a
    // present-but-disabled row.
    const tools = createAutomationTools(
      backendsOf({
        getModuleRegistrySnapshot: () =>
          registrySnapshot(
            [registryEntry({ id: 'backlog', displayName: 'Backlog', version: 1, defaultEnabled: true })],
            'production',
          ),
      }),
    )
    const listed = await tool(tools, 'module.list').handler({})
    const listedIds = (listed.structuredContent as { modules: Array<{ id: string }> }).modules.map((m) => m.id)
    assert.deepEqual(listedIds, ['backlog'], 'no dev-only module appears in a packaged build')
    assert.equal((listed.structuredContent as { channel: string }).channel, 'production')

    // No module is dev-only today, so this asks after a retired id instead: it
    // is reserved, so it reads as known-but-absent rather than unknown.
    const retired = await tool(tools, 'module.status').handler({ id: 'voice-dictation' })
    const error = (retired.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(error.code, 'module_not_in_build', 'a reserved id is absent, not disabled')
    assert.match(error.message, /not part of this production build/)
  }

  async function testModuleToolsRefuseBeforeTheRegistryArrives(): Promise<void> {
    const tools = createAutomationTools(backendsOf())
    for (const [name, args] of [
      ['module.list', {}],
      ['module.status', { id: 'git' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const answered = await tool(tools, name).handler(args)
      assert.equal(answered.isError, true, `${name} fails explicitly`)
      assert.equal(
        (answered.structuredContent as { error: { code: string } }).error.code,
        'module_registry_unavailable',
        `${name} never reports an empty registry as fact`,
      )
    }
  }

  async function testMarketplaceListReadsTheSameIndexTheDoorReads(): Promise<void> {
    const marketplace = {
      schemaVersion: 1 as const,
      plugins: [
        {
          id: 'weather-module',
          name: 'Weather',
          publisher: { name: 'Acme', verified: true },
          summary: 'Local forecasts in a panel.',
          category: 'Insight',
          icon: 'cloud',
          latest: 3,
          provides: ['module'] as MarketplaceComponentKind[],
          source: 'https://example.test/weather.zip',
          tags: ['forecast'],
        },
        {
          id: 'railway-mcp',
          name: 'Railway',
          publisher: { name: 'Railway', verified: false },
          summary: 'Deploy from an agent.',
          category: 'Connectivity',
          icon: 'train',
          latest: 1,
          provides: ['mcp'] as MarketplaceComponentKind[],
        },
      ],
    }
    const reads: Array<MarketplaceRegistryReadInput | undefined> = []
    const tools = createAutomationTools(
      backendsOf({
        readMarketplaceRegistry: async (input) => {
          reads.push(input)
          return {
            ok: true,
            state: 'ok',
            registryUrl: 'https://example.test/marketplace.json',
            source: 'bundled',
            stale: false,
            fetchedAt: '2026-08-06T09:00:00.000Z',
            marketplace,
          }
        },
      }),
    )

    const all = await tool(tools, 'marketplace.list').handler({})
    const listed = all.structuredContent as {
      total: number
      matched: number
      plugins: Array<{ id: string; signed: boolean; bundleSource?: string }>
      source: string
    }
    assert.equal(listed.total, 2)
    assert.equal(listed.source, 'bundled', 'the read discloses where the index came from')
    assert.equal(listed.plugins.find((plugin) => plugin.id === 'weather-module')?.signed, false)

    const modulesOnly = await tool(tools, 'marketplace.list').handler({ provides: 'module' })
    assert.deepEqual(
      (modulesOnly.structuredContent as { plugins: Array<{ id: string }> }).plugins.map((plugin) => plugin.id),
      ['weather-module'],
      'the module-first facet is a provides filter over the same index',
    )
    const searched = await tool(tools, 'marketplace.list').handler({ query: 'RAILWAY' })
    assert.deepEqual(
      (searched.structuredContent as { plugins: Array<{ id: string }> }).plugins.map((plugin) => plugin.id),
      ['railway-mcp'],
    )
    await tool(tools, 'marketplace.list').handler({ forceRefresh: true })
    assert.deepEqual(reads, [undefined, undefined, undefined, { forceRefresh: true }])
    assert.equal(
      (await tool(tools, 'marketplace.list').handler({ provides: 'widgets' })).isError,
      true,
      'an unknown component kind is rejected',
    )

    const offline = createAutomationTools(
      backendsOf({
        readMarketplaceRegistry: async () => ({
          ok: false,
          state: 'fetch-error',
          registryUrl: 'https://example.test/marketplace.json',
          stale: false,
          message: 'network unreachable',
        }),
      }),
    )
    const failed = await tool(offline, 'marketplace.list').handler({})
    assert.equal(failed.isError, true)
    const failure = (failed.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(failure.code, 'marketplace_unavailable', 'a failed registry read never renders as an empty catalogue')
    assert.match(failure.message, /network unreachable/)
  }

  async function testModuleAndMarketplaceToolsAreReadOnly(): Promise<void> {
    // The lifecycle work defers install/uninstall/enable to the trust model, and the
    // gateway's mutation classifier must agree: none of these tools may be
    // audited or gated as a mutation.
    for (const name of ['module.list', 'module.status', 'marketplace.list']) {
      assert.equal(isStudioGatewayMutation(name), false, `${name} is a read`)
    }
    const tools = createAutomationTools(backendsOf())
    for (const name of ['module.list', 'module.status', 'marketplace.list']) {
      const schema = tool(tools, name).inputSchema as { additionalProperties?: boolean }
      assert.equal(schema.additionalProperties, false, `${name} refuses unknown arguments`)
    }
    assert.equal(
      tools.some((registration) => /^module\.(install|uninstall|enable|disable)$/.test(registration.name)),
      false,
      'no module mutation reached this surface',
    )
  }

  // ── Mobile companion over the gateway ──────────────────────────────────────

  async function testMobileSnapshotToolServesTheCompanionReadModel(): Promise<void> {
    const reads: Array<{ include?: string[]; knownSnapshotVersion?: string }> = []
    const tools = createAutomationTools(
      backendsOf({
        mobileControl: {
          readSnapshot: async (input) => {
            reads.push(input)
            if (input.knownSnapshotVersion === 'snap_current') {
              return { unchanged: true as const, snapshotVersion: 'snap_current' }
            }
            return {
              unchanged: false as const,
              snapshot: { protocolVersion: 4, snapshotVersion: 'snap_current', backlog: [] },
            }
          },
          dispatchCommand: async () => {
            throw new Error('not under test')
          },
        },
      }),
    )

    // Phones built before automations left the wire ask for them on every read.
    // The retired name is accepted and forwarded, and the bridge serves nothing
    // for it, rather than failing every read those phones make.
    const full = await tool(tools, 'workspace.snapshot').handler({ include: ['automations', 'backlog'] })
    assert.equal(full.isError, undefined)
    const fullBody = full.structuredContent as { unchanged: boolean; snapshot: { snapshotVersion: string } }
    assert.equal(fullBody.unchanged, false)
    assert.equal(fullBody.snapshot.snapshotVersion, 'snap_current')
    assert.deepEqual(reads[0]?.include, ['automations', 'backlog'])

    const short = await tool(tools, 'workspace.snapshot').handler({ knownSnapshotVersion: 'snap_current' })
    assert.deepEqual(short.structuredContent, { unchanged: true, snapshotVersion: 'snap_current' })

    const badInclude = await tool(tools, 'workspace.snapshot').handler({ include: [''] })
    assert.equal(badInclude.isError, true)

    // A name the wire does not declare is refused rather than forwarded: the bridge
    // would drop it and serve the default set, hiding the caller's mistake. Both
    // retired names are pinned — `sprintEngines` (v3) and `desktopWorkspaces` (v4).
    for (const retired of ['sprintEngines', 'desktopWorkspaces']) {
      const refused = await tool(tools, 'workspace.snapshot').handler({ include: ['backlog', retired] })
      assert.equal(refused.isError, true, `${retired} is not a snapshot collection`)
      assert.match(JSON.stringify(refused.content), new RegExp(retired))
    }
    assert.equal(reads.length, 2, 'a refused include never reaches the snapshot backend')
  }

  async function testMobileCommandToolDispatchesOnlyTheServedEnvelopes(): Promise<void> {
    const dispatched: Array<{ type: string; deviceId: string; idempotencyKey: string }> = []
    const tools = createAutomationTools(
      backendsOf({
        mobileControl: {
          readSnapshot: async () => {
            throw new Error('not under test')
          },
          dispatchCommand: async (input) => {
            dispatched.push({ type: input.type, deviceId: input.deviceId, idempotencyKey: input.idempotencyKey })
            if ((input.payload as { workspacePath?: string }).workspacePath === 'ws_zzz') {
              return { ok: false as const, code: 'path_not_allowed', message: 'workspace token matched no root' }
            }
            return {
              ok: true as const,
              commandId: 'tnc_1',
              commandType: input.type,
              executedAt: '2026-08-31T00:00:00.000Z',
              data: { relativePath: 'backlog/x.md' },
            }
          },
        },
      }),
    )
    const reg = tool(tools, 'workspace.mobile_command')

    // The device identity comes from the transport metadata, never the args.
    const ok = await reg.handler(
      {
        type: 'backlog.update',
        payload: { workspacePath: 'ws_abc123', relativePath: 'backlog/x.md', status: 'ready' },
        idempotencyKey: 'idem-1',
      },
      { metadata: { kind: 'remote-tailnet', deviceId: 'tnd_phone' } },
    )
    assert.equal(ok.isError, undefined)
    assert.equal((ok.structuredContent as { ok: boolean }).ok, true)
    assert.deepEqual(dispatched[0], { type: 'backlog.update', deviceId: 'tnd_phone', idempotencyKey: 'idem-1' })

    // Backend refusals surface as tool errors with the backend's own code.
    const refusedByBackend = await reg.handler(
      {
        type: 'backlog.update',
        payload: { workspacePath: 'ws_zzz', relativePath: 'backlog/x.md', status: 'ready' },
        idempotencyKey: 'idem-2',
      },
      { metadata: { kind: 'remote-tailnet', deviceId: 'tnd_phone' } },
    )
    assert.equal(refusedByBackend.isError, true)
    assert.match(JSON.stringify(refusedByBackend.structuredContent), /path_not_allowed/u)

    // A command type outside the served set never reaches the backend — including
    // `sprintengine.create`, which this transport served until the Sprint Engine
    // left the app.
    for (const [index, type] of ['device.revoke', 'sprintengine.create'].entries()) {
      const refusedByTool = await reg.handler({ type, payload: {}, idempotencyKey: `idem-${index + 3}` })
      assert.equal(refusedByTool.isError, true)
      assert.match(JSON.stringify(refusedByTool.structuredContent), /command_not_supported/u)
    }
    assert.equal(dispatched.length, 2)
  }

  const tests = [
    testSettingsDefaultOnAndRoundTrip,
    testStudioGatewayStartsDespiteLegacyDisabledSetting,
    testStudioGatewayEndpointContractAcrossPlatforms,
    testToolListNamesTheToolSurface,
    testTerminalListReportsAttachableSessions,
    testTerminalListCarriesTheRowsProjectAndConversationFacts,
    testReadToolsAnswerFromSnapshot,
    testReadToolsResolveWorkspaceRootThroughSnapshot,
    testReadToolsPassServiceFailuresThrough,
    testMobileSnapshotToolServesTheCompanionReadModel,
    testMobileCommandToolDispatchesOnlyTheServedEnvelopes,
    testBacklogRepairRoutesOnlyValidatedIntegrityOperations,
    testBacklogUpdateAppliesInOrderAndStopsOnFailure,
    testBacklogUpdateCarriesTheEpicOrderingMark,
    testBacklogAssignBuildsTheCanonicalLink,
    testBacklogWorkHandsItemToAgent,
    testBacklogWorkFallsBackAndRefusesFinishedItems,
    testBacklogWorkPresetsAndPostLaunchLinkFailure,
    testScheduleToolsDriveTheScheduledAgentsService,
    testAScheduledRunsChatMayNotChangeSchedules,
    testBothPresetsAreOpenAtTheExternalToolBoundary,
    testAnOmittedPresetResolvesLikeTheDesktopLauncher,
    testScheduleToolsPassServiceFailuresThrough,
    testAgentLaunchWidensConfigAndIsolation,
    testAgentLaunchLinksItsCallerForNotices,
    testAgentLaunchAnswersWhileItsWorktreeInstalls,
    testTerminalCreateSpawnsAndReturnsTheAttachableSession,
    testTerminalCreateTakesThisMachinesLaunchDefaults,
    testWorkspaceCheckoutReportsTheBackendsFacts,
    testInvalidRequestsReturnExplicitErrors,
    testCreateMintsInMainWithNoWindow,
    testCreateSurfacesARegistryRefusal,
    testSocketServerSpeaksMcpAndOnlyWhenStarted,
    testInitializeNegotiatesTheProtocolVersionInsteadOfEchoingIt,
    testToolsAnswerAConnectionThatNeverInitialized,
    testPerRequestProtocolVersionDeclarationIsValidated,
    testStaleSocketFileIsReplacedOnStart,
    testBridgePipesStdioToSocketAndOutlivesServerStop,
    testConcurrentBridgesKeepResponsesAndAttributionIsolated,
    testBridgeFailsClearlyWithoutDiscoveryFile,
    testBridgeReportsStaleDiscoveryFile,
    testStudioGatewayRejectsDuplicatesAndClassifiesMutations,
    testModuleMcpToolContributionOwnershipAndCollisions,
    testModuleContributedToolIsLiveOnAConnectedSession,
    testCliRuntimeListReportsTheRegistry,
    testStudioGatewayAuditIsRedactedAndRotated,
    testModuleToolsReportTheRegistryTheUserSees,
    testModuleStatusAgreesWithTheToolsTheGatewayServes,
    testDevOnlyModulesAreAbsentFromAPackagedBuild,
    testModuleToolsRefuseBeforeTheRegistryArrives,
    testMarketplaceListReadsTheSameIndexTheDoorReads,
    testModuleAndMarketplaceToolsAreReadOnly,
  ]

  async function main(): Promise<void> {
    let failures = 0
    for (const test of tests) {
      try {
        await test()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${test.name}`)
        console.error(error)
      }
    }
    if (failures > 0) {
      console.error(`\n${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('automation.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
