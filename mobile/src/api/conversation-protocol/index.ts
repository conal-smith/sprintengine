export * from './tool-types.js'
export * from './presentation.js'
export * from './toolKind.js'
export * from './commandLabel.js'

/** An additive capability of the tailnet gateway, served only over the tailnet. */
export const CONVERSATION_CAPABILITY = 'conversations' as const
/**
 * An additive capability of the tailnet gateway, beside `conversations`: the
 * list names each chat's CLI and the models it can switch between (`models`
 * on a thread), and the `setModel` command switches a chat to one of them. A
 * desktop that does not advertise it lists no catalog and refuses the command
 * as unsupported, so a client hides its model control.
 */
export const CONVERSATION_MODELS_CAPABILITY = 'conversation-models' as const
/**
 * An additive capability of the tailnet gateway, beside `conversations`: the
 * desktop runs chats on all four permission presets, not only `none` and
 * `bypass`. Its list may name `manual` or `auto` as a chat's preset and names
 * the presets each chat's provider can run (`capabilities.permissionPresets`),
 * and it takes `setPermissionPreset` with either. A desktop without it reads
 * `manual` and `auto` as `none`, so a client offers them only where this is
 * advertised.
 */
export const CONVERSATION_PERMISSION_MODES_CAPABILITY = 'conversation-permission-modes' as const
/**
 * The model id that asks a chat's CLI for its own default model, as a launch
 * without a model flag does. `setModel` always accepts it for a chat that has a
 * catalog, and a catalog never lists it.
 */
export const CONVERSATION_DEFAULT_MODEL_ID = 'default'
/** The most models one chat's catalog lists. A desktop cuts a longer catalog to this many. */
export const CONVERSATION_MAX_MODEL_OPTIONS = 100
export const CONVERSATION_SOCKET_PATH = '/tailnet/v1/conversation'
/**
 * The largest frame the desktop sends. A logical frame bigger than this — a
 * large tool detail, a long merged reply — arrives as consecutive `chunk`
 * frames whose `json` strings concatenate, in `index` order, to the frame.
 */
export const CONVERSATION_MAX_FRAME_BYTES = 256 * 1024
export const CONVERSATION_MAX_IMAGES = 16
/** The longest message a `send` carries, and the most text a question's answers may hold together. */
export const CONVERSATION_MAX_MESSAGE_CHARS = 200_000
/**
 * The largest frame a client may send. A message at the character limit can
 * encode to six bytes per UTF-16 unit when every unit is escaped (`\u0001`),
 * so the cap is that worst case plus room for the envelope: a message the
 * validator accepts always fits. A larger frame is skipped and refused with a
 * typed `too_large` failure rather than closing the socket.
 */
export const CONVERSATION_MAX_CLIENT_FRAME_BYTES = CONVERSATION_MAX_MESSAGE_CHARS * 6 + 64 * 1024
const MAX_ANSWERS = 64
/**
 * The close code for a socket the desktop could not keep up to date: the
 * client fell too far behind live events. Reconnect with the last cursor after
 * the delay the close reason advises (`conversationCloseRetryAfterMs`).
 */
export const CONVERSATION_RESYNC_CLOSE_CODE = 4409
/** The close code for a device whose grant no longer includes `conversation:read`. Re-pairing is the fix. */
export const CONVERSATION_SCOPE_CLOSE_CODE = 4403

/** A close reason carrying a retry delay, e.g. `resync_required;retryAfterMs=2000`. */
export function conversationCloseReason(code: string, retryAfterMs: number): string {
  return `${code};retryAfterMs=${Math.max(0, Math.round(retryAfterMs))}`
}

/** The retry delay a close reason advises, or null when it names none. */
export function conversationCloseRetryAfterMs(reason: string): number | null {
  const match = /;retryAfterMs=(\d{1,7})$/.exec(reason)
  return match ? Number(match[1]) : null
}

export type ConversationWirePhase =
  'idle' | 'starting' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'failed' | 'completed'
export type ConversationWireKey = { workspaceId: string; agentId: string }
/**
 * `bypass` skips the CLI's approval prompts; `auto` lets edits in the
 * workspace through and asks before anything riskier; `manual` asks before
 * every edit, command and outside call; `none` passes no permission flag.
 * `manual` and `auto` need `conversation-permission-modes`.
 */
export type ConversationWirePermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'
/** Every wire preset, strictest first. */
export const CONVERSATION_WIRE_PERMISSION_PRESETS: readonly ConversationWirePermissionPreset[] = [
  'manual',
  'none',
  'auto',
  'bypass',
]
/** One model a chat can switch to: the id its CLI takes, and the name the desktop's own picker shows. */
export type ConversationWireModelOption = { id: string; label?: string }
/**
 * The chat's CLI and the models it can switch between — the same rows the
 * desktop's own picker offers for that CLI. A switch stays within the CLI;
 * `CONVERSATION_DEFAULT_MODEL_ID` is accepted besides the listed ids.
 */
export type ConversationWireModels = {
  /** The CLI the chat runs on, e.g. `claude-code`. */
  cli: string
  /** What the desktop calls that CLI, e.g. `Claude Code`: the name of its default-model row. */
  cliLabel: string
  /**
   * Whether the chat's provider takes a new model mid-conversation, from its
   * next turn. Without it the model is fixed once the chat has started.
   */
  liveModelSwitch: boolean
  options: ConversationWireModelOption[]
}
export type ConversationWireThread = ConversationWireKey & {
  title: string
  phase: ConversationWirePhase
  updatedAt: number
  createdAt: number
  providerId: string
  modelId: string
  turnCount: number
  lastSeq: number
  sessionId?: string
  /**
   * The permission preset the conversation runs under, or resumes under when
   * no session is live. Absent from a desktop built before it was listed.
   */
  permissionPreset?: ConversationWirePermissionPreset
  /**
   * The models the chat can switch between, from a desktop that advertises
   * `conversation-models`. Absent from any other desktop, and for a chat whose
   * provider is not a CLI.
   */
  models?: ConversationWireModels
  capabilities?: {
    images: boolean
    approvals: boolean
    questions: boolean
    planMode: boolean
    interrupt: boolean
    checkpoints: boolean
    /**
     * The presets the chat's provider can run, from a desktop that advertises
     * `conversation-permission-modes`. Absent means unknown.
     */
    permissionPresets?: ConversationWirePermissionPreset[]
  }
}
export type ConversationWireErrorCode =
  | 'conversation_scope_required'
  | 'conversation_operate_required'
  | 'invalid_frame'
  | 'not_found'
  | 'unavailable'
  | 'resync_required'
  // Too many requests of this kind are already in flight on this socket.
  // Retryable: retry after `retryAfterMs`.
  | 'busy'
  // A request, command or response over its size limit. Not retryable as is.
  | 'too_large'
  | 'unsafe_remote_decision'
  | 'unsupported_command'
  // A `setModel` naming a model that is not in the chat's CLI catalog.
  | 'unsupported_model'
export type ConversationWireCommand =
  | { kind: 'send'; message: string; uploadIds?: string[] }
  | { kind: 'interrupt' }
  | { kind: 'resolveApproval'; requestId: string; decision: 'once' | 'conversation' | 'deny' }
  | { kind: 'answerQuestion'; requestId: string; answers: Record<string, string> }
  | { kind: 'setPermissionPreset'; preset: ConversationWirePermissionPreset }
  // Needs `conversation-models`. `modelId` is one of the chat's `models.options`
  // or `CONVERSATION_DEFAULT_MODEL_ID`; the CLI never changes.
  | { kind: 'setModel'; modelId: string }
/**
 * `afterSeq` with the `generation` of an earlier `snapshot` or `synchronized`
 * asks for only the events after that sequence: one `event` per missed event,
 * then `synchronized`, then live events, with no snapshot. A cursor the
 * desktop cannot vouch for — another generation, no generation, ahead of the
 * log, or too far behind — is answered with `snapshot` (`reset: true`) instead.
 */
export type ConversationClientFrame =
  | { type: 'subscribe'; key: ConversationWireKey; afterSeq?: number; generation?: string; turnLimit?: number }
  | { type: 'list'; requestId: string }
  | { type: 'loadEarlier'; requestId: string; beforeCursor: number; turnLimit?: number }
  | { type: 'getToolDetail'; requestId: string; toolUseId: string }
  | { type: 'getTurnDiff'; requestId: string; turnSeq: number; path?: string }
  | { type: 'command'; commandId: string; command: ConversationWireCommand }

export type ConversationServerFrame =
  | { type: 'sessions'; requestId: string; sessions: ConversationWireThread[] }
  | { type: 'event'; event: unknown }
  | { type: 'chunk'; frameId: string; index: number; total: number; json: string }
  // Sequence numbers only ever increase, but they are not contiguous: a run of
  // text deltas can arrive merged into one delta numbered with the run's last
  // sequence. A gap is normal and never a reason to resubscribe.
  //
  // A snapshot too big for one frame arrives as consecutive `snapshot` frames
  // with `part`: their `page.events` concatenate in `index` order, and every
  // other field is the same on each. Apply it once the last part arrives. A
  // snapshot without `part` is whole.
  //
  // `key` names the conversation a snapshot or fence belongs to. A client
  // ignores one for a conversation it no longer follows; a desktop from
  // before the field sends none.
  | {
      type: 'snapshot'
      page: unknown
      reset?: true
      generation?: string
      part?: { index: number; total: number }
      key?: ConversationWireKey
    }
  | { type: 'synchronized'; seq: number; generation?: string; key?: ConversationWireKey }
  // The subscription to `key` did not start. When `retryable`, subscribe again
  // after `retryAfterMs`; otherwise the conversation is not available to this
  // device.
  | {
      type: 'subscribeFailed'
      key: ConversationWireKey
      code: ConversationWireErrorCode
      message: string
      retryable: boolean
      retryAfterMs?: number
    }
  | {
      type: 'result'
      requestId: string
      ok: boolean
      data?: unknown
      code?: ConversationWireErrorCode
      message?: string
      retryAfterMs?: number
    }
  // `notice` qualifies an accepted command: a model switch made while a turn
  // is running applies from the next turn, and the reply on screen finishes
  // on the model it started with.
  | {
      type: 'commandResult'
      commandId: string
      ok: boolean
      code?: ConversationWireErrorCode
      message?: string
      notice?: string
      retryAfterMs?: number
    }
  | { type: 'error'; code: ConversationWireErrorCode; message: string; retryAfterMs?: number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function answers(value: unknown): value is Record<string, string> {
  if (!record(value)) return false
  const entries = Object.entries(value)
  let chars = 0
  for (const [key, answer] of entries) {
    if (key.length > 200 || typeof answer !== 'string' || answer.length > 20_000) return false
    chars += key.length + answer.length
  }
  return entries.length <= MAX_ANSWERS && chars <= CONVERSATION_MAX_MESSAGE_CHARS
}

/** Why a client frame was refused, and the id to answer it under when it carries one. */
export type ConversationFrameRejection = {
  code: ConversationWireErrorCode
  message: string
  commandId?: string
  commandKind?: string
  requestId?: string
}

/**
 * The typed refusal for a frame `parseConversationClientFrame` rejected. A
 * command is answered under its `commandId` and a read under its `requestId`,
 * so a client can always settle what it sent.
 */
export function explainRejectedConversationFrame(value: unknown): ConversationFrameRejection {
  const frame = record(value) ? value : {}
  const command = frame.type === 'command' && record(frame.command) ? frame.command : null
  const ids = {
    ...(frame.type === 'command' && id(frame.commandId) ? { commandId: frame.commandId } : {}),
    ...(command && typeof command.kind === 'string' ? { commandKind: command.kind.slice(0, 64) } : {}),
    ...(frame.type !== 'command' && id(frame.requestId) ? { requestId: frame.requestId } : {}),
  }
  if (command?.decision === 'always')
    return { code: 'unsafe_remote_decision', message: 'A remote device cannot choose a permanent rule.', ...ids }
  const tooLong =
    (typeof command?.message === 'string' && command.message.length > CONVERSATION_MAX_MESSAGE_CHARS) ||
    (record(command?.answers) &&
      (Object.keys(command.answers).length > MAX_ANSWERS ||
        Object.entries(command.answers).reduce(
          (sum, [key, answer]) => sum + key.length + (typeof answer === 'string' ? answer.length : 0),
          0,
        ) > CONVERSATION_MAX_MESSAGE_CHARS))
  if (tooLong)
    return {
      code: 'too_large',
      message: `A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`,
      ...ids,
    }
  if (
    command &&
    !['send', 'interrupt', 'resolveApproval', 'answerQuestion', 'setPermissionPreset', 'setModel'].includes(
      String(command.kind),
    )
  )
    return { code: 'unsupported_command', message: 'This desktop does not support that command.', ...ids }
  return { code: 'invalid_frame', message: 'Unsupported conversation frame.', ...ids }
}

// Every client that ever sent `manual` or `auto` meant those modes: one built
// before the two-mode change, or one that saw `conversation-permission-modes`.
function wirePermissionPreset(value: unknown): ConversationWirePermissionPreset | null {
  return isConversationWirePermissionPreset(value) ? value : null
}

/** Whether a value is one of the wire's permission presets. */
export function isConversationWirePermissionPreset(value: unknown): value is ConversationWirePermissionPreset {
  return CONVERSATION_WIRE_PERMISSION_PRESETS.includes(value as ConversationWirePermissionPreset)
}

/** Validate supported fields and strip unknown members before handing a frame to main. */
export function parseConversationClientFrame(value: unknown): ConversationClientFrame | null {
  if (!record(value) || typeof value.type !== 'string') return null
  switch (value.type) {
    case 'subscribe': {
      const key = value.key
      if (!record(key) || !id(key.workspaceId) || !id(key.agentId)) return null
      if (value.afterSeq !== undefined && !integer(value.afterSeq)) return null
      if (value.generation !== undefined && !id(value.generation)) return null
      if (value.turnLimit !== undefined && (!integer(value.turnLimit) || value.turnLimit > 100)) return null
      return {
        type: 'subscribe',
        key: { workspaceId: key.workspaceId, agentId: key.agentId },
        ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq as number }),
        ...(value.generation === undefined ? {} : { generation: value.generation as string }),
        ...(value.turnLimit === undefined ? {} : { turnLimit: value.turnLimit as number }),
      }
    }
    case 'list':
      return id(value.requestId) ? { type: 'list', requestId: value.requestId } : null
    case 'loadEarlier':
      return id(value.requestId) &&
        integer(value.beforeCursor) &&
        (value.turnLimit === undefined || (integer(value.turnLimit) && value.turnLimit <= 100))
        ? {
            type: 'loadEarlier',
            requestId: value.requestId,
            beforeCursor: value.beforeCursor,
            ...(value.turnLimit === undefined ? {} : { turnLimit: value.turnLimit as number }),
          }
        : null
    case 'getToolDetail':
      return id(value.requestId) && id(value.toolUseId)
        ? { type: 'getToolDetail', requestId: value.requestId, toolUseId: value.toolUseId }
        : null
    case 'getTurnDiff':
      return id(value.requestId) &&
        integer(value.turnSeq) &&
        (value.path === undefined || (typeof value.path === 'string' && value.path.length <= 4096))
        ? {
            type: 'getTurnDiff',
            requestId: value.requestId,
            turnSeq: value.turnSeq,
            ...(value.path === undefined ? {} : { path: value.path as string }),
          }
        : null
    case 'command': {
      if (!id(value.commandId) || !record(value.command)) return null
      const command = value.command
      switch (command.kind) {
        case 'send':
          return typeof command.message === 'string' &&
            command.message.length <= CONVERSATION_MAX_MESSAGE_CHARS &&
            (command.uploadIds === undefined ||
              (Array.isArray(command.uploadIds) &&
                command.uploadIds.length <= CONVERSATION_MAX_IMAGES &&
                command.uploadIds.every(id)))
            ? {
                type: 'command',
                commandId: value.commandId,
                command: {
                  kind: 'send',
                  message: command.message,
                  ...(command.uploadIds === undefined ? {} : { uploadIds: command.uploadIds as string[] }),
                },
              }
            : null
        case 'interrupt':
          return { type: 'command', commandId: value.commandId, command: { kind: 'interrupt' } }
        case 'resolveApproval':
          return id(command.requestId) && ['once', 'conversation', 'deny'].includes(String(command.decision))
            ? {
                type: 'command',
                commandId: value.commandId,
                command: {
                  kind: 'resolveApproval',
                  requestId: command.requestId,
                  decision: command.decision as 'once' | 'conversation' | 'deny',
                },
              }
            : null
        case 'answerQuestion':
          return id(command.requestId) && answers(command.answers)
            ? {
                type: 'command',
                commandId: value.commandId,
                command: { kind: 'answerQuestion', requestId: command.requestId, answers: command.answers },
              }
            : null
        case 'setPermissionPreset': {
          const preset = wirePermissionPreset(command.preset)
          return preset
            ? { type: 'command', commandId: value.commandId, command: { kind: 'setPermissionPreset', preset } }
            : null
        }
        case 'setModel':
          return id(command.modelId)
            ? { type: 'command', commandId: value.commandId, command: { kind: 'setModel', modelId: command.modelId } }
            : null
        default:
          return null
      }
    }
    default:
      return null
  }
}

/**
 * A thread's `models`, validated for a client: null when it is absent or not
 * in the documented shape, so a client hides its model control rather than
 * offering a guess. A row with no usable id is dropped; the list is cut to
 * `CONVERSATION_MAX_MODEL_OPTIONS`.
 */
export function parseConversationWireModels(value: unknown): ConversationWireModels | null {
  if (!record(value) || !id(value.cli) || typeof value.cliLabel !== 'string' || value.cliLabel.length > 200) return null
  if (typeof value.liveModelSwitch !== 'boolean' || !Array.isArray(value.options)) return null
  const options: ConversationWireModelOption[] = []
  for (const option of value.options) {
    if (options.length >= CONVERSATION_MAX_MODEL_OPTIONS) break
    if (!record(option) || !id(option.id) || option.id === CONVERSATION_DEFAULT_MODEL_ID) continue
    const label = typeof option.label === 'string' && option.label.length <= 200 ? option.label.trim() : ''
    options.push({ id: option.id, ...(label ? { label } : {}) })
  }
  return { cli: value.cli, cliLabel: value.cliLabel, liveModelSwitch: value.liveModelSwitch, options }
}
