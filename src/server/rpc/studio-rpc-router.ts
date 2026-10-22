import {
  STUDIO_METHODS,
  isStudioChatMethod,
  isStudioToolsMethod,
  isStudioFilesMethod,
  isStudioPullRequestsMethod,
  isStudioLocalServersMethod,
  parseStudioMethodParams,
  type StudioFilesMethod,
  type StudioPullRequestsMethod,
  type StudioLocalServersMethod,
  type StudioToolsMethod,
  studioScopesGrant,
  type ConversationCommand,
  type StudioChatMethod,
  type StudioConversationKey,
  type StudioCreatedConversation,
  type StudioErrorBody,
  type StudioGrant,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioServerInfo,
} from '../../../packages/studio-protocol/src/public'
import { createHash, randomBytes } from 'node:crypto'

import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import { ceilingAllowsUnaskedTools, clampPresetToCeiling } from '../../shared/permission-ceiling'
import type {
  ConversationCliRuntimeOverrides,
  ConversationImageAttachment,
  ConversationKey,
} from '../../shared/conversation-runtime'
import { createStudioUploads, type StudioUploads } from './studio-uploads'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { StudioFiles } from './studio-files'
import type { StudioPullRequests } from '../pull-requests/pull-request-domain'
import type { StudioLocalServers } from '../local-servers/local-server-domain'
import type {
  StudioAuditEntry,
  StudioChatBackend,
  StudioConversationBackend,
  StudioRequestContext,
} from './studio-rpc-types'

// The Studio RPC's methods, transport-free: given the grant a client holds at
// this moment, a method and its params, an answer. The connection reads the
// grant live and hands it here on every request, so a narrowed grant or a
// revoked client is refused at the next request, not the next connection.
//
// Three rules sit here rather than in the conversation host, because they are
// about who is asking:
//
// - Scope. Every method's scope comes from STUDIO_METHODS, checked first.
// - Ceiling. A paired app's chats run no looser than its ceiling, exactly as a
//   module's do (permission-ceiling.ts): a preset it asks for is lowered to the
//   ceiling, none asked for is pinned to it, and naming tools a chat may use
//   unasked needs the loosest ceiling. An app does not drive a chat that
//   already runs looser than its ceiling — it may read it, interrupt or stop
//   it, deny its requests and lower its preset, but not send to it or approve
//   for it — or the ceiling would hold only for chats the app started. A chat
//   running with tools it may use unasked counts as `bypass` for that check,
//   and answering a request for the rest of the conversation (an allow rule
//   for its kind) needs a ceiling of at least `auto`.
// - Command ids. A client's ids are namespaced by the client before they reach
//   the runtime's receipts (`client:<id>:<commandId>`, `owner:<commandId>`), as
//   a module's are (`module:<id>:<commandId>`), so one client can neither
//   collide with nor be answered from another's receipts.
//
// The chat surface (`chat.ts` in the protocol) is served only to owners, and
// only where main hands the router a chat backend. Its session commands reach
// the runtime's durable receipts by the same namespaced ids. Its other
// mutations (starting a session, a revert, a rewind, a fork) address a
// conversation rather than a session, which the runtime keeps no receipts
// for, so this router keeps them: the first answer to an id is the answer to
// every retry of it while this process runs.
//
// What a reply carries is redacted and a failure below is told in stable
// words, except to Studio's own windows (`context.ownWindow`): they are the
// app's own chat view, which reads the same conversations over IPC as they
// are, and a view showing a redacted usage count or a vaguer error than its
// IPC would have is a regression, not a protection.

export type StudioRpcAnswer<M extends StudioMethod = StudioMethod> =
  { ok: true; result: StudioMethodResult<M> } | { ok: false; error: StudioErrorBody }

export type StudioRpcRouter = {
  handle(
    grant: StudioGrant,
    method: StudioMethod,
    params: unknown,
    context?: StudioRequestContext,
  ): Promise<StudioRpcAnswer>
  /** A connection closed: what it staged and did not send waits a little for its reconnect. */
  connectionClosed(connectionId: string): void
  /** The RPC is stopping: timers stop and staged uploads go. */
  close(): void
}

export type StudioRpcRouterOptions = {
  backend: StudioConversationBackend
  /** What `server.info` answers, without the grant. */
  info: () => Omit<StudioServerInfo, 'grant'>
  audit?: (entry: StudioAuditEntry) => void
  /** Where a refusal's own words go: the client is answered with a stable message instead. */
  log?: (message: string) => void
  /** The chat surface, once main has one to give; null until then, and for a Studio without one. */
  chat?: () => StudioChatBackend | null
  /** Client toolsets; without it, `tools.*` is answered `unavailable`. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots; without it, `files.*` by root is answered `unavailable`. */
  files?: StudioFiles
  /** The pull requests the conversations opened; without it, `pullRequests.*` is answered `unavailable`. */
  pullRequests?: StudioPullRequests
  /** The local servers the conversations started; without it, `localServers.*` is answered `unavailable`. */
  localServers?: StudioLocalServers
  uploads?: StudioUploads
  now?: () => number
}

// How many answers to the chat surface's conversation-level mutations are kept.
const MAX_KEPT_ANSWERS = 256

const OWNER_ONLY = 'This is served to Studio’s own connections only.'
const FOLDER_OWNER_ONLY = 'Only Studio’s own connections may name a conversation by its folder.'
const NO_CONTEXT: StudioRequestContext = { connectionId: '', slot: 0, ownWindow: false }

/** How a request is answered: what its replies show, and in whose words a failure is told. */
type Voice = {
  redact<T>(value: T): T
  failed(
    code: string,
    detail: string | undefined,
    context: string,
    retryAfterMs?: number,
  ): { ok: false; error: StudioErrorBody }
}

/**
 * What a client is told when the work below the router refused or failed: one
 * stable sentence per code. The runtime's and the launch's own words can name
 * paths, processes and other internals, so they go to the log and not to the
 * client; a code with no sentence here is answered as `unavailable`.
 */
const STABLE_MESSAGES: Readonly<Record<string, string>> = {
  unavailable: 'Studio could not carry that out.',
  not_found: 'Studio has no such record for this conversation.',
  invalid_params: 'Studio could not read that request.',
  unsupported_model: "That model is not one this chat's agent offers here.",
  unknown_workspace: 'There is no workspace with that id here.',
  workspace_folder_missing: 'That workspace has no project folder.',
  no_cli_selected: 'No agent CLI was named, and none is chosen here.',
  cli_not_conversational: 'That agent CLI does not run as a chat here.',
  unknown_skill: 'A skill the request names is not installed here.',
  conversation_start_failed: 'The conversation could not be started.',
  command_id_conflict: 'That command id was already used for a different command. Send this one under a new id.',
  // Another send to the chat is being prepared: the client tries again after
  // `retryAfterMs` (the SDK does so by itself), rather than failing for good.
  busy: 'Studio is busy with another message for this chat. Try again shortly.',
}

/** The delay a `busy` refusal carries, when there is one to carry. */
const retryAfter = (code: string, retryAfterMs: number | undefined): { retryAfterMs?: number } =>
  code === 'busy' && retryAfterMs !== undefined ? { retryAfterMs } : {}

/** JSON with every object's keys in order, so two spellings of one command hash alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * What a command is, for its receipt: its method and its params (but its id),
 * hashed. Kept with the receipt, it tells a retry of the command from another
 * command sent under the same id, which is refused rather than answered with
 * the first one's result.
 */
export function studioCommandFingerprint(method: string, params: unknown): string {
  const { commandId: _id, ...rest } = (params ?? {}) as Record<string, unknown>
  return createHash('sha256')
    .update(`${method}\n${canonicalJson(rest)}`)
    .digest('base64url')
    .slice(0, 32)
}

// How many command ids' fingerprints the router keeps, across every way in.
const MAX_FINGERPRINTS = 4096

/** An opaque id for one refusal, logged beside its real cause. */
export function studioErrorId(): string {
  return randomBytes(6).toString('hex')
}

/** The receipt key a client's command id is held under. */
export function studioRuntimeCommandId(grant: StudioGrant, commandId: string): string {
  return grant.owner ? `owner:${commandId}` : `client:${grant.clientId}:${commandId}`
}

/** The strictest ceiling under which an app may answer a request for the rest of a conversation. */
const CONVERSATION_RULE_FLOOR = 'auto' as const
const MAX_REMEMBERED_STOPS = 1024

const refuse = (code: string, message: string): { ok: false; error: StudioErrorBody } => ({
  ok: false,
  error: { code, message },
})

// Commands that move a chat's work forward. The rest — interrupt, a denial, a
// rejected plan, a stricter preset, stop — only ever hold it back, so they are
// never refused for the chat's own preset.
function drivesChat(command: ConversationCommand): boolean {
  switch (command.kind) {
    case 'send':
    case 'answerQuestion':
    case 'setModel':
      return true
    case 'resolveApproval':
      return command.decision !== 'deny'
    case 'resolvePlan':
      return command.decision === 'approve'
    default:
      return false
  }
}

export function createStudioRpcRouter(options: StudioRpcRouterOptions): StudioRpcRouter {
  const { backend } = options
  // A refusal from below: logged in its own words under an opaque id, answered
  // in stable ones carrying that id, so a person can quote it and the log
  // still says what really happened.
  const failed = (
    code: string,
    detail: string | undefined,
    context: string,
    retryAfterMs?: number,
  ): { ok: false; error: StudioErrorBody } => {
    const known = Object.hasOwn(STABLE_MESSAGES, code) ? code : 'unavailable'
    const errorId = studioErrorId()
    options.log?.(`Studio RPC ${context} refused (${code}) [${errorId}]: ${detail || STABLE_MESSAGES[known]}`)
    return {
      ok: false,
      error: { code: known, message: STABLE_MESSAGES[known], errorId, ...retryAfter(known, retryAfterMs) },
    }
  }
  const clientVoice: Voice = { redact: (value) => backend.redact(value), failed }
  // Studio's own window hears what its IPC would have said, in the same words.
  const windowVoice: Voice = {
    redact: (value) => value,
    failed: (code, detail, _context, retryAfterMs) => {
      const known = Object.hasOwn(STABLE_MESSAGES, code) ? code : 'unavailable'
      const refused = refuse(known, detail || STABLE_MESSAGES[known])
      return { ok: false, error: { ...refused.error, ...retryAfter(known, retryAfterMs) } }
    },
  }
  const now = options.now ?? Date.now
  const uploads = options.uploads ?? createStudioUploads({ now })
  // Answers to the chat surface's conversation-level mutations, by namespaced
  // id, shared while pending so a retry racing the first attempt waits for it.
  const kept = new Map<string, Promise<StudioRpcAnswer>>()
  // What each command id named, while this process runs: the receipts the
  // runtime keeps hold the same fingerprint for a session's commands across a
  // restart, and this covers the rest (a create, a revert, a fork, a stop).
  const fingerprints = new Map<string, string>()
  // Creates still starting, by namespaced id: a retry that arrives while the
  // first attempt is launching shares it, so one id makes one chat.
  const stopsDone = new Set<string>()
  const creating = new Map<
    string,
    Promise<{ ok: true; conversation: StudioCreatedConversation } | { ok: false; code: string; message: string }>
  >()

  // A key's folder is an owner's to name: it is a path on this disk. Anyone
  // else's key is resolved by its workspace, as on the tailnet; `handle`
  // refuses a folder from anyone else before it gets here.
  function resolve(key: StudioConversationKey, grant: StudioGrant): ConversationKey | null {
    if (key.workspaceRoot !== undefined && grant.owner)
      return { workspaceRoot: key.workspaceRoot, workspaceId: key.workspaceId, agentId: key.agentId }
    return backend.resolveKey(key.workspaceId, key.agentId)
  }
  const notFound = (key: { workspaceId: string; agentId: string }) =>
    refuse('not_found', `No conversation "${key.agentId}" in workspace "${key.workspaceId}" here.`)

  function audit(
    grant: StudioGrant,
    method: StudioMethod,
    started: number,
    params: {
      key?: { workspaceId: string; agentId: string }
      commandId?: string
      workspaceId?: string
      toolset?: string
    },
    answer: StudioRpcAnswer,
    created?: { workspaceId: string; agentId: string },
  ): void {
    const target = created ?? params.key
    options.audit?.({
      clientId: grant.clientId,
      clientName: grant.name,
      tool: method,
      ...(target ? { workspaceId: target.workspaceId, agentId: target.agentId } : {}),
      ...(!target && params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.commandId ? { commandId: params.commandId } : {}),
      ...(params.toolset ? { toolset: params.toolset } : {}),
      ok: answer.ok,
      ...(answer.ok ? {} : { code: answer.error.code }),
      durationMs: now() - started,
    })
  }

  async function command(
    grant: StudioGrant,
    params: { key: StudioConversationKey; commandId: string },
    command: ConversationCommand,
    voice: Voice,
    fingerprint: string | undefined,
  ): Promise<StudioRpcAnswer> {
    const key = resolve(params.key, grant)
    if (!key) return notFound(params.key)
    let carried = command
    if (command.kind === 'setPermissionPreset') {
      // Lowered, never refused: the answer names the preset in force. A mode
      // belongs to the preset it was asked with, so one lowered runs its own.
      const preset = clampPresetToCeiling(command.preset, grant.ceiling) ?? command.preset
      carried = {
        kind: 'setPermissionPreset',
        preset,
        ...(preset === command.preset && command.permissionMode ? { permissionMode: command.permissionMode } : {}),
      }
    } else if (
      command.kind === 'resolveApproval' &&
      command.decision === 'conversation' &&
      isLooserCliPermissionPreset(CONVERSATION_RULE_FLOOR, grant.ceiling)
    ) {
      // Allowing a kind of request for the rest of the chat is an allow rule,
      // as loose for that kind as `auto` lets edits be: an app held below
      // `auto` answers one request at a time.
      return refuse(
        'ceiling_exceeded',
        `Allowing a request for the rest of the conversation needs a ceiling of "${CONVERSATION_RULE_FLOOR}" or looser; this app's is "${grant.ceiling}". Answer it "once" instead.`,
      )
    } else if (drivesChat(command)) {
      const running = backend.permissionOf(key)
      if (isLooserCliPermissionPreset(running, grant.ceiling))
        return refuse(
          'ceiling_exceeded',
          `This conversation runs on "${running}", looser than the "${grant.ceiling}" this app is allowed. Lower its preset first, or pair the app again with a looser ceiling.`,
        )
    }
    const outcome = await backend.command(
      key,
      grant.clientId,
      studioRuntimeCommandId(grant, params.commandId),
      carried,
      fingerprint,
    )
    if (!outcome.ok)
      return voice.failed(
        outcome.code ?? 'unavailable',
        outcome.message,
        `conversation.${carried.kind}`,
        outcome.retryAfterMs,
      )
    const notice = outcome.notice ? { notice: outcome.notice } : {}
    if (carried.kind === 'setPermissionPreset')
      return {
        ok: true,
        result: {
          permissionPreset: carried.preset,
          ...(carried.permissionMode ? { permissionMode: carried.permissionMode } : {}),
          ...notice,
        },
      }
    if (carried.kind === 'setModel') return { ok: true, result: { modelId: carried.modelId, ...notice } }
    return { ok: true, result: notice }
  }

  async function create(
    grant: StudioGrant,
    params: StudioMethodParams<'conversation.create'>,
    voice: Voice,
    context: StudioRequestContext,
  ): Promise<StudioRpcAnswer<'conversation.create'>> {
    const { commandId, ...request } = params
    if (request.allowedTools?.length && !ceilingAllowsUnaskedTools(grant.ceiling))
      return refuse(
        'ceiling_exceeded',
        'Letting a chat use tools without asking needs a "bypass" ceiling, which this app was not given.',
      )
    const permissionPreset = clampPresetToCeiling(request.permissionPreset, grant.ceiling)
    const capped = {
      ...request,
      permissionPreset,
      // A mode rides only beside the preset it was asked with.
      permissionMode:
        permissionPreset && permissionPreset === request.permissionPreset ? request.permissionMode : undefined,
    }
    if (!capped.permissionPreset) delete capped.permissionPreset
    if (!capped.permissionMode) delete capped.permissionMode
    const launchCommandId = studioRuntimeCommandId(grant, commandId)
    const found = backend.findCreated(launchCommandId)
    if (found) return { ok: true, result: { conversation: found } }
    let pending = creating.get(launchCommandId)
    if (!pending) {
      pending = backend.create(capped, launchCommandId).catch((error: unknown) => ({
        ok: false as const,
        code: 'conversation_start_failed',
        message: error instanceof Error ? error.message : String(error),
      }))
      creating.set(launchCommandId, pending)
      const settled = pending
      void settled.then(() => {
        if (creating.get(launchCommandId) === settled) creating.delete(launchCommandId)
      })
    }
    const created = await pending
    if (created.ok && context.connectionId)
      // The process that started it is where its calls go first (routing, 6.2).
      options.tools?.noteStarted(context.connectionId, created.conversation)
    return created.ok
      ? { ok: true, result: { conversation: created.conversation } }
      : voice.failed(created.code, created.message, 'conversation.create')
  }

  async function dispatch(
    grant: StudioGrant,
    method: StudioMethod,
    params: never,
    context: StudioRequestContext,
    voice: Voice,
    fingerprint: string | undefined,
  ): Promise<StudioRpcAnswer> {
    // By root it is the files family's, served with or without a chat surface.
    if (method === 'files.stat' && (params as StudioMethodParams<'files.stat'>).root !== undefined) {
      const { path, root } = params as StudioMethodParams<'files.stat'>
      if (!options.files) return refuse('unavailable', 'This Studio does not serve files by root.')
      const found = await options.files.stat(root!, path)
      return found.ok ? { ok: true, result: { stat: found.stat } } : refuse(found.code, found.message)
    }
    if (isStudioChatMethod(method)) return chatDispatch(grant, method, params, context, voice, fingerprint)
    if (isStudioToolsMethod(method)) return toolsDispatch(grant, method, params, context)
    if (isStudioFilesMethod(method)) return filesDispatch(grant, method, params, voice)
    if (isStudioPullRequestsMethod(method)) return pullRequestsDispatch(method, params)
    if (isStudioLocalServersMethod(method)) return localServersDispatch(method, params)
    const { failed } = voice
    switch (method) {
      case 'server.info':
        return { ok: true, result: { ...options.info(), grant } }
      case 'server.ping':
        return { ok: true, result: { at: now() } }
      case 'conversation.list':
        return { ok: true, result: { conversations: await backend.list() } }
      case 'conversation.create':
        return create(grant, params, voice, context)
      case 'conversation.stop': {
        const { key: wire, commandId } = params as StudioMethodParams<'conversation.stop'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        const runtimeId = studioRuntimeCommandId(grant, commandId)
        // A stop with no session to stop leaves no receipt in the runtime, so
        // it is remembered here: a resend of it never stops a later session.
        if (stopsDone.has(runtimeId)) return { ok: true, result: {} }
        const stopped = await backend.stop(key, runtimeId, fingerprint)
        if (stopped.ok) {
          stopsDone.add(runtimeId)
          while (stopsDone.size > MAX_REMEMBERED_STOPS) stopsDone.delete(stopsDone.values().next().value!)
        }
        return stopped.ok
          ? { ok: true, result: {} }
          : failed(
              stopped.code === 'command_id_conflict' ? stopped.code : 'unavailable',
              stopped.message,
              'conversation.stop',
            )
      }
      case 'conversation.loadEarlier': {
        const { key: wire, beforeCursor, turnLimit } = params as StudioMethodParams<'conversation.loadEarlier'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        const read = await backend.loadEarlier(key, beforeCursor, turnLimit)
        return read.ok
          ? {
              ok: true,
              result: { page: { ...read.page, events: read.page.events.map((event) => voice.redact(event)) } },
            }
          : failed('unavailable', read.message, 'conversation.loadEarlier')
      }
      case 'conversation.toolDetail': {
        const { key: wire, toolUseId } = params as StudioMethodParams<'conversation.toolDetail'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        const read = await backend.toolDetail(key, toolUseId)
        if (read.ok)
          return { ok: true, result: { detail: voice.redact(read.detail) as unknown as Record<string, unknown> } }
        return failed(
          read.code === 'not_found' ? 'not_found' : read.code === 'invalid_input' ? 'invalid_params' : 'unavailable',
          read.message,
          'conversation.toolDetail',
        )
      }
      case 'conversation.turnDiff': {
        const { key: wire, turnSeq, path } = params as StudioMethodParams<'conversation.turnDiff'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        const read = await backend.turnDiff(key, turnSeq, path)
        if (!read.ok) return failed('unavailable', read.message, 'conversation.turnDiff')
        const { ok: _ok, ...diff } = read
        return { ok: true, result: voice.redact(diff) }
      }
      default: {
        const { key, commandId, ...members } = params as {
          key: StudioConversationKey
          commandId: string
        } & Record<string, unknown>
        const kind = method.slice('conversation.'.length) as ConversationCommand['kind']
        return command(grant, { key, commandId }, { kind, ...members } as ConversationCommand, voice, fingerprint)
      }
    }
  }

  // ── Client tools ─────────────────────────────────────────────────────────

  function toolsDispatch(
    grant: StudioGrant,
    method: StudioToolsMethod,
    params: never,
    context: StudioRequestContext,
  ): StudioRpcAnswer {
    const tools = options.tools
    if (!tools) return refuse('unavailable', `This Studio does not serve ${method}.`)
    switch (method) {
      case 'tools.offer': {
        const { toolset, reach } = params as StudioMethodParams<'tools.offer'>
        const offered = tools.offer(context.connectionId, toolset, reach)
        return offered.ok
          ? { ok: true, result: { toolset: offered.toolset, wireNames: offered.wireNames, reach: offered.reach } }
          : {
              ok: false,
              error: {
                code: offered.code,
                message: offered.message,
                ...(offered.retryAfterMs === undefined ? {} : { retryAfterMs: offered.retryAfterMs }),
              },
            }
      }
      case 'tools.withdraw': {
        const withdrawn = tools.withdraw(context.connectionId, (params as StudioMethodParams<'tools.withdraw'>).toolset)
        return withdrawn.ok
          ? { ok: true, result: { withdrawn: withdrawn.withdrawn } }
          : {
              ok: false,
              error: {
                code: withdrawn.code,
                message: withdrawn.message,
                ...(withdrawn.retryAfterMs === undefined ? {} : { retryAfterMs: withdrawn.retryAfterMs }),
              },
            }
      }
      case 'tools.focus':
        tools.focus(context.connectionId, params as StudioMethodParams<'tools.focus'>)
        return { ok: true, result: {} }
      case 'tools.catalog':
        return { ok: true, result: { toolsets: tools.catalog({ clientId: grant.clientId, owner: grant.owner }) } }
      case 'tools.grants': {
        const { key: wire } = params as StudioMethodParams<'tools.grants'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        return { ok: true, result: { grants: tools.grantsOf({ workspaceId: key.workspaceId, agentId: key.agentId }) } }
      }
      case 'tools.grant': {
        const { key: wire, toolset, granted } = params as StudioMethodParams<'tools.grant'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        const answer = tools.grant({ workspaceId: key.workspaceId, agentId: key.agentId }, toolset, granted)
        return answer.ok ? { ok: true, result: { grants: answer.grants } } : refuse(answer.code, answer.message)
      }
    }
  }

  // ── Pull requests ────────────────────────────────────────────────────────

  async function pullRequestsDispatch(method: StudioPullRequestsMethod, params: never): Promise<StudioRpcAnswer> {
    const pullRequests = options.pullRequests
    if (!pullRequests) return refuse('unavailable', `This Studio does not serve ${method}.`)
    switch (method) {
      case 'pullRequests.list':
        return { ok: true, result: await pullRequests.list(params as StudioMethodParams<'pullRequests.list'>) }
      case 'pullRequests.refresh':
        return { ok: true, result: await pullRequests.refresh(params as StudioMethodParams<'pullRequests.refresh'>) }
      case 'pullRequests.noteWork':
        // Answered at once: what it changes reports through
        // `pullRequests.changed`, and a turn end must not wait on GitHub.
        void pullRequests.noteWork(params as StudioMethodParams<'pullRequests.noteWork'>).catch((error: unknown) => {
          options.log?.(`A pull request note failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        return { ok: true, result: {} }
      case 'pullRequests.link': {
        const linked = await pullRequests.link(params as StudioMethodParams<'pullRequests.link'>)
        if (!linked.ok)
          return refuse(linked.code === 'not_a_pull_request' ? 'invalid_params' : 'claimed', linked.message)
        return { ok: true, result: { recorded: linked.recorded, pullRequest: linked.pullRequest } }
      }
      case 'pullRequests.unwatch':
        if (!pullRequests.unwatch) return refuse('unavailable', `This Studio does not serve ${method}.`)
        return { ok: true, result: await pullRequests.unwatch(params as StudioMethodParams<'pullRequests.unwatch'>) }
      case 'pullRequests.noteToolCall':
        // Answered at once, like a note: what it records reports through
        // `pullRequests.changed`.
        void pullRequests
          .noteToolCall(params as StudioMethodParams<'pullRequests.noteToolCall'>)
          .catch((error: unknown) => {
            options.log?.(
              `A tool call could not be read for a pull request: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        return { ok: true, result: {} }
    }
  }

  // ── Local servers ────────────────────────────────────────────────────────

  async function localServersDispatch(method: StudioLocalServersMethod, params: never): Promise<StudioRpcAnswer> {
    const localServers = options.localServers
    if (!localServers) return refuse('unavailable', `This Studio does not serve ${method}.`)
    switch (method) {
      case 'localServers.list':
        return { ok: true, result: await localServers.list(params as StudioMethodParams<'localServers.list'>) }
      case 'localServers.run': {
        // Answered once the run has started; its port opening reports through
        // `localServers.changed`.
        const started = await localServers.run(params as StudioMethodParams<'localServers.run'>)
        return started.ok ? { ok: true, result: { started: true } } : refuse(started.code, started.message)
      }
      case 'localServers.stop': {
        const stopped = await localServers.stop(params as StudioMethodParams<'localServers.stop'>)
        return stopped.ok ? { ok: true, result: { stopped: stopped.stopped } } : refuse(stopped.code, stopped.message)
      }
      case 'localServers.remove':
        return { ok: true, result: await localServers.remove(params as StudioMethodParams<'localServers.remove'>) }
    }
  }

  // ── Files under a workspace's roots ──────────────────────────────────────

  async function filesDispatch(
    grant: StudioGrant,
    method: StudioFilesMethod,
    params: never,
    voice: Voice,
  ): Promise<StudioRpcAnswer> {
    const files = options.files
    if (!files) return refuse('unavailable', `This Studio does not serve ${method}.`)
    const failed = (outcome: { code: string; message: string }) => refuse(outcome.code, outcome.message)
    switch (method) {
      case 'files.roots':
        return { ok: true, result: files.roots((params as StudioMethodParams<'files.roots'>).workspaceId) }
      case 'files.list': {
        const { root, path } = params as StudioMethodParams<'files.list'>
        const listed = await files.list(root, path)
        return listed.ok ? { ok: true, result: { entries: listed.entries } } : failed(listed)
      }
      case 'files.read': {
        const { root, path } = params as StudioMethodParams<'files.read'>
        const read = await files.read(root, path)
        if (!read.ok) return failed(read)
        const { ok: _ok, ...result } = read
        return { ok: true, result }
      }
      case 'files.write': {
        const { root, path, text, uploadId, ifMatch, commandId } = params as StudioMethodParams<'files.write'>
        const runtimeId = studioRuntimeCommandId(grant, commandId)
        // A retry of a write is answered with the first one's outcome: carried
        // out again, its own write would read as another writer's conflict.
        return once(
          `files.write:${runtimeId}`,
          async () => {
            let bytes: Buffer
            if (text !== undefined) bytes = Buffer.from(text, 'utf8')
            else {
              const spent = uploads.spend(grant.clientId, [uploadId!], runtimeId, 'file')
              if (!spent.ok) return refuse(spent.code, spent.message)
              bytes = spent.pictures[0].bytes
            }
            // A conflict is an answer, kept for every repeat of this command,
            // so its bytes go as a write's do; a write that could not be
            // carried out leaves them unsent, for a retry or a discard.
            let written: Awaited<ReturnType<typeof files.write>>
            try {
              written = await files.write(root, path, bytes, ifMatch)
            } catch (error) {
              if (uploadId !== undefined) uploads.settle(grant.clientId, runtimeId, false)
              throw error
            }
            if (uploadId !== undefined)
              uploads.settle(grant.clientId, runtimeId, written.ok || written.code === 'conflict')
            return written.ok || written.code === 'conflict' ? { ok: true, result: written as never } : failed(written)
          },
          voice,
          method,
        )
      }
      case 'files.remove': {
        const { root, path, ifMatch, commandId } = params as StudioMethodParams<'files.remove'>
        return once(
          `files.remove:${studioRuntimeCommandId(grant, commandId)}`,
          async () => {
            const removed = await files.remove(root, path, ifMatch)
            return removed.ok || removed.code === 'conflict' ? { ok: true, result: removed as never } : failed(removed)
          },
          voice,
          method,
        )
      }
    }
  }

  // ── The chat surface ─────────────────────────────────────────────────────

  /** The first answer to a namespaced id, for every retry of it; new work otherwise. */
  function once(
    id: string,
    work: () => Promise<StudioRpcAnswer>,
    voice: Voice,
    method: string,
  ): Promise<StudioRpcAnswer> {
    const known = kept.get(id)
    if (known) {
      kept.delete(id)
      kept.set(id, known)
      return known
    }
    const answer = work().catch((error: unknown): StudioRpcAnswer =>
      voice.failed('unavailable', error instanceof Error ? error.message : String(error), method),
    )
    kept.set(id, answer)
    while (kept.size > MAX_KEPT_ANSWERS) kept.delete(kept.keys().next().value!)
    // Work that could not be carried out at all may be tried again under its id.
    void answer.then((settled) => {
      if (!settled.ok && settled.error.code === 'unavailable' && kept.get(id) === answer) kept.delete(id)
    })
    return answer
  }

  async function chatDispatch(
    grant: StudioGrant,
    method: StudioChatMethod,
    params: never,
    context: StudioRequestContext,
    voice: Voice,
    fingerprint: string | undefined,
  ): Promise<StudioRpcAnswer> {
    const chat = options.chat?.() ?? null
    // A session command's receipt keeps what it was, across a restart too.
    const stamp = fingerprint ? { commandFingerprint: fingerprint } : {}
    // An upload is the client's; its budget is this connection's. Staging
    // needs no chat: a board too large for one frame is staged the same way.
    const holder = { client: grant.clientId, connection: context.connectionId }
    switch (method) {
      case 'uploads.begin': {
        const input = params as StudioMethodParams<'uploads.begin'>
        // A file's bytes are only ever spent by `files.write`, which is an owner's.
        if (input.purpose === 'file' && !grant.owner)
          return refuse('owner_required', 'Only Studio itself may stage a file’s bytes.')
        const begun = uploads.begin(holder, input)
        return begun.ok
          ? { ok: true, result: { uploadId: begun.uploadId, chunkBytes: begun.chunkBytes } }
          : refuse(begun.code, begun.message)
      }
      case 'uploads.append': {
        const appended = uploads.append(holder, params as StudioMethodParams<'uploads.append'>)
        return appended.ok
          ? { ok: true, result: { received: appended.received } }
          : refuse(appended.code, appended.message)
      }
      case 'uploads.discard':
        return {
          ok: true,
          result: uploads.discard(grant.clientId, (params as StudioMethodParams<'uploads.discard'>).uploadIds),
        }
    }
    if (!chat) return refuse('unavailable', `This Studio does not serve ${method}.`)
    // A reply is what the backend answered, as this connection may be shown it.
    const outcome = (result: unknown): StudioRpcAnswer => ({ ok: true, result: voice.redact(result) as never })
    const runtimeId = (id: string) => studioRuntimeCommandId(grant, id)
    const keptId = (id: string) => `${method}:${runtimeId(id)}`
    switch (method) {
      case 'session.start': {
        const { commandId, cliRuntimes, ...input } = params as StudioMethodParams<'session.start'>
        // What a CLI override names is checked where the backend checks the
        // rest of the start, by the rules its IPC applies.
        const overrides = cliRuntimes as ConversationCliRuntimeOverrides | undefined
        return once(
          keptId(commandId),
          async () => outcome(await chat.startSession({ ...input, ...(overrides ? { cliRuntimes: overrides } : {}) })),
          voice,
          method,
        )
      }
      case 'session.send': {
        const { commandId, attachments, mentions, ...input } = params as StudioMethodParams<'session.send'>
        let pictures: ConversationImageAttachment[] | undefined
        // A repeat of a send the runtime holds a receipt for is answered from
        // it, so it needs none of the pictures the first attempt carried,
        // which may be long gone: it must not be refused for them, or the
        // client sends the message again under a new id.
        const answered =
          attachments?.length &&
          (await chat.hasReceipt({ sessionId: input.sessionId, commandId: runtimeId(commandId) }))
        if (attachments?.length && !answered) {
          const spent = uploads.spend(
            grant.clientId,
            attachments.map((attachment) => attachment.uploadId),
            runtimeId(commandId),
          )
          if (!spent.ok) return refuse(spent.code, spent.message)
          pictures = attachments.map((attachment, index) => {
            const picture = spent.pictures[index]
            const name = attachment.name ?? picture.name
            return {
              id: attachment.id,
              mediaType: picture.mediaType,
              dataBase64: picture.bytes.toString('base64'),
              byteLength: picture.bytes.length,
              ...(name === undefined ? {} : { name }),
            }
          })
        }
        const sent = await chat
          .sendTurn({
            ...input,
            // What each mention names is checked by the backend, by the rules its IPC applies.
            ...(mentions ? { mentions: mentions as never } : {}),
            ...(pictures ? { attachments: pictures } : {}),
            commandId: runtimeId(commandId),
            ...stamp,
          })
          .finally(async () => {
            // Recorded, its receipt answers every repeat and the bytes can go;
            // not recorded, nothing ran, and a retry may carry them again.
            if (!pictures) return
            const recorded = await chat
              .hasReceipt({ sessionId: input.sessionId, commandId: runtimeId(commandId) })
              .catch(() => false)
            uploads.settle(grant.clientId, runtimeId(commandId), recorded)
          })
        return outcome(sent)
      }
      case 'session.interrupt': {
        const { commandId, ...input } = params as StudioMethodParams<'session.interrupt'>
        return outcome(await chat.interrupt({ ...input, commandId: runtimeId(commandId), ...stamp }))
      }
      case 'session.respond': {
        const { commandId, requestKind, ...input } = params as StudioMethodParams<'session.respond'>
        return outcome(
          await chat.respond({
            ...input,
            ...(requestKind === undefined ? {} : { requestKind: requestKind as never }),
            commandId: runtimeId(commandId),
            ...stamp,
          }),
        )
      }
      case 'session.setPermission': {
        const { commandId, ...input } = params as StudioMethodParams<'session.setPermission'>
        return outcome(await chat.setPermission({ ...input, commandId: runtimeId(commandId), ...stamp }))
      }
      case 'session.setModel': {
        const { commandId, ...input } = params as StudioMethodParams<'session.setModel'>
        return outcome(await chat.setModel({ ...input, commandId: runtimeId(commandId), ...stamp }))
      }
      case 'conversation.revert': {
        const { commandId, key: wire, ...input } = params as StudioMethodParams<'conversation.revert'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        return once(keptId(commandId), async () => outcome(await chat.revert({ ...input, key })), voice, method)
      }
      case 'conversation.rewind': {
        const { commandId, key: wire, turnSeq } = params as StudioMethodParams<'conversation.rewind'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        return once(keptId(commandId), async () => outcome(await chat.rewind({ key, turnSeq })), voice, method)
      }
      case 'conversation.handoff': {
        const { commandId, key: wire } = params as StudioMethodParams<'conversation.handoff'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        return once(keptId(commandId), async () => outcome(await chat.handoff({ key })), voice, method)
      }
      case 'conversation.fork': {
        const { commandId, key: wire, ...input } = params as StudioMethodParams<'conversation.fork'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        return once(keptId(commandId), async () => outcome(await chat.fork({ ...input, key })), voice, method)
      }
      case 'conversation.attachment':
        return outcome(await chat.attachment((params as StudioMethodParams<'conversation.attachment'>).ref))
      case 'conversation.planDocument': {
        const { key: wire, ...input } = params as StudioMethodParams<'conversation.planDocument'>
        const key = resolve(wire, grant)
        if (!key) return notFound(wire)
        return outcome(await chat.planDocument({ ...key, ...input }))
      }
      case 'conversation.commands':
        return outcome({ catalog: await chat.commands(params as StudioMethodParams<'conversation.commands'>) })
      case 'providers.list': {
        const { cliRuntimes } = params as StudioMethodParams<'providers.list'>
        const overrides = cliRuntimes as ConversationCliRuntimeOverrides | undefined
        return outcome(await chat.providers(overrides ? { cliRuntimes: overrides } : {}))
      }
      case 'providers.models':
        return outcome(await chat.providerModels(params as StudioMethodParams<'providers.models'>))
      case 'providers.secretStatus':
        return outcome(await chat.secretStatus(params as StudioMethodParams<'providers.secretStatus'>))
      case 'files.search': {
        const search = params as StudioMethodParams<'files.search'>
        if (!(await folderAllowed(chat, context, search.rootPath))) return refuse('not_found', UNKNOWN_FOLDER)
        return outcome(await chat.searchFiles(context.slot, search))
      }
      case 'files.cancelSearch':
        chat.cancelFileSearch(context.slot, (params as StudioMethodParams<'files.cancelSearch'>).channel)
        return { ok: true, result: {} }
      case 'files.stat':
        return outcome({ stat: await chat.stat((params as StudioMethodParams<'files.stat'>).path) })
      case 'files.readImage':
        return {
          ok: true,
          result: { dataUrl: await chat.readImage((params as StudioMethodParams<'files.readImage'>).path) },
        }
      case 'files.repoRoot': {
        const { folderPath, hostId } = params as StudioMethodParams<'files.repoRoot'>
        if (!(await folderAllowed(chat, context, folderPath))) return refuse('not_found', UNKNOWN_FOLDER)
        return outcome({ repoRoot: await chat.repoRoot(folderPath, hostId) })
      }
      case 'workspaces.list':
        return outcome({ workspaces: chat.workspaces() })
    }
  }

  return {
    connectionClosed: (connectionId) => uploads.release(connectionId),
    close: () => uploads.close(),
    async handle(grant, method, params, context = NO_CONTEXT) {
      const spec = STUDIO_METHODS[method]
      const voice = context.ownWindow ? windowVoice : clientVoice
      const started = now()
      let answer: StudioRpcAnswer
      let read: unknown = params
      if (spec.owner && !grant.owner) {
        answer = refuse('owner_required', OWNER_ONLY)
      } else if (spec.scope && !studioScopesGrant(grant.scopes, spec.scope)) {
        answer = refuse('scope_required', `This app's grant does not include "${spec.scope}".`)
      } else {
        const parsed = parseStudioMethodParams(method, params)
        // A mutation's id names one command: the same id for another one is refused.
        const fingerprint = spec.mutation
          ? studioCommandFingerprint(method, parsed.ok ? parsed.params : null)
          : undefined
        const runtimeId =
          spec.mutation && parsed.ok
            ? studioRuntimeCommandId(grant, (parsed.params as { commandId: string }).commandId)
            : undefined
        const known = runtimeId === undefined ? undefined : fingerprints.get(runtimeId)
        if (!parsed.ok) answer = refuse(parsed.code, parsed.message)
        else if (!grant.owner && namesFolder(parsed.params)) answer = refuse('owner_required', FOLDER_OWNER_ONLY)
        else if (known !== undefined && known !== fingerprint)
          answer = refuse('command_id_conflict', STABLE_MESSAGES.command_id_conflict)
        else {
          read = parsed.params
          if (runtimeId !== undefined && fingerprint !== undefined) {
            fingerprints.delete(runtimeId)
            fingerprints.set(runtimeId, fingerprint)
            while (fingerprints.size > MAX_FINGERPRINTS) fingerprints.delete(fingerprints.keys().next().value!)
          }
          answer = await dispatch(grant, method, parsed.params as never, context, voice, fingerprint).catch(
            (error: unknown): StudioRpcAnswer =>
              voice.failed('unavailable', error instanceof Error ? error.message : String(error), method),
          )
        }
      }
      // Every mutation is audited, a refused one included: a refusal at the
      // scope or the ceiling is what this log exists to show. Studio's own
      // windows are the app rather than a client of it, and are left out.
      if (spec.mutation && (context.audited ?? !context.ownWindow)) {
        const created =
          answer.ok && method === 'conversation.create'
            ? (answer.result as StudioMethodResult<'conversation.create'>).conversation
            : undefined
        audit(grant, method, started, auditTargets(read), answer, created)
      }
      return answer
    },
  }
}

const UNKNOWN_FOLDER = 'That folder is not one Studio knows.'

/** Whether a connection may name this folder: any, unless it is held to the folders Studio knows. */
async function folderAllowed(chat: StudioChatBackend, context: StudioRequestContext, path: string): Promise<boolean> {
  if (!context.knownFoldersOnly) return true
  return chat.isKnownFolder ? chat.isKnownFolder(path).catch(() => false) : false
}

/** Whether parsed params name a conversation by its folder, which only an owner may. */
function namesFolder(params: unknown): boolean {
  const key = (params as { key?: { workspaceRoot?: unknown } } | null)?.key
  return key?.workspaceRoot !== undefined
}

// What a request names, for the audit: its conversation and command id when
// they are where the protocol puts them. Never anything else it carries.
function auditTargets(value: unknown): {
  key?: { workspaceId: string; agentId: string }
  commandId?: string
  workspaceId?: string
  toolset?: string
} {
  if (value === null || typeof value !== 'object') return {}
  const params = value as Record<string, unknown>
  const text = (field: unknown) => (typeof field === 'string' && field ? field.slice(0, 200) : undefined)
  const key = params.key as Record<string, unknown> | undefined
  const workspaceId = text(key?.workspaceId)
  const agentId = text(key?.agentId)
  const commandId = text(params.commandId)
  const created = text(params.workspaceId)
  const toolset = text(params.toolset)
  return {
    ...(workspaceId && agentId ? { key: { workspaceId, agentId } } : {}),
    ...(commandId ? { commandId } : {}),
    ...(created ? { workspaceId: created } : {}),
    ...(toolset ? { toolset } : {}),
  }
}
