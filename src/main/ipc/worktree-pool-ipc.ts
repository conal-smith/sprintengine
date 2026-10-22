import type { IpcMain } from 'electron'
import type {
  WorktreeDependencyInstallView,
  WorktreeInventory,
  WorktreeInventoryInput,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import { dependencyInstallSettingFor } from '../../shared/ipc/worktree-pool'
import { removeGitWorktree } from '../git'
import { createWorktreeInventory, type WorktreeInventoryDeps } from '../worktree-pool/worktree-inventory'
import type { DependencyInstaller } from '../worktree-pool/dependency-install'
import { catchUpResult, type WorktreePoolService } from '../worktree-pool/worktree-pool-service'
import { broadcastToAllWindows } from '../window-broadcast'

/**
 * The windows' side of the worktree pool: a snapshot of a repository's pool,
 * a person's action on a held or idle slot, the pool's settings, the
 * inventory of every worktree Settings ▸ Worktrees draws, and the dependency
 * installs leased worktrees run (listed, and cancelled). A window
 * is sent `worktree-pool:changed` with a pool's snapshot whenever one moves.
 * Leases are not asked for here; an agent worktree created with `fromPool`
 * comes from the pool (git.ts). Every git step runs in main.
 */

const HELD_ACTIONS = new Set(['commit', 'stash', 'discard', 'keep'])

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A leased worktree's dependency install started, moved on, or ended (`WorktreeDependencyInstallView`). */
export const WORKTREE_INSTALL_CHANGED_CHANNEL = 'worktree-install:changed'

/** A pool's snapshot moved (`WorktreePoolSnapshot`); one channel for every pool. */
const WORKTREE_POOL_CHANGED_CHANNEL = 'worktree-pool:changed'

export function broadcastWorktreePoolChanged(snapshot: WorktreePoolSnapshot): void {
  broadcastToAllWindows(WORKTREE_POOL_CHANGED_CHANNEL, snapshot)
}

export function registerWorktreePoolIpc(
  ipcMain: IpcMain,
  pool: WorktreePoolService,
  installer: DependencyInstaller | null = null,
  checks: Pick<WorktreeInventoryDeps, 'livePaths' | 'knownWorkspaceIds'> = {},
): void {
  ipcMain.handle(
    'worktree-pool:action',
    async (_, input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> => {
      if (input?.kind === 'release') {
        return isString(input.leaseId)
          ? pool.action({ kind: 'release', leaseId: input.leaseId })
          : { ok: false, message: 'No lease named.' }
      }
      if (input?.kind === 'catch-up') {
        if (!isString(input.leaseId)) return { ok: false, message: 'No lease named.' }
        const outcome = await pool.catchUp(input.leaseId)
        // A move that changed the lockfile installs again, as a lease does,
        // before the chat that waits on the catch-up starts in it.
        if (outcome.kind === 'moved' && installer) {
          await installer.prepare({
            repoRoot: outcome.repoRoot,
            path: outcome.path,
            branch: outcome.branch,
            setting: dependencyInstallSettingFor(await pool.getSettings(), outcome.repoRoot),
            quiet: true,
          })
        }
        return catchUpResult(outcome)
      }
      if (!input || !isString(input.repoRoot) || !isString(input.slotId)) {
        return { ok: false, message: 'No worktree named.' }
      }
      if (input.kind === 'evict' || input.kind === 'clear-ignored') {
        return pool.action({ kind: input.kind, repoRoot: input.repoRoot, slotId: input.slotId })
      }
      if (input.kind !== 'held' || !HELD_ACTIONS.has(input.action)) return { ok: false, message: 'Unknown action.' }
      return pool.action({
        kind: 'held',
        repoRoot: input.repoRoot,
        slotId: input.slotId,
        action: input.action,
        message: typeof input.message === 'string' ? input.message.slice(0, 2_000) : undefined,
      })
    },
  )

  ipcMain.handle('worktree-pool:snapshot', async (_, repoRoot: unknown): Promise<WorktreePoolSnapshot | null> => {
    if (!isString(repoRoot)) return null
    return pool.snapshot(repoRoot)
  })

  ipcMain.handle('worktree-pool:settings-get', async (): Promise<WorktreePoolSettings> => pool.getSettings())

  ipcMain.handle(
    'worktree-pool:settings-set',
    async (_, patch: Partial<WorktreePoolSettings> | null): Promise<WorktreePoolSettings> => {
      if (!patch || typeof patch !== 'object') return pool.getSettings()
      const clean: Partial<WorktreePoolSettings> = {}
      if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
      if (typeof patch.keepIdle === 'number') clean.keepIdle = patch.keepIdle
      if (typeof patch.maxSlots === 'number') clean.maxSlots = patch.maxSlots
      if (patch.diskLimitGb === null || typeof patch.diskLimitGb === 'number') clean.diskLimitGb = patch.diskLimitGb
      if (typeof patch.idleReturnMinutes === 'number') clean.idleReturnMinutes = patch.idleReturnMinutes
      // Every project's choice at once, as the page holds them; checked entry
      // by entry where it is stored (normalizePoolSettings).
      if (patch.dependencyInstall && typeof patch.dependencyInstall === 'object') {
        clean.dependencyInstall = patch.dependencyInstall
      }
      if (patch.submodulesAndLfs && typeof patch.submodulesAndLfs === 'object') {
        clean.submodulesAndLfs = patch.submodulesAndLfs
      }
      return pool.updateSettings(clean)
    },
  )

  // The installs running now (a window opening while one runs), and Cancel on one.
  ipcMain.handle('worktree-install:list', async (): Promise<WorktreeDependencyInstallView[]> => installer?.list() ?? [])
  ipcMain.handle('worktree-install:cancel', async (_, id: unknown): Promise<boolean> =>
    isString(id) ? (installer?.cancel(id) ?? false) : false,
  )

  const inventory = createWorktreeInventory({ pool, ...checks, removeWorktree: removeGitWorktree })
  // Remove or Free up space on a worktree the pool does not own: checked as
  // an eviction is (live work, hidden edits, ignored files that may be work).
  ipcMain.handle(
    'worktree-pool:remove-other',
    async (_, input: { repoRoot?: unknown; path?: unknown } | null): Promise<WorktreePoolActionResult> => {
      if (!input || !isString(input.repoRoot) || !isString(input.path)) {
        return { ok: false, message: 'No worktree named.' }
      }
      return inventory.removeOther({ repoRoot: input.repoRoot, path: input.path })
    },
  )
  ipcMain.handle(
    'worktree-pool:inventory',
    async (_, input: WorktreeInventoryInput | null): Promise<WorktreeInventory> =>
      inventory.read({
        repoRoots: Array.isArray(input?.repoRoots) ? input.repoRoots.filter(isString).slice(0, 200) : [],
        measure: input?.measure === true,
      }),
  )
}
