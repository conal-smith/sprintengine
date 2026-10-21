// The agent trail for one Files tree: the workspace's chats' file activity,
// read through the shared sessions store, kept current by one timer that
// wakes only when a lingering mark is due to lapse.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { conversationSessionsStore } from '../../hooks/conversationSessionsStore'
import { agentFileTrail, EMPTY_AGENT_TRAIL, type AgentTrail } from './agentFileTrail'

/**
 * @param rootPath the tree's root; null for marks on files anywhere and on no
 *   folder, which is what an editor's tabs ask.
 */
export function useAgentFileTrail(workspaceId: string, rootPath: string | null): AgentTrail {
  const store = conversationSessionsStore()
  const getSnapshot = useCallback(() => store.getWorkspaceSnapshot(workspaceId), [store, workspaceId])
  const sessions = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
  // The time is read when the sessions move or the timer below fires; nothing
  // else can change what the trail draws.
  const [tick, setTick] = useState(0)
  const trail = useMemo(
    () =>
      sessions.some((session) => session.fileActivity?.length)
        ? agentFileTrail(sessions, rootPath, Date.now())
        : EMPTY_AGENT_TRAIL,
    // `tick` is the clock: a new reading of `Date.now()` when a mark lapses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, rootPath, tick],
  )
  const wakeAt = trail.nextChangeAt
  useEffect(() => {
    if (wakeAt === null) return undefined
    const timer = setTimeout(() => setTick((current) => current + 1), Math.max(0, wakeAt - Date.now()))
    return () => clearTimeout(timer)
  }, [wakeAt])
  return trail
}
