/**
 * AgentLaunchService — composing an agent launch is a main-process capability.
 *
 * The spawn mechanics were already main-owned (`terminal-launch.ts` renders the
 * argv and env; the runtime's spawn handler takes the whole payload as data).
 * What lived in the renderer was the DECISION layer: which CLI when the caller
 * named none, which permission preset, how a connector resolves, and what the
 * agent is called. It lived in a React hook, so `agent.launch`, `backlog.work`,
 * and the old automation runs all failed headless — not because they needed a
 * window, but because the composition did.
 *
 * This service is that layer, with every input injected:
 *
 * - **CLI + permission defaults** come from the main-owned launch settings store,
 *   which the renderer pushes on change and main reads synchronously,
 *   so a headless launch uses the user's real defaults instead of guessing.
 * - **Connector resolution** is the shared rule (`src/shared/connector-launch.ts`)
 *   over main's own MCP catalog — the same answer the connector chat gets.
 * - **The spawn** is the terminal runtime's own handler. Nothing here writes to
 *   a pty or knows what Electron is.
 *
 * ## The renderer's remaining half
 *
 * Main mints the terminal session id and spawns; the launched record rides back
 * on the session snapshot as {@link AgentLaunchRecord}. The renderer projects
 * live sessions into `AgentState` records and reveals their tabs
 * (`projectLaunchedAgentSessions`), so the FlexLayout tab is a VIEW of main's
 * session list. A `TerminalView` mounting on a projected agent calls
 * `terminalSpawn` with the session id main already used, which the runtime
 * answers by reattaching and replaying the retained scrollback — which is why a
 * window opened long after a headless launch shows the terminal with its
 * history, and why no launch is ever performed twice.
 *
 * ## What it deliberately does not do
 *
 * Dispatch per transport (a conversation-runtime session for non-PTY agents) is
 * named by the item as the second half. Every caller today asks for a terminal
 * agent, and the `transport` field below is the seam that half plugs into: it is
 * resolved here, in one place, rather than each caller assuming a pty.
 */
import { randomUUID } from 'crypto'

import type {
  AgentCli,
  MemoryRootStatus,
  McpSettings,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type {
  AgentDisposeRequest,
  AgentDisposeResult,
  AgentLaunchRecord,
  AgentLaunchRequest,
  AgentLaunchResult,
} from '../shared/agent-launch'
import { LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE, launchPromptReadsAsOption } from '../shared/agent-launch'
import {
  effectiveAgentLaunchSettings,
  resolveAgentSpawnPermission,
  type AgentLaunchSettings,
} from '../shared/launch-settings'
import { parseCliPermissionModeId } from '../shared/cli-permission-mode'
import { resolveConnectorLaunchFrom } from '../shared/connector-launch'
import { newAgentIdSuffix } from '../shared/agent-ids'
import { pickRandomAgentName } from '../shared/agent-names'
import {
  knowledgeLaunchContext,
  resolveProjectKnowledgeConfig,
  type KnowledgeLaunchContext,
} from '../shared/project-knowledge'
import { normalizeExecutionHostId } from '../shared/execution-host'
import { isMachinePath } from '../shared/machine-paths'
import type { CliPermissionPreset } from '../shared/cli-permission-preset'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'

/**
 * Terminal geometry for a session no view has bound to yet. The first
 * `TerminalView` that attaches resizes it; this only has to be wide enough that
 * the CLI's own startup output is not wrapped into nonsense in the scrollback a
 * later-opened window replays. Same values the review guide's headless spawn
 * uses, for the same reason.
 */
const UNBOUND_TERMINAL_COLS = 120
const UNBOUND_TERMINAL_ROWS = 30

/** A workspace as the launch service needs to see it. */
export type AgentLaunchWorkspace = {
  id: string
  mode?: string
  folderPath?: string | null
  agents?: Record<string, { name?: string }>
  /** Workspace-level Knowledge Graph override, below the per-project setting. */
  memory?: { relativeRoot?: string | null } | null
  /** The machine the workspace runs on (`local`, or a WSL distribution). */
  hostId?: string | null
}

export type AgentLaunchServiceDeps = {
  /** Open workspaces, from the workspace-sync snapshot. */
  listWorkspaces: () => ReadonlyArray<AgentLaunchWorkspace>
  /**
   * The main-owned launch settings: CLI runtimes, MCP servers, the
   * last-selected CLI, and the agent-spawn permission presets. Read at launch
   * time, never cached, so a setting changed in the UI reaches the next launch
   * without a restart.
   */
  getLaunchSettings: () => AgentLaunchSettings
  /**
   * Whether this CLI may launch as an agent: true exactly when its plugin
   * manifest declares an `agentStateSpec` (hooks are the only supported status
   * mechanism — decision of record 2026-08-31). This service is the shared door
   * for `agent.launch`, `backlog.work` and `terminal.create`, so gating here
   * covers them all. Optional so bare test harnesses
   * keep working; production wiring always provides it.
   */
  isAgentSelectableCli?: (cli: string) => boolean
  /**
   * The permission presets a terminal launch of this CLI is told in its own
   * words (`declaredPermissionPresets`), or null for a CLI the registry does
   * not hold. A preset the caller names outside the list is refused rather
   * than launched with no flag under that preset's name. Optional, like
   * `isAgentSelectableCli`.
   */
  permissionPresetsForCli?: (cli: string) => readonly CliPermissionPreset[] | null
  /**
   * Whether this CLI's manifest declares a resume it has been verified to
   * honour (`capabilities.resumeSession`). A launch that asks to resume a
   * session on one that does not is refused rather than started fresh under
   * the resumed conversation's name. Optional, like `isAgentSelectableCli`.
   */
  cliResumesSessions?: (cli: string) => boolean
  /**
   * Resolve a project's Knowledge Graph root on disk (`memory-graph.ts`'s
   * `resolveMemoryRoot`, the same call the renderer makes over IPC). Optional:
   * a host that cannot resolve one launches without the graph rather than
   * failing, which is what a project with no KG configured gets anyway.
   */
  resolveKnowledgeRoot?: (input: { workspaceRoot: string; relativeRoot: string }) => Promise<MemoryRootStatus>
  terminal: {
    list: () => TerminalSessionSnapshot[]
    spawn: (payload: TerminalSpawnPayload) => Promise<TerminalSpawnResult>
    kill: (sessionId: string) => void
  }
  /** Session id minting. Injected so tests get stable ids; must be a UUID. */
  newSessionId?: () => string
  /** Agent id suffix. Injected for the same reason. */
  newAgentSuffix?: () => string
}

export type AgentLaunchService = {
  launch: (request: AgentLaunchRequest) => Promise<AgentLaunchResult>
  dispose: (request: AgentDisposeRequest) => AgentDisposeResult
}

export function createAgentLaunchService(deps: AgentLaunchServiceDeps): AgentLaunchService {
  const newSessionId = deps.newSessionId ?? (() => randomUUID())
  const newAgentSuffix = deps.newAgentSuffix ?? newAgentIdSuffix

  async function launch(request: AgentLaunchRequest): Promise<AgentLaunchResult> {
    const workspace = deps.listWorkspaces().find((candidate) => candidate.id === request.workspaceId)
    if (!workspace) {
      return {
        ok: false,
        code: 'unknown_workspace',
        message: `Workspace "${request.workspaceId}" does not exist in the main-process registry.`,
      }
    }
    // Agents launch into standard workspaces. Any other mode is not a valid
    // launch host. A restart-restored routing placeholder reports 'standard',
    // which is the permissive answer and matches what the renderer used to
    // conclude from its own record.
    //
    // A caller that owns its own residency (a module agent session, which names
    // the workspace its surface was opened from) opts out with
    // `anyWorkspaceMode`: refusing there would refuse the workspace the user is
    // actually standing in.
    const mode = workspace.mode ?? 'standard'
    if (!request.anyWorkspaceMode && mode !== 'standard') {
      return {
        ok: false,
        code: 'unsupported_workspace_mode',
        message: `Agent launch supports standard workspaces; "${workspace.id}" is a ${mode} workspace.`,
      }
    }

    // A never-chosen CLI or preset reads as the app default, through the same
    // function the window's pickers read, so a launch with no window open runs
    // on exactly what the window shows.
    const settings = effectiveAgentLaunchSettings(deps.getLaunchSettings())
    const cli = (request.cli?.trim() || settings.lastSelectedCli || '') as AgentCli | ''
    if (!cli) {
      return {
        ok: false,
        code: 'no_cli_selected',
        message: 'No CLI was requested and no last-selected CLI is configured.',
      }
    }
    // Never silently substitute another CLI for an ineligible one — surface it
    // and let the caller pick. Covers a stale persisted selection (a
    // lastSelectedCli naming a CLI that lost eligibility).
    if (deps.isAgentSelectableCli && !deps.isAgentSelectableCli(cli)) {
      return {
        ok: false,
        code: 'cli_not_agent_selectable',
        message: `Agent CLI "${cli}" cannot report agent status (its plugin declares no lifecycle-hook support), so it is not selectable as an agent. Pick another CLI.`,
      }
    }

    const declared = deps.permissionPresetsForCli?.(cli) ?? null
    if (request.permissionPreset && declared && !declared.includes(request.permissionPreset)) {
      return {
        ok: false,
        code: 'unsupported_permission_preset',
        message: `Agent CLI "${cli}" has no setting for the "${request.permissionPreset}" permission preset in a terminal. Pass one of: ${declared.join(', ')}.`,
      }
    }

    const resumeCliSessionId = request.resumeCliSessionId?.trim() || undefined
    if (resumeCliSessionId && deps.cliResumesSessions && !deps.cliResumesSessions(cli)) {
      return {
        ok: false,
        code: 'cli_resume_unsupported',
        message: `Agent CLI "${cli}" cannot resume a session in a terminal.`,
      }
    }

    // A connector-backed launch resolves the same way a connector chat does
    // (the installed, enabled server → a single-server MCP config); the resolved
    // settings ride the spawn so the connector's .mcp.json lands in the run
    // worktree and nowhere else. An unavailable id is an explicit failure —
    // never launch a plain agent that silently drops the connector environment.
    const connector = request.connectorId
      ? resolveConnectorLaunchFrom({
          connectorId: request.connectorId,
          installedServers: settings.mcp?.servers,
        })
      : null
    if (connector && !connector.ok) {
      return { ok: false, code: 'connector_unavailable', message: connector.message }
    }

    const worktreePath = request.worktreePath?.trim() || undefined
    // An explicit cwd wins over both: a module agent session runs in a folder
    // its own surface resolved (a project root the workspace merely holds),
    // and the workspace still owns the residency around it.
    const cwd = request.cwd?.trim() || worktreePath || workspace.folderPath?.trim() || ''
    if (!cwd) {
      // Spawning into `process.cwd()` would run the agent inside the app's own
      // install directory. Refuse rather than launch somewhere nobody asked for.
      return {
        ok: false,
        code: 'workspace_folder_missing',
        message: `Workspace "${workspace.id}" has no project folder, so there is nowhere to launch the agent.`,
      }
    }
    if (isMachinePath(cwd)) {
      // A folder on an SSH machine (`ssh://…`): a terminal runs on this
      // computer, where that spelling would name a folder under the app's
      // working directory, and its .mcp.json and skills would be written there.
      return {
        ok: false,
        code: 'workspace_on_ssh_machine',
        message: `Workspace "${workspace.id}" is on an SSH machine, and agents in a terminal run on this computer. Start a chat there instead.`,
      }
    }

    // The caller's preset when it names one: the agent.launch and backlog.work
    // tools always do, and they floor an unnamed preset to their most
    // restrictive one. A caller that names none gets what the spawn footer
    // shows for this CLI: the preset (and the CLI's own mode) the person chose
    // for it, else the app-wide spawn default, else Auto where the CLI has it.
    const permission = resolveAgentSpawnPermission(settings, cli, request.permissionPreset, declared)
    const permissionMode = request.permissionPreset ? parseCliPermissionModeId(request.permissionMode) : permission.mode

    const agentId = request.agentId?.trim() || `agent-${cli}-${newAgentSuffix()}`
    const name = request.name?.trim() || pickRandomAgentName(takenAgentNames(workspace, deps.terminal.list()))
    // The project's Knowledge Graph, resolved the same way the interactive
    // launch resolves it: the per-project setting from the main-owned store,
    // falling back to the workspace's own override. Without this a
    // headless-launched agent silently loses `SPRINTENGINE_KNOWLEDGE_ROOT`, and the
    // spawn has nothing to build the host-context document's knowledge section
    // from — it would then either ignore the project's recorded context or guess
    // at a folder.
    const knowledge = await resolveKnowledgeLaunch(workspace, settings.projectKnowledgeRoots)
    // The prompt is the user's alone. The sentence about the graph, and the one
    // about an attached design system, are built into the host-context document
    // by `terminal-launch.ts` from the root/relativeRoot pair below — which is
    // how a headless launch now receives exactly what an interactive one does.
    // A resumed conversation already has its opening; a prompt would be sent
    // into it as a new message nobody typed there.
    const initialPrompt = resumeCliSessionId ? undefined : request.prompt
    // Refused here as well as at each tool, so no caller of the service can
    // hand the CLI a first message its option parser would read as a flag.
    if (launchPromptReadsAsOption(initialPrompt)) {
      return { ok: false, code: 'prompt_reads_as_option', message: LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE }
    }

    const record: AgentLaunchRecord = {
      agentId,
      name,
      cli,
      ...(request.cliModel?.trim() ? { cliModel: request.cliModel.trim() } : {}),
      cliPermissionPreset: permission.preset,
      ...(permissionMode ? { cliPermissionMode: permissionMode } : {}),
      ...(connector?.ok ? { connectorMcpSettings: connector.resolved.mcpSettings } : {}),
      ...(request.spawnSkillId?.trim() ? { spawnSkillId: request.spawnSkillId.trim() } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    }
    // The caller's machine, else the workspace's. Absent from both, the spawn
    // reads the folder (a folder inside a distribution runs there) and
    // otherwise launches on this machine.
    const hostId = normalizeExecutionHostId(request.host) ?? normalizeExecutionHostId(workspace.hostId)
    if (hostId) record.hostId = hostId

    const sessionId = newSessionId()
    const spawned = await deps.terminal.spawn({
      sessionId,
      cols: UNBOUND_TERMINAL_COLS,
      rows: UNBOUND_TERMINAL_ROWS,
      cwd,
      cli,
      ...(initialPrompt ? { initialPrompt } : {}),
      // The spawn renders the manifest's resume command around this id, and
      // seeds the session's harness id with it so a later relaunch resumes the
      // same conversation.
      ...(resumeCliSessionId ? { resume: true, cliSessionId: resumeCliSessionId } : {}),
      // The user's command overrides. The two shapes are field-identical
      // (`command`, `models?`); the cast is only the keying — the
      // mirror types its map by plain string, the payload by `AgentCli`, which
      // is itself a string alias. Omitted when empty so an unconfigured install
      // spawns exactly as it did before the store existed.
      ...(Object.keys(settings.cliRuntimes ?? {}).length > 0
        ? { cliRuntimes: settings.cliRuntimes as TerminalSpawnPayload['cliRuntimes'] }
        : {}),
      kind: 'agent',
      workspaceId: workspace.id,
      ...(hostId ? { hostId } : {}),
      agentId,
      agentName: name,
      cliPermissionPreset: record.cliPermissionPreset,
      ...(record.cliPermissionMode ? { cliPermissionMode: record.cliPermissionMode } : {}),
      ...(record.cliModel ? { cliModel: record.cliModel } : {}),
      ...(worktreePath ? { executionMode: 'worktree' as const, worktreePath } : {}),
      ...(knowledge.rootPath ? { memoryRootPath: knowledge.rootPath } : {}),
      ...(knowledge.relativeRoot ? { memoryRelativeRoot: knowledge.relativeRoot } : {}),
      // A connector launch forwards its own single-server MCP instead of the
      // workspace's, and marks itself so the spawn prunes anything else out of
      // the worktree config. Ordinary agents fall through to the user's MCP.
      ...connectorLaunchMcp(record, settings.mcp),
      ...(record.spawnSkillId ? { spawnSkillId: record.spawnSkillId } : {}),
      // Nothing is bound to this session yet. A window open right now projects
      // and reveals it within a session-snapshot tick; a window opened later
      // does the same on its first tick.
      visible: false,
      // The session's EXECUTION identity, without which the runtime reports no
      // agent-session exit for it at all (`agentSession?.executionId` gates the
      // listener) and `resolveAgentExecutionId` never matches. Both are how an
      // agent-backed automation run finalizes and how its teardown finds the
      // terminal to kill, so a launch that omitted this would start runs that
      // could never end. `TerminalView` supplied it on the old renderer path;
      // main supplies exactly the same shape now.
      agentSession: {
        executionId: sessionId,
        // 'manual' is an agent this app launched itself; a capability module
        // that runs its own agents names itself instead.
        system: 'manual',
        workspaceId: workspace.id,
        // The PROJECT root, not the run worktree: a module's teardown matches
        // its sessions on the workspace root they were launched for.
        workspaceRoot: workspace.folderPath?.trim() || cwd,
        displayName: name,
      },
      agentRecord: record,
    })

    if (!spawned.ok) {
      return {
        ok: false,
        code: 'agent_spawn_failed',
        message: spawned.message ?? `Agent "${agentId}" could not be started in workspace "${workspace.id}".`,
      }
    }
    return { ok: true, workspaceId: workspace.id, agentId, sessionId, cli, executionId: sessionId }
  }

  /**
   * Remove a launched agent: kill its terminal session. Called at run finalize
   * so a one-shot automation agent never lingers pointing at a torn-down run
   * worktree. Idempotent — an agent with no live session is already disposed,
   * and reporting that as success keeps a duplicate finalize benign.
   *
   * The renderer's half (dropping the FlexLayout tab and the projected record)
   * follows from the session disappearing: the projection only ever mirrors live
   * sessions, so there is nothing to tell it.
   */
  function dispose(request: AgentDisposeRequest): AgentDisposeResult {
    for (const session of deps.terminal.list()) {
      if (session.kind !== 'agent') continue
      if (session.workspaceId !== request.workspaceId) continue
      if (session.agentId !== request.agentId) continue
      deps.terminal.kill(session.sessionId)
    }
    return { ok: true, workspaceId: request.workspaceId, agentId: request.agentId }
  }

  /**
   * The Knowledge Graph inputs for this launch, or an empty context when the
   * project configures none (the common case) or the host wired no resolver.
   * Never throws: a graph that cannot be read must not fail a launch, and
   * `knowledgeLaunchContext` still emits the "configured but inaccessible" line
   * so the agent is told rather than left to guess a folder.
   */
  async function resolveKnowledgeLaunch(
    workspace: AgentLaunchWorkspace,
    projectKnowledgeRoots: AgentLaunchSettings['projectKnowledgeRoots'],
  ): Promise<KnowledgeLaunchContext> {
    const empty: KnowledgeLaunchContext = { promptSuffix: null }
    if (!deps.resolveKnowledgeRoot) return empty
    const config = resolveProjectKnowledgeConfig(
      workspace.folderPath,
      projectKnowledgeRoots,
      workspace.memory?.relativeRoot,
    )
    if (!config?.relativeRoot) return empty
    const status = await deps
      .resolveKnowledgeRoot({ workspaceRoot: config.projectRoot, relativeRoot: config.relativeRoot })
      .catch((error): MemoryRootStatus => ({
        ok: false,
        status: 'inaccessible',
        relativeRoot: config.relativeRoot,
        message: error instanceof Error ? error.message : 'Unable to resolve workspace knowledge.',
      }))
    return knowledgeLaunchContext(status)
  }

  return { launch, dispose }
}

/**
 * Names already in use in this workspace: the records main knows about plus the
 * names of its live agent sessions. Both halves matter — a headless launch has
 * no renderer record to read, and two launches in the same second would
 * otherwise both pick the same "unused" name.
 */
function takenAgentNames(workspace: AgentLaunchWorkspace, sessions: ReadonlyArray<TerminalSessionSnapshot>): string[] {
  const names = Object.values(workspace.agents ?? {})
    .map((agent) => agent?.name)
    .filter((name): name is string => Boolean(name))
  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    if (session.workspaceId !== workspace.id) continue
    if (session.agentName) names.push(session.agentName)
  }
  return names
}

/**
 * The MCP half of the spawn payload. A connector launch forwards ONLY its own
 * server and sets `connectorLaunch`, which is what tells the spawn to prune
 * every other server out of the worktree config and git-exclude it. That flag is
 * driven by the connector settings alone: `spawnSkillId` is the orthogonal
 * skill-install concern, and letting it imply pruning would wipe the MCP config
 * of a skill-only spawn.
 */
function connectorLaunchMcp(
  record: AgentLaunchRecord,
  workspaceMcp: McpSettings | undefined,
): Pick<TerminalSpawnPayload, 'mcpSettings' | 'connectorLaunch'> {
  if (record.connectorMcpSettings) {
    return { mcpSettings: record.connectorMcpSettings, connectorLaunch: true }
  }
  return workspaceMcp ? { mcpSettings: workspaceMcp } : {}
}
