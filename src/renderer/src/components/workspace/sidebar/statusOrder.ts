import type { Activity } from './rowStyle'

// The By status list's order: what waits on the person first (blocked on a
// question or an approval, or stopped by a failed turn, the chats a folded
// project counts as waiting), then what finished while nobody had it on
// screen, then the rest. Each band keeps the order it came in, newest message
// first. Working chats are not ranked: that list folds them into its Working
// shelf.

export const STATUS_WAITING = 0
export const STATUS_FINISHED_UNSEEN = 1
export const STATUS_REST = 2

/** The band a chat sits in, from what its row says of it. */
export function chatStatusRank(status: { activity: Activity | undefined; unseenDone: boolean }): number {
  if (status.activity === 'needs-input' || status.activity === 'failed') return STATUS_WAITING
  return status.unseenDone ? STATUS_FINISHED_UNSEEN : STATUS_REST
}

/** `entries` by band, each band in the order the entries came in. */
export function orderByStatus<T>(entries: readonly T[], rankOf: (entry: T) => number): T[] {
  return entries
    .map((entry, index) => ({ entry, index, rank: rankOf(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry)
}
