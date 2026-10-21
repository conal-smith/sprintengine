import { isAbsolute } from 'path'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { RepositoryIdentity } from '../../shared/repository-identity'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { WorkspaceExtensions } from '../../shared/workspace-extensions'
import type { CliPermissionPreset, TerminalSessionSnapshot } from '../../shared/electron-api'
import { projectColorKey, projectHue } from '../../shared/project-hue'
import { projectFrecency, projectUsageKey, type ProjectUsageMap } from '../../shared/project-frecency'
import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { declaredPermissionModes, declaredPermissionPresets, pluginHostedVia } from '../plugin-render'
import { mergeCliModelCatalog, type DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import { cliPickerModels } from '../../shared/cli-model-families'
import { conversationProviderForCli } from '../../shared/conversation-harness'
import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'
import {
  launchingAgentOf,
  NOT_TOLD_NOT_AN_AGENT,
  NOT_TOLD_UNAVAILABLE,
  type LaunchedAgentLink,
  type LaunchLinkResult,
} from '../agent-launch-notices'
import { mobileSnapshotCollections, retiredMobileSnapshotCollections } from '../mobile/control/protocol'
import type { Workspace } from '../../renderer/src/types/workspace'
import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCriticalityPayload,
  BacklogDependenciesPlannedInput,
  BacklogDifficultyPayload,
  BacklogEpicInput,
  BacklogItemStatusPayload,
  BacklogMutationResult,
  BacklogRiskPayload,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogTypePayload,
} from '../../shared/electron-api'
import type {
  BacklogIntegrityRepairInput,
  BacklogIntegrityRepairResult,
  BacklogListItemsResult,
  BacklogReadItemResult,
} from '../backlog-service'
import type { ScheduledAgentsService } from '../scheduled-agents/service'
import { scheduledAgentScheduleWords, type ScheduledAgentView } from '../../shared/scheduled-agents'
import type { LoadedPlugin } from '../../shared/plugin-manifest'
import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api'
import {
  MARKETPLACE_COMPONENT_KINDS,
  type MarketplaceComponentKind,
  type MarketplacePluginEntry,
} from '../../shared/marketplace/manifest'
import {
  BUNDLED_MODULE_IDS,
  type CapabilityManifest,
  type ThirdPartyModuleListResult,
  type ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import { isDevOnlyModule } from '../../shared/modules/dev-only'
import type { ModuleRegistryEntry, ModuleRegistrySnapshot } from '../../shared/modules/registry-snapshot'
import { buildAgentBacklogLink } from '../../shared/backlog/agent-links'
// The built-in Backlog skill id backlog.work installs and invokes, and the
// plain-language handoff it falls back to. Both come from the shared module the
// renderer's "Hand to agent" reads too, so the same handoff is worded the same
// way whichever door it comes through. The skill contract owns item lifecycle
// through backlog.update; this tool only launches the agent and records links
// (epic decision 7).
import { BACKLOG_SKILL_ID, backlogLifecycleHandoffPrompt } from '../../shared/backlog/handoff-prompt'
import { renderSkillInvocationTemplate } from '../../shared/skill-invocation'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from './mcp-socket-server'
import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../workspace-registry-service'
import type { WorkspaceMutationActor } from '../workspace-sync-service'
import { getWorkspaceChangeSummary } from '../workspace-change-summary'
import {
  capScheduledAgentPreset,
  capLaunchPermissionPreset,
  launchPermissionCeiling,
  refuseScheduledAgentRun,
  type AgentPermissionResolver,
} from './launch-permission-cap'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { newAgentIdSuffix } from '../../shared/agent-ids'
import type { StartedDependencyInstall } from '../worktree-pool/dependency-install'
import { installProjection } from './conversation-tools'
import type { TerminalOutputTail } from '../terminal-output-tail'
import { terminalPlainText } from './terminal-plain-text'

// The automation tool surface. v1: workspace.create / workspace.list /
// workspace.status / agent.launch / agent.status; the read expansion adds
// backlog.list / backlog.read / schedule.list. Reads and
// mutations alike answer from main's own services — there is one lane, and it is
// main's. No tool on this surface needs a window, and the renderer
// delegate that used to carry mutations, along with its `no_primary_window` /
// `renderer_timeout` error class, is gone. Mutations that have to be observed
// before success is reported are confirmed against the state main itself minted
// (the workspace-sync bus, the live terminal session).

const LAUNCH_CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 150
/** The launches that waited on a dependency install, kept for `agent.status` to report. */
const DEFERRED_LAUNCHES_KEPT = 128
/** Why a launch answered before its agent started says nothing yet about telling the caller. */
const DEFERRED_NOTIFY_REASON =
  'The agent starts when its worktree finishes installing dependencies, and the caller is linked to it then if ' +
  'it can be; agent.status says whether it was. Until it starts, read agent.status.'

// All agents spawn on Auto unless someone chooses another preset (owner
// request 2026-10-01; Bypass before then), and that holds on this surface too
// (owner ruling 2026-09-27): an
// external caller, a paired machine and an automation may name any preset,
// exactly as a person at the launcher can. An omitted preset is not floored here; the
// launch service resolves it the way the desktop launcher does, so an agent
// started from outside runs on the preset the spawn footer shows for its CLI.
// The one exception is a caller that is itself one of this app's agents: it
// launches at its own preset or stricter (launch-permission-cap.ts).
const LAUNCH_PERMISSION_PRESETS = ['none', 'manual', 'auto', 'bypass'] as const satisfies readonly CliPermissionPreset[]

// Said on every launching tool, so an agent learns the rule before it is refused by it.
const CALLER_PRESET_CAP_SENTENCE =
  "Called by an agent of this app, the launch runs no looser than that agent's own preset: a looser one " +
  'is refused with "permission_escalation", and an omitted one takes the stricter of the two.'

// What one `terminal.read` hands back. Lines are what a caller asks for, and
// two hundred is a screenful or four of a dev server's log — enough to hold the
// error and what led up to it. The character cap bounds the answer whatever the
// line length, since one minified stack line can be longer than a whole log.
// The raw window read from the buffer is wider than the character cap because
// escapes and redraws are thrown away on the way: a coloured log is often half
// escapes, and a progress bar's every frame shrinks to its last.
const TERMINAL_READ_DEFAULT_LINES = 200
const TERMINAL_READ_MAX_LINES = 2_000
const TERMINAL_READ_MAX_CHARS = 64 * 1024
const TERMINAL_READ_RAW_BYTES = 256 * 1024

export type AutomationBackends = {
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  listTerminalSessions(): TerminalSessionSnapshot[]
  /**
   * The newest raw output of one terminal session, at most `maxBytes` of it
   * and, with `since`, only what came after that cursor
   * (terminal-output-tail.ts). `undefined` when the runtime holds no such
   * session. Absent, `terminal.read` answers that this machine does not serve
   * terminal output.
   */
  readTerminalOutputTail?(
    sessionId: string,
    options: { maxBytes: number; since?: string },
  ): TerminalOutputTail | undefined
  /** Compose and spawn an agent in main. */
  launchAgent(request: AgentLaunchRequest): Promise<AgentLaunchResult>
  /**
   * Remember that the calling agent launched this one, so the caller is told
   * when it finishes or stops to ask (agent-launch-notices.ts). Answers
   * whether the caller will be told. Absent, nobody is, and `agent.launch`
   * says so.
   */
  linkLaunchedAgent?(link: LaunchedAgentLink): LaunchLinkResult
  /**
   * The preset an agent of this app is running on now. A connection that
   * declares itself one of them launches no looser than this; see
   * launch-permission-cap.ts.
   */
  resolveAgentPermissionPreset: AgentPermissionResolver
  /**
   * Mint a workspace in main's registry. Synchronous and
   * window-independent: `workspace.create` no longer asks a renderer to build
   * the record and then polls the bus to see whether it appeared.
   */
  createWorkspace(
    input: WorkspaceCreateRequest,
    actor: WorkspaceMutationActor,
  ): { ok: true; result: WorkspaceCreateResult } | { ok: false; reason: string; message: string }
  /** Read-only backlog listing for a workspace root (files + frontmatter, no writes). */
  listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult>
  /** Read one backlog item (validated backlog/ relative path). */
  readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult>
  /** Backlog write services (main-owned file/store writers in backlog-service). */
  backlogWrite: BacklogWriteBackends
  /**
   * The scheduled agents service, resolved lazily (the module kernel boots
   * after the automation server's tools are constructed). Null while the
   * Scheduled agents module is disabled or not yet loaded — tools report that
   * explicitly instead of buffering.
   */
  getScheduledAgents(): ScheduledAgentsService | null
  /** The CLI a scheduled agent runs when its creator names none: the last one picked here. */
  defaultChatCli(): string | null
  /**
   * Create a git worktree for a widened agent.launch (model/preset launches
   * that request isolation, and every connector launch). Worktree
   * creation is renderer-adjacent but git-bound, so it happens in main before
   * delegating — the automations executor precedent. Returns the created
   * absolute path + branch, or `{ error }` (non-git folder, name collision,
   * git failure) which the tool surfaces as `worktree_unavailable`. Injected as
   * a backend so tests fake it.
   */
  createAgentWorktree(input: {
    workspaceRoot: string
    name: string
    /** The ref the worktree branches from; the checkout's HEAD when absent. */
    baseRef?: string
  }): Promise<
    | {
        worktreePath: string
        branch: string
        /**
         * The project's dependency install, started in the new worktree and
         * still running (worktree-pool/dependency-install.ts). The agent is
         * started once it ends.
         */
        dependencyInstall?: StartedDependencyInstall
      }
    | { error: string }
  >
  /**
   * Which repository a folder is a clone of (one-project-across-machines):
   * its primary remote, normalised. Null for a non-repo or a remote-less one.
   * Served on `workspace.list` so a paired Studio can match this machine's
   * copy of a repository to its own. Cached in main; never throws.
   */
  readRepositoryIdentity(folderPath: string): Promise<RepositoryIdentity | null>
  /**
   * Where chats were started, by project folder: the agent-launch settings'
   * `projectUsage`. Served on `workspace.list` as each row's
   * `projectFrecency`, so a phone lists its projects in the order New chat
   * here does. Absent, the rows go without it, as they did before.
   */
  projectUsage?(): ProjectUsageMap
  /**
   * The checkout facts a remote launch panel needs before choosing where a
   * chat runs (checkout-and-branch-on-remote-create): whether the folder is
   * a repository, its branch, the trunk, every local branch, and the
   * worktrees the repository holds. Read-only; never throws for a non-repo
   * (that is the `git: false` answer).
   */
  readWorkspaceCheckout(workspaceRoot: string): Promise<{
    git: boolean
    branch: string | null
    defaultBranch: string | null
    branches: Array<{ name: string; current: boolean }>
    worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
  }>
  /**
   * The skills a chat in a project can be given and the MCP servers a CLI
   * there is configured with, for a paired machine's composer to offer: the
   * same inventory and capability answer the composer here reads. Absent,
   * `workspace.extensions` is not served.
   */
  readWorkspaceExtensions?(workspaceRoot: string, cli: string | null): Promise<WorkspaceExtensions>
  /**
   * Loaded CLI plugin manifests (`getPluginRegistry().loaded()`). backlog.work
   * composes the target CLI's native skill invocation from the matching
   * plugin's `skillIntegration.invocation.fileDropTemplate`; injected as a
   * backend so tests fake manifests.
   */
  listPlugins(): LoadedPlugin[]
  /**
   * What the model picker here reads besides the manifests: the catalogs each
   * CLI reported about itself (the discovery cache) and the ids the person
   * added for it in Settings. `cli.runtime.list` merges them as the picker
   * does to answer with the picker's own rows; absent, it answers without a
   * `catalog`, as it did before it had one.
   */
  readCliModelSources?(): Promise<CliModelSources>
  /**
   * Make a built-in skill present in the workspace's native harness dirs before
   * a launch reads its invocation (getStatus → install; the
   * `ensureBuiltinSkillInstalled` seam in app-services). Returns whether the
   * skill is now installed. A false result is non-fatal for backlog.work — the
   * response records `skillEnsured: false` and the composed prompt still states
   * the lifecycle contract. `cli` is the agent the handoff names, when it names
   * one: a CLI whose launch carries the skill in the app's own plugin directory
   * needs no copy in the workspace, and gets none. `hostId` is the workspace's
   * machine, which decides whether that launch carries it (a WSL machine's
   * launch can while this machine's cannot).
   */
  ensureBuiltinSkillInstalled(
    workspaceRoot: string,
    skillId: string,
    cli?: string,
    hostId?: string | null,
  ): Promise<boolean>
  /**
   * The module registry as the renderer resolves it, mirrored into
   * main. Null until a window has pushed one — the module tools report that
   * explicitly rather than answering from main's own half of the universe,
   * which knows nothing about renderer-only modules (Backlog, Design, Git, …).
   */
  getModuleRegistrySnapshot(): ModuleRegistrySnapshot | null
  /**
   * Installed third-party modules with the trust + launch readiness only main
   * can compute (signature verification and the trust store live here). An
   * untrusted module never reaches the renderer registry, so this is also how
   * `module.list` sees that it is installed at all.
   */
  listInstalledThirdPartyModules(): Promise<ThirdPartyModuleListResult>
  /** Gateway tools contributed by capability modules, by owner. */
  listModuleContributedTools(): ReadonlyArray<{ moduleId: string; toolName: string }>
  /**
   * The marketplace registry index through the same client, cache, and
   * bundled-first policy the Extensions storefront reads (`marketplace:registry:read`)
   * — one source of truth, not a second fetch path.
   */
  readMarketplaceRegistry(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
  /**
   * The mobile companion's read model and command lane. The phone pairs with
   * and talks to this desktop only over the tailnet gateway, so this is the
   * whole of its connection: snapshots come back in path-token form — the
   * phone round-trips `ws_` tokens, never local paths — and commands run
   * through the MobileControlCommandService.
   */
  mobileControl: {
    readSnapshot(input: {
      include?: string[]
      knownSnapshotVersion?: string
    }): Promise<{ unchanged: true; snapshotVersion: string } | { unchanged: false; snapshot: Record<string, unknown> }>
    dispatchCommand(input: {
      type: string
      payload: Record<string, unknown>
      deviceId: string
      idempotencyKey: string
      expectedSnapshotVersion?: string
    }): Promise<
      | { ok: true; commandId: string; commandType: string; executedAt: string; data: unknown }
      | { ok: false; code: string; message: string }
    >
  }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type CliModelSources = {
  /** The discovered catalogs, keyed by CLI id; an unreadable cache reads as none. */
  discovered: Record<string, DiscoveredCliModelCatalog>
  /** The ids the person added for a CLI in Settings. */
  userModels: (cli: string) => readonly string[] | undefined
}

type BacklogWriteBackends = {
  updateStatus(input: BacklogStatusInput): Promise<BacklogMutationResult>
  updateType(input: BacklogTypeInput): Promise<BacklogMutationResult>
  updateTriage(input: BacklogTriageInput): Promise<BacklogMutationResult>
  updateEpic(input: BacklogEpicInput): Promise<BacklogMutationResult>
  updateDependenciesPlanned(input: BacklogDependenciesPlannedInput): Promise<BacklogMutationResult>
  addOrUpdateLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>
  repairIntegrity(input: BacklogIntegrityRepairInput): Promise<BacklogIntegrityRepairResult>
}

/** What `launchConfiguredAgent` is asked to start. */
type LaunchPlan = {
  workspaceId: string
  cli?: string
  name?: string
  prompt?: string
  cliModel?: string
  permissionPreset?: CliPermissionPreset
  connectorId?: string
  worktreeRequested: boolean
  worktreeName?: string
  worktreeBaseRef?: string
  host?: ExecutionHostId
  /** A bundled skill the prompt invokes; the launch carries it (see `launchSkills`). */
  spawnSkillId?: string
}

type LaunchWorktree = { path: string; branch: string }

/** An agent started and confirmed by its live terminal session. */
type ConfirmedLaunch = {
  workspace: Workspace
  agentId: string
  session: TerminalSessionSnapshot
  worktreePath?: string
  worktreeBranch?: string
}

type DeferredLaunchOptions = {
  /**
   * Run once the agent has started, after its install: what the caller does
   * with a confirmed launch (link it to the calling agent, record it). Answers
   * whether the caller will be told about the agent from then on.
   */
  afterStart?: (launched: ConfirmedLaunch) => LaunchLinkResult | null
}

type DeferredLaunchRecord = {
  workspaceId: string
  agentId: string
  name: string | null
  cli: string
  worktree: LaunchWorktree
  install: StartedDependencyInstall
  /** The install has ended and the agent is being started: its terminal may be live, its start not yet confirmed. */
  starting: boolean
  /** Null while the install runs; how the start went once it has ended. */
  outcome:
    { started: true; notifyParent: LaunchLinkResult | null } | { started: false; code: string; message: string } | null
}

/** A launch answered before its agent exists: it starts when its worktree's install ends. */
type DeferredLaunch = { deferred: true; workspace: Workspace; agentId: string; record: DeferredLaunchRecord }

export function createAutomationTools(backends: AutomationBackends): McpToolRegistration[] {
  const now = backends.now ?? Date.now
  const sleep = backends.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function waitFor<T>(timeoutMs: number, probe: () => T | null): Promise<T | null> {
    const deadline = now() + timeoutMs
    for (;;) {
      const found = probe()
      if (found !== null) return found
      if (now() >= deadline) return null
      await sleep(CONFIRM_POLL_INTERVAL_MS)
    }
  }

  function findWorkspace(workspaceId: string): Workspace | null {
    return (
      backends.getWorkspaceSyncSnapshot().state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
    )
  }

  // Backlog and Automations services speak absolute workspace roots; tools
  // speak workspace ids. Resolution goes through main's registry, so a tool can
  // only ever reach app-known folders. A restart survivor resolves like any
  // other workspace now: main persists the real record, so there is
  // no longer a half-known placeholder to refuse or to except a live terminal
  // from.
  function resolveWorkspaceRoot(workspaceId: string): { root: string } | McpToolResult {
    const workspace = findWorkspace(workspaceId)
    if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    if (!workspace.folderPath) {
      return failure(
        'workspace_without_folder',
        `Workspace "${workspaceId}" has no usable folder path in this app session; open it in the app first.`,
      )
    }
    return { root: workspace.folderPath }
  }

  // Backlog tools address a project folder, not the workspace registry: the
  // connection's advisory workspace identity resolves the folder for
  // Studio-launched agents, and callers outside the app pass an absolute
  // `projectRoot` instead. There is deliberately no open-workspace gate on the
  // folder — the socket's trust boundary is the local OS user, and
  // backlog-service validates the folder itself.
  function resolveBacklogRoot(
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ): { root: string } | McpToolResult {
    if (args.projectRoot !== undefined) {
      if (typeof args.projectRoot !== 'string' || !isAbsolute(args.projectRoot)) {
        return failure('invalid_arguments', '"projectRoot" must be an absolute path to the project folder.')
      }
      return { root: args.projectRoot }
    }
    const workspace = connectionWorkspace(context)
    if (workspace?.folderPath) return { root: workspace.folderPath }
    return failure(
      'project_root_required',
      'This connection has no resolvable workspace to default from; pass "projectRoot" (the absolute path to the project folder).',
    )
  }

  // Link a launched agent to the agent that asked for it, so the caller hears
  // back (agent-launch-notices.ts). Not linked, the caller is told why.
  function linkToCaller(
    context: McpConnectionContext | undefined,
    child: LaunchedAgentLink['child'],
  ): LaunchLinkResult {
    const parent = launchingAgentOf(context)
    if (!parent) return { linked: false, reason: NOT_TOLD_NOT_AN_AGENT }
    if (!backends.linkLaunchedAgent) return { linked: false, reason: NOT_TOLD_UNAVAILABLE }
    return backends.linkLaunchedAgent({ parent, child })
  }

  function connectionWorkspace(context: McpConnectionContext | undefined): Workspace | null {
    const workspaceId = context?.metadata.workspaceId
    return workspaceId ? findWorkspace(workspaceId) : null
  }

  // backlog.assign and backlog.work additionally need the live app workspace
  // record (the agent registry and the renderer launch delegate), so they
  // resolve to the connection's own workspace, or to the open workspace whose
  // folder matches an explicit projectRoot.
  function resolveBacklogWorkspace(
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ): { workspace: Workspace; root: string } | McpToolResult {
    if (args.projectRoot !== undefined) {
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const workspace =
        backends
          .getWorkspaceSyncSnapshot()
          .state.workspaces.find((candidate) => candidate.folderPath === resolved.root) ?? null
      if (!workspace?.folderPath) {
        return failure(
          'workspace_not_open',
          `No open workspace uses the folder "${resolved.root}"; this tool needs that project open in the app.`,
        )
      }
      return { workspace, root: workspace.folderPath }
    }
    const workspace = connectionWorkspace(context)
    if (workspace?.folderPath) return { workspace, root: workspace.folderPath }
    return failure(
      'project_root_required',
      'This connection has no resolvable workspace to default from; pass "projectRoot" (the absolute path to the project folder).',
    )
  }

  function workspaceWindowId(workspaceId: string): string | null {
    const { workspaceWindows } = backends.getWorkspaceSyncSnapshot().state
    return workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))?.id ?? null
  }

  function agentTerminalSession(
    workspaceId: string,
    agentId: string,
    cliSessionId?: string,
  ): TerminalSessionSnapshot | null {
    return (
      backends
        .listTerminalSessions()
        .find(
          (session) =>
            session.kind === 'agent' &&
            session.workspaceId === workspaceId &&
            (session.agentId === agentId || (cliSessionId !== undefined && session.sessionId === cliSessionId)),
        ) ?? null
    )
  }

  function workspaceProjection(workspace: Workspace): Record<string, unknown> {
    return {
      id: workspace.id,
      name: workspace.name,
      mode: workspace.mode,
      folderPath: workspace.folderPath,
      windowId: workspaceWindowId(workspace.id),
      detail: 'full',
      agentIds: Object.keys(workspace.agents),
      // When the chat was settled, or null while it is in the list: a paired
      // desktop browsing this machine leaves the resting ones out, as this
      // machine's own sidebar does.
      settledAt: isSettledWorkspace(workspace) ? workspace.settledAt : null,
    }
  }

  function agentProjection(workspace: Workspace, agentId: string): Record<string, unknown> {
    const agent = workspace.agents[agentId]
    const session = agentTerminalSession(workspace.id, agentId, agent?.cliSessionId)
    return {
      workspaceId: workspace.id,
      agentId,
      name: agent?.name ?? null,
      cli: agent?.cli ?? null,
      cliStartRequested: agent?.cliStartRequested ?? false,
      cliHasLaunched: agent?.cliHasLaunched ?? false,
      cliSessionId: agent?.cliSessionId ?? null,
      terminal: session
        ? {
            sessionId: session.sessionId,
            processAlive: session.processAlive,
            startedAt: session.startedAt,
            lastOutputAt: session.lastOutputAt,
            phase: session.agentState?.phase ?? null,
          }
        : null,
    }
  }

  // The `permissionPreset` argument every launching tool accepts, validated
  // once. Returns the named preset, `undefined` when the caller named none (the
  // launch service then resolves it), or the failure.
  function validatePermissionPreset(args: Record<string, unknown>): CliPermissionPreset | undefined | McpToolResult {
    if (args.permissionPreset === undefined) return undefined
    if (typeof args.permissionPreset !== 'string') {
      return failure('invalid_arguments', '"permissionPreset" must be a string when provided.')
    }
    // Parsed, not compared: an external caller written before the preset
    // rename still sends `bypass_all`, `default` or `auto_workspace`. Each
    // keeps meaning what its caller meant rather than failing on a spelling.
    const requested = parseCliPermissionPreset(args.permissionPreset)
    if (!requested) {
      return failure('invalid_arguments', `"permissionPreset" must be one of: ${LAUNCH_PERMISSION_PRESETS.join(', ')}.`)
    }
    return requested
  }

  // The validated preset held to the calling agent's own (launch-permission-cap.ts):
  // the preset to forward, `undefined` to leave it to the launch service, or
  // the failure — `permission_escalation` for a preset looser than the caller's.
  function cappedPermissionPreset(
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ): CliPermissionPreset | undefined | McpToolResult {
    const requested = validatePermissionPreset(args)
    if (requested !== undefined && typeof requested !== 'string') return requested
    const capped = capLaunchPermissionPreset(
      requested,
      launchPermissionCeiling(context, backends.resolveAgentPermissionPreset),
    )
    if ('refused' in capped) return failure(capped.refused.code, capped.refused.message)
    return capped.permissionPreset
  }

  // The launch-config fields agent.launch and backlog.work both accept:
  // `permissionPreset` (either preset, or omitted for the spawn default)
  // and `worktree` (an object with an optional name — never a bare cwd). Returns
  // the resolved options or a failure McpToolResult.
  function resolveLaunchOptions(
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ):
    | {
        permissionPreset?: CliPermissionPreset
        worktreeRequested: boolean
        worktreeName?: string
        worktreeBaseRef?: string
      }
    | McpToolResult {
    const preset = cappedPermissionPreset(args, context)
    if (preset !== undefined && typeof preset !== 'string') return preset
    let worktreeRequested = false
    let worktreeName: string | undefined
    let worktreeBaseRef: string | undefined
    if (args.worktree !== undefined) {
      if (typeof args.worktree !== 'object' || args.worktree === null || Array.isArray(args.worktree)) {
        return failure('invalid_arguments', '"worktree" must be an object with an optional "name".')
      }
      const rawName = (args.worktree as { name?: unknown }).name
      if (rawName !== undefined && typeof rawName !== 'string') {
        return failure('invalid_arguments', '"worktree.name" must be a string when provided.')
      }
      const rawBaseRef = (args.worktree as { baseRef?: unknown }).baseRef
      if (rawBaseRef !== undefined && typeof rawBaseRef !== 'string') {
        return failure('invalid_arguments', '"worktree.baseRef" must be a string when provided.')
      }
      worktreeRequested = true
      worktreeName = optionalString(rawName)
      worktreeBaseRef = optionalString(rawBaseRef)
    }
    return {
      // Forwarded as the caller sent it, absent included: the launch service
      // fills an absent preset from the person's choice for the CLI, else the
      // app default, which is the same answer the desktop launcher gives. An
      // agent's own launch arrives here already held to its cap.
      ...(preset ? { permissionPreset: preset } : {}),
      worktreeRequested,
      worktreeName,
      worktreeBaseRef,
    }
  }

  // Create the isolation worktree (when requested or forced by a connector),
  // compose and spawn the agent in main, and confirm the launch by the live
  // terminal session main itself minted — the shared execution path for
  // agent.launch and backlog.work. Returns the confirmed workspace + agent id
  // (and worktree path), or a failure McpToolResult. The caller is expected to
  // have validated args and confirmed the workspace exists.
  //
  // A caller that passes `deferred` takes a launch whose worktree is still
  // installing its dependencies as an answer of its own: the agent's id is
  // minted now, the call answers with it at once, and the agent starts when
  // the install ends (`deferredLaunch`). A gateway call cannot wait out an
  // install: its client gives up first, and a retry would be a second agent
  // in a second worktree. Without it, the launch waits for the install.
  function launchConfiguredAgent(plan: LaunchPlan): Promise<ConfirmedLaunch | McpToolResult>
  function launchConfiguredAgent(
    plan: LaunchPlan,
    deferred: DeferredLaunchOptions,
  ): Promise<ConfirmedLaunch | DeferredLaunch | McpToolResult>
  async function launchConfiguredAgent(
    plan: LaunchPlan,
    deferred?: DeferredLaunchOptions,
  ): Promise<ConfirmedLaunch | DeferredLaunch | McpToolResult> {
    // A connector launch forces a worktree even when none was requested — the
    // connector .mcp.json must never land in the user's checkout. Worktree
    // creation runs in main before delegating, and a failure here is fatal: the
    // caller asked for isolation, so we never silently fall back.
    let worktree: LaunchWorktree | null = null
    if (plan.worktreeRequested || plan.connectorId) {
      const resolved = resolveWorkspaceRoot(plan.workspaceId)
      if (!('root' in resolved)) return resolved
      const derivedName = plan.worktreeName || plan.name || plan.connectorId || `agent-${now().toString(36)}`
      const created = await backends.createAgentWorktree({
        workspaceRoot: resolved.root,
        name: derivedName,
        ...(plan.worktreeBaseRef ? { baseRef: plan.worktreeBaseRef } : {}),
      })
      if ('error' in created) {
        return failure(
          'worktree_unavailable',
          `Could not create an isolated worktree for the launch (${created.error}). The folder must be a git repository.`,
        )
      }
      worktree = { path: created.worktreePath, branch: created.branch }
      const installing = created.dependencyInstall
      if (installing) {
        // The id the launch would mint, minted here so the answer can name the
        // agent before it exists. A launch that names no CLI and has no
        // last-selected one is refused by the launch itself, at once.
        const cli = plan.cli?.trim() || backends.defaultChatCli()
        if (deferred && cli) return deferLaunch({ ...plan, cli }, worktree, installing, deferred)
        // Not deferred: the agent starts after the install, as a window's does,
        // and not at all once the app is quitting.
        if ((await installing.settled) === null) {
          return failure('app_quitting', 'The app quit before the agent started.')
        }
      }
    }
    return startConfiguredAgent(plan, worktree)
  }

  // Spawn the agent in main and confirm it by its live terminal session.
  async function startConfiguredAgent(
    plan: LaunchPlan & { agentId?: string },
    worktree: LaunchWorktree | null,
  ): Promise<ConfirmedLaunch | McpToolResult> {
    // Composed and spawned in main. Previously this delegated to the
    // primary window, which is why `agent.launch` and `backlog.work` failed
    // outright with no window open — the composition lived in a React hook, not
    // because anything about the launch needed a UI.
    const launched = await backends.launchAgent({
      workspaceId: plan.workspaceId,
      cli: plan.cli,
      name: plan.name,
      prompt: plan.prompt,
      cliModel: plan.cliModel,
      permissionPreset: plan.permissionPreset,
      connectorId: plan.connectorId,
      worktreePath: worktree?.path,
      ...(plan.agentId ? { agentId: plan.agentId } : {}),
      ...(plan.host ? { host: plan.host } : {}),
      ...(plan.spawnSkillId ? { spawnSkillId: plan.spawnSkillId } : {}),
    })
    if (!launched.ok) return failure(launched.code, launched.message)
    const { agentId, sessionId } = launched
    // Confirmation is still a LIVE terminal session, not the launch call
    // returning — a spawn can report success and the CLI can die immediately.
    // It now watches the session main actually minted rather than waiting for a
    // renderer to write an agent record, so it confirms identically with or
    // without a window (the 20s window is unchanged).
    const live = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => {
      const session = backends.listTerminalSessions().find((candidate) => candidate.sessionId === sessionId)
      return session?.processAlive ? session : null
    })
    if (!live) {
      return failure(
        'launch_confirmation_timeout',
        `Agent "${agentId}" was launched in workspace "${plan.workspaceId}" but no live terminal session registered within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms; treat the launch as unverified. Read agent.status for the current state.`,
      )
    }
    // The workspace record is only the shape callers project; main has held it
    // since before the launch (the service resolved the launch against this same
    // snapshot), so it is read once here rather than polled — waiting on it
    // would report a launch timeout for something that is not a launch problem.
    const workspace = findWorkspace(plan.workspaceId)
    if (!workspace) {
      return failure('unknown_workspace', `Workspace "${plan.workspaceId}" is not known to the running app.`)
    }
    // `live` is the session the launch actually minted, carried out so a caller
    // that needs the session id (terminal.create answers with it) reads the
    // confirmed one rather than re-searching for it.
    return {
      workspace,
      agentId,
      session: live,
      ...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
    }
  }

  // Launches waiting on their worktree's dependency install, and the ones
  // that waited, by workspace and agent: what `agent.status` reports for an
  // agent that does not exist yet, and how its install ended once it does.
  const deferredLaunches = new Map<string, DeferredLaunchRecord>()
  const deferredKey = (workspaceId: string, agentId: string) => `${workspaceId}\0${agentId}`

  function deferLaunch(
    plan: LaunchPlan & { cli: string },
    worktree: LaunchWorktree,
    installing: StartedDependencyInstall,
    options: DeferredLaunchOptions,
  ): DeferredLaunch | McpToolResult {
    const workspace = findWorkspace(plan.workspaceId)
    if (!workspace) {
      return failure('unknown_workspace', `Workspace "${plan.workspaceId}" is not known to the running app.`)
    }
    const agentId = `agent-${plan.cli}-${newAgentIdSuffix()}`
    const record: DeferredLaunchRecord = {
      workspaceId: plan.workspaceId,
      agentId,
      name: plan.name?.trim() || null,
      cli: plan.cli,
      worktree,
      install: installing,
      starting: false,
      outcome: null,
    }
    deferredLaunches.set(deferredKey(plan.workspaceId, agentId), record)
    while (deferredLaunches.size > DEFERRED_LAUNCHES_KEPT)
      deferredLaunches.delete(deferredLaunches.keys().next().value!)
    void (async () => {
      const ended = await installing.settled.catch(() => installing.current())
      // The app is quitting: nothing starts on the way out.
      if (!ended) {
        record.outcome = { started: false, code: 'app_quitting', message: 'The app quit before the agent started.' }
        return
      }
      record.starting = true
      const launched = await startConfiguredAgent({ ...plan, agentId }, worktree).catch((error: unknown) =>
        failure('launch_failed', error instanceof Error ? error.message : String(error)),
      )
      if ('content' in launched) {
        const error = (launched.structuredContent as { error?: { code?: string; message?: string } } | undefined)?.error
        record.outcome = {
          started: false,
          code: error?.code ?? 'launch_failed',
          message: error?.message ?? 'The agent could not be started.',
        }
        return
      }
      let linked: LaunchLinkResult | null = null
      try {
        linked = options.afterStart?.(launched) ?? null
      } catch {
        linked = null
      }
      record.outcome = { started: true, notifyParent: linked }
    })()
    return { deferred: true, workspace, agentId, record }
  }

  // An agent waiting on its worktree's dependency install, as `agent.status`
  // and the launch's answer describe it: the agent's fields as they will be,
  // nothing running yet, and the install.
  function deferredAgentProjection(record: DeferredLaunchRecord): Record<string, unknown> {
    return {
      workspaceId: record.workspaceId,
      agentId: record.agentId,
      name: record.name,
      cli: record.cli,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliSessionId: null,
      terminal: null,
      ...deferredLaunchFields(record),
    }
  }

  function deferredLaunchFields(record: DeferredLaunchRecord): Record<string, unknown> {
    const install = record.install.current()
    const outcome = record.outcome
    return {
      // Present only until the agent has started: what it waits on, or why it
      // will not start.
      ...(outcome?.started
        ? {}
        : { state: outcome ? 'launch_failed' : record.starting ? 'starting' : 'installing_dependencies' }),
      ...(outcome && !outcome.started ? { launchError: { code: outcome.code, message: outcome.message } } : {}),
      worktreePath: record.worktree.path,
      worktreeBranch: record.worktree.branch,
      dependencyInstall: installProjection(install),
    }
  }

  const workspaceList: McpToolRegistration = {
    name: 'workspace.list',
    description:
      'List the workspaces visible to the user in the running SprintEngine instance, with window assignment and agent ids. ' +
      'Workspaces that survived a restart are listed like any other: main owns the registry, so their name, ' +
      'folder, mode, and agents are real whether or not a window is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { state } = backends.getWorkspaceSyncSnapshot()
      const usage = backends.projectUsage?.() ?? null
      const listedAt = now()
      // The repository each folder is a clone of rides the listing
      // (one-project-across-machines): it is how a paired Studio recognises
      // its own project on this machine. Read per folder, cached in main.
      const workspaces = await Promise.all(
        state.workspaces.map(async (workspace) => {
          const repository = workspace.folderPath ? await backends.readRepositoryIdentity(workspace.folderPath) : null
          const colorKey = projectColorKey({ folderPath: workspace.folderPath ?? null, repository })
          return {
            ...workspaceProjection(workspace),
            repository,
            // The project's hue, as `terminal.list` sends it: derived here so a
            // phone paints the degree the sidebar does; null for no folder.
            projectHue: colorKey ? projectHue(colorKey) : null,
            ...(usage ? projectUseFields(workspace, usage, listedAt) : {}),
          }
        }),
      )
      return success({
        workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        primaryWindowId: state.primaryWorkspaceWindowId,
      })
    },
  }

  // ── Mobile companion over the gateway ────────────────────────────────────
  // The phone's snapshot and command lane, and its only one: the companion
  // pairs over the tailnet and reaches the desktop through these two tools. The
  // command allowlist is deliberately narrow; widening it is a decision, not a
  // default.
  const MOBILE_GATEWAY_COMMAND_TYPES = ['backlog.update'] as const

  const workspaceSnapshot: McpToolRegistration = {
    name: 'workspace.snapshot',
    description:
      'The mobile companion snapshot: backlog and the dev servers published on the tailnet as one ' +
      'versioned document, in path-token form (ws_ tokens round-trip; local paths never leave ' +
      'the desktop). Pass knownSnapshotVersion from the previous read to get an {unchanged: true} marker ' +
      'instead of the full document when nothing moved.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: [...mobileSnapshotCollections, ...retiredMobileSnapshotCollections] },
          description:
            `Collections to include (${mobileSnapshotCollections.join(', ')}). Defaults to all of them. ` +
            `${retiredMobileSnapshotCollections.join(', ')} is retired: accepted, and answered with nothing.`,
        },
        knownSnapshotVersion: { type: 'string', description: 'The snapshotVersion returned by the previous read.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalidArray = firstInvalidStringArray(args, ['include'])
      if (invalidArray) return invalidArray
      // Checked here rather than left to the bridge, which drops unknown names:
      // a caller that misspells a collection would otherwise get no hint that
      // its scope was ignored. A retired name is not a misspelling — phones
      // built before automations left the wire still ask for them on every
      // read — so it is accepted and serves nothing.
      const collections: readonly string[] = [...mobileSnapshotCollections, ...retiredMobileSnapshotCollections]
      const unknownCollection = optionalStringArray(args.include)?.find((entry) => !collections.includes(entry))
      if (unknownCollection !== undefined) {
        return failure(
          'invalid_arguments',
          `"include" names "${unknownCollection}", which is not a snapshot collection. ` +
            `Collections: ${mobileSnapshotCollections.join(', ')}.`,
        )
      }
      const invalidString = firstInvalidOptionalString(args, ['knownSnapshotVersion'])
      if (invalidString) return invalidString
      const result = await backends.mobileControl.readSnapshot({
        include: optionalStringArray(args.include),
        knownSnapshotVersion: optionalString(args.knownSnapshotVersion),
      })
      return success(result)
    },
  }

  const workspaceMobileCommand: McpToolRegistration = {
    name: 'workspace.mobile_command',
    description:
      'Dispatch one mobile-control command envelope from a paired companion device. ' +
      `Served types: ${MOBILE_GATEWAY_COMMAND_TYPES.join(', ')}. ` +
      'The device identity comes from the transport, never from the arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `One of: ${MOBILE_GATEWAY_COMMAND_TYPES.join(', ')}.` },
        payload: {
          type: 'object',
          description: 'The command payload, exactly as the mobile-control protocol defines it.',
        },
        idempotencyKey: { type: 'string', description: 'Client-chosen key; replays return the recorded result.' },
        expectedSnapshotVersion: { type: 'string' },
      },
      required: ['type', 'payload', 'idempotencyKey'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const type = requireString(args, 'type')
      if (typeof type !== 'string') return type
      const idempotencyKey = requireString(args, 'idempotencyKey')
      if (typeof idempotencyKey !== 'string') return idempotencyKey
      const invalidString = firstInvalidOptionalString(args, ['expectedSnapshotVersion'])
      if (invalidString) return invalidString
      if (!(MOBILE_GATEWAY_COMMAND_TYPES as readonly string[]).includes(type)) {
        return failure(
          'command_not_supported',
          `Mobile command "${type}" is not served over the gateway (served: ${MOBILE_GATEWAY_COMMAND_TYPES.join(', ')}).`,
        )
      }
      const payload = args.payload
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return failure('invalid_arguments', '"payload" must be an object.')
      }
      // The transport proved which paired device is calling (remote-tailnet
      // metadata is set server-side); a local-socket caller is the owner's own
      // machine and is labelled as such rather than trusted to name a device.
      const metadata = context?.metadata
      const deviceId =
        metadata?.kind === 'remote-tailnet' && metadata.deviceId
          ? metadata.deviceId
          : `local:${metadata?.kind ?? 'unknown'}`
      const result = await backends.mobileControl.dispatchCommand({
        type,
        payload: payload as Record<string, unknown>,
        deviceId,
        idempotencyKey,
        expectedSnapshotVersion: optionalString(args.expectedSnapshotVersion),
      })
      if (!result.ok) return failure(result.code, result.message)
      return success({
        ok: true,
        commandId: result.commandId,
        commandType: result.commandType,
        executedAt: result.executedAt,
        data: (result.data ?? null) as Record<string, unknown> | null,
      })
    },
  }

  const workspaceStatus: McpToolRegistration = {
    name: 'workspace.status',
    description: 'Read one workspace from the main process store, including its agents and their terminal liveness.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list or workspace.create.' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const workspace = findWorkspace(workspaceId)
      if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      return success({
        workspace: workspaceProjection(workspace),
        agents: Object.keys(workspace.agents).map((agentId) => agentProjection(workspace, agentId)),
      })
    },
  }

  const workspaceCreate: McpToolRegistration = {
    name: 'workspace.create',
    description:
      'Create a workspace in the running SprintEngine instance. The main process owns the registry, so this ' +
      'succeeds with no window open and the returned workspace is immediately addressable by every other tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace display name.' },
        folderPath: { type: 'string', description: 'Absolute folder to open in the workspace.' },
        templateId: { type: 'string', description: 'Layout template id; defaults to the standard template.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['name', 'folderPath', 'templateId'])
      if (invalid) return invalid
      // Synchronous authority: the id comes back from the same call that
      // committed it, which is what retired the delegate-to-renderer round trip
      // and its 7s bus-confirmation poll.
      const outcome = backends.createWorkspace(
        {
          name: optionalString(args.name),
          folderPath: optionalString(args.folderPath),
          templateId: optionalString(args.templateId),
        },
        'gateway',
      )
      if (!outcome.ok) return failure(outcome.reason, outcome.message)
      return success({ workspace: workspaceProjection(outcome.result.workspace) })
    },
  }

  const agentLaunch: McpToolRegistration = {
    name: 'agent.launch',
    description:
      'Add a fully-configured agent to a workspace and start its CLI through the same renderer flow the UI uses. ' +
      'Optionally selects the model, permission preset and connector, and isolates the agent in a ' +
      'git worktree. Success is confirmed by the agent terminal session registering with the main process. ' +
      'Called by an agent of this app, the caller is told when the launched agent finishes a turn, fails or ' +
      'stops: a short notice from Studio arrives as a new message once the caller is idle (never in the ' +
      'middle of its turn), so there is no need to poll agent.status. That the agent waits on the person for ' +
      'an approval or an answer rides along with the next notice. The result\'s "notifyParent" says whether ' +
      'the caller will be told, and "notifyParentReason" why not. A worktree whose project installs its ' +
      "dependencies first (an opt-in in this machine's Settings) answers while the install runs: the agent " +
      'comes back with state "installing_dependencies" and its "dependencyInstall", and starts when the ' +
      'install ends, however it ends; agent.status reports where it is.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Target workspace id.' },
        cli: {
          type: 'string',
          description:
            'Agent CLI plugin id; defaults to the last selected CLI. cli.runtime.list enumerates the ids this ' +
            'app actually holds — do not guess one.',
        },
        name: { type: 'string', description: 'Agent display name.' },
        prompt: { type: 'string', description: 'Startup prompt sent to the CLI after launch.' },
        host: {
          type: 'string',
          description:
            'The machine on this computer to run on: "local", or "wsl:<distribution>" for a WSL distribution on ' +
            "Windows. Defaults to the workspace's machine, then the distribution its folder lives in, then local. " +
            'Only Windows has machines other than "local".',
        },
        cliModel: {
          type: 'string',
          description:
            'Model id for CLIs that support model selection; forwarded verbatim (the app does not validate it ' +
            "against the CLI). cli.runtime.list reports each CLI's declared model ids and whether it accepts " +
            'ids outside that list.',
        },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'CLI permission preset: "bypass" launches the CLI with its own skip-every-prompt flag; "auto" runs ' +
            "the CLI's own auto mode (a classifier or reviewer that runs what it judges safe, where the CLI has " +
            'one, else edits in the workspace go through and commands ask); "manual" asks before every edit, ' +
            'command and outside call; "none" passes no permission flag, so the CLI\'s own configuration ' +
            'decides. A terminal agent takes only the presets its CLI has a setting for (cli.runtime.list names ' +
            'them, with the name each mode has in that CLI). Omitted, the launch takes the preset chosen for ' +
            'that CLI on this machine, else the app default "auto" ("none" for a CLI with no auto mode), ' +
            'exactly as the desktop launcher would. The older "bypass_all" is read as "bypass". ' +
            CALLER_PRESET_CAP_SENTENCE,
        },
        connectorId: {
          type: 'string',
          description:
            "Connector id from the installed connectors. Attaches the connector's single-server MCP and forces " +
            'worktree isolation (the connector .mcp.json never lands in the checkout), even without "worktree".',
        },
        worktree: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Worktree/branch name; defaults to the agent name.' },
            baseRef: {
              type: 'string',
              description:
                'The ref the new worktree branches from (a branch name from workspace.checkout, e.g. "main"). ' +
                'Leave it out: the worktree then branches from the default branch on origin, freshly fetched, ' +
                'which is where every chat starts.',
            },
          },
          additionalProperties: false,
          description:
            'Isolate the agent in a git worktree on a "<prefix>/<name>" branch (the branch prefix set in Settings ▸ ' +
            'Worktrees, "agent" unless changed) instead of the workspace checkout.',
        },
        notifyParent: {
          type: 'boolean',
          description:
            'Tell the calling agent when the launched agent finishes a turn, fails or stops, with a short ' +
            'notice that arrives as a new message once the caller is idle. Defaults to true. ' +
            'Pass false to hear nothing and read agent.status instead.',
        },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'prompt', 'cliModel', 'connectorId', 'host'])
      if (invalid) return invalid
      if (args.notifyParent !== undefined && typeof args.notifyParent !== 'boolean') {
        return failure('invalid_arguments', '"notifyParent" must be a boolean when provided.')
      }

      const options = resolveLaunchOptions(args, context)
      if ('content' in options) return options

      const host = args.host === undefined ? undefined : normalizeExecutionHostId(args.host)
      if (host === null) {
        return failure('invalid_arguments', '"host" must be "local" or "wsl:<distribution>".')
      }

      if (!findWorkspace(workspaceId)) {
        return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      }

      const link = (started: ConfirmedLaunch): LaunchLinkResult | null =>
        args.notifyParent === false
          ? null
          : linkToCaller(context, {
              workspaceId: started.workspace.id,
              agentId: started.agentId,
              sessionId: started.session.sessionId,
              transport: 'terminal',
              ...(started.session.agentName ? { name: started.session.agentName } : {}),
            })
      const launched = await launchConfiguredAgent(
        {
          ...(host ? { host } : {}),
          workspaceId,
          cli: optionalString(args.cli),
          name: optionalString(args.name),
          prompt: optionalString(args.prompt),
          cliModel: optionalString(args.cliModel),
          permissionPreset: options.permissionPreset,
          connectorId: optionalString(args.connectorId),
          worktreeRequested: options.worktreeRequested,
          worktreeName: options.worktreeName,
          worktreeBaseRef: options.worktreeBaseRef,
        },
        { afterStart: link },
      )
      if (!('agentId' in launched)) return launched
      if ('deferred' in launched) {
        // Answered now, the agent to come: the caller is linked to it when it
        // starts, if it can be, and until then reads agent.status.
        return success({
          agent: deferredAgentProjection(launched.record),
          worktreePath: launched.record.worktree.path,
          worktreeBranch: launched.record.worktree.branch,
          notifyParent: false,
          notifyParentReason: args.notifyParent === false ? 'Not asked for.' : DEFERRED_NOTIFY_REASON,
        })
      }
      const linked = link(launched)
      return success({
        agent: agentProjection(launched.workspace, launched.agentId),
        ...(launched.worktreePath ? { worktreePath: launched.worktreePath } : {}),
        ...(launched.worktreeBranch ? { worktreeBranch: launched.worktreeBranch } : {}),
        notifyParent: linked?.linked === true,
        ...(linked && !linked.linked ? { notifyParentReason: linked.reason } : {}),
      })
    },
  }

  // The checkout facts behind a remote launch's checkout · branch segments
  // (checkout-and-branch-on-remote-create). A read, on `workspace:read`, so a
  // paired Studio can show where a chat would run before asking for it; the
  // worktree itself is minted by `agent.launch` (workspace:operate), never
  // here — scopes stay a function of the tool's NAME (tailnet-scopes.ts).
  const workspaceCheckout: McpToolRegistration = {
    name: 'workspace.checkout',
    description:
      "Read a workspace's git checkout: whether its folder is a repository, the branch it is on, the trunk, " +
      "every local branch, and the worktrees the repository holds. Pair it with agent.launch's " +
      '"worktree.baseRef" to start an agent on a fresh worktree branched from one of the listed branches.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const checkout = await backends.readWorkspaceCheckout(resolved.root)
      return success({ workspaceId, ...checkout })
    },
  }

  // What a paired machine's composer offers a chat here: the project's skills
  // (installed, and the built-ins a pick installs) and the MCP servers the
  // chat's CLI is configured with, each with the connection it last reported.
  // A read, on `workspace:read` like `workspace.checkout`; attaching one is
  // `conversation.create`'s `skills`, under its own grant.
  const workspaceExtensions: McpToolRegistration = {
    name: 'workspace.extensions',
    description:
      "List what a chat in a workspace's folder can use: `skills` (id, name, description, whether it is " +
      'installed there or a built-in a chat installs on first use, and the GitHub repository it came from when ' +
      'a skill source installed it) and, with `cli`, `servers`: the MCP servers that CLI is configured with, ' +
      'each with its `status` (connected, pending, needs-auth, failed, disabled) once a chat on it here has ' +
      "reported one. Pass the skill ids to conversation.create's `skills`.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        cli: { type: 'string', description: 'The agent CLI plugin id whose MCP servers to list.' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const invalid = firstInvalidOptionalString(args, ['cli'])
      if (invalid) return invalid
      if (!backends.readWorkspaceExtensions)
        return failure('unavailable', 'This machine does not list its skills and MCP servers.')
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const extensions = await backends.readWorkspaceExtensions(resolved.root, optionalString(args.cli) ?? null)
      return success({ workspaceId, ...extensions })
    },
  }

  // The answer to "what may I pass as a cli / model / effort?".
  // Before this, `agent.launch.cliModel` was a blind string an agent could only
  // guess at from a tool description's example. Reports the CLI plugin registry as the app itself resolves it —
  // declared, not probed: it says what the registry HOLDS, never whether the
  // binary is installed on this machine (that probe spawns a login shell per
  // CLI and belongs to the app's own availability refresh).
  const cliRuntimeList: McpToolRegistration = {
    name: 'cli.runtime.list',
    description:
      'List the agent CLIs this app can launch, with the model ids and reasoning-effort levels each one ' +
      'declares. Read it before passing `cli`/`cliModel` to agent.launch — those are otherwise blind strings. Only rows with `agentSelectable: ' +
      'true` may be launched as agents (the CLI reports agent state via lifecycle hooks); ' +
      'a false row is registry-held for install/detect only and every launch door refuses it. A CLI whose ' +
      '`allowCustomModelId` is true accepts model ids outside its listed options (the list is a seed, not a ' +
      'closed set); a level outside `reasoningLevels` is refused by the CLI itself. This reports what the ' +
      'registry HOLDS, not what is installed on this machine — it never probes for binaries. ' +
      'Each row may carry a `catalog`: what the model picker here offers for that CLI, read the way it reads ' +
      "it — `models` is the CLI's own reported list (its manifest seed until it has reported) followed by " +
      "the ids added in Settings, each marked with the `family` row it renders under (a model's context " +
      'windows are one row; `contextLabel` names the window, `familyDefault` the id the row selects), and ' +
      '`isNew` where the picker shows New; `providerLabel` is the line under each row, naming the CLI a ' +
      'hosted runtime rides (`hostedVia`); `conversational` says whether conversation.create can start it as ' +
      "a chat. The CLI's own default model is not a row of `models`: omit `cliModel` for it.",
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Report only this CLI plugin id. Unknown ids fail rather than returning an empty list.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['cli'])
      if (invalid) return invalid
      const wanted = optionalString(args.cli)
      const plugins = backends.listPlugins()
      if (wanted && !plugins.some((plugin) => plugin.manifest.id === wanted)) {
        return failure(
          'unknown_cli',
          `No agent CLI "${wanted}" is registered in this app. Call cli.runtime.list with no arguments for the ids it holds.`,
        )
      }
      // Read once for every row, and never fatal: a cache that cannot be read
      // leaves the rows as they were before they carried a catalog.
      const sources = backends.readCliModelSources ? await backends.readCliModelSources().catch(() => null) : null
      const now = (backends.now ?? Date.now)()
      const clis = plugins
        .filter((plugin) => !wanted || plugin.manifest.id === wanted)
        .map((plugin) => ({
          ...cliRuntimeProjection(plugin),
          ...(sources ? { catalog: cliRuntimeCatalog(plugin, sources, now) } : {}),
        }))
      return success({ clis })
    },
  }

  const agentStatus: McpToolRegistration = {
    name: 'agent.status',
    description:
      "Read one agent's launch state from the main process store plus its terminal session from the terminal " +
      'runtime: whether its process is live, and its phase (starting, thinking, tool_use, idle, awaiting_input, ' +
      'stalled, exited, failed) when its CLI reports one. An agent launched with agent.launch tells its caller ' +
      'when it finishes, fails, stops or waits for input, so read this when a notice says to, not in a loop. ' +
      'An agent waiting on its worktree\'s dependency install has state "installing_dependencies", then "starting" ' +
      'while it is started after it (or "launch_failed", with "launchError", when it could not start), and an ' +
      'agent started after one keeps "dependencyInstall", saying how the install ended.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id.' },
        agentId: { type: 'string', description: 'Agent id within the workspace.' },
      },
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const agentId = requireString(args, 'agentId')
      if (typeof agentId !== 'string') return agentId
      const workspace = findWorkspace(workspaceId)
      if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      // An agent is reportable if the bus knows it OR a terminal session exists
      // for it (sessions can register before the launch-state event lands),
      // or it is waiting on its worktree's dependency install to start.
      const deferred = deferredLaunches.get(deferredKey(workspaceId, agentId))
      if (!workspace.agents[agentId] && !agentTerminalSession(workspaceId, agentId)) {
        if (deferred) return success({ agent: deferredAgentProjection(deferred) })
        return failure('unknown_agent', `Agent "${agentId}" is not known in workspace "${workspaceId}".`)
      }
      // Started after an install: how the install ended stays on the answer,
      // so a caller learns that the agent runs without its dependencies.
      return success({
        agent: { ...agentProjection(workspace, agentId), ...(deferred ? deferredLaunchFields(deferred) : {}) },
        ...(deferred?.outcome?.started && deferred.outcome.notifyParent
          ? { notifyParent: deferred.outcome.notifyParent.linked }
          : {}),
      })
    },
  }

  // The terminals this app holds, for an agent or MCP client on this machine.
  // Served on the local socket only (`localOnlyGatewayToolReason`): terminals
  // do not cross the tailnet, so a paired device neither sees nor may call it.
  const terminalList: McpToolRegistration = {
    name: 'terminal.list',
    description:
      'List the terminal sessions open in this app: session id, agent name, CLI, working directory, ' +
      'workspace, whether the process is live or the session is paused, and the agent phase when the CLI ' +
      'reports one. Reads the terminal runtime; never writes. Served on this machine only, never to a ' +
      'paired device.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Report only sessions in this workspace.' },
        kind: {
          type: 'string',
          enum: ['agent', 'terminal'],
          description: 'Report only agent sessions, or only plain shells. Omit for both.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['workspaceId', 'kind'])
      if (invalid) return invalid
      const kind = optionalString(args.kind)
      if (kind !== undefined && kind !== 'agent' && kind !== 'terminal') {
        return failure('invalid_kind', 'The "kind" filter accepts "agent" or "terminal".')
      }
      const workspaceId = optionalString(args.workspaceId)
      // The name lookup reads the sync snapshot ONCE for the whole answer. It
      // used to go through `findWorkspace` per session, and each of those took
      // a fresh snapshot — a whole-registry clone per row, which was the
      // main-thread stall of 2026-09-05.
      const workspaceRows = new Map(
        backends.getWorkspaceSyncSnapshot().state.workspaces.map((workspace) => [workspace.id, workspace]),
      )
      // The project hue, resolved once per DISTINCT workspace rather than per
      // row: `readRepositoryIdentity` holds its answers behind a timed cache
      // and de-duplicates in flight, but a dozen rows in one project would
      // still be a dozen awaits.
      const projectHues = new Map<string, number | null>()
      const projectHueFor = async (
        workspace: { id: string; folderPath?: string | null } | undefined,
      ): Promise<number | null> => {
        if (!workspace) return null
        const cached = projectHues.get(workspace.id)
        if (cached !== undefined) return cached
        const folderPath = workspace.folderPath ?? null
        const repository = folderPath ? await backends.readRepositoryIdentity(folderPath) : null
        const key = projectColorKey({ folderPath, repository })
        const hue = key ? projectHue(key) : null
        projectHues.set(workspace.id, hue)
        return hue
      }
      const sessions = await Promise.all(
        backends
          .listTerminalSessions()
          .filter((session) => !workspaceId || session.workspaceId === workspaceId)
          .filter((session) => !kind || session.kind === kind)
          .map(async (session) => ({
            ...terminalSessionProjection(session),
            // The same second line the sidebar draws: the workspace's display
            // name, and the checkout's branch and diff read through the
            // sidebar's own summary share (one read per checkout per hold
            // window, at most four reads in flight). Both are null when
            // unknown, so a caller never guesses.
            workspaceName: (session.workspaceId ? workspaceRows.get(session.workspaceId)?.name : null) ?? null,
            git: await terminalGitSummary(session),
            // The project's hue as a whole degree on the OKLCH wheel, hashed
            // from the repository key (or the folder's name when there is no
            // remote) by shared/project-hue.ts. Sent rather than left to the
            // caller to derive so it cannot disagree with the sidebar about a
            // degree; null when the chat has no folder, which is not a project
            // and wears no colour.
            projectHue: await projectHueFor(session.workspaceId ? workspaceRows.get(session.workspaceId) : undefined),
            // When the chat is asleep until, or null, for the same reason the
            // sidebar shows it: a snoozed chat that still claims to be running
            // is the bug the desktop fixed on 2026-09-10.
            snoozedUntil: (session.workspaceId ? workspaceRows.get(session.workspaceId)?.snoozedUntil : null) || null,
          })),
      )
      return success({ terminals: sessions })
    },
  }

  // What a terminal printed, for an agent following a dev server's errors, a
  // watcher's rebuilds or a test run's failures in a terminal it did not start.
  // It reads only a session `terminal.list` lists: the id is looked up in that
  // same list, never in the runtime directly, so the two tools cannot disagree
  // about which terminals a caller may see. Like the rest of the family it is
  // served on the local socket only (`localOnlyGatewayToolReason`), and it is a
  // read — not audited as a mutation, and on `workspace:read` were it ever
  // offered to a paired device.
  const terminalRead: McpToolRegistration = {
    name: 'terminal.read',
    description:
      'Read the recent output of a terminal session in this app as plain text, escapes stripped: the newest ' +
      `"lines" lines (default ${TERMINAL_READ_DEFAULT_LINES}, at most ${TERMINAL_READ_MAX_LINES}) and at most ` +
      `${TERMINAL_READ_MAX_CHARS} characters, with "truncated" true when older output was left out. Every answer ` +
      'carries a "cursor"; pass it back as "since" to read only what the terminal printed after that read, which ' +
      'is how to follow a dev server or a test run without reading its log again. A cursor from before the ' +
      'session was resumed or respawned reads the newest output instead, with "truncated" true. A paused or ' +
      'exited session ' +
      'still reads the output it left, and "state" and "exitCode" say how it ended. A full-screen program (an ' +
      'agent CLI, an editor) reads as the stream that drew it, so its redraws can repeat lines. Session ids come from ' +
      'terminal.list or terminal.create. Reads the terminal runtime; never types into the terminal. Served on ' +
      'this machine only, never to a paired device.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Terminal session id, from terminal.list or terminal.create.' },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: TERMINAL_READ_MAX_LINES,
          description: `How many of the newest lines to return; default ${TERMINAL_READ_DEFAULT_LINES}.`,
        },
        since: {
          type: 'string',
          description:
            'The "cursor" an earlier terminal.read of this session answered with, passed back as it was: only ' +
            'output printed after it is read. Omit for the newest output.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sessionId = requireString(args, 'sessionId')
      if (typeof sessionId !== 'string') return sessionId
      const lines = optionalBoundedInteger(args, 'lines', 1, TERMINAL_READ_MAX_LINES)
      if (typeof lines === 'object') return lines
      // Opaque: the tail reader parses it and reads one this session's stream
      // did not hand out as no cursor, so only its type is checked here.
      const since = args.since
      if (since !== undefined && (typeof since !== 'string' || since.length === 0)) {
        return failure('invalid_arguments', '"since" must be a cursor an earlier terminal.read answered with.')
      }
      if (!backends.readTerminalOutputTail) {
        return failure('unavailable', 'This machine does not serve terminal output.')
      }
      const session = backends.listTerminalSessions().find((candidate) => candidate.sessionId === sessionId)
      if (!session) {
        return failure(
          'unknown_terminal',
          `No terminal session "${sessionId}" is open in this app; a closed terminal's output is not kept. ` +
            'Call terminal.list for the sessions it holds.',
        )
      }
      const read = backends.readTerminalOutputTail(sessionId, {
        maxBytes: TERMINAL_READ_RAW_BYTES,
        ...(since !== undefined ? { since } : {}),
      })
      // Listed a moment ago and gone now: closed between the two reads.
      if (!read) {
        return failure('unknown_terminal', `Terminal session "${sessionId}" closed before its output could be read.`)
      }
      const plain = terminalPlainText(read.text, {
        maxLines: lines ?? TERMINAL_READ_DEFAULT_LINES,
        maxChars: TERMINAL_READ_MAX_CHARS,
      })
      const ended = session.activity.kind === 'exited' || session.activity.kind === 'failed' ? session.activity : null
      return success({
        sessionId,
        kind: session.kind,
        workspaceId: session.workspaceId ?? null,
        agentName: session.agentName ?? null,
        // One word for what the process is doing, so a caller polling a dev
        // server learns it died from the same answer that carries its last
        // words. Paused is not ended: a parked agent resumes where it was.
        state: session.processAlive ? 'running' : session.suspended ? 'paused' : (ended?.kind ?? 'exited'),
        exitCode: ended ? ended.exitCode : null,
        text: plain.text,
        lineCount: plain.lineCount,
        truncated: read.truncated || plain.truncated,
        cursor: read.cursor,
      })
    },
  }

  /**
   * The workspace a `terminal.create` names, by id or by display name.
   *
   * A name is accepted because it is how the person names a workspace when
   * they ask an agent to open one, and it saves the caller a `workspace.list`
   * round trip. A name matching more than one workspace is an explicit refusal
   * listing the ids — picking the first would open a terminal in someone
   * else's project.
   */
  function resolveTerminalWorkspace(args: Record<string, unknown>): { workspace: Workspace } | McpToolResult {
    const workspaceId = optionalString(args.workspaceId)?.trim()
    const workspaceName = optionalString(args.workspaceName)?.trim()
    if (workspaceId && workspaceName) {
      return failure('invalid_arguments', 'Name the workspace once: pass "workspaceId" or "workspaceName", not both.')
    }
    if (workspaceId) {
      const workspace = findWorkspace(workspaceId)
      return workspace
        ? { workspace }
        : failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    }
    if (!workspaceName) {
      return failure(
        'invalid_arguments',
        'Name the workspace to open the terminal in: pass "workspaceId" or "workspaceName".',
      )
    }
    const wanted = workspaceName.toLowerCase()
    const matches = backends
      .getWorkspaceSyncSnapshot()
      .state.workspaces.filter((candidate) => candidate.name.trim().toLowerCase() === wanted)
    if (matches.length === 0) {
      return failure('unknown_workspace', `No workspace named "${workspaceName}" is open in the running app.`)
    }
    if (matches.length > 1) {
      return failure(
        'ambiguous_workspace_name',
        `${matches.length} workspaces are named "${workspaceName}". Name one by id instead: ${matches
          .map((candidate) => candidate.id)
          .join(', ')}.`,
      )
    }
    return { workspace: matches[0] }
  }

  // Open an agent terminal on this machine: `agent.launch`'s plain case, for a
  // caller that wants a terminal agent in a workspace and nothing else. It
  // deliberately does NOT carry `agent.launch`'s connector or worktree options:
  // those create git worktrees and write connector config into the checkout,
  // and a caller that needs them has `agent.launch`. Served on the local socket
  // only (`localOnlyGatewayToolReason`), like `agent.launch`.
  //
  // The session id comes back so the caller can follow the session it just
  // opened — searching terminal.list for "the one that just appeared" would be
  // a guess.
  const terminalCreate: McpToolRegistration = {
    name: 'terminal.create',
    description:
      'Open a new agent terminal on the machine running this app and return its session id. ' +
      'Works with no window open: the session exists in the main process, and a window opened later shows it as ' +
      'a pane with its scrollback intact. Name the workspace by "workspaceId" or by "workspaceName". The ' +
      "CLI and permission preset default to this machine's own launch settings unless you name them, exactly " +
      'as a launch from the desktop would, and the answer reports the preset the launch resolved. Use ' +
      'cli.runtime.list for the CLI ids this app holds. Served on this machine only, never to a paired device.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Target workspace id, from workspace.list or terminal.list.' },
        workspaceName: {
          type: 'string',
          description:
            'Target workspace by display name instead of id (case-insensitive). Refused when more than one ' +
            'workspace carries the name.',
        },
        cli: {
          type: 'string',
          description:
            "Agent CLI plugin id; defaults to this machine's last-selected CLI. cli.runtime.list enumerates the " +
            'ids this app actually holds — do not guess one.',
        },
        name: { type: 'string', description: 'Agent display name; defaults to an unused name from the shared pool.' },
        prompt: { type: 'string', description: 'Startup prompt sent to the CLI after launch.' },
        cliModel: {
          type: 'string',
          description: 'Model id for CLIs that support model selection; forwarded verbatim to the CLI.',
        },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'CLI permission preset: "bypass" launches the CLI with its own skip-every-prompt flag; "auto" runs ' +
            "the CLI's own auto mode (a classifier or reviewer that runs what it judges safe, where the CLI has " +
            'one, else edits in the workspace go through and commands ask); "manual" asks before every edit, ' +
            'command and outside call; "none" passes no permission flag, so the CLI\'s own configuration ' +
            'decides. A terminal agent takes only the presets its CLI has a setting for (cli.runtime.list names ' +
            'them, with the name each mode has in that CLI). Omitted, the launch takes the preset chosen for ' +
            'that CLI on this machine, else the app default "auto" ("none" for a CLI with no auto mode), ' +
            'exactly as the desktop launcher would. The older "bypass_all" is read as "bypass". ' +
            CALLER_PRESET_CAP_SENTENCE,
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const invalid = firstInvalidOptionalString(args, [
        'workspaceId',
        'workspaceName',
        'cli',
        'name',
        'prompt',
        'cliModel',
      ])
      if (invalid) return invalid

      const resolved = resolveTerminalWorkspace(args)
      if (!('workspace' in resolved)) return resolved

      const requestedPreset = cappedPermissionPreset(args, context)
      if (requestedPreset !== undefined && typeof requestedPreset !== 'string') return requestedPreset

      // An omitted preset is left to the launch service, which resolves it the
      // way the desktop launcher does (owner ruling 2026-09-27): the person's
      // choice for this CLI, else the app default, `auto` — unless the caller
      // is an agent whose own preset is stricter, which it then launches on.
      const launched = await launchConfiguredAgent({
        workspaceId: resolved.workspace.id,
        cli: optionalString(args.cli),
        name: optionalString(args.name),
        prompt: optionalString(args.prompt),
        cliModel: optionalString(args.cliModel),
        ...(requestedPreset ? { permissionPreset: requestedPreset } : {}),
        worktreeRequested: false,
      })
      if (!('agentId' in launched)) return launched
      return success({
        sessionId: launched.session.sessionId,
        workspaceId: launched.workspace.id,
        agentId: launched.agentId,
        // What the launch RESOLVED, not what was asked for: the CLI and the
        // preset both came from this machine's settings when the caller named
        // none. The launch record on the session is the resolution itself.
        permissionPreset: launched.session.agentRecord?.cliPermissionPreset ?? requestedPreset ?? null,
        terminal: terminalSessionProjection(launched.session),
      })
    },
  }

  // Backlog tools take no workspace id: the target project defaults to the
  // folder this agent connection was launched from, and external callers name
  // a folder directly.
  const PROJECT_ROOT_PROPERTY = {
    type: 'string',
    description:
      'Absolute path to the project folder. Optional — when omitted, the tool targets the project this agent ' +
      'connection was launched from. Only needed when calling from outside a Studio-launched agent.',
  }

  const backlogList: McpToolRegistration = {
    name: 'backlog.list',
    description:
      "List the project's Backlog items and epics (title, display id, status, type, triage axes, epic " +
      'membership). Reads item files and frontmatter only — never writes. Archived items are omitted.',
    inputSchema: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PROPERTY },
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const listed = await backends.listBacklogItems(resolved.root)
      if (!listed.ok) return failure('backlog_unavailable', listed.message)
      return success({ workspaceKey: listed.key, items: listed.items })
    },
  }

  const backlogRead: McpToolRegistration = {
    name: 'backlog.read',
    description:
      'Read one Backlog item: parsed frontmatter fields plus the markdown body. ' +
      'The path must be a project-relative markdown path under backlog/.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        projectRoot: PROJECT_ROOT_PROPERTY,
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const read = await backends.readBacklogItem(resolved.root, path)
      if (!read.ok) return failure('backlog_read_failed', read.message)
      return success({ item: read.item, body: read.body })
    },
  }

  // module.* / marketplace.*. Read-only by decision: install,
  // uninstall, and enable/disable mutate trust, and belong to the item that
  // models that permission question — not to the surface that reports state.
  //
  // The registry answered from is the renderer's mirrored universe: main sees
  // only its own modules, so a main-derived list would silently omit every
  // renderer-only module (Backlog, Design, Git, Memory, Dev tools). It is
  // widened with third-party modules installed on disk that never reached the
  // renderer — an untrusted or tampered module loads nowhere, and "what is
  // installed" has to include it or the answer is wrong in the case that
  // matters most.
  async function collectModuleRecords(): Promise<
    { snapshot: ModuleRegistrySnapshot; records: ModuleRecord[]; thirdPartyUnavailable?: string } | McpToolResult
  > {
    const snapshot = backends.getModuleRegistrySnapshot()
    if (!snapshot) {
      return failure(
        'module_registry_unavailable',
        'The running app has not reported its module registry yet (no window has finished starting). ' +
          'Retry once the app window is up.',
      )
    }
    let installed: ThirdPartyModuleListResult | null = null
    let thirdPartyUnavailable: string | undefined
    try {
      installed = await backends.listInstalledThirdPartyModules()
    } catch (error) {
      // The bundled half of the answer is still exact; say what is missing
      // rather than pretending no third-party module is installed.
      thirdPartyUnavailable = error instanceof Error ? error.message : 'The installed module folder could not be read.'
    }
    const installedById = new Map((installed?.modules ?? []).map((module) => [module.manifest.id, module] as const))
    const records: ModuleRecord[] = snapshot.modules.map((entry) => {
      const view = installedById.get(entry.id)
      installedById.delete(entry.id)
      return {
        id: entry.id,
        source: entry.source,
        enabled: entry.enabled,
        manifest: entry.manifest,
        entry,
        report: registeredModuleReport(entry, view),
      }
    })
    for (const view of installedById.values()) {
      records.push({
        id: view.manifest.id,
        source: 'third-party',
        enabled: false,
        manifest: view.manifest,
        entry: null,
        report: installedOnlyModuleReport(view),
      })
    }
    return { snapshot, records, ...(thirdPartyUnavailable ? { thirdPartyUnavailable } : {}) }
  }

  const moduleList: McpToolRegistration = {
    name: 'module.list',
    description:
      'List the capability modules this app has, as the user sees them: bundled and third-party, each with its ' +
      'source, version, whether it is enabled, and why it is not when it is off. Modules that ship only in ' +
      'development builds are absent from a packaged build entirely — never reported as present-but-disabled. ' +
      'A third-party module that is installed but untrusted appears here (installed) even though it loads nowhere. ' +
      'Read-only: enabling, installing, and trusting are not on this surface.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['bundled', 'third-party'], description: 'Only modules from this source.' },
        enabled: { type: 'boolean', description: 'Only modules in this enablement state.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (args.source !== undefined && args.source !== 'bundled' && args.source !== 'third-party') {
        return failure('invalid_arguments', '"source" must be "bundled" or "third-party" when provided.')
      }
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        return failure('invalid_arguments', '"enabled" must be a boolean when provided.')
      }
      const collected = await collectModuleRecords()
      if ('content' in collected) return collected
      const modules = collected.records
        .filter((record) => args.source === undefined || record.source === args.source)
        .filter((record) => args.enabled === undefined || record.enabled === args.enabled)
        .map((record) => record.report)
      return success({
        channel: collected.snapshot.channel,
        capturedAt: new Date(collected.snapshot.capturedAt).toISOString(),
        modules,
        ...(collected.thirdPartyUnavailable ? { thirdPartyUnavailable: collected.thirdPartyUnavailable } : {}),
      })
    },
  }

  const moduleStatus: McpToolRegistration = {
    name: 'module.status',
    description:
      'Read one capability module: its manifest, the permissions it declares, the surfaces it contributes ' +
      '(workspace types, doors, settings sections, commands, …), the gateway tools it adds, and — when it is ' +
      'not active — why. A module that ships only in development builds reports module_not_in_build on a ' +
      'packaged build rather than appearing disabled.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Module id from module.list, e.g. "automations".' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const collected = await collectModuleRecords()
      if ('content' in collected) return collected
      const record = collected.records.find((candidate) => candidate.id === id)
      if (!record) {
        if (BUNDLED_MODULE_IDS.includes(id)) {
          return failure(
            'module_not_in_build',
            isDevOnlyModule(id) && collected.snapshot.channel === 'production'
              ? `Module "${id}" ships only in development builds; this build does not contain it, so it is absent rather than disabled.`
              : `Module "${id}" is a known module id but is not part of this ${collected.snapshot.channel} build.`,
          )
        }
        return failure('unknown_module', `Module "${id}" is not installed in the running app.`)
      }
      const contributedTools = backends
        .listModuleContributedTools()
        .filter((tool) => tool.moduleId === id)
        .map((tool) => tool.toolName)
      return success({
        channel: collected.snapshot.channel,
        capturedAt: new Date(collected.snapshot.capturedAt).toISOString(),
        module: {
          ...record.report,
          manifest: record.manifest,
          permissions: record.manifest.permissions ?? [],
          dependsOn: record.manifest.dependsOn ?? [],
          surfaces: record.entry?.surfaces ?? null,
          contributedTools,
        },
        ...(collected.thirdPartyUnavailable ? { thirdPartyUnavailable: collected.thirdPartyUnavailable } : {}),
      })
    },
  }

  const marketplaceList: McpToolRegistration = {
    name: 'marketplace.list',
    description:
      'Browse the extension marketplace index the app itself reads (same registry client, cache, and ' +
      'bundled-first policy as the Plugins marketplace) — modules, MCP servers, skill packs, agent CLIs and ' +
      'automations. Filter by what an entry provides to get the module-first facet. Read-only: installing is ' +
      'a trust decision and is not on this surface. The result discloses where the index came from and ' +
      'whether it is a stale offline cache.',
    inputSchema: {
      type: 'object',
      properties: {
        provides: {
          type: 'string',
          enum: [...MARKETPLACE_COMPONENT_KINDS],
          description: 'Only entries that bundle this component kind; "module" is the module-first facet.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive match over name, summary, category, publisher, and tags.',
        },
        forceRefresh: { type: 'boolean', description: 'Re-fetch the index instead of answering from the cache.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['provides', 'query'])
      if (invalid) return invalid
      if (
        args.provides !== undefined &&
        !MARKETPLACE_COMPONENT_KINDS.includes(args.provides as MarketplaceComponentKind)
      ) {
        return failure('invalid_arguments', `"provides" must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.`)
      }
      if (args.forceRefresh !== undefined && typeof args.forceRefresh !== 'boolean') {
        return failure('invalid_arguments', '"forceRefresh" must be a boolean when provided.')
      }
      const read = await backends.readMarketplaceRegistry(
        args.forceRefresh === true ? { forceRefresh: true } : undefined,
      )
      if (!read.ok) {
        return failure('marketplace_unavailable', `${read.message} (registry ${read.registryUrl}, state ${read.state})`)
      }
      const provides = optionalString(args.provides) as MarketplaceComponentKind | undefined
      const query = optionalString(args.query)?.trim().toLowerCase()
      const all = read.marketplace.plugins
      const matched = all
        .filter((plugin) => provides === undefined || plugin.provides.includes(provides))
        .filter((plugin) => query === undefined || marketplaceEntryMatches(plugin, query))
      return success({
        registryUrl: read.registryUrl,
        state: read.state,
        source: read.source,
        stale: read.stale,
        fetchedAt: read.fetchedAt,
        ...(read.state === 'offline' ? { notice: read.message } : {}),
        total: all.length,
        matched: matched.length,
        plugins: matched.map(marketplaceEntryProjection),
      })
    },
  }

  const BACKLOG_TYPES = ['epic', 'feature', 'bug', 'mockup', 'spike'] as const
  const BACKLOG_STATUSES = ['idea', 'ready', 'in_progress', 'needs_input', 'completed', 'archived'] as const
  const BACKLOG_DIFFICULTIES = ['xs', 's', 'm', 'l', 'xl'] as const
  const BACKLOG_CRITICALITIES = ['low', 'normal', 'high', 'critical'] as const
  const BACKLOG_RISKS = ['low', 'normal', 'high'] as const

  const backlogUpdate: McpToolRegistration = {
    name: 'backlog.update',
    description:
      "Update one Backlog item's lifecycle or triage frontmatter: status, type, difficulty, criticality, risk, " +
      'epic membership, or (on an epic) the dependenciesPlanned ordering mark. Pass null to clear a field ' +
      '(status cannot be cleared). Only supplied fields change; ' +
      'the item body is never touched and a real change gets a server-owned precise updated timestamp. ' +
      'Fields apply in a fixed order (status, type, triage, epic, dependenciesPlanned) and the first ' +
      'invalid field stops the write — fields earlier in the order stay applied.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        projectRoot: PROJECT_ROOT_PROPERTY,
        status: { type: 'string', enum: [...BACKLOG_STATUSES] },
        type: { type: ['string', 'null'], enum: [...BACKLOG_TYPES, null] },
        difficulty: { type: ['string', 'null'], enum: [...BACKLOG_DIFFICULTIES, null] },
        criticality: { type: ['string', 'null'], enum: [...BACKLOG_CRITICALITIES, null] },
        risk: { type: ['string', 'null'], enum: [...BACKLOG_RISKS, null] },
        epic: { type: ['string', 'null'], description: 'Epic slug, or null to remove the item from its epic.' },
        dependenciesPlanned: {
          type: 'boolean',
          description:
            'On an EPIC: the ordering pass over its children is finished — their dependsOn edges are authored, ' +
            'and no edges at all means deliberately parallel. Set it as the LAST act of planning an epic. ' +
            "Nothing recomputes it: editing the epic's membership is your cue to re-check it. " +
            'false removes the mark.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const fields = ['status', 'type', 'difficulty', 'criticality', 'risk', 'epic'] as const
      if (!fields.some((field) => field in args) && !('dependenciesPlanned' in args)) {
        return failure('invalid_arguments', 'Supply at least one field to update.')
      }
      for (const field of fields) {
        if (field in args && args[field] !== null && typeof args[field] !== 'string') {
          return failure('invalid_arguments', `"${field}" must be a string${field === 'status' ? '' : ' or null'}.`)
        }
      }
      // The one boolean field: an assertion of intent, so it is true or false —
      // never a string "true", which would read as an accidental write.
      if ('dependenciesPlanned' in args && typeof args.dependenciesPlanned !== 'boolean') {
        return failure('invalid_arguments', '"dependenciesPlanned" must be true or false.')
      }
      if (args.status === null) return failure('invalid_arguments', 'Status cannot be cleared, only changed.')
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved

      // Apply in a fixed order, stopping at the first failure; the services
      // validate vocabulary and report plain messages.
      // Values are passed through as-typed; the services own vocabulary
      // validation and return plain messages for anything invalid.
      const base = { workspaceRoot: resolved.root, relativePath: path }
      const writes: Array<() => Promise<BacklogMutationResult>> = []
      if (typeof args.status === 'string') {
        writes.push(() =>
          backends.backlogWrite.updateStatus({ ...base, status: args.status as BacklogItemStatusPayload }),
        )
      }
      if ('type' in args) {
        writes.push(() =>
          backends.backlogWrite.updateType({ ...base, type: (args.type ?? null) as BacklogTypePayload | null }),
        )
      }
      if ('difficulty' in args || 'criticality' in args || 'risk' in args) {
        writes.push(() =>
          backends.backlogWrite.updateTriage({
            ...base,
            ...('difficulty' in args
              ? { difficulty: (args.difficulty ?? null) as BacklogDifficultyPayload | null }
              : {}),
            ...('criticality' in args
              ? { criticality: (args.criticality ?? null) as BacklogCriticalityPayload | null }
              : {}),
            ...('risk' in args ? { risk: (args.risk ?? null) as BacklogRiskPayload | null } : {}),
          }),
        )
      }
      if ('epic' in args) {
        writes.push(() => backends.backlogWrite.updateEpic({ ...base, epic: (args.epic ?? null) as string | null }))
      }
      if ('dependenciesPlanned' in args) {
        writes.push(() =>
          backends.backlogWrite.updateDependenciesPlanned({
            ...base,
            dependenciesPlanned: args.dependenciesPlanned as boolean,
          }),
        )
      }
      for (const write of writes) {
        const written = await write()
        if (!written.ok) return failure('backlog_update_failed', written.message)
      }
      return success({ updated: { relativePath: path } })
    },
  }

  const backlogRepair: McpToolRegistration = {
    name: 'backlog.repair',
    description:
      'Repair one diagnosed Backlog integrity defect. This is deliberately narrow: replace embedded NUL bytes ' +
      'with the visible \\0 escape, or reallocate one side of a proven duplicate numeric id to the next free id. ' +
      'The operation refuses files that do not currently have the named defect.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Item path relative to the project root.' },
        issue: { type: 'string', enum: ['embedded_nul', 'duplicate_id'] },
        projectRoot: PROJECT_ROOT_PROPERTY,
      },
      required: ['path', 'issue'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const issue = requireString(args, 'issue')
      if (typeof issue !== 'string') return issue
      if (issue !== 'embedded_nul' && issue !== 'duplicate_id') {
        return failure('invalid_arguments', '"issue" must be one of: embedded_nul, duplicate_id.')
      }
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const repaired = await backends.backlogWrite.repairIntegrity({
        workspaceRoot: resolved.root,
        relativePath: path,
        issue,
      })
      if (!repaired.ok) return failure('backlog_repair_failed', repaired.message)
      return success({ repaired })
    },
  }

  const backlogAssign: McpToolRegistration = {
    name: 'backlog.assign',
    description:
      'Record which agent is working a Backlog item (the working-agent link shown in the Backlog panel). ' +
      'Idempotent — assigning again replaces the previous agent link. Never changes item status. ' +
      "The panel's file watcher observes backlog/ item files, so a bare assignment appears on the panel's " +
      'next refresh rather than instantly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        agentId: { type: 'string', description: 'Agent id within the workspace (see workspace.status).' },
        projectRoot: PROJECT_ROOT_PROPERTY,
      },
      required: ['path', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const agentId = requireString(args, 'agentId')
      if (typeof agentId !== 'string') return agentId
      const resolved = resolveBacklogWorkspace(args, context)
      if (!('workspace' in resolved)) return resolved
      const { workspace } = resolved
      const agent = workspace.agents[agentId]
      if (!agent) return failure('unknown_agent', `Agent "${agentId}" is not known in workspace "${workspace.id}".`)

      const link = buildAgentBacklogLink({ workspaceId: workspace.id, agentId, agentName: agent.name || agentId })
      const written = await backends.backlogWrite.addOrUpdateLink({
        workspaceRoot: resolved.root,
        relativePath: path,
        link,
      })
      if (!written.ok) return failure('backlog_assign_failed', written.message)
      return success({ assigned: { relativePath: path, agentId, label: link.label } })
    },
  }

  // Compose the startup prompt for a backlog.work handoff: the target CLI's
  // native skill invocation (e.g. `/backlog backlog/foo.md` for Claude) when the
  // plugin declares a file-drop template, otherwise a plain-language block that
  // names the path and restates the built-in skill's lifecycle contract so any
  // agent can follow it. The invocation is what gets sent; the fallback is
  // CLI-agnostic, so it also covers an unspecified or unknown `cli`.
  function renderBacklogSkillInvocation(cli: string | undefined, relativePath: string): string {
    const plugin = cli ? backends.listPlugins().find((candidate) => candidate.manifest.id === cli) : undefined
    const template = plugin?.manifest.skillIntegration?.invocation?.fileDropTemplate
    if (template) {
      return renderSkillInvocationTemplate(template, {
        skillId: BACKLOG_SKILL_ID,
        skillName: 'Backlog',
        path: relativePath,
      })
    }
    return backlogLifecycleHandoffPrompt(relativePath)
  }

  const backlogWork: McpToolRegistration = {
    name: 'backlog.work',
    description:
      'Hand a Backlog item to a freshly launched agent in one call: launches a configured agent whose first input ' +
      'is the target CLI\'s Backlog skill invocation (e.g. "/backlog <path>" for Claude, a plain-language ' +
      'lifecycle block for CLIs without skill integration), then records the working-agent link. Never changes ' +
      'item status — the Backlog skill contract owns lifecycle, exactly like dragging the item onto a terminal. ' +
      'Refuses completed or archived items. Same launch fields as agent.launch, minus the connector.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        projectRoot: PROJECT_ROOT_PROPERTY,
        cli: {
          type: 'string',
          description:
            'Agent CLI plugin id; defaults to the last selected CLI. cli.runtime.list enumerates the registered ids.',
        },
        name: { type: 'string', description: 'Agent display name.' },
        cliModel: {
          type: 'string',
          description:
            "Model id for CLIs that support model selection; forwarded verbatim. cli.runtime.list reports each CLI's ids.",
        },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'CLI permission preset: "bypass" launches the CLI with its own skip-every-prompt flag; "auto" runs ' +
            "the CLI's own auto mode (a classifier or reviewer that runs what it judges safe, where the CLI has " +
            'one, else edits in the workspace go through and commands ask); "manual" asks before every edit, ' +
            'command and outside call; "none" passes no permission flag, so the CLI\'s own configuration ' +
            'decides. A terminal agent takes only the presets its CLI has a setting for (cli.runtime.list names ' +
            'them, with the name each mode has in that CLI). Omitted, the launch takes the preset chosen for ' +
            'that CLI on this machine, else the app default "auto" ("none" for a CLI with no auto mode), ' +
            'exactly as the desktop launcher would. The older "bypass_all" is read as "bypass". ' +
            CALLER_PRESET_CAP_SENTENCE,
        },
        worktree: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Worktree/branch name; defaults to the agent name.' } },
          additionalProperties: false,
          description:
            'Isolate the agent in a git worktree on a "<prefix>/<name>" branch (the branch prefix set in Settings ▸ ' +
            'Worktrees, "agent" unless changed) instead of the workspace checkout.',
        },
        instructions: {
          type: 'string',
          description: 'Extra context appended after the skill invocation in the startup prompt.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'cliModel', 'instructions'])
      if (invalid) return invalid
      const options = resolveLaunchOptions(args, context)
      if ('content' in options) return options
      const resolved = resolveBacklogWorkspace(args, context)
      if (!('workspace' in resolved)) return resolved
      const workspaceId = resolved.workspace.id

      // Read the item and gate on workability: a missing/invalid path is
      // not_found; a completed item or anything under backlog/archived/ is a
      // finished record that must not be re-handed. Every other status
      // (including in_progress — a re-handoff is legitimate) is workable.
      const read = await backends.readBacklogItem(resolved.root, path)
      if (!read.ok) return failure('backlog_item_not_found', read.message)
      if (read.item.status === 'completed' || isArchivedBacklogPath(read.item.relativePath)) {
        const reason = read.item.status === 'completed' ? 'completed' : 'archived'
        return failure(
          'backlog_item_not_workable',
          `Backlog item ${read.item.relativePath} is ${reason} and cannot be handed to an agent.`,
        )
      }

      const cli = optionalString(args.cli)
      const instructions = optionalString(args.instructions)
      const invocation = renderBacklogSkillInvocation(cli, read.item.relativePath)
      const prompt = instructions ? `${invocation}\n\n${instructions}` : invocation

      // Install the Backlog skill into the CLI's native dir before launch so the
      // invocation resolves. Non-fatal: a false result rides `skillEnsured` and
      // the prompt still states the lifecycle contract.
      const skillEnsured = await backends.ensureBuiltinSkillInstalled(
        resolved.root,
        BACKLOG_SKILL_ID,
        cli,
        resolved.workspace.hostId ?? null,
      )

      // Record the working-agent link after a confirmed launch. A link failure
      // here is NOT overall failure — the agent is already running, so faking
      // failure would invite a duplicate launch. Report assigned:false + warning.
      const assign = (started: ConfirmedLaunch) => {
        const agent = findWorkspace(workspaceId)?.agents[started.agentId] ?? started.workspace.agents[started.agentId]
        return backends.backlogWrite.addOrUpdateLink({
          workspaceRoot: resolved.root,
          relativePath: read.item.relativePath,
          link: buildAgentBacklogLink({
            workspaceId,
            agentId: started.agentId,
            agentName: agent?.name || started.agentId,
          }),
        })
      }
      const launched = await launchConfiguredAgent(
        {
          workspaceId,
          cli,
          name: optionalString(args.name),
          prompt,
          cliModel: optionalString(args.cliModel),
          permissionPreset: options.permissionPreset,
          worktreeRequested: options.worktreeRequested,
          worktreeName: options.worktreeName,
          // The launch carries the skill its `/backlog` invocation names; the
          // ensure above wrote nothing for a launch that does.
          spawnSkillId: BACKLOG_SKILL_ID,
        },
        {
          // Assigned once the agent exists, after its worktree's install.
          afterStart: (started) => {
            void assign(started).catch(() => undefined)
            return null
          },
        },
      )
      if (!('agentId' in launched)) return launched
      if ('deferred' in launched) {
        return success({
          worked: {
            relativePath: read.item.relativePath,
            workspaceId,
            agentId: launched.agentId,
            invocation,
            skillEnsured,
            assigned: false,
            warning:
              'The agent starts when its worktree finishes installing dependencies, and the item is assigned to it ' +
              'then. Read agent.status for where it is.',
            ...deferredLaunchFields(launched.record),
          },
        })
      }

      const written = await assign(launched)
      return success({
        worked: {
          relativePath: read.item.relativePath,
          workspaceId,
          agentId: launched.agentId,
          invocation,
          skillEnsured,
          assigned: written.ok,
          ...(written.ok
            ? {}
            : { warning: `Agent launched but the working-agent link was not recorded: ${written.message}` }),
          ...(launched.worktreePath ? { worktreePath: launched.worktreePath } : {}),
        },
      })
    },
  }

  function scheduledAgentsOrFailure(): ScheduledAgentsService | McpToolResult {
    const service = backends.getScheduledAgents()
    if (!service) {
      return failure(
        'scheduled_agents_unavailable',
        'Scheduled agents are switched off or not loaded in this app session; turn them on in Settings → Modules.',
      )
    }
    return service
  }

  // A chat a schedule started may read the schedules but not make, remove or
  // fire one. A run that could schedule runs could fill the list with copies
  // of itself, each starting more, with nobody watching any of them; and one
  // that could fire its own schedule would be a loop by another name. The
  // schedule is the one long-lived thing, set up by a person, and its runs
  // come and go under it.
  //
  // The caller is the chat whose agent declared itself on this connection
  // (`launchPermissionCeiling` reads the same identity). A caller that
  // declared no workspace is not a run's chat as far as anything here can
  // tell, and keeps what it had.
  function refuseScheduledRunCaller(context: McpConnectionContext | undefined, action: string): McpToolResult | null {
    if (context?.metadata.kind !== 'studio-agent') return null
    if (!connectionWorkspace(context)?.scheduledAgentId) return null
    return failure(
      'scheduled_run_refused',
      `This chat was started by a scheduled agent, and a scheduled run may not ${action} one. ` +
        'Ask the person to change schedules from the app.',
    )
  }

  // What a caller reads about a scheduled agent: the record, its schedule in
  // words, whether it is paused (and since when), and when it runs next as an
  // ISO instant — null while it is paused, on its own or with every other.
  const isoOrNull = (at: number | null | undefined) => (typeof at === 'number' ? new Date(at).toISOString() : null)
  const scheduledAgentForCaller = (agent: ScheduledAgentView) => ({
    ...agent,
    scheduleWords: scheduledAgentScheduleWords(agent.schedule),
    paused: agent.pausedAt !== undefined,
    pausedAt: isoOrNull(agent.pausedAt),
    nextRunAt: isoOrNull(agent.nextRunAt),
  })

  const scheduledAgentList: McpToolRegistration = {
    name: 'schedule.list',
    description:
      'List the scheduled agents on this computer: each is a prompt and a cron schedule, and each time the ' +
      'schedule comes round a new chat starts in its project with that prompt. `paused` is true for one the ' +
      'person paused; `pausedAll` says whether every scheduled agent is paused, and until when. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const service = scheduledAgentsOrFailure()
      if (!('list' in service)) return service
      const pause = service.pausedAll()
      return success({
        scheduledAgents: service.list().map(scheduledAgentForCaller),
        pausedAll: pause ? { since: isoOrNull(pause.since), until: isoOrNull(pause.until) } : null,
      })
    },
  }

  const scheduledAgentCreate: McpToolRegistration = {
    name: 'schedule.create',
    description:
      "Schedule an agent: each time the cron schedule comes round, a new chat starts in the workspace's " +
      'project, on its machine, with `prompt` as its first message. Nothing carries over between runs. ' +
      '`cron` is five-field cron (minute hour day month weekday), several separated by ";". The schedule is ' +
      "read in this computer's timezone unless `timezone` names another IANA zone. " +
      CALLER_PRESET_CAP_SENTENCE +
      ' Refused to a chat a scheduled agent started.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list: its project and machine.' },
        prompt: { type: 'string', description: 'The first message each run is sent.' },
        cron: { type: 'string', description: 'Five-field cron, e.g. "0 9 * * 1-5" for weekdays at 9:00 AM.' },
        timezone: { type: 'string', description: "IANA zone the cron is read in; this computer's when omitted." },
        cli: { type: 'string', description: 'Agent CLI id (e.g. "claude-code"); the last-picked one when omitted.' },
        model: { type: 'string', description: "The CLI's model id; its default when omitted." },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'Each run\'s CLI permission preset: "bypass" skips every prompt; "auto" runs the CLI\'s own auto ' +
            'mode, or lets edits in the workspace through and asks before commands where it has none; "manual" asks before every ' +
            'edit, command and outside call; "none" passes no flag. Nobody watches a run, so one that asks ' +
            'waits on its approval card. Omitted, each run takes the preset chosen for its CLI at run time.',
        },
        worktree: {
          type: 'boolean',
          description: 'Run each time in a fresh git worktree rather than the project checkout.',
        },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill ids attached to each run.' },
        mcpServers: { type: 'array', items: { type: 'string' }, description: 'Installed MCP server ids.' },
      },
      required: ['workspaceId', 'prompt', 'cron'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const refused = refuseScheduledRunCaller(context, 'create')
      if (refused) return refused
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const workspace = findWorkspace(workspaceId)
      if (!workspace?.folderPath) return resolveWorkspaceRoot(workspaceId) as McpToolResult
      const service = scheduledAgentsOrFailure()
      if (!('create' in service)) return service
      const requested =
        typeof args.permissionPreset === 'string' ? parseCliPermissionPreset(args.permissionPreset) : null
      if (typeof args.permissionPreset === 'string' && requested === null) {
        return failure(
          'invalid_arguments',
          `"permissionPreset" must be one of: ${LAUNCH_PERMISSION_PRESETS.join(', ')}.`,
        )
      }
      // A scheduled agent launches later with nobody watching, so one made by
      // an agent of this app stores no looser a preset than the agent's own.
      const capped = capScheduledAgentPreset(
        requested,
        launchPermissionCeiling(context, backends.resolveAgentPermissionPreset),
      )
      if ('refused' in capped) return failure(capped.refused.code, capped.refused.message)
      const cli = (typeof args.cli === 'string' && args.cli.trim()) || backends.defaultChatCli()
      if (!cli) return failure('no_cli_selected', 'Name a "cli": no agent CLI has been picked on this computer yet.')
      const strings = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((id): id is string => typeof id === 'string').map((id) => ({ id, name: id }))
          : []
      const created = await service.create({
        prompt: args.prompt,
        schedule: {
          cron: args.cron,
          timezone:
            typeof args.timezone === 'string' && args.timezone.trim()
              ? args.timezone
              : Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        // A workspace on a worktree schedules into its project, not into that
        // one worktree: each run makes its own.
        folderPath: workspace.worktree?.repoRoot ?? workspace.folderPath,
        hostId: workspace.hostId ?? null,
        cli,
        cliModel: typeof args.model === 'string' ? args.model : null,
        permissionPreset: capped.permissionPreset,
        skills: strings(args.skills),
        mcpServers: strings(args.mcpServers),
        worktree: args.worktree === true ? { name: '' } : null,
      })
      if (!created.ok) return failure('scheduled_agent_invalid', created.message)
      return success({ scheduledAgent: scheduledAgentForCaller(created.agent) })
    },
  }

  const scheduledAgentDelete: McpToolRegistration = {
    name: 'schedule.delete',
    description:
      'Stop and remove a scheduled agent. Chats its past runs started are left as they are. ' +
      'Refused to a chat a scheduled agent started.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Scheduled agent id from schedule.list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const refused = refuseScheduledRunCaller(context, 'delete')
      if (refused) return refused
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const service = scheduledAgentsOrFailure()
      if (!('remove' in service)) return service
      const removed = await service.remove(id)
      return removed.ok ? success({ removed: id }) : failure('unknown_scheduled_agent', removed.message)
    },
  }

  const scheduledAgentRun: McpToolRegistration = {
    name: 'schedule.run',
    description:
      "Start a scheduled agent's run now, without waiting for its schedule: a new chat with its prompt. " +
      "Called by an agent of this app, the scheduled agent must launch no looser than that agent's own " +
      'preset, or the run is refused with "permission_escalation". Refused to a chat a scheduled agent ' +
      "started, and while the scheduled agent's last run is still working.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Scheduled agent id from schedule.list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const refused = refuseScheduledRunCaller(context, 'run')
      if (refused) return refused
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const service = scheduledAgentsOrFailure()
      if (!('runNow' in service)) return service
      const agent = service.get(id)
      if (!agent) return failure('unknown_scheduled_agent', `No scheduled agent "${id}".`)
      const refusal = refuseScheduledAgentRun(
        agent.permissionPreset,
        launchPermissionCeiling(context, backends.resolveAgentPermissionPreset),
      )
      if (refusal) return failure(refusal.code, refusal.message)
      const ran = await service.runNow(id)
      if (!ran.ok) return failure('scheduled_agent_run_failed', ran.message)
      if (!ran.run.ok) return failure('scheduled_agent_run_failed', ran.run.message)
      return success({ workspaceId: ran.run.workspaceId })
    },
  }

  const scheduledAgentPause: McpToolRegistration = {
    name: 'schedule.pause',
    description:
      'Pause a scheduled agent: it starts no run at its scheduled times until it is resumed. A run already ' +
      'going is left to finish, and schedule.run still starts one. Refused to a chat a scheduled agent started.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Scheduled agent id from schedule.list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const refused = refuseScheduledRunCaller(context, 'pause')
      if (refused) return refused
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const service = scheduledAgentsOrFailure()
      if (!('pause' in service)) return service
      if (!service.get(id)) return failure('unknown_scheduled_agent', `No scheduled agent "${id}".`)
      const paused = await service.pause(id)
      if (!paused.ok) return failure('scheduled_agent_invalid', paused.message)
      return success({ scheduledAgent: scheduledAgentForCaller(paused.agent) })
    },
  }

  const scheduledAgentResume: McpToolRegistration = {
    name: 'schedule.resume',
    description:
      'Resume a paused scheduled agent. It runs next at its first scheduled time from now: the times that ' +
      'passed while it was paused are not made up. Called by an agent of this app, the scheduled agent must ' +
      'launch no looser than that agent\'s own preset, or it is refused with "permission_escalation". ' +
      'Refused to a chat a scheduled agent started.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Scheduled agent id from schedule.list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const refused = refuseScheduledRunCaller(context, 'resume')
      if (refused) return refused
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const service = scheduledAgentsOrFailure()
      if (!('resume' in service)) return service
      const agent = service.get(id)
      if (!agent) return failure('unknown_scheduled_agent', `No scheduled agent "${id}".`)
      // Resumed, it starts runs on its own preset with nobody watching, as
      // schedule.run would start one now: held to the same ceiling.
      const refusal = refuseScheduledAgentRun(
        agent.permissionPreset,
        launchPermissionCeiling(context, backends.resolveAgentPermissionPreset),
      )
      if (refusal) return failure(refusal.code, refusal.message)
      const resumed = await service.resume(id)
      if (!resumed.ok) return failure('scheduled_agent_invalid', resumed.message)
      return success({ scheduledAgent: scheduledAgentForCaller(resumed.agent) })
    },
  }

  return [
    workspaceCheckout,
    workspaceExtensions,
    workspaceCreate,
    workspaceList,
    workspaceMobileCommand,
    workspaceSnapshot,
    workspaceStatus,
    agentLaunch,
    agentStatus,
    cliRuntimeList,
    terminalList,
    terminalRead,
    terminalCreate,
    backlogList,
    backlogRead,
    backlogUpdate,
    backlogRepair,
    backlogAssign,
    backlogWork,
    moduleList,
    moduleStatus,
    marketplaceList,
    scheduledAgentList,
    scheduledAgentCreate,
    scheduledAgentDelete,
    scheduledAgentRun,
    scheduledAgentPause,
    scheduledAgentResume,
  ]
}

// One terminal session as terminal.list reports it: enough to choose one and
// say what it is doing, and nothing about its contents.
//
// `processAlive` and `suspended` are separate on purpose: a paused agent is not
// running (its pty was killed to reclaim memory) but is not gone either, and a
// caller that collapsed the two would treat a parked agent as finished.
/**
 * The checkout a terminal works in, summarised the way the sidebar row is:
 * branch, `+n −n`, and the scope that says whose changes they are (`worktree` —
 * this chat's own; `branch` — the branch's, possibly shared; `folder` — only
 * what is uncommitted). Null when the session has no directory or the read
 * fails; never a confident zero for a span that was not measured.
 */
async function terminalGitSummary(session: TerminalSessionSnapshot): Promise<{
  branch: string | null
  additions: number
  deletions: number
  changedFiles: number
  scope: string
} | null> {
  // Only a running session is asked about — the sidebar's own rule (owner
  // ruling 2026-09-04, the-diff-an-agent-made decision 9): a parked or exited
  // chat's numbers would be the checkout's present state, not anything the
  // chat did. It is also what keeps a list from fanning git out to every
  // checkout the runtime has ever held a session in.
  if (!session.processAlive) return null
  const checkoutPath = session.worktreePath ?? session.cwd
  if (!checkoutPath) return null
  try {
    const summary = await getWorkspaceChangeSummary({ checkoutPath })
    return {
      branch: summary.branch,
      additions: summary.additions,
      deletions: summary.deletions,
      changedFiles: summary.changedFiles,
      scope: summary.scope,
    }
  } catch {
    return null
  }
}

function terminalSessionProjection(session: TerminalSessionSnapshot): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    kind: session.kind,
    workspaceId: session.workspaceId ?? null,
    agentId: session.agentId ?? null,
    agentName: session.agentName ?? null,
    cli: session.cli ?? null,
    cwd: session.cwd ?? null,
    worktreePath: session.worktreePath ?? null,
    processAlive: session.processAlive,
    suspended: session.suspended,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    activity: session.activity.kind,
    // The agent's phase, marked with its provenance so a caller can tell an
    // authoritative hook frame from a lifecycle stamp (`starting` at spawn,
    // `stalled`/`exited`/`failed` from the watchdog and pty). Never an
    // output-timing guess. Absent for plain shells.
    agentState: session.agentState
      ? { phase: session.agentState.phase, source: session.agentState.source, since: session.agentState.since }
      : null,
    // ── What a row needs to say the same thing the sidebar says ──────────────
    //
    // Every field below is additive and null/zero when unknown, so a caller
    // built before them reads the row exactly as it did.

    // When the agent's last turn ended. Distinct from `activity`, which the
    // reaper's suspend and the quit path overwrite with the moment the PROCESS
    // died — so a parked chat can still say when it actually finished.
    lastTurnEndedAt: session.lastTurnEndedAt ?? null,
    // Context-window usage from the session's own status line, or null: a plain
    // terminal, a CLI with no status line, or a session that has not made an
    // API call yet. Never a guess, and a /compact does not clear it.
    contextUsage: session.contextUsage
      ? { usedPercentage: session.contextUsage.usedPercentage, at: session.contextUsage.at }
      : null,
    // Subagents started and not yet seen to stop, so a row can say "3 running"
    // rather than a bare spinner. Zero for plain terminals and hookless CLIs.
    activeSubagents: session.activeSubagents ?? 0,
    // The pull requests this conversation has, newest first — the ones on its
    // observed branch and the ones it opened itself in any repository. Absent
    // on the snapshot means "not asked yet", which is not "none": an empty
    // array is sent only when main actually holds an empty list.
    pullRequests: (session.pullRequests ?? []).map((pr) => ({
      url: pr.url,
      repoKey: pr.repoKey,
      repoName: pr.repoName,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
    })),
  }
}

// One agent CLI as cli.runtime.list reports it. Everything here is
// manifest-declared, so the projection is honest about its own limits: an empty
// `models` means the CLI declares no seed list, which — with
// `allowCustomModelId` — is different from "no model may be passed".
/**
 * How much the workspace's project is used, for a phone to order its project
 * list the way New chat here does (shared/project-frecency.ts). Additive and
 * optional on the wire: a phone that does not read them lists as it did, and a
 * phone that finds them absent (an older desktop) orders by its own picks.
 *
 * - `projectFrecency`: the project's score as of this listing, 0 for a project
 *   never used. Every row of one listing is scored at the same moment, so they
 *   compare. Keyed by the row's own folder, which is what a phone lists a
 *   project by: a worktree chat's folder is its own entry there.
 * - `projectLastUsedAt`: the latest use as an ISO time, null for never; a tie
 *   on the score goes to the later one.
 */
function projectUseFields(
  workspace: Workspace,
  usage: ProjectUsageMap,
  now: number,
): { projectFrecency: number; projectLastUsedAt: string | null } {
  const key = projectUsageKey(workspace.folderPath)
  const entry = key ? usage[key] : undefined
  return {
    // Six places are plenty to order by and keep the float noise off the wire.
    projectFrecency: Math.round(projectFrecency(entry, now) * 1e6) / 1e6,
    projectLastUsedAt: entry ? new Date(entry.lastUsedAt).toISOString() : null,
  }
}

function cliRuntimeProjection(plugin: LoadedPlugin): Record<string, unknown> {
  const { manifest } = plugin
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    source: plugin.source,
    binary: manifest.binary,
    // Hooks-only selectability (decision of record 2026-08-31): declared, not
    // probed — true exactly when the manifest carries an agentStateSpec. Rows
    // are marked rather than omitted so a remote caller holding a stale id
    // learns WHY it is refused instead of seeing the CLI vanish.
    agentSelectable: Boolean(manifest.agentStateSpec),
    supportsModelSelection: Boolean(manifest.modelSelection),
    models: (manifest.modelSelection?.options ?? []).map((option) => ({
      id: option.id,
      ...(option.label ? { label: option.label } : {}),
    })),
    allowCustomModelId: manifest.modelSelection?.allowCustomId === true,
    reasoningLevels: (manifest.reasoningSelection?.levels ?? []).map((level) => ({
      id: level.id,
      ...(level.label ? { label: level.label } : {}),
    })),
    defaultReasoningLevel: manifest.reasoningSelection?.default ?? null,
    // The presets a launch on this CLI can honour: `none` always (it passes no
    // flag), each other one only where the manifest names its setting.
    permissionPresets: declaredPermissionPresets(manifest),
    // The CLI's modes under its own names, each with the preset a caller names
    // to get it. A mode that is not a preset's own is chosen in the app; a
    // caller's preset runs that preset's own mode.
    permissionModes: declaredPermissionModes(manifest).map((mode) => ({
      id: mode.id,
      label: mode.label,
      preset: mode.level,
    })),
  }
}

// What the model picker here offers for one CLI, for a client that draws the
// same picker (the phone's New chat). The rows are the picker's own: the same
// merge of the CLI's reported list, its manifest seed and the person's ids
// (`mergeCliModelCatalog`), grouped into the same families
// (`cliPickerModels`), named the way its provider line names them. Additive
// beside `models`, which keeps answering the manifest seed for a caller built
// before this.
function cliRuntimeCatalog(plugin: LoadedPlugin, sources: CliModelSources, now: number): Record<string, unknown> {
  const { manifest } = plugin
  const merged = mergeCliModelCatalog(
    manifest.modelSelection
      ? {
          options: (manifest.modelSelection.options ?? []).map((option) => ({
            id: option.id,
            ...(option.label ? { label: option.label } : {}),
          })),
          allowCustomId: manifest.modelSelection.allowCustomId === true,
        }
      : undefined,
    [...(sources.userModels(manifest.id) ?? [])],
    sources.discovered[manifest.id],
    now,
  )
  const hostedVia = pluginHostedVia(manifest) ?? null
  return {
    conversational: conversationProviderForCli(manifest.id) !== null,
    hostedVia,
    providerLabel: hostedVia === 'claude-code' ? `${manifest.displayName} · via Claude Code` : manifest.displayName,
    allowCustomModelId: merged?.allowCustomId === true,
    models: merged ? cliPickerModels(merged.options) : [],
  }
}

// One module as the module.* tools report it. `entry` is the renderer registry
// entry when the module reached the renderer at all; a third-party module that
// is installed but untrusted has none, which is exactly what its report says.
type ModuleRecord = {
  id: string
  source: 'bundled' | 'third-party'
  enabled: boolean
  /** The registered manifest, from the renderer registry or (for a module that
   *  never loaded) the installed folder main read it from. Never null: a module
   *  in this list described itself somewhere, and the declared permissions of an
   *  untrusted module are exactly what a caller needs before trusting it. */
  manifest: CapabilityManifest
  entry: ModuleRegistryEntry | null
  report: Record<string, unknown>
}

function registeredModuleReport(
  entry: ModuleRegistryEntry,
  view: ThirdPartyModuleView | undefined,
): Record<string, unknown> {
  return {
    id: entry.id,
    displayName: entry.manifest.displayName,
    version: entry.manifest.version,
    source: entry.source,
    publisher: entry.manifest.publisher ?? null,
    category: entry.manifest.category ?? null,
    summary: entry.manifest.summary ?? null,
    core: entry.manifest.core === true,
    installed: true,
    enabled: entry.enabled,
    absence: entry.absence,
    ...(view ? { trust: view.trust, launch: thirdPartyLaunchReport(view) } : {}),
  }
}

// Installed on disk, absent from the renderer registry: the module never
// loaded, so everything reported about it comes from main's own trust and
// launch classification.
function installedOnlyModuleReport(view: ThirdPartyModuleView): Record<string, unknown> {
  const id = view.manifest.id
  const absence =
    view.trust === 'invalid'
      ? { reason: 'invalid_signature', message: `Module "${id}" has an invalid signature and will not load.` }
      : view.trust === 'trusted'
        ? {
            reason: 'not_loaded',
            message:
              view.launch.message ??
              `Module "${id}" is installed and trusted but registered nothing in the running app.`,
          }
        : { reason: 'untrusted', message: `Module "${id}" is installed but not trusted yet (Settings → Modules).` }
  return {
    id,
    displayName: view.manifest.displayName,
    version: view.manifest.version,
    source: 'third-party',
    publisher: view.manifest.publisher ?? null,
    category: view.manifest.category ?? null,
    summary: view.manifest.summary ?? null,
    core: false,
    installed: true,
    enabled: false,
    absence,
    trust: view.trust,
    launch: thirdPartyLaunchReport(view),
  }
}

function thirdPartyLaunchReport(view: ThirdPartyModuleView): Record<string, unknown> {
  return {
    status: view.launch.status,
    hasMainEntry: view.launch.hasMainEntry,
    expectedToLoad: view.launch.expectedToLoad,
    ...(view.launch.message ? { message: view.launch.message } : {}),
    ...(view.launch.rendererEntry ? { rendererEntry: view.launch.rendererEntry.availability } : {}),
  }
}

// Mirrors the storefront's own filter (name, category, summary, publisher, the
// widened categories/tags facets) so an agent searching the marketplace matches
// what a person searching the Plugins marketplace would.
function marketplaceEntryMatches(plugin: MarketplacePluginEntry, needle: string): boolean {
  return [
    plugin.name,
    plugin.id,
    plugin.category,
    plugin.summary,
    plugin.publisher.name,
    ...(plugin.categories ?? []),
    ...(plugin.tags ?? []),
  ].some((field) => field.toLowerCase().includes(needle))
}

function marketplaceEntryProjection(plugin: MarketplacePluginEntry): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    publisher: { name: plugin.publisher.name, verified: plugin.publisher.verified },
    summary: plugin.summary,
    category: plugin.category,
    ...(plugin.categories ? { categories: plugin.categories } : {}),
    ...(plugin.tags ? { tags: plugin.tags } : {}),
    latest: plugin.latest,
    provides: plugin.provides,
    // The index is display metadata: permissions and changelog live in the
    // signed plugin.json that is only downloaded at install time, so they are
    // deliberately absent rather than guessed.
    signed: Boolean(plugin.signature),
    ...(plugin.source ? { bundleSource: plugin.source } : {}),
  }
}

// Archived items live under backlog/archived/ (path-derived, matching the
// renderer's isArchivedBacklogPath); readBacklogItem normalizes the path but is
// case-preserving, so lowercase before the prefix check.
function isArchivedBacklogPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').toLowerCase().startsWith('backlog/archived/')
}

function success(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function requireString(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure('invalid_arguments', `"${key}" must be a non-empty string.`)
  }
  return value.trim()
}

function firstInvalidStringArray(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    const value = args[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      return failure('invalid_arguments', `"${key}" must be an array of non-empty strings.`)
    }
  }
  return null
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** An optional whole-number argument within [min, max]: the number, undefined when omitted, or the refusal. */
function optionalBoundedInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined | McpToolResult {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    return failure('invalid_arguments', `"${key}" must be a whole number from ${min} to ${max} when provided.`)
  }
  return value
}

function firstInvalidOptionalString(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      return failure('invalid_arguments', `"${key}" must be a string when provided.`)
    }
  }
  return null
}
