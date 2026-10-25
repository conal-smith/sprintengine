import { requestConversationJump } from '../../../utils/conversationHistoryNavigation'

// What the palette needs to find what was said in the paired machines' chats
// and open a match where it was said. Only the sidebar reads those machines,
// so it says which of them take a search from here (`chat-search`), and the
// window's manager says how one of their chats is opened here, as its sidebar
// row opens it (`registerRemoteChatOpener`). The palette asks each machine
// itself (`meshConversationSearch`).

export type RemoteSearchMachine = { connectionId: string; machineName: string }

let machines: readonly RemoteSearchMachine[] = []

/** The paired machines whose chats the palette may search from here now. */
export function publishRemoteSearchMachines(next: readonly RemoteSearchMachine[]): void {
  machines = next
}

export function remoteSearchMachines(): readonly RemoteSearchMachine[] {
  return machines
}

/** A paired machine's chat by its ids there; answers the workspace here whose pane follows it, or null. */
type RemoteChatOpener = (target: { connectionId: string; workspaceId: string; agentId: string }) => string | null

let opener: RemoteChatOpener | null = null

/** The window's way to open a paired machine's chat; the returned call takes it back. */
export function registerRemoteChatOpener(next: RemoteChatOpener): () => void {
  opener = next
  return () => {
    if (opener === next) opener = null
  }
}

/**
 * Open a paired machine's chat at a message the palette found in it: its pane
 * here, and the jump a chat here takes to a match (`useConversationSearchJump`),
 * which pages back to the message as it would in a chat here. False when the
 * chat could not be opened.
 */
export function openRemoteChatAtMatch(match: {
  connectionId: string
  workspaceId: string
  agentId: string
  seq: number
}): boolean {
  const here = opener?.(match) ?? null
  if (!here) return false
  requestConversationJump(here, match.agentId, match.seq)
  return true
}
