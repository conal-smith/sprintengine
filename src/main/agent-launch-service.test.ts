import assert from 'node:assert/strict'

import type { McpServerConfig, TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api'
import type { AgentLaunchSettings } from '../shared/launch-settings'
import {
  DEFAULT_AGENT_LAUNCH_CLI,
  DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  emptyAgentLaunchSettings,
} from '../shared/launch-settings'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import {
  createAgentLaunchService,
  type AgentLaunchServiceDeps,
  type AgentLaunchWorkspace,
} from './agent-launch-service'
import { test } from 'vitest'

test('agent-launch-service', async () => {
  const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
  function run(name: string, body: () => Promise<void> | void): void {
    tests.push({ name, body })
  }

  function workspace(overrides: Partial<AgentLaunchWorkspace> = {}): AgentLaunchWorkspace {
    return { id: 'ws-1', mode: 'standard', folderPath: '/repo/a', agents: {}, ...overrides }
  }

  function settings(overrides: Partial<AgentLaunchSettings> = {}): AgentLaunchSettings {
    return { ...emptyAgentLaunchSettings(), ...overrides }
  }

  function liveSession(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
    return {
      sessionId: 'session-live',
      processAlive: true,
      kind: 'agent',
      visible: false,
      suspended: false,
      reapExempt: false,
      startedAt: 0,
      lastOutputAt: null,
      lastInputAt: null,
      lastVisibleAt: null,
      activity: { kind: 'idle', since: 0 },
      exitedAt: null,
      outputBufferLength: 0,
      fileChanges: [],
      activeSubagents: 0,
      contextUsage: null,
      retainedOutputBytes: 0,
      ...overrides,
    }
  }

  /**
   * A launch service over fakes. There is no window, no Electron, and no pty
   * anywhere in this harness — which is the whole point of the item: composing a
   * launch must not need any of them.
   */
  function harness(
    options: {
      workspaces?: AgentLaunchWorkspace[]
      settings?: AgentLaunchSettings
      sessions?: TerminalSessionSnapshot[]
      spawnResult?: TerminalSpawnResult
      resolveKnowledgeRoot?: AgentLaunchServiceDeps['resolveKnowledgeRoot']
      isAgentSelectableCli?: AgentLaunchServiceDeps['isAgentSelectableCli']
      permissionPresetsForCli?: AgentLaunchServiceDeps['permissionPresetsForCli']
      permissionModeLevelForCli?: AgentLaunchServiceDeps['permissionModeLevelForCli']
      cliResumesSessions?: AgentLaunchServiceDeps['cliResumesSessions']
    } = {},
  ) {
    const spawns: TerminalSpawnPayload[] = []
    const kills: string[] = []
    const sessions = options.sessions ?? []
    const service = createAgentLaunchService({
      listWorkspaces: () => options.workspaces ?? [workspace()],
      getLaunchSettings: () => options.settings ?? settings(),
      ...(options.isAgentSelectableCli ? { isAgentSelectableCli: options.isAgentSelectableCli } : {}),
      ...(options.permissionPresetsForCli ? { permissionPresetsForCli: options.permissionPresetsForCli } : {}),
      ...(options.permissionModeLevelForCli ? { permissionModeLevelForCli: options.permissionModeLevelForCli } : {}),
      ...(options.cliResumesSessions ? { cliResumesSessions: options.cliResumesSessions } : {}),
      ...(options.resolveKnowledgeRoot ? { resolveKnowledgeRoot: options.resolveKnowledgeRoot } : {}),
      terminal: {
        list: () => sessions,
        spawn: async (payload) => {
          spawns.push(payload)
          return options.spawnResult ?? { ok: true, sessionId: payload.sessionId }
        },
        kill: (sessionId) => kills.push(sessionId),
      },
      newSessionId: () => 'session-minted',
      newAgentSuffix: () => 'abc123',
    })
    return { service, spawns, kills, sessions }
  }

  run('a resume launch runs the CLI resume on the session it names, with no startup prompt', async () => {
    const app = harness({ cliResumesSessions: (cli) => cli === 'claude-code' })

    const launched = await app.service.launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'ignored',
      resumeCliSessionId: ' 5d1c2a3e-chat-session ',
    })

    assert.equal(launched.ok, true, JSON.stringify(launched))
    const spawn = app.spawns[0]!
    assert.equal(spawn.resume, true)
    assert.equal(spawn.cliSessionId, '5d1c2a3e-chat-session', 'the spawn resumes the named session')
    assert.equal(spawn.initialPrompt, undefined, 'a resumed conversation is not sent a message nobody typed')
  })

  run('a resume is refused on a CLI that cannot resume, rather than started fresh', async () => {
    const app = harness({ cliResumesSessions: () => false })

    const launched = await app.service.launch({ workspaceId: 'ws-1', cli: 'cursor', resumeCliSessionId: 'id' })

    assert.equal(launched.ok, false)
    assert.equal(!launched.ok && launched.code, 'cli_resume_unsupported')
    assert.equal(app.spawns.length, 0)
  })

  run('composes a launch with no window: settings defaults reach the spawn', async () => {
    const app = harness({
      settings: settings({
        lastSelectedCli: 'claude-code',
        lastAgentSpawnPermissionPreset: 'none',
        cliRuntimes: { 'claude-code': { command: '/usr/local/bin/claude' } },
        mcp: { syncEnabled: true, servers: {} },
      }),
    })

    const launched = await app.service.launch({ workspaceId: 'ws-1', prompt: 'go' })

    assert.equal(launched.ok, true, JSON.stringify(launched))
    assert.equal(launched.ok && launched.sessionId, 'session-minted')
    assert.equal(launched.ok && launched.agentId, 'agent-claude-code-abc123')
    assert.equal(app.spawns.length, 1)
    const spawn = app.spawns[0]!
    assert.equal(spawn.cli, 'claude-code', 'the last-selected CLI is the default')
    assert.equal(spawn.cliPermissionPreset, 'none', 'the app-level spawn preset is the default')
    assert.equal(spawn.cwd, '/repo/a')
    assert.equal(spawn.initialPrompt, 'go')
    assert.equal(spawn.kind, 'agent')
    assert.equal(spawn.visible, false, 'nothing is bound to the session yet')
    assert.deepEqual(spawn.cliRuntimes, { 'claude-code': { command: '/usr/local/bin/claude' } })
    assert.deepEqual(spawn.mcpSettings, { syncEnabled: true, servers: {} })
    assert.equal(spawn.connectorLaunch, undefined, 'an ordinary launch never prunes the worktree MCP config')
  })

  run('an explicit request beats the stored defaults', async () => {
    const app = harness({
      settings: settings({ lastSelectedCli: 'claude-code', lastAgentSpawnPermissionPreset: 'bypass' }),
    })

    const launched = await app.service.launch({
      workspaceId: 'ws-1',
      cli: 'codex',
      name: 'Scout',
      cliModel: 'opus',
      permissionPreset: 'none',
      worktreePath: '/repo/a/.worktrees/run-1',
      spawnSkillId: 'backlog',
    })

    assert.equal(launched.ok, true, JSON.stringify(launched))
    const spawn = app.spawns[0]!
    assert.equal(spawn.cli, 'codex')
    assert.equal(spawn.agentName, 'Scout')
    assert.equal(spawn.cliModel, 'opus')
    assert.equal(spawn.cliPermissionPreset, 'none')
    assert.equal(spawn.spawnSkillId, 'backlog')
    assert.equal(spawn.cwd, '/repo/a/.worktrees/run-1', 'a worktree launch runs in the worktree, not the checkout')
    assert.equal(spawn.executionMode, 'worktree')
    assert.equal(spawn.worktreePath, '/repo/a/.worktrees/run-1')
  })

  run('a CLI and preset the person never chose launch on the defaults the window shows', async () => {
    const app = harness({ settings: settings({ lastSelectedCli: null, lastAgentSpawnPermissionPreset: null }) })
    const launched = await app.service.launch({ workspaceId: 'ws-1' })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    const spawn = app.spawns[0]!
    assert.equal(spawn.cli, DEFAULT_AGENT_LAUNCH_CLI, 'the app default CLI, as the pickers show it')
    assert.equal(spawn.cliPermissionPreset, DEFAULT_AGENT_SPAWN_PERMISSION_PRESET, 'the app default spawn preset')
  })

  run('a launch with no preset named takes the one chosen for its CLI, then the app-wide one', async () => {
    const app = harness({
      settings: settings({
        lastSelectedCli: 'claude-code',
        lastAgentSpawnPermissionPreset: 'none',
        cliPermissionPresets: { codex: 'bypass' },
      }),
    })
    await app.service.launch({ workspaceId: 'ws-1', cli: 'codex' })
    await app.service.launch({ workspaceId: 'ws-1', cli: 'claude-code' })
    await app.service.launch({ workspaceId: 'ws-1', cli: 'codex', permissionPreset: 'none' })
    assert.deepEqual(
      app.spawns.map((spawn) => [spawn.cli, spawn.cliPermissionPreset]),
      [
        ['codex', 'bypass'],
        ['claude-code', 'none'],
        ['codex', 'none'],
      ],
      'Codex keeps its own choice, Claude Code reads the app-wide default, and a named preset wins',
    )
  })

  run('a CLI that cannot report agent state is refused, never substituted', async () => {
    // Hooks-only selectability: the predicate is manifest-derived in prod
    // (agentStateSpec presence); here it bans 'muse'. The refusal must cover a
    // stale persisted lastSelectedCli too — the caller typed nothing.
    const banned = harness({
      settings: settings({ lastSelectedCli: 'muse' }),
      isAgentSelectableCli: (cli) => cli !== 'muse',
    })
    const refused = await banned.service.launch({ workspaceId: 'ws-1' })
    assert.equal(!refused.ok && refused.code, 'cli_not_agent_selectable')
    assert.match(!refused.ok ? refused.message : '', /"muse"/)
    assert.equal(banned.spawns.length, 0, 'nothing may spawn on a refused CLI')

    // An eligible CLI passes the same gate untouched.
    const allowed = harness({
      settings: settings({ lastSelectedCli: 'claude-code' }),
      isAgentSelectableCli: (cli) => cli !== 'muse',
    })
    const launchedOk = await allowed.service.launch({ workspaceId: 'ws-1' })
    assert.equal(launchedOk.ok, true, !launchedOk.ok ? launchedOk.message : '')
  })

  run('a preset the CLI has no setting for in a terminal is refused, never launched with no flag', async () => {
    const presets = (cli: string) => (cli === 'kimi-code' ? (['none', 'bypass'] as const) : null)
    const refusing = harness({ permissionPresetsForCli: presets })
    const refused = await refusing.service.launch({ workspaceId: 'ws-1', cli: 'kimi-code', permissionPreset: 'manual' })
    assert.equal(!refused.ok && refused.code, 'unsupported_permission_preset')
    assert.match(!refused.ok ? refused.message : '', /Pass one of: none, bypass/)
    assert.equal(refusing.spawns.length, 0)

    // A mode of the CLI's own at a level it has no preset for is told in its
    // own flag, so it launches; the level alone, or a mode at another level,
    // is still refused.
    const modes = harness({
      permissionPresetsForCli: () => ['none', 'auto', 'bypass'],
      permissionModeLevelForCli: (_cli, mode) => (mode === 'ask' ? 'manual' : null),
    })
    const ask = await modes.service.launch({
      workspaceId: 'ws-1',
      cli: 'cursor',
      permissionPreset: 'manual',
      permissionMode: 'ask',
    })
    assert.equal(ask.ok, true, !ask.ok ? ask.message : '')
    const unheld = await modes.service.launch({
      workspaceId: 'ws-1',
      cli: 'cursor',
      permissionPreset: 'manual',
      permissionMode: 'edit',
    })
    assert.equal(!unheld.ok && unheld.code, 'unsupported_permission_preset')

    // A preset it names, and a CLI the registry does not hold, launch as asked.
    const ok = await refusing.service.launch({ workspaceId: 'ws-1', cli: 'kimi-code', permissionPreset: 'bypass' })
    assert.equal(ok.ok, true, !ok.ok ? ok.message : '')
    const unknown = await refusing.service.launch({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'auto' })
    assert.equal(unknown.ok, true, !unknown.ok ? unknown.message : '')
    assert.equal(refusing.spawns.at(-1)?.cliPermissionPreset, 'auto')
  })

  run('an unknown or unsupported workspace refuses before spawning', async () => {
    const missing = harness()
    const unknown = await missing.service.launch({ workspaceId: 'nope' })
    assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')

    const moduleHost = harness({
      workspaces: [workspace({ mode: 'weather-deck' })],
      settings: settings({ lastSelectedCli: 'codex' }),
    })
    const refused = await moduleHost.service.launch({ workspaceId: 'ws-1' })
    assert.equal(!refused.ok && refused.code, 'unsupported_workspace_mode')
    assert.equal(moduleHost.spawns.length, 0)

    // A caller that owns its own residency may name any mode.
    const allowed = await moduleHost.service.launch({ workspaceId: 'ws-1', anyWorkspaceMode: true })
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
  })

  run('a folderless workspace refuses rather than spawning into the app directory', async () => {
    const app = harness({
      workspaces: [workspace({ folderPath: null })],
      settings: settings({ lastSelectedCli: 'codex' }),
    })
    const launched = await app.service.launch({ workspaceId: 'ws-1' })
    assert.equal(!launched.ok && launched.code, 'workspace_folder_missing')
    assert.equal(app.spawns.length, 0)
  })

  run('a workspace on an SSH machine is refused in words, and nothing is spawned here', async () => {
    const app = harness({
      workspaces: [workspace({ folderPath: 'ssh://e1/home/dev/repo' })],
      settings: settings({ lastSelectedCli: 'codex' }),
    })
    const launched = await app.service.launch({ workspaceId: 'ws-1' })
    assert.equal(!launched.ok && launched.code, 'workspace_on_ssh_machine')
    assert.match(!launched.ok ? launched.message : '', /is on an SSH machine/u)
    assert.equal(app.spawns.length, 0)
  })

  // The connector is resolved from the installed MCP settings alone since the
  // bundled catalogue was retired (2026-09-08): there is no template
  // left to launch a server the person never installed, so "installed and
  // enabled" is the whole rule.
  const railway = {
    id: 'railway',
    name: 'Railway',
    category: 'infrastructure',
    description: 'Railway',
    transport: 'stdio',
    command: 'railway-mcp',
    enabled: true,
    clients: [],
    scope: 'workspace',
    source: 'custom',
    riskLevel: 'network',
  } as unknown as McpServerConfig

  run('a connector launch carries an isolated single-server MCP and prunes', async () => {
    const app = harness({
      settings: settings({
        lastSelectedCli: 'claude-code',
        mcp: { syncEnabled: true, servers: { railway } },
      }),
    })

    const launched = await app.service.launch({ workspaceId: 'ws-1', connectorId: 'railway' })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    const spawn = app.spawns[0]!
    assert.deepEqual(Object.keys(spawn.mcpSettings?.servers ?? {}), ['railway'], 'only the connector travels')
    assert.equal(spawn.connectorLaunch, true, 'so the worktree config is pruned to it')
  })

  run('a disabled connector fails loudly instead of launching a plain agent', async () => {
    const app = harness({
      settings: settings({
        lastSelectedCli: 'claude-code',
        mcp: { syncEnabled: true, servers: { railway: { ...railway, enabled: false } } },
      }),
    })
    const launched = await app.service.launch({ workspaceId: 'ws-1', connectorId: 'railway' })
    assert.equal(!launched.ok && launched.code, 'connector_unavailable')
    assert.equal(app.spawns.length, 0, 'the connector environment is never silently dropped')
  })

  run('an unavailable connector fails loudly instead of launching a plain agent', async () => {
    const app = harness({ settings: settings({ lastSelectedCli: 'claude-code' }) })
    const launched = await app.service.launch({ workspaceId: 'ws-1', connectorId: 'railway' })
    assert.equal(!launched.ok && launched.code, 'connector_unavailable')
    assert.equal(app.spawns.length, 0, 'the connector environment is never silently dropped')
  })

  run('names avoid both stored records and the names of live sessions', async () => {
    // Every name the pool could pick is already taken by a record or a live
    // session, so the collision suffix is the only honest answer left.
    const app = harness({
      workspaces: [workspace({ agents: { a: { name: 'Aed' } } })],
      settings: settings({ lastSelectedCli: 'codex' }),
      sessions: [liveSession({ workspaceId: 'ws-1', agentName: 'Aidan' })],
    })
    const launched = await app.service.launch({ workspaceId: 'ws-1' })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    const name = app.spawns[0]!.agentName ?? ''
    assert.notEqual(name, 'Aed', 'a name held by a stored record is taken')
    assert.notEqual(name, 'Aidan', 'so is a name held only by a live session')
  })

  run('a failed spawn reports the failure rather than a launched agent', async () => {
    const app = harness({
      settings: settings({ lastSelectedCli: 'codex' }),
      spawnResult: { ok: false, sessionId: 'session-minted', message: 'codex is not installed', exitCode: 1 },
    })
    const launched = await app.service.launch({ workspaceId: 'ws-1' })
    assert.equal(!launched.ok && launched.code, 'agent_spawn_failed')
    assert.match(!launched.ok ? launched.message : '', /codex is not installed/)
  })

  run('the launch record rides the spawn so the renderer can project a tab', async () => {
    const app = harness({
      settings: settings({ lastSelectedCli: 'claude-code', lastAgentSpawnPermissionPreset: 'none' }),
    })
    const launched = await app.service.launch({ workspaceId: 'ws-1', name: 'Scout', cliModel: 'opus' })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    assert.deepEqual(app.spawns[0]!.agentRecord, {
      agentId: 'agent-claude-code-abc123',
      name: 'Scout',
      cli: 'claude-code',
      cliModel: 'opus',
      cliPermissionPreset: 'none',
    })
  })

  run("the project's Knowledge Graph reaches a headless launch", async () => {
    const app = harness({
      workspaces: [workspace({ folderPath: '/repo/a' })],
      settings: settings({
        lastSelectedCli: 'codex',
        projectKnowledgeRoots: { '/repo/a': 'knowledge' },
      }),
      resolveKnowledgeRoot: async () => ({ ok: true, rootPath: '/repo/a/knowledge', relativeRoot: 'knowledge' }),
    })

    const launched = await app.service.launch({ workspaceId: 'ws-1', prompt: 'Do the thing.' })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    const spawn = app.spawns[0]!
    // The resolved pair is what the spawn carries, and it is BOTH halves now: it
    // sets SPRINTENGINE_KNOWLEDGE_ROOT for the session AND it is what
    // `terminal-launch.ts` builds the host-context document's knowledge section
    // from. A headless launch therefore hands the spawn exactly what an
    // interactive one does.
    assert.equal(spawn.memoryRootPath, '/repo/a/knowledge')
    assert.equal(spawn.memoryRelativeRoot, 'knowledge')
    // And the prompt is the user's alone: the sentence about the graph is host
    // context, delivered out of band, not something the user said.
    assert.equal(spawn.initialPrompt, 'Do the thing.')
  })

  run('a configured-but-unreadable Knowledge Graph is said out loud, not dropped', async () => {
    const app = harness({
      workspaces: [workspace({ folderPath: '/repo/a' })],
      settings: settings({ lastSelectedCli: 'codex', projectKnowledgeRoots: { '/repo/a': 'knowledge' } }),
      resolveKnowledgeRoot: async () => {
        throw new Error('disk is on fire')
      },
    })

    const launched = await app.service.launch({ workspaceId: 'ws-1' })
    // A graph that cannot be read must not fail the launch, and the fact that one
    // is CONFIGURED still has to reach the spawn — an unresolved root with a known
    // relative path is what makes the host-context document say "configured, but
    // missing" instead of saying nothing and leaving the agent to guess a folder.
    assert.equal(launched.ok, true, JSON.stringify(launched))
    assert.equal(app.spawns[0]!.memoryRootPath, undefined)
    assert.equal(app.spawns[0]!.memoryRelativeRoot, 'knowledge')
    assert.equal(app.spawns[0]!.initialPrompt, undefined)
  })

  run('a project with no Knowledge Graph launches with no graph and no line', async () => {
    const app = harness({ settings: settings({ lastSelectedCli: 'codex' }) })
    const launched = await app.service.launch({ workspaceId: 'ws-1', prompt: 'go' })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    assert.equal(app.spawns[0]!.memoryRootPath, undefined)
    assert.equal(app.spawns[0]!.initialPrompt, 'go')
  })

  run('the launch carries an execution identity, or the run could never finalize', async () => {
    // Without `agentSession` the runtime fires NO agent-session exit for this
    // terminal (the listener is gated on `agentSession?.executionId`) and
    // `resolveAgentExecutionId` never matches it — an agent
    // would start and have no way to end, and its teardown could not find the
    // terminal to kill. This is the field that makes both work.
    const app = harness({
      workspaces: [workspace({ folderPath: '/repo/a' })],
      settings: settings({ lastSelectedCli: 'codex' }),
    })
    const launched = await app.service.launch({
      workspaceId: 'ws-1',
      name: 'Scout',
      worktreePath: '/repo/a/.worktrees/run-1',
    })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    assert.deepEqual(app.spawns[0]!.agentSession, {
      executionId: 'session-minted',
      system: 'manual',
      workspaceId: 'ws-1',
      // The PROJECT root, never the run worktree: a module's teardown matches its
      // sessions on the workspace root they were launched for.
      workspaceRoot: '/repo/a',
      displayName: 'Scout',
    })
  })

  // The caller-owned half of the launch (WP-B). A module agent session is an
  // ordinary launch that brings its own identity, its own working directory, and
  // its own residency rule — so the composition below is the same one every
  // app-level launch gets, and only these four inputs differ.

  run('a caller that owns its agent id keeps it, and the session id is still minted', async () => {
    const app = harness()
    const launched = await app.service.launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      agentId: 'review-guide-review_1',
    })

    assert.equal(launched.ok && launched.agentId, 'review-guide-review_1')
    assert.equal(app.spawns[0]!.agentId, 'review-guide-review_1')
    assert.equal(
      app.spawns[0]!.sessionId,
      'session-minted',
      'the agent id is never reused as the session id — a Claude-harness CLI refuses one it has seen',
    )
  })

  run('an explicit cwd wins over the workspace folder, which still owns the residency', async () => {
    const app = harness({ workspaces: [workspace({ folderPath: '/repo/a' })] })
    const launched = await app.service.launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      cwd: '/repo/a/packages/thing',
    })

    assert.equal(launched.ok, true)
    assert.equal(app.spawns[0]!.cwd, '/repo/a/packages/thing')
    assert.equal(app.spawns[0]!.workspaceId, 'ws-1')
    assert.equal(
      app.spawns[0]!.agentSession?.workspaceRoot,
      '/repo/a',
      'the execution identity still names the project root',
    )
  })

  run('anyWorkspaceMode accepts the workspace the caller named, whatever its mode', async () => {
    const app = harness({ workspaces: [workspace({ mode: 'weather-deck' })] })

    const refused = await app.service.launch({ workspaceId: 'ws-1', cli: 'claude-code' })
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.code, 'unsupported_workspace_mode')

    const allowed = await app.service.launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      anyWorkspaceMode: true,
    })
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
  })

  run('the result names the CLI main resolved and the execution id the exit will carry', async () => {
    const app = harness({ settings: settings({ lastSelectedCli: 'codex' }) })
    const launched = await app.service.launch({ workspaceId: 'ws-1' })

    assert.ok(launched.ok)
    if (!launched.ok) return
    assert.equal(launched.cli, 'codex', 'a caller that named no CLI still learns which one started')
    assert.equal(launched.executionId, launched.sessionId)
    assert.equal(app.spawns[0]!.agentSession?.executionId, launched.executionId)
  })

  run("dispose kills the agent's live sessions and is idempotent", () => {
    const app = harness({
      sessions: [
        liveSession({ sessionId: 'session-a', workspaceId: 'ws-1', agentId: 'agent-1' }),
        liveSession({ sessionId: 'session-b', workspaceId: 'ws-1', agentId: 'agent-2' }),
        liveSession({ sessionId: 'session-c', workspaceId: 'ws-2', agentId: 'agent-1' }),
        liveSession({ sessionId: 'session-d', kind: 'terminal', workspaceId: 'ws-1', agentId: 'agent-1' }),
      ],
    })

    const first = app.service.dispose({ workspaceId: 'ws-1', agentId: 'agent-1' })
    assert.equal(first.ok, true)
    assert.deepEqual(app.kills, ['session-a'], 'only THIS agent in THIS workspace, and only agent sessions')

    // A second finalize for the same agent must stay benign.
    const again = app.service.dispose({ workspaceId: 'ws-1', agentId: 'missing' })
    assert.equal(again.ok, true)
    assert.deepEqual(app.kills, ['session-a'])
  })

  async function main(): Promise<void> {
    let failed = false
    for (const test of tests) {
      try {
        await test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        failed = true
        console.error(`not ok - ${test.name}`)
        console.error(error)
      }
    }
    if (failed) process.exit(1)
    console.log('agent-launch-service.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
