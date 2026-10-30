// Where the part of a chat nobody has read starts: the "New" divider drawn
// before the first reply the person has not seen, and the place the chat opens
// at when there is one.
//
// What was seen comes from the chat's visit clock (`lastVisitedAt`), which the
// sidebar moves forward while the chat is in front (`useVisitStamp`). Opening
// a chat moves it at once, so the clock as it stood just before is taken here
// first (`noteChatOpened`) and held until the person leaves the chat. It is
// said as the chat is made active (`noteWorkspaceOpening`), before anything is
// drawn, so a chat whose transcript is already loaded mounts its list at the
// divider; the visit stamp says it again, to the same effect, for a chat that
// came in front any other way. The divider is placed against that
// reading and the moment of opening, never against the live clock, so it
// stays where it was drawn while the agent keeps streaming and does not
// vanish the instant the visit lands.
//
// Mark unread, on any device, moves that clock back to just before the
// chat's latest finish (`conversation.mark_unread`), so the next opening
// reads its latest reply as the first unseen one; nothing here keeps a mark
// of its own. The opening is this window's: each has its own chat in front.

import { useCallback, useSyncExternalStore } from 'react'
import type { ConversationTimelineRow } from './conversationTimeline'

/** What the person had seen of a chat when it was opened: everything an agent finished by its visit clock. */
export type ChatUnreadSince = { kind: 'visit'; at: number }

/** A chat in front of this window, as it was when it came there. */
export type ChatOpening = {
  workspaceId: string
  openedAt: number
  /** Null for a chat with no visit clock: there is nothing to measure against. */
  since: ChatUnreadSince | null
}

let opening: ChatOpening | null = null
const listeners = new Set<() => void>()

function publish(next: ChatOpening | null): void {
  opening = next
  for (const listener of listeners) listener()
}

/**
 * The chat came in front of this window. `visitedAt` is its visit clock as it
 * stands now, before this opening is stamped as a visit. Said again for the
 * chat already open, it changes nothing: that is the same opening, and the
 * clock has moved since by the visit it began.
 */
export function noteChatOpened(workspaceId: string, visitedAt: number | null, now: number): void {
  if (opening?.workspaceId === workspaceId) return
  publish({ workspaceId, openedAt: now, since: visitedAt === null ? null : { kind: 'visit', at: visitedAt } })
}

/** The chat left the front of this window. A later opening reads the clock afresh. */
export function noteChatLeft(workspaceId: string): void {
  if (opening?.workspaceId === workspaceId) publish(null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The opening of `workspaceId` while it is the chat in front; null otherwise, or for no chat. */
export function useChatOpening(workspaceId: string | null): ChatOpening | null {
  const read = useCallback(
    () => (workspaceId !== null && opening?.workspaceId === workspaceId ? opening : null),
    [workspaceId],
  )
  return useSyncExternalStore(subscribe, read, read)
}

type ReplyRow = Extract<ConversationTimelineRow, { kind: 'assistant' }>

/**
 * Pages of older history the view loads, at most, looking for the reply the
 * reader saw above an unseen run that reaches the top of what is loaded.
 * Past them the divider stands at the top of what is loaded.
 */
export const MAX_DIVIDER_PAGES = 5

/** Whether the first reply loaded is already unseen: the unseen run may reach into history not loaded yet. */
export function unseenFromTheTop(rows: readonly ConversationTimelineRow[], opened: ChatOpening): boolean {
  const first = firstUnseenReply(rows, opened)
  return first !== null && !first.seenAbove
}

// The first reply the reader had not seen when the chat was opened, and
// whether one they had seen sits above it.
function firstUnseenReply(
  rows: readonly ConversationTimelineRow[],
  opened: ChatOpening,
): { index: number; seenAbove: boolean } | null {
  const since = opened.since
  if (!since) return null
  const arrivedBeforeOpening = (row: ReplyRow) => (replyBegan(row) ?? Number.NEGATIVE_INFINITY) <= opened.openedAt
  let seenAbove = false
  for (let cursor = 0; cursor < rows.length; cursor += 1) {
    const row = rows[cursor]!
    if (row.kind !== 'assistant') continue
    if (!arrivedBeforeOpening(row)) return null
    // A finish after the opening was watched, so the reply is read as it
    // stood then: still streaming. Without this the divider would jump onto
    // a reply the moment it finished in front of the reader.
    const finishedAt = replyFinished(row)
    const finished = finishedAt !== undefined && finishedAt <= opened.openedAt ? finishedAt : undefined
    const unseen =
      finished !== undefined ? finished > since.at : (replyBegan(row) ?? Number.NEGATIVE_INFINITY) > since.at
    if (unseen) return { index: cursor, seenAbove }
    seenAbove = true
  }
  return null
}

// When a reply began, and when it finished; a reply still streaming has not.
// A reply replayed from a transcript that kept no clock has neither.
function replyBegan(row: ReplyRow): number | undefined {
  return row.entry.startedAt ?? row.entry.completedAt
}
function replyFinished(row: ReplyRow): number | undefined {
  return row.entry.status === 'streaming' ? undefined : (row.entry.completedAt ?? row.entry.startedAt)
}

/**
 * The row the "New" divider goes above, or null for none.
 *
 * Only an agent's reply can be new. The person's own messages are never the
 * start of what they have not read, and the compaction marker, decision
 * records and the live status line are the view's furniture. A reply is a
 * whole row — its steps folded under it — so the divider lands at a reply's
 * start, never inside its work.
 *
 * A reply is unseen when it finished after the visit clock, or, still
 * streaming when the chat was opened, began after it: one already under way
 * when the person last looked is one they watched begin, and a divider above
 * it after a glance elsewhere would send them back over what they just read. A reply that began
 * after the chat was opened is being watched as it arrives, so the divider
 * never moves on to it. With nothing seen from an agent above the first
 * unseen reply there is no divider at all: the whole chat is new — one started
 * and left before it answered, or never opened — and a "New" above all of it
 * says nothing. Marked unread, the clock stands just before the latest
 * finish, so that is the reply the divider goes above.
 *
 * A context compaction that happened inside the unseen reply's turn sits just
 * above it, and the divider goes above that too, so the two seams read in the
 * order things happened.
 *
 * Only the loaded part of a long chat is in `rows`. With older history above
 * it (`historyAbove`), a first loaded reply that is unseen is not the whole
 * chat being new — the reader may well have seen what came before — so the
 * divider goes above it, at the top of what is loaded. The view pages back
 * first, a bounded few pages, to find the reply that was seen
 * (`unseenFromTheTop`).
 */
export function unreadDividerRowId(
  rows: readonly ConversationTimelineRow[],
  opened: ChatOpening,
  { historyAbove = false }: { historyAbove?: boolean } = {},
): string | null {
  const first = firstUnseenReply(rows, opened)
  if (!first) return null
  const index = first.seenAbove || historyAbove ? first.index : -1
  const target = rows[index]
  if (!target || target.kind !== 'assistant') return null
  let start = index
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const row = rows[cursor]!
    if (row.kind !== 'compaction' || row.entry.turnId !== target.entry.turnId) break
    start = cursor
  }
  return rows[start]!.id
}
