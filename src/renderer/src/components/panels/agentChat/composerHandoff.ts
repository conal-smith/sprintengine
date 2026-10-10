import { useWorkspaceStore } from '../../../store/workspaceStore'
import { composerDraftStore } from './draftStore'
import { mountedChatViewFor } from './mountedChatViews'
import { insertQuoteIntoDraft } from './quoteSelection'

// A quote handed to a workspace's chat from somewhere else in the app (the
// diff viewer's "Add to chat", in this window or another): set into that
// chat's composer the way its own quote shortcut sets one.
//
// The chat drawn in this window takes it in its composer, at its caret, with
// the keyboard put there. One that is not drawn has it set into its saved
// draft, after whatever is there, and finds it when it is opened. Answers the
// agent that took it, or null when the workspace has no chat here.

/**
 * The chat in the workspace the quote should land in, among its agents a
 * conversation runs in: the one drawn here with the keyboard in it, else the
 * one drawn here, else the one the workspace last worked with
 * (`lastActiveAgentId`), else the first. A workspace with several chats is
 * rare, and the quote going to one the person is not looking at is the
 * mistake this order is there to avoid.
 */
function chatAgentOf(workspaceId: string): string | null {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  const chats = Object.entries(workspace?.agents ?? {})
    .filter(([, agent]) => agent.conversation)
    .map(([agentId]) => agentId)
  if (chats.length <= 1) return chats[0] ?? null
  const drawn = chats.map((agentId) => mountedChatViewFor(workspaceId, agentId)).filter((view) => view !== null)
  const focused = drawn.find((view) => view.isFocused())
  if (focused?.agentId) return focused.agentId
  if (drawn[0]?.agentId) return drawn[0].agentId
  const last = workspace?.lastActiveAgentId
  if (last && chats.includes(last)) return last
  return chats[0]!
}

export function deliverQuoteToWorkspaceChat(workspaceId: string, text: string): string | null {
  if (!text.trim()) return null
  const agentId = chatAgentOf(workspaceId)
  if (!agentId) return null
  const view = mountedChatViewFor(workspaceId, agentId)
  if (view?.insertQuote) {
    view.insertQuote(text)
    return agentId
  }
  const drafts = composerDraftStore().getState()
  const draft = drafts.read(workspaceId, agentId)
  const next = insertQuoteIntoDraft(draft.text, text, draft.text.length)
  drafts.put(workspaceId, agentId, { ...draft, text: next.text })
  return agentId
}

/**
 * A workspace window's answer to the diff window's "Add to chat" (main's
 * `window:diff-to-chat`): take it when this window holds the workspace and
 * the workspace has a chat, bring that chat forward, and ack. Silence is the
 * refusal: main then asks the next window, and the diff window says nobody
 * took it when none does. The ack is the last thing, and only on the path
 * that set the quote into a composer.
 */
export function answerDiffToChat(
  request: { requestId: string; workspaceId: string; text: string },
  windowId: string,
  ack: (requestId: string) => void,
): boolean {
  const state = useWorkspaceStore.getState()
  if (!state.workspaces.some((workspace) => workspace.id === request.workspaceId)) return false
  // An unregistered window list (the single-window default) holds everything.
  const held = state.workspaceWindows.find((entry) => entry.id === windowId)?.workspaceIds
  if (held && !held.includes(request.workspaceId)) return false
  if (!deliverQuoteToWorkspaceChat(request.workspaceId, request.text)) return false
  state.setActiveWorkspaceForWindow(windowId, request.workspaceId)
  ack(request.requestId)
  return true
}
