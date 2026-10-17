import type { ConversationSecretSetInput, ConversationSecretStatusInput } from '../shared/electron-api'
import type {
  ConversationCliRuntimeOverrides,
  ConversationImageAttachment,
  ConversationInterruptInput,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSetModelInput,
  ConversationMcpServerAction,
  ConversationMcpServerActionInput,
  ConversationStopSubagentInput,
  ConversationCancelSideQuestionInput,
  ConversationSideQuestionExchange,
  ConversationSideQuestionInput,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationTranscriptInput,
} from '../shared/conversation-runtime'
import { CONVERSATION_PERMISSION_PRESETS } from '../shared/conversation-runtime'
import { parseCliPermissionPreset } from '../shared/cli-permission-preset'
import { parseCliPermissionModeId } from '../shared/cli-permission-mode'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
} from '../shared/conversation-attachments'
import { isRecord } from '../shared/records'
import { parseConversationMentions } from '../shared/conversation/mentions'
import { parseConversationAttachedFiles } from '../shared/conversation/attachedFiles'

// What the conversation boundary accepts from a chat view, checked where it
// arrives: the IPC from Studio's windows, and the Studio RPC's chat surface,
// which reads the same inputs by the same rules so one chat behaves the same
// whichever way its view reaches it. Each answers the parsed input, keeping
// only the members it knows, or the sentence that says what is wrong.

export function parseProviderInput(
  input: unknown,
): { ok: true; input: ConversationSecretStatusInput } | { ok: false; message: string } {
  if (!isRecord(input) || typeof input.providerId !== 'string') {
    return { ok: false, message: 'providerId is required.' }
  }
  return { ok: true, input: { providerId: input.providerId } }
}

export function parseSecretSetInput(
  input: unknown,
): { ok: true; input: ConversationSecretSetInput } | { ok: false; message: string } {
  const parsed = parseProviderInput(input)
  if (!parsed.ok) return parsed
  if (!isRecord(input) || typeof input.value !== 'string') {
    return { ok: false, message: 'Secret value is required.' }
  }
  return { ok: true, input: { providerId: parsed.input.providerId, value: input.value } }
}

export function parseStartSessionInput(
  input: unknown,
): { ok: true; input: ConversationStartSessionInput } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'Start session input must be an object.' }
  const { workspaceRoot, workspaceId, agentId, providerId, modelId, cliRuntimes, permissionPreset, allowedTools } =
    input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  if (typeof providerId !== 'string') return { ok: false, message: 'providerId is required.' }
  if (typeof modelId !== 'string') return { ok: false, message: 'modelId is required.' }
  if (cliRuntimes !== undefined && !isRecord(cliRuntimes)) {
    return { ok: false, message: 'cliRuntimes must be an object when present.' }
  }
  const preset = permissionPreset === undefined ? undefined : parseCliPermissionPreset(permissionPreset)
  if (preset === null) return { ok: false, message: PERMISSION_PRESET_ERROR }
  // A mode of the CLI's own rides only beside a preset; one that is not a mode
  // id is dropped, and the preset's own mode runs.
  const mode = preset ? parseCliPermissionModeId(input.permissionMode) : null
  if (
    allowedTools !== undefined &&
    (!Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== 'string'))
  ) {
    return { ok: false, message: 'allowedTools must be an array of tool names.' }
  }
  return {
    ok: true,
    input: {
      workspaceRoot,
      workspaceId,
      agentId,
      providerId,
      modelId,
      ...(isRecord(cliRuntimes) ? { cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides } : {}),
      ...(preset ? { permissionPreset: preset } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      ...(Array.isArray(allowedTools) ? { allowedTools: allowedTools as string[] } : {}),
    },
  }
}

export function parseTranscriptInput(
  input: unknown,
): { ok: true; input: ConversationTranscriptInput } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'Transcript input must be an object.' }
  const { workspaceRoot, workspaceId, agentId } = input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  return { ok: true, input: { workspaceRoot, workspaceId, agentId } }
}

// Image attachments accepted on a send-turn. The media-type set, the per-image
// byte ceiling and the per-turn cap are the shared boundary limits the composer
// stages against (src/shared/conversation-attachments.ts) — one declaration
// rather than a copy on each side, so the composer can never stage an image
// this boundary then refuses. Anything outside them is rejected here rather
// than failing deep in the provider.
const ALLOWED_IMAGE_MEDIA_TYPES = new Set<string>(ATTACHABLE_IMAGE_TYPES)
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

// Decoded byte length of a base64 string without allocating the buffer.
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function parseImageAttachments(
  raw: unknown,
): { ok: true; attachments: ConversationImageAttachment[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'attachments must be an array when present.' }
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, message: `A turn can carry at most ${MAX_ATTACHMENTS_PER_TURN} attachments.` }
  }
  const attachments: ConversationImageAttachment[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, message: 'Each attachment must be an object.' }
    const { id, mediaType, dataBase64, name, byteLength } = entry
    if (typeof id !== 'string' || !id.trim()) return { ok: false, message: 'Attachment id is required.' }
    if (typeof mediaType !== 'string' || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, message: 'Attachments must be PNG, JPEG, WebP, or GIF images.' }
    }
    if (
      typeof dataBase64 !== 'string' ||
      !dataBase64 ||
      !BASE64_PATTERN.test(dataBase64) ||
      dataBase64.length % 4 !== 0
    ) {
      return { ok: false, message: 'Attachment image data must be base64-encoded.' }
    }
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, message: 'Attachment name must be a string when present.' }
    }
    // Trust the decoded length over the client-supplied byteLength for the guard.
    const decodedBytes = base64ByteLength(dataBase64)
    if (decodedBytes > MAX_ATTACHMENT_BYTES) {
      return { ok: false, message: 'Each attached image must be 5 MB or smaller.' }
    }
    if (byteLength !== undefined && typeof byteLength !== 'number') {
      return { ok: false, message: 'Attachment byteLength must be a number when present.' }
    }
    attachments.push({
      id,
      mediaType,
      dataBase64,
      ...(typeof name === 'string' ? { name } : {}),
      byteLength: decodedBytes,
    })
  }
  return { ok: true, attachments }
}

export function parseSendTurnInput(
  input: unknown,
): { ok: true; input: ConversationSendTurnInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isRecord(input) || typeof input.message !== 'string') return { ok: false, message: 'message is required.' }
  if ('localTurnId' in input && input.localTurnId !== undefined && typeof input.localTurnId !== 'string') {
    return { ok: false, message: 'localTurnId must be a string when present.' }
  }
  if (
    input.reasoningEffort !== undefined &&
    (typeof input.reasoningEffort !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(input.reasoningEffort))
  )
    return { ok: false, message: 'Invalid reasoning effort.' }
  if (input.mode !== undefined && !['default', 'plan', 'ask'].includes(String(input.mode)))
    return { ok: false, message: 'Invalid conversation mode.' }
  if (input.steer !== undefined && typeof input.steer !== 'boolean')
    return { ok: false, message: 'steer must be a boolean when present.' }
  let attachments: ConversationImageAttachment[] | undefined
  const mentions = input.mentions === undefined ? undefined : parseConversationMentions(input.mentions)
  if (mentions === null) return { ok: false, message: 'Mention references are invalid.' }
  const files = input.files === undefined ? undefined : parseConversationAttachedFiles(input.files)
  if (files === null) return { ok: false, message: 'Attached files must be absolute paths, at most 50.' }
  if (
    input.skills !== undefined &&
    (!Array.isArray(input.skills) ||
      input.skills.length > 32 ||
      input.skills.some(
        (skill) =>
          !isRecord(skill) ||
          typeof skill.id !== 'string' ||
          (skill.sourcePath !== undefined && typeof skill.sourcePath !== 'string'),
      ))
  )
    return { ok: false, message: 'skills must contain skill identities and optional source paths.' }
  if ('attachments' in input && input.attachments !== undefined) {
    const parsed = parseImageAttachments(input.attachments)
    if (!parsed.ok) return parsed
    if (parsed.attachments.length > 0) attachments = parsed.attachments
  }
  return {
    ok: true,
    input: {
      ...session.input,
      message: input.message,
      ...(typeof input.localTurnId === 'string' ? { localTurnId: input.localTurnId } : {}),
      ...(attachments ? { attachments } : {}),
      ...(mentions ? { mentions } : {}),
      ...(files?.length ? { files } : {}),
      ...(Array.isArray(input.skills) ? { skills: input.skills as ConversationSendTurnInput['skills'] } : {}),
      ...(typeof input.reasoningEffort === 'string' ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.mode ? { mode: input.mode as ConversationSendTurnInput['mode'] } : {}),
      ...(input.steer === true ? { steer: true } : {}),
    },
  }
}

export function parseSessionIdInput(
  input: unknown,
): { ok: true; input: ConversationInterruptInput } | { ok: false; message: string } {
  if (!isRecord(input) || typeof input.sessionId !== 'string') return { ok: false, message: 'sessionId is required.' }
  if (
    input.commandId !== undefined &&
    (typeof input.commandId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.commandId))
  )
    return { ok: false, message: 'commandId must be a UUID.' }
  return {
    ok: true,
    input: {
      sessionId: input.sessionId,
      ...(typeof input.commandId === 'string' ? { commandId: input.commandId } : {}),
    },
  }
}

// A window built before the preset rename can still send `default`,
// `auto_workspace` or `bypass_all`; parseCliPermissionPreset reads each as the
// preset it meant rather than refusing it.
const PERMISSION_PRESET_ERROR = `permissionPreset must be ${CONVERSATION_PERMISSION_PRESETS.join(' or ')}.`

export function parseSetPermissionInput(
  input: unknown,
): { ok: true; input: ConversationSetPermissionInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const permissionPreset = parseCliPermissionPreset(isRecord(input) ? input.permissionPreset : undefined)
  if (!permissionPreset) return { ok: false, message: PERMISSION_PRESET_ERROR }
  const permissionMode = parseCliPermissionModeId(isRecord(input) ? input.permissionMode : undefined)
  return { ok: true, input: { ...session.input, permissionPreset, ...(permissionMode ? { permissionMode } : {}) } }
}

export function parseSetModelInput(
  input: unknown,
): { ok: true; input: ConversationSetModelInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const modelId = isRecord(input) && typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (!modelId || modelId.length > 200) return { ok: false, message: 'modelId is required.' }
  return { ok: true, input: { ...session.input, modelId } }
}

const MCP_SERVER_ACTIONS: readonly ConversationMcpServerAction[] = ['reconnect', 'enable', 'disable', 'sign-in']

export function parseMcpServerActionInput(
  input: unknown,
): { ok: true; input: ConversationMcpServerActionInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const serverId = isRecord(input) && typeof input.serverId === 'string' ? input.serverId.trim() : ''
  if (!serverId || serverId.length > 200) return { ok: false, message: 'serverId is required.' }
  const action = isRecord(input) ? input.action : undefined
  if (!MCP_SERVER_ACTIONS.includes(action as ConversationMcpServerAction))
    return { ok: false, message: 'action must be reconnect, enable, disable or sign-in.' }
  return {
    ok: true,
    input: { sessionId: session.input.sessionId, serverId, action: action as ConversationMcpServerAction },
  }
}

export function parseStopSubagentInput(
  input: unknown,
): { ok: true; input: ConversationStopSubagentInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const toolUseId = isRecord(input) && typeof input.toolUseId === 'string' ? input.toolUseId.trim() : ''
  if (!toolUseId || toolUseId.length > 200) return { ok: false, message: 'toolUseId is required.' }
  return { ok: true, input: { sessionId: session.input.sessionId, toolUseId } }
}

// A side question is a message's worth of text, and an aside holds a handful
// of them: enough room for a long one pasted in, not for a transcript.
const SIDE_QUESTION_MAX_CHARS = 20_000
const SIDE_ANSWER_MAX_CHARS = 100_000
const SIDE_QUESTION_HISTORY_MAX = 20

function parseSideQuestionRequestId(input: Record<string, unknown>): string | null {
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
  return requestId && requestId.length <= 200 ? requestId : null
}

export function parseSideQuestionInput(
  input: unknown,
): { ok: true; input: ConversationSideQuestionInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const record = input as Record<string, unknown>
  const requestId = parseSideQuestionRequestId(record)
  if (!requestId) return { ok: false, message: 'requestId is required.' }
  const question = typeof record.question === 'string' ? record.question.trim() : ''
  if (!question) return { ok: false, message: 'A side question needs a question.' }
  if (question.length > SIDE_QUESTION_MAX_CHARS) return { ok: false, message: 'That side question is too long.' }
  const history: ConversationSideQuestionExchange[] = []
  if (record.history !== undefined) {
    if (!Array.isArray(record.history) || record.history.length > SIDE_QUESTION_HISTORY_MAX)
      return { ok: false, message: 'history is invalid.' }
    for (const entry of record.history) {
      if (
        !isRecord(entry) ||
        typeof entry.question !== 'string' ||
        typeof entry.answer !== 'string' ||
        entry.question.length > SIDE_QUESTION_MAX_CHARS ||
        entry.answer.length > SIDE_ANSWER_MAX_CHARS
      )
        return { ok: false, message: 'history is invalid.' }
      history.push({ question: entry.question, answer: entry.answer })
    }
  }
  return {
    ok: true,
    input: { sessionId: session.input.sessionId, requestId, question, ...(history.length ? { history } : {}) },
  }
}

export function parseCancelSideQuestionInput(
  input: unknown,
): { ok: true; input: ConversationCancelSideQuestionInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const requestId = parseSideQuestionRequestId(input as Record<string, unknown>)
  if (!requestId) return { ok: false, message: 'requestId is required.' }
  return { ok: true, input: { sessionId: session.input.sessionId, requestId } }
}

export function parseRespondToRequestInput(
  input: unknown,
): { ok: true; input: ConversationRespondToRequestInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isRecord(input) || typeof input.requestId !== 'string') return { ok: false, message: 'requestId is required.' }
  if (typeof input.approved !== 'boolean') return { ok: false, message: 'approved is required.' }
  if (input.decision !== undefined && !['once', 'conversation', 'always', 'deny'].includes(String(input.decision)))
    return { ok: false, message: 'Permission decision is invalid.' }
  let answers: Record<string, string> | undefined
  if ('answers' in input && input.answers !== undefined) {
    if (!isRecord(input.answers) || Object.values(input.answers).some((value) => typeof value !== 'string')) {
      return { ok: false, message: 'answers must map question text to answer strings.' }
    }
    answers = input.answers as Record<string, string>
  }
  return {
    ok: true,
    input: {
      ...session.input,
      requestId: input.requestId,
      approved: input.approved,
      ...(input.decision ? { decision: input.decision as ConversationRespondToRequestInput['decision'] } : {}),
      ...(answers ? { answers } : {}),
    },
  }
}
