import { AGENT_BRANCH_PREFIX } from '../shared/worktree-branch'

/**
 * The worktree branch prefix this process names and recognises Studio's
 * branches by (Settings ▸ Worktrees; `shared/worktree-branch.ts`).
 *
 * The prefix lives in the launch settings, and the core that holds them
 * installs the reader once (`studio-core.ts`), in the desktop's main process and
 * in a server out of process alike. Read on every use, never kept: a change in
 * Settings names the next worktree, and the cleanup after it recognises the
 * new prefix. Until something installs a reader, and when the reader throws,
 * the answer is `agent`, which is what Studio always named its branches.
 */
let read: (() => string) | null = null

export function setWorktreeBranchPrefixReader(next: (() => string) | null): void {
  read = next
}

export function worktreeBranchPrefix(): string {
  try {
    return read?.() ?? AGENT_BRANCH_PREFIX
  } catch {
    return AGENT_BRANCH_PREFIX
  }
}
