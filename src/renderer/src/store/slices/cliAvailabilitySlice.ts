import { isDraft, original } from 'immer'

import type { AgentCli, AgentCliAvailabilityMap, CliRuntimeSettings } from '../../../../shared/electron-api'
import { reuseUnchanged } from '../../utils/reuseUnchanged'

// Whether the detected-availability map is trustworthy yet. Pickers only filter
// out uninstalled CLIs once this is `ready` with at least one installed entry;
// while `loading`/`error` they fall back to showing all registered CLIs so the
// deployment picker is never empty (see cliRuntimeOptions.filterCatalog).
export type CliAvailabilityStatus = 'loading' | 'ready' | 'error'

export interface CliAvailabilitySliceState {
  cliAvailability: AgentCliAvailabilityMap
  cliAvailabilityStatus: CliAvailabilityStatus
  cliAvailabilityError: string | null
  // When this map was last accepted, as epoch ms — the freshness the Agent CLIs
  // section band reports ("Checked 2m ago"). It is when the RESULT landed here;
  // main holds each detection until Re-check (or an install or update it ran),
  // so the underlying detection can be as old as the session. The band's
  // re-check button has main detect every CLI again. Null until a probe has ever succeeded, so the
  // band shows nothing rather than implying a check that never happened.
  cliAvailabilityCheckedAt: number | null
}

interface RefreshCliAvailabilityOptions {
  // Background re-sync (window focus): don't flip to `loading` and don't wipe a
  // working map on a transient failure, mirroring refreshPluginCatalog.
  background?: boolean
  // Probe every CLI again instead of reading main's held answer. Settings'
  // Re-check detects through the version service instead (every machine at
  // once), and an install or update records its own CLI's answer in main.
  force?: boolean
  // Per-CLI command/WSL overrides forwarded into the probe so detection matches
  // the launch path. Callers read these from appSettings.cliRuntimes.
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
}

interface CliAvailabilitySliceActions {
  refreshCliAvailability: (options?: RefreshCliAvailabilityOptions) => Promise<void>
}

export type CliAvailabilitySlice = CliAvailabilitySliceState & CliAvailabilitySliceActions

type CliAvailabilitySliceSet = (mutator: (state: CliAvailabilitySliceState) => void) => void

type CliAvailabilityApi = Pick<Window['api'], 'pluginsDetectAvailability'>

function getCliAvailabilityApi(): CliAvailabilityApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  return api && typeof api.pluginsDetectAvailability === 'function' ? api : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createCliAvailabilitySlice(
  set: CliAvailabilitySliceSet,
  deps: { getApi?: () => CliAvailabilityApi | null } = {},
): CliAvailabilitySlice {
  const getApi = deps.getApi ?? getCliAvailabilityApi
  // Dedup concurrent refreshes but track the in-flight MODE so a foreground
  // request is never swallowed by an in-flight background one — same contract as
  // refreshPluginCatalog.
  let inFlight: { promise: Promise<void>; background: boolean } | null = null

  const track = (background: boolean, work: Promise<void>): Promise<void> => {
    const settled = work.finally(() => {
      if (inFlight?.promise === settled) inFlight = null
    })
    inFlight = { promise: settled, background }
    return settled
  }

  const runRefresh = async (options: RefreshCliAvailabilityOptions): Promise<void> => {
    const background = options.background ?? false
    if (!background) {
      set((state) => {
        state.cliAvailabilityStatus = 'loading'
        state.cliAvailabilityError = null
      })
    }

    const api = getApi()
    if (!api) {
      if (!background) {
        set((state) => {
          state.cliAvailability = {}
          state.cliAvailabilityStatus = 'error'
          state.cliAvailabilityError = 'CLI availability API is unavailable.'
        })
      }
      return
    }

    try {
      const result = await api.pluginsDetectAvailability({
        cliRuntimes: options.cliRuntimes,
        force: options.force,
      })
      set((state) => {
        if (result.ok) {
          // Main hands back the whole answer on every read, and a background
          // re-read usually finds nothing new: what reads the same keeps its
          // object, so the window's return re-renders only what moved.
          const previous = isDraft(state.cliAvailability) ? original(state.cliAvailability) : state.cliAvailability
          const next = reuseUnchanged(previous, result.availability)
          if (next !== previous) state.cliAvailability = next
          state.cliAvailabilityStatus = 'ready'
          state.cliAvailabilityError = null
          state.cliAvailabilityCheckedAt = Date.now()
        } else if (!background) {
          state.cliAvailability = {}
          state.cliAvailabilityStatus = 'error'
          state.cliAvailabilityError = result.message
        }
      })
    } catch (error) {
      if (!background) {
        set((state) => {
          state.cliAvailability = {}
          state.cliAvailabilityStatus = 'error'
          state.cliAvailabilityError = formatError(error)
        })
      }
    }
  }

  return {
    cliAvailability: {},
    cliAvailabilityStatus: 'loading',
    cliAvailabilityError: null,
    cliAvailabilityCheckedAt: null,

    refreshCliAvailability: (options) => {
      const opts = options ?? {}
      const background = opts.background ?? false
      const current = inFlight
      if (current) {
        // A foreground request must not inherit an in-flight background run's
        // no-loading/suppressed-error behavior; queue a foreground run after it.
        if (background || !current.background) return current.promise
        return track(
          false,
          current.promise.then(() => runRefresh(opts)),
        )
      }
      return track(background, runRefresh(opts))
    },
  }
}
