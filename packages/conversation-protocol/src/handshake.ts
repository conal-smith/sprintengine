import {
  CONVERSATION_CAPABILITY,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
} from './index.js'

// What a client and a desktop say about themselves before relying on anything
// the first version of the lane did not have.
//
// Features are asked about by name (capabilities), never inferred from a
// version: a capability is what the desktop says it serves now, while a
// version goes stale when a feature is back-ported, withdrawn or behind a
// setting. The version is there to refuse a peer outright when a change could
// not be additive, and to say so with both numbers.

/**
 * The contract this package describes. 1 is the lane as it first shipped plus
 * every capability below; a later integer means a change a capability could
 * not describe.
 */
export const CONVERSATION_PROTOCOL_VERSION = 1
/** The oldest contract a desktop built from this package still serves. */
export const CONVERSATION_PROTOCOL_MIN_SUPPORTED = 1

/** The desktop answers `hello` with its protocol version and conversation capabilities. */
export const CONVERSATION_HELLO_CAPABILITY = 'conversation-hello' as const
/** The `resolvePlan` command answers a `plan` request as a plan. */
export const CONVERSATION_PLANS_CAPABILITY = 'conversation-plans' as const
/**
 * Chats run on the CLI's own permission modes beside the four presets: a
 * listed thread names its `permissionMode` and the modes its provider runs
 * (`capabilities.permissionModes`), and `setPermissionPreset` takes a
 * `permissionMode`.
 */
export const CONVERSATION_CLI_PERMISSION_MODES_CAPABILITY = 'conversation-cli-permission-modes' as const
/**
 * The desktop owns each chat's rest and read state, and every client agrees
 * with it: the list leaves out the chats it has settled, arrives in the order
 * its sidebar draws them, and names each chat's `chatTitle`,
 * `lastUserMessageAt`, `lastTurnEndedAt` and `lastVisitedAt`; and the gateway
 * serves `conversation.settle` and `conversation.visit`.
 */
export const CONVERSATION_LIFECYCLE_CAPABILITY = 'conversation-lifecycle' as const
/**
 * The desktop holds a message queued while a chat is mid-turn and sends it
 * when the turn ends, as its own composer's queue does: `send` takes `queue`,
 * `cancelQueued` takes a held message back, and `watchQueued` has the
 * desktop say what it holds for the chat followed, in `queued` frames. A
 * message queued on the device that typed it is lost when that device sleeps
 * or closes before the turn ends; one the desktop holds is not.
 */
export const CONVERSATION_QUEUED_SENDS_CAPABILITY = 'conversation-queued-sends' as const
/**
 * A message may bring skills with it: `send` takes `skills`, the ids of skills
 * on the desktop that the chat should run with that message, as its own
 * composer's skill chips do. The desktop installs each into the chat's folder
 * if it is not there and keeps them on the chat.
 */
export const CONVERSATION_SEND_SKILLS_CAPABILITY = 'conversation-send-skills' as const
/**
 * A message may be steered into the turn that is running, as its own
 * composer's Steer does: `send` takes `steer`, and a listed chat says whether
 * its provider takes a message mid-turn (`capabilities.steer`). A steer the
 * turn cannot take is not lost: the desktop holds it as a queued message, or,
 * where a held message could not carry it, refuses it `busy` as any send made
 * mid-turn was.
 */
export const CONVERSATION_STEER_SENDS_CAPABILITY = 'conversation-steer-sends' as const
/**
 * The pictures a person sent with a message are served beside the step
 * pictures `conversation-images` names: `GET conversation-image` takes
 * `attachment`, the `ref` a `user_message`'s `attachments` entry records,
 * in place of `toolUseId`. Only a picture kept for that chat is served. A
 * client without it names the picture instead of showing it.
 */
export const CONVERSATION_MESSAGE_IMAGES_CAPABILITY = 'conversation-message-images' as const
/**
 * A picture uploaded for a chat (`POST upload`) is shrunk by the desktop on
 * receipt to the long edge its own composer sends (1568px), so the route takes
 * one up to 20MB as it arrives; what is kept is still at most 5MB. A client
 * without it keeps its upload under 5MB itself.
 */
export const CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY = 'conversation-image-downscale' as const

/**
 * Every conversation capability this version of the package knows, in the
 * order they shipped. A desktop advertises the ones it serves; a client reads
 * a name it does not know as a feature it does not use.
 */
export const CONVERSATION_CAPABILITIES = [
  CONVERSATION_CAPABILITY,
  CONVERSATION_MODELS_CAPABILITY,
  'conversation-images',
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_HELLO_CAPABILITY,
  CONVERSATION_PLANS_CAPABILITY,
  CONVERSATION_CLI_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_LIFECYCLE_CAPABILITY,
  CONVERSATION_QUEUED_SENDS_CAPABILITY,
  CONVERSATION_SEND_SKILLS_CAPABILITY,
  CONVERSATION_STEER_SENDS_CAPABILITY,
  CONVERSATION_MESSAGE_IMAGES_CAPABILITY,
  CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY,
] as const

export type ConversationCapability = (typeof CONVERSATION_CAPABILITIES)[number]

/**
 * Whether a peer serves a capability. `null` — a peer that published no list
 * — is unknown, which is not the same as a list without the name; both answer
 * false here, and a caller that must tell them apart checks for null first.
 */
export function conversationPeerSupports(
  capabilities: readonly string[] | null | undefined,
  capability: ConversationCapability,
): boolean {
  return Array.isArray(capabilities) && capabilities.includes(capability)
}

/**
 * The `hello` request: a client's first frame, answered by a `result` under
 * its `requestId` whose `data` is a `ConversationHelloAnswer`. A desktop from
 * before `conversation-hello` answers it `ok: false` with `invalid_frame`,
 * which a client reads as protocol 1 with whatever capabilities the
 * transport's own handshake listed.
 */
export type ConversationHelloRequest = { type: 'hello'; requestId: string; protocolVersion?: number }

export type ConversationHelloAnswer = {
  protocolVersion: number
  minProtocolVersion: number
  capabilities: string[]
}

/** A `hello` answer read off a `result`'s `data`, or null when it is not one. */
export function parseConversationHelloAnswer(value: unknown): ConversationHelloAnswer | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const answer = value as Record<string, unknown>
  const version = (field: unknown): field is number =>
    typeof field === 'number' && Number.isSafeInteger(field) && field >= 1
  if (!version(answer.protocolVersion) || !version(answer.minProtocolVersion)) return null
  if (!Array.isArray(answer.capabilities)) return null
  return {
    protocolVersion: answer.protocolVersion,
    minProtocolVersion: answer.minProtocolVersion,
    capabilities: answer.capabilities.filter(
      (name): name is string => typeof name === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(name),
    ),
  }
}

/**
 * Whether two ends can talk: each must serve the other's version. The
 * refusal names both numbers and which side to update, so it is a fix and not
 * a support thread.
 */
export function checkConversationProtocolVersion(
  peerVersion: number,
  peerMinVersion: number = peerVersion,
): { ok: true } | { ok: false; message: string } {
  if (peerVersion < CONVERSATION_PROTOCOL_MIN_SUPPORTED)
    return {
      ok: false,
      message: `The other end speaks conversation protocol ${peerVersion}, and this one needs ${CONVERSATION_PROTOCOL_MIN_SUPPORTED} or newer. Update the other end.`,
    }
  if (peerMinVersion > CONVERSATION_PROTOCOL_VERSION)
    return {
      ok: false,
      message: `The other end needs conversation protocol ${peerMinVersion} or newer, and this one speaks ${CONVERSATION_PROTOCOL_VERSION}. Update this end.`,
    }
  return { ok: true }
}
