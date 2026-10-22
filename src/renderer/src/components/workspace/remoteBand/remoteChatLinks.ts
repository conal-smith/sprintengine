import {
  conversationsOf,
  openSpecOfConversation,
  type RemoteMachineGroup,
  type RemoteSessionOpenSpec,
} from './remoteSessionsModel'

// A `sprintengine://chat/<id>` link to a chat on a paired machine names it by
// its id on that machine (the row menu's Copy link to chat), so one link opens
// the chat there, where it is a chat of that machine's own, and on every
// machine that follows it. Only the sidebar reads the paired machines' lists,
// so it says here which chats they hold, and the window a link is handed to
// opens one from that (`chatLinkOpener.ts`'s `openRemote`).

let targets: ReadonlyMap<string, RemoteSessionOpenSpec> = new Map()

/** The chats the paired machines list now, by their id there. */
export function publishRemoteChatLinkTargets(groups: readonly RemoteMachineGroup[]): void {
  const next = new Map<string, RemoteSessionOpenSpec>()
  for (const group of groups)
    for (const conversation of conversationsOf(group))
      if (!next.has(conversation.workspaceId)) next.set(conversation.workspaceId, openSpecOfConversation(conversation))
  targets = next
}

/** What opening a linked chat on a paired machine asks, or null for a chat none of them lists. */
export function remoteChatLinkTarget(chatId: string): RemoteSessionOpenSpec | null {
  return targets.get(chatId) ?? null
}
