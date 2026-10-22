import {
  CONVERSATION_MAX_MESSAGE_CHARS,
  isConversationWirePermissionPreset,
  type ConversationWireEvent,
  type ConversationWirePermissionPreset,
} from './conversation.js'
import {
  STUDIO_CHECKPOINTS_CAPABILITY,
  STUDIO_COMMANDS_CAPABILITY,
  STUDIO_CONVERSATION_FILES_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_HANDOFF_CAPABILITY,
  STUDIO_PROVIDERS_CAPABILITY,
  STUDIO_SESSIONS_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  type StudioCapability,
} from './handshake.js'
import type { StudioErrorCode } from './envelope.js'
import { isStudioPath, parseStudioConversationKey, type StudioConversationKey } from './key.js'
import { STUDIO_MAX_FILE_BYTES, isStudioRelativePath, parseStudioFileRoot, type StudioFileRoot } from './files.js'
import type { StudioScope } from './scopes.js'

// What a chat view needs beside the conversation lane: the methods Studio's
// own chat view calls, so a window, a browser tab or any other client can
// show and drive a chat exactly as the desktop does.
//
// - `session.*` drives a chat's live session by its id, with everything the
//   composer sends (mentions, skills, effort, mode, a steer, pictures). The
//   conversation lane's commands (`conversation.send`, …) stay as they are for
//   a client that drives a chat by its key and never starts a session itself.
// - `uploads.*` carries a picture in pieces small enough for a frame, ahead of
//   the send that names it.
// - `conversation.*` gains a turn's revert, rewind and fork, a sent picture, a
//   plan as a file, and the `/` command list.
// - `providers.*`, `files.*` and `workspaces.*` are the reads around a chat:
//   which providers and models it can run, @-mention search and the file facts
//   its links and pictures need, and the workspace list.
//
// Every one of them is held to an owner's connection for now (`owner: true`):
// they take paths on Studio's disk and a CLI's own executable, which no
// pairing has been asked about. Each still names the scope it would need, so
// opening one to paired clients later is a decision about that one method.
//
// A session method answers with the runtime's own outcome, a refusal by the
// runtime included: `{ ok: true, session } | { ok: false, message, event? }`
// inside a successful response, exactly what Studio's own windows read. The
// response's error is for the request itself (its scope, its params, Studio
// being unable to carry it). The same holds for the other methods whose
// outcome has an `ok` of its own.

/** The largest picture a send may carry, decoded. */
export const STUDIO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** The most pictures one send may carry. */
export const STUDIO_MAX_UPLOADS_PER_SEND = 16
/** The most bytes one `uploads.append` may carry, decoded: its base64 stays well under a client frame. */
export const STUDIO_UPLOAD_CHUNK_BYTES = 512 * 1024
/** The picture types a send may carry. */
export const STUDIO_UPLOAD_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A live session as the runtime summarises it. Members beyond these are the runtime's own, passed through. */
export type StudioSessionSummary = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  status: string
  createdAt: number
  updatedAt: number
} & Record<string, unknown>

/** What a session method answers: the runtime's own outcome. */
export type StudioSessionOutcome =
  | { ok: true; session: StudioSessionSummary; notice?: string }
  | { ok: false; message: string; event?: ConversationWireEvent }

/** An outcome with nothing more to say than whether it worked. */
export type StudioOutcome = { ok: true } | { ok: false; message: string }

/** A CLI's runtime override: the command to run it with, the machine it runs on, the models it offers. */
export type StudioCliRuntimeOverride = { command?: string; hostId?: string; models?: string[] }

/** A file an @-mention names: the path as the composer resolved it, and what it is. */
export type StudioMention = Record<string, unknown>

/**
 * A file a send attaches by path: an absolute path on the Studio's own
 * machine. The agent is told where it is after the words, and the
 * `user_message` the send becomes keeps it in its `files` beside the text.
 * Sent only to a Studio that advertises `session-files`; one that does not
 * would drop it without a word.
 */
export type StudioAttachedFile = { path: string }

/** The most files one send may attach. */
export const STUDIO_MAX_FILES_PER_SEND = 50

/** A skill a send carries: its id, and the file it was read from when it is not the CLI's own. */
export type StudioSkillRef = { id: string; sourcePath?: string }

/** A picture a send carries, by the upload that holds its bytes. */
export type StudioSendAttachment = { id: string; uploadId: string; name?: string }

export type StudioSessionStartParams = {
  commandId: string
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  cliRuntimes?: Record<string, StudioCliRuntimeOverride | undefined>
  permissionPreset?: ConversationWirePermissionPreset
  permissionMode?: string
  allowedTools?: string[]
}

export type StudioSessionSendParams = {
  commandId: string
  sessionId: string
  message: string
  /** The client's id for the optimistic bubble; echoed on the `user_message` it becomes. */
  localTurnId?: string
  mentions?: StudioMention[]
  /** Files attached by path, where the Studio advertises `session-files`. */
  files?: StudioAttachedFile[]
  skills?: StudioSkillRef[]
  reasoningEffort?: string
  mode?: 'default' | 'plan' | 'ask'
  /** Hand the message to the turn that is running, where the provider takes one. */
  steer?: boolean
  attachments?: StudioSendAttachment[]
}

export type StudioSessionRespondParams = {
  commandId: string
  sessionId: string
  requestId: string
  approved: boolean
  decision?: 'once' | 'conversation' | 'always' | 'deny'
  answers?: Record<string, string>
  /** The kind of request the client believes it answers; an answer to another kind is refused. */
  requestKind?: string
}

/** A file a turn changed, as its checkpoint diff lists it. */
export type StudioCheckpointFile = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  addedLines: number
  removedLines: number
  binary: boolean
}

export type StudioRevertOutcome =
  | { ok: true; files: StudioCheckpointFile[]; reverted: boolean; undoRef?: string; kept?: string[] }
  | { ok: false; message: string; changed?: true }

export type StudioForkParams = {
  commandId: string
  key: StudioConversationKey
  newAgentId: string
  title?: string
} & ({ side: 'assistant'; turnId: string } | { side: 'user'; turnSeq: number })

/** A workspace as the chat surface lists it. */
export type StudioWorkspace = { id: string; name: string; folderPath: string | null; hostId?: string }

export type StudioChatMethodMap = {
  'session.start': { params: StudioSessionStartParams; result: StudioSessionOutcome }
  'session.send': { params: StudioSessionSendParams; result: StudioSessionOutcome }
  'session.interrupt': { params: { commandId: string; sessionId: string }; result: StudioSessionOutcome }
  'session.respond': { params: StudioSessionRespondParams; result: StudioSessionOutcome }
  'session.setPermission': {
    params: {
      commandId: string
      sessionId: string
      permissionPreset: ConversationWirePermissionPreset
      permissionMode?: string
    }
    result: StudioSessionOutcome
  }
  'session.setModel': {
    params: { commandId: string; sessionId: string; modelId: string }
    result: StudioSessionOutcome
  }
  'uploads.begin': {
    /** A picture for a send, or (`purpose: 'file'`, owners) a file's bytes for `files.write`, of any type. */
    params: { mediaType: string; byteLength: number; name?: string; purpose?: 'picture' | 'file' }
    result: { uploadId: string; chunkBytes: number }
  }
  'uploads.append': { params: { uploadId: string; offset: number; dataBase64: string }; result: { received: number } }
  /** Give back staged pictures that will not be sent; one already sent, or not this client's, is passed over. */
  'uploads.discard': { params: { uploadIds: string[] }; result: { discarded: number } }
  'conversation.revert': {
    params: {
      commandId: string
      key: StudioConversationKey
      turnSeq: number
      confirmed?: boolean
      undo?: boolean
      files?: string[]
    }
    result: StudioRevertOutcome
  }
  'conversation.rewind': {
    params: { commandId: string; key: StudioConversationKey; turnSeq: number }
    result: StudioOutcome
  }
  'conversation.fork': { params: StudioForkParams; result: StudioOutcome }
  /** Hand a chat off to a fresh session pointed at a file of its messages; answers that file's path. */
  'conversation.handoff': {
    params: { commandId: string; key: StudioConversationKey }
    result: { ok: true; path: string } | { ok: false; message: string }
  }
  'conversation.attachment': {
    params: { ref: string }
    result: { ok: true; mediaType: string; dataBase64: string } | { ok: false; message: string }
  }
  'conversation.planDocument': {
    params: { key: StudioConversationKey; plan: string; title?: string; planFilePath?: string }
    result: { ok: true; path: string } | { ok: false; message: string }
  }
  'conversation.commands': {
    params: { cli: string; cwd: string; refresh?: boolean; probe?: false }
    result: { catalog: Record<string, unknown> }
  }
  'providers.list': {
    params: { cliRuntimes?: Record<string, StudioCliRuntimeOverride | undefined> }
    result: { ok: true; providers: Record<string, unknown>[] } | { ok: false; message: string }
  }
  'providers.models': { params: { providerId: string }; result: Record<string, unknown> & { ok: boolean } }
  'providers.secretStatus': { params: { providerId: string }; result: Record<string, unknown> & { ok: boolean } }
  'files.search': {
    params: {
      rootPath: string
      query: string
      limit?: number
      purpose?: 'mention'
      /** Names this search, so a newer one or `files.cancelSearch` can end it. */
      channel?: string
      recentAt?: Record<string, number>
    }
    result: Record<string, unknown> & { ok: boolean }
  }
  'files.cancelSearch': { params: { channel?: string }; result: Record<string, never> }
  /** By an absolute path; or, with `root` (the `files-write` capability), by a path relative to it. */
  'files.stat': { params: { path: string; root?: StudioFileRoot }; result: { stat: Record<string, unknown> } }
  'files.readImage': { params: { path: string }; result: { dataUrl: string } }
  'files.repoRoot': { params: { folderPath: string; hostId?: string }; result: { repoRoot: string | null } }
  'workspaces.list': { params: Record<string, never>; result: { workspaces: StudioWorkspace[] } }
}

export type StudioChatMethod = keyof StudioChatMethodMap

/** How a method is held: the scope a grant needs, whether it mutates, the capability that offers it. */
export type StudioMethodSpec = {
  /** The scope a grant must hold; null for what any authenticated client may ask. */
  scope: StudioScope | null
  /** A mutation carries a `commandId`, is audited, and is answered from its receipt on a retry. */
  mutation: boolean
  /** The capability a client checks before calling it. */
  capability: StudioCapability | null
  /** Only an owner's connection may call it, whatever scopes another grant holds. */
  owner?: true
}

const owned = (scope: StudioScope, capability: StudioCapability, mutation: boolean): StudioMethodSpec => ({
  scope,
  mutation,
  capability,
  owner: true,
})

export const STUDIO_CHAT_METHODS: { readonly [M in StudioChatMethod]: StudioMethodSpec } = {
  'session.start': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true),
  'session.send': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true),
  'session.interrupt': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true),
  'session.respond': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true),
  'session.setPermission': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true),
  'session.setModel': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true),
  // Staging bytes changes nothing anyone sees until a send names them, and an
  // append is idempotent by its offset, so neither carries a command id.
  'uploads.begin': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, false),
  'uploads.append': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, false),
  // Discarding unsent bytes is as safe to repeat as staging them.
  'uploads.discard': owned('conversation:operate', STUDIO_SESSIONS_CAPABILITY, false),
  'conversation.revert': owned('conversation:operate', STUDIO_CHECKPOINTS_CAPABILITY, true),
  'conversation.rewind': owned('conversation:operate', STUDIO_CHECKPOINTS_CAPABILITY, true),
  'conversation.fork': owned('conversation:create', STUDIO_CHECKPOINTS_CAPABILITY, true),
  'conversation.handoff': owned('conversation:operate', STUDIO_HANDOFF_CAPABILITY, true),
  'conversation.attachment': owned('conversation:read', STUDIO_CONVERSATION_FILES_CAPABILITY, false),
  // Writes the plan into Studio's data when the agent kept no copy of its
  // own, the same text to the same file however often it is asked.
  'conversation.planDocument': owned('conversation:read', STUDIO_CONVERSATION_FILES_CAPABILITY, false),
  'conversation.commands': owned('conversation:read', STUDIO_COMMANDS_CAPABILITY, false),
  'providers.list': owned('providers:read', STUDIO_PROVIDERS_CAPABILITY, false),
  'providers.models': owned('providers:read', STUDIO_PROVIDERS_CAPABILITY, false),
  'providers.secretStatus': owned('providers:read', STUDIO_PROVIDERS_CAPABILITY, false),
  'files.search': owned('files:read', STUDIO_FILES_CAPABILITY, false),
  'files.cancelSearch': owned('files:read', STUDIO_FILES_CAPABILITY, false),
  'files.stat': owned('files:read', STUDIO_FILES_CAPABILITY, false),
  'files.readImage': owned('files:read', STUDIO_FILES_CAPABILITY, false),
  'files.repoRoot': owned('files:read', STUDIO_FILES_CAPABILITY, false),
  'workspaces.list': owned('workspaces:read', STUDIO_WORKSPACES_CAPABILITY, false),
}

export function isStudioChatMethod(value: unknown): value is StudioChatMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_CHAT_METHODS, value)
}

// ── Params ──────────────────────────────────────────────────────────────────
//
// Shapes are checked here, at the edge, and unknown members dropped. What a
// value means (a mention that resolves inside its folder, a skill that
// exists) is checked by the Studio against the same rules its own windows'
// requests meet.

type Refusal = { ok: false; code: StudioErrorCode; message: string }
type Parsed<M extends StudioChatMethod> = { ok: true; params: StudioChatMethodMap[M]['params'] } | Refusal

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function optional<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === undefined || check(value)
}
function boolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}
function strings(value: unknown, max: number, each: (value: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(each)
}
const refuse = (message: string, code: StudioErrorCode = 'invalid_params'): Refusal => ({ ok: false, code, message })
const COMMAND_ID = '"commandId" must be a string of 1 to 200 characters.'
const SESSION_ID = '"sessionId" names the session.'
const KEY = '"key" names the conversation: { workspaceId, agentId, workspaceRoot? }.'

function cliRuntimes(value: unknown): Record<string, StudioCliRuntimeOverride | undefined> | null {
  if (!record(value)) return null
  const out: Record<string, StudioCliRuntimeOverride | undefined> = {}
  for (const [cli, entry] of Object.entries(value)) {
    if (!id(cli)) return null
    if (entry === undefined || entry === null) continue
    if (!record(entry)) return null
    if (!optional(entry.command, (v): v is string => text(v, 4096))) return null
    if (!optional(entry.hostId, id)) return null
    if (entry.models !== undefined && !strings(entry.models, 500, id)) return null
    out[cli] = {
      ...(entry.command === undefined ? {} : { command: entry.command as string }),
      ...(entry.hostId === undefined ? {} : { hostId: entry.hostId as string }),
      ...(entry.models === undefined ? {} : { models: [...(entry.models as string[])] }),
    }
  }
  return out
}

function sessionCommand(value: Record<string, unknown>): Refusal | { commandId: string; sessionId: string } {
  if (!id(value.commandId)) return refuse(COMMAND_ID)
  if (!id(value.sessionId)) return refuse(SESSION_ID)
  return { commandId: value.commandId, sessionId: value.sessionId }
}

function attachments(value: unknown): StudioSendAttachment[] | null {
  if (!Array.isArray(value) || value.length > STUDIO_MAX_UPLOADS_PER_SEND) return null
  const out: StudioSendAttachment[] = []
  for (const entry of value) {
    if (
      !record(entry) ||
      !id(entry.id) ||
      !id(entry.uploadId) ||
      !optional(entry.name, (v): v is string => text(v, 500))
    )
      return null
    out.push({
      id: entry.id,
      uploadId: entry.uploadId,
      ...(entry.name === undefined ? {} : { name: entry.name as string }),
    })
  }
  return out
}

/** A chat method's params, shape-checked, keeping only the members it defines. */
export function parseStudioChatParams<M extends StudioChatMethod>(method: M, params: unknown): Parsed<M> {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse(`${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioChatMethodMap[M]['params'] })
  switch (method as StudioChatMethod) {
    case 'session.start': {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (!isStudioPath(value.workspaceRoot)) return refuse('"workspaceRoot" is the folder the chat runs in.')
      if (!id(value.workspaceId) || !id(value.agentId)) return refuse('"workspaceId" and "agentId" name the chat.')
      if (!id(value.providerId) || !text(value.modelId, 400)) return refuse('"providerId" and "modelId" are required.')
      const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
      if (runtimes === null) return refuse('"cliRuntimes" maps a CLI to { command?, hostId?, models? }.')
      if (!optional(value.permissionPreset, isConversationWirePermissionPreset))
        return refuse('"permissionPreset" is none, manual, auto or bypass.')
      if (!optional(value.permissionMode, id)) return refuse('"permissionMode" names a mode of the CLI.')
      if (value.allowedTools !== undefined && !strings(value.allowedTools, 200, id))
        return refuse('"allowedTools" is a list of tool names.')
      return ok({
        commandId: value.commandId,
        workspaceRoot: value.workspaceRoot,
        workspaceId: value.workspaceId,
        agentId: value.agentId,
        providerId: value.providerId,
        modelId: value.modelId,
        ...(runtimes ? { cliRuntimes: runtimes } : {}),
        ...(value.permissionPreset === undefined ? {} : { permissionPreset: value.permissionPreset }),
        ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode }),
        ...(value.allowedTools === undefined ? {} : { allowedTools: [...(value.allowedTools as string[])] }),
      })
    }
    case 'session.send': {
      const session = sessionCommand(value)
      if ('ok' in session) return session
      if (typeof value.message !== 'string') return refuse('"message" is required.')
      if (value.message.length > CONVERSATION_MAX_MESSAGE_CHARS)
        return refuse(`A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`, 'too_large')
      if (!optional(value.localTurnId, id)) return refuse('"localTurnId" must be a string of 1 to 200 characters.')
      if (value.mentions !== undefined && !(Array.isArray(value.mentions) && value.mentions.length <= 200))
        return refuse('"mentions" is a list of at most 200 file references.')
      if (value.mentions !== undefined && !(value.mentions as unknown[]).every(record))
        return refuse('Each mention is an object.')
      if (
        value.files !== undefined &&
        !(
          Array.isArray(value.files) &&
          value.files.length <= STUDIO_MAX_FILES_PER_SEND &&
          value.files.every((file) => record(file) && isStudioPath(file.path))
        )
      )
        return refuse(`"files" is a list of at most ${STUDIO_MAX_FILES_PER_SEND} { path }.`)
      if (
        value.skills !== undefined &&
        !(
          Array.isArray(value.skills) &&
          value.skills.length <= 32 &&
          value.skills.every(
            (skill) => record(skill) && id(skill.id) && optional(skill.sourcePath, (v): v is string => isStudioPath(v)),
          )
        )
      )
        return refuse('"skills" is a list of at most 32 { id, sourcePath? }.')
      if (!optional(value.reasoningEffort, (v): v is string => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v)))
        return refuse('"reasoningEffort" names an effort level.')
      if (value.mode !== undefined && !['default', 'plan', 'ask'].includes(value.mode as string))
        return refuse('"mode" is default, plan or ask.')
      if (!optional(value.steer, boolean)) return refuse('"steer" is a boolean.')
      const sent = value.attachments === undefined ? undefined : attachments(value.attachments)
      if (sent === null)
        return refuse(`"attachments" is a list of at most ${STUDIO_MAX_UPLOADS_PER_SEND} { id, uploadId, name? }.`)
      return ok({
        ...session,
        message: value.message,
        ...(value.localTurnId === undefined ? {} : { localTurnId: value.localTurnId }),
        ...(value.mentions === undefined ? {} : { mentions: value.mentions }),
        ...(value.files === undefined
          ? {}
          : { files: (value.files as StudioAttachedFile[]).map((file) => ({ path: file.path })) }),
        ...(value.skills === undefined
          ? {}
          : {
              skills: (value.skills as StudioSkillRef[]).map((skill) => ({
                id: skill.id,
                ...(skill.sourcePath === undefined ? {} : { sourcePath: skill.sourcePath }),
              })),
            }),
        ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
        ...(value.mode === undefined ? {} : { mode: value.mode }),
        ...(value.steer === true ? { steer: true } : {}),
        ...(sent?.length ? { attachments: sent } : {}),
      })
    }
    case 'session.interrupt': {
      const session = sessionCommand(value)
      return 'ok' in session ? session : ok(session)
    }
    case 'session.respond': {
      const session = sessionCommand(value)
      if ('ok' in session) return session
      if (!id(value.requestId)) return refuse('"requestId" names the request.')
      if (!boolean(value.approved)) return refuse('"approved" is a boolean.')
      if (
        value.decision !== undefined &&
        !['once', 'conversation', 'always', 'deny'].includes(value.decision as string)
      )
        return refuse('"decision" is once, conversation, always or deny.')
      if (
        value.answers !== undefined &&
        !(
          record(value.answers) &&
          Object.keys(value.answers).length <= 64 &&
          Object.values(value.answers).every((answer) => text(answer, CONVERSATION_MAX_MESSAGE_CHARS))
        )
      )
        return refuse('"answers" maps question text to answer strings.')
      if (!optional(value.requestKind, id)) return refuse('"requestKind" names a kind of request.')
      return ok({
        ...session,
        requestId: value.requestId,
        approved: value.approved,
        ...(value.decision === undefined ? {} : { decision: value.decision }),
        ...(value.answers === undefined ? {} : { answers: { ...(value.answers as Record<string, string>) } }),
        ...(value.requestKind === undefined ? {} : { requestKind: value.requestKind }),
      })
    }
    case 'session.setPermission': {
      const session = sessionCommand(value)
      if ('ok' in session) return session
      if (!isConversationWirePermissionPreset(value.permissionPreset))
        return refuse('"permissionPreset" is none, manual, auto or bypass.')
      if (!optional(value.permissionMode, id)) return refuse('"permissionMode" names a mode of the CLI.')
      return ok({
        ...session,
        permissionPreset: value.permissionPreset,
        ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode }),
      })
    }
    case 'session.setModel': {
      const session = sessionCommand(value)
      if ('ok' in session) return session
      if (!(typeof value.modelId === 'string' && value.modelId.trim() && value.modelId.length <= 200))
        return refuse('"modelId" names the model.')
      return ok({ ...session, modelId: value.modelId.trim() })
    }
    case 'uploads.begin': {
      if (value.purpose === 'file') {
        if (!(typeof value.mediaType === 'string' && /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(value.mediaType)))
          return refuse('"mediaType" is the file’s media type.')
        if (!(integer(value.byteLength) && value.byteLength > 0))
          return refuse('"byteLength" is the file’s size in bytes.')
        if (value.byteLength > STUDIO_MAX_FILE_BYTES)
          return refuse(`A file may be at most ${STUDIO_MAX_FILE_BYTES / (1024 * 1024)} MB.`, 'too_large')
        return ok({ mediaType: value.mediaType, byteLength: value.byteLength, purpose: 'file' })
      }
      if (value.purpose !== undefined && value.purpose !== 'picture') return refuse('"purpose" is picture or file.')
      if (!(STUDIO_UPLOAD_MEDIA_TYPES as readonly unknown[]).includes(value.mediaType))
        return refuse('A picture is PNG, JPEG, WebP or GIF.')
      if (!(integer(value.byteLength) && value.byteLength > 0))
        return refuse('"byteLength" is the picture’s size in bytes.')
      if (value.byteLength > STUDIO_MAX_UPLOAD_BYTES)
        return refuse(`A picture may be at most ${STUDIO_MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'too_large')
      if (!optional(value.name, (v): v is string => text(v, 500))) return refuse('"name" is the picture’s file name.')
      return ok({
        mediaType: value.mediaType,
        byteLength: value.byteLength,
        ...(value.name === undefined ? {} : { name: value.name }),
      })
    }
    case 'uploads.append': {
      if (!id(value.uploadId)) return refuse('"uploadId" names the upload.')
      if (!integer(value.offset)) return refuse('"offset" is where these bytes start.')
      if (typeof value.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64))
        return refuse('"dataBase64" is the bytes, base64-encoded.')
      if (value.dataBase64.length > Math.ceil(STUDIO_UPLOAD_CHUNK_BYTES / 3) * 4)
        return refuse(`One append carries at most ${STUDIO_UPLOAD_CHUNK_BYTES} bytes.`, 'too_large')
      return ok({ uploadId: value.uploadId, offset: value.offset, dataBase64: value.dataBase64 })
    }
    case 'uploads.discard': {
      const ids = value.uploadIds
      if (!(Array.isArray(ids) && ids.length <= STUDIO_MAX_UPLOADS_PER_SEND * 2 && ids.every(id)))
        return refuse(`"uploadIds" lists at most ${STUDIO_MAX_UPLOADS_PER_SEND * 2} uploads.`)
      return ok({ uploadIds: [...ids] })
    }
    case 'conversation.revert': {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      if (!(integer(value.turnSeq) && value.turnSeq >= 1)) return refuse('"turnSeq" is the turn to revert.')
      if (!optional(value.confirmed, boolean) || !optional(value.undo, boolean))
        return refuse('"confirmed" and "undo" are booleans.')
      if (value.files !== undefined && !strings(value.files, 10_000, isStudioPath))
        return refuse('"files" lists the paths the preview showed.')
      return ok({
        commandId: value.commandId,
        key,
        turnSeq: value.turnSeq,
        ...(value.confirmed === true ? { confirmed: true } : {}),
        ...(value.undo === true ? { undo: true } : {}),
        ...(value.files === undefined ? {} : { files: [...(value.files as string[])] }),
      })
    }
    case 'conversation.rewind': {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      if (!(integer(value.turnSeq) && value.turnSeq >= 1)) return refuse('"turnSeq" is the message to go back to.')
      return ok({ commandId: value.commandId, key, turnSeq: value.turnSeq })
    }
    case 'conversation.handoff': {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      return ok({ commandId: value.commandId, key })
    }
    case 'conversation.fork': {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      if (!(id(value.newAgentId) && value.newAgentId.trim())) return refuse('"newAgentId" names the new chat.')
      if (!optional(value.title, (v): v is string => text(v, 500))) return refuse('"title" is the new chat’s name.')
      const common = {
        commandId: value.commandId,
        key,
        newAgentId: value.newAgentId,
        ...(value.title === undefined ? {} : { title: value.title }),
      }
      if (value.side === 'user') {
        if (!(integer(value.turnSeq) && value.turnSeq >= 1)) return refuse('"turnSeq" is the message to fork before.')
        return ok({ ...common, side: 'user', turnSeq: value.turnSeq })
      }
      if (value.side === 'assistant' && id(value.turnId))
        return ok({ ...common, side: 'assistant', turnId: value.turnId })
      return refuse('A fork is { side: "assistant", turnId } or { side: "user", turnSeq }.')
    }
    case 'conversation.attachment':
      return typeof value.ref === 'string' && value.ref.length > 0 && value.ref.length <= 1000
        ? ok({ ref: value.ref })
        : refuse('"ref" is the reference the user_message recorded.')
    case 'conversation.planDocument': {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      if (!text(value.plan, CONVERSATION_MAX_MESSAGE_CHARS * 5)) return refuse('"plan" is the plan’s text.')
      if (!optional(value.title, (v): v is string => text(v, 500))) return refuse('"title" is the plan’s title.')
      if (!optional(value.planFilePath, isStudioPath)) return refuse('"planFilePath" is the agent’s own copy.')
      return ok({
        key,
        plan: value.plan,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.planFilePath === undefined ? {} : { planFilePath: value.planFilePath }),
      })
    }
    case 'conversation.commands': {
      if (!id(value.cli)) return refuse('"cli" names the chat’s CLI.')
      if (!isStudioPath(value.cwd)) return refuse('"cwd" is the folder the list is for.')
      if (!optional(value.refresh, boolean)) return refuse('"refresh" is a boolean.')
      if (value.probe !== undefined && value.probe !== false) return refuse('"probe" is false or absent.')
      return ok({
        cli: value.cli,
        cwd: value.cwd,
        ...(value.refresh === true ? { refresh: true } : {}),
        ...(value.probe === false ? { probe: false } : {}),
      })
    }
    case 'providers.list': {
      const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
      if (runtimes === null) return refuse('"cliRuntimes" maps a CLI to { command?, hostId?, models? }.')
      return ok(runtimes ? { cliRuntimes: runtimes } : {})
    }
    case 'providers.models':
    case 'providers.secretStatus':
      return id(value.providerId) ? ok({ providerId: value.providerId }) : refuse('"providerId" names the provider.')
    case 'files.search': {
      if (!isStudioPath(value.rootPath)) return refuse('"rootPath" is the folder to search.')
      if (!text(value.query, 1000)) return refuse('"query" is at most 1000 characters.')
      if (!optional(value.limit, (v): v is number => integer(v) && v >= 1 && v <= 500))
        return refuse('"limit" is between 1 and 500.')
      if (value.purpose !== undefined && value.purpose !== 'mention') return refuse('"purpose" is mention or absent.')
      if (!optional(value.channel, id)) return refuse('"channel" names the search.')
      let recentAt: Record<string, number> | undefined
      if (value.recentAt !== undefined) {
        if (!record(value.recentAt) || Object.keys(value.recentAt).length > 1000)
          return refuse('"recentAt" maps at most 1000 paths to when each was opened.')
        recentAt = {}
        for (const [path, at] of Object.entries(value.recentAt))
          if (isStudioPath(path) && typeof at === 'number' && Number.isFinite(at)) recentAt[path] = at
      }
      return ok({
        rootPath: value.rootPath,
        query: value.query,
        ...(value.limit === undefined ? {} : { limit: value.limit }),
        ...(value.purpose === undefined ? {} : { purpose: 'mention' }),
        ...(value.channel === undefined ? {} : { channel: value.channel }),
        ...(recentAt ? { recentAt } : {}),
      })
    }
    case 'files.cancelSearch':
      return optional(value.channel, id)
        ? ok(value.channel === undefined ? {} : { channel: value.channel })
        : refuse('"channel" names the search.')
    case 'files.stat': {
      if (value.root === undefined)
        return isStudioPath(value.path) ? ok({ path: value.path }) : refuse('"path" is a path on Studio’s disk.')
      const root = parseStudioFileRoot(value.root)
      if (!root) return refuse('"root" is { kind: "boards" | "workspace" | "store", workspaceId }.')
      if (!isStudioRelativePath(value.path)) return refuse('"path" is relative to its root, with "/" between parts.')
      return ok({ path: value.path, root })
    }
    case 'files.readImage':
      return isStudioPath(value.path) ? ok({ path: value.path }) : refuse('"path" is a path on Studio’s disk.')
    case 'files.repoRoot':
      if (!isStudioPath(value.folderPath)) return refuse('"folderPath" is a folder on Studio’s disk.')
      if (!optional(value.hostId, id)) return refuse('"hostId" names the machine.')
      return ok({ folderPath: value.folderPath, ...(value.hostId === undefined ? {} : { hostId: value.hostId }) })
    case 'workspaces.list':
      return ok({})
  }
}

// ── Topics ──────────────────────────────────────────────────────────────────

export type StudioChatTopicMap = {
  /**
   * Every `/` command list a CLI reports for a folder, as it reports it: a
   * live session's, an ACP update's, a probe's. Each `push` payload is a whole
   * catalog `{ cli, cwd, commands, … }` that replaces the last one for its
   * (CLI, folder). Nothing is replayed on subscribing; ask
   * `conversation.commands` for the list held now.
   */
  'conversation.commands': { params: Record<string, never> }
}

export type StudioChatTopic = keyof StudioChatTopicMap

export const STUDIO_CHAT_TOPICS: {
  readonly [T in StudioChatTopic]: { scope: StudioScope; capability: StudioCapability; owner: true; push: true }
} = {
  'conversation.commands': {
    scope: 'conversation:read',
    capability: STUDIO_COMMANDS_CAPABILITY,
    owner: true,
    push: true,
  },
}
