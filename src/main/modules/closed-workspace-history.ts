import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ModuleWorkspaceView } from '../../shared/modules/workspace-view'

// The workspaces closed on this machine, for `WorkspaceContextService.list({
// includeClosed: true })`. Closing a workspace removes its record from the
// registry outright (only a bare tombstone id is kept, for a day), so without
// this a module could not tie anything it kept — a chat transcript in the
// project's store, its own storage — back to a project that is no
// longer open.
//
// It records what the registry said about a workspace the moment it left:
// id, name, folder and type, and when. Fed the registry's workspace list on
// every change; an id that disappears is recorded, an id that comes back is
// dropped. Bounded, newest kept; persisted as one small JSON file in user data.

export type ClosedWorkspaceRecord = ModuleWorkspaceView & { closedAt: number }

export const CLOSED_WORKSPACE_HISTORY_FILE = 'closed-workspaces.json'
export const CLOSED_WORKSPACE_HISTORY_LIMIT = 500

export type ClosedWorkspaceHistory = {
  /** Feed the registry's current workspaces; the first call only sets the baseline. */
  observe(workspaces: readonly ModuleWorkspaceView[]): void
  /** Closed workspaces, newest first. */
  list(): ClosedWorkspaceRecord[]
}

export function createClosedWorkspaceHistory(options: {
  filePath: string
  now?: () => number
  limit?: number
}): ClosedWorkspaceHistory {
  const now = options.now ?? Date.now
  const limit = options.limit ?? CLOSED_WORKSPACE_HISTORY_LIMIT
  let records: ClosedWorkspaceRecord[] | null = null
  let previous: Map<string, ModuleWorkspaceView> | null = null

  const load = (): ClosedWorkspaceRecord[] => {
    if (records) return records
    try {
      const parsed = JSON.parse(readFileSync(options.filePath, 'utf8')) as unknown
      records = Array.isArray(parsed) ? parsed.filter(isRecord) : []
    } catch {
      records = []
    }
    return records
  }

  const persist = (next: ClosedWorkspaceRecord[]): void => {
    records = next
    const tmp = `${options.filePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(options.filePath), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8')
      renameSync(tmp, options.filePath)
    } catch {
      // History is a convenience: a failed write costs a closed workspace's
      // entry, never the registry change that caused it.
      rmSync(tmp, { force: true })
    }
  }

  return {
    observe(workspaces) {
      const current = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
      const before = previous
      previous = current
      if (!before) return
      const closed = [...before.values()].filter((workspace) => !current.has(workspace.id))
      const existing = load()
      const reopened = existing.some((record) => current.has(record.id))
      if (closed.length === 0 && !reopened) return
      const at = now()
      const closedIds = new Set(closed.map((workspace) => workspace.id))
      const next = [
        ...closed.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          folderPath: workspace.folderPath,
          mode: workspace.mode,
          closedAt: at,
        })),
        ...existing.filter((record) => !current.has(record.id) && !closedIds.has(record.id)),
      ].slice(0, limit)
      persist(next)
    },
    list() {
      return load().map((record) => ({ ...record }))
    },
  }
}

function isRecord(value: unknown): value is ClosedWorkspaceRecord {
  const record = value as Partial<ClosedWorkspaceRecord> | null
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    (record.folderPath === null || typeof record.folderPath === 'string') &&
    typeof record.mode === 'string' &&
    typeof record.closedAt === 'number'
  )
}
