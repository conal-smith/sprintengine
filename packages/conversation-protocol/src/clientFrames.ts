import {
  explainRejectedConversationFrame,
  parseConversationClientFrame,
  type ConversationClientFrame,
  type ConversationFrameRejection,
} from './index.js'
import {
  CONVERSATION_MAX_SEND_SKILLS,
  isConversationPermissionModeId,
  type ConversationCommand,
  type ConversationWatchQueuedRequest,
} from './commands.js'
import type { ConversationHelloRequest } from './handshake.js'

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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
// A skill's directory name, as the desktop's chat runtime accepts one.
const SKILL_ID = /^[\w.-]{1,200}(?::[\w.-]{1,200})?$/
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
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
  if (value.type === 'command' && record(value.command)) {
    const command = value.command
    if (command.kind === 'cancelQueued') {
      return id(value.commandId) && id(command.queuedId)
        ? { type: 'command', commandId: value.commandId, command: { kind: 'cancelQueued', queuedId: command.queuedId } }
        : null
    }
    // A steer is read as the send it rides on, and is never one held for
    // later: the two ask for opposite things.
    if (command.kind === 'send' && command.steer !== undefined) {
      if (command.steer !== true || command.queue !== undefined) return null
      const frame = parseConversationClientMessage({ ...value, command: { ...command, steer: undefined } })
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'send') return null
      return { ...frame, command: { ...frame.command, steer: true } }
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
  // A malformed command of a kind this contract added is a bad frame, not one
  // the desktop does not know.
  return rejection.code === 'unsupported_command' &&
    (rejection.commandKind === 'resolvePlan' || rejection.commandKind === 'cancelQueued')
    ? { ...rejection, code: 'invalid_frame', message: 'Unsupported conversation frame.' }
    : rejection
}
