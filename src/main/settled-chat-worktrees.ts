import { pathExists } from './git-utils'
import type { SettledChatWorktreeOps } from './settled-chat-deletion'
import { defaultSlotGitRunner, readSlotStatus, type SlotGitRunner } from './worktree-pool/slot-git'
import type { WorktreePoolService } from './worktree-pool/worktree-pool-service'
import type { createWorktreeInventory } from './worktree-pool/worktree-inventory'

/**
 * A deleted chat's worktree, as this machine's git and worktree pool see it
 * (settled-chat-deletion.ts decides what to do with it; this does it).
 *
 * The removal of a worktree the pool does not own is Settings ▸ Worktrees'
 * own Remove (`removeOther`): it keeps a worktree something works in, one with
 * uncommitted changes, commits no branch holds, edits git status does not
 * show, or ignored files that may be someone's work, and git checks again as
 * it removes. A pool slot is given back to the pool as a closed New chat's is:
 * detached when clean, held with its changes otherwise.
 */
export function createSettledChatWorktreeOps(deps: {
  pool: Pick<WorktreePoolService, 'load' | 'ownsPath' | 'leaseAt' | 'release'> | null
  inventory: Pick<ReturnType<typeof createWorktreeInventory>, 'removeOther'>
  git?: SlotGitRunner
  exists?: (path: string) => Promise<boolean>
}): SettledChatWorktreeOps {
  const git = deps.git ?? defaultSlotGitRunner
  return {
    async isPoolSlot(path) {
      if (!deps.pool) return false
      await deps.pool.load()
      return deps.pool.ownsPath(path)
    },
    exists: deps.exists ?? pathExists,
    async inspect(path) {
      const status = await readSlotStatus(git, path)
      if (!status.ok) return null
      return {
        branch: status.status.branch,
        changedPaths: status.status.changedPaths,
        unpushedCommits: await unpushedCommits(git, path, status.status.branch),
      }
    },
    async releaseSlot(path) {
      const lease = deps.pool?.leaseAt(path) ?? null
      // Not leased: the pool has it back already (it was returned when the chat
      // settled), and its next sweep lets go of anything kept for the chat.
      if (!lease || !deps.pool) return { result: 'returned' }
      const outcome = await deps.pool.release(lease.leaseId)
      if (outcome === 'returned' || outcome === 'not-found') return { result: 'returned' }
      if (outcome === 'held') {
        return { result: 'kept', detail: 'It has changes, so the pool holds it for you in Settings ▸ Worktrees.' }
      }
      if (outcome === 'busy') return { result: 'kept', detail: 'Another Studio is using its pool.' }
      return { result: 'kept', detail: 'Something still runs in it; the next cleanup returns it.' }
    },
    removeWorktree: (input) => deps.inventory.removeOther(input),
  }
}

/**
 * The commits HEAD has that exist nowhere else: on no remote branch, and on
 * no other local branch. Removing the worktree keeps its branch, so these are
 * not lost, but they are the ones a person would want to hear about, as the
 * work nobody else has. Null when git could not say.
 */
async function unpushedCommits(git: SlotGitRunner, path: string, branch: string | null): Promise<number | null> {
  const others = branch ? [`--exclude=${branch}`, '--branches', '--remotes'] : ['--branches', '--remotes']
  const counted = await git(path, ['rev-list', '--count', 'HEAD', '--not', ...others])
  if (!counted.ok) return null
  const value = Number.parseInt(counted.stdout.trim(), 10)
  return Number.isFinite(value) ? value : null
}
