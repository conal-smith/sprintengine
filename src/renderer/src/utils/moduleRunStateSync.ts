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
 * Nothing goes until the third-party modules have loaded: before then a
 * module's chats have no provider here, and their runs would be pushed as
 * none. After that the reading is taken again, a moment after the store's
 * chats change (a burst of changes is one reading) and on a slow beat besides,
 * since a provider derives from module state the store does not hold. Only
 * module chats are read, none at all when there are none, and an unchanged
 * reading is not sent again. Mounted once from `WorkspaceManager`.
 */
import type { LifecycleState } from '../../../shared/lifecycle-state'
import { onThirdPartyRendererModulesLoaded } from '../modules'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { Workspace } from '../types/workspace'
import { deriveWorkspaceRunGlyph } from './workspaceRunGlyph'

/** How often the reading is taken again, for a module whose state moved without the store. */
const MODULE_RUN_STATE_POLL_MS = 30_000
/** How long a burst of store changes is gathered into one reading. */
const MODULE_RUN_STATE_DEBOUNCE_MS = 500

const moduleChats = (workspaces: readonly Workspace[]) =>
  workspaces.filter((workspace) => workspace.mode !== 'standard')

export function initModuleRunStateSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setModuleRunStates) return () => undefined

  let loaded = false
  let lastPushed: string | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  const push = (): void => {
    if (!loaded) return
    const chats = moduleChats(useWorkspaceStore.getState().workspaces)
    // No module chats now and none told before: nothing to say.
    if (chats.length === 0 && (lastPushed === null || lastPushed === '{}')) return
    const states: Record<string, LifecycleState | null> = {}
    for (const workspace of chats) states[workspace.id] = deriveWorkspaceRunGlyph(workspace)?.state ?? null
    const key = JSON.stringify(states)
    if (key === lastPushed) return
    lastPushed = key
    void api.setModuleRunStates(states).catch(() => {
      lastPushed = null
    })
  }
  const soon = (): void => {
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      push()
    }, MODULE_RUN_STATE_DEBOUNCE_MS)
  }

  // Called at once when they have already loaded, and again on each reload.
  const stopLoaded = onThirdPartyRendererModulesLoaded(() => {
    loaded = true
    push()
  })
  const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspaces !== previous.workspaces) soon()
  })
  const timer = setInterval(push, MODULE_RUN_STATE_POLL_MS)
  return () => {
    stopLoaded()
    unsubscribe()
    clearInterval(timer)
    if (debounce !== null) clearTimeout(debounce)
  }
}
