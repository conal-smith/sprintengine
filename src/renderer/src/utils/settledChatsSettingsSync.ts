/**
 * Pushes Settings ▸ Settled chats to main.
 *
 * A chat's rest is decided by main's sweep
 * (`main/automation/workspace-settlement-sweep.ts`), which runs with or
 * without a window open and so cannot ask one for the settings it reads. Same
 * one-way contract as the titles setting (`textGenerationSettingsSync.ts`):
 * the renderer owns the values, main keeps a persisted copy, and there is no
 * read path back.
 *
 * Mounted once from `WorkspaceManager`. The first push runs on mount so main
 * converges even when this window's stored values came from another window or
 * from an import.
 */
import { normalizeSettledChatsSettings } from '../../../shared/workspace-settlement'
import { useWorkspaceStore } from '../store/workspaceStore'

export function initSettledChatsSettingsSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setSettledChatsSettings) return () => undefined

  // `null` so the mount push always goes, even at the defaults, or a value
  // changed in another window would leave main holding the stale one.
  let lastPushed: string | null = null
  const push = (): void => {
    const settings = normalizeSettledChatsSettings(useWorkspaceStore.getState().appSettings)
    const key = JSON.stringify(settings)
    if (key === lastPushed) return
    lastPushed = key
    void api.setSettledChatsSettings(settings).catch(() => {
      // Retry on the next settings change; main also persists the last good
      // push, so a transient IPC failure only delays convergence.
      lastPushed = null
    })
  }

  push()
  return useWorkspaceStore.subscribe(push)
}
