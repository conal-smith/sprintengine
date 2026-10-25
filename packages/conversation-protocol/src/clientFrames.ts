import {
  CONVERSATION_MAX_MESSAGE_CHARS,
  explainRejectedConversationFrame,
  parseConversationClientFrame,
  type ConversationClientFrame,
  type ConversationFrameRejection,
} from './index.js'
import {
  CONVERSATION_MAX_REVERT_FILES,
  CONVERSATION_MAX_REVERT_PATH_CHARS,
  CONVERSATION_MAX_SEND_SKILLS,
  CONVERSATION_MCP_SERVER_ACTIONS,
  CONVERSATION_SEND_MODES,
  CONVERSATION_USAGE_LIMIT_RESUME_ACTIONS,
  isConversationPermissionModeId,
  parseConversationWireMentions,
  isConversationReasoningEffortId,
  type ConversationCommand,
  type ConversationWatchQueuedRequest,
  type ConversationWatchScheduledRequest,
  type ConversationWatchUsageLimitsRequest,
  type ConversationUsageLimitResumeAction,
} from './commands.js'
import type { ConversationHelloRequest } from './handshake.js'
import {
  parseConversationSideQuestionRequest,
  type ConversationAskSideQuestionRequest,
  type ConversationCancelSideQuestionRequest,
  type ConversationContextBreakdownRequest,
} from './agentReads.js'

// The server half of the full contract: what a desktop accepts from a client.
// `parseConversationClientFrame` (index.ts) is the lane as it first shipped
// and stays byte-for-byte what the phone carries; this reads the same frames
// plus the extensions in commands.ts and handshake.ts, each of which a client
// sends only to a desktop that advertised it.

/** A client frame under the full contract. */
export type ConversationClientMessage =
  | Exclude<ConversationClientFrame, { type: 'command' }>
  | { type: 'command'; commandId: string; command: ConversationCommand }
  | ConversationHelloRequest
  | ConversationWatchQueuedRequest
  | ConversationAskSideQuestionRequest
  | ConversationCancelSideQuestionRequest
  | ConversationContextBreakdownRequest
  | ConversationWatchScheduledRequest
  | ConversationWatchUsageLimitsRequest

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
// A skill's directory name, as the desktop's chat runtime accepts one.
const SKILL_ID = /^[\w.-]{1,200}(?::[\w.-]{1,200})?$/
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
// A user message's `seq`: the first event of a chat is 1.
function turnSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
function revertPaths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CONVERSATION_MAX_REVERT_FILES &&
    value.every(
      (path) => typeof path === 'string' && path.length > 0 && path.length <= CONVERSATION_MAX_REVERT_PATH_CHARS,
    )
  )
}

// A question's text is its answer's key, because the CLI reads the answers
// back by question, so a key is as long as the question it answers. The first
// version capped a key at 200 characters, and a long question (a two-part one
// most often) had its answer refused as an unsupported frame. A key may now be
// as long as an answer; the frame's total stays the message limit.
const MAX_QUESTION_CHARS = 20_000
const MAX_ANSWER_CHARS = 20_000
const MAX_ANSWERS = 64
function questionAnswers(value: unknown): value is Record<string, string> {
  if (!record(value)) return false
  const entries = Object.entries(value)
  if (entries.length > MAX_ANSWERS) return false
  let chars = 0
  for (const [key, answer] of entries) {
    if (key.length > MAX_QUESTION_CHARS || typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS) return false
    chars += key.length + answer.length
  }
  return chars <= CONVERSATION_MAX_MESSAGE_CHARS
}

/** Validate supported fields and strip unknown members, as `parseConversationClientFrame` does for the first version. */
export function parseConversationClientMessage(value: unknown): ConversationClientMessage | null {
  if (!record(value)) return null
  if (value.type === 'hello') {
    if (!id(value.requestId)) return null
    const version = value.protocolVersion
    if (version !== undefined && !(typeof version === 'number' && Number.isSafeInteger(version) && version >= 1))
      return null
    return {
      type: 'hello',
      requestId: value.requestId,
      ...(version === undefined ? {} : { protocolVersion: version as number }),
    }
  }
  if (value.type === 'watchQueued')
    return id(value.requestId) ? { type: 'watchQueued', requestId: value.requestId } : null
  // Reads that ask the chat's agent (agentReads.ts).
  if (value.type === 'askSideQuestion' || value.type === 'cancelSideQuestion')
    return parseConversationSideQuestionRequest(value)
  if (value.type === 'getContextBreakdown')
    return id(value.requestId) ? { type: 'getContextBreakdown', requestId: value.requestId } : null
  if (value.type === 'watchScheduled')
    return id(value.requestId) ? { type: 'watchScheduled', requestId: value.requestId } : null
  if (value.type === 'watchUsageLimits')
    return id(value.requestId) ? { type: 'watchUsageLimits', requestId: value.requestId } : null
  if (value.type === 'command' && record(value.command)) {
    const command = value.command
    // When the message was written, and whether the person confirmed one
    // written long ago, ride beside whatever else the send says: read here,
    // and the send without them is read as any other.
    if (command.kind === 'send' && (command.composedAt !== undefined || command.confirmedStale !== undefined)) {
      const { composedAt, confirmedStale } = command
      if (
        composedAt !== undefined &&
        !(typeof composedAt === 'number' && Number.isSafeInteger(composedAt) && composedAt >= 0)
      )
        return null
      if (confirmedStale !== undefined && confirmedStale !== true) return null
      const frame = parseConversationClientMessage({
        ...value,
        command: { ...command, composedAt: undefined, confirmedStale: undefined },
      })
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return {
        ...frame,
        command: {
          ...frame.command,
          ...(composedAt === undefined ? {} : { composedAt: composedAt as number }),
          ...(confirmedStale === true ? { confirmedStale: true as const } : {}),
        },
      }
    }
    if (command.kind === 'setReasoningEffort') {
      return id(value.commandId) && (command.effort === undefined || isConversationReasoningEffortId(command.effort))
        ? {
            type: 'command',
            commandId: value.commandId,
            command: {
              kind: 'setReasoningEffort',
              ...(command.effort === undefined ? {} : { effort: command.effort as string }),
            },
          }
        : null
    }
    if (command.kind === 'mcpServerAction') {
      return id(value.commandId) &&
        id(command.serverId) &&
        CONVERSATION_MCP_SERVER_ACTIONS.includes(command.action as never)
        ? {
            type: 'command',
            commandId: value.commandId,
            command: {
              kind: 'mcpServerAction',
              serverId: command.serverId,
              action: command.action as (typeof CONVERSATION_MCP_SERVER_ACTIONS)[number],
            },
          }
        : null
    }
    if (command.kind === 'restartSession') {
      return id(value.commandId)
        ? { type: 'command', commandId: value.commandId, command: { kind: 'restartSession' } }
        : null
    }
    // The mode a turn runs in rides beside whatever else the send says, and
    // never beside a message held for later, which goes in the default one.
    // `default` is the same as naming none, and is read as none.
    if (command.kind === 'send' && command.mode !== undefined) {
      const mode = command.mode
      if (!CONVERSATION_SEND_MODES.includes(mode as never) || command.queue !== undefined) return null
      const frame = parseConversationClientMessage({ ...value, command: { ...command, mode: undefined } })
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return mode === 'default' ? frame : { ...frame, command: { ...frame.command, mode: mode as 'plan' | 'ask' } }
    }
    if (command.kind === 'cancelQueued') {
      return id(value.commandId) && id(command.queuedId)
        ? { type: 'command', commandId: value.commandId, command: { kind: 'cancelQueued', queuedId: command.queuedId } }
        : null
    }
    if (command.kind === 'stopSubagent') {
      return id(value.commandId) && id(command.toolUseId)
        ? {
            type: 'command',
            commandId: value.commandId,
            command: { kind: 'stopSubagent', toolUseId: command.toolUseId },
          }
        : null
    }
    if (command.kind === 'handoff') {
      return id(value.commandId) ? { type: 'command', commandId: value.commandId, command: { kind: 'handoff' } } : null
    }
    if (command.kind === 'rewind') {
      return id(value.commandId) && turnSeq(command.turnSeq)
        ? { type: 'command', commandId: value.commandId, command: { kind: 'rewind', turnSeq: command.turnSeq } }
        : null
    }
    // The paths a confirmed revert acts on are the ones its preview listed,
    // and a preview names none.
    if (command.kind === 'revert') {
      const { undo, confirmed, files } = command
      if (!id(value.commandId) || !turnSeq(command.turnSeq)) return null
      if ((undo !== undefined && undo !== true) || (confirmed !== undefined && confirmed !== true)) return null
      if (confirmed === true ? !revertPaths(files) : files !== undefined) return null
      return {
        type: 'command',
        commandId: value.commandId,
        command: {
          kind: 'revert',
          turnSeq: command.turnSeq,
          ...(undo === true ? { undo: true as const } : {}),
          ...(confirmed === true ? { confirmed: true as const, files: [...(files as string[])] } : {}),
        },
      }
    }
    if (command.kind === 'fork') {
      if (!id(value.commandId) || !id(command.newAgentId)) return null
      const base = { kind: 'fork' as const, newAgentId: command.newAgentId }
      if (command.side === 'assistant')
        return id(command.turnId)
          ? {
              type: 'command',
              commandId: value.commandId,
              command: { ...base, side: 'assistant', turnId: command.turnId },
            }
          : null
      return command.side === 'user' &&
        typeof command.turnSeq === 'number' &&
        Number.isSafeInteger(command.turnSeq) &&
        command.turnSeq >= 1
        ? { type: 'command', commandId: value.commandId, command: { ...base, side: 'user', turnSeq: command.turnSeq } }
        : null
    }
    // A scheduled message is its words and its time, nothing else: what a
    // send stages beside its words is the moment's, and would be gone by then.
    if (command.kind === 'scheduleSend') {
      const { message, sendAt } = command
      return id(value.commandId) &&
        typeof message === 'string' &&
        message.trim() !== '' &&
        message.length <= CONVERSATION_MAX_MESSAGE_CHARS &&
        typeof sendAt === 'number' &&
        Number.isSafeInteger(sendAt) &&
        sendAt > 0
        ? { type: 'command', commandId: value.commandId, command: { kind: 'scheduleSend', message, sendAt } }
        : null
    }
    if (command.kind === 'sendScheduledNow' || command.kind === 'cancelScheduled') {
      return id(value.commandId) && id(command.scheduledId)
        ? {
            type: 'command',
            commandId: value.commandId,
            command: { kind: command.kind, scheduledId: command.scheduledId },
          }
        : null
    }
    if (command.kind === 'usageLimitResume') {
      const action = command.action as ConversationUsageLimitResumeAction
      if (!id(value.commandId) || !CONVERSATION_USAGE_LIMIT_RESUME_ACTIONS.includes(action)) return null
      // "Always" is a way to schedule, and only that.
      if (command.always !== undefined && (command.always !== true || action !== 'schedule')) return null
      return {
        type: 'command',
        commandId: value.commandId,
        command: { kind: 'usageLimitResume', action, ...(command.always === true ? { always: true } : {}) },
      }
    }
    // A steer is read as the send it rides on, and is never one held for
    // later: the two ask for opposite things.
    if (command.kind === 'send' && command.steer !== undefined) {
      if (command.steer !== true || command.queue !== undefined) return null
      const frame = parseConversationClientMessage({ ...value, command: { ...command, steer: undefined } })
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return { ...frame, command: { ...frame.command, steer: true } }
    }
    // Mentions ride a message the chat runs now, as skills do, and are read
    // off the send before the rest of it is.
    if (command.kind === 'send' && command.mentions !== undefined) {
      const mentions = parseConversationWireMentions(command.mentions)
      if (command.queue !== undefined || !mentions) return null
      const frame = parseConversationClientMessage({ ...value, command: { ...command, mentions: undefined } })
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return mentions.length ? { ...frame, command: { ...frame.command, mentions } } : frame
    }
    // Skills ride a message the chat runs now, not one held for later.
    if (command.kind === 'send' && command.skills !== undefined) {
      const skills = command.skills
      if (
        command.queue !== undefined ||
        !Array.isArray(skills) ||
        skills.length > CONVERSATION_MAX_SEND_SKILLS ||
        !skills.every((skill) => typeof skill === 'string' && SKILL_ID.test(skill))
      )
        return null
      const frame = parseConversationClientFrame({ ...value, command: { ...command, skills: undefined } })
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return { ...frame, command: { ...frame.command, skills: [...(skills as string[])] } }
    }
    // A held message is its words alone: the pictures a send carries are
    // staged for that send, and would be gone by the turn it waits for.
    if (command.kind === 'send' && command.queue !== undefined) {
      if (command.queue !== true || command.uploadIds !== undefined) return null
      const frame = parseConversationClientFrame(value)
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return { ...frame, command: { ...frame.command, queue: true } }
    }
    if (command.kind === 'resolvePlan') {
      return id(value.commandId) &&
        id(command.requestId) &&
        (command.decision === 'approve' || command.decision === 'reject')
        ? {
            type: 'command',
            commandId: value.commandId,
            command: { kind: 'resolvePlan', requestId: command.requestId, decision: command.decision },
          }
        : null
    }
    if (command.kind === 'answerQuestion') {
      return id(value.commandId) && id(command.requestId) && questionAnswers(command.answers)
        ? {
            type: 'command',
            commandId: value.commandId,
            command: { kind: 'answerQuestion', requestId: command.requestId, answers: { ...command.answers } },
          }
        : null
    }
    if (command.kind === 'setPermissionPreset' && command.permissionMode !== undefined) {
      if (!isConversationPermissionModeId(command.permissionMode)) return null
      const frame = parseConversationClientFrame(value)
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'setPermissionPreset') return null
      return { ...frame, command: { ...frame.command, permissionMode: command.permissionMode } }
    }
  }
  return parseConversationClientFrame(value)
}

/**
 * The typed refusal for a frame `parseConversationClientMessage` rejected,
 * answered under the id it carries, as `explainRejectedConversationFrame`
 * answers the first version's frames.
 */
export function explainRejectedConversationMessage(value: unknown): ConversationFrameRejection {
  const rejection = explainRejectedConversationFrame(value)
  // A question or an answer past its own limit is too large, not malformed.
  const command = record(value) && value.type === 'command' && record(value.command) ? value.command : null
  if (
    rejection.code === 'invalid_frame' &&
    command?.kind === 'answerQuestion' &&
    record(command.answers) &&
    Object.entries(command.answers).some(
      ([key, answer]) =>
        key.length > MAX_QUESTION_CHARS || (typeof answer === 'string' && answer.length > MAX_ANSWER_CHARS),
    )
  )
    return {
      ...rejection,
      code: 'too_large',
      message: `A question and its answer may each hold at most ${MAX_ANSWER_CHARS} characters.`,
    }
  // A malformed command of a kind this contract added is a bad frame, not one
  // the desktop does not know.
  return rejection.code === 'unsupported_command' &&
    (rejection.commandKind === 'resolvePlan' ||
      rejection.commandKind === 'cancelQueued' ||
      rejection.commandKind === 'stopSubagent' ||
      rejection.commandKind === 'handoff' ||
      rejection.commandKind === 'rewind' ||
      rejection.commandKind === 'revert' ||
      rejection.commandKind === 'fork' ||
      rejection.commandKind === 'setReasoningEffort' ||
      rejection.commandKind === 'mcpServerAction' ||
      rejection.commandKind === 'restartSession' ||
      rejection.commandKind === 'scheduleSend' ||
      rejection.commandKind === 'sendScheduledNow' ||
      rejection.commandKind === 'cancelScheduled' ||
      rejection.commandKind === 'usageLimitResume')
    ? { ...rejection, code: 'invalid_frame', message: 'Unsupported conversation frame.' }
    : rejection
}
