import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { ConversationEventType } from '../../shared/conversation-runtime'
import { createAutomationService } from '../../main/automation/automation-service'
import { createConversationTools, type ConversationToolsDeps } from '../../main/automation/conversation-tools'
import {
  chatCheckoutFromRegistry,
  createConversationPullRequestTools,
} from '../../main/automation/conversation-pull-request-tools'
import { knownCliAvailability } from '../../main/cli-availability'
import { listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { createPullRequestCreator } from '../../main/pull-request-create'
import { generatePullRequestText } from '../../main/text-generation/text-generation-service'
import { resolveTextGenerationEngine } from '../../shared/text-generation/contract'
import {
  createConversationListChangeFilter,
  latestTurnEnd,
  movesWorkspaceList,
} from '../../main/automation/conversation-lifecycle'
import { launchPermissionCeiling } from '../../main/automation/launch-permission-cap'
import { gatewayToolsForCaller } from '../../main/automation/tailnet/tailnet-scopes'
import { createUsageTools } from '../../main/usage/usage-tools'
import { appUsageService } from '../../main/usage/usage-service'
import { createStudioGatewayTools } from '../../main/automation/studio-gateway-tools'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { toolSuccess, toolError } from '../../shared/modules/mcp-tools'
import type { StudioToolReach } from '../../../packages/studio-protocol/src/public'
import { createClientToolRegistry, type ClientToolRegistry } from '../tools/client-tool-registry'
import { createClientToolGateway, type ExpectedShellToolsets } from '../tools/client-tool-gateway'
import { cancelClientCallsAtTurnEnd } from '../tools/client-tool-turns'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { createClientToolsetStore, type ConversationRef } from '../tools/client-toolset-store'
import { createPullRequestTools } from '../pull-requests/pull-request-tools'
import { createLocalServerTools } from '../local-servers/local-server-tools'
import { studioBridgeScriptPath, type StudioCore } from './studio-core'

// The Studio MCP gateway over a core: the always-on socket agents reach the
// app through, the opt-in tailnet listener, and the conversation lane paired
// devices follow chats on. Composed beside the core rather than inside it,
// because the desktop adds tools that act on what only it has (windows,
// terminals, the browser pane, the canvas worker); a standalone server serves
// the core's own tools alone.

/** The conversation events that change what a paired device's list says: a start, an end, a phase. */
const CONVERSATION_LIST_EVENTS = new Set<ConversationEventType>([
  'session_started',
  'session_closed',
  'user_message',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'approval_requested',
  'approval_resolved',
])

// The module host's contribution type, read off the tool set rather than
// imported from the host, whose file also names Electron's IPC types.
type GatewayToolsOptions = Parameters<typeof createStudioGatewayTools>[0]

export type StudioGatewayOptions = Pick<
  Parameters<typeof createAutomationService>[0],
  'onTailnetEvent' | 'onMeshEvent' | 'hasWindow' | 'downscaleUpload'
> & {
  /**
   * The gateway's app tools, given the core's own: the desktop places them
   * among its window and terminal tools, a server serves them as they are. The
   * order is the order agents list them in.
   */
  appTools?: (coreTools: McpToolRegistration[]) => McpToolRegistration[]
  /** Module-contributed tools, from the host kernel; empty until modules load. */
  resolveModuleTools?: GatewayToolsOptions['resolveModuleTools']
  /** Live enablement of a contributing module; resolved per call, never captured. */
  isModuleEnabled?: (moduleId: string) => boolean
  /**
   * The shell's toolsets this server lists from an agent's first `tools/list`
   * (the desktop's own: `browser`, `canvas`). A list that arrives before the
   * shell has offered them waits for them, up to five seconds. A server with
   * no shell of its own names none and never waits.
   */
  expectShellToolsets?: ExpectedShellToolsets
  /**
   * A gateway tool to leave out of every list now: a family the person
   * switched off (the agents' browser) while it is served here rather than
   * offered by the shell. Asked per list, so the switch holds without a restart.
   */
  hideTool?: (name: string) => boolean
  /**
   * Remember which agent started a chat through `conversation.create`, so it is
   * told when the chat's turn ends (agent-launch-notices.ts). The desktop in
   * process links; a server out of process cannot type into a terminal agent
   * and leaves it out.
   */
  linkLaunchedAgent?: ConversationToolsDeps['linkLaunchedAgent']
}

export type StudioGateway = ReturnType<typeof createStudioGateway>

/** What the client tools registry reads from the RPC that pairs apps, linked once that RPC exists. */
export type ClientToolLinks = {
  /** Which agents a paired app's tools reach. */
  reachOf?: (clientId: string) => StudioToolReach
  /** The client that started a conversation, from its record. */
  startedBy?: (conversation: ConversationRef) => string | null
}

export function createStudioGateway(core: StudioCore, options: StudioGatewayOptions = {}) {
  const { platform, workspaceSyncService, conversations } = core
  const coreTools = [
    ...createConversationTools({
      launch: (request) => core.conversationLaunchService.launch(request),
      resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
      lifecycle: core.conversationLifecycle,
      ...(options.linkLaunchedAgent ? { linkLaunchedAgent: options.linkLaunchedAgent } : {}),
    }),
    // A paired desktop's Create PR on one of this machine's chats: the
    // checkout, git, the forge's CLI and the drafting CLI are here, and so is
    // the record the pull request is kept in.
    ...createConversationPullRequestTools({
      checkoutOf: chatCheckoutFromRegistry((workspaceId) => core.workspaceRegistry.getRecord(workspaceId)),
      creator: createPullRequestCreator(),
      // The engine a chat here is titled with (chat-titler.ts), read as the
      // draft starts: this machine's setting, its CLIs and their overrides.
      draftEngine: () => {
        const settings = core.textGenerationSettings.get()
        const cliRuntimes = core.agentLaunchSettings.get().cliRuntimes
        const engine = resolveTextGenerationEngine(
          settings,
          listPluginRegistryEntries().map((entry) => entry.id),
          (cli) => knownCliAvailability({ cliRuntimes })[cli]?.installed,
        )
        return engine ? { engine, cliRuntimes, writingStyle: settings.writingStyle } : null
      },
      generate: (request) => generatePullRequestText(request),
      link: async (input) => {
        const linked = await core.pullRequests.link(input)
        return linked.ok ? { ok: true } : { ok: false, message: linked.message }
      },
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'agents', title: 'Pull request text not drafted', message })
      },
    }),
    ...createPullRequestTools({
      link: (key, input) => core.pullRequests.linkForAgent(key, input),
      watch: (key, input) => core.pullRequests.watchForAgent(key, input),
      unwatch: (key, input) => core.pullRequests.unwatchForAgent(key, input),
      pullRequestsOf: (key) => core.pullRequests.record.forConversation(key),
      // A chat has sessions in the runtime; the agent calling is in one now.
      isChat: (key) => {
        const listed = conversations.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
        return listed.ok && listed.sessions.length > 0
      },
    }),
    ...createLocalServerTools({ link: (key, input) => core.localServers.linkForAgent(key, input) }),
    // A paired desktop's usage dashboard counts what this machine spent.
    ...createUsageTools({
      usage: () =>
        appUsageService({
          dataDir: () => platform.paths.dataDir(),
          getWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
        }),
    }),
  ]

  // The gateway's own tools: what no client may offer under the same family.
  const resolveGatewayTools = createStudioGatewayTools({
    resolveModuleTools: () => options.resolveModuleTools?.() ?? [],
    isModuleEnabled: (moduleId) => options.isModuleEnabled?.(moduleId) ?? false,
    // A module tool runs under its caller's launch cap, so a chat the module
    // starts for a capped agent is no looser than that agent.
    callerPermissionCeiling: (context) => launchPermissionCeiling(context, core.resolveAgentPermissionPreset),
    warn: (details) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Studio MCP gateway',
        message: 'Studio MCP gateway',
        details,
      })
    },
    appTools: options.appTools ? options.appTools(coreTools) : coreTools,
  })

  // Client toolsets: offered over the Studio RPC, listed to agents here. The
  // RPC that pairs apps links in each app's reach and who started a chat.
  const clientToolLinks: ClientToolLinks = {}
  let automation: ReturnType<typeof createAutomationService> | null = null
  const clientTools: ClientToolRegistry = createClientToolRegistry({
    store: createClientToolsetStore({
      dataDir: () => platform.paths.dataDir(),
      log: (message) => {
        void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Client tools', message })
      },
    }),
    servedFamilies: () => new Set(resolveGatewayTools().map((tool) => tool.name.split('.')[0])),
    servedTools: () => resolveGatewayTools().map((tool) => tool.name),
    reservedNames: () =>
      new Set((options.resolveModuleTools?.() ?? []).map((contribution) => contribution.moduleId.toLowerCase())),
    reachOf: (clientId) => clientToolLinks.reachOf?.(clientId) ?? 'own',
    startedBy: (conversation) => clientToolLinks.startedBy?.(conversation) ?? null,
    // Offers and withdrawals land in the gateway's one audit, beside the RPC's
    // own records, with the toolset's name and size and nothing a tool was given.
    audit: (entry) =>
      automation?.gatewayAudit().record({
        connection: { kind: 'studio-client', clientId: entry.clientId, clientName: entry.clientName },
        tool: entry.tool,
        durationMs: 0,
        args: { toolset: entry.toolset, tools: entry.tools },
        result: entry.ok
          ? toolSuccess({ ok: true })
          : toolError(entry.code ?? 'refused', 'The Studio RPC request was not carried out.'),
      }),
    // The person hears once when an app first gives agents tools under a name
    // (decisions R82): the pairing tick was the consent, this is the notice.
    onFirstOffer: (entry) =>
      platform.notifier.notify({
        key: `client-tools:${entry.clientId}:${entry.toolset}`,
        title: `${entry.clientName} gave agents ${entry.tools === 1 ? 'a tool' : `${entry.tools} tools`}`,
        body: `Agents can now call its ${entry.title} tools. See them, or revoke the app, in Settings → Local apps.`,
      }),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Client tools', message })
    },
  })

  // Each agent connection's own list of client tools, which only grows.
  const clientGateway = createClientToolGateway({
    registry: clientTools,
    ...(options.expectShellToolsets ? { expectShellToolsets: options.expectShellToolsets } : {}),
  })
  // The order agents have always listed: the shell's toolsets in the slots
  // the browser and canvas tools held, Studio's own tools, then any app's.
  // A tool only a paired device has a use for is left out for everyone else.
  const hideTool = options.hideTool
  const resolveTools = (context?: McpConnectionContext) => [
    ...clientGateway.builtIns(context),
    ...gatewayToolsForCaller(
      hideTool ? resolveGatewayTools().filter((tool) => !hideTool(tool.name)) : resolveGatewayTools(),
      context,
    ),
    ...clientGateway.apps(context),
  ]

  const automationService = createAutomationService({
    resolveUserDataDir: () => platform.paths.dataDir(),
    appVersion: platform.identity.version(),
    resolveBridgeScriptPath: () => studioBridgeScriptPath(platform.paths),
    ...(options.onTailnetEvent ? { onTailnetEvent: options.onTailnetEvent } : {}),
    ...(options.onMeshEvent ? { onMeshEvent: options.onMeshEvent } : {}),
    ...(options.hasWindow ? { hasWindow: options.hasWindow } : {}),
    ...(options.downscaleUpload ? { downscaleUpload: options.downscaleUpload } : {}),
    // The tailnet lane advertises `conversation-lifecycle`, so its list is
    // the one that keeps the capability's promise.
    resolveConversationHost: () => core.createConversationHost({ lifecycleList: true }),
    // The run lock's holder removes a stale socket; nobody else does. A desktop
    // that could not take the lock still may, as builds before it did: its
    // single-instance lock already rules out a second app on this profile.
    holdsDataDir: () => (core.dataDirLock ? core.dataDirLock.isHeld() : core.role === 'desktop'),
    // The gateway's tool set: core app tools + canonical run tools merged once,
    // module-contributed tools read from the host kernel per request
    // and gated on their owner's live enablement.
    resolveGatewayTools: resolveTools,
    clientTools: {
      ready: () => clientGateway.ready(),
      fallback: (context, name) => clientGateway.fallback(context, name),
      track: (context, notify) => clientGateway.track(context, notify),
    },
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // The change feed (2026-09-05): paired devices used to poll workspace.list
  // every thirty seconds; now the registry's accepted events become one small
  // push, throttled in the listener so a burst here is one push there, and a
  // device re-reads only when told to. A patch of the clocks alone, which
  // `workspace.list` does not carry (a visit stamped every few seconds while
  // a chat is on screen), tells it nothing (`movesWorkspaceList`).
  workspaceSyncService.subscribeEvents((event) => {
    if (movesWorkspaceList(event)) automationService.notifyWorkspacesChanged()
  })
  // The conversation list reads the desktop's records too (a chat settled,
  // renamed, written to or looked at), so the changes it reads are the same
  // push as a conversation event; `createConversationListChangeFilter` keeps
  // the visits stamped while a chat is on screen from becoming a push each.
  const listChanged = createConversationListChangeFilter({
    turnEndOf: (workspaceId) => {
      const listed = conversations.listSessions({ workspaceId })
      return listed.ok ? latestTurnEnd(listed.sessions, { workspaceId }) : undefined
    },
  })
  workspaceSyncService.subscribeEvents((event) => {
    if (listChanged(event)) automationService.notifyConversationsChanged()
  })
  // A conversation's row on another machine shows its phase: running, waiting
  // on a person, done. The events that move it (never a token of a reply)
  // become the same throttled push.
  conversations.onEvent((event) => {
    if (CONVERSATION_LIST_EVENTS.has(event.type)) automationService.notifyConversationsChanged()
    // An interrupted turn stops what it was waiting on in a client too.
    cancelClientCallsAtTurnEnd(clientTools, event)
  })

  // A desktop that displaced a Studio server from its data directory opens
  // the socket only once that server has exited: closing its listener
  // removes the socket file at the shared path, which would take the
  // desktop's new one with it. Agent launches wait on the same.
  automation = automationService
  return {
    ...automationService,
    /** The client toolsets offered over the Studio RPC. */
    clientTools,
    /**
     * Studio's own tools, core and module, without any a client offers: what
     * a WSL server's agents are offered of this side beside the shell's
     * toolsets (phase 7, 3.7). Not those served to paired devices alone.
     */
    ownTools: (): McpToolRegistration[] => gatewayToolsForCaller(resolveGatewayTools(), undefined),
    /**
     * The names of the core's own tools, without any a module contributes:
     * what the module host refuses a module tool name against.
     */
    coreToolNames: (): ReadonlySet<string> => resolveGatewayTools.coreToolNames(),
    /** Link in what the registry reads from the RPC that pairs apps. */
    linkClientTools: (links: ClientToolLinks) => Object.assign(clientToolLinks, links),
    shutdown: async () => {
      // Every call still waiting on a client is answered before the sockets go.
      clientTools.close()
      await automationService.shutdown()
    },
    initialize: async () => {
      await core.whenDataDirFree
      return automationService.initialize()
    },
    whenGatewayReady: async () => {
      await core.whenDataDirFree
      return automationService.whenGatewayReady()
    },
  }
}
