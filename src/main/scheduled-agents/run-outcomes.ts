// What a scheduled agent's run comes to once it has started, written down.
//
// A run is recorded as started when its chat is up, but the chat's first
// message goes out after that, and may still be refused: by the chat before
// the start is recorded, or after. Either way the run did not do its job, and
// its schedule's card says so in the failure's words.
//
// A one-time schedule whose chat started has done its one job, and is closed:
// its chat carries on as any other. One whose run failed stays, saying so,
// until the person has seen it. That holds for a refusal that comes late too —
// after the schedule had closed — which puts the schedule back with the
// failure rather than leaving the person's one message lost with nothing to
// say so.

import type { ScheduledAgent, ScheduledAgentLastRun } from '../../shared/scheduled-agents'
import type { ScheduledAgentsStore } from './store'

/** How many recent first-send outcomes are kept, for refusals that come after the run was written down. */
const MAX_REMEMBERED = 32

export type ScheduledRunOutcomesDeps = {
  store: Pick<ScheduledAgentsStore, 'get' | 'recordRun' | 'failRun' | 'closeRan' | 'restore'>
  /** A run finished starting, however it went: the service's report to its listeners. */
  notifyRan: (agent: ScheduledAgent, run: ScheduledAgentLastRun) => void
  /** The list changed. */
  notifyChanged: () => void
  warn: (message: string) => void
}

export type ScheduledRunOutcomes = {
  /** The scheduler's `recordRun`: a start whose first message was already refused is recorded as that failure. */
  recordRun(id: string, run: ScheduledAgentLastRun): Promise<void>
  /** The scheduler's `onRan`. */
  onRan(agent: ScheduledAgent, run: ScheduledAgentLastRun): void
  /** The chat a run started in refused its first message. */
  firstSendFailed(agentId: string, workspaceId: string, message: string): void
}

export function createScheduledRunOutcomes(deps: ScheduledRunOutcomesDeps): ScheduledRunOutcomes {
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
  // A run's first message refused before its start was recorded, by the chat
  // it started in: the start is recorded as that failure instead.
  const refusedBeforeRecorded = new Map<string, string>()
  // One-time schedules closed because their chat started, by that chat, so a
  // refusal that comes after can put them back.
  const closed = new Map<string, ScheduledAgent>()
  const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
    map.delete(key)
    map.set(key, value)
    while (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!)
  }

  return {
    recordRun(id, run) {
      const refused = run.ok ? refusedBeforeRecorded.get(run.workspaceId) : undefined
      if (refused === undefined || !run.ok) return deps.store.recordRun(id, run)
      refusedBeforeRecorded.delete(run.workspaceId)
      return deps.store.recordRun(id, { at: run.at, ok: false, message: refused })
    },
    onRan(agent, run) {
      // Told first, so a one-time schedule's run is heard before the
      // schedule closes and leaves the list.
      deps.notifyRan(agent, run)
      // As written down, not as the scheduler saw it: a refusal that beat the
      // record made the run a failure, and a failed one stays.
      const recorded = deps.store.get(agent.id)
      if (agent.schedule.once === undefined || !run.ok || !recorded?.lastRun?.ok) {
        deps.notifyChanged()
        return
      }
      const workspaceId = run.workspaceId
      // Remembered before it goes, so a refusal heard while it is going finds it.
      remember(closed, workspaceId, recorded)
      void deps.store
        .closeRan(agent.id, workspaceId)
        .then((gone) => {
          if (!gone) closed.delete(workspaceId)
        })
        .catch((error: unknown) => deps.warn(describe(error)))
        .then(() => deps.notifyChanged())
    },
    firstSendFailed(agentId, workspaceId, message) {
      void deps.store
        .failRun(agentId, workspaceId, message)
        .then(async (failed) => {
          if (failed) {
            closed.delete(workspaceId)
            deps.notifyChanged()
            return
          }
          const gone = closed.get(workspaceId)
          if (gone && gone.id === agentId && gone.lastRun?.ok) {
            closed.delete(workspaceId)
            const back = await deps.store.restore({ ...gone, lastRun: { at: gone.lastRun.at, ok: false, message } })
            if (back) {
              deps.notifyChanged()
              return
            }
          }
          remember(refusedBeforeRecorded, workspaceId, message)
        })
        // The store refuses writes while its file cannot be read.
        .catch((error: unknown) => deps.warn(describe(error)))
    },
  }
}
