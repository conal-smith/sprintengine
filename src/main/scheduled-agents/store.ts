// Scheduled agents on disk: one JSON file in the app's own data. Never in a
// project folder — what is scheduled on this computer is decided on this
// computer, so a commit pulled into a project can never schedule anything.
//
// The file is small (a person has a handful of these), so the store holds the
// whole list in memory, reads it once, and rewrites it whole on every change,
// serialized so two writes never interleave.
//
// Rewriting it whole is why the read is careful. Every call waits for the
// file to have been read, so a write that comes early (the window's IPC is
// up before the scheduler's sidecar starts) does not replace the file with
// only its own entry. A missing file is an empty list; one that is there but
// cannot be read (a permission, a lock) refuses every write this run; one
// that cannot be understood is kept aside as `.corrupt-<time>` and the list
// starts empty; and an entry that no longer validates is held back, written
// back as it was, rather than dropped by the next change.
//
// Pausing added two fields and no version: an entry's `pausedAt`, and the
// file's `pausedAll` (every schedule paused, since and until when). A file
// without them is every schedule running, as it always was. The version stays
// at 1 because a build that reads a higher one keeps the whole file aside as
// not its own, and an older app would lose every schedule over two fields it
// can do without; reading this file, it drops them and runs its schedules,
// which is what it did before there was a pause.

import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { writeFileAtomically } from '../config-file-write'
import {
  validateScheduledAgentDraft,
  withoutEmptyLabels,
  type ScheduledAgent,
  type ScheduledAgentDraft,
  type ScheduledAgentLastRun,
  type ScheduledAgentsPause,
} from '../../shared/scheduled-agents'
import { isRecord } from '../../shared/records'

const FILE_VERSION = 1

type StoreFile = { version: typeof FILE_VERSION; agents: ScheduledAgent[]; pausedAll?: ScheduledAgentsPause }

export function scheduledAgentsFilePath(userDataDir: string): string {
  return join(userDataDir, 'scheduled-agents.json')
}

export type ScheduledAgentsStoreOptions = {
  filePath: string
  now?: () => number
  newId?: () => string
  warn?: (message: string) => void
}

export type ScheduledAgentsStore = {
  /** Read the file, once; every other call waits for it, and starts it when nothing has. */
  load(): Promise<void>
  list(): ScheduledAgent[]
  get(id: string): ScheduledAgent | null
  create(draft: ScheduledAgentDraft, ownerModuleId?: string | null): Promise<ScheduledAgent>
  update(id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgent | null>
  remove(id: string): Promise<boolean>
  recordRun(id: string, run: ScheduledAgentLastRun): Promise<void>
  /**
   * The run recorded as started in `workspaceId` failed after all: its last
   * run becomes that failure. False when the last run is another one (or none).
   */
  failRun(id: string, workspaceId: string, message: string): Promise<boolean>
  /**
   * Close a one-time schedule whose run started its chat in `workspaceId`: it
   * is removed and returned. Null, and kept, when its last run is not that
   * one, or failed after all: a failed one stays to say so.
   */
  closeRan(id: string, workspaceId: string): Promise<ScheduledAgent | null>
  /**
   * Put back a schedule `closeRan` took away, as `agent` says it now is: its
   * run's first message was refused after the schedule had closed. False when
   * one with its id is already there.
   */
  restore(agent: ScheduledAgent): Promise<boolean>
  markFailureSeen(id: string): Promise<void>
  /** Paused at `at`, or running on its schedule again (null). Null when there is no such scheduled agent. */
  setPaused(id: string, at: number | null): Promise<ScheduledAgent | null>
  /** Every scheduled agent paused, as the file says it, expired or not; null when they are not. */
  pausedAll(): ScheduledAgentsPause | null
  setPausedAll(pause: ScheduledAgentsPause | null): Promise<void>
}

export function createScheduledAgentsStore(options: ScheduledAgentsStoreOptions): ScheduledAgentsStore {
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => `sa-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
  let agents: ScheduledAgent[] = []
  // Entries in the file this build would not schedule, kept as they were.
  let heldBack: unknown[] = []
  let pausedAll: ScheduledAgentsPause | null = null
  // Why the file could not be read, while it could not: nothing is written over it.
  let unreadable: string | null = null
  let ready: Promise<void> | null = null
  let writing: Promise<void> = Promise.resolve()

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

  async function read(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(options.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      unreadable = `Scheduled agents could not be read from ${options.filePath}, so no change is saved until they can be: ${describe(error)}`
      options.warn?.(unreadable)
      return
    }
    let parsed: ReturnType<typeof parseStoreFile>
    try {
      parsed = parseStoreFile(JSON.parse(raw), now(), options.warn)
    } catch (error) {
      parsed = null
      options.warn?.(`Scheduled agents could not be read from ${options.filePath}: ${describe(error)}`)
    }
    if (parsed) {
      agents = parsed.agents
      heldBack = parsed.heldBack
      pausedAll = parsed.pausedAll
      return
    }
    // Truncated, hand-edited, or written by a version this build does not
    // know: kept aside rather than overwritten by the next write.
    const aside = `${options.filePath}.corrupt-${now()}`
    try {
      await rename(options.filePath, aside)
      options.warn?.(`Scheduled agents that could not be understood were kept aside as ${aside}.`)
    } catch (error) {
      unreadable = `Scheduled agents in ${options.filePath} could not be understood or kept aside, so no change is saved: ${describe(error)}`
      options.warn?.(unreadable)
    }
  }

  const loaded = (): Promise<void> => (ready ??= read())

  /** Before a change: the file read, and one that could not be is not written over. */
  const writable = async (): Promise<void> => {
    await loaded()
    if (unreadable) throw new Error(unreadable)
  }

  const persist = (): Promise<void> => {
    const snapshot: StoreFile = {
      version: FILE_VERSION,
      agents: [...agents, ...heldBack] as ScheduledAgent[],
      ...(pausedAll ? { pausedAll } : {}),
    }
    writing = writing
      .catch(() => undefined)
      .then(() => writeFileAtomically(options.filePath, `${JSON.stringify(snapshot, null, 2)}\n`))
    return writing
  }

  const replace = (id: string, next: ScheduledAgent): void => {
    agents = agents.map((agent) => (agent.id === id ? next : agent))
  }

  return {
    load: loaded,
    list: () => agents,
    get: (id) => agents.find((agent) => agent.id === id) ?? null,
    async create(draft, ownerModuleId = null) {
      await writable()
      const at = now()
      const agent: ScheduledAgent = {
        ...withoutEmptyLabels(draft),
        id: newId(),
        ownerModuleId: ownerModuleId?.trim() || null,
        createdAt: at,
        updatedAt: at,
        lastRun: null,
        lastFailureSeenAt: null,
      }
      agents = [...agents, agent]
      await persist()
      return agent
    },
    async update(id, draft) {
      await writable()
      const current = agents.find((agent) => agent.id === id)
      if (!current) return null
      // A draft that does not name a name or tag keeps the record's; an empty one clears it.
      const next: ScheduledAgent = withoutEmptyLabels({ ...current, ...draft, updatedAt: now() })
      replace(id, next)
      await persist()
      return next
    },
    async remove(id) {
      await writable()
      const before = agents.length
      agents = agents.filter((agent) => agent.id !== id)
      if (agents.length === before) return false
      await persist()
      return true
    },
    async recordRun(id, run) {
      await writable()
      const current = agents.find((agent) => agent.id === id)
      if (!current) return
      replace(id, { ...current, lastRun: run })
      await persist()
    },
    async failRun(id, workspaceId, message) {
      await writable()
      const current = agents.find((agent) => agent.id === id)
      const run = current?.lastRun
      if (!current || !run?.ok || run.workspaceId !== workspaceId) return false
      replace(id, { ...current, lastRun: { at: run.at, ok: false, message } })
      await persist()
      return true
    },
    async closeRan(id, workspaceId) {
      await writable()
      const current = agents.find((agent) => agent.id === id)
      const run = current?.lastRun
      if (!current || !run?.ok || run.workspaceId !== workspaceId) return null
      agents = agents.filter((agent) => agent.id !== id)
      await persist()
      return current
    },
    async restore(agent) {
      await writable()
      if (agents.some((candidate) => candidate.id === agent.id)) return false
      agents = [...agents, agent]
      await persist()
      return true
    },
    async markFailureSeen(id) {
      await writable()
      const current = agents.find((agent) => agent.id === id)
      if (!current || !current.lastRun || current.lastRun.ok) return
      replace(id, { ...current, lastFailureSeenAt: now() })
      await persist()
    },
    async setPaused(id, at) {
      await writable()
      const current = agents.find((agent) => agent.id === id)
      if (!current) return null
      // Not an edit: the schedule is as it was, so `updatedAt` is too.
      const { pausedAt: _was, ...rest } = current
      const next: ScheduledAgent = at === null ? rest : { ...rest, pausedAt: at }
      replace(id, next)
      await persist()
      return next
    },
    pausedAll: () => pausedAll,
    async setPausedAll(pause) {
      await writable()
      pausedAll = pause
      await persist()
    },
  }
}

// Each record is re-validated on the way in: a hand-edited or half-written
// entry is held back with a warning rather than scheduled in a shape nothing
// else would have written, and written back as it was. Null for a file whose
// shape is not this store's at all.
function parseStoreFile(
  input: unknown,
  now: number,
  warn?: (message: string) => void,
): { agents: ScheduledAgent[]; heldBack: unknown[]; pausedAll: ScheduledAgentsPause | null } | null {
  if (!isRecord(input) || !Array.isArray(input.agents)) return null
  if (typeof input.version === 'number' && input.version > FILE_VERSION) return null
  const agents: ScheduledAgent[] = []
  const heldBack: unknown[] = []
  for (const entry of input.agents) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
      heldBack.push(entry)
      continue
    }
    const validated = validateScheduledAgentDraft(entry, now, { stored: true })
    if (!validated.ok) {
      warn?.(`Scheduled agent "${entry.id}" was skipped: ${validated.message}`)
      heldBack.push(entry)
      continue
    }
    agents.push({
      ...withoutEmptyLabels(validated.draft),
      id: entry.id,
      ownerModuleId: typeof entry.ownerModuleId === 'string' && entry.ownerModuleId ? entry.ownerModuleId : null,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
      lastRun: parseLastRun(entry.lastRun),
      lastFailureSeenAt: typeof entry.lastFailureSeenAt === 'number' ? entry.lastFailureSeenAt : null,
      ...(isInstant(entry.pausedAt) ? { pausedAt: entry.pausedAt } : {}),
    })
  }
  return { agents, heldBack, pausedAll: parsePausedAll(input.pausedAll) }
}

const isInstant = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// Anything but a pause this build would have written is no pause: a schedule
// that runs when it should not have is seen, and one that never runs is not.
function parsePausedAll(input: unknown): ScheduledAgentsPause | null {
  if (!isRecord(input) || !isInstant(input.since)) return null
  if (input.until !== null && !isInstant(input.until)) return null
  return { since: input.since, until: input.until }
}

function parseLastRun(input: unknown): ScheduledAgentLastRun | null {
  if (!isRecord(input) || typeof input.at !== 'number') return null
  if (input.ok === true && typeof input.workspaceId === 'string') {
    return {
      at: input.at,
      ok: true,
      workspaceId: input.workspaceId,
      ...(typeof input.agentId === 'string' && input.agentId ? { agentId: input.agentId } : {}),
    }
  }
  if (input.ok === false && typeof input.message === 'string')
    return { at: input.at, ok: false, message: input.message }
  return null
}
