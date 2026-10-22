// What a client and a Studio say about themselves before anything else.
//
// The rule is the conversation lane's, one level up: features are asked about
// by capability, and the version integer exists only to refuse a peer outright
// when a change could not be additive, naming both numbers when it does. The
// conversation contract's own version and capabilities travel inside the
// welcome unchanged, so a client that speaks only conversations reads exactly
// what it reads from the tailnet lane.

/** The envelope, handshake and method table this package describes. */
export const STUDIO_PROTOCOL_VERSION = 1
/** The oldest version a Studio built from this package still serves. */
export const STUDIO_PROTOCOL_MIN_SUPPORTED = 1

/** Follow, list and drive conversations: the `conversation.*` reads, commands and the session stream. */
export const STUDIO_CONVERSATIONS_CAPABILITY = 'conversations' as const
/** Start a conversation with `conversation.create`. */
export const STUDIO_CONVERSATION_CREATE_CAPABILITY = 'conversation-create' as const
/** A `hello` may carry a one-time pairing code instead of a token, and is answered with the token. */
export const STUDIO_LOCAL_PAIRING_CAPABILITY = 'local-pairing' as const
/**
 * A conversation may be addressed by its folder as well as its workspace
 * (`key.workspaceRoot`): a chat started in a run worktree is kept in that
 * worktree, not in its workspace's folder. Owners only.
 */
export const STUDIO_CONVERSATION_FOLDERS_CAPABILITY = 'conversation-folders' as const
/** Drive a chat's live session by its id, as Studio's own chat view does: `session.*` and `uploads.*`. */
export const STUDIO_SESSIONS_CAPABILITY = 'conversation-sessions' as const
/** Read a sent picture back (`conversation.attachment`) and open a proposed plan as a file (`conversation.planDocument`). */
export const STUDIO_CONVERSATION_FILES_CAPABILITY = 'conversation-files' as const
/** Revert a turn's files from its checkpoint, take a chat back to an earlier message, or fork it there. */
export const STUDIO_CHECKPOINTS_CAPABILITY = 'conversation-checkpoints' as const
/** The `/` command list a chat's CLI reports for a folder: `conversation.commands` and its stream. */
export const STUDIO_COMMANDS_CAPABILITY = 'conversation-commands' as const
/** The conversation providers, their models and whether each has its key: `providers.*`. */
export const STUDIO_PROVIDERS_CAPABILITY = 'providers' as const
/** File search for @-mentions, and the file facts a chat's links and pictures need: `files.*`. */
export const STUDIO_FILES_CAPABILITY = 'files-mention' as const
/** The workspaces this Studio holds: `workspaces.list`. */
export const STUDIO_WORKSPACES_CAPABILITY = 'workspaces' as const
/**
 * A client may offer toolsets for Studio's agents (`tools.*`), and is sent a
 * `call` when an agent uses one. A client sends `reply` and `progress` frames
 * only to a Studio that advertises this.
 */
export const STUDIO_CLIENT_TOOLS_CAPABILITY = 'client-tools' as const
/**
 * Files under a workspace's roots, by root and relative path: `files.roots`,
 * `list`, `read`, `write`, `remove`, `stat` with a root, and the `files.watch`
 * stream. Owners only. What a client runs the canvas over a Studio's boards with.
 */
export const STUDIO_BOARD_FILES_CAPABILITY = 'files-write' as const
/**
 * The pull requests a Studio's conversations opened: `pullRequests.list`,
 * `refresh` and `noteWork`, and the `pullRequests.changed` stream. Owners only.
 */
export const STUDIO_PULL_REQUESTS_CAPABILITY = 'pull-requests' as const
/**
 * `pullRequests.noteToolCall`: a client forwards a tool call one of its own
 * agents made, and the Studio decides whether it opened a pull request. Owners
 * only, beside `pull-requests`.
 */
export const STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY = 'pull-request-tool-calls' as const
/**
 * `pullRequests.link`: an owner records a pull request it opened for one of
 * the Studio's conversations (the desktop's "Create PR" button). Owners only.
 */
export const STUDIO_PULL_REQUEST_LINK_CAPABILITY = 'pull-request-link' as const
/**
 * `pullRequests.unwatch`: an owner stops a conversation's agent watching one
 * of its pull requests. A Studio that advertises it may also send `watch` on a
 * listed pull request, which says what a watched one waits on. Owners only.
 */
export const STUDIO_PULL_REQUEST_WATCH_CAPABILITY = 'pull-request-watch' as const
/**
 * The local servers a Studio's conversations started: `localServers.list`,
 * `run`, `stop` and `remove`, and the `localServers.changed` stream. Owners
 * only.
 */
export const STUDIO_LOCAL_SERVERS_CAPABILITY = 'local-servers' as const

/**
 * `session.send` takes `files`, the files a message attaches by path, and the
 * `user_message` it becomes carries them. A Studio without it drops the member
 * unread, so a client sends it only where this is advertised.
 */
export const STUDIO_SESSION_FILES_CAPABILITY = 'session-files' as const

/**
 * `conversation.handoff`: hand a chat off to a fresh session of its CLI,
 * pointed at a file of the chat's messages, instead of compacting it. Owners
 * only.
 */
export const STUDIO_HANDOFF_CAPABILITY = 'conversation-handoff' as const

/**
 * Every Studio capability this version of the package knows, in the order
 * they shipped. A Studio advertises the ones it serves; a client reads a name
 * it does not know as a feature it does not use.
 */
export const STUDIO_CAPABILITIES = [
  STUDIO_CONVERSATIONS_CAPABILITY,
  STUDIO_CONVERSATION_CREATE_CAPABILITY,
  STUDIO_LOCAL_PAIRING_CAPABILITY,
  STUDIO_CONVERSATION_FOLDERS_CAPABILITY,
  STUDIO_SESSIONS_CAPABILITY,
  STUDIO_CONVERSATION_FILES_CAPABILITY,
  STUDIO_CHECKPOINTS_CAPABILITY,
  STUDIO_COMMANDS_CAPABILITY,
  STUDIO_PROVIDERS_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_BOARD_FILES_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY,
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_LOCAL_SERVERS_CAPABILITY,
  STUDIO_SESSION_FILES_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_HANDOFF_CAPABILITY,
] as const

/**
 * The capabilities a Studio serves only with the chat surface beside the
 * conversation lane, in `STUDIO_CAPABILITIES` order. A Studio that has no chat
 * surface (a test double, a future headless build without one) leaves them out.
 */
export const STUDIO_CHAT_CAPABILITIES = [
  STUDIO_CONVERSATION_FOLDERS_CAPABILITY,
  STUDIO_SESSIONS_CAPABILITY,
  STUDIO_CONVERSATION_FILES_CAPABILITY,
  STUDIO_CHECKPOINTS_CAPABILITY,
  STUDIO_COMMANDS_CAPABILITY,
  STUDIO_PROVIDERS_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_SESSION_FILES_CAPABILITY,
  STUDIO_HANDOFF_CAPABILITY,
] as const

export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number]

/** Whether a peer serves a capability. A peer that listed none serves none. */
export function studioPeerSupports(
  capabilities: readonly string[] | null | undefined,
  capability: StudioCapability,
): boolean {
  return Array.isArray(capabilities) && capabilities.includes(capability)
}

/**
 * Whether two ends can talk: each must serve the other's version. Both then
 * speak the lower of the two current versions. The refusal names both numbers
 * and which side to update.
 */
export function checkStudioProtocolVersion(
  peerVersion: number,
  peerMinVersion: number = peerVersion,
): { ok: true; version: number } | { ok: false; message: string } {
  if (peerVersion < STUDIO_PROTOCOL_MIN_SUPPORTED)
    return {
      ok: false,
      message: `The other end speaks Studio protocol ${peerVersion}, and this one needs ${STUDIO_PROTOCOL_MIN_SUPPORTED} or newer. Update the other end.`,
    }
  if (peerMinVersion > STUDIO_PROTOCOL_VERSION)
    return {
      ok: false,
      message: `The other end needs Studio protocol ${peerMinVersion} or newer, and this one speaks ${STUDIO_PROTOCOL_VERSION}. Update this end.`,
    }
  return { ok: true, version: Math.min(peerVersion, STUDIO_PROTOCOL_VERSION) }
}
