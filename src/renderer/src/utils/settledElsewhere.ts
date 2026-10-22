// Chats that came to rest through a registry change this window did not
// make: a paired phone or desktop settled one (`conversation.settle`), or
// another window here did.
//
// A Settle is more than its record. A resting chat holds no processes (owner
// ruling 2026-09-07), and the chat you are in hands you on to the next one; the
// sidebar does both for a Settle made in it. One that arrives from elsewhere
// lands in the store as a field patch, which says nothing about either, so the
// store's inbound path notes it here and the sidebar carries out the rest
// (`settledElsewhere` in WorkspaceSidebar). Held until the sidebar takes it,
// so a note made before it mounts is not lost.

// A Snooze is more than its record in the same way: a sleeping chat holds no
// processes either (they are paused, to be resumed on the next keystroke), so
// one snoozed from a paired desktop is noted beside the settles, and the
// sidebar pauses it as its own Snooze does.

const pending = new Set<string>()
const pendingSnoozes = new Set<string>()
const listeners = new Set<() => void>()

/** A chat moved from in the list to resting through a patch from elsewhere. */
export function noteWorkspaceSettledElsewhere(workspaceId: string): void {
  pending.add(workspaceId)
  for (const listener of [...listeners]) listener()
}

/** The chats noted since the last take, each once. */
export function takeWorkspacesSettledElsewhere(): string[] {
  const taken = [...pending]
  pending.clear()
  return taken
}

/** Called after each note. Returns the unsubscribe. */
export function onWorkspaceSettledElsewhere(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A chat that went to sleep through a patch from elsewhere. */
export function noteWorkspaceSnoozedElsewhere(workspaceId: string): void {
  pendingSnoozes.add(workspaceId)
  for (const listener of [...listeners]) listener()
}

/** The snoozed chats noted since the last take, each once. */
export function takeWorkspacesSnoozedElsewhere(): string[] {
  const taken = [...pendingSnoozes]
  pendingSnoozes.clear()
  return taken
}
