// Export chat: a chat tab's whole conversation written out as a file the
// person can send (PDF, Word, Markdown), or put on the clipboard to paste into
// an email. The window names the chat and what to make of it, nothing else;
// main reads the transcript, asks where to save, and writes.

import type { ConversationEvent } from './conversation-runtime'

export const CHAT_EXPORT_CHANNEL = 'chat-export:run'

/** The files a chat is exported as. */
export const CHAT_EXPORT_FILE_FORMATS = ['pdf', 'docx', 'markdown'] as const
export type ChatExportFileFormat = (typeof CHAT_EXPORT_FILE_FORMATS)[number]

/**
 * What to make of the chat: one of the files, or the clipboard. `copy` puts
 * the chat on it twice, as Markdown text and as formatted HTML, and the app the
 * paste lands in picks; `copy-markdown` puts the Markdown alone.
 */
export const CHAT_EXPORT_ACTIONS = [...CHAT_EXPORT_FILE_FORMATS, 'copy', 'copy-markdown'] as const
export type ChatExportAction = (typeof CHAT_EXPORT_ACTIONS)[number]

/**
 * A chat followed from a paired machine, whose transcript is kept on that
 * machine and not here: the window following it reads the whole of it from
 * there (`loadEarlier` back to the first page) and hands it over with what the
 * machine lists about the chat. The pictures its messages attached stay over
 * there, and are named rather than drawn.
 */
export type ChatExportRemoteSource = {
  events: ConversationEvent[]
  title: string
  project: string | null
  providerId: string | null
  modelId: string | null
  /** The chat's folder on that machine, which its steps' paths are read against. */
  workspaceRoot: string
}

export type ChatExportInput = {
  workspaceId: string
  agentId: string
  action: ChatExportAction
  remote?: ChatExportRemoteSource
}

export type ChatExportResult =
  | { ok: true; kind: 'saved'; path: string; fileName: string }
  /** The person dismissed the save dialog: nothing was written, and nothing needs saying. */
  | { ok: true; kind: 'cancelled' }
  | { ok: true; kind: 'copied' }
  | { ok: false; message: string }

export function isChatExportAction(value: unknown): value is ChatExportAction {
  return typeof value === 'string' && (CHAT_EXPORT_ACTIONS as readonly string[]).includes(value)
}

/** The input as the boundary accepts it, keeping only what it knows, or what is wrong with it. */
export function parseChatExportInput(
  input: unknown,
): { ok: true; input: ChatExportInput } | { ok: false; message: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, message: 'Export input must be an object.' }
  const { workspaceId, agentId, action } = input as Record<string, unknown>
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 256)
    return { ok: false, message: 'A workspace id is required.' }
  if (typeof agentId !== 'string' || !agentId.trim() || agentId.length > 256)
    return { ok: false, message: 'A chat id is required.' }
  if (!isChatExportAction(action)) return { ok: false, message: 'That is not a format a chat exports as.' }
  return { ok: true, input: { workspaceId, agentId, action } }
}
