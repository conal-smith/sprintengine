import type { StudioErrorCode } from './envelope.js'
import { STUDIO_LOCAL_SERVERS_CAPABILITY } from './handshake.js'
import type { StudioScope } from './scopes.js'

// The local servers a Studio's conversations started: a dev server, a preview,
// anything an agent ran that a person may want to open. An agent says so
// through the Studio's MCP gateway (`local_server.link`), with the URL and,
// when it has one, the command that starts it. The Studio checks each one
// where its agents run (is something accepting connections on its port?), so
// a client shows "Running" or "Stopped" and only displays what it is told.
//
// A server a person asks to run again is started by the Studio itself, from
// the command and folder the agent gave, and only that run can be stopped
// from a client: a server an agent started belongs to the agent's process,
// and the Studio does not reach into it.
//
// Two ways to ask, as for pull requests: by workspace (every conversation in
// it) and by conversation (one agent). `localServers.changed` names what
// moved, never the lists themselves, so a client asks again for what it is
// showing.
//
// Owners only in this version, behind the `local-servers` capability. `run`,
// `stop` and `remove` name a server by its id and the conversation it is
// linked to; `run` and `stop` are refused as `not_found` when that
// conversation has no server with that id.

/**
 * `running`: something accepts connections on the server's port. `stopped`:
 * nothing does. `starting`: the Studio is running its command and the port has
 * not opened yet.
 */
export type StudioLocalServerState = 'running' | 'stopped' | 'starting'

/** One linked server, as the Studio last checked it. */
export type StudioLocalServer = {
  /** Stable for the life of the link; what `run`, `stop` and `remove` name. */
  id: string
  /** The agent whose conversation linked it; with the workspace, what `run`, `stop` and `remove` name. */
  agentId: string
  /** What a person opens, as the agent gave it: `http://localhost:5173/`. */
  url: string
  /** The agent's name for it, else the URL's host and port. */
  title: string
  /** The port checked, read off the URL (80 or 443 when it names none). */
  port: number
  state: StudioLocalServerState
  /** When it was linked, ms epoch. */
  linkedAt: number
  /** When its state was last checked, ms epoch; 0 when it never has been. */
  stateAt: number
  /** The shell command that starts it, when the agent gave one: what "Run again" runs. */
  command?: string
  /** The folder the command runs in. */
  cwd?: string
  /** The Studio started the current run itself, so a client may stop it. */
  startedByStudio?: true
  /**
   * The last run the Studio started ended: its exit code (null when a signal
   * ended it) and the end of what it printed, so a client can say why it is
   * not running. Cleared when a run starts.
   */
  lastExit?: { code: number | null; at: number; output: string }
}

/** A conversation by its workspace and agent. */
export type StudioLocalServerOwner = { workspaceId: string; agentId: string }

/** What to ask about. Both lists are optional; at most `STUDIO_LOCAL_SERVERS_MAX_IDS` each. */
export type StudioLocalServersTarget = {
  workspaceIds?: string[]
  conversations?: StudioLocalServerOwner[]
}

/** The most ids one request may name in each list. */
export const STUDIO_LOCAL_SERVERS_MAX_IDS = 500
/** The longest URL a link may carry. */
export const STUDIO_LOCAL_SERVER_MAX_URL = 2048
/** The longest title a link may carry. */
export const STUDIO_LOCAL_SERVER_MAX_TITLE = 200
/** The longest command a link may carry. */
export const STUDIO_LOCAL_SERVER_MAX_COMMAND = 4096
/** The most of a run's output `lastExit.output` keeps: its end. */
export const STUDIO_LOCAL_SERVER_MAX_OUTPUT = 4000

export type StudioLocalServersMethodMap = {
  /**
   * Newest first. Only what has servers is answered: an id with none is left
   * out of `workspaces` and `conversations`.
   */
  'localServers.list': {
    params: StudioLocalServersTarget
    result: {
      workspaces: Record<string, StudioLocalServer[]>
      conversations: Array<StudioLocalServerOwner & { servers: StudioLocalServer[] }>
    }
  }
  /**
   * Start the server's command again, in its folder, as a process the Studio
   * owns. Refused as `invalid_params` when it has no command, and `conflict`
   * when it is already running or starting. The new state arrives as
   * `localServers.changed`.
   */
  'localServers.run': { params: { conversation: StudioLocalServerOwner; id: string }; result: { started: true } }
  /**
   * Stop the run the Studio started. Refused as `conflict` when the Studio did
   * not start the current run (an agent's server is the agent's to stop).
   */
  'localServers.stop': { params: { conversation: StudioLocalServerOwner; id: string }; result: { stopped: boolean } }
  /** Forget the link (and stop the Studio's own run of it, if any). `removed` is false when there was none. */
  'localServers.remove': { params: { conversation: StudioLocalServerOwner; id: string }; result: { removed: boolean } }
}

export type StudioLocalServersMethod = keyof StudioLocalServersMethodMap

export type StudioLocalServersTopicMap = {
  /** What moved, as `{ workspaceIds: string[], conversations: StudioLocalServerOwner[] }`; ask `localServers.list` again. */
  'localServers.changed': { params: Record<string, never> }
}

type MethodSpec = {
  scope: StudioScope
  mutation: false
  capability: typeof STUDIO_LOCAL_SERVERS_CAPABILITY
  owner: true
}

const read: MethodSpec = {
  scope: 'workspaces:read',
  mutation: false,
  capability: STUDIO_LOCAL_SERVERS_CAPABILITY,
  owner: true,
}
// Running a command is driving the conversation's work, not reading it.
const operate: MethodSpec = {
  ...read,
  scope: 'conversation:operate',
}

export const STUDIO_LOCAL_SERVERS_METHODS: { readonly [M in StudioLocalServersMethod]: MethodSpec } = {
  'localServers.list': read,
  'localServers.run': operate,
  'localServers.stop': operate,
  'localServers.remove': operate,
}

export const STUDIO_LOCAL_SERVERS_TOPICS: {
  readonly [T in keyof StudioLocalServersTopicMap]: {
    scope: StudioScope
    capability: typeof STUDIO_LOCAL_SERVERS_CAPABILITY
    owner: true
    push: true
  }
} = {
  'localServers.changed': {
    scope: 'workspaces:read',
    capability: STUDIO_LOCAL_SERVERS_CAPABILITY,
    owner: true,
    push: true,
  },
}

export function isStudioLocalServersMethod(value: unknown): value is StudioLocalServersMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_LOCAL_SERVERS_METHODS, value)
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = { ok: false; code: StudioErrorCode; message: string }
const refuse = (message: string): Refusal => ({ ok: false, code: 'invalid_params', message })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A conversation by workspace and agent, or null. */
export function parseStudioLocalServerOwner(value: unknown): StudioLocalServerOwner | null {
  if (!record(value) || !id(value.workspaceId) || !id(value.agentId)) return null
  return { workspaceId: value.workspaceId, agentId: value.agentId }
}

function parseTarget(value: Record<string, unknown>): StudioLocalServersTarget | Refusal {
  const target: StudioLocalServersTarget = {}
  if (value.workspaceIds !== undefined) {
    if (!Array.isArray(value.workspaceIds) || value.workspaceIds.length > STUDIO_LOCAL_SERVERS_MAX_IDS)
      return refuse(`"workspaceIds" is a list of at most ${STUDIO_LOCAL_SERVERS_MAX_IDS} workspace ids.`)
    if (!value.workspaceIds.every(id)) return refuse('Every entry of "workspaceIds" is a workspace id.')
    target.workspaceIds = [...new Set(value.workspaceIds as string[])]
  }
  if (value.conversations !== undefined) {
    if (!Array.isArray(value.conversations) || value.conversations.length > STUDIO_LOCAL_SERVERS_MAX_IDS)
      return refuse(`"conversations" is a list of at most ${STUDIO_LOCAL_SERVERS_MAX_IDS} conversations.`)
    const conversations: StudioLocalServerOwner[] = []
    for (const entry of value.conversations) {
      const owner = parseStudioLocalServerOwner(entry)
      if (!owner) return refuse('Every entry of "conversations" is { workspaceId, agentId }.')
      conversations.push(owner)
    }
    target.conversations = conversations
  }
  return target
}

/** A `localServers.*` method's params, shape-checked, keeping only the members it defines. */
export function parseStudioLocalServersParams<M extends StudioLocalServersMethod>(
  method: M,
  params: unknown,
): { ok: true; params: StudioLocalServersMethodMap[M]['params'] } | Refusal {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse(`${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioLocalServersMethodMap[M]['params'] })
  if (method === 'localServers.list') {
    const target = parseTarget(value)
    return 'ok' in target ? target : ok(target)
  }
  if (method === 'localServers.run' || method === 'localServers.stop' || method === 'localServers.remove') {
    const conversation = parseStudioLocalServerOwner(value.conversation)
    if (!conversation) return refuse('"conversation" is { workspaceId, agentId }.')
    if (!id(value.id)) return refuse('"id" is the server\'s id, from localServers.list.')
    return ok({ conversation, id: value.id })
  }
  return refuse(`${method} is not a localServers method.`)
}
