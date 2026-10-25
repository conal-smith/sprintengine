import type { ConversationSearchHit, ConversationSearchResult } from '../../shared/conversation-index'

// What a paired desktop's palette finds in this machine's chats: what was
// said, chat by chat, as this machine's own palette searches its own
// (conversationHistoryProvider.ts) — the chats its sidebar lists, most
// recently spoken in first, each one's transcripts through the runtime's own
// search. One answer for the whole question, bounded so a far machine's
// answer stays one tool call: so many chats with a match, so many matches of
// each, and a time past which the answer says it stopped early.

/** The most chats one answer names, as this machine's palette lists at most. */
export const CHAT_SEARCH_CHAT_LIMIT = 50
/** The most matches each chat carries: its row shows the best and counts the rest. */
export const CHAT_SEARCH_HIT_LIMIT = 20
/** How long one answer reads before it says it stopped early. */
export const CHAT_SEARCH_BUDGET_MS = 8_000
/** A question past this is not one a person typed into a palette. */
export const CHAT_SEARCH_MAX_QUERY = 200

export type SearchableChatHere = { workspaceId: string; workspaceRoot: string; chatTitle: string }

export type ChatSearchAnswer = {
  chats: Array<{ workspaceId: string; chatTitle: string; hits: ConversationSearchHit[]; count: number }>
  /** The answer stopped early, at the limit or the time; a narrower question finds the rest. */
  truncated: boolean
}

export async function searchChatsHere(
  query: string,
  deps: {
    /** The chats the sidebar lists, in its order: settled ones left out. */
    chats(): readonly SearchableChatHere[]
    search(input: { workspaceRoot: string; workspaceId: string; query: string }): Promise<ConversationSearchResult>
    now?: () => number
    budgetMs?: number
  },
): Promise<ChatSearchAnswer> {
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.budgetMs ?? CHAT_SEARCH_BUDGET_MS)
  const answer: ChatSearchAnswer = { chats: [], truncated: false }
  for (const chat of deps.chats()) {
    if (answer.chats.length >= CHAT_SEARCH_CHAT_LIMIT || now() > deadline) {
      answer.truncated = true
      break
    }
    const found = await deps
      .search({ workspaceRoot: chat.workspaceRoot, workspaceId: chat.workspaceId, query })
      .catch(() => null)
    // One chat whose history cannot be read costs its own matches only.
    if (!found?.ok || found.hits.length === 0) continue
    answer.chats.push({
      workspaceId: chat.workspaceId,
      chatTitle: chat.chatTitle,
      hits: found.hits.slice(0, CHAT_SEARCH_HIT_LIMIT),
      count: found.hits.length,
    })
  }
  return answer
}
