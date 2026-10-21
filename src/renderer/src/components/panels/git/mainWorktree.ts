import { samePath } from '../../../utils/paths'

/**
 * Which entry of `git worktree list` is the project's main checkout, and the
 * linked worktrees beside it.
 *
 * Matched by path first. A repository made with `git init --separate-git-dir`
 * is the case where no path matches: git names its git folder (`store.git`)
 * as the main worktree rather than the work tree the panel resolved. Git always
 * lists the main worktree first, so with no match the first entry is taken as
 * the main one — otherwise the git folder showed up as a second worktree scope
 * and the main scope lost its branch.
 */
export function splitMainWorktree<T extends { path: string }>(
  worktrees: readonly T[],
  mainRepoRoot: string,
): { main: T | null; linked: T[] } {
  const main = worktrees.find((worktree) => samePath(worktree.path, mainRepoRoot)) ?? worktrees[0] ?? null
  return { main, linked: worktrees.filter((worktree) => worktree !== main) }
}
