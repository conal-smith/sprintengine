/**
 * Pushes each module chat's run state to main.
 *
 * Main's rest sweep never settles a chat whose module reports a run still in
 * flight or waiting on the person (`AutoSettleContext.runState`), but the
 * report comes from the module type's provider (`deriveRunGlyph`), which runs
 * in a window. So the windows push it: every chat of a type other than the
 * standard one, with the state its provider reports, `null` where it reports
 * none (a type with no provider settles as any other chat). A chat main has
 * not been told about is never settled by it.
 *
 * Pushed on mount, on every store change, and on a slow beat besides: a
 * provider derives from module state the store does not hold, so a run that
 * ends moves nothing here. Compared by value, so an unchanged reading is not
 * sent again. Mounted once from `WorkspaceManager`.
 */
import type { LifecycleState } from '../../../shared/lifecycle-state'
import { useWorkspaceStore } from '../store/workspaceStore'
import { deriveWorkspaceRunGlyph } from './workspaceRunGlyph'

/** How often the reading is taken again, for a module whose state moved without the store. */
const MODULE_RUN_STATE_POLL_MS = 30_000

export function initModuleRunStateSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setModuleRunStates) return () => undefined

  let lastPushed: string | null = null
  const push = (): void => {
    const states: Record<string, LifecycleState | null> = {}
    for (const workspace of useWorkspaceStore.getState().workspaces) {
      if (workspace.mode === 'standard') continue
      states[workspace.id] = deriveWorkspaceRunGlyph(workspace)?.state ?? null
    }
    const key = JSON.stringify(states)
    if (key === lastPushed) return
    lastPushed = key
    void api.setModuleRunStates(states).catch(() => {
      lastPushed = null
    })
  }

  push()
  const unsubscribe = useWorkspaceStore.subscribe(push)
  const timer = setInterval(push, MODULE_RUN_STATE_POLL_MS)
  return () => {
    unsubscribe()
    clearInterval(timer)
  }
}
