import { hostname } from 'node:os'
import { join } from 'node:path'

import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { conversationWorkingRoot } from '../../shared/agent-state'
import { getWorkspaceChangeSummary } from '../../main/workspace-change-summary'
import { isMachinePath } from '../../shared/machine-paths'
import { isWorkspaceTombstoned } from '../../shared/workspace-registry'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import { gitHostIdForPath, type ExecutionHostId, type ExecutionHostSettings } from '../../shared/execution-host'
import { ensureSkillInstalled } from '../../main/builtin-skills'
import { cliResumeCapabilities } from '../../main/cli-resume-capabilities'
import {
  createAgentPermissionResolver,
  type AgentPermissionResolver,
} from '../../main/automation/launch-permission-cap'
import { createConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import { resolveCheckoutForCwd } from '../../main/checkout-resolve'
import {
  conversationBranchesOf,
  conversationCheckoutsOf,
  conversationHostOf,
  conversationPullRequestsOf,
  tailnetSelfMachine,
  type ConversationMachineContext,
} from '../../main/automation/tailnet/tailnet-conversation-machine'
import { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import {
  ConversationAttachmentStore,
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { attachmentImagesRoot } from '../../main/attachment-image-file'
import { createConversationLaunchService } from '../../main/conversation-launch-service'
import { createConversationImportService } from '../../main/conversation-import/conversation-import-service'
import { createConversationModelCatalog } from '../../main/conversation-model-catalog'
import { ConversationPlanStore } from '../../main/conversation-plan-store'
import { ConversationRuntime, type ConversationRuntimeOptions } from '../../main/conversation-runtime'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { createGitWorktree, getGitRepoRoot } from '../../main/git'
import { listGitWorktrees } from '../../main/git-worktree-list'
import { startedDependencyInstall } from '../../main/worktree-pool/dependency-install'
import { installGitHostResolver, withGitHost } from '../../main/git-run'
import { createHostRegistry, installHostRegistry } from '../../main/hosts/host-registry'
import { createAgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { setWorktreeBranchPrefixReader } from '../../main/worktree-branch-prefix'
import { readDiscoveredCliModelCatalogs } from '../../main/model-discovery/service'
import { listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { powerActivity } from '../../main/power-activity'
import { getSharedCredentialStore } from '../../main/secret-store'
import { createWorkspaceRegistryService } from '../../main/workspace-registry-service'
import { createWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../main/workspace-sync-service'
import { startWorkspaceStoreMigration } from '../../main/workspace-store-migration'
import { knownCliAvailability } from '../../main/cli-availability'
import { createChatTitler } from '../../main/text-generation/chat-titler'
import { generateChatTitle } from '../../main/text-generation/text-generation-service'
import { createTextGenerationSettingsStore } from '../../main/text-generation/text-generation-settings-store'
import {
  createConversationLifecycle,
  latestTurnEnd,
  onlyOwnChatTurn,
} from '../../main/automation/conversation-lifecycle'
import { conversationSessionWorking, terminalAgentWorking } from '../../shared/conversation/phase'
import type { ConversationMessageOrigin, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { installedStudioPlatform, installStudioPlatform, type StudioPlatform } from '../platform/platform'
import type { StudioPaths } from '../platform/studio-paths'
import { createPullRequestDomain } from '../pull-requests/pull-request-domain'
import { createLocalServerDomain } from '../local-servers/local-server-domain'
import { localConversationBackend, refuseMachinePaths, type ConversationBackend } from './conversation-backend'
import {
  createRoutedConversationBackend,
  type SshRoutedConnection,
  type SshRoutedServers,
} from './routed-conversation-backend'
import type { WslServers } from '../wsl/desktop-wsl-servers'
import type { StudioRole } from './data-dir'
import { takeDataDir } from './take-data-dir'
import { createStudioUsageLimitResumes } from './studio-usage-limit-resumes'
import { studioPullRequestWakes } from './studio-pull-request-wakes'
import { createStudioScheduledMessages, studioHeldMessages } from './studio-scheduled-messages'
import { createStudioAutoCompact } from './studio-auto-compact'

// The Studio core: the services the server owns (studio-server design, section
// 4.1), composed once. The desktop builds it inside Electron main, from
// `createAppServices`, with the Electron platform; the standalone server
// (src/server/main.ts) builds it under plain Node with the Node platform. Both
// go through this function, so there is one wiring of the core and not two
// that drift.
//
// What is here: launch settings and the machines they name, the workspace
// registry and its sync, git's machine resolver, the conversation runtime and
// the backend every caller drives chats through (providers, checkpoints, the
// thread index and transcripts are the runtime's), the model catalog, the
// launch service that starts a chat for a caller with no window, the pull
// request record, which reacts to chats and so is the server's (owner ruling
// 2026-10-03), and the local servers the agents started, which are checked
// where the agents run (owner ruling 2026-10-04). The MCP
// gateway is composed beside it (studio-gateway.ts), because the desktop adds
// tools to it that act on windows and terminals.
//
// What is not, yet: the module host and its bundled modules (they still take
// the shell's terminal runtime and account bridge), terminals (owner ruling
// 2026-10-01: not served by the server in v1), and everything the shell owns.
// What is not, ever: the browser and the canvas (owner ruling 2026-10-02: the
// server draws nothing). They are toolsets a client offers, which the gateway
// lists and routes (src/server/tools/); the server keeps only the board files,
// read and written through `files.*`.

export type StudioCoreOptions = {
  /** Which kind of process this core runs in; decides the lock and secret rules below. */
  role: StudioRole
  /**
   * How a Claude chat's child reaches this process's MCP gateway, on the machine
   * its `claude` runs on. Null for no gateway entry.
   */
  resolveStudioMcpServer?: ConversationRuntimeOptions['resolveStudioMcpServer']
  /**
   * Brings a chat's folder back before an agent runs in it, where this
   * process keeps a worktree pool that may have given it back
   * (main/worktree-pool/chat-folder-guard.ts). A server keeps no pool.
   */
  prepareChatFolder?: ConversationRuntimeOptions['prepareChatFolder']
  /**
   * The agent terminals this process runs, for the gateway's launch cap: an
   * agent may start agents only at its own preset or stricter. A server has
   * none (owner ruling 2026-10-01), so it defaults to an empty list.
   */
  listTerminalSessions?: () => ReadonlyArray<{
    kind?: string
    workspaceId?: string
    agentId?: string
    processAlive: boolean
    /** What the terminal is doing, for Settle from another device: one mid-turn is working. */
    activity?: { kind: string }
    agentRecord?: { cliPermissionPreset?: unknown }
  }>
  /** A machine's settings changed (a distribution turned on or off). */
  onHostSettingsChanged?: () => void
  /**
   * Windows: the WSL distributions whose chats can run on a Studio server
   * inside them (phase 7). Given, every caller's chats go through a router
   * that sends a distribution's chats to its server when its switch is on.
   */
  wslServers?: (deps: { readHostSettings: () => Partial<Record<ExecutionHostId, ExecutionHostSettings>> }) => WslServers
  /**
   * The desktop's SSH machines (phase 8), held by Electron main, which shows
   * their prompts. Given, a workspace recorded on one runs its chats there.
   * In process only: out of process, main's sessions are not this core's.
   */
  sshServers?: {
    servers: SshRoutedServers
    onConnected(listener: (connection: SshRoutedConnection) => void): void
    /**
     * A saved SSH machine's host, as its SSH config resolves it (else as it
     * was typed), and its resolved port: what its kind and colour are keyed
     * by. Without it a paired phone is not told which SSH machine a chat runs on.
     */
    machineOf?(savedId: string): { host: string; port?: number | null } | null
  }
}

export { StudioDataDirBusyError, StudioDataDirUnusableError } from './take-data-dir'

export type StudioCore = ReturnType<typeof createStudioCore>

export function createStudioCore(platform: StudioPlatform, options: StudioCoreOptions) {
  // Installed first, so a free function deep in the graph (the credential
  // store, a resource lookup) reads this platform even when the caller has not
  // installed one. The desktop's entry has already installed the same one.
  if (installedStudioPlatform() !== platform) installStudioPlatform(platform)
  const dataDir = platform.paths.dataDir()
  const taken = takeDataDir(platform, options.role)
  const dataDirLock = taken.lock

  const logDiagnostic =
    (source: 'agents' | 'workspace') =>
    (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => {
      void writeDiagnosticLog({ ...diagnostic, source })
    }

  // The agent-launch settings (CLI runtimes, MCP, knowledge roots, last CLI,
  // spawn permission preset). The core owns them: clients read and patch this
  // store, and every launch the core makes reads it.
  const agentLaunchSettings = createAgentLaunchSettingsStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('agents'),
  })
  // The prefix every worktree branch this process names starts with, and the
  // ones its cleanup recognises: read from the record on each use, so a
  // change in Settings ▸ Worktrees names the next one.
  setWorktreeBranchPrefixReader(() => effectiveAgentLaunchSettings(agentLaunchSettings.get()).worktreeBranchPrefix)

  // The machines this computer offers (shared/execution-host.ts): this one,
  // and on Windows each WSL distribution. One registry, installed for the whole
  // process, so a launch, the reaper and the git runner resolve a host against
  // the same per-machine settings.
  // Built before the WSL servers (below), so their status is read when listed.
  let wslServersForHosts: WslServers | null = null
  const hosts = createHostRegistry({
    readHostSettings: () => agentLaunchSettings.get().hosts,
    chatServer: (distro) => {
      const servers = wslServersForHosts
      if (!servers) return undefined
      const status = servers.manager.status(distro)
      return {
        on: servers.chatServerOn(distro),
        state: status.state,
        ...(status.transport ? { transport: status.transport } : {}),
        ...((status.reason ?? status.transportReason) ? { reason: status.reason ?? status.transportReason } : {}),
      }
    },
  })
  installHostRegistry(hosts)
  let lastHostSettings = JSON.stringify(agentLaunchSettings.get().hosts)
  agentLaunchSettings.subscribe((record) => {
    const next = JSON.stringify(record.settings.hosts)
    if (next === lastHostSettings) return
    lastHostSettings = next
    hosts.notifyChanged()
    options.onHostSettingsChanged?.()
  })

  // The authoritative workspace registry. Routing lives in the record, so no
  // side-map of names, folders or modes is needed beside it.
  const workspaceRegistryStore = createWorkspaceRegistryStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('workspace'),
  })
  const workspaceRegistry = createWorkspaceRegistryService({
    store: workspaceRegistryStore,
    logDiagnostic: logDiagnostic('workspace'),
  })
  const workspaceSyncService = createWorkspaceSyncService({
    registry: workspaceRegistry,
    resolveResumeCapabilities: cliResumeCapabilities,
  })

  // Git for a repository runs on the machine of the open workspace holding
  // it, which is where its agents run theirs: a `C:\` folder of a WSL
  // workspace in that distribution, and a folder inside a distribution on
  // This PC when its workspace runs here (owner ruling 2026-10-03). A folder
  // no workspace holds goes by where it lives. macOS and Linux have one
  // machine, so their git never asks.
  installGitHostResolver((cwd) => {
    if (process.platform !== 'win32') return null
    const id = gitHostIdForPath(cwd, workspaceSyncService.getSnapshot().state.workspaces)
    return id ? hosts.get(id) : null
  })

  // The conversation runtime: chat sessions and the providers and agent CLI
  // children behind them, transcripts, the thread index and checkpoints. Owned
  // here so the owner's shutdown disposes its child processes.
  // The saved approvals, which a revoked app's tools leave with it.
  const approvalRules = new ConversationApprovalRuleStore(dataDir)
  const conversationRuntime = new ConversationRuntime({
    secretStore: getSharedCredentialStore(),
    approvalRules,
    attachmentStore: new ConversationAttachmentStore(dataDir),
    planStore: new ConversationPlanStore(dataDir),
    ...(options.resolveStudioMcpServer ? { resolveStudioMcpServer: options.resolveStudioMcpServer } : {}),
    ...(options.prepareChatFolder ? { prepareChatFolder: options.prepareChatFolder } : {}),
  })
  conversationRuntime.startIdleSweep(powerActivity)
  // Each project's state lives in its store in the person's home, on the
  // machine its chats run on (main/workspace-store.ts). An older build kept it
  // in `<project>/.sprintengine/`: moved out the first time a folder reaches
  // the store, and in the background, from the next turn of the loop, for
  // every project the registry holds, so a chat's history is in place before
  // anyone opens it.
  startWorkspaceStoreMigration(
    () => workspaceSyncService.getSnapshot().state.workspaces.map((workspace) => workspace.folderPath),
    { log: (message) => console.info(`[workspace-store] ${message}`) },
  )
  const wslServers =
    process.platform === 'win32' && options.wslServers
      ? options.wslServers({ readHostSettings: () => agentLaunchSettings.get().hosts })
      : null
  // What only the runtime's owner does with it: the idle threshold, hearing
  // when one of this process's chats lets go of its turn, and the flush and
  // shutdown at the end. Everything else goes through the backend.
  const conversationOwner = {
    setIdleThresholdMs: (value: unknown) => conversationRuntime.setIdleThresholdMs(value),
    onSessionIdle: (listener: (summary: ConversationSessionSummary) => void) =>
      conversationRuntime.onSessionIdle(listener),
    flushTranscripts: () => conversationRuntime.flushTranscripts(),
    // Each WSL server drains its own chats, within the quit's ten seconds,
    // beside this process's.
    shutdown: async () => {
      await Promise.all([
        wslServers?.manager.shutdown({ budgetMs: 10_000 }).catch(() => undefined),
        conversationRuntime.shutdown(),
      ])
    },
  }
  // What every caller drives chats through; the runtime itself is only for
  // what its owner does (the idle sweep, flush, shutdown). On Windows, with
  // WSL servers, a router in front of it sends a distribution's chats there.
  // A chat whose folder is on an SSH machine never runs in this process.
  const localConversations = refuseMachinePaths(localConversationBackend(conversationRuntime))
  let conversations: ConversationBackend = localConversations
  const sshServers = options.sshServers ?? null
  if (wslServers || sshServers) {
    if (wslServers) {
      wslServersForHosts = wslServers
      // Settings › Machines reads the server's state with the machine list.
      wslServers.onStatus(() => hosts.notifyChanged())
    }
    const routed = createRoutedConversationBackend({
      local: localConversations,
      workspace: (workspaceId) => workspaceRegistry.getRecord(workspaceId) ?? null,
      chatServerOn: (distro) => wslServers?.chatServerOn(distro) ?? false,
      servers: wslServers?.manager ?? null,
      ssh: sshServers?.servers ?? null,
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Remote server', message })
      },
    })
    wslServers?.onConnected((connection) => routed.attach(connection))
    // A distribution's server that stopped under its chats (a crash, `wsl
    // --shutdown`): the turns it was running show as interrupted now, not
    // when the server next starts and its transcripts are read again.
    wslServers?.onStatus((status) => {
      if (status.state === 'unavailable' || status.state === 'shut-down')
        routed.lost(status.distro, `The Studio server in ${status.distro} stopped while this turn was running.`)
    })
    sshServers?.onConnected((connection) => routed.attach(connection))
    conversations = routed
  }

  const conversationModelCatalog = createConversationModelCatalog({
    listClis: () => listPluginRegistryEntries(),
    readDiscovered: () => readDiscoveredCliModelCatalogs(),
    userModels: (cli) => agentLaunchSettings.get().cliRuntimes[cli]?.models,
  })

  // Starting a chat for a caller with no window to start it in (a paired
  // machine's New chat, `conversation.create`, a module). The record goes
  // through the sequenced bus like any agent the core registers, so every
  // client hears about the chat the moment it exists.
  const conversationLaunchService = createConversationLaunchService({
    getWorkspace: (workspaceId) => workspaceRegistry.getRecord(workspaceId) ?? null,
    getLaunchSettings: () => agentLaunchSettings.get(),
    writeAgent: (workspaceId, agentId, agent) =>
      workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => workspaceRegistry.getRecords(),
    createWorkspace: (request) => {
      const created = workspaceSyncService.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      workspaceSyncService.removeWorkspace(workspaceId, 'system')
    },
    startSession: (input) => conversations.startSession(input),
    send: (input) => conversations.sendTurn(input),
    recordProjectUse: (folderPath) => {
      agentLaunchSettings.update({ projectUse: { folderPath, at: Date.now() } }, 'system')
    },
    // The levels the CLI's picker offers, from the same manifests it reads.
    reasoningLevels: (cli) =>
      listPluginRegistryEntries()
        .find((entry) => entry.id === cli)
        ?.reasoningSelection?.levels.map((level) => level.id) ?? [],
    // A new chat's worktree, cut by the machine the chat runs on, as a
    // scheduled run's is: from the worktree pool when this process keeps one
    // (the desktop's main does; a server out of process forks a fresh one), on
    // the default branch, locked to its branch until the chat claims it.
    getRepoRoot: (folderPath, hostId) =>
      withGitHost(hostId ? hosts.get(hostId) : null, () => getGitRepoRoot(folderPath)),
    createWorktree: async (input) => {
      const created = await withGitHost(input.hostId ? hosts.get(input.hostId) : null, () =>
        createGitWorktree({
          repoRoot: input.repoRoot,
          containerPath: input.containerPath,
          destinationPath: input.destinationPath,
          branchName: input.branchName,
          baseRef: 'HEAD',
          fromPool: true,
          copyIncludedFiles: true,
          // The chat is created after its worktree, so the branch names the owner.
          agentLockOwner: input.branchName,
          // Every caller here is a client with a call timeout of its own (a
          // paired device's New chat, `conversation.create`): the chat is
          // made while the project's dependency install runs, and its first
          // message waits for it instead.
          dependencyInstall: 'start',
        }),
      )
      if (!created.ok) return { ok: false, message: created.message }
      const installing = startedDependencyInstall(created.data.dependencyInstall)
      return {
        ok: true,
        path: created.data.path,
        branch: created.data.branch ?? input.branchName,
        baseRef: created.data.baseRef,
        ...(installing ? { dependencyInstall: installing } : {}),
      }
    },
    // The worktrees a new chat may be started in, read as `workspace.checkout`
    // reads them for the picker that named one: bare entries dropped, the main
    // worktree first. Asked of the machine the chat runs on.
    listWorktrees: async (repoRoot, hostId) => {
      const listed = await withGitHost(hostId ? hosts.get(hostId) : null, () =>
        listGitWorktrees(repoRoot, { resolvedRoot: true }),
      )
      if (!listed.ok) return null
      return listed.data.worktrees
        .filter((entry) => !entry.bare)
        .map((entry) => ({ path: entry.path, branch: entry.branch }))
    },
    // The same installer a terminal launch's skill-at-spawn uses, into the
    // folder the chat works in (a run's worktree when it has one).
    ensureSkillInstalled: (workingRoot, skillId) => ensureSkillInstalled(workingRoot, skillId),
    warn: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Chat launch', message })
    },
  })

  // The sessions a person ran in an agent CLI's own terminal, brought in as
  // chats (conversation-import-service.ts). The CLIs' homes it reads are this
  // machine's, so the chats it writes are this process's own runtime's, never
  // a router's: a session ran here, in a folder here.
  const conversationImport = createConversationImportService({
    listWorkspaces: () => workspaceRegistry.getRecords(),
    createWorkspace: (request) => {
      const created = workspaceSyncService.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      workspaceSyncService.removeWorkspace(workspaceId, 'system')
    },
    importTranscript: (input) => conversationRuntime.importTranscript(input),
    getLaunchSettings: () => agentLaunchSettings.get(),
  })

  // The pull requests the conversations opened (pull-request-domain.ts): heard
  // from a chat's create calls, from a client's forwarded terminal tool calls,
  // and from the gateway's `pull_request.link`. Every client reads it through
  // `pullRequests.*`. With no `gh` on this machine it shows what it has, as
  // last read. A pull request an agent asked to have watched
  // (`pull_request.watch`) wakes its chat through the same send a resume
  // after a usage limit takes, marked as Studio's (studio-pull-request-wakes.ts).
  const pullRequests = createPullRequestDomain({
    dataDir,
    conversations,
    wakes: studioPullRequestWakes({
      conversations,
      workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
      // Called only once a wake goes, long after the core is composed.
      createHost: (hostOptions) => createConversationHost(hostOptions),
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Pull request watch', message })
      },
    }),
    // An open pull request is probed every couple of minutes while a window
    // is in front, and far less often while none is.
    recordOptions: { focus: powerActivity },
    workspaceFolder: (workspaceId) => workspaceRegistry.getRecord(workspaceId)?.folderPath ?? null,
    log: (message, error) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Pull request record',
        message,
        ...(error === undefined
          ? {}
          : { details: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
      })
    },
  })

  // The local servers the conversations' agents started (local-server-domain.ts):
  // linked through the gateway's `local_server.link`, checked from here, where
  // the agents run, and read by every client through `localServers.*`. A
  // command the agent gave without a folder runs where its chat works (the
  // session's own root, a worktree, when it has one), else in the workspace's
  // folder; a folder on another machine is not one to run in here.
  const localFolder = (folder: string | null | undefined) => (folder && !isMachinePath(folder) ? folder : null)
  const localServers = createLocalServerDomain({
    dataDir,
    conversationFolder: (key) => {
      const listed = conversations.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
      const latest = listed.ok ? [...listed.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined
      const sessionRoot = latest ? conversations.sessionWorkspaceRoot(latest.sessionId) : null
      return localFolder(sessionRoot) ?? localFolder(workspaceRegistry.getRecord(key.workspaceId)?.folderPath)
    },
    // Read from the registry's tombstones rather than from a missing record:
    // a registry that failed to load is not a person removing every workspace.
    workspaceRemoved: (workspaceId) => isWorkspaceTombstoned(workspaceRegistry.getTombstones(), workspaceId),
    log: (message, error) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Local servers',
        message,
        ...(error === undefined
          ? {}
          : { details: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
      })
    },
  })
  // A removed workspace's servers go with it, whichever door removed it.
  const stopPruningLocalServers = workspaceRegistry.subscribe(() => void localServers.prune())
  // A settled or deleted chat's pull request watches stop with it: there is
  // nobody to wake. Waking from sleep looks again at news a timer held.
  const stopFollowingWatchedChats = [
    workspaceRegistry.subscribe(() => pullRequests.pruneWatches()),
    powerActivity.onResume(() => pullRequests.wakeWatches()),
  ]

  // What an agent of this app is running on now, for the gateway's launch cap:
  // an agent may start agents only at its own preset or stricter.
  const resolveAgentPermissionPreset: AgentPermissionResolver = createAgentPermissionResolver({
    listConversationSessions: (agentId) => {
      const listed = conversations.listSessions({ agentId })
      return listed.ok ? listed.sessions : []
    },
    listTerminalSessions: () => options.listTerminalSessions?.() ?? [],
    readAgentRecordPreset: (workspaceId, agentId) => {
      const agent = workspaceRegistry.getRecord(workspaceId)?.agents[agentId]
      return agent ? { found: true, preset: agent.cliPermissionPreset } : { found: false }
    },
  })

  /**
   * The conversation host every remote door wraps: the tailnet lane a paired
   * device follows chats through, and the Studio RPC a local app does. One
   * factory, so a chat lists, resumes and switches the same by either.
   */
  // The machine a chat runs on and its pull requests, as a paired phone's
  // list shows them: read from the registry, the launch settings and the pull
  // request record, never from a machine or GitHub.
  const machineContext = (): ConversationMachineContext => ({
    hostName: readHostName(),
    platform: process.platform,
    marks: agentLaunchSettings.get().machineMarks,
    ...(sshServers?.machineOf ? { sshMachineOf: (id: string) => sshServers.machineOf?.(id) ?? null } : {}),
  })
  const listMarks = {
    // What a paired desktop's management of each chat reads: whether it
    // compacts by itself, by its own Auto compact switch or by this
    // machine's default where it left that unset.
    manageOf: (keys: Array<{ workspaceId: string; agentId: string }>) => {
      const byDefault = effectiveAgentLaunchSettings(agentLaunchSettings.get()).autoCompactChats === true
      return new Map(
        keys.map((key) => {
          const own = workspaceRegistry.getRecord(key.workspaceId)?.autoCompactEnabled
          return [`${key.workspaceId}:${key.agentId}`, { autoCompact: typeof own === 'boolean' ? own : byDefault }]
        }),
      )
    },
    machineReader: () => {
      const context = machineContext()
      return (workspaceId: string) => conversationHostOf(workspaceRegistry.getRecord(workspaceId) ?? null, context)
    },
    pullRequestsOf: async (keys: Array<{ workspaceId: string; agentId: string }>) => {
      const found = await pullRequests.list({ conversations: keys })
      return new Map(
        found.conversations.map((entry) => [
          `${entry.workspaceId}:${entry.agentId}`,
          conversationPullRequestsOf(entry.pullRequests),
        ]),
      )
    },
    selfMachine: () => tailnetSelfMachine(machineContext()),
    // Only a folder on this computer: one on an SSH machine is that
    // machine's path, and this disk has nothing to read at it.
    branchesOf: (workspaceIds: string[]) =>
      conversationBranchesOf(
        workspaceIds,
        (workspaceId) => {
          const record = workspaceRegistry.getRecord(workspaceId)
          return record && !record.environment ? (record.folderPath ?? null) : null
        },
        resolveCheckoutForCwd,
      ),
    // The chat's own folder (its worktree, when the agent works in one),
    // counted from the sidebar's shared reading; again only on this computer.
    checkoutsOf: (keys: Array<{ workspaceId: string; agentId: string; live: boolean }>) =>
      conversationCheckoutsOf(
        keys,
        ({ workspaceId, agentId }) => {
          const record = workspaceRegistry.getRecord(workspaceId)
          if (!record || record.environment) return null
          const agent = record.agents[agentId]
          const path = conversationWorkingRoot(agent, record.folderPath)
          if (!path) return null
          const agentWorktree = agent?.execution?.mode === 'worktree' && Boolean(agent.execution.cwd?.trim())
          return { path, worktree: agentWorktree || Boolean(record.worktree) }
        },
        (checkoutPath) => getWorkspaceChangeSummary({ checkoutPath }),
      ),
  }
  // A chat's rest and its person-clocks, written for a paired device to the
  // same record the sidebar writes (conversation-lifecycle.ts). Busy is
  // anything ending the chat's processes would cut short: a chat's turn
  // starting, running or waiting on the person, an agent it launched still
  // working in the background under any parent phase, or one of its agent
  // terminals mid-turn (`conversationSessionWorking`, `terminalAgentWorking`).
  const terminalWorking = (workspaceId: string) =>
    (options.listTerminalSessions?.() ?? []).some(
      (session) => session.kind === 'agent' && session.workspaceId === workspaceId && terminalAgentWorking(session),
    )
  const conversationLifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    updateWorkspaceFields: (workspaceId, patch, actor) =>
      workspaceSyncService.updateWorkspaceFields(workspaceId, patch, actor),
    rewindVisit: (workspaceId, lastVisitedAt, actor) =>
      workspaceSyncService.rewindVisit(workspaceId, lastVisitedAt, actor),
    // A person's name, as a window's Rename writes one: locked, and stamped now.
    renameWorkspace: (workspaceId, name, actor) =>
      workspaceSyncService.renameWorkspace(workspaceId, name, true, actor, Date.now()),
    isWorking: (workspaceId) => {
      const listed = conversations.listSessions({ workspaceId })
      if (listed.ok && listed.sessions.some(conversationSessionWorking)) return true
      return terminalWorking(workspaceId)
    },
    // An agent's own chat turn, and nothing else: no other chat or agent
    // terminal of the workspace at work (`onlyOwnChatTurn`).
    onlyTurnOf: (workspaceId, agentId) => {
      const listed = conversations.listSessions({ workspaceId })
      return listed.ok && onlyOwnChatTurn(listed.sessions, agentId) && !terminalWorking(workspaceId)
    },
    // A message held for the end of a turn: the scheduled messages, created
    // below, hold the ones a paired machine queued and the ones that came due
    // mid-turn.
    messageWaiting: (workspaceId) =>
      scheduledMessages
        .state()
        .messages.some(
          (message) =>
            message.workspaceId === workspaceId &&
            !message.failure &&
            (message.queued === true || message.waitingSince !== undefined || message.sending === true),
        ),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Conversation settle', message })
    },
    // The transcripts' index too, as the list reads it: after a restart a
    // chat-only conversation's finishes are on record only there.
    latestChatTurnEnd: async (workspaceId) => {
      const workspaceRoot = workspaceRegistry.getRecord(workspaceId)?.folderPath
      const indexed = workspaceRoot
        ? await conversations.listThreads({ workspaceId, workspaceRoot }).catch(() => null)
        : null
      const indexedEnd = Math.max(
        -1,
        ...(indexed?.ok ? indexed.threads : []).map((thread) => thread.lastTurnEndedAt ?? -1),
      )
      const listed = conversations.listSessions({ workspaceId })
      return latestTurnEnd(listed.ok ? listed.sessions : [], { workspaceId }, indexedEnd)
    },
  })
  // A settle an agent asked for on its own chat goes ahead, or is let go, on
  // that chat's events: every chat's, a distribution's or an SSH machine's
  // included. For the core's life, as the chats are.
  conversations.onEvent((event) => conversationLifecycle.onConversationEvent(event))
  // `origin` is for Studio's own sends (a resume after a usage limit): they
  // are not the person writing, so each is recorded as Studio's and the chat
  // keeps its place in the lists ordered by when the person last did.
  // `lifecycleList` is for the door that advertises `conversation-lifecycle`
  // (the tailnet lane): its list leaves settled chats out, in the sidebar's
  // order. The Studio RPC's lists every chat by `updatedAt`, as it always has.
  const createConversationHost = (hostOptions: { origin?: ConversationMessageOrigin; lifecycleList?: boolean } = {}) =>
    createConversationGatewayHost(
      conversations,
      (workspaceId) => workspaceRegistry.getRecord(workspaceId)?.folderPath ?? null,
      () =>
        workspaceRegistry
          .getRecords()
          .filter((record) => Boolean(record.folderPath))
          .map((record) => ({
            workspaceId: record.id,
            workspaceRoot: record.folderPath!,
          })),
      // A chat's own agent record carries the preset the person last chose
      // for it; a chat without one starts on the app-wide spawn default, as a
      // new chat in a window does.
      (key) =>
        parseCliPermissionPreset(
          workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.cliPermissionPreset,
        ) ?? effectiveAgentLaunchSettings(agentLaunchSettings.get()).lastAgentSpawnPermissionPreset,
      // The agent record's name — the same record, and the same field, this
      // desktop's tab and sidebar read — so a remote lists the chat by the
      // name it has here rather than by its first message.
      (key) => workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.name,
      // The chat's CLI catalog as this machine's own picker lists it, so a
      // paired device offers the same models and can switch to no other.
      conversationModelCatalog,
      listMarks,
      {
        workspaceOf: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
        // What chats sent, the pictures their steps returned, and pasted images.
        imageRoots: () => [
          join(dataDir, CONVERSATION_ATTACHMENTS_DIRECTORY),
          join(dataDir, CONVERSATION_TOOL_IMAGES_DIRECTORY),
          attachmentImagesRoot(),
        ],
        ...(hostOptions.lifecycleList ? { lifecycleList: true } : {}),
        ...(hostOptions.origin
          ? { sendOrigin: hostOptions.origin }
          : {
              noteUserMessage: (workspaceId: string, at: number) =>
                conversationLifecycle.noteUserMessage(workspaceId, at, 'gateway'),
            }),
        reasoningEffortOf: (key) =>
          workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.conversationReasoningEffort,
        // A phone's switch moves the chat's record as the chat view's own does,
        // through the same bus, so it outlives the session it was applied to.
        writeAgentChoice: (key, patch) => {
          if (!workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]) return
          workspaceSyncService.updateWorkspaceAgent(key.workspaceId, key.agentId, patch, 'system')
        },
        // A message a paired machine queued while the chat's turn ran is held
        // here, among the scheduled messages below, and sent from here when the
        // turn ends: the machine that typed it may sleep or close meanwhile.
        heldMessages: studioHeldMessages(() => scheduledMessages),
      },
    )

  // A chat a usage limit stopped picks up again when the limit resets
  // (usage-limits/resume.ts, wired in studio-usage-limit-resumes.ts). The
  // limits are reported in this process, by the chats it runs; the resume goes
  // through the same send a paired device's does, marked as Studio's.
  const usageLimitResumes = createStudioUsageLimitResumes({
    dataDir,
    conversations,
    workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    createHost: (hostOptions) => createConversationHost(hostOptions),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Usage limits', message })
    },
  })
  void usageLimitResumes.start()
  const stopFollowingResumes = [
    // A timer stands still while the computer sleeps; waking reads the clock again.
    powerActivity.onResume(() => usageLimitResumes.wake()),
    powerActivity.onScreenLockChange((locked) => {
      if (!locked) usageLimitResumes.wake()
    }),
    // A deleted chat's resume goes with it.
    workspaceRegistry.subscribe(() => usageLimitResumes.prune()),
  ]

  // A Claude chat with Auto compact on is compacted by Studio while it sits
  // idle, just before its prompt cache expires (conversation-auto-compact.ts,
  // wired in studio-auto-compact.ts): its chats' sessions, a distribution's
  // and an SSH machine's included, read through the router; the send goes
  // through the same door a resume after a usage limit takes, marked as
  // Studio's. Looked at again whenever a chat, its record or the default
  // moves, and on waking, since a timer stands still while the machine sleeps.
  const autoCompact = createStudioAutoCompact({
    conversations,
    workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    enabledByDefault: () => effectiveAgentLaunchSettings(agentLaunchSettings.get()).autoCompactChats,
    createHost: (hostOptions) => createConversationHost(hostOptions),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Auto compact', message })
    },
  })
  const stopFollowingAutoCompact = [
    workspaceRegistry.subscribe(() => autoCompact.recompute()),
    agentLaunchSettings.subscribe(() => autoCompact.recompute()),
    powerActivity.onResume(() => autoCompact.recompute()),
  ]

  // Messages a person scheduled into a chat from its composer's "+"
  // (scheduled-messages/scheduled-messages.ts, wired in
  // studio-scheduled-messages.ts): sent when their time comes through the same
  // send a paired device's takes, as the person's own words.
  const scheduledMessages = createStudioScheduledMessages({
    dataDir,
    conversations,
    workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    createHost: () => createConversationHost(),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Scheduled messages', message })
    },
  })
  void scheduledMessages.start()
  const stopFollowingScheduledMessages = [
    powerActivity.onResume(() => scheduledMessages.wake()),
    powerActivity.onScreenLockChange((locked) => {
      if (!locked) scheduledMessages.wake()
    }),
    // A deleted chat's scheduled messages go with it.
    workspaceRegistry.subscribe(() => scheduledMessages.prune()),
  ]

  // A chat is titled here, from its own events, rather than by a window: the
  // chats that most need a title are the ones a phone or a paired machine
  // started while no window was watching (chat-titler.ts). The heuristic
  // lands at once; a model-written title replaces it when the person has them
  // on, on the setting each window pushes to this process (absent, the
  // window's own default: on, with the engine left to the CLIs installed).
  const textGenerationSettings = createTextGenerationSettingsStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('agents'),
  })
  const chatTitler = createChatTitler({
    onEvent: (listener) => conversations.onEvent(listener),
    getWorkspace: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    rename: (workspaceId, name) => workspaceSyncService.renameWorkspace(workspaceId, name, true, 'system').ok,
    settings: () => textGenerationSettings.get(),
    candidateClis: () => listPluginRegistryEntries().map((entry) => entry.id),
    // The availability this process already holds, never a fresh probe: a
    // CLI it has not looked at yet is kept, and the generator itself answers
    // for one that turns out to be missing.
    installed: (cli) => knownCliAvailability({ cliRuntimes: agentLaunchSettings.get().cliRuntimes })[cli]?.installed,
    cliRuntimes: () => agentLaunchSettings.get().cliRuntimes,
    generate: (request) => generateChatTitle(request),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'agents', title: 'Chat title not generated', message })
    },
  })

  // Both of Studio's own sends stop before the chats do, listeners first, so
  // none comes due on the way out and starts an agent the quit then has to
  // stop (or, stopped already, would be recorded as sent). The desktop's quit
  // runs these as legs of its own; `shutdown` below for a process that owns
  // nothing else.
  function stopUsageLimitResumes(): Promise<void> {
    for (const stop of stopFollowingResumes.splice(0)) stop()
    return usageLimitResumes.dispose()
  }
  function stopScheduledMessages(): Promise<void> {
    for (const stop of stopFollowingScheduledMessages.splice(0)) stop()
    return scheduledMessages.dispose()
  }
  function stopAutoCompact(): void {
    for (const stop of stopFollowingAutoCompact.splice(0)) stop()
    autoCompact.dispose()
  }

  /**
   * The core's own end, for a process that owns nothing else: the registry
   * flushed around the chats' end, the machines' helpers told to stop, the
   * data directory let go. The desktop runs the same steps as legs of its own
   * quit (app-lifecycle.ts), interleaved with the shell's.
   *
   * The lock is let go last, once the chats' shutdown has closed every
   * transcript, so a process that takes the directory next never finds a log
   * still being written. A stop cut short leaves the lock to be found
   * abandoned instead.
   */
  async function shutdown(): Promise<void> {
    const legs: Array<() => unknown> = [
      () => workspaceSyncService.flush(),
      () => pullRequests.flush(),
      () => localServers.flush(),
      () => conversationRuntime.flushTranscripts(),
      stopUsageLimitResumes,
      stopScheduledMessages,
      stopAutoCompact,
      () => chatTitler.dispose(),
      () => conversationOwner.shutdown(),
      () => {
        for (const stop of stopFollowingWatchedChats.splice(0)) stop()
        pullRequests.dispose()
      },
      // The servers the Studio itself started stop with it: nothing would be
      // left to stop them from.
      () => {
        stopPruningLocalServers()
        return localServers.dispose()
      },
      () => workspaceSyncService.flush(),
      () => hosts.dispose(),
    ]
    for (const leg of legs) {
      try {
        await leg()
      } catch {
        // Best effort, leg by leg: the process is leaving either way.
      }
    }
    dataDirLock?.release()
  }

  return {
    platform,
    role: options.role,
    /** Null only in a desktop that could not take the directory and carried on, as builds before the lock did. */
    dataDirLock,
    /** Resolves once a Studio server this desktop displaced has exited; a gateway or socket opens after it. */
    whenDataDirFree: taken.whenFree,
    agentLaunchSettings,
    hosts,
    workspaceRegistry,
    workspaceSyncService,
    conversations,
    conversationOwner,
    /** Windows: the WSL servers chats may run on, for Settings' status; null elsewhere. */
    wslServers,
    approvalRules,
    conversationModelCatalog,
    conversationLaunchService,
    conversationImport,
    resolveAgentPermissionPreset,
    createConversationHost,
    conversationLifecycle,
    pullRequests,
    localServers,
    usageLimitResumes,
    scheduledMessages,
    /** The model-written chat titles setting, as the windows push it. */
    textGenerationSettings,
    stopUsageLimitResumes,
    stopScheduledMessages,
    stopAutoCompact,
    shutdown,
  }
}

/**
 * The stdio bridge agents run to reach the gateway: shipped under
 * `resources/automation`, which an installed build unpacks into its resources
 * directory and a source checkout keeps at its root.
 */
export function studioBridgeScriptPath(paths: StudioPaths): string {
  const root = paths.isPackaged() ? paths.resourcesDir() : join(paths.appRoot() ?? process.cwd(), 'resources')
  return join(root ?? '', 'automation', 'mcp-stdio-bridge.mjs')
}

/** This machine's host name, or empty when the OS will not say. */
function readHostName(): string {
  try {
    return hostname().trim()
  } catch {
    return ''
  }
}
