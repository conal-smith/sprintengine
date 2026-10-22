import type { ChatLink } from '../../../../../shared/deep-link'

// What a window does with a `sprintengine://chat/…` link main handed it
// (main/chat-link-router.ts picked the window): select the chat, and bring the
// named agent's tab forward when the chat has that agent. Nothing else — no
// agent starts, nothing is typed or sent.
//
// A chat this window's store does not have may run on a paired machine, linked
// by its id there, and is opened as its sidebar row opens it. Otherwise it was
// closed, or lives on a machine this one does not follow, and the person is
// told so rather than left wondering whether the click reached the app. A workspace the rail hides (a module's background
// host) is not a chat anyone links to, and is answered the same way: opening
// one would leave the person somewhere the rail cannot take them back from.
//
// Main sends the link to the window that holds the chat. One filed under a
// window that is not open is moved here, as "Move to Main Window" would.
//
// Store-free, so every path is tested without a window: WorkspaceManager hands
// in the reads and writes.

export type ChatLinkOpenerDeps = {
  /** The chat, when this window's store has one the rail lists; null otherwise. */
  getChat: (chatId: string) => { agents: Record<string, { name: string }> } | null
  /** The window the store files the chat under, if any. */
  holderOf: (chatId: string) => string | null
  /** This window's workspace-window id. */
  windowId: string
  moveHere: (chatId: string, fromWindowId: string | null) => void
  /** What a click on the chat's sidebar row does. */
  select: (chatId: string) => void
  revealAgent: (chatId: string, agentId: string, name: string) => void
  /**
   * A chat a paired machine runs, linked by its id there: opened here as
   * its sidebar row opens it. True when one was.
   */
  openRemote?: (chatId: string) => boolean
  notOnThisMachine: () => void
}

/** True when the chat was opened. */
export function openChatLink(link: ChatLink, deps: ChatLinkOpenerDeps): boolean {
  const chat = deps.getChat(link.chatId)
  if (!chat) {
    if (deps.openRemote?.(link.chatId)) return true
    deps.notOnThisMachine()
    return false
  }
  const holder = deps.holderOf(link.chatId)
  if (holder !== deps.windowId) deps.moveHere(link.chatId, holder)
  deps.select(link.chatId)
  // An agent the chat no longer has (closed since the link was copied) still
  // lands on the chat, as it was left.
  const agent = link.agentId ? chat.agents[link.agentId] : undefined
  if (link.agentId && agent) deps.revealAgent(link.chatId, link.agentId, agent.name)
  return true
}
