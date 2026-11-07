import type { ConversationEvent } from '../../shared/conversation-runtime'
import { buildChatExportDocument, type ChatExportDocument, type ChatExportMeta } from './chat-export-document'
import { writeChatExportMarkdown } from './chat-export-markdown'

// What a handoff gives a new session in place of the old one
// (ConversationRuntime.handoffConversation): the chat as Export chat writes it
// to Markdown, the words alone. The person's messages, the replies' prose, and
// the questions and plans the person answered; never a step, its output, or
// an agent the turn sent off. The new session has the project in front of it
// and reads whatever it needs; what it cannot get back by itself is what was
// said.
//
// The file is read by the agent, not a person, so it opens by saying what it
// is, and says so when it is not the whole conversation: a transcript longer
// than the reader's budget comes back as its newest part.

/** What the file says about itself under the title. */
const HANDOFF_INTRO =
  'This is the text of an earlier session of this conversation, handed off to a new session to save cost: ' +
  'the messages only, without the tool calls or what they returned.'

const TRUNCATED_NOTE =
  'The conversation was too long to keep whole, so this file holds its most recent part. ' +
  'The earliest messages are not in it.'

export type HandoffMarkdown = {
  markdown: string
  /** How many messages it holds, the person's and the agent's. */
  messages: number
  /** Whether it leaves the oldest of them out. */
  truncated: boolean
}

/**
 * The handoff file's text. `truncated` says the events are already the newest
 * part of a longer transcript; `maxBytes` bounds the file, dropping the oldest
 * messages until it fits.
 */
export function writeHandoffMarkdown(
  events: readonly ConversationEvent[],
  meta: Omit<ChatExportMeta, 'messagesOnly'>,
  options: { truncated: boolean; maxBytes: number; intro?: string },
): HandoffMarkdown {
  const document = buildChatExportDocument({ events, attachments: new Map() }, { ...meta, messagesOnly: true })
  let messages = document.messages
  let truncated = options.truncated
  for (;;) {
    const markdown = render({ ...document, messages }, truncated, options.intro ?? HANDOFF_INTRO)
    if (Buffer.byteLength(markdown) <= options.maxBytes || messages.length <= 1)
      return { markdown, messages: messages.length, truncated }
    // A tenth at a time, so a long chat is cut in a few passes, not thousands.
    messages = messages.slice(Math.max(1, Math.floor(messages.length / 10)))
    truncated = true
  }
}

function render(document: ChatExportDocument, truncated: boolean, intro: string): string {
  const { markdown } = writeChatExportMarkdown(document, null)
  const lead = [intro, ...(truncated ? [`**${TRUNCATED_NOTE}**`] : [])].join('\n\n')
  const titleEnd = markdown.indexOf('\n\n')
  return titleEnd < 0
    ? `${markdown.trimEnd()}\n\n${lead}\n`
    : `${markdown.slice(0, titleEnd)}\n\n${lead}${markdown.slice(titleEnd)}`
}
