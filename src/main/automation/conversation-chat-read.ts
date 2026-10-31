import type { ConversationEvent } from '../../shared/conversation-runtime'
import { buildChatExportDocument } from '../chat-export/chat-export-document'
import { writeExportMessageMarkdown } from '../chat-export/chat-export-markdown'

// What conversation.read answers with (conversation-chat-tools.ts): a page of
// a chat as Export chat writes it, the words alone, inside a budget. Kept
// apart from the tools so the export's Markdown parser loads with a read, not
// with every process that lists them (the server bundle checks its
// dependencies at start, before anything else is loaded).

/** The end of a text, at most `chars` long, cut at a line where one is near. */
export function tailOf(text: string, chars: number): string {
  if (text.length <= chars) return text
  const cut = text.slice(text.length - chars)
  const newline = cut.indexOf('\n')
  return newline >= 0 && newline < chars / 4 ? cut.slice(newline + 1) : cut
}

/**
 * The words of a page of a chat, oldest first, inside `maxChars`: the newest
 * messages are kept whole while they fit, then the one that does not is cut
 * to its end, and older ones are left out and counted.
 */
export function chatMessagesOf(
  events: readonly ConversationEvent[],
  maxChars: number,
): { messages: Array<{ from: 'person' | 'agent'; at?: number; text: string; cut?: true }>; omitted: number } {
  const document = buildChatExportDocument(
    { events, attachments: new Map() },
    {
      title: '',
      project: null,
      engine: null,
      model: null,
      workspaceRoot: null,
      exportedAt: 0,
      locale: 'en-US',
      timeZone: 'UTC',
      messagesOnly: true,
    },
  )
  const all = document.messages.map((message) => ({
    from: message.kind === 'user' ? ('person' as const) : ('agent' as const),
    ...(message.at !== undefined ? { at: message.at } : {}),
    text: writeExportMessageMarkdown(message).trim(),
  }))
  const kept: Array<{ from: 'person' | 'agent'; at?: number; text: string; cut?: true }> = []
  let budget = maxChars
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index]!
    if (message.text.length <= budget) {
      kept.unshift(message)
      budget -= message.text.length
      continue
    }
    if (budget >= 200 || kept.length === 0) kept.unshift({ ...message, text: tailOf(message.text, budget), cut: true })
    return { messages: kept, omitted: index + (kept[0]?.cut ? 0 : 1) }
  }
  return { messages: kept, omitted: 0 }
}
