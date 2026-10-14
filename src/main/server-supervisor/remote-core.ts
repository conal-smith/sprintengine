import type { StudioTransportFactory } from '../../../packages/agent-sdk/src/transport'
import type { StudioCore } from '../../server/core/studio-core'
import type { ControlRpc } from '../../server/bootstrap/control-rpc'
import { SERVER_EVENTS, SERVER_METHODS } from '../../server/desktop/server-methods'
import { gitHostIdForPath } from '../../shared/execution-host'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import { installGitHostResolver } from '../git-run'
import { createHostRegistry, installHostRegistry } from '../hosts/host-registry'
import { setWorktreeBranchPrefixReader } from '../worktree-branch-prefix'
import type { TerminalRootInfo } from '../workspace-memory'
import type { GitHubTokenStatus, GitHubTokenStore } from '../github-token-store'
import type { ProviderSecretStore, ProviderSecretValueResult } from '../secret-store'
import type { ServerStateMirror } from './server-mirror'

// The shell's view of the core when the Studio server runs in a process of its
// own (phase 6 spec, sections 5 and 7.3). The shell builds no server-owned
// store: what it reads synchronously comes from the mirror, what it writes or
// asks goes over the control channel, and the machines its terminals launch on
// come from a host registry of its own over the mirrored settings.
//
// It has the core's shape for the members the shell's composition uses, so
// that composition does not branch on every read. Any other member is the
// server's alone, and reaching for it throws by name rather than returning
// nothing: a missed conversion fails in development, not quietly in the field.

export type ShellServerLink = {
  rpc: ControlRpc
  mirror: ServerStateMirror
  /** Waits until the server is serving (or gives up after the budget). */
  whenServing(budgetMs: number): Promise<boolean>
  isServing(): boolean
  /** Every time a server says ready: the first, and each restart's. */
  onServing(listener: () => void): () => void
  /**
   * Connections for the shell's own Studio client to its server, each over a
   * port the shell brokers on the control channel, with the shell role. Called
   * again for every reconnect, so a restarted server is reached too.
   */
  shellTransport(): StudioTransportFactory
  /** Hand the server a port spliced onto an SSH machine's relay stream (phase 8). False while it restarts. */
  attachSshPort?(clientId: string, port: Electron.MessagePortMain): boolean
}

/** The members of the core the shell uses, out of process. */
const SHELL_CORE_MEMBERS = new Set([
  'agentLaunchSettings',
  'hosts',
  'workspaceRegistry',
  'workspaceSyncService',
  'conversations',
  'conversationOwner',
  'dataDirLock',
  // Read only by the gateway and module wiring that the shell skips out of
  // process; present so destructuring the core does not throw.
  'conversationModelCatalog',
  'conversationLaunchService',
  'resolveAgentPermissionPreset',
])

export function createRemoteCore(link: ShellServerLink): StudioCore {
  const { mirror, rpc } = link
  // The machines this computer offers, for the shell's terminal launches: one
  // registry in each process, over the same settings.
  const hosts = createHostRegistry({ readHostSettings: () => mirror.launchSettings.get().hosts })
  installHostRegistry(hosts)
  // The worktree branch prefix the shell names its own worktrees with (a New
  // chat's, a pool lease's), from the same settings the server names its by.
  setWorktreeBranchPrefixReader(() => effectiveAgentLaunchSettings(mirror.launchSettings.get()).worktreeBranchPrefix)
  let lastHosts = JSON.stringify(mirror.launchSettings.get().hosts)
  mirror.launchSettings.subscribe((record) => {
    const next = JSON.stringify(record.settings.hosts)
    if (next === lastHosts) return
    lastHosts = next
    hosts.notifyChanged()
  })
  // The git panel's git for a repository runs on the machine of the open
  // workspace holding it, as the core arranges in process (`gitHostIdForPath`).
  // The server installs the same rule for its own git; this is the shell's,
  // for the panel it keeps.
  installGitHostResolver((cwd) => {
    if (process.platform !== 'win32') return null
    const id = gitHostIdForPath(cwd, mirror.workspaceSync.getSnapshot().state.workspaces)
    return id ? hosts.get(id) : null
  })

  // The folders the server's chats run in, for Diagnostics' per-workspace
  // memory, which reads them synchronously: each read answers the last list
  // and asks for the next, and the panel polls while it is open.
  let conversationRoots: TerminalRootInfo[] = []
  let rootsInFlight = false
  const readConversationRoots = (): TerminalRootInfo[] => {
    if (!link.isServing()) {
      conversationRoots = []
      return conversationRoots
    }
    if (!rootsInFlight) {
      rootsInFlight = true
      rpc
        .call<TerminalRootInfo[]>(SERVER_METHODS.conversationRoots)
        .then(
          (roots) => {
            conversationRoots = Array.isArray(roots) ? roots : []
          },
          () => undefined,
        )
        .finally(() => {
          rootsInFlight = false
        })
    }
    return conversationRoots
  }

  const serverOnly = (member: string) => () => {
    throw new Error(`${member} is the Studio server's; the shell reaches it over the control channel.`)
  }
  const members: Record<string, unknown> = {
    agentLaunchSettings: mirror.launchSettings,
    hosts,
    workspaceRegistry: mirror.registry,
    workspaceSyncService: mirror.workspaceSync,
    // Chats live in the server. The shell's own uses of them (the control
    // plane that types at agents, the attention badge, the peek card) are
    // served there or over the channel; what is left here answers as a
    // process with no chats of its own, except the folders they run in, which
    // Diagnostics asks the server for.
    conversations: {
      listSessions: () => ({ ok: true, sessions: [] }),
      sendTurn: async () => ({ ok: false, message: 'Chats are served by the Studio server.' }),
      interrupt: async () => ({ ok: false, message: 'Chats are served by the Studio server.' }),
      onEvent: () => () => undefined,
      listLiveConversationRoots: readConversationRoots,
      // Asked of the server as the worktree cleanup needs it, not cached: it is
      // the last look before a worktree is removed.
      liveConversationWorkspaceRoots: () =>
        link.isServing()
          ? rpc.call<unknown>(SERVER_METHODS.conversationWorkspaceRoots).then(
              (roots) => (Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string') : []),
              () => [],
            )
          : Promise.resolve([]),
    },
    conversationOwner: {
      // One idle setting governs terminals and chats; the chats' half is the server's.
      setIdleThresholdMs: (value: unknown) => rpc.emit(SERVER_EVENTS.conversationIdleThreshold, value),
      // The chats run in the server; none of them is this process's to hear settle.
      onSessionIdle: () => () => undefined,
      flushTranscripts: () => undefined,
      shutdown: () => undefined,
    },
    dataDirLock: null,
    conversationModelCatalog: { forCli: serverOnly('conversationModelCatalog') },
    conversationLaunchService: { launch: serverOnly('conversationLaunchService') },
    resolveAgentPermissionPreset: serverOnly('resolveAgentPermissionPreset'),
  }
  return new Proxy(members, {
    get(target, property) {
      if (typeof property === 'string' && SHELL_CORE_MEMBERS.has(property)) return target[property]
      if (typeof property === 'symbol' || property === 'then') return undefined
      throw new Error(`core.${String(property)} is the Studio server's; the shell does not hold it out of process.`)
    },
  }) as unknown as StudioCore
}

/** The GitHub token, which the server keeps: the shell's skills, cards and marketplace ask for it. */
export function createRemoteGitHubTokenStore(
  rpc: Pick<ControlRpc, 'call'>,
): Pick<GitHubTokenStore, 'getStatus' | 'resolveToken' | 'readToken' | 'writeToken' | 'clearToken'> {
  const ask = <T>(op: string, extra: Record<string, unknown> = {}) =>
    rpc.call<T>(SERVER_METHODS.githubToken, { op, ...extra })
  return {
    getStatus: () => ask<GitHubTokenStatus>('status'),
    // A token is only ever a convenience to a read: with no server, there is none.
    resolveToken: (explicit?: string | null) =>
      ask<string>('resolve', explicit ? { explicit } : {}).catch(() => explicit?.trim() || ''),
    readToken: () => ask<string | null>('read').catch(() => null),
    writeToken: (token: string) => ask<GitHubTokenStatus>('write', { token }),
    clearToken: () => ask<GitHubTokenStatus>('clear'),
  }
}

/**
 * The credential a terminal launch hands its CLI (phase 6 spec,
 * `secrets.resolveForLaunch`): kept by the server, asked for by the shell
 * only, at the moment of the launch.
 */
export function createRemoteCredentialStore(rpc: Pick<ControlRpc, 'call'>): ProviderSecretStore {
  return {
    resolveSecret: (cli: string) =>
      rpc
        .call<ProviderSecretValueResult>(SERVER_METHODS.resolveSecretForLaunch, { cli })
        .catch((error: unknown): ProviderSecretValueResult => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })),
  } as unknown as ProviderSecretStore
}
