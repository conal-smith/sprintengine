import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import type { TerminalSessionSnapshot } from '../../../../../shared/ipc/terminal'
import type { Activity } from './rowStyle'
import { combinedAgentActivity, workspaceIsWorking } from './conversationLines'

// The Working section (a Settings ▸ Appearance switch, off by default): chats
// whose agent is at work fold out of their project, or out of the All chats
// stream, into one section at the top of the list, and go back to their seat
// the moment the agent finishes or stops on the person.
//
// Rows otherwise never move on their own (owner ruling 2026-09-09: a finishing
// or blocked agent tints its row but never moves it). This is the one exception,
// and it is the person's to turn on. It moves a row between two places and
// nowhere else: inside the section, and back in its project, rows keep the
// order they always have, by the person's last message.
//
// Starred chats stay in Starred: the person put them there. The chat open in
// front stays where it is, as it does for Settle and Snooze, so a row never
// slides out from under the person reading it. A chat waiting on the person,
// or whose turn failed, is not working: it goes back, where its tint says so.

export type WorkingSectionSources = {
  activity: Activity
  conversations: readonly ConversationSessionSummary[]
  terminals: readonly TerminalSessionSnapshot[]
}

/** Whether a chat sits in the Working section now. */
export function inWorkingSection(chat: { starred: boolean; front: boolean }, sources: WorkingSectionSources): boolean {
  if (chat.starred || chat.front) return false
  const shown = combinedAgentActivity(sources.activity, sources.conversations)
  if (shown === 'needs-input' || shown === 'failed') return false
  return workspaceIsWorking(sources.activity, sources.conversations, sources.terminals)
}
