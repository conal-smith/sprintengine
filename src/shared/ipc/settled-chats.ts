// Part of the IPC contract: deleting settled chats, from Settings ▸ Settled
// chats and from a settled chat's row menu. ../electron-api.ts re-exports
// everything here.
//
// Main does the deleting (src/main/settled-chat-deletion.ts): it holds the
// chat's record, its transcripts and the worktree pool. A window asks first
// what a delete would do (`planSettledChatDeletion`), shows that in its
// confirmation, and then asks for the delete itself, which checks everything
// again: a worktree written to between the two is kept, not taken.

/** Why a chat's worktree stays when the chat is deleted. */
export type SettledChatWorktreeKeptBecause =
  /** Uncommitted or untracked changes: removing the folder would lose them. */
  | 'changes'
  /** Another chat works in it, or in a folder inside it. */
  | 'shared'
  /** Neither a pool slot nor in Studio's worktree folder: someone else made it. */
  | 'not-made-here'
  /** It is on another machine (an SSH machine or a WSL distribution). */
  | 'other-machine'
  /** Its status could not be read, so nothing is known to be safe. */
  | 'unreadable'

export type SettledChatWorktreePlan = {
  path: string
  /** The folder's own name, which is how Settings ▸ Worktrees lists it. */
  name: string
  branch: string | null
  /** A worktree pool slot: it goes back to the pool rather than off the disk. */
  pooled: boolean
  /** Changed, staged and untracked paths; null when not read. */
  changedPaths: number | null
  /** Commits HEAD has that no remote branch (and no other local branch) has; null when not read. */
  unpushedCommits: number | null
  /** What the delete would do with it, as things stand now. */
  fate: 'remove' | 'keep'
  keptBecause?: SettledChatWorktreeKeptBecause
}

export type SettledChatDeletionPlan = {
  workspaceId: string
  /**
   * The paired machine the chat lives on, for one opened here from there.
   * Deleting it takes this computer's record only; the chat, its history and
   * its worktree stay on that machine.
   */
  remoteMachine: string | null
  worktrees: SettledChatWorktreePlan[]
  /** Why it cannot be deleted now (not settled, working, gone). Absent when it can. */
  refused?: string
}

export type SettledChatWorktreeOutcome = {
  path: string
  name: string
  branch: string | null
  /** `removed`: off the disk; `returned`: back in the pool, detached; `kept`: still there. */
  result: 'removed' | 'returned' | 'kept'
  /** Why it was kept, in a sentence. */
  detail?: string
}

export type SettledChatDeletionOutcome =
  | { workspaceId: string; ok: true; worktrees: SettledChatWorktreeOutcome[] }
  | { workspaceId: string; ok: false; message: string }
