// New chat making its worktree while the person types (utils/newChatWorktree.ts's
// reservation): from the moment the door stands on a git project with Worktree
// on, so Enter finds it made. Turning Worktree off, naming it, or moving to
// another project or machine gives it back to the pool; so does closing New
// chat, after a moment in which the Enter that closed it can take it.

import { nanoid } from 'nanoid'
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  hasNewChatWorktreeReservation,
  releaseNewChatWorktreeReservation,
  reserveNewChatWorktree,
  subscribeNewChatWorktreeReservations,
} from '../../../utils/newChatWorktree'

/** How long after the door settles on a project the worktree is asked for: not for every passing state. */
export const RESERVE_AFTER_MS = 250
/**
 * After a chat took the reservation, how long before the next one is made:
 * long enough for the door that launched it to close, so only a ⌘⏎ that
 * stays on New chat for the next task gets another.
 */
export const RESERVE_AGAIN_AFTER_MS = 2_000
/** A closed door's reservation, kept this long for the Enter that closed it. */
export const RELEASE_GRACE_MS = 10_000

export function useNewChatWorktreeReservation(input: {
  enabled: boolean
  folderPath: string | null
  hostId: ExecutionHostId | null
}): void {
  const [owner] = useState(() => `new-chat-${nanoid(8)}`)
  const held = useSyncExternalStore(subscribeNewChatWorktreeReservations, () => hasNewChatWorktreeReservation(owner))
  // Once one was held, the next waits for the door that launched it to close.
  const [hadOne, setHadOne] = useState(false)
  useEffect(() => {
    if (held) setHadOne(true)
  }, [held])
  const { enabled, folderPath, hostId } = input
  useEffect(() => {
    if (!enabled || !folderPath) {
      releaseNewChatWorktreeReservation(owner)
      return
    }
    // Another project or machine replaces the one held; the same keeps it.
    if (held) {
      reserveNewChatWorktree(owner, folderPath, hostId)
      return
    }
    const timer = setTimeout(
      () => reserveNewChatWorktree(owner, folderPath, hostId),
      hadOne ? RESERVE_AGAIN_AFTER_MS : RESERVE_AFTER_MS,
    )
    return () => clearTimeout(timer)
  }, [owner, enabled, folderPath, hostId, held, hadOne])
  useEffect(() => () => releaseNewChatWorktreeReservation(owner, RELEASE_GRACE_MS), [owner])
}
