import type { AgentLaunchSettings, AgentLaunchSettingsRecord } from '../../shared/launch-settings'
import type { WorkspaceSyncSnapshot, WorkspaceSyncState } from '../../shared/workspace-sync'

// What the shell and its out-of-process server say to each other on the
// control channel beyond the bootstrap frames and the ShellBridge (phase 6
// spec, 6.3 and 6.4): the state the shell mirrors, the writes and reads it
// makes on server-owned stores, the hints it sends, and the two reads the
// server asks of the shell's own caches. Method names are the contract; both
// ends import them from here.

export const SERVER_METHODS = {
  /** → `ServerMirrorState`: what the shell's mirror starts from. */
  mirrorSnapshot: 'mirror.snapshot',
  /** `{ workspaceId, agentId, patch, actor, stamp? }` → the sync service's result. */
  updateWorkspaceAgent: 'workspace.update-agent',
  /** `{ cli }` → `ProviderSecretValueResult`: a terminal launch's credential, for the shell only. */
  resolveSecretForLaunch: 'secrets.resolve-for-launch',
  /** `{ op, token? }` → the GitHub token store's answer. */
  githubToken: 'github.token',
  /** `{ sessionId }` → the peek card's events, or null for a session the server does not have. */
  conversationPeekEvents: 'conversations.peek-events',
  /**
   * `{ workspaceRoot, workspaceId, agentId }` → `{ ok, source }` (`ChatExportSourceWire`) or
   * `{ ok: false, message }`: a chat's whole transcript and its pictures, for Export chat.
   */
  conversationExportSource: 'conversations.export-source',
  /** → the folders the chats live in, for diagnostics. */
  conversationRoots: 'conversations.live-roots',
  /** → the folders chats are working in now, which the shell's worktree cleanup never removes. */
  conversationWorkspaceRoots: 'conversations.live-workspace-roots',
  /** → how many chats have a turn in progress, which a quit would stop. */
  conversationsWorking: 'conversations.working',
  /** `{ overrides }` → the module enablement result: the shell wrote the file, the server applies it live. */
  applyModuleEnablement: 'modules.apply-enablement',
  /** → `ThirdPartyLaunchSessionWire`: which third-party main halves loaded here, and what they registered. */
  thirdPartyLaunchSession: 'modules.third-party-launch-session',
  /** `{ clientId }` → `{ connectionId, ticket }`: a chat view's protocol connection, its port already attached. */
  studioConnect: 'studio.connect',
  /**
   * `{ clientId }` → `{ connectionId, ticket }`: the shell's own Studio
   * connection, with the shell role, over which it offers its toolsets (6.3).
   */
  shellConnect: 'studio.connect-shell',
  /** `CliModelDiscoveryInput` → its result: the pass after an install, run where the catalog cache lives. */
  discoverModels: 'models.discover',
  /** → `ServerInfo`. */
  info: 'server.info',
} as const

/** Server → shell requests: the shell's own caches the gateway's tools read. */
export const SHELL_METHODS = {
  /** `MarketplaceRegistryReadInput` → its result. */
  marketplaceRead: 'shell.marketplace.read',
  /** → the installed third-party modules with trust and launch readiness. */
  thirdPartyModules: 'shell.modules.third-party-list',
  /**
   * → every live launch token the shell's terminals were issued, by digest
   * (`LaunchTokenChange[]`, decision R87). Asked before the gateway listens,
   * so a bridge that reconnects the moment the socket is back is proven.
   */
  liveLaunchTokens: 'shell.launch-tokens.live',
  /**
   * `{ key, purpose }` → `{ clientId, label }`: a stream on an SSH machine's
   * relay (phase 8), which main holds; its port follows on the control
   * channel as an `ssh-stream` attach with that client id.
   */
  sshOpen: 'shell.ssh.open',
} as const

/** One-way, either direction. */
export const SERVER_EVENTS = {
  /** Server → shell: the registry changed. `ServerMirrorRegistry`. */
  mirrorRegistry: 'mirror.registry',
  /** Server → shell: an accepted workspace event, for the shell's subscribers. */
  mirrorWorkspaceEvent: 'mirror.workspace-event',
  /** Server → shell: the launch settings changed. `{ settings, record }`. */
  mirrorLaunchSettings: 'mirror.launch-settings',
  /** Server → shell: a chat's phase moved; the shell's dock badge and taskbar flash follow it. */
  attentionPhase: 'attention.agent-phase',
  /** Shell → server: the renderer's module registry, mirrored. */
  moduleRegistrySnapshot: 'modules.registry-snapshot',
  /** Shell → server: the idle threshold shared with terminals. */
  conversationIdleThreshold: 'conversations.idle-threshold',
  /**
   * Shell → server: the terminal sessions the shell runs, as the gateway reads
   * them (`backlog.work`'s confirmation, the launch cap). Sent whole on every
   * change, and again to a restarted server.
   */
  terminalSessions: 'terminals.sessions',
  /**
   * Shell → server: the gateway launch tokens the shell's terminal launches
   * were issued, by digest (decision R87). `{ reset, changes }`: `reset` says
   * the list is every live one, sent to a server that has just started.
   */
  launchTokens: 'gateway.launch-tokens',
  /**
   * Shell → server: a Claude terminal's status-line usage windows
   * `{ rateLimits, at }`. The shell runs the terminals; the server keeps the
   * usage-limit store its IPC draws from and its resumes ask.
   */
  usageStatusLine: 'usage-limits.status-line',
  /** Shell → server: an SSH machine connected or reconnected `{ key }`; the server follows its chats (phase 8). */
  sshConnected: 'ssh.connected',
  /** Shell → server hints (6.3). */
  hintPower: 'hint.power',
  hintVisibility: 'hint.visibility',
  hintFocus: 'hint.focus',
  hintOnline: 'hint.online',
} as const

export type ServerMirrorRegistry = {
  state: WorkspaceSyncState
  snapshot: WorkspaceSyncSnapshot
  needsHydration: boolean
}

export type ServerMirrorLaunchSettings = { settings: AgentLaunchSettings; record: AgentLaunchSettingsRecord | null }

export type ServerMirrorState = ServerMirrorRegistry & { launchSettings: ServerMirrorLaunchSettings }

export type PowerHint = 'suspend' | 'resume' | 'lock' | 'unlock' | 'battery' | 'ac'

export type ServerInfo = {
  pid: number
  uptimeMs: number
  version: string
  gatewaySocket: string | null
  tailnetBound: string | null
  /** Which cipher seals the server's secrets. */
  cipher: 'desktop keychain (through the shell)' | 'key file'
  rssMb: number
}
