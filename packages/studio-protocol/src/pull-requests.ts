import type { StudioErrorCode } from './envelope.js'
import {
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
} from './handshake.js'
import type { StudioScope } from './scopes.js'

// The pull requests a Studio's conversations opened. A conversation owns a
// pull request when its agent opened it: a create command or tool whose output
// named it, or the agent saying so through the Studio's MCP gateway. A Studio
// reads each one's state from its host (GitHub, through `gh`) and watches the
// open ones until they land; one on another forge is shown as opened. A client
// only displays them: a sidebar's mark, a tooltip, a peek's menu.
//
// Two ways to ask, by workspace (every conversation in it, and every agent it
// ever had) and by conversation (one agent). `pullRequests.changed` names what
// moved, never the lists themselves, so a client asks again for what it is
// showing. A Studio with no way to ask its host (no `gh`, or not signed in)
// answers with what it last read and never fails for it.
//
// `pullRequests.noteToolCall` and `pullRequests.noteWork` are for a client that
// runs agents the Studio does not: the desktop's terminal agents. The first
// forwards a tool call such an agent made, which the Studio reads exactly as
// it reads its own chats' calls; the second says which checkout the agent is
// in, which decides which of its pull requests are from the branch it is on.
//
// Owners only in this version, behind the `pull-requests` capability,
// `pullRequests.noteToolCall` behind `pull-request-tool-calls`,
// `pullRequests.link` (an owner that opened a pull request for a conversation)
// behind `pull-request-link`, and `pullRequests.unwatch` (an owner stopping an
// agent's watch on one) behind `pull-request-watch`.

export type StudioPullRequestState = 'open' | 'merged' | 'closed'

/** The forges besides GitHub a pull request can be on. */
export type StudioPullRequestForge = 'gitlab' | 'gitea' | 'bitbucket' | 'azure-devops'

/** One pull request, as its host last answered for it. */
export type StudioPullRequest = {
  /** Canonical: `https://<host>/<owner>/<repo>/pull/<n>` on GitHub, the forge's own shape elsewhere. */
  url: string
  /** The repository it is in, `host/owner/name`. Not always the conversation's own. */
  repoKey: string
  repoName: string
  number: number
  title: string
  state: StudioPullRequestState
  /** A draft is still `open`. */
  isDraft: boolean
  /** When it was opened, ms epoch; 0 when the host never said. */
  openedAt: number
  /** When its state was last read from the host, ms epoch; 0 when it never has been. */
  stateAt: number
  /** When it merged, or closed without merging, ms epoch. Absent while open, or when the host never said. */
  endedAt?: number
  /**
   * Set when it is not on GitHub. Its state is not read, so `state` stays
   * `open` and a client says "opened" rather than "open".
   */
  forge?: StudioPullRequestForge
  /**
   * On a conversation's list only: the pull request is on the branch the
   * conversation's own checkout is on, and so may say whether that branch has
   * landed. Absent for one found in another repository the agent worked in.
   */
  onConversationBranch?: true
  /**
   * Present while the conversation's agent has the Studio watching it. Sent
   * only by a Studio that advertises `pull-request-watch`; a client that does
   * not read it shows the pull request as it always did.
   */
  watch?: StudioPullRequestWatch
}

/**
 * What a watched pull request waits on, as the Studio's last read of it left
 * it, most pressing first: its checks to finish, a failed check, its branch
 * behind or conflicting with the base, the changes a reviewer asked for, a
 * review, or only the merge. `first-read` is a watch the Studio has not read
 * yet. A client reads a word it does not know as plain watching.
 */
export type StudioPullRequestWatchWaitingOn =
  'first-read' | 'checks' | 'checks-failed' | 'behind' | 'conflicts' | 'changes-requested' | 'review' | 'merge'

/**
 * A pull request the conversation's agent asked the Studio to watch: the
 * Studio reads it every couple of minutes and wakes the conversation when it
 * needs a look, until it merges or closes, or the watch is stopped.
 */
export type StudioPullRequestWatch = {
  /** When the watch began, ms epoch. */
  since: number
  waitingOn: StudioPullRequestWatchWaitingOn
  /** A reviewer approved it. */
  approved?: true
  /** GitHub merges it on its own once it may (auto-merge is on). */
  autoMerge?: true
  /** The branch it merges into, once read. */
  base?: string
  /** How many checks failed on its head, while some did. */
  failedChecks?: number
}

/** A conversation by its workspace and agent. */
export type StudioPullRequestOwner = { workspaceId: string; agentId: string }

/** What to ask about. Both lists are optional; at most `STUDIO_PULL_REQUESTS_MAX_IDS` each. */
export type StudioPullRequestsTarget = {
  workspaceIds?: string[]
  conversations?: StudioPullRequestOwner[]
}

/** The most ids one request may name in each list. */
export const STUDIO_PULL_REQUESTS_MAX_IDS = 500
/** The most changed paths one `noteWork` may carry. */
export const STUDIO_PULL_REQUESTS_MAX_PATHS = 256
/** The longest command one `noteToolCall` may carry. */
export const STUDIO_PULL_REQUESTS_MAX_COMMAND = 4096
/** The longest output one `noteToolCall` may carry: the client sends both ends of a longer one. */
export const STUDIO_PULL_REQUESTS_MAX_OUTPUT = 32 * 1024

export type StudioPullRequestsMethodMap = {
  /**
   * Newest first, de-duplicated by URL. Only what has pull requests is
   * answered: an id with none is left out of `workspaces` and `conversations`.
   */
  'pullRequests.list': {
    params: StudioPullRequestsTarget
    result: {
      workspaces: Record<string, StudioPullRequest[]>
      conversations: Array<StudioPullRequestOwner & { pullRequests: StudioPullRequest[] }>
    }
  }
  /**
   * Ask the host again: re-read states older than a minute. With no ids,
   * every open pull request the Studio holds. `asked` is false when there was
   * nothing to ask about. The answers arrive as `pullRequests.changed`.
   */
  'pullRequests.refresh': { params: StudioPullRequestsTarget; result: { asked: boolean } }
  /**
   * An agent this client runs is in this checkout (the branch it is on).
   * `turnEnded` also re-reads the stale states of the pull requests it opened.
   * `sessionId` and `changedPaths` are accepted from older clients and no
   * longer read: a branch never decides which pull requests are whose.
   */
  'pullRequests.noteWork': {
    params: {
      conversation: StudioPullRequestOwner
      /** The client's own id for the session the agent runs in. */
      sessionId?: string
      checkout?: { gitRoot: string; branch: string }
      /** Absolute paths, in this Studio's spelling. */
      changedPaths?: string[]
      turnEnded?: boolean
    }
    result: Record<string, never>
  }
  /**
   * An agent this client runs made a tool call that may have opened a pull
   * request: its tool's name, the shell command it ran (if any), and what it
   * printed. The Studio decides whether it opened one, with the same reader it
   * uses for its own chats' calls, and records it as the conversation's.
   */
  'pullRequests.noteToolCall': {
    params: {
      conversation: StudioPullRequestOwner
      toolCall: { name: string; command?: string; output: string; failed?: boolean }
    }
    result: Record<string, never>
  }
  /**
   * The owner opened this pull request for the conversation (the desktop's
   * "Create PR"). Recorded as the conversation's unless another one claimed it
   * first, which is refused as `conflict`; a URL that is not a pull request is
   * `invalid_params`. `recorded` is false when it was already this one's.
   */
  'pullRequests.link': {
    params: { conversation: StudioPullRequestOwner; url: string; title?: string }
    result: { recorded: boolean; pullRequest: StudioPullRequest }
  }
  /**
   * Stop the Studio watching this pull request for the conversation: it is
   * no longer read for the agent, and the conversation is not woken about it
   * again. The pull request stays the conversation's. `watched` is false when
   * it was not being watched.
   */
  'pullRequests.unwatch': {
    params: { conversation: StudioPullRequestOwner; url: string }
    result: { watched: boolean }
  }
}

export type StudioPullRequestsMethod = keyof StudioPullRequestsMethodMap

export type StudioPullRequestsTopicMap = {
  /** What moved, as `{ workspaceIds: string[], conversations: StudioPullRequestOwner[] }`; ask `pullRequests.list` again. */
  'pullRequests.changed': { params: Record<string, never> }
}

type MethodSpec = {
  scope: StudioScope
  mutation: false
  capability:
    | typeof STUDIO_PULL_REQUESTS_CAPABILITY
    | typeof STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY
    | typeof STUDIO_PULL_REQUEST_LINK_CAPABILITY
    | typeof STUDIO_PULL_REQUEST_WATCH_CAPABILITY
  owner: true
}

const owned: MethodSpec = {
  scope: 'workspaces:read',
  mutation: false,
  capability: STUDIO_PULL_REQUESTS_CAPABILITY,
  owner: true,
}

export const STUDIO_PULL_REQUESTS_METHODS: { readonly [M in StudioPullRequestsMethod]: MethodSpec } = {
  'pullRequests.list': owned,
  'pullRequests.refresh': owned,
  'pullRequests.noteWork': owned,
  // Its own capability: a client that runs agents asks for it before it
  // forwards a call, and a Studio from before it has none to offer.
  'pullRequests.noteToolCall': { ...owned, capability: STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY },
  'pullRequests.link': { ...owned, capability: STUDIO_PULL_REQUEST_LINK_CAPABILITY },
  'pullRequests.unwatch': { ...owned, capability: STUDIO_PULL_REQUEST_WATCH_CAPABILITY },
}

export const STUDIO_PULL_REQUESTS_TOPICS: {
  readonly [T in keyof StudioPullRequestsTopicMap]: {
    scope: StudioScope
    capability: typeof STUDIO_PULL_REQUESTS_CAPABILITY
    owner: true
    push: true
  }
} = {
  'pullRequests.changed': {
    scope: 'workspaces:read',
    capability: STUDIO_PULL_REQUESTS_CAPABILITY,
    owner: true,
    push: true,
  },
}

export function isStudioPullRequestsMethod(value: unknown): value is StudioPullRequestsMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_PULL_REQUESTS_METHODS, value)
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
export function parseStudioPullRequestOwner(value: unknown): StudioPullRequestOwner | null {
  if (!record(value) || !id(value.workspaceId) || !id(value.agentId)) return null
  return { workspaceId: value.workspaceId, agentId: value.agentId }
}

function parseTarget(value: Record<string, unknown>): StudioPullRequestsTarget | Refusal {
  const target: StudioPullRequestsTarget = {}
  if (value.workspaceIds !== undefined) {
    if (!Array.isArray(value.workspaceIds) || value.workspaceIds.length > STUDIO_PULL_REQUESTS_MAX_IDS)
      return refuse(`"workspaceIds" is a list of at most ${STUDIO_PULL_REQUESTS_MAX_IDS} workspace ids.`)
    if (!value.workspaceIds.every(id)) return refuse('Every entry of "workspaceIds" is a workspace id.')
    target.workspaceIds = [...new Set(value.workspaceIds as string[])]
  }
  if (value.conversations !== undefined) {
    if (!Array.isArray(value.conversations) || value.conversations.length > STUDIO_PULL_REQUESTS_MAX_IDS)
      return refuse(`"conversations" is a list of at most ${STUDIO_PULL_REQUESTS_MAX_IDS} conversations.`)
    const conversations: StudioPullRequestOwner[] = []
    for (const entry of value.conversations) {
      const owner = parseStudioPullRequestOwner(entry)
      if (!owner) return refuse('Every entry of "conversations" is { workspaceId, agentId }.')
      conversations.push(owner)
    }
    target.conversations = conversations
  }
  return target
}

/** A `pullRequests.*` method's params, shape-checked, keeping only the members it defines. */
export function parseStudioPullRequestsParams<M extends StudioPullRequestsMethod>(
  method: M,
  params: unknown,
): { ok: true; params: StudioPullRequestsMethodMap[M]['params'] } | Refusal {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse(`${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioPullRequestsMethodMap[M]['params'] })
  if (method === 'pullRequests.list' || method === 'pullRequests.refresh') {
    const target = parseTarget(value)
    return 'ok' in target ? target : ok(target)
  }
  if (method === 'pullRequests.noteToolCall') {
    const conversation = parseStudioPullRequestOwner(value.conversation)
    if (!conversation) return refuse('"conversation" is { workspaceId, agentId }.')
    const call = value.toolCall
    if (
      !record(call) ||
      typeof call.name !== 'string' ||
      call.name.length > 200 ||
      typeof call.output !== 'string' ||
      call.output.length > STUDIO_PULL_REQUESTS_MAX_OUTPUT ||
      (call.command !== undefined &&
        (typeof call.command !== 'string' || call.command.length > STUDIO_PULL_REQUESTS_MAX_COMMAND)) ||
      (call.failed !== undefined && typeof call.failed !== 'boolean')
    )
      return refuse(
        `"toolCall" is { name, output, command?, failed? }: a command of at most ${STUDIO_PULL_REQUESTS_MAX_COMMAND} characters and an output of at most ${STUDIO_PULL_REQUESTS_MAX_OUTPUT}.`,
      )
    return ok({
      conversation,
      toolCall: {
        name: call.name,
        output: call.output,
        ...(typeof call.command === 'string' ? { command: call.command } : {}),
        ...(typeof call.failed === 'boolean' ? { failed: call.failed } : {}),
      },
    })
  }
  if (method === 'pullRequests.link') {
    const conversation = parseStudioPullRequestOwner(value.conversation)
    if (!conversation) return refuse('"conversation" is { workspaceId, agentId }.')
    if (typeof value.url !== 'string' || value.url.length === 0 || value.url.length > 2048)
      return refuse('"url" is the pull request\'s web URL.')
    if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 300))
      return refuse('"title" is a string of at most 300 characters.')
    return ok({ conversation, url: value.url, ...(typeof value.title === 'string' ? { title: value.title } : {}) })
  }
  if (method === 'pullRequests.unwatch') {
    const conversation = parseStudioPullRequestOwner(value.conversation)
    if (!conversation) return refuse('"conversation" is { workspaceId, agentId }.')
    if (typeof value.url !== 'string' || value.url.length === 0 || value.url.length > 2048)
      return refuse('"url" is the pull request\'s web URL.')
    return ok({ conversation, url: value.url })
  }
  if (method !== 'pullRequests.noteWork') return refuse(`${method} is not a pullRequests method.`)
  const conversation = parseStudioPullRequestOwner(value.conversation)
  if (!conversation) return refuse('"conversation" is { workspaceId, agentId }.')
  const parsed: StudioPullRequestsMethodMap['pullRequests.noteWork']['params'] = { conversation }
  if (value.sessionId !== undefined) {
    if (!id(value.sessionId)) return refuse('"sessionId" is a string of 1 to 200 characters.')
    parsed.sessionId = value.sessionId
  }
  if (value.checkout !== undefined) {
    const checkout = value.checkout
    if (
      !record(checkout) ||
      typeof checkout.gitRoot !== 'string' ||
      checkout.gitRoot.length === 0 ||
      checkout.gitRoot.length > 4096 ||
      checkout.gitRoot.includes('\0') ||
      typeof checkout.branch !== 'string' ||
      checkout.branch.length === 0 ||
      checkout.branch.length > 255 ||
      checkout.branch.startsWith('-') ||
      checkout.branch.includes('\0')
    )
      return refuse('"checkout" is { gitRoot, branch }: a folder, and a branch name that does not start with "-".')
    parsed.checkout = { gitRoot: checkout.gitRoot, branch: checkout.branch }
  }
  if (value.changedPaths !== undefined) {
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length > STUDIO_PULL_REQUESTS_MAX_PATHS)
      return refuse(`"changedPaths" is a list of at most ${STUDIO_PULL_REQUESTS_MAX_PATHS} paths.`)
    if (
      !value.changedPaths.every(
        (path) => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'),
      )
    )
      return refuse('Every entry of "changedPaths" is an absolute path.')
    parsed.changedPaths = value.changedPaths as string[]
  }
  if (value.turnEnded !== undefined) {
    if (typeof value.turnEnded !== 'boolean') return refuse('"turnEnded" is true or false.')
    parsed.turnEnded = value.turnEnded
  }
  return ok(parsed)
}
