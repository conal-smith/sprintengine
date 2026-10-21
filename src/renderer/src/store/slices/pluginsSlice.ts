import { isDraft, original } from 'immer'

import type { PluginCatalogEntry, PluginCatalogStatus } from '../../types/workspace'
import { reuseUnchanged } from '../../utils/reuseUnchanged'

// `resumeCapabilitiesForCli` moved to the shared resume-capability module
// (main-process consumers resolve caps from
// the same catalog shape); this re-export keeps every existing import site
// working unchanged.
export { resumeCapabilitiesForCli } from '../../../../shared/agent-cli-resume'

export interface PluginsSliceState {
  pluginCatalogEntries: PluginCatalogEntry[]
  pluginCatalogStatus: PluginCatalogStatus
  pluginCatalogError: string | null
}

interface RefreshPluginCatalogOptions {
  // Background re-sync (e.g. window focus): don't flip the catalog to `loading`
  // and don't wipe a working catalog on a transient failure. The explicit
  // startup load and Settings retry stay foreground so their loading/error
  // states still surface.
  background?: boolean
}

interface PluginsSliceActions {
  refreshPluginCatalog: (options?: RefreshPluginCatalogOptions) => Promise<void>
}

export type PluginsSlice = PluginsSliceState & PluginsSliceActions

type PluginsSliceSet = (mutator: (state: PluginsSliceState) => void) => void

type PluginsApi = Pick<Window['api'], 'pluginsList'>

function getPluginsApi(): PluginsApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  return api && typeof api.pluginsList === 'function' ? api : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginsSlice(
  set: PluginsSliceSet,
  deps: { getApi?: () => PluginsApi | null } = {},
): PluginsSlice {
  const getApi = deps.getApi ?? getPluginsApi
  // Dedup concurrent refreshes (rapid window focus changes, startup + focus
  // racing), but track the in-flight MODE so a foreground refresh is never
  // swallowed by an in-flight background one. A foreground run (sets loading,
  // surfaces errors) satisfies background callers too; a background run does not
  // satisfy a foreground caller, so a foreground request queues its own
  // foreground run after the background one settles.
  let inFlight: { promise: Promise<void>; background: boolean } | null = null

  const track = (background: boolean, work: Promise<void>): Promise<void> => {
    const settled = work.finally(() => {
      if (inFlight?.promise === settled) inFlight = null
    })
    inFlight = { promise: settled, background }
    return settled
  }

  const runRefresh = async (background: boolean): Promise<void> => {
    if (!background) {
      set((state) => {
        state.pluginCatalogStatus = 'loading'
        state.pluginCatalogError = null
      })
    }

    const api = getApi()
    if (!api) {
      // A background re-sync keeps the last-known-good catalog; only the
      // foreground load reports the unavailable API as an error state.
      if (!background) {
        set((state) => {
          state.pluginCatalogEntries = []
          state.pluginCatalogStatus = 'error'
          state.pluginCatalogError = 'Plugin registry API is unavailable.'
        })
      }
      return
    }

    try {
      const result = await api.pluginsList()
      set((state) => {
        if (result.ok) {
          // Main hands back the whole answer on every read, and a background
          // re-read usually finds nothing new: what reads the same keeps its
          // object, so the window's return re-renders only what moved.
          const previous = isDraft(state.pluginCatalogEntries)
            ? original(state.pluginCatalogEntries)
            : state.pluginCatalogEntries
          const next = reuseUnchanged(previous, result.plugins)
          if (next !== previous) state.pluginCatalogEntries = next
          state.pluginCatalogStatus = 'ready'
          state.pluginCatalogError = null
        } else if (!background) {
          state.pluginCatalogEntries = []
          state.pluginCatalogStatus = 'error'
          state.pluginCatalogError = result.message
        }
      })
    } catch (error) {
      if (!background) {
        set((state) => {
          state.pluginCatalogEntries = []
          state.pluginCatalogStatus = 'error'
          state.pluginCatalogError = formatError(error)
        })
      }
    }
  }

  return {
    pluginCatalogEntries: [],
    pluginCatalogStatus: 'loading',
    pluginCatalogError: null,

    refreshPluginCatalog: (options) => {
      const background = options?.background ?? false
      const current = inFlight
      if (current) {
        // Ride the in-flight refresh only when it already provides
        // at-least-as-strong semantics: any caller can ride a foreground run, and
        // a background caller can ride a background run. A foreground request
        // during an in-flight background run must not inherit its no-loading /
        // suppressed-error behavior, so queue a foreground run after it settles.
        if (background || !current.background) return current.promise
        return track(
          false,
          current.promise.then(() => runRefresh(false)),
        )
      }
      return track(background, runRefresh(background))
    },
  }
}

interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

interface VisibilityDocLike extends EventTargetLike {
  readonly visibilityState: DocumentVisibilityState
}

// Wires window focus + document visibility ("visible") to a catalog refresh,
// the approved v1 substitute for a `plugins:changed` push event so plugins
// installed/removed while the user was away show up when they return. Returns a
// cleanup that removes both listeners. Guarded for non-browser execution and
// injectable for tests.
export function subscribePluginCatalogRefreshOnFocus(
  refresh: () => void,
  overrides: { win?: EventTargetLike | null; doc?: VisibilityDocLike | null } = {},
): () => void {
  const win = overrides.win ?? (typeof window === 'undefined' ? null : window)
  const doc = overrides.doc ?? (typeof document === 'undefined' ? null : document)
  if (!win && !doc) return () => {}

  const onFocus = (): void => refresh()
  const onVisibility = (): void => {
    if (!doc || doc.visibilityState === 'visible') refresh()
  }

  win?.addEventListener('focus', onFocus)
  doc?.addEventListener('visibilitychange', onVisibility)

  return () => {
    win?.removeEventListener('focus', onFocus)
    doc?.removeEventListener('visibilitychange', onVisibility)
  }
}
