import { randomUUID } from 'node:crypto'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { CONVERSATION_SESSION_NOT_FOUND } from '../../shared/conversation-runtime'
import { distroOfHostId, workspaceHostIdOf } from '../../shared/execution-host'
import type { RemoteBackendMember, RemoteConversationBackend } from '../wsl/backend-wire'
import { createPathEdge, createWslPathEdge, type PathEdge } from '../wsl/wsl-path-edge'
import { isMachinePath, machinePath, parseMachinePath } from '../../shared/machine-paths'
import type { WslEnvironmentManager, WslServerConnection } from '../wsl/wsl-environment-manager'
import type { ConversationBackend } from './conversation-backend'

// The front door's router (phase 7 spec, 5.1–5.3): one `ConversationBackend`
// that answers every caller (the chat view's IPC and protocol, the phone's
// lane, the gateway, modules, scheduled and companion agents) and sends each
// call to the server that owns the chat.
//
// Which server owns a chat is decided by the workspace's machine, never by
// where its folder sits (section 6): a workspace on `wsl:<distro>`, or one
// whose folder is inside that distribution whatever its machine says, goes to
// that distribution's server when the person turned chats on there
// (`ExecutionHostSettings.chatServer`); everything else stays in this process,
// on today's per-process path. A call about a running session goes to
// whichever side holds that session, so a session started before the switch
// moved finishes where it started, and one chat never has two writers.
//
// Reads that need no server stay here: the provider catalog is the same build
// on both sides, and a live process's pid means nothing across the VM. Lists
// that span every chat (sessions, approval rules) merge this process's with
// those of the servers already running; they never start one.

/**
 * An SSH machine's server, as the router reaches it (phase 8): keyed
 * `ssh:<saved id>`, its paths already the server's own (a workspace on an SSH
 * machine is recorded with the remote's spelling), and reached through main's
 * SSH connection, which reconnects on its own.
 */
export type SshRoutedConnection = { key: string; label: string; backend: RemoteConversationBackend }

export type SshRoutedServers = {
  connect(key: string): Promise<SshRoutedConnection>
  current(key: string): SshRoutedConnection | null
  touch(key: string): void
}

export type RoutedConversationBackendDeps = {
  local: ConversationBackend
  /** The workspace's machine and folder, from the front door's registry. */
  workspace(
    workspaceId: string,
  ): { hostId?: string | null; folderPath?: string | null; environment?: { kind: 'ssh'; id: string } | null } | null
  /** Whether a distribution's chats run on its server (the per-distribution switch). */
  chatServerOn(distro: string): boolean
  servers?: Pick<WslEnvironmentManager, 'connect' | 'current' | 'touch'> | null
  /** SSH machines' servers, keyed `ssh:<id>`: a workspace recorded on one always runs there. */
  ssh?: SshRoutedServers | null
  platform?: NodeJS.Platform
  log?: (message: string) => void
}

export type RoutedConversationBackend = ConversationBackend & {
  /** A server connected (or reconnected): its events join the stream. */
  attach(connection: WslServerConnection | SshRoutedConnection): void
  /** Where a workspace's chats run now: `null` for this process, a distribution, or `ssh:<id>`. */
  routeOf(workspaceId: string, workspaceRoot?: string): string | null
  /**
   * A server's wire came back after it was lost (`key` as `routeOf` names
   * it). What that server published meanwhile reached nobody here, so every
   * subscription to one of its chats catches up from its cursor
   * (ConversationSessionApi).
   */
  onRouteResumed(listener: (key: string) => void): () => void
  /**
   * A server that held chats stopped (its process is gone: it crashed, or WSL
   * was shut down), as opposed to a wire that dropped under a server still
   * running. A turn it was running ended with it.
   */
  lost(key: string, message: string): void
  /** Who hears `lost`: every subscription to one of that server's chats closes the turn it shows open. */
  onRouteLost(listener: (key: string, message: string) => void): () => void
}

const SSH_KEY = /^ssh:[A-Za-z0-9_-]+$/u

// Members whose answer is `{ ok: false, message }` when they fail; the router
// answers a server it cannot reach the same way, in words.
const RESULT_MEMBERS: ReadonlySet<string> = new Set([
  'startSession',
  'sendTurn',
  'respondToRequest',
  'setPermission',
  'setModel',
  'interrupt',
  'stopSubagent',
  'askSideQuestion',
  'cancelSideQuestion',
  'stopSession',
  'suspendSession',
  'terminalHandoffTarget',
  'stopForTerminalHandoff',
  'readAttachment',
  'planDocument',
  'listThreads',
  'searchThreads',
  'renameThread',
  'deleteTranscript',
  'readTranscript',
  'readConversationSync',
  'readConversationPage',
  'getTurnDiff',
  'listApprovalRules',
  'revokeApprovalRule',
  'revertToTurn',
  'rewindToTurn',
  'handoffConversation',
  'forkAtTurn',
])

type Remote = { connection: WslServerConnection | SshRoutedConnection; edge: PathEdge; unsubscribe: () => void }

/**
 * An SSH machine's paths as this computer spells them (`ssh://<id>/…`,
 * shared/machine-paths.ts), and as its server takes them (plain).
 */
function sshPathEdge(key: string): PathEdge {
  const id = key.slice('ssh:'.length)
  return createPathEdge({
    isClientPath: isMachinePath,
    toServer(path) {
      const parsed = parseMachinePath(path)
      if (!parsed || parsed.id !== id) throw new Error(`${path} is not on this SSH machine.`)
      return parsed.path
    },
    pathOut: (path) => machinePath(id, path),
  })
}

// A call that carries a command id is answered once by the server's receipts,
// so after a lost SSH session it is sent again, and joins the turn still
// running there rather than start another (phase 8 spec, 7).
const RETRIES_AFTER_LOST_WIRE = 2

// The members the runtime answers once per command id. A call to an SSH
// machine that came without one (a window's IPC sends none) is given one
// here, so a session lost under it can be repeated safely.
const COMMAND_MEMBERS: ReadonlySet<string> = new Set([
  'sendTurn',
  'respondToRequest',
  'setPermission',
  'setModel',
  'interrupt',
  'stopSession',
])

function keyOf(connection: WslServerConnection | SshRoutedConnection): string {
  return 'distro' in connection ? connection.distro : connection.key
}

function workspaceKeyOf(first: unknown): { workspaceId?: string; workspaceRoot?: string } {
  if (typeof first !== 'object' || first === null) return {}
  const record = first as Record<string, unknown>
  const key = (typeof record.key === 'object' && record.key !== null ? record.key : record) as Record<string, unknown>
  return {
    ...(typeof key.workspaceId === 'string' ? { workspaceId: key.workspaceId } : {}),
    ...(typeof key.workspaceRoot === 'string' ? { workspaceRoot: key.workspaceRoot } : {}),
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRoutedConversationBackend(deps: RoutedConversationBackendDeps): RoutedConversationBackend {
  const { local } = deps
  const platform = deps.platform ?? process.platform
  const log = deps.log ?? (() => undefined)
  const listeners = new Set<(event: ConversationEvent) => void>()
  const remotes = new Map<string, Remote>()
  // Which distribution each remote session last said it was in, so a call
  // about it after its server restarted goes there (and is answered there),
  // not to this process, which never held it.
  const sessionDistro = new Map<string, string>()

  const dispatch = (event: ConversationEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        log(`A chat event listener threw: ${failureMessage(error)}`)
      }
    }
  }
  local.onEvent(dispatch)

  const resumedListeners = new Set<(key: string) => void>()
  const lostListeners = new Set<(key: string, message: string) => void>()

  function attach(connection: WslServerConnection | SshRoutedConnection): void {
    const key = keyOf(connection)
    const previous = remotes.get(key)
    if (previous?.connection === connection) return
    previous?.unsubscribe()
    const edge =
      'distro' in connection
        ? createWslPathEdge({ distro: connection.distro, driveMountRoot: connection.driveMountRoot })
        : sshPathEdge(key)
    const unsubscribe = connection.backend.onEvent((event) => {
      sessionDistro.set(event.sessionId, key)
      dispatch(event)
    })
    remotes.set(key, { connection, edge, unsubscribe })
    // A new wire to a server this router followed before: tell every
    // subscription to its chats to catch up.
    if (previous)
      for (const listener of [...resumedListeners]) {
        try {
          listener(key)
        } catch (error) {
          log(`A resume listener threw: ${failureMessage(error)}`)
        }
      }
  }

  /** The servers a key belongs to: an SSH machine's, or the WSL distributions'. */
  function serversOf(key: string) {
    const servers = SSH_KEY.test(key) ? deps.ssh : deps.servers
    if (!servers) throw new Error('That machine is not available in this app.')
    return servers as {
      connect(key: string): Promise<WslServerConnection | SshRoutedConnection>
      current(key: string): WslServerConnection | SshRoutedConnection | null
      touch(key: string): void
    }
  }

  function routeOf(workspaceId: string, workspaceRoot?: string): string | null {
    const record = deps.workspace(workspaceId)
    // A workspace on an SSH machine runs there, whatever this computer is.
    if (record?.environment?.kind === 'ssh' && deps.ssh) return `ssh:${record.environment.id}`
    // A folder spelled on an SSH machine is that machine's, whatever the record says.
    const machine = workspaceRoot && isMachinePath(workspaceRoot) ? parseMachinePath(workspaceRoot) : null
    if (machine && deps.ssh) return `ssh:${machine.id}`
    if (platform !== 'win32' || !deps.servers) return null
    // The machine decides (owner ruling 2026-10-03): a folder inside a
    // distribution whose workspace runs on This PC stays here, and a `C:\`
    // folder on a WSL machine goes there. The folder's distribution is only
    // the default for a workspace that names no machine.
    const distro = distroOfHostId(
      workspaceHostIdOf({ hostId: record?.hostId, folderPath: record?.folderPath ?? workspaceRoot ?? null }),
      platform,
    )
    return distro && deps.chatServerOn(distro) ? distro : null
  }

  function liveRemote(distro: string): Remote | null {
    const remote = remotes.get(distro)
    if (!remote) return null
    try {
      if (serversOf(distro).current(distro) !== remote.connection) return null
    } catch {
      return null
    }
    return remote
  }

  function sessionOwner(sessionId: string): string | null {
    const listed = local.listSessions()
    if (listed.ok && listed.sessions.some((session) => session.sessionId === sessionId)) return null
    for (const [distro, remote] of remotes) {
      const mirrored = remote.connection.backend.listSessions()
      if (mirrored.ok && mirrored.sessions.some((session) => session.sessionId === sessionId)) return distro
    }
    return sessionDistro.get(sessionId) ?? null
  }

  async function callRemote(distro: string, member: RemoteBackendMember, given: unknown[]): Promise<unknown> {
    const servers = serversOf(distro)
    const first = given[0] as { commandId?: unknown } | null | undefined
    const args =
      SSH_KEY.test(distro) &&
      COMMAND_MEMBERS.has(member) &&
      typeof first === 'object' &&
      first !== null &&
      typeof first.commandId !== 'string'
        ? [{ ...first, commandId: `route-${randomUUID()}` }, ...given.slice(1)]
        : given
    const repeatable =
      SSH_KEY.test(distro) && typeof (args[0] as { commandId?: unknown } | null)?.commandId === 'string'
    for (let attempt = 0; ; attempt++) {
      servers.touch(distro)
      const connection = await servers.connect(distro)
      let remote = remotes.get(distro)
      if (!remote || remote.connection !== connection) {
        attach(connection)
        remote = remotes.get(distro)!
      }
      const method = (connection.backend as unknown as Record<string, (...input: unknown[]) => unknown>)[member]
      try {
        const value = await method.apply(connection.backend, remote.edge.args(member, args))
        const session = (value as { session?: ConversationSessionSummary } | null)?.session
        if (session?.sessionId) sessionDistro.set(session.sessionId, distro)
        // Sent again after a lost wire, to a server that no longer holds the
        // session: that server restarted, and the first attempt may have run
        // before it went. Its receipt is on disk but this server cannot reach
        // it without the session, so the caller is not told to start the
        // session and send again, which would send the message twice.
        if (attempt > 0 && (value as { code?: unknown } | null)?.code === CONVERSATION_SESSION_NOT_FOUND)
          return {
            ok: false,
            message: `The connection to ${'label' in connection ? connection.label : `WSL: ${distro}`} was lost while this was being sent, and its Studio server has restarted since. Check the conversation before sending it again.`,
          }
        return remote.edge.result(member, value)
      } catch (error) {
        // The wire went under the call (a dropped SSH session): sent again
        // once the machine is back, the same command id is answered once.
        if (!repeatable || connection.backend.isOpen() || attempt >= RETRIES_AFTER_LOST_WIRE) throw error
        log(`${member} on ${distro}: the connection was lost mid-call; sending it again once it is back.`)
      }
    }
  }

  /** A call to a distribution's server, failing the way the member fails when the server cannot be reached. */
  async function guarded(distro: string, member: RemoteBackendMember, args: unknown[]): Promise<unknown> {
    try {
      return await callRemote(distro, member, args)
    } catch (error) {
      if (!RESULT_MEMBERS.has(member) && member !== 'getToolDetail') throw error
      const message = failureMessage(error)
      log(`${member} on ${SSH_KEY.test(distro) ? distro : `WSL: ${distro}`} failed: ${message}`)
      return member === 'getToolDetail' ? { ok: false, code: 'unavailable', message } : { ok: false, message }
    }
  }

  const localCall = (member: string, args: unknown[]): unknown =>
    (local as unknown as Record<string, (...input: unknown[]) => unknown>)[member].apply(local, args)

  /** A member answered where the chat's workspace runs. */
  const byWorkspace =
    (member: RemoteBackendMember) =>
    (...args: unknown[]): unknown => {
      const { workspaceId, workspaceRoot } = workspaceKeyOf(args[0])
      const distro = workspaceId ? routeOf(workspaceId, workspaceRoot) : null
      return distro ? guarded(distro, member, args) : localCall(member, args)
    }

  /** A member answered where the session runs. */
  const bySession =
    (member: RemoteBackendMember) =>
    (...args: unknown[]): unknown => {
      const first = args[0]
      const sessionId =
        typeof first === 'string'
          ? first
          : typeof (first as { sessionId?: unknown } | null)?.sessionId === 'string'
            ? (first as { sessionId: string }).sessionId
            : null
      const distro = sessionId ? sessionOwner(sessionId) : null
      return distro ? guarded(distro, member, args) : localCall(member, args)
    }

  const backend = {
    attach,
    routeOf,
    onRouteResumed(listener: (key: string) => void) {
      resumedListeners.add(listener)
      return () => resumedListeners.delete(listener)
    },
    lost(key: string, message: string) {
      for (const listener of [...lostListeners]) {
        try {
          listener(key, message)
        } catch (error) {
          log(`A lost-server listener threw: ${failureMessage(error)}`)
        }
      }
    },
    onRouteLost(listener: (key: string, message: string) => void) {
      lostListeners.add(listener)
      return () => lostListeners.delete(listener)
    },
    onEvent(listener: (event: ConversationEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listSessions(input: { workspaceId?: string; agentId?: string } = {}) {
      const listed = local.listSessions(input)
      if (!listed.ok) return listed
      const sessions = [...listed.sessions]
      for (const distro of remotes.keys()) {
        const remote = liveRemote(distro)
        const mirrored = remote?.connection.backend.listSessions(input)
        if (mirrored?.ok) sessions.push(...mirrored.sessions)
      }
      return { ok: true as const, sessions }
    },
    // A live process's pid means nothing on the other side of the VM.
    listLiveConversationRoots: () => local.listLiveConversationRoots(),
    // The same build on both sides: the catalog is this process's.
    getProviderCapabilities: (providerId: string) => local.getProviderCapabilities(providerId),
    getNativeProviderModels: (providerId: string) => local.getNativeProviderModels(providerId),
    startSession(...args: unknown[]) {
      const input = args[0] as { workspaceId: string; agentId: string; workspaceRoot: string }
      const live = (listed: ReturnType<ConversationBackend['listSessions']> | undefined) =>
        listed?.ok === true && listed.sessions.some((session) => session.status !== 'stopped')
      const key = { workspaceId: input.workspaceId, agentId: input.agentId }
      const distro = routeOf(input.workspaceId, input.workspaceRoot)
      if (!distro) {
        // The switch turned off under a chat still live on a server: it keeps
        // that one writer until it stops, as a chat live here does below.
        for (const [running, remote] of remotes) {
          if (liveRemote(running) && live(remote.connection.backend.listSessions(key)))
            return guarded(running, 'startSession', args)
        }
        return localCall('startSession', args)
      }
      // A chat still live here keeps its one writer until it stops.
      if (live(local.listSessions(key))) return localCall('startSession', args)
      return guarded(distro, 'startSession', args)
    },
    sendTurn: bySession('sendTurn'),
    hasCommandReceipt: bySession('hasCommandReceipt'),
    respondToRequest: bySession('respondToRequest'),
    setPermission: bySession('setPermission'),
    setModel: bySession('setModel'),
    interrupt: bySession('interrupt'),
    stopSubagent: bySession('stopSubagent'),
    askSideQuestion: bySession('askSideQuestion'),
    cancelSideQuestion: bySession('cancelSideQuestion'),
    stopSession: bySession('stopSession'),
    suspendSession: bySession('suspendSession'),
    terminalHandoffTarget: bySession('terminalHandoffTarget'),
    stopForTerminalHandoff: bySession('stopForTerminalHandoff'),
    endTerminalHandoff(...args: unknown[]) {
      const sessionId = (args[0] as { sessionId?: string } | null)?.sessionId
      const distro = sessionId ? sessionOwner(sessionId) : null
      if (!distro) {
        localCall('endTerminalHandoff', args)
        return
      }
      void guarded(distro, 'endTerminalHandoff', args).catch(() => undefined)
    },
    noteTerminalHandoff: bySession('noteTerminalHandoff'),
    getToolDetail: byWorkspace('getToolDetail'),
    findToolCall: byWorkspace('findToolCall'),
    async readAttachment(...args: unknown[]) {
      // A reference names no workspace: this process's store first, then each running server's.
      const here = (await localCall('readAttachment', args)) as { ok: boolean }
      if (here.ok) return here
      for (const distro of remotes.keys()) {
        if (!liveRemote(distro)) continue
        const there = (await guarded(distro, 'readAttachment', args)) as { ok: boolean }
        if (there.ok) return there
      }
      return here
    },
    planDocument: byWorkspace('planDocument'),
    listThreads: byWorkspace('listThreads'),
    searchThreads(...args: unknown[]) {
      const { workspaceId, workspaceRoot } = workspaceKeyOf(args[0])
      const distro = workspaceId ? routeOf(workspaceId, workspaceRoot) : null
      if (!distro) return localCall('searchThreads', args)
      return (async () => {
        const result = (await guarded(distro, 'searchThreads', [args[0]])) as {
          ok: boolean
          hits?: unknown[]
        }
        const onBatch = (args[1] as { onBatch?: (hits: unknown[]) => void } | undefined)?.onBatch
        if (result.ok && result.hits?.length) onBatch?.(result.hits)
        return result
      })()
    },
    renameThread: byWorkspace('renameThread'),
    deleteTranscript: byWorkspace('deleteTranscript'),
    readTranscript: byWorkspace('readTranscript'),
    readPeekTranscript: byWorkspace('readPeekTranscript'),
    readConversationSync: byWorkspace('readConversationSync'),
    readConversationPage: byWorkspace('readConversationPage'),
    recoverTranscript: byWorkspace('recoverTranscript'),
    getTurnDiff: byWorkspace('getTurnDiff'),
    async listApprovalRules() {
      const here = await local.listApprovalRules()
      if (!here.ok) return here
      const rules = [...here.rules]
      for (const distro of remotes.keys()) {
        if (!liveRemote(distro)) continue
        const there = (await guarded(distro, 'listApprovalRules', [])) as typeof here
        if (there.ok) rules.push(...there.rules)
      }
      return { ok: true as const, rules }
    },
    async revokeApprovalRule(ruleId: string) {
      const here = await local.revokeApprovalRule(ruleId)
      if (here.ok) return here
      for (const distro of remotes.keys()) {
        if (!liveRemote(distro)) continue
        const there = (await guarded(distro, 'revokeApprovalRule', [ruleId])) as typeof here
        if (there.ok) return there
      }
      return here
    },
    revertToTurn: byWorkspace('revertToTurn'),
    rewindToTurn: byWorkspace('rewindToTurn'),
    handoffConversation: byWorkspace('handoffConversation'),
    forkAtTurn: byWorkspace('forkAtTurn'),
  }
  return backend as unknown as RoutedConversationBackend
}
