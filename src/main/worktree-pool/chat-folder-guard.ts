import type { GitWorktreeRestoreInput, GitWorktreeRestoreResult } from '../../shared/ipc/git'
import { comparablePath } from '../../shared/host-paths'
import { repoRootFromWorktreePath } from '../../shared/worktree-paths'
import type { WorktreePoolService } from './worktree-pool-service'

/** A chat as the guard reads it off the workspace registry. */
export type GuardedChat = {
  folderPath?: string | null
  worktree?: { branch?: string; repoRoot?: string } | null
  environment?: unknown
  remoteOrigin?: unknown
}

export type ChatFolderGuardDeps = {
  /** The pool this process keeps, or null (git.ts `activeWorktreePool`). */
  pool: () => Pick<WorktreePoolService, 'load' | 'awaitsChat'> | null
  chat: (workspaceId: string) => GuardedChat | null | undefined
  /** git.ts `restoreGitWorktree`: the pool's `reclaim` first, a plain worktree at the path failing that. */
  restore: (input: GitWorktreeRestoreInput) => Promise<GitWorktreeRestoreResult>
}

export type ChatFolderGuard = (input: {
  workspaceId: string
  workspaceRoot: string
}) => Promise<{ ok: true } | { ok: false; message: string }>

/**
 * The last word before an agent runs in a chat's folder, asked by main's
 * conversation runtime for every session start and every turn, whoever sent
 * it: a window, a paired phone, a schedule, another agent. A worktree chat
 * whose pool slot was given back while it sat idle (pool-idle.ts) gets its
 * branch checked out again at the same path first, so the agent's CLI finds
 * its session where it keyed it (Claude Code by folder, a Codex thread by its
 * cwd) and works on its own branch, never on a detached or borrowed tree. The
 * chat view asks the same of the renderer's `ensureChatWorktree` before a
 * turn; this covers the senders that have no view.
 *
 * In memory unless something was given back (`awaitsChat`), so a turn in a
 * chat whose worktree is where it should be costs nothing. Refused, the turn
 * is refused with the reason, as the view refuses it.
 */
export function createChatFolderGuard(deps: ChatFolderGuardDeps): ChatFolderGuard {
  return async ({ workspaceId, workspaceRoot }) => {
    const pool = deps.pool()
    if (!pool) return { ok: true }
    const chat = deps.chat(workspaceId)
    const branch = chat?.worktree?.branch
    const folder = chat?.folderPath
    // A chat on another machine has its folder there; one opened on a plain
    // folder, or running somewhere other than its own folder (a run's
    // worktree), is not the pool's to bring back.
    if (!chat || !folder || !branch || chat.environment || chat.remoteOrigin) return { ok: true }
    if (comparablePath(folder) !== comparablePath(workspaceRoot)) return { ok: true }
    await pool.load()
    if (!pool.awaitsChat(folder, branch)) return { ok: true }
    const repoRoot = chat.worktree?.repoRoot?.trim() || repoRootFromWorktreePath(folder)
    if (!repoRoot) {
      return { ok: false, message: `No project is recorded for ${folder}, so its worktree cannot come back.` }
    }
    const restored = await deps
      .restore({ repoRoot, path: folder, branchName: branch, copyIncludedFiles: true, agentLockOwner: branch })
      .catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }))
    return restored.ok
      ? { ok: true }
      : { ok: false, message: `This chat’s worktree could not be brought back: ${restored.message}` }
  }
}
