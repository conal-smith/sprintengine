import type { ConversationThread } from "../../api/conversationWire";
import type { ConversationRow, ReplyClock } from "./conversationLogic";

// Where the part of a chat nobody has read starts: the "New" divider drawn
// above the first reply the person has not seen, and the place the chat opens
// at when there is one. The desktop's (`unreadDivider.ts` there), read off the
// phone's rows.
//
// What was seen comes from the chat's visit clock (`lastVisitedAt`), which a
// lifecycle desktop lists and every device moves while the chat is on screen
// (`useChatVisits`), and which Mark unread moves back to just before the
// chat's latest finish, so the next opening's divider sits above that reply. Opening the chat here stamps a visit at once, so the
// clock as it stood just before is taken first, as the screen mounts, and held
// until the person leaves the chat. The divider is placed against that reading
// and the moment of opening, never against the live clock, so it stays where
// it was drawn while the agent keeps streaming and does not vanish the instant
// the visit lands.
//
// A desktop that lists no visit clock gets no divider. This phone's own record
// of opening a chat (`chatOpenedKey`) is no stand-in: a chat's first sighting
// in the list is written there as seen, so it cannot tell a chat read before
// from one never opened.

/** A chat as it was when it was opened here. */
export interface ChatOpenedSince {
  /** When it was opened, on the phone's clock. */
  openedAt: number;
  /**
   * Its visit clock as it stood before this opening was stamped, on the
   * desktop's; null for a chat nobody has had on screen, or a desktop that
   * lists no visits.
   */
  seenAt: number | null;
}

/**
 * The opening of a chat, from the threads that say when it was last seen: the
 * one the chat was opened with and the list's latest read of it, whichever
 * saw it later. A thread listed without a visit clock says nothing.
 *
 * Except a Mark unread (`conversation.mark_unread`), which moves the clock
 * back: a thread carrying the latest mark (`visitRewoundAt`) has the clock as
 * it stood after it, and a clock from another thread wins over that only when
 * it is later than the mark itself, a visit made since. Taking the later of
 * the two regardless would read a thread handed over before the mark, which
 * still has the clock from before it, and put the divider below the reply the
 * mark made new again, or draw none.
 */
export function chatOpenedSince(
  threads: readonly (Pick<ConversationThread, "lastVisitedAt" | "visitRewoundAt"> | null | undefined)[],
  now: number,
): ChatOpenedSince {
  const clock = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at);
  // The latest mark any thread carries, and the clock that thread has with it.
  let mark: { at: number; seenAt: number } | null = null;
  for (const thread of threads) {
    const at = thread?.visitRewoundAt;
    const seen = thread?.lastVisitedAt;
    if (clock(at) && clock(seen) && (mark === null || at > mark.at)) mark = { at, seenAt: seen };
  }
  let seenAt: number | null = mark?.seenAt ?? null;
  for (const thread of threads) {
    const at = thread?.lastVisitedAt;
    if (!clock(at) || (mark !== null && at <= mark.at)) continue;
    seenAt = Math.max(seenAt ?? at, at);
  }
  return { openedAt: now, seenAt };
}

/** The turn a row belongs to, for the rows that are an agent's reply; undefined for the rest. */
function replyTurn(row: ConversationRow): string | undefined {
  switch (row.kind) {
    case "fold":
      return row.turn;
    case "tools":
      return row.turn;
    case "reasoning":
      return row.turn;
    case "agent":
      return row.lane.turn || undefined;
    case "message":
      return row.role === "assistant" ? row.turn : undefined;
    default:
      return undefined;
  }
}

/**
 * The turn whose reply the "New" divider goes above, or null for none.
 *
 * Only an agent's reply can be new. The person's own messages are never the
 * start of what they have not read, and the compaction divider, a command's
 * output and a turn's footer are the transcript's furniture. A message Studio
 * sent is not a reply either; it goes with the reply to it
 * (`unreadDividerRowId`).
 *
 * A reply is unseen when it finished after the visit clock, or, still running
 * when the chat was opened, began after it: one already under way when the
 * person last looked is one they watched begin. A reply that began after the
 * chat was opened is being watched as it arrives, so the divider never moves
 * on to it, and one that finishes while the chat is open is read as it stood
 * at the opening, still running. With nothing seen from an agent above the
 * first unseen reply there is no divider at all: the whole chat is new, and a
 * "New" above all of it says nothing.
 *
 * The opening is on the phone's clock and the replies on the desktop's.
 * Machines on one tailnet keep time to well under a second of each other, far
 * inside the gap between a person opening a chat and an agent's next reply.
 */
export function unreadDividerTurn(replies: readonly ReplyClock[], opened: ChatOpenedSince): string | null {
  const seenAt = opened.seenAt;
  if (seenAt === null) return null;
  let seenReply = false;
  for (const reply of replies) {
    if (reply.startedAt > opened.openedAt) break;
    // A finish after the opening was watched, so the reply is read as it
    // stood then: still running. Without this the divider would jump onto a
    // reply the moment it finished in front of the reader.
    const finishedAt = reply.streaming ? undefined : (reply.endedAt ?? reply.startedAt);
    const finished = finishedAt !== undefined && finishedAt <= opened.openedAt ? finishedAt : undefined;
    const unseen = finished !== undefined ? finished > seenAt : reply.startedAt > seenAt;
    if (!unseen) {
      seenReply = true;
      continue;
    }
    return seenReply ? reply.turn : null;
  }
  return null;
}

/**
 * The row the divider is drawn above: the first of the turn's reply, never a
 * row inside its folded work. A compaction just above it happened on the way
 * into that turn, so the divider goes above that too and the two seams read
 * in the order things happened. So does a message Studio sent that opened the
 * turn (`studioNotice.ts`): it is news the reader has not seen either, and the
 * reply below it answers it, where a person's own message above a reply is
 * what they already know. Null while the turn has no row yet.
 */
export function unreadDividerRowId(rows: readonly ConversationRow[], turn: string | null): string | null {
  if (turn === null) return null;
  let index = rows.findIndex((row) => replyTurn(row) === turn);
  if (index < 0) return null;
  while (index > 0) {
    const above = rows[index - 1];
    if (above.kind !== "compaction" && !(above.kind === "studio" && above.turn === turn)) break;
    index -= 1;
  }
  return rows[index].id;
}
