import {
  explainRejectedConversationMessage,
  parseConversationClientMessage,
  parseConversationCreateRequest,
  type ConversationCommand,
  type ConversationCreateRequest,
  type ConversationHelloAnswer,
  type ConversationPlanDecision,
  type ConversationQuestionAnswers,
  type ConversationRequestDecision,
  type ConversationThread,
  type ConversationWireMcpServerAction,
  type ConversationUsageLimitResumeAction,
  type ConversationWirePage,
  type ConversationWirePermissionPreset,
} from './conversation.js'
import {
  STUDIO_CONVERSATION_CREATE_CAPABILITY,
  STUDIO_CONVERSATIONS_CAPABILITY,
  type StudioCapability,
} from './handshake.js'
import type { StudioEnvironment, StudioErrorCode, StudioGrant, StudioServerIdentity } from './envelope.js'
import type { StudioScope } from './scopes.js'
import {
  STUDIO_CHAT_METHODS,
  STUDIO_CHAT_TOPICS,
  isStudioChatMethod,
  parseStudioChatParams,
  type StudioChatMethodMap,
  type StudioChatTopicMap,
  type StudioMethodSpec,
} from './chat.js'
import { parseStudioConversationKey, type StudioConversationKey } from './key.js'
import {
  STUDIO_FILES_METHODS,
  STUDIO_FILES_TOPICS,
  isStudioFilesMethod,
  parseStudioFilesParams,
  parseStudioFilesWatchParams,
  type StudioFilesMethodMap,
  type StudioFilesTopicMap,
} from './files.js'
import {
  STUDIO_PULL_REQUESTS_METHODS,
  STUDIO_PULL_REQUESTS_TOPICS,
  isStudioPullRequestsMethod,
  parseStudioPullRequestsParams,
  type StudioPullRequestsMethodMap,
  type StudioPullRequestsTopicMap,
} from './pull-requests.js'
import {
  STUDIO_LOCAL_SERVERS_METHODS,
  STUDIO_LOCAL_SERVERS_TOPICS,
  isStudioLocalServersMethod,
  parseStudioLocalServersParams,
  type StudioLocalServersMethodMap,
  type StudioLocalServersTopicMap,
} from './local-servers.js'
import {
  STUDIO_TOOLS_METHODS,
  STUDIO_TOOLS_TOPICS,
  isStudioToolsMethod,
  parseStudioToolsParams,
  type StudioToolsMethodMap,
  type StudioToolsTopicMap,
} from './tools.js'

export { parseStudioConversationKey, isStudioPath, STUDIO_MAX_PATH_CHARS, type StudioConversationKey } from './key.js'
export type { StudioMethodSpec } from './chat.js'

// Every method and stream topic, with the scope it needs, in one table.
//
// `StudioMethodMap` is the source of truth for what a method takes and
// answers; `STUDIO_METHODS` is typed over its keys, so a method added to the
// map without a scope does not compile. A Studio checks the scope on every
// request, against the grant as it stands at that moment.
//
// A conversation command is the conversation lane's own command, addressed:
// its params are the command's members plus the conversation `key` and the
// client's `commandId`, and they are read by the lane's own validator
// (`parseConversationClientMessage`), so the socket and the tailnet accept
// exactly the same commands. Every mutation carries a `commandId`; a retry
// with the same id is answered with the first attempt's result and is never
// carried out twice, across a reconnect and an app restart alike.

/** Every command answers with this, plus what its own method adds. */
export type StudioCommandAnswer = {
  /** Qualifies an accepted command: a model switched mid-turn applies from the next turn. */
  notice?: string
}

type Addressed<T> = { key: StudioConversationKey; commandId: string } & T

/** A conversation `conversation.create` started. */
export type StudioCreatedConversation = {
  workspaceId: string
  agentId: string
  sessionId: string | null
  name: string
  cli: string
  providerId: string
  modelId: string
  /** The preset the chat runs on: the one asked for, lowered to the client's ceiling. */
  permissionPreset?: ConversationWirePermissionPreset
  permissionMode?: string
}

/** What `server.info` answers: the welcome without the per-connection parts. */
export type StudioServerInfo = {
  protocolVersion: number
  minProtocolVersion: number
  server: StudioServerIdentity
  environment: StudioEnvironment
  capabilities: string[]
  conversation: ConversationHelloAnswer
  grant: StudioGrant
}

export type StudioMethodMap = StudioConversationMethodMap &
  StudioChatMethodMap &
  StudioToolsMethodMap &
  StudioFilesMethodMap &
  StudioPullRequestsMethodMap &
  StudioLocalServersMethodMap

/** The `server` and `conversation` methods phase 2 shipped; the chat surface's are in `chat.ts`. */
type StudioConversationMethodMap = {
  'server.info': { params: Record<string, never>; result: StudioServerInfo }
  /**
   * Answered at once, by any authenticated client: proof the connection is
   * alive end to end. A client asks after a quiet spell, since a socket left
   * half-open by a machine that slept never closes by itself.
   */
  'server.ping': { params: Record<string, never>; result: { at: number } }
  'conversation.list': { params: Record<string, never>; result: { conversations: ConversationThread[] } }
  'conversation.create': {
    params: ConversationCreateRequest & { commandId: string }
    result: { conversation: StudioCreatedConversation }
  }
  'conversation.send': { params: Addressed<{ message: string }>; result: StudioCommandAnswer }
  'conversation.interrupt': { params: Addressed<object>; result: StudioCommandAnswer }
  'conversation.resolveApproval': {
    params: Addressed<{ requestId: string; decision: ConversationRequestDecision }>
    result: StudioCommandAnswer
  }
  'conversation.answerQuestion': {
    params: Addressed<{ requestId: string; answers: ConversationQuestionAnswers }>
    result: StudioCommandAnswer
  }
  'conversation.resolvePlan': {
    params: Addressed<{ requestId: string; decision: ConversationPlanDecision }>
    result: StudioCommandAnswer
  }
  'conversation.setPermissionPreset': {
    params: Addressed<{ preset: ConversationWirePermissionPreset; permissionMode?: string }>
    result: StudioCommandAnswer & { permissionPreset: ConversationWirePermissionPreset; permissionMode?: string }
  }
  'conversation.setModel': { params: Addressed<{ modelId: string }>; result: StudioCommandAnswer & { modelId: string } }
  /**
   * Takes back a message the desktop holds for the chat's turn to end, by its
   * `id` (the conversation lane's `cancelQueued`). An owner's only: this
   * socket names no held message to anyone else.
   */
  'conversation.cancelQueued': { params: Addressed<{ queuedId: string }>; result: StudioCommandAnswer }
  /**
   * Stops one agent the chat spawned, by the call that spawned it (its lane's
   * `toolUseId`; the conversation lane's `stopSubagent`), and leaves the chat,
   * its turn and its other agents running. Refused for an agent that is not
   * running, and for a chat whose provider cannot stop one by itself. An
   * owner's only for now: no SDK call names it yet.
   */
  'conversation.stopSubagent': { params: Addressed<{ toolUseId: string }>; result: StudioCommandAnswer }
  /**
   * Sets the reasoning effort the chat runs at from its next turn (the
   * conversation lane's `setReasoningEffort`): one of the levels its listed
   * `capabilities.reasoningEfforts` names, or none for the provider's own
   * default, kept on the chat. An owner's only for now: no SDK call names it yet.
   */
  'conversation.setReasoningEffort': { params: Addressed<{ effort?: string }>; result: StudioCommandAnswer }
  /**
   * Reconnects one of a live chat's MCP servers, or switches it on or off (the
   * conversation lane's `mcpServerAction`), where its listed
   * `capabilities.mcpServerActions` names the action. Never a sign-in, whose
   * callback the chat's CLI waits for on the desktop. An owner's only for now.
   */
  'conversation.mcpServerAction': {
    params: Addressed<{ serverId: string; action: ConversationWireMcpServerAction }>
    result: StudioCommandAnswer
  }
  /**
   * Restarts the chat's agent (the conversation lane's `restartSession`): its
   * process ends, the session keeps its place, and the next message starts it
   * again. Refused while the agent works; `notice` says when there was none
   * running. An owner's only for now.
   */
  'conversation.restartSession': { params: Addressed<object>; result: StudioCommandAnswer }
  /**
   * Has the desktop keep a message and send it into the chat at `sendAt`
   * (the conversation lane's `scheduleSend`), answered once it is kept; and
   * sends one it keeps now, or deletes it, by its `id`
   * (`sendScheduledNow`, `cancelScheduled`). Owners' only, as
   * `conversation.cancelQueued` is: this socket's conversation topic names no
   * scheduled message, so nothing else could address one.
   */
  'conversation.scheduleSend': {
    params: Addressed<{ message: string; sendAt: number }>
    result: StudioCommandAnswer
  }
  'conversation.sendScheduledNow': { params: Addressed<{ scheduledId: string }>; result: StudioCommandAnswer }
  'conversation.cancelScheduled': { params: Addressed<{ scheduledId: string }>; result: StudioCommandAnswer }
  /**
   * Acts on the notice a usage limit left on the chat's turn (the
   * conversation lane's `usageLimitResume`): schedules the resume the desktop
   * sends once the limit resets (`always`: for every chat a limit stops),
   * cancels, dismisses or retries it. An owner's only: this socket's
   * conversation topic names no notice.
   */
  'conversation.usageLimitResume': {
    params: Addressed<{ action: ConversationUsageLimitResumeAction; always?: true }>
    result: StudioCommandAnswer
  }
  /** Ends the chat's live session. Idempotent by nature: stopping a stopped chat answers ok. */
  'conversation.stop': { params: Addressed<object>; result: StudioCommandAnswer }
  'conversation.loadEarlier': {
    params: { key: StudioConversationKey; beforeCursor: number; turnLimit?: number }
    result: { page: ConversationWirePage }
  }
  'conversation.toolDetail': {
    params: { key: StudioConversationKey; toolUseId: string }
    result: { detail: Record<string, unknown> }
  }
  'conversation.turnDiff': {
    params: { key: StudioConversationKey; turnSeq: number; path?: string }
    result: { diff: unknown; patch?: string; original?: string; modified?: string }
  }
}

export type StudioMethod = keyof StudioMethodMap
export type StudioMethodParams<M extends StudioMethod> = StudioMethodMap[M]['params']
export type StudioMethodResult<M extends StudioMethod> = StudioMethodMap[M]['result']

const read = (scope: StudioScope | null = 'conversation:read'): StudioMethodSpec => ({
  scope,
  mutation: false,
  capability: scope ? STUDIO_CONVERSATIONS_CAPABILITY : null,
})
const operate: StudioMethodSpec = {
  scope: 'conversation:operate',
  mutation: true,
  capability: STUDIO_CONVERSATIONS_CAPABILITY,
}

export const STUDIO_METHODS: { readonly [M in StudioMethod]: StudioMethodSpec } = {
  'server.info': read(null),
  'server.ping': read(null),
  'conversation.list': read(),
  'conversation.create': {
    scope: 'conversation:create',
    mutation: true,
    capability: STUDIO_CONVERSATION_CREATE_CAPABILITY,
  },
  'conversation.send': operate,
  'conversation.interrupt': operate,
  'conversation.resolveApproval': operate,
  'conversation.answerQuestion': operate,
  'conversation.resolvePlan': operate,
  'conversation.setPermissionPreset': operate,
  'conversation.setModel': operate,
  'conversation.cancelQueued': { ...operate, owner: true },
  'conversation.stopSubagent': { ...operate, owner: true },
  'conversation.setReasoningEffort': { ...operate, owner: true },
  'conversation.mcpServerAction': { ...operate, owner: true },
  'conversation.restartSession': { ...operate, owner: true },
  'conversation.scheduleSend': { ...operate, owner: true },
  'conversation.sendScheduledNow': { ...operate, owner: true },
  'conversation.cancelScheduled': { ...operate, owner: true },
  'conversation.usageLimitResume': { ...operate, owner: true },
  'conversation.stop': operate,
  'conversation.loadEarlier': read(),
  'conversation.toolDetail': read(),
  'conversation.turnDiff': read(),
  ...STUDIO_CHAT_METHODS,
  ...STUDIO_TOOLS_METHODS,
  ...STUDIO_FILES_METHODS,
  ...STUDIO_PULL_REQUESTS_METHODS,
  ...STUDIO_LOCAL_SERVERS_METHODS,
}

/** Whether a string names a method this version of the protocol defines. */
export function isStudioMethod(value: unknown): value is StudioMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_METHODS, value)
}

export type StudioTopicMap = {
  /**
   * One conversation, followed as every follower of the contract follows it:
   * a `snapshot` (or, for a cursor the log can vouch for, only the events
   * after it), one `synchronized` fence, then live `event`s.
   */
  'conversation.session': { params: { key: StudioConversationKey; turnLimit?: number } }
} & StudioChatTopicMap &
  StudioToolsTopicMap &
  StudioFilesTopicMap &
  StudioPullRequestsTopicMap &
  StudioLocalServersTopicMap

export type StudioTopic = keyof StudioTopicMap
export type StudioTopicParams<T extends StudioTopic> = StudioTopicMap[T]['params']

/**
 * How a topic is held. A `push` topic's frames are `{ t: 'push', sub, payload }`
 * with no cursor; the others' are conversation frames under `{ t: 'frame' }`.
 */
export type StudioTopicSpec = { scope: StudioScope; capability: StudioCapability; owner?: true; push?: true }

export const STUDIO_TOPICS: { readonly [T in StudioTopic]: StudioTopicSpec } = {
  'conversation.session': { scope: 'conversation:read', capability: STUDIO_CONVERSATIONS_CAPABILITY },
  ...STUDIO_CHAT_TOPICS,
  ...STUDIO_TOOLS_TOPICS,
  ...STUDIO_FILES_TOPICS,
  ...STUDIO_PULL_REQUESTS_TOPICS,
  ...STUDIO_LOCAL_SERVERS_TOPICS,
}

/** Whether a string names a topic this version of the protocol defines. */
export function isStudioTopic(value: unknown): value is StudioTopic {
  return typeof value === 'string' && Object.hasOwn(STUDIO_TOPICS, value)
}

/** The conversation command kind each command method carries. */
export const STUDIO_COMMAND_METHODS = {
  'conversation.send': 'send',
  'conversation.interrupt': 'interrupt',
  'conversation.resolveApproval': 'resolveApproval',
  'conversation.answerQuestion': 'answerQuestion',
  'conversation.resolvePlan': 'resolvePlan',
  'conversation.setPermissionPreset': 'setPermissionPreset',
  'conversation.setModel': 'setModel',
  'conversation.cancelQueued': 'cancelQueued',
  'conversation.stopSubagent': 'stopSubagent',
  'conversation.setReasoningEffort': 'setReasoningEffort',
  'conversation.mcpServerAction': 'mcpServerAction',
  'conversation.restartSession': 'restartSession',
  'conversation.scheduleSend': 'scheduleSend',
  'conversation.sendScheduledNow': 'sendScheduledNow',
  'conversation.cancelScheduled': 'cancelScheduled',
  'conversation.usageLimitResume': 'usageLimitResume',
} as const satisfies Partial<Record<StudioMethod, ConversationCommand['kind']>>

export type StudioCommandMethod = keyof typeof STUDIO_COMMAND_METHODS

// ── Params ──────────────────────────────────────────────────────────────────

export type StudioParamsRefusal = { ok: false; code: StudioErrorCode; message: string }
export type StudioParsedParams<M extends StudioMethod> =
  { ok: true; params: StudioMethodParams<M> } | StudioParamsRefusal

/** A command's params as the conversation command they carry, with its conversation and id. */
export type StudioParsedCommand = { key: StudioConversationKey; commandId: string; command: ConversationCommand }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function refuse(code: StudioErrorCode, message: string): StudioParamsRefusal {
  return { ok: false, code, message }
}

const KEY_REQUIRED = '"key" names the conversation: { workspaceId, agentId, workspaceRoot? }.'

/**
 * A command method's params as the conversation command they carry, read by
 * the conversation lane's own validator. The refusal is the lane's own
 * (`explainRejectedConversationMessage`), so an `always` decision is refused
 * as unsafe and an over-long message as too large, exactly as on the tailnet.
 */
export function parseStudioCommand(
  method: StudioCommandMethod,
  params: unknown,
): StudioParsedCommand | StudioParamsRefusal {
  if (!record(params)) return refuse('invalid_params', 'A command takes an object of params.')
  const key = parseStudioConversationKey(params.key)
  if (!key) return refuse('invalid_params', KEY_REQUIRED)
  if (!id(params.commandId)) return refuse('invalid_params', '"commandId" must be a string of 1 to 200 characters.')
  // Pictures travel beside the socket, not in it, and this version has no
  // upload route: refused rather than dropped, so a send never silently loses one.
  if (params.uploadIds !== undefined) return refuse('invalid_params', 'This connection does not carry pictures yet.')
  const { key: _key, commandId, ...members } = params
  const frame = { type: 'command', commandId, command: { ...members, kind: STUDIO_COMMAND_METHODS[method] } }
  const parsed = parseConversationClientMessage(frame)
  if (!parsed || parsed.type !== 'command') {
    const rejection = explainRejectedConversationMessage(frame)
    return refuse(
      rejection.code === 'too_large' || rejection.code === 'unsafe_remote_decision' ? rejection.code : 'invalid_params',
      rejection.code === 'invalid_frame' || rejection.code === 'unsupported_command'
        ? `The params of ${method} are not in the documented shape.`
        : rejection.message,
    )
  }
  return { key, commandId: parsed.commandId, command: parsed.command }
}

/** Validate a request's params for its method, keeping only the members the method defines. */
export function parseStudioMethodParams<M extends StudioMethod>(method: M, params: unknown): StudioParsedParams<M> {
  if (isStudioChatMethod(method)) return parseStudioChatParams(method, params) as StudioParsedParams<M>
  if (isStudioToolsMethod(method)) return parseStudioToolsParams(method, params) as StudioParsedParams<M>
  if (isStudioFilesMethod(method)) return parseStudioFilesParams(method, params) as StudioParsedParams<M>
  if (isStudioPullRequestsMethod(method)) return parseStudioPullRequestsParams(method, params) as StudioParsedParams<M>
  if (isStudioLocalServersMethod(method)) return parseStudioLocalServersParams(method, params) as StudioParsedParams<M>
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse('invalid_params', `${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioMethodParams<M> })
  switch (method) {
    case 'server.info':
    case 'server.ping':
    case 'conversation.list':
      return ok({})
    case 'conversation.create': {
      if (!id(value.commandId)) return refuse('invalid_params', '"commandId" must be a string of 1 to 200 characters.')
      const { commandId, ...request } = value
      const parsed = parseConversationCreateRequest(request)
      if (!parsed.ok) return refuse('invalid_params', parsed.message)
      return ok({ ...parsed.request, commandId })
    }
    case 'conversation.stop': {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse('invalid_params', KEY_REQUIRED)
      if (!id(value.commandId)) return refuse('invalid_params', '"commandId" must be a string of 1 to 200 characters.')
      return ok({ key, commandId: value.commandId })
    }
    case 'conversation.loadEarlier': {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse('invalid_params', KEY_REQUIRED)
      if (!integer(value.beforeCursor)) return refuse('invalid_params', '"beforeCursor" must be a sequence number.')
      if (
        value.turnLimit !== undefined &&
        !(integer(value.turnLimit) && value.turnLimit >= 1 && value.turnLimit <= 100)
      )
        return refuse('invalid_params', '"turnLimit" must be between 1 and 100.')
      return ok({
        key,
        beforeCursor: value.beforeCursor,
        ...(value.turnLimit === undefined ? {} : { turnLimit: value.turnLimit }),
      })
    }
    case 'conversation.toolDetail': {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse('invalid_params', KEY_REQUIRED)
      if (!id(value.toolUseId)) return refuse('invalid_params', '"toolUseId" names the tool call.')
      return ok({ key, toolUseId: value.toolUseId })
    }
    case 'conversation.turnDiff': {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse('invalid_params', KEY_REQUIRED)
      if (!integer(value.turnSeq)) return refuse('invalid_params', '"turnSeq" must be a sequence number.')
      if (value.path !== undefined && !(typeof value.path === 'string' && value.path.length <= 4096))
        return refuse('invalid_params', '"path" must be a path of at most 4096 characters.')
      return ok({ key, turnSeq: value.turnSeq, ...(value.path === undefined ? {} : { path: value.path }) })
    }
    default: {
      const parsed = parseStudioCommand(method as StudioCommandMethod, value)
      if (!('command' in parsed)) return parsed
      const { kind: _kind, ...members } = parsed.command as ConversationCommand & Record<string, unknown>
      return ok({ key: parsed.key, commandId: parsed.commandId, ...members })
    }
  }
}

/** A subscription's params for its topic, or why they are not. */
export function parseStudioTopicParams<T extends StudioTopic>(
  topic: T,
  params: unknown,
): { ok: true; params: StudioTopicParams<T> } | StudioParamsRefusal {
  // The push topics that follow no one thing take no params.
  if (topic === 'files.watch')
    return parseStudioFilesWatchParams(params) as { ok: true; params: StudioTopicParams<T> } | StudioParamsRefusal
  const whole =
    topic === 'conversation.commands' ||
    topic === 'tools.catalog' ||
    topic === 'pullRequests.changed' ||
    topic === 'localServers.changed'
  if (params === undefined && whole) return { ok: true, params: {} as StudioTopicParams<T> }
  if (!record(params)) return refuse('invalid_params', `${topic} takes an object of params.`)
  if (whole) return { ok: true, params: {} as StudioTopicParams<T> }
  const key = parseStudioConversationKey(params.key)
  if (!key) return refuse('invalid_params', KEY_REQUIRED)
  if (
    params.turnLimit !== undefined &&
    !(integer(params.turnLimit) && params.turnLimit >= 1 && params.turnLimit <= 100)
  )
    return refuse('invalid_params', '"turnLimit" must be between 1 and 100.')
  return {
    ok: true,
    params: { key, ...(params.turnLimit === undefined ? {} : { turnLimit: params.turnLimit as number }) },
  }
}
