/**
 * ConversationLaunchService — starting a chat agent is a main-process
 * capability, as starting a terminal agent is (`agent-launch-service.ts`).
 *
 * A window starts a chat by adding a conversation-runtime agent to its store
 * and letting the chat view start the session and send the first message. That
 * needs a window showing the chat. A paired machine asking this one to start a
 * chat over the tailnet has no window here to lean on, so the same three steps
 * run in main:
 *
 * 1. The agent record is written to the workspace registry, so every window
 *    here lists the chat and a later-opened one shows it with its history.
 * 2. The conversation session is started, on the CLI's chat provider.
 * 3. The prompt is sent as the chat's first message. The send is NOT awaited:
 *    the runtime answers a send when the whole turn has finished, and the
 *    caller is a person waiting on a pane that follows the turn live.
 *
 * A session that cannot start takes its record back out, so a refused launch
 * never leaves a chat nobody can open.
 *
 * A workspace here is one chat, and its name is the chat's title. So a caller
 * that means "a new chat in this project" — a phone's or a paired machine's
 * New chat, which names a project by one of the workspaces in its folder —
 * asks for `newChat`: the chat is then born in a workspace of its own, in that
 * workspace's folder, instead of joining the chat that workspace already is.
 * A refused start then takes that whole workspace back out.
 *
 * The same three steps start every chat main starts for someone else: a module's
 * `create`, and an automation run's agent. Those callers add what a window's
 * New chat also carries — skills installed before the session starts and
 * attached to the first message, pictures on it — plus what only they need: the
 * module that owns the chat, and a run worktree the chat works in instead of
 * the workspace checkout.
 */
import { randomUUID } from 'crypto'

import { newAgentIdSuffix } from '../shared/agent-ids'
import { pickRandomAgentName } from '../shared/agent-names'
import { defaultAgent, type AgentState } from '../shared/agent-state'
import {
  CONVERSATION_DEFAULT_MODEL_ID,
  conversationPermissionModes,
  conversationProviderForCli,
} from '../shared/conversation-harness'
import type {
  ConversationCliRuntimeOverrides,
  ConversationImageAttachment,
  ConversationMcpServer,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
} from '../shared/conversation-runtime'
import type { EnsureSkillInstalledResult } from '../shared/modules/skills'
import type { WorktreeDependencyInstallView } from '../shared/ipc/worktree-pool'
import type { StartedDependencyInstall } from './worktree-pool/dependency-install'
import type { CliPermissionPreset } from '../shared/cli-permission-preset'
import { parseCliPermissionModeId } from '../shared/cli-permission-mode'
import { workspaceHostIdOf, type ExecutionHostId } from '../shared/execution-host'
import { resolveConnectorLaunchFrom } from '../shared/connector-launch'
import { conversationCliRuntimesForHost } from '../shared/conversation-cli-runtimes'
import type { McpServerConfig } from '../shared/ipc/mcp'
import { SOLO_CHAT_TEMPLATE_AGENT_ID, SOLO_CHAT_TEMPLATE_ID } from '../shared/layouts/templates'
import { deriveWorkspaceTitle, nextNewChatName } from '../shared/workspace-title'
import { agentWorktreePaths, newChatWorktreeName, workspaceProjectRootOf } from '../shared/worktree-paths'
import type { WorkspaceWorktree } from '../renderer/src/types/workspace'
import type { WorkspaceCreateRequest } from './workspace-registry-service'
import { isMachinePath } from '../shared/machine-paths'
import {
  effectiveAgentLaunchSettings,
  resolveAgentSpawnPermission,
  type AgentLaunchSettings,
} from '../shared/launch-settings'

/** A workspace as the chat launch needs to see it. */
export type ConversationLaunchWorkspace = {
  id: string
  name?: string
  folderPath?: string | null
  hostId?: ExecutionHostId | null
  worktree?: WorkspaceWorktree | null
  agents?: Record<string, { name?: string }>
}

export type ConversationLaunchRequest = {
  /** The workspace the chat joins (or, with `newChat`, whose folder a new one starts in). */
  workspaceId?: string
  /**
   * Start the chat in a new workspace of its own in this folder, on this
   * machine, with no workspace to borrow them from: a scheduled agent's run.
   * Takes the place of `workspaceId` and implies `newChat`.
   */
  newChatIn?: {
    folderPath: string
    hostId?: ExecutionHostId | null
    worktree?: WorkspaceWorktree | null
  }
  /**
   * Start the chat in a new workspace of its own, in `workspaceId`'s folder
   * (on its machine, and marked as the same worktree), rather than in that
   * workspace. The new workspace takes an app-minted name, so the chat's
   * first message titles it.
   */
  newChat?: boolean
  /**
   * Start the new chat in a worktree of its own, cut the way a window's New
   * chat cuts one with Worktree on: from the worktree pool where this process
   * keeps one, on the default branch, under the project's worktree container,
   * with the new workspace marked as a worktree of the project it was cut from.
   * Read only beside `newChat`. A project that is not a git repository refuses
   * the launch (`worktree_unavailable`) rather than starting the chat in the
   * checkout it was asked to keep clean.
   */
  newWorktree?: boolean
  /**
   * What the new chat's worktree is named from, with `newWorktree`: its branch
   * is `<prefix>/<name>-<suffix>` (the branch prefix from Settings ▸
   * Worktrees, `agent` unless changed), the short suffix keeping each chat's
   * branch its own. Absent, the name a window's New chat gives one
   * (`chat-<suffix>`).
   */
  worktreeName?: string
  /**
   * Start the new chat in a worktree the project's repository already has,
   * by its path as `workspace.checkout` lists it, rather than in the
   * workspace folder or a worktree cut for it. A path the repository does not
   * list as one of its worktrees refuses the launch (`worktree_unavailable`):
   * the caller may be a paired device, and a path is not a way to start a
   * chat in any folder of this disk. The repository's main worktree is its
   * own checkout, and starts the chat there as if no path were named. Read
   * only beside `newChat`, and never with `newWorktree`.
   */
  existingWorktreePath?: string
  /** The agent CLI the chat drives; the last-selected CLI when absent. */
  cli?: string
  /** The CLI's model id; the CLI's own default when absent. */
  cliModel?: string
  /**
   * The effort level the chat runs at, one of the levels its CLI declares.
   * Kept on the agent record, as a window's New chat keeps its effort pick,
   * and sent with each turn the chat's provider can run at that level. A CLI
   * that declares no levels ignores it; one outside the declared levels
   * refuses the launch (`unsupported_effort`).
   */
  reasoningEffort?: string
  /** Absent, the preset chosen for that CLI here, else the app default — as the launcher would. */
  permissionPreset?: CliPermissionPreset
  /** The CLI's own mode at `permissionPreset`, read only beside it. */
  permissionMode?: string
  /**
   * Tools the chat's session may use without asking, by its CLI's names for
   * them. They hold for the session this launch starts, as `connectorId`'s
   * servers do; a session started again later (after a restart) asks as its
   * preset says. A CLI whose chat cannot take the list ignores it.
   */
  allowedTools?: string[]
  /** The chat's first message. */
  prompt?: string
  name?: string
  /**
   * Skill ids installed into the chat's working root before its session
   * starts, attached to the first message and kept on the chat as its skill
   * chips. An id no skill answers to refuses the launch (`unknown_skill`).
   */
  skills?: string[]
  /** Pictures sent with the first message. */
  attachments?: ConversationImageAttachment[]
  /** The module that started the chat; only that module reaches it through the module service. */
  ownerModuleId?: string
  /** The caller's namespaced id for this create, kept on the chat so a retry can find it. */
  launchCommandId?: string
  /**
   * The scheduled agent whose run this is. Written on the workspace a new
   * chat is born in (`Workspace.scheduledAgentId`), so the chat says where it
   * came from; a chat joining a workspace that already exists is not a run,
   * and the field is ignored there.
   */
  scheduledAgentId?: string
  /**
   * The label the scheduled agent's creator gave it (`ScheduledAgent.tag`),
   * kept on the run's chat agent (`AgentState.scheduledAgentTag`) beside the
   * workspace's `scheduledAgentId`, so the extension that made the schedule
   * can tell its runs apart. Read only beside `scheduledAgentId`.
   */
  scheduledAgentTag?: string
  /**
   * Open the new chat without bringing it to the front of the window: it
   * joins the list and waits there. For a chat nobody is watching start, like
   * a scheduled run; ignored when joining an existing workspace.
   */
  background?: boolean
  /**
   * The folder the chat works in instead of the workspace checkout: an
   * automation run's worktree. The chat still lives in the workspace.
   */
  worktreePath?: string
  /**
   * The installed MCP server (a connector) the chat runs with, on top of the
   * person's own configuration: an automation that runs with a connector.
   * Resolved as a terminal connector launch resolves it; one that is not
   * installed and enabled refuses the launch (`connector_unavailable`), and a
   * CLI whose chats take no MCP servers of their own refuses the start.
   */
  connectorId?: string
  /** More installed MCP servers the chat runs with, each resolved and refused as `connectorId` is. */
  connectorIds?: string[]
  /**
   * Send `prompt` as the first message (the default). False starts the session
   * and sends nothing, for a caller that sends the first turn itself.
   */
  sendFirst?: boolean
  /**
   * Told when the first message was refused or failed. The launch has already
   * answered by then, so this is the only way a caller waiting on the chat's
   * first turn learns that none is coming.
   */
  onFirstSendFailed?: (message: string) => void
}

export type ConversationLaunchResult =
  | {
      ok: true
      workspaceId: string
      agentId: string
      name: string
      cli: string
      providerId: string
      modelId: string
      sessionId: string
      /**
       * The new worktree's dependency install, still running: the chat and its
       * session are there, and its first message is sent once the install
       * ends, however it ends. Absent when nothing was installing.
       */
      dependencyInstall?: WorktreeDependencyInstallView
      /**
       * The worktree a new chat was started in, cut for it or picked: its
       * folder and branch, for a caller that shows where the chat runs.
       * Absent for a chat in the workspace's own folder.
       */
      worktree?: { path: string; branch: string | null }
    }
  | { ok: false; code: string; message: string }

export type ConversationLaunchServiceDeps = {
  getWorkspace: (workspaceId: string) => ConversationLaunchWorkspace | null
  /** Read at launch time, never cached, as the terminal launch reads it. */
  getLaunchSettings: () => AgentLaunchSettings
  /** Write (or, with null, remove) an agent record through the sequenced workspace bus. */
  writeAgent: (workspaceId: string, agentId: string, agent: AgentState | null) => { ok: boolean; message?: string }
  /** Every workspace, for the name a `newChat` takes beside the others in its folder. */
  listWorkspaces: () => ConversationLaunchWorkspace[]
  /** Create a workspace through the sequenced workspace bus, as a headless create does. */
  createWorkspace: (
    request: WorkspaceCreateRequest,
  ) => { ok: true; workspaceId: string } | { ok: false; message: string }
  removeWorkspace: (workspaceId: string) => void
  startSession: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  send: (
    input: Pick<
      ConversationSendTurnInput,
      'sessionId' | 'commandId' | 'message' | 'skills' | 'attachments' | 'reasoningEffort'
    >,
  ) => Promise<ConversationSessionActionResult>
  /**
   * Make a skill present in the chat's working root, as a terminal launch does
   * (`ensureSkillInstalled`). Absent, requested skills are left to the
   * runtime's own resolver at the first send, and no id is refused up front.
   */
  ensureSkillInstalled?: (workingRoot: string, skillId: string) => Promise<EnsureSkillInstalledResult>
  /**
   * The effort levels a CLI declares (its manifest's `reasoningSelection`),
   * which a requested effort must be one of. Absent, or empty for a CLI, and
   * an effort is not taken.
   */
  reasoningLevels?: (cli: string) => readonly string[]
  /** The repository root a folder is in, asked of the machine's own git; null when it is not in one. */
  getRepoRoot?: (folderPath: string, hostId: ExecutionHostId | null) => Promise<string | null>
  /**
   * Cut an agent worktree on the machine that runs the chat, as a window's New
   * chat does (`createGitWorktree` with `fromPool`). Absent, `newWorktree` is
   * refused as unavailable.
   */
  createWorktree?: (input: {
    repoRoot: string
    containerPath: string
    destinationPath: string
    branchName: string
    hostId: ExecutionHostId | null
  }) => Promise<
    | {
        ok: true
        path: string
        branch: string
        baseRef: string
        /** The project's dependency install, started in the worktree and still running. */
        dependencyInstall?: StartedDependencyInstall
      }
    | { ok: false; message: string }
  >
  /**
   * The worktrees a repository holds, main worktree first, as `git worktree
   * list` names them on the machine that runs the chat. Absent, a launch
   * into an existing worktree is refused as unavailable.
   */
  listWorktrees?: (
    repoRoot: string,
    hostId: ExecutionHostId | null,
  ) => Promise<Array<{ path: string; branch: string | null }> | null>
  /**
   * Count a new chat in the project at this folder, for the project pickers'
   * order (`shared/project-frecency.ts`). Told after a `newChat` launch has
   * started, which is a phone's or a paired machine's New chat: the same use a
   * window's New chat records. A scheduled run (`newChatIn`) is not a person
   * choosing the project, and is not told.
   */
  recordProjectUse?: (folderPath: string) => void
  /** Where a first message the runtime refused is reported; the chat itself shows a failed turn. */
  warn?: (message: string) => void
  /** Agent id suffix. Injected so tests get stable ids. */
  newAgentSuffix?: () => string
  /** The random tail of a new chat's worktree name. Injected so tests get stable names. */
  newWorktreeSuffix?: () => string
  newCommandId?: () => string
}

export type ConversationLaunchService = {
  launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
}

export function createConversationLaunchService(deps: ConversationLaunchServiceDeps): ConversationLaunchService {
  const newAgentSuffix = deps.newAgentSuffix ?? newAgentIdSuffix
  const newCommandId = deps.newCommandId ?? (() => randomUUID())
  const newWorktreeSuffix = deps.newWorktreeSuffix ?? (() => newAgentIdSuffix().slice(0, 4))

  // The worktree a window's New chat cuts with Worktree on
  // (`createNewChatWorktree` in WorkspaceManager.tsx), cut here for a caller
  // with no window: the same repository, name, container, branch and pool, and
  // the same marker, which files the chat under the project it was cut from
  // rather than founding a header named after the slug. Everything works off
  // the project behind the folder, so a chat started from a worktree chat gets
  // a sibling worktree, not one nested inside the other's container.
  async function cutNewChatWorktree(
    workspace: ConversationLaunchWorkspace,
    folderPath: string,
    worktreeName: string | undefined,
  ): Promise<
    | { ok: true; folderPath: string; worktree: WorkspaceWorktree; dependencyInstall?: StartedDependencyInstall }
    | { ok: false; message: string }
  > {
    // A folder on an SSH machine is not this computer's to fork: a window's
    // New chat does not offer the worktree there either.
    if (isMachinePath(folderPath)) {
      return { ok: false, message: 'A chat on an SSH machine starts in its folder there; it cannot have a worktree.' }
    }
    if (!deps.getRepoRoot || !deps.createWorktree) {
      return { ok: false, message: 'This Studio cannot make worktrees for the chats it starts.' }
    }
    const projectFolder = workspaceProjectRootOf(workspace) ?? folderPath
    // The machine the chat runs on makes its worktree too: a worktree made by
    // another machine's git names a gitdir this one cannot follow.
    const hostId = workspace.hostId ?? null
    const repoRoot = await deps.getRepoRoot(projectFolder, hostId).catch(() => null)
    if (!repoRoot) {
      return {
        ok: false,
        message: `${projectFolder} is not a git repository, so a worktree cannot be created. Start the chat without one.`,
      }
    }
    const suffix = newWorktreeSuffix()
    const name = worktreeName ? `${worktreeName}-${suffix.toLowerCase()}` : newChatWorktreeName(suffix)
    const { worktreeBranchPrefix } = effectiveAgentLaunchSettings(deps.getLaunchSettings())
    const paths = agentWorktreePaths(repoRoot, name, worktreeBranchPrefix)
    if (!paths) return { ok: false, message: `"${name}" does not reduce to a usable worktree name.` }
    const made = await deps
      .createWorktree({
        repoRoot,
        containerPath: paths.containerPath,
        destinationPath: paths.destinationPath,
        branchName: paths.branchName,
        hostId,
      })
      .catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }))
    if (!made.ok) return { ok: false, message: `The chat's worktree could not be made: ${made.message}` }
    return {
      ok: true,
      folderPath: made.path,
      worktree: { branch: made.branch, baseRef: made.baseRef, repoRoot: projectFolder },
      ...(made.dependencyInstall ? { dependencyInstall: made.dependencyInstall } : {}),
    }
  }

  // A worktree the project already has, named by a caller that read it off
  // `workspace.checkout`: the chat is born in it, marked as a worktree of the
  // project as the Worktree panel's Open marks one, so it files under that
  // project. Only a path git lists for the repository is taken. The main
  // worktree is the project's own checkout and answers null: no worktree.
  async function findExistingWorktree(
    workspace: ConversationLaunchWorkspace,
    folderPath: string,
    requestedPath: string,
  ): Promise<
    { ok: true; worktree: { folderPath: string; marker: WorkspaceWorktree } | null } | { ok: false; message: string }
  > {
    if (isMachinePath(folderPath)) {
      return { ok: false, message: 'A chat on an SSH machine starts in its folder there; it cannot pick a worktree.' }
    }
    if (!deps.getRepoRoot || !deps.listWorktrees) {
      return { ok: false, message: 'This Studio cannot start a chat in an existing worktree.' }
    }
    const projectFolder = workspaceProjectRootOf(workspace) ?? folderPath
    const hostId = workspace.hostId ?? null
    const repoRoot = await deps.getRepoRoot(projectFolder, hostId).catch(() => null)
    if (!repoRoot) return { ok: false, message: `${projectFolder} is not a git repository, so it has no worktrees.` }
    const worktrees = await deps.listWorktrees(repoRoot, hostId).catch(() => null)
    if (!worktrees) return { ok: false, message: `The worktrees of ${projectFolder} could not be read.` }
    const wanted = trimTrailingSeparators(requestedPath)
    const index = worktrees.findIndex((entry) => trimTrailingSeparators(entry.path) === wanted)
    if (index < 0) {
      return {
        ok: false,
        message: `${requestedPath} is not a worktree of ${projectFolder}. Pick one of the worktrees it lists.`,
      }
    }
    if (index === 0) return { ok: true, worktree: null }
    const entry = worktrees[index]!
    return {
      ok: true,
      worktree: {
        folderPath: entry.path,
        marker: { ...(entry.branch ? { branch: entry.branch } : {}), repoRoot: projectFolder },
      },
    }
  }

  async function launch(request: ConversationLaunchRequest): Promise<ConversationLaunchResult> {
    // A chat born in a folder has no workspace to read the folder, machine and
    // worktree off, so it stands in for one that has no agents yet.
    const newChat = request.newChat === true || request.newChatIn !== undefined
    const workspace: ConversationLaunchWorkspace | null = request.newChatIn
      ? {
          id: '',
          folderPath: request.newChatIn.folderPath,
          hostId: request.newChatIn.hostId ?? null,
          worktree: request.newChatIn.worktree ?? null,
          agents: {},
        }
      : request.workspaceId
        ? deps.getWorkspace(request.workspaceId)
        : null
    if (!workspace) {
      return {
        ok: false,
        code: 'unknown_workspace',
        message: `Workspace "${request.workspaceId ?? ''}" is not known to the running app.`,
      }
    }
    const workspaceRoot = workspace.folderPath?.trim()
    if (!workspaceRoot) {
      return {
        ok: false,
        code: 'workspace_folder_missing',
        message: `Workspace "${workspace.id}" has no project folder, so there is nowhere to start the chat.`,
      }
    }

    const settings = effectiveAgentLaunchSettings(deps.getLaunchSettings())
    const cli = request.cli?.trim() || settings.lastSelectedCli || ''
    if (!cli) {
      return { ok: false, code: 'no_cli_selected', message: 'No CLI was requested and no last-selected CLI is set.' }
    }
    // Never another CLI in its place: the caller picked this one on its own
    // launcher, and a chat on a different CLI would not be what it showed.
    const providerId = conversationProviderForCli(cli)
    if (!providerId) {
      return {
        ok: false,
        code: 'cli_not_conversational',
        message: `"${cli}" cannot run as a chat agent here. Pick another CLI, or start it as a terminal agent.`,
      }
    }
    // Never a chat that silently runs without a connector it was asked for.
    const connectorIds = [
      ...new Set([request.connectorId, ...(request.connectorIds ?? [])].map((id) => id?.trim()).filter(Boolean)),
    ] as string[]
    const mcpServers: ConversationMcpServer[] = []
    for (const connectorId of connectorIds) {
      const connector = resolveConnectorLaunchFrom({ connectorId, installedServers: settings.mcp?.servers })
      if (!connector.ok) return { ok: false, code: 'connector_unavailable', message: connector.message }
      mcpServers.push(...Object.values(connector.resolved.mcpSettings.servers).map(conversationMcpServer))
    }
    // The levels the CLI declares are the ones its picker offers. A CLI that
    // declares none has no effort to set, and the request is not taken.
    const requestedEffort = request.reasoningEffort?.trim() || undefined
    const effortLevels = deps.reasoningLevels?.(cli) ?? []
    if (requestedEffort && effortLevels.length > 0 && !effortLevels.includes(requestedEffort)) {
      return {
        ok: false,
        code: 'unsupported_effort',
        message: `"${cli}" has no effort level "${requestedEffort}". Its levels are ${effortLevels.join(', ')}.`,
      }
    }
    const reasoningEffort = requestedEffort && effortLevels.length > 0 ? requestedEffort : undefined
    if (request.newWorktree === true && request.newChat !== true) {
      return {
        ok: false,
        code: 'invalid_arguments',
        message: 'A worktree is cut only for a new chat: ask for "newChat" with it.',
      }
    }
    const existingWorktreePath = request.existingWorktreePath?.trim() || undefined
    if (existingWorktreePath && request.newChat !== true) {
      return {
        ok: false,
        code: 'invalid_arguments',
        message: 'A chat starts in an existing worktree only as a new chat: ask for "newChat" with it.',
      }
    }
    if (existingWorktreePath && request.newWorktree === true) {
      return {
        ok: false,
        code: 'invalid_arguments',
        message: 'Ask for a new worktree or name an existing one, not both.',
      }
    }
    const modelId = request.cliModel?.trim() || CONVERSATION_DEFAULT_MODEL_ID
    const permission = resolveAgentSpawnPermission(settings, cli, request.permissionPreset)
    const permissionPreset = permission.preset
    // A mode of the CLI's own only where its chat runs it; elsewhere the
    // preset's own mode.
    const ownMode = request.permissionPreset ? parseCliPermissionModeId(request.permissionMode) : permission.mode
    const permissionMode = ownMode && conversationPermissionModes(cli).includes(ownMode) ? ownMode : undefined
    const allowedTools = [...new Set((request.allowedTools ?? []).map((tool) => tool.trim()).filter(Boolean))]
    // A new chat's own worktree, last of the checks and before anything is
    // written: it is the folder the chat is born in, so the skills below are
    // installed into it. A launch refused after this leaves the worktree
    // behind, as a window's New chat that fails after cutting one does; a pool
    // slot comes back with the pool's return sweep, which takes back a lease
    // no chat has been seen to hold.
    let chatFolder = workspaceRoot
    let chatWorktree = workspace.worktree ?? null
    let installing: StartedDependencyInstall | null = null
    // The worktree the new chat runs in, for the answer: one cut for it here,
    // or one the project already had.
    let launchedWorktree: { path: string; branch: string | null } | null = null
    if (request.newWorktree === true) {
      const cut = await cutNewChatWorktree(workspace, workspaceRoot, request.worktreeName?.trim() || undefined)
      if (!cut.ok) return { ok: false, code: 'worktree_unavailable', message: cut.message }
      chatFolder = cut.folderPath
      chatWorktree = cut.worktree
      installing = cut.dependencyInstall ?? null
      launchedWorktree = { path: cut.folderPath, branch: cut.worktree.branch ?? null }
    } else if (existingWorktreePath) {
      const found = await findExistingWorktree(workspace, workspaceRoot, existingWorktreePath)
      if (!found.ok) return { ok: false, code: 'worktree_unavailable', message: found.message }
      if (found.worktree) {
        chatFolder = found.worktree.folderPath
        chatWorktree = found.worktree.marker
        launchedWorktree = { path: found.worktree.folderPath, branch: found.worktree.marker.branch ?? null }
      }
    }
    // The run worktree when there is one: the session starts there, so the
    // agent's edits, its transcript and the skills below all stay inside it.
    const worktreePath = request.worktreePath?.trim() || undefined
    const workingRoot = worktreePath ?? chatFolder

    // Skills first, before anything is written: an id nothing answers to is
    // the caller's mistake and refuses the launch, where a copy that could not
    // be written is only reported — the runtime installs a missing skill again
    // when the first message attaches it.
    const skills = [...new Set((request.skills ?? []).map((id) => id.trim()).filter(Boolean))]
    // A folder on an SSH machine (`ssh://…`) is not this computer's to write
    // a skill into: the machine's own runtime attaches skills there.
    if (deps.ensureSkillInstalled && !isMachinePath(workingRoot)) {
      for (const skillId of skills) {
        const installed = await deps
          .ensureSkillInstalled(workingRoot, skillId)
          .catch((error: unknown): EnsureSkillInstalledResult => ({
            ok: false,
            status: 'install-failed',
            message: error instanceof Error ? error.message : String(error),
          }))
        if (installed.ok) continue
        if (installed.status === 'unknown-skill') {
          return { ok: false, code: 'unknown_skill', message: `No skill "${skillId}" is available to attach.` }
        }
        deps.warn?.(
          `Skill "${skillId}" could not be installed for a chat in "${workspace.id}": ${installed.message ?? installed.status}`,
        )
      }
    }

    // An id of its own either way, unique across workspaces. A new chat's agent
    // fills its workspace's one template tab (`templateAgentIds` below), so the
    // tab names it rather than the template's placeholder every chat shared.
    const agentId = `agent-${cli}-${newAgentSuffix()}`
    const name =
      request.name?.trim() ||
      pickRandomAgentName(
        newChat
          ? []
          : Object.values(workspace.agents ?? {})
              .map((agent) => agent?.name)
              .filter((taken): taken is string => Boolean(taken)),
      )
    // The same record a window's New chat writes (`conversationNewChatSeed`),
    // minus the startup prompt: that field asks a mounting chat view to send
    // it, and here main sends it itself.
    const agent: AgentState = {
      ...defaultAgent(agentId, name),
      runtimeKind: 'conversation',
      conversation: { providerId, modelId },
      cliPermissionPreset: permissionPreset,
      ...(permissionMode ? { cliPermissionMode: permissionMode } : {}),
      // Where a window's New chat keeps its effort pick, and where every
      // window's chat view and a paired device's send read it for each turn.
      ...(reasoningEffort ? { conversationReasoningEffort: reasoningEffort } : {}),
      // Where a window's chat view finds the session: a worktree chat is keyed
      // by the worktree, not the workspace folder (`conversationWorkingRoot`).
      ...(worktreePath ? { execution: { mode: 'worktree' as const, worktreeId: null, cwd: worktreePath } } : {}),
      ...(skills.length > 0 ? { conversationSkills: skills } : {}),
      ...(request.ownerModuleId?.trim() ? { ownerModuleId: request.ownerModuleId.trim() } : {}),
      ...(request.launchCommandId ? { launchCommandId: request.launchCommandId } : {}),
      ...(newChat && request.scheduledAgentId?.trim() && request.scheduledAgentTag?.trim()
        ? { scheduledAgentTag: request.scheduledAgentTag.trim() }
        : {}),
    }
    let chatWorkspaceId = workspace.id
    if (newChat) {
      // Named after the message it is about to be sent, so the chat has its
      // title the moment it is listed anywhere, a phone included, rather than
      // "Chat N" until its first message has gone. The name stays open: the
      // chat's titler (`text-generation/chat-titler.ts`) hears that message
      // like any other, locks the name, and replaces it with a model-written
      // title when one is on. A chat made with no prompt (a phone's New chat
      // with pictures, whose first message follows through its ordinary send)
      // is named by the titler from that message instead.
      const firstTitle = request.sendFirst !== false && request.prompt ? deriveWorkspaceTitle(request.prompt) : null
      // Born with its agent, in one event, so a window never shows the
      // template's tab with no agent behind it.
      const created = deps.createWorkspace({
        name:
          firstTitle ??
          nextNewChatName(
            deps
              .listWorkspaces()
              .filter((other) => other.folderPath === chatFolder)
              .map((other) => other.name ?? ''),
          ),
        ...(firstTitle ? { titleOpen: true } : {}),
        folderPath: chatFolder,
        templateId: SOLO_CHAT_TEMPLATE_ID,
        ...(workspace.hostId ? { hostId: workspace.hostId } : {}),
        ...(chatWorktree ? { worktree: chatWorktree } : {}),
        ...(request.scheduledAgentId?.trim() ? { scheduledAgentId: request.scheduledAgentId.trim() } : {}),
        ...(request.background ? { background: true } : {}),
        templateAgentIds: { [SOLO_CHAT_TEMPLATE_AGENT_ID]: agentId },
        agents: { [agentId]: agent },
      })
      if (!created.ok) return { ok: false, code: 'workspace_create_failed', message: created.message }
      chatWorkspaceId = created.workspaceId
    } else {
      const written = deps.writeAgent(workspace.id, agentId, agent)
      if (!written.ok) {
        return {
          ok: false,
          code: 'agent_write_failed',
          message: written.message ?? `The chat could not be added to workspace "${workspace.id}".`,
        }
      }
    }

    // The chat's CLI on the machine the chat runs on: a WSL workspace's chat
    // runs that distribution's CLI, whichever it is, as a window's chat would.
    // A workspace that records no machine runs where its folder defaults to,
    // as the router and Studio's git read it (owner ruling 2026-10-03).
    const cliRuntimes = conversationCliRuntimesForHost(
      settings.cliRuntimes,
      workspaceHostIdOf(workspace),
      settings.hosts,
    )
    const started = await deps
      .startSession({
        workspaceRoot: workingRoot,
        workspaceId: chatWorkspaceId,
        agentId,
        providerId,
        modelId,
        // The person's command overrides, as a window's chat passes them.
        ...(Object.keys(cliRuntimes ?? {}).length > 0
          ? { cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides }
          : {}),
        permissionPreset,
        ...(permissionMode ? { permissionMode } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
      })
      .catch((error: unknown): ConversationStartSessionResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'The conversation could not start.',
      }))
    if (!started.ok) {
      if (newChat) deps.removeWorkspace(chatWorkspaceId)
      else deps.writeAgent(workspace.id, agentId, null)
      return { ok: false, code: 'conversation_start_failed', message: started.message }
    }

    // The folder the person picked, as its project list showed it: not the
    // worktree this chat may have been given.
    if (request.newChat === true) deps.recordProjectUse?.(workspaceRoot)

    const prompt = request.prompt?.trim()
    if (prompt && request.sendFirst !== false) {
      const sessionId = started.session.sessionId
      const failed = (message: string): void => {
        deps.warn?.(message)
        request.onFirstSendFailed?.(message)
      }
      // The chat's worktree is still installing its dependencies: the chat
      // and its session are there, and say so (the chat view shows the
      // install), and the first message goes once the install ends, however
      // it ends — a failure is the person's toast and bell row, never a chat
      // that never starts. Nothing goes while the app quits.
      const ready: Promise<boolean> = installing
        ? installing.settled.then(
            (ended) => ended !== null,
            () => true,
          )
        : Promise.resolve(true)
      // At the chat's effort only where its provider runs that level, as a
      // window's chat view sends each turn: a level the CLI's terminal takes
      // and its chat does not (Codex's `max`) runs at the provider's default.
      const turnEffort =
        reasoningEffort && started.session.capabilities?.reasoningEfforts?.includes(reasoningEffort)
          ? reasoningEffort
          : undefined
      void ready
        .then(async (go) => {
          if (!go) return
          const sent = await deps.send({
            sessionId,
            commandId: newCommandId(),
            message: prompt,
            ...(turnEffort ? { reasoningEffort: turnEffort } : {}),
            ...(skills.length > 0 ? { skills: skills.map((id) => ({ id })) } : {}),
            ...(request.attachments?.length ? { attachments: request.attachments } : {}),
          })
          if (!sent.ok) failed(`The first message of chat "${agentId}" was refused: ${sent.message}`)
        })
        .catch((error: unknown) => {
          failed(
            `The first message of chat "${agentId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }

    return {
      ok: true,
      workspaceId: chatWorkspaceId,
      agentId,
      name,
      cli,
      providerId,
      modelId,
      sessionId: started.session.sessionId,
      ...(installing ? { dependencyInstall: installing.current() } : {}),
      ...(launchedWorktree ? { worktree: launchedWorktree } : {}),
    }
  }

  return { launch }
}

/** A path as two spellings of the same folder compare: without the separators that end it. */
function trimTrailingSeparators(path: string): string {
  return path.trim().replace(/(.)[\\/]+$/u, '$1')
}

// An installed server as a session takes it: what the CLI needs to start or
// reach it, without the settings-only fields.
function conversationMcpServer(server: McpServerConfig): ConversationMcpServer {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    ...(server.envVarNames?.length ? { envVarNames: server.envVarNames } : {}),
  }
}
