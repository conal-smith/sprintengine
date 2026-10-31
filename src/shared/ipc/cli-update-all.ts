import type { AgentCli } from '../electron-api'
import type { ExecutionHostId } from '../execution-host'

// Update everything: one action that updates every agent CLI with a newer
// version published, on this machine and on each WSL distribution turned on in
// Settings ▸ Machines, through the same updater each row's Update runs.

/** Where one CLI's update stands. */
export type CliUpdateAllState = 'queued' | 'updating' | 'updated' | 'unchanged' | 'failed'

export type CliUpdateAllItem = {
  hostId: ExecutionHostId
  cli: AgentCli
  /** The version found before the update, and the one published. */
  from: string | null
  latest: string | null
  /** The version found after it, once it has run. */
  to?: string | null
  state: CliUpdateAllState
  error?: string
}

export type CliUpdateAllResult = { ok: true; items: CliUpdateAllItem[] } | { ok: false; message: string }

export const CLI_UPDATE_ALL_CHANNEL = 'cli-runtime:update-all'
/** Every item, each time one moves, to the windows that asked. */
export const CLI_UPDATE_ALL_PROGRESS_CHANNEL = 'cli-runtime:update-all-progress'
