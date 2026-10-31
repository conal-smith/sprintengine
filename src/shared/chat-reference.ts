import { chatLinkFor } from './deep-link'

// A chat dragged from the sidebar into a composer lands as a reference to it:
// a Markdown link whose text is the chat's title and whose address is the
// chat's link (`chatLinkFor`). The composer's live preview draws it as a link,
// the person's message shows it as one, and the agent reading the message
// finds the chat's id in the address, which `conversation.read` takes as its
// `workspaceId`. It is words in the message, so it needs nothing of the
// protocol, and a client that has never heard of it shows a link.

/** The MIME type a sidebar chat's drag carries its reference under, beside `text/plain`. */
export const CHAT_REFERENCE_MIME = 'application/x-sprintengine-chat-reference'

const MAX_TITLE = 80

/** The Markdown reference to a chat on this machine, or null when its id cannot be linked. */
export function chatReferenceMarkdown(title: string, chatId: string): string | null {
  const link = chatLinkFor(chatId)
  if (!link) return null
  const words = title.replace(/\s+/gu, ' ').trim() || 'Untitled chat'
  const cut = words.length > MAX_TITLE ? `${words.slice(0, MAX_TITLE - 1)}…` : words
  // Brackets and backslashes in a title would end the link's text early.
  return `[${cut.replace(/[\\[\]]/gu, '\\$&')}](${link})`
}

/**
 * Puts a chat's reference on a drag, so a composer the drag is dropped on
 * types it where it lands. A chat on a paired machine is not one this
 * machine's agents can read, so it carries none.
 */
export function setChatReferenceDragData(
  transfer: Pick<DataTransfer, 'setData'>,
  chat: { id: string; name: string; remote: boolean },
): boolean {
  if (chat.remote) return false
  const reference = chatReferenceMarkdown(chat.name, chat.id)
  if (!reference) return false
  transfer.setData(CHAT_REFERENCE_MIME, chat.id)
  transfer.setData('text/plain', reference)
  return true
}
