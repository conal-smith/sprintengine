import type { ConversationKey } from './conversation-runtime'

export type ConversationWorkspaceKey = Pick<ConversationKey, 'workspaceRoot' | 'workspaceId'>
export type ConversationThread = {
  agentId: string
  title: string
  titleSource: 'first-message' | 'generated' | 'user'
  createdAt: number
  updatedAt: number
  turnCount: number
  model: string
  providerId: string
  lastSeq: number
  firstUserText: string
  totalCostUsd?: number
  // When the agent last finished a turn, or failed one, read off the
  // transcript's own events. Absent for a chat whose agent has not finished
  // one. Not `updatedAt`, which every event moves.
  lastTurnEndedAt?: number
  // The opening of the agent's last reply, as the runtime's session keeps it
  // (`lastAssistantText`): the sidebar's preview for a chat no session holds.
  // Empty once the person has written again, until the agent answers.
  lastAssistantText?: string
}
export type ConversationSearchInput = ConversationWorkspaceKey & { query: string; requestId?: string }
export type ConversationSearchHit = {
  agentId: string
  seq: number
  turnId?: string
  snippet: string
  // Who said the matching words: the person, the agent, or Studio (a message
  // the app sent the chat on the person's behalf). Absent from a host that
  // predates it.
  from?: 'person' | 'agent' | 'studio'
}
export type ConversationRenameInput = ConversationKey & { title: string }
export type ConversationThreadsResult = { ok: true; threads: ConversationThread[] } | { ok: false; message: string }
export type ConversationSearchResult = { ok: true; hits: ConversationSearchHit[] } | { ok: false; message: string }
