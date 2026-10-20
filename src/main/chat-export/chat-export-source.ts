import { parseStoredAttachments } from '../../../packages/conversation-timeline/src/conversationProjection'
import type {
  ConversationAttachmentResult,
  ConversationEvent,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
} from '../../shared/conversation-runtime'

// What an export is read from: the chat's whole transcript, through the
// reader the chat view's own pages come from (the conversation runtime's
// transcript reader), and the pictures its messages attached, through the
// attachment store the view reads them back from. It is read where the chats
// are: here when they run in this process, in the Studio server when that has
// a process of its own (`conversations.export-source`), which hands this
// object back over its control channel.

export type ChatExportReader = {
  readTranscript(input: ConversationTranscriptInput, options: { all: true }): Promise<ConversationTranscriptResult>
  readAttachment(ref: unknown): Promise<ConversationAttachmentResult>
}

/** The source as it crosses a process boundary: the pictures as base64, by their store reference. */
export type ChatExportSourceWire = {
  events: ConversationEvent[]
  attachments: Record<string, { mediaType: string; dataBase64: string }>
}

/** More pictures than any chat a person would send is a transcript gone wrong; the rest are named, not drawn. */
const MAX_ATTACHMENTS = 200

export async function readChatExportSource(
  reader: ChatExportReader,
  key: ConversationTranscriptInput,
): Promise<{ ok: true; source: ChatExportSourceWire } | { ok: false; message: string }> {
  const transcript = await reader.readTranscript(key, { all: true })
  if (!transcript.ok) return transcript
  const refs = new Set<string>()
  for (const event of transcript.events) {
    if (event.type !== 'user_message') continue
    for (const attachment of parseStoredAttachments(event.payload?.attachments) ?? []) {
      if (refs.size < MAX_ATTACHMENTS) refs.add(attachment.ref)
    }
  }
  const attachments: ChatExportSourceWire['attachments'] = {}
  for (const ref of refs) {
    const read = await reader.readAttachment(ref).catch(() => null)
    if (read?.ok) attachments[ref] = { mediaType: read.mediaType, dataBase64: read.dataBase64 }
  }
  return { ok: true, source: { events: transcript.events, attachments } }
}

/** A source handed back over the control channel, checked for shape before it is trusted. */
export function parseChatExportSourceWire(value: unknown): ChatExportSourceWire | null {
  if (!value || typeof value !== 'object') return null
  const { events, attachments } = value as Record<string, unknown>
  if (!Array.isArray(events) || !attachments || typeof attachments !== 'object') return null
  const pictures: ChatExportSourceWire['attachments'] = {}
  for (const [ref, picture] of Object.entries(attachments as Record<string, unknown>)) {
    const { mediaType, dataBase64 } = (picture ?? {}) as Record<string, unknown>
    if (typeof mediaType === 'string' && typeof dataBase64 === 'string') pictures[ref] = { mediaType, dataBase64 }
  }
  return { events: events as ConversationEvent[], attachments: pictures }
}
